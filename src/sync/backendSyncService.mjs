// @ts-check
import fs from 'fs';
import path from 'path';
import { backendClient } from '../security-authority/protocol/backend-client.mjs';
import { repositoryFactory } from '../repositories/repositoryFactory.mjs';
import { machineIdentity } from '../security-authority/identity/machine-identity.mjs';
import { NativeCore } from '../security-authority/native/security-core.mjs';
import { wsServer } from '../api-server/websocket/wsServer.mjs';
import { logger } from '../shared/logging.mjs';

/**
 * Orchestrates synchronization between ACP and the Cloud Backend.
 * Responsible for:
 * 1. Bootstrapping machine identity and session auth on startup.
 * 2. Hydrating in-memory repositories from the authoritative backend snapshot.
 * 3. Maintaining an encrypted DPAPI local cache for resilient offline cold boots.
 * 4. Dispatching mutation intents to the Backend and local state.
 */
export class BackendSyncService {
  /**
   * @param {Object} [options]
   * @param {import('../security-authority/protocol/backend-client.mjs').BackendClient} [options.client]
   * @param {string} [options.cachePath]
   */
  constructor(options = {}) {
    this.client = options.client || backendClient;
    this.isConnected = false;
    this.isHydrated = false;
    this.lastSyncTimestamp = null;

    const baseDir = process.env.APPDATA || process.cwd();
    const secDir = path.join(baseDir, '.security_authority');
    if (!fs.existsSync(secDir)) {
      try { fs.mkdirSync(secDir, { recursive: true }); } catch { /* ignore */ }
    }
    this.cacheFilePath = options.cachePath || path.join(secDir, 'acp_cache.enc');
  }

  /**
   * Initializes the synchronization pipeline.
   * Runs cold-boot hydration (from Cloud Backend if reachable, else from local DPAPI cache).
   * 
   * @param {Object} [credentials]
   * @param {string} [credentials.email]
   * @param {string} [credentials.password]
   * @returns {Promise<{ isConnected: boolean; isHydrated: boolean }>}
   */
  async initialize(credentials = null) {
    logger.info('[BackendSyncService] Initializing Backend synchronization pipeline...');

    // 1. Ensure machine identity is initialized
    try {
      if (!machineIdentity.publicKeyHex) {
        await machineIdentity.initialize();
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Machine identity init warning');
    }

    // 2. Check Backend liveness
    const health = await this.client.checkHealth();
    if (!health.ok) {
      logger.warn({ status: health.status }, '[BackendSyncService] Cloud Backend unreachable. Falling back to local encrypted cache.');
      const loaded = this.loadLocalCache();
      this.isConnected = false;
      this.isHydrated = loaded;
      return { isConnected: false, isHydrated: loaded };
    }

    // 3. Backend is reachable: register machine if needed
    try {
      const desc = machineIdentity.getDescriptor();
      const selfSig = machineIdentity.signPayload(Buffer.from(`REGISTRATION:${desc.hardwareId}`, 'utf8'));
      await this.client.registerMachine(desc.machineKeyPub, `inst_${desc.hardwareId}`, selfSig, desc);
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Machine registration returned notice (may already be registered)');
    }

    // 4. Authenticate session if credentials provided or available in env
    const email = credentials?.email || process.env.OPERATOR_EMAIL || 'operator@bettingautomation.io';
    const password = credentials?.password || process.env.OPERATOR_PASSWORD || 'Password123!';

    try {
      const authRes = await this.client.initAuth({ email, password });
      logger.info({ sessionId: authRes.sessionId, generation: authRes.sessionGeneration }, '[BackendSyncService] Machine session authenticated');
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Auth init failed; proceeding with public/local capability scope');
    }

    // 5. Pull authoritative snapshot and hydrate in-memory repositories
    try {
      await this.pullAuthoritativeSnapshot();
      this.isConnected = true;
      this.isHydrated = true;

      // 6. Save encrypted cache for future offline cold boot
      this.saveLocalCache();
      logger.info('[BackendSyncService] Authoritative state hydrated and local encrypted cache updated.');
    } catch (err) {
      logger.error({ err: err.message }, '[BackendSyncService] Error pulling snapshot from backend; falling back to cache');
      this.loadLocalCache();
    }

    return { isConnected: this.isConnected, isHydrated: this.isHydrated };
  }

  /**
   * Pulls authoritative automation and accounts state from Backend.
   */
  async pullAuthoritativeSnapshot() {
    const configRepo = repositoryFactory.getConfigRepo();
    const accountsRepo = repositoryFactory.getAccountsRepo();

    // 1. Fetch automation configuration and accounts snapshot
    try {
      const autoSnapshot = await this.client.getAutomationSnapshot();
      if (autoSnapshot?.globalConfig) {
        configRepo.hydrate(autoSnapshot.globalConfig);
      }
      if (Array.isArray(autoSnapshot?.accounts) && autoSnapshot.accounts.length > 0) {
        accountsRepo.hydrate(autoSnapshot.accounts);
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not fetch automation snapshot directly');
    }

    // 2. Fetch full betting accounts list
    try {
      const accountsRes = await this.client.getBettingAccounts({ limit: 1000 });
      if (Array.isArray(accountsRes?.viewportAccounts)) {
        accountsRepo.hydrate(accountsRes.viewportAccounts);
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not fetch accounts list directly');
    }

    this.lastSyncTimestamp = new Date().toISOString();
  }

  /**
   * Encrypts and saves current in-memory accounts and config to local disk cache using DPAPI.
   * @returns {boolean}
   */
  saveLocalCache() {
    try {
      const accountsRepo = repositoryFactory.getAccountsRepo();
      const configRepo = repositoryFactory.getConfigRepo();

      const cachePayload = {
        version: 1,
        savedAt: new Date().toISOString(),
        globalConfig: configRepo.globalConfig,
        accounts: Array.from(accountsRepo.accounts.values())
      };

      const jsonBuffer = Buffer.from(JSON.stringify(cachePayload), 'utf8');
      const aad = Buffer.from('ACP_LOCAL_CACHE_V1', 'utf8');
      const encrypted = NativeCore.encryptAead(jsonBuffer, aad);

      fs.writeFileSync(this.cacheFilePath, encrypted);
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not save encrypted local cache');
      return false;
    }
  }

  /**
   * Reads and decrypts local encrypted cache into in-memory repositories.
   * @returns {boolean}
   */
  loadLocalCache() {
    try {
      if (!fs.existsSync(this.cacheFilePath)) {
        logger.info('[BackendSyncService] No local cache found; running with memory seed defaults');
        return false;
      }

      const encrypted = fs.readFileSync(this.cacheFilePath);
      const aad = Buffer.from('ACP_LOCAL_CACHE_V1', 'utf8');
      const decrypted = NativeCore.decryptAead(encrypted, aad);

      const cachePayload = JSON.parse(decrypted.toString('utf8'));
      if (Array.isArray(cachePayload.accounts)) {
        repositoryFactory.getAccountsRepo().hydrate(cachePayload.accounts);
      }
      if (cachePayload.globalConfig) {
        repositoryFactory.getConfigRepo().hydrate(cachePayload.globalConfig);
      }

      logger.info({ count: cachePayload.accounts?.length }, '[BackendSyncService] Loaded state from local encrypted cache');
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Failed to decrypt local cache');
      return false;
    }
  }

  /**
   * Synchronizes an ingress mutation with the Cloud Backend.
   * @param {'REGISTER_ACCOUNT' | 'UPDATE_GLOBAL_CONFIG' | 'UPDATE_ACCOUNT_CONFIG'} type 
   * @param {any} payload 
   * @returns {Promise<any>}
   */
  async syncMutation(type, payload) {
    if (!this.isConnected) {
      logger.info({ type }, '[BackendSyncService] Backend offline; mutation queued/stored locally only');
      this.saveLocalCache();
      return { localOnly: true };
    }

    try {
      let result;
      if (type === 'REGISTER_ACCOUNT') {
        result = await this.client.createBettingAccount(payload);
      } else if (type === 'UPDATE_GLOBAL_CONFIG') {
        result = await this.client.updateGlobalConfig(payload.category, payload.values);
      }

      this.saveLocalCache();
      return result;
    } catch (err) {
      logger.error({ type, err: err.message }, '[BackendSyncService] Failed to sync mutation to Backend');
      // Save locally to cache so intent is not lost
      this.saveLocalCache();
      return { localOnly: true, error: err.message };
    }
  }
}

export const backendSyncService = new BackendSyncService();

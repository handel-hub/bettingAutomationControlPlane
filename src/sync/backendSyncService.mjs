// @ts-check
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { backendClient } from '../security-authority/protocol/backend-client.mjs';
import { repositoryFactory } from '../repositories/repositoryFactory.mjs';
import { machineIdentity } from '../security-authority/identity/machine-identity.mjs';
import { NativeCore } from '../security-authority/native/security-core.mjs';
import { wsServer } from '../api-server/websocket/wsServer.mjs';
import { securityFacade } from '../security-authority/facade.mjs';
import { FreshnessEvaluator } from '../state-store/hydration/FreshnessEvaluator.mjs';
import { logger } from '../shared/logging.mjs';

/**
 * Orchestrates synchronization between ACP and the Cloud Backend.
 * Responsible for:
 * 1. Bootstrapping machine identity and session auth on startup.
 * 2. Hydrating in-memory repositories from the authoritative backend snapshot.
 * 3. Maintaining an encrypted DPAPI local cache for resilient offline cold boots.
 * 4. Dispatching mutation intents to the Backend and local state.
 * 5. Maintaining persistent Server-to-ACP Event Stream (/ws/v1/events) with monotonic gap detection.
 * 6. Enforcing 2-hour offline operational grace period.
 */
export class BackendSyncService {
  /**
   * @param {Object} [options]
   * @param {import('../security-authority/protocol/backend-client.mjs').BackendClient} [options.client]
   * @param {string} [options.cachePath]
   * @param {boolean} [options.enableWebSocket]
   */
  constructor(options = {}) {
    this.client = options.client || backendClient;
    this.isConnected = false;
    this.isHydrated = false;
    this.lastSyncTimestamp = null;
    this.enableWebSocket = options.enableWebSocket !== undefined ? options.enableWebSocket : true;

    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {number} */
    this.lastObservedSequence = 0;
    /** @type {Map<string, number>} */
    this.accountSequences = new Map();
    /** @type {NodeJS.Timeout | null} */
    this.reconnectTimer = null;
    /** @type {number} */
    this.reconnectAttempts = 0;
    /** @type {boolean} */
    this.isStopping = false;

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

      // 7. Establish Server-to-ACP Event Stream WebSocket connection
      if (this.enableWebSocket && this.client.sessionId) {
        this.connectWebSocket();
      }
    } catch (err) {
      logger.error({ err: err.message }, '[BackendSyncService] Error pulling snapshot from backend; falling back to cache');
      this.loadLocalCache();
    }

    return { isConnected: this.isConnected, isHydrated: this.isHydrated };
  }

  /**
   * Connects to the Server-to-ACP Event Stream (/ws/v1/events) on Backend.
   */
  connectWebSocket() {
    if (this.isStopping) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (!this.client.sessionId) {
      logger.debug('[BackendSyncService] Cannot connect WebSocket: no authenticated session ID');
      return;
    }

    const wsUrl = `${this.client.endpoint.replace(/^http/, 'ws')}/ws/v1/events?session=${encodeURIComponent(this.client.sessionId)}`;
    logger.info({ url: wsUrl }, '[BackendSyncService] Connecting to Server-to-ACP Event Stream...');

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        logger.info('[BackendSyncService] Connected to Backend Server Event Stream');
        this.reconnectAttempts = 0;
      });

      ws.on('message', async (data) => {
        try {
          const raw = data.toString('utf8');
          const event = JSON.parse(raw);
          await this.handleServerEvent(event);
        } catch (err) {
          logger.warn({ err: err.message }, '[BackendSyncService] Error handling incoming server event');
        }
      });

      ws.on('error', (err) => {
        logger.warn({ err: err.message }, '[BackendSyncService] Server Event Stream error');
      });

      ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason?.toString() }, '[BackendSyncService] Server Event Stream closed');
        this.ws = null;
        this.scheduleReconnect();
      });
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Failed to establish Server Event Stream');
      this.scheduleReconnect();
    }
  }

  /**
   * Schedules reconnect with exponential backoff.
   */
  scheduleReconnect() {
    if (this.isStopping || !this.enableWebSocket || !this.client.sessionId) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
    if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  /**
   * Disconnects from Server Event Stream and cancels reconnect timer.
   */
  disconnectWebSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  /**
   * Processes incoming Server-to-ACP Event Stream frames with monotonic gap detection.
   * @param {Object} event
   */
  async handleServerEvent(event) {
    if (!event || typeof event !== 'object') return;

    const eventType = event.eventType || event.topic;
    const seq = event.sequenceNumber;
    const payload = event.payload || {};

    // 1. Monotonic Gap Detection
    const accountId = payload.accountId || payload.id || 'global';
    const lastSeq = this.accountSequences.get(accountId) ?? (this.lastObservedSequence ?? 0);

    if (seq !== undefined && seq !== null && typeof seq === 'number') {
      if (lastSeq === 0) {
        // First frame observed
        this.accountSequences.set(accountId, seq);
        this.lastObservedSequence = Math.max(this.lastObservedSequence, seq);
      } else if (seq === lastSeq + 1) {
        // Strictly in order
        this.accountSequences.set(accountId, seq);
        this.lastObservedSequence = Math.max(this.lastObservedSequence, seq);
      } else if (seq > lastSeq + 1) {
        // Gap detected!
        logger.warn({ accountId, expected: lastSeq + 1, received: seq }, '[BackendSyncService] Monotonic sequence gap detected! Triggering full authoritative state reconciliation');
        this.accountSequences.set(accountId, seq);
        this.lastObservedSequence = Math.max(this.lastObservedSequence, seq);
        
        // Trigger full state reconciliation
        this.pullAuthoritativeSnapshot().catch(err => {
          logger.error({ err: err.message }, '[BackendSyncService] Authoritative state reconciliation failed after gap');
        });
      } else {
        // Duplicate or stale frame (seq <= lastSeq)
        logger.debug({ accountId, seq, lastSeq }, '[BackendSyncService] Dropping duplicate or stale frame');
        return;
      }
    }

    // 2. Domain Event Routing
    switch (eventType) {
      case 'LICENSE_UPDATED': {
        const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
        wsServer.broadcast('billing:snapshot', billingSnapshot);
        break;
      }

      case 'LICENSE_REVOKED': {
        logger.warn('[BackendSyncService] Authoritative license revoked by Backend. Transitioning to degraded mode.');
        await securityFacade.transitionToDegraded('LICENSE_REVOKED');
        wsServer.broadcast('app:state', 'Degraded');
        break;
      }

      case 'SUBSCRIPTION_STATUS_CHANGED': {
        if (payload.subscription) {
          await repositoryFactory.getBillingRepo().updateSubscription(payload.subscription);
        }
        const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
        wsServer.broadcast('billing:snapshot', billingSnapshot);
        break;
      }

      case 'ACCOUNT_LOCKED':
      case 'ACCOUNT_STATUS_CHANGED': {
        const targetAccId = payload.accountId || payload.id;
        if (targetAccId) {
          await repositoryFactory.getAccountsRepo().update(targetAccId, {
            backendState: payload.status || (eventType === 'ACCOUNT_LOCKED' ? 'LOCKED' : 'SUSPENDED')
          });
        }
        wsServer.broadcast('accounts:delta', payload);
        break;
      }

      case 'ALERT_TRIGGERED': {
        const notif = await repositoryFactory.getNotificationsRepo().add({
          id: event.eventId || payload.id,
          severity: payload.severity || 'WARN',
          category: payload.category || 'SYSTEM',
          title: payload.title || 'Security / System Alert',
          message: payload.message || JSON.stringify(payload),
          metadata: payload
        });
        wsServer.broadcast('notifications:delta', notif);
        break;
      }

      case 'FORCE_LOGOUT': {
        logger.warn('[BackendSyncService] Backend issued FORCE_LOGOUT. Invalidating session context.');
        this.client.setSession(null, null);
        await securityFacade.logout().catch(() => {});
        wsServer.broadcast('app:state', 'Unauthenticated');
        this.disconnectWebSocket();
        break;
      }

      case 'app:state':
      default: {
        logger.debug({ eventType, payload }, '[BackendSyncService] Processed server event');
        break;
      }
    }
  }

  /**
   * Evaluates the 2-hour offline operational grace period.
   * If exceeded, transitions Security Authority into Degraded mode.
   * @returns {boolean} True if within grace period, false if expired.
   */
  checkGracePeriod() {
    if (!this.lastSyncTimestamp) return false;
    const isWithin = FreshnessEvaluator.isSubscriptionWithinGracePeriod(this.lastSyncTimestamp);
    if (!isWithin && !securityFacade.isDegraded()) {
      logger.warn('[BackendSyncService] 2-hour offline operational grace period expired. Transitioning to degraded mode.');
      securityFacade.transitionToDegraded('GRACE_PERIOD_EXPIRED').catch(() => {});
    }
    return isWithin;
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
   * Preserves full account payload including accountPassword per boundary contract.
   * @param {'REGISTER_ACCOUNT' | 'UPDATE_GLOBAL_CONFIG' | 'UPDATE_ACCOUNT_CONFIG' | 'TOGGLE_BET_CYCLE' | 'ACCOUNT_ACTION' | 'CANCEL_SUBSCRIPTION' | 'RESUME_SUBSCRIPTION' | 'SUBMIT_SETTINGS'} type 
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
      switch (type) {
        case 'REGISTER_ACCOUNT':
          // NOTE: Do NOT scrub accountPassword! Backend database encrypts it with AES-256-GCM AEAD.
          result = await this.client.createBettingAccount(payload);
          break;

        case 'UPDATE_GLOBAL_CONFIG':
          result = await this.client.updateGlobalConfig(payload.category, payload.values);
          break;

        case 'UPDATE_ACCOUNT_CONFIG':
          result = await this.client.updateAccountConfigOverride(payload.accountId, payload.config);
          break;

        case 'TOGGLE_BET_CYCLE':
          result = await this.client.toggleBetCycle(payload.accountId, payload.action || (payload.enabled ? 'ACTIVATE' : 'DEACTIVATE'));
          break;

        case 'ACCOUNT_ACTION':
          result = await this.client.executeAccountAction(payload.accountId, payload.action, payload.parameters);
          break;

        case 'CANCEL_SUBSCRIPTION':
          result = await this.client.cancelSubscription();
          break;

        case 'RESUME_SUBSCRIPTION':
          result = await this.client.resumeSubscription();
          break;

        case 'SUBMIT_SETTINGS':
          result = await this.client.submitSettingsIntent(payload);
          break;

        default:
          logger.warn({ type }, '[BackendSyncService] Unknown mutation type for backend sync');
          break;
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

  /**
   * Shuts down the sync service, disconnecting WebSockets and timers.
   */
  stop() {
    this.isStopping = true;
    this.disconnectWebSocket();
  }
}

export const backendSyncService = new BackendSyncService();

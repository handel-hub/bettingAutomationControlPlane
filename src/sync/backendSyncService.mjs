// @ts-check
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import { backendClient } from '../security-authority/protocol/backend-client.mjs';
import { repositoryFactory } from '../repositories/repositoryFactory.mjs';
import { machineIdentity } from '../security-authority/identity/machine-identity.mjs';
import { NativeCore } from '../security-authority/native/security-core.mjs';
import { wsServer } from '../api-server/websocket/wsServer.mjs';
import { securityFacade } from '../security-authority/facade.mjs';
import { licenseManager } from '../security-authority/licensing/license-manager.mjs';
import { clock } from '../security-authority/time/clock.mjs';
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
    this.machineIdentity = options.identity || machineIdentity;
    this.isConnected = false;
    this.isHydrated = false;
    this.lastSyncTimestamp = null;
    /** @type {any} */
    this.lastGraceToken = null;
    /** @type {bigint | null} */
    this.lastSyncHrtime = null;
    /** @type {number} */
    this.lastObservedEpoch = 0;
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

    /** @type {any} */
    this.engine = options.engine || null;
    /** @type {Array<{ id: string, mutationType: string, payload: any, attempts: number, status: string, createdAt: number, nextRetryAt: number, lastError: string | null }>} */
    this.outbox = [];

    const baseDir = process.env.APPDATA || process.cwd();
    const secDir = path.join(baseDir, '.security_authority');
    if (!fs.existsSync(secDir)) {
      try { fs.mkdirSync(secDir, { recursive: true }); } catch { /* ignore */ }
    }
    const isTest =
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT) ||
      process.execArgv.includes('--test') ||
      Boolean(process.env.npm_lifecycle_event?.includes('test'));
    const defaultCachePath = isTest
      ? path.join(os.tmpdir(), `acp_test_cache_${process.pid}.enc`)
      : path.join(secDir, 'acp_cache.enc');
    this.cacheFilePath = options.cachePath || process.env.ACP_CACHE_PATH || defaultCachePath;

    if (this.engine) {
      this._initOutboxPersistence();
      this._hydrateOutboxFromPersistence();
    }
  }

  /**
   * Connects the SQLite storage engine and initializes outbox persistence.
   * @param {any} engine
   */
  setEngine(engine) {
    if (!engine || this.engine === engine) return;
    this.engine = engine;
    this._initOutboxPersistence();
    this._hydrateOutboxFromPersistence();
  }

  /**
   * Initializes SQLite outbox persistence schema.
   * @private
   */
  _initOutboxPersistence() {
    try {
      this.engine.exec(`
        CREATE TABLE IF NOT EXISTS sync_outbox (
          id TEXT PRIMARY KEY,
          mutation_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'PENDING',
          last_error TEXT,
          created_at INTEGER NOT NULL,
          next_retry_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_retry ON sync_outbox(status, next_retry_at);
      `);
    } catch { /* ignore */ }
  }

  /**
   * Encrypts an outbox mutation payload using NativeCore AEAD before SQLite persistence.
   * @private
   * @param {any} payload
   * @returns {string}
   */
  _encryptOutboxPayload(payload) {
    const jsonStr = JSON.stringify(payload);
    try {
      const aad = Buffer.from('ACP_SYNC_OUTBOX_V1', 'utf8');
      const encrypted = NativeCore.encryptAead(Buffer.from(jsonStr, 'utf8'), aad);
      return `enc:v1:${Buffer.from(encrypted).toString('base64')}`;
    } catch {
      return jsonStr;
    }
  }

  /**
   * Decrypts an outbox mutation payload loaded from SQLite persistence.
   * @private
   * @param {string} rawPayload
   * @returns {any}
   */
  _decryptOutboxPayload(rawPayload) {
    if (typeof rawPayload === 'string' && rawPayload.startsWith('enc:v1:')) {
      const cipherBuf = Buffer.from(rawPayload.slice('enc:v1:'.length), 'base64');
      const aad = Buffer.from('ACP_SYNC_OUTBOX_V1', 'utf8');
      const plainBuf = NativeCore.decryptAead(cipherBuf, aad);
      const str = Buffer.from(plainBuf).toString('utf8');
      plainBuf.fill(0);
      return JSON.parse(str);
    }
    return JSON.parse(rawPayload);
  }

  /**
   * Hydrates pending outbox entries from persistence.
   * @private
   */
  _hydrateOutboxFromPersistence() {
    try {
      const rows = this.engine.query(`
        SELECT id, mutation_type, payload_json, attempts, status, last_error, created_at, next_retry_at
        FROM sync_outbox
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
      `);
      const existingIds = new Set(this.outbox.map(i => i.id));
      for (const row of rows) {
        if (!existingIds.has(row.id)) {
          try {
            this.outbox.push({
              id: row.id,
              mutationType: row.mutation_type,
              payload: this._decryptOutboxPayload(row.payload_json),
              attempts: row.attempts,
              status: row.status,
              createdAt: row.created_at,
              nextRetryAt: row.next_retry_at,
              lastError: row.last_error
            });
            existingIds.add(row.id);
          } catch { /* ignore corrupted outbox entry */ }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Enqueues a mutation intent into the persistent retry outbox.
   * @param {string} type
   * @param {any} payload
   */
  enqueueOutbox(type, payload) {
    const id = `out_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const item = {
      id,
      mutationType: type,
      payload,
      attempts: 0,
      status: 'PENDING',
      createdAt: Date.now(),
      nextRetryAt: Date.now(),
      lastError: null
    };

    this.outbox.push(item);

    if (this.engine) {
      try {
        const serializedPayload = this._encryptOutboxPayload(item.payload);
        this.engine.run(`
          INSERT INTO sync_outbox (id, mutation_type, payload_json, attempts, status, last_error, created_at, next_retry_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id, item.mutationType, serializedPayload, item.attempts, item.status, null, item.createdAt, item.nextRetryAt]);
      } catch { /* ignore */ }
    }

    return item;
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
      if (!this.machineIdentity.publicKeyHex) {
        await this.machineIdentity.initialize();
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Machine identity init warning');
    }

    // 2. Lazily wire SQLite engine from shared state store if not provided
    if (!this.engine) {
      try {
        const { getSharedStateStore } = await import('../state-store/sharedStateStore.mjs');
        const store = getSharedStateStore();
        if (store?.engine) {
          this.setEngine(store.engine);
        }
      } catch { /* ignore */ }
    }

    // 3. Check Backend liveness
    let health = { ok: false, status: 503 };
    try {
      health = await this.client.checkHealth();
    } catch { /* ignore */ }

    if (!health.ok) {
      logger.warn({ status: health.status }, '[BackendSyncService] Cloud Backend unreachable. Falling back to local state store and encrypted cache.');
      const loaded = this.loadLocalCache();
      this.isConnected = false;
      this.isHydrated = loaded;

      // Extract last sync / validated timestamp from SQLite if present
      if (this.engine) {
        try {
          const rows = this.engine.query("SELECT last_validated_at FROM cache_metadata WHERE entity_key = 'billing'");
          if (rows && rows[0]?.last_validated_at) {
            this.lastSyncTimestamp = rows[0].last_validated_at;
            this.isHydrated = true;
          }
        } catch { /* ignore */ }
      }

      return { isConnected: false, isHydrated: this.isHydrated };
    }

    // 4. Backend is reachable: register machine if needed
    try {
      const desc = this.machineIdentity.getDescriptor();
      const selfSig = this.machineIdentity.signPayload(Buffer.from(`REGISTRATION:${desc.hardwareId}`, 'utf8'));
      await this.client.registerMachine(desc.machineKeyPub, `inst_${desc.hardwareId}`, selfSig, desc);
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Machine registration returned notice (may already be registered)');
    }

    // 5. Authenticate session ONLY if explicit credentials provided or configured in env
    const email = credentials?.email || process.env.OPERATOR_EMAIL || null;
    const password = credentials?.password || process.env.OPERATOR_PASSWORD || null;

    this.isConnected = true;
    let authRes = null;

    if (email && password) {
      try {
        authRes = await this.client.initAuth({ email, password });
        this.lastAuthResult = authRes;
        if (authRes?.graceToken) {
          this.lastGraceToken = authRes.graceToken;
        }
        if (clock) {
          await clock.updateAnchor(Date.now()).catch(() => {});
        }
        logger.info({ sessionId: authRes.sessionId, generation: authRes.sessionGeneration }, '[BackendSyncService] Machine session authenticated');
        console.log(`✓ [ControlPlane] Operator "${email}" logged in to Cloud Backend (Session: ${authRes.sessionId})`);
      } catch (err) {
        this.lastAuthResult = null;
        logger.warn({ err: err.message }, '[BackendSyncService] Auth init failed; operator must authenticate via /api/v1/auth/login');
        console.warn(`⚠ [ControlPlane] Cloud Backend login failed for "${email}": ${err.message}`);
      }
    } else {
      this.lastAuthResult = null;
      logger.info('[BackendSyncService] No startup credentials provided; awaiting interactive operator authentication.');
    }

    // 6. If authenticated, pull authoritative snapshot and hydrate in-memory repositories & state store
    if (authRes && authRes.sessionId) {
      try {
        await this.pullAuthoritativeSnapshot();
        this.isHydrated = true;

        // 7. Flush pending outbox mutations now that we are connected and authenticated
        await this.flushOutbox();

        // 8. Save encrypted cache for future offline cold boot
        this.saveLocalCache();
        logger.info('[BackendSyncService] Authoritative state hydrated and local cache updated.');

        // 9. Establish Server-to-ACP Event Stream WebSocket connection
        if (this.enableWebSocket && this.client.sessionId) {
          this.connectWebSocket();
        }
      } catch (err) {
        logger.error({ err: err.message }, '[BackendSyncService] Error pulling snapshot from backend; falling back to cache');
        this.loadLocalCache();
      }
    } else {
      // Pull public reference catalogs (platforms & plans) even before login
      await this.pullPublicCatalogs();
    }

    return {
      isConnected: this.isConnected,
      isHydrated: this.isHydrated,
      session: this.lastAuthResult
    };
  }

  /**
   * Pulls public reference catalogs (platforms & plans) without requiring an authenticated session.
   */
  async pullPublicCatalogs() {
    const catalogsRepo = repositoryFactory.getCatalogsRepo();
    try {
      let currentPlatformEtag = undefined;
      let currentPlansEtag = undefined;
      try {
        const { getSharedStateStore } = await import('../state-store/sharedStateStore.mjs');
        const store = getSharedStateStore();
        currentPlatformEtag = store.metadataAdapter?.get('platform_registry')?.etag;
        currentPlansEtag = store.metadataAdapter?.get('plans_catalog')?.etag;
      } catch { /* ignore */ }

      if (this.client.sessionId) {
        const platformRes = await this.client.getPlatformRegistry({ ifNoneMatch: currentPlatformEtag });
        if (!platformRes.notModified && platformRes.registry && catalogsRepo) {
          const platforms = platformRes.registry.platforms || platformRes.registry;
          catalogsRepo.hydratePlatforms(platforms, platformRes.etag);
        }
      }

      const plansRes = await this.client.getPlansCatalog({ ifNoneMatch: currentPlansEtag });
      if (!plansRes.notModified && plansRes.catalog && catalogsRepo) {
        const plans = plansRes.catalog.plans || plansRes.catalog;
        catalogsRepo.hydratePlans(plans, plansRes.etag);
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not fetch public catalog snapshots');
    }
  }

  /**
   * Interactive operator login flow: registers machine if needed, authenticates with Backend,
   * establishes SecurityFacade session, pulls authoritative snapshot, and connects WebSocket.
   * @param {{ email: string, password: string }} credentials
   */
  async authenticateOperator({ email, password }) {
    if (!this.machineIdentity.publicKeyHex) {
      await this.machineIdentity.initialize();
    }
    try {
      const desc = this.machineIdentity.getDescriptor();
      const selfSig = this.machineIdentity.signPayload(Buffer.from(`REGISTRATION:${desc.hardwareId}`, 'utf8'));
      await this.client.registerMachine(desc.machineKeyPub, `inst_${desc.hardwareId}`, selfSig, desc);
    } catch { /* ignore if already registered */ }

    const authRes = await this.client.initAuth({ email, password });
    this.lastAuthResult = authRes;
    if (authRes?.graceToken) {
      this.lastGraceToken = authRes.graceToken;
    }
    this.isConnected = true;

    if (clock) {
      await clock.updateAnchor(Date.now()).catch(() => {});
    }

    const securityResult = await securityFacade.establishSession(authRes);
    await this.pullAuthoritativeSnapshot();
    this.isHydrated = true;
    await this.flushOutbox();
    this.saveLocalCache();

    if (this.enableWebSocket && this.client.sessionId) {
      this.connectWebSocket();
    }

    return { authRes, securityResult };
  }

  /**
   * Interactive operator registration flow: registers operator on Backend, establishes session,
   * and hydrates initial state.
   * @param {{ email: string, password: string, name?: string }} params
   */
  async registerOperator({ email, password, name }) {
    if (!this.machineIdentity.publicKeyHex) {
      await this.machineIdentity.initialize();
    }
    try {
      const desc = this.machineIdentity.getDescriptor();
      const selfSig = this.machineIdentity.signPayload(Buffer.from(`REGISTRATION:${desc.hardwareId}`, 'utf8'));
      await this.client.registerMachine(desc.machineKeyPub, `inst_${desc.hardwareId}`, selfSig, desc);
    } catch { /* ignore if already registered */ }

    const authRes = await this.client.registerOperator({ email, password, name });
    this.lastAuthResult = authRes;
    if (authRes?.graceToken) {
      this.lastGraceToken = authRes.graceToken;
    }
    this.isConnected = true;

    if (clock) {
      await clock.updateAnchor(Date.now()).catch(() => {});
    }

    const securityResult = await securityFacade.establishSession(authRes);
    await this.pullAuthoritativeSnapshot();
    this.isHydrated = true;

    if (this.enableWebSocket && this.client.sessionId) {
      this.connectWebSocket();
    }

    return { authRes, securityResult };
  }

  /**
   * Logs out current operator session, scrubs local user-scoped cache, and disconnects event stream.
   */
  async logoutOperator() {
    this.disconnectWebSocket();
    if (this.client?.sessionId && typeof this.client.logout === 'function') {
      await this.client.logout().catch(() => {});
    }
    await securityFacade.logout().catch(() => {});
    await securityFacade.transitionToUnauthenticated().catch(() => {});
    this.client.setSession(null, this.client.machineId);
    this.lastAuthResult = null;
    this.lastGraceToken = null;
    this.lastSyncTimestamp = null;
    this.lastSyncHrtime = null;
    this.outbox = [];
    if (this.engine) {
      try {
        this.engine.run('DELETE FROM sync_outbox');
      } catch { /* ignore */ }
    }
    if (this.cacheFilePath && fs.existsSync(this.cacheFilePath)) {
      try {
        fs.unlinkSync(this.cacheFilePath);
      } catch { /* ignore */ }
    }
    try {
      const { vaultCredentialPipeline } = await import('../runtime-manager/boundary/VaultCredentialPipeline.mjs');
      vaultCredentialPipeline.clear();
    } catch { /* ignore */ }
    try {
      const { getSharedStateStore } = await import('../state-store/sharedStateStore.mjs');
      const store = getSharedStateStore();
      store.onLogout();
    } catch { /* ignore */ }
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
        console.log('✓ [ControlPlane] Connected to Cloud Backend Event Stream (/ws/v1/events)');
        this.reconnectAttempts = 0;
        this.flushOutbox().catch(err => {
          logger.warn({ err: err.message }, '[BackendSyncService] Error flushing outbox upon WS open');
        });
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

    // Check server epoch reset / progression
    const incomingEpoch = Number(event.server_epoch ?? event.epoch ?? 0);
    if (incomingEpoch > 0) {
      if (this.lastObservedEpoch === 0) {
        this.lastObservedEpoch = incomingEpoch;
      } else if (incomingEpoch > this.lastObservedEpoch) {
        logger.info({ incomingEpoch, lastEpoch: this.lastObservedEpoch }, '[BackendSyncService] New server epoch detected! Resetting sequence watermarks and reconciling state.');
        this.accountSequences.clear();
        this.lastObservedSequence = 0;
        this.lastObservedEpoch = incomingEpoch;
        try {
          if (!this._reconcilingPromise) {
            this._reconcilingPromise = this.pullAuthoritativeSnapshot();
          }
          await this._reconcilingPromise;
        } catch (err) {
          logger.error({ err: err.message }, '[BackendSyncService] Authoritative state reconciliation failed on epoch change');
          return;
        } finally {
          this._reconcilingPromise = null;
        }
      } else if (incomingEpoch < this.lastObservedEpoch) {
        logger.debug({ incomingEpoch, currentEpoch: this.lastObservedEpoch }, '[BackendSyncService] Dropping event from prior server epoch');
        return;
      }
    }

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
        
        // Await authoritative state reconciliation to restore clean baseline
        try {
          if (!this._reconcilingPromise) {
            this._reconcilingPromise = this.pullAuthoritativeSnapshot();
          }
          await this._reconcilingPromise;
        } catch (err) {
          logger.error({ err: err.message }, '[BackendSyncService] Authoritative state reconciliation failed after gap');
          return;
        } finally {
          this._reconcilingPromise = null;
        }

        // Drop frame if superseded by authoritative snapshot
        const currentWatermark = this.accountSequences.get(accountId) ?? (this.lastObservedSequence ?? 0);
        if (seq <= currentWatermark) {
          logger.debug({ accountId, seq, currentWatermark }, '[BackendSyncService] Frame already captured by authoritative snapshot, dropping');
          return;
        }

        this.accountSequences.set(accountId, seq);
        this.lastObservedSequence = Math.max(this.lastObservedSequence, seq);
      } else {
        // Duplicate or stale frame (seq <= lastSeq)
        logger.debug({ accountId, seq, lastSeq }, '[BackendSyncService] Dropping duplicate or stale frame');
        return;
      }
    }

    // 2. Domain Event Routing
    switch (eventType) {
      case 'LICENSE_UPDATED': {
        const licPayload = payload?.license || payload || {};
        const caps = Array.isArray(licPayload.capabilities)
          ? licPayload.capabilities
          : (Array.isArray(payload?.capabilities)
            ? payload.capabilities
            : ['CAP_AUTOMATION_START', 'CAP_AUTOMATION_STOP', 'CAP_FILE_UPLOAD', 'CAP_TACTICAL_BET', 'CAP_CASH_OUT', 'CAP_CONFIG_MODIFY']);
        const sessionId = this.client?.sessionId || this.lastAuthResult?.sessionId || 'active-session';
        const sessionGeneration = this.lastAuthResult?.sessionGeneration || 1;
        await securityFacade.establishSession({
          ...(this.lastAuthResult || {}),
          sessionId,
          sessionGeneration,
          capabilities: caps,
          license: {
            ...(this.lastAuthResult?.license || {}),
            ...licPayload,
            licenseId: payload?.licenseKey || licPayload.licenseId || this.lastAuthResult?.license?.licenseId || `lic-${payload?.accountId || 'active'}`,
            status: licPayload.status || 'VALID',
            planId: licPayload.planId || this.lastAuthResult?.license?.planId || 'pro',
            capabilities: caps
          }
        }).catch(() => {});
        const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
        wsServer.broadcast('billing:snapshot', billingSnapshot);
        try {
          const { workspaceAggregator } = await import('../state/workspaceAggregator.mjs');
          const snap = await workspaceAggregator.getSnapshot();
          wsServer.broadcast('automation:snapshot', snap);
          wsServer.broadcast('automation:delta', {
            type: 'CAPABILITIES_CHANGED',
            capabilities: snap.capabilities,
            fleetReadiness: snap.fleetReadiness
          });
        } catch { /* ignore */ }
        break;
      }

      case 'LICENSE_REVOKED': {
        logger.error({ reason: payload?.reason }, '[BackendSyncService] Authoritative license revoked by Backend! Executing immediate fail-closed revocation.');
        await securityFacade.revokeLicense(payload?.reason || 'AUTHORITATIVE_BACKEND_REVOCATION');
        wsServer.broadcast('app:state', { state: 'Revoked', reason: payload?.reason });
        wsServer.broadcast('license:revoked', { reason: payload?.reason });
        break;
      }

      case 'SUBSCRIPTION_STATUS_CHANGED':
      case 'subscription:expired': {
        if (eventType === 'subscription:expired') {
          await securityFacade.transitionToDegraded('SUBSCRIPTION_EXPIRED_PUSH').catch(() => {});
          wsServer.broadcast('app:state', { state: 'Payment_Required' });
        } else if (payload.subscription) {
          const sub = payload.subscription;
          const normalizedStatus = sub.status === 'ACTIVE' ? 'Active' : (sub.status === 'PAST_DUE' ? 'Past_Due' : (sub.status === 'CANCELLED' ? 'Cancelled' : sub.status));
          const normalizedSub = {
            ...sub,
            planId: sub.planId || sub.plan_id || sub.currentPlanId,
            status: normalizedStatus
          };
          await repositoryFactory.getBillingRepo().updateSubscription(normalizedSub);
          if (normalizedStatus === 'Active') {
            const defaultCaps = ['CAP_AUTOMATION_START', 'CAP_AUTOMATION_STOP', 'CAP_FILE_UPLOAD', 'CAP_TACTICAL_BET', 'CAP_CASH_OUT', 'CAP_CONFIG_MODIFY'];
            const sessionId = this.client?.sessionId || this.lastAuthResult?.sessionId || 'active-session';
            const sessionGeneration = this.lastAuthResult?.sessionGeneration || 1;
            await securityFacade.establishSession({
              ...(this.lastAuthResult || {}),
              sessionId,
              sessionGeneration,
              capabilities: Array.isArray(sub.capabilities) && sub.capabilities.length > 0 ? sub.capabilities : defaultCaps,
              license: {
                ...(this.lastAuthResult?.license || {}),
                status: 'VALID',
                planId: normalizedSub.planId || 'pro',
                capabilities: Array.isArray(sub.capabilities) && sub.capabilities.length > 0 ? sub.capabilities : defaultCaps
              }
            }).catch(() => {});
            wsServer.broadcast('app:state', { state: 'Authorized' });
            try {
              const { workspaceAggregator } = await import('../state/workspaceAggregator.mjs');
              const snap = workspaceAggregator.getSnapshot();
              wsServer.broadcast('automation:snapshot', snap);
              wsServer.broadcast('automation:delta', {
                type: 'CAPABILITIES_CHANGED',
                capabilities: snap.capabilities,
                fleetReadiness: snap.fleetReadiness
              });
            } catch { /* ignore */ }
          } else if (normalizedStatus === 'Past_Due' || normalizedStatus === 'Payment_Required' || normalizedStatus === 'EXPIRED' || normalizedStatus === 'Expired') {
            await securityFacade.transitionToDegraded('SUBSCRIPTION_EXPIRED_PUSH').catch(() => {});
            wsServer.broadcast('app:state', { state: 'Payment_Required' });
          }
        }
        const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
        wsServer.broadcast('billing:snapshot', billingSnapshot);
        break;
      }

      case 'accounts:delta': {
        const innerType = payload.type || payload.action;
        const targetAccId = payload.accountId || payload.id || payload.partialSnapshot?.id;

        if (innerType === 'ACCOUNT_STATUS_CHANGED' || innerType === 'ACCOUNT_LOCKED') {
          if (targetAccId) {
            await repositoryFactory.getAccountsRepo().update(targetAccId, {
              backendState: payload.backendState || payload.status || (innerType === 'ACCOUNT_LOCKED' ? 'LOCKED' : 'SUSPENDED'),
              presentationCategory: payload.presentationCategory,
              statusDescription: payload.statusDescription
            });
          }
        } else if (innerType === 'ACCOUNT_CREATED' && payload.partialSnapshot) {
          try {
            await repositoryFactory.getAccountsRepo().create(payload.partialSnapshot);
          } catch { /* ignore if already exists */ }
        }

        wsServer.broadcast('accounts:delta', payload);
        break;
      }

      case 'automation:delta': {
        wsServer.broadcast('automation:delta', payload);
        break;
      }

      case 'ACCOUNT_LOCKED':
      case 'ACCOUNT_STATUS_CHANGED': {
        const targetAccId = payload.accountId || payload.id;
        if (targetAccId) {
          await repositoryFactory.getAccountsRepo().update(targetAccId, {
            backendState: payload.backendState || payload.status || (eventType === 'ACCOUNT_LOCKED' ? 'LOCKED' : 'SUSPENDED'),
            presentationCategory: payload.presentationCategory,
            statusDescription: payload.statusDescription
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
        await this.logoutOperator().catch(() => {});
        this.client.setSession(null, null);
        wsServer.broadcast('app:state', 'Unauthenticated');
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
   * Anchored to hardware monotonic timer and persistent clock rollback detection.
   * If exceeded or tampered, transitions Security Authority into Degraded mode.
   * @returns {boolean} True if within grace period, false if expired.
   */
  checkGracePeriod() {
    // 1. PersistentClock rollback check - fail-closed if boot-time clock rollback or anchor tampering detected
    if (clock && clock.isUncertain) {
      logger.warn('[BackendSyncService] Clock rollback detected or time anchor uncertain. Grace period denied.');
      return false;
    }

    // 2. Cryptographic GraceToken verification if present (or mandatory in production)
    if (this.lastGraceToken) {
      if (!licenseManager.verifyGraceToken(this.lastGraceToken)) {
        logger.warn('[BackendSyncService] Offline GraceToken failed cryptographic signature or expiry verification. Grace period denied.');
        if (!securityFacade.isDegraded()) {
          securityFacade.transitionToDegraded('INVALID_GRACE_TOKEN').catch(() => {});
        }
        return false;
      }
    } else if (process.env.NODE_ENV === 'production') {
      logger.warn('[BackendSyncService] Missing signed GraceToken in production. Grace period denied.');
      return false;
    }

    let timestamp = this.lastSyncTimestamp;
    if (!timestamp && this.engine) {
      try {
        const rows = this.engine.query("SELECT last_validated_at FROM cache_metadata WHERE entity_key = 'billing'");
        if (rows && rows[0]?.last_validated_at) {
          timestamp = rows[0].last_validated_at;
          this.lastSyncTimestamp = timestamp;
        }
      } catch { /* ignore */ }
    }
    if (!timestamp) return false;

    // 3. Monotonic elapsed duration check from process.hrtime.bigint()
    let elapsedMonotonicMs = null;
    if (this.lastSyncHrtime) {
      const elapsedNs = process.hrtime.bigint() - this.lastSyncHrtime;
      elapsedMonotonicMs = Number(elapsedNs / 1000000n);
    }

    const isWithin = FreshnessEvaluator.isSubscriptionWithinGracePeriod(timestamp, elapsedMonotonicMs);
    if (!isWithin && !securityFacade.isDegraded()) {
      logger.warn('[BackendSyncService] 2-hour offline operational grace period expired. Transitioning to degraded mode.');
      securityFacade.transitionToDegraded('GRACE_PERIOD_EXPIRED').catch(() => {});
    }
    return isWithin;
  }

  /**
   * Computes authoritative offline grace lease anchored to backend lastSyncTimestamp.
   * Defeats caller tampering, restart extensions, and OS wall-clock rollbacks.
   * @returns {{ lastValidatedAt: string, cachedTime: number, expiresAt: number, remainingMs: number } | null}
   */
  getOfflineGraceLease() {
    // 1. Clock rollback or uncertainty check - fail-closed
    if (clock && clock.isUncertain) {
      logger.warn('[BackendSyncService] Clock rollback or uncertain time anchor detected. Grace lease denied.');
      return null;
    }

    // 2. Cryptographic GraceToken verification if present (or mandatory in production)
    if (this.lastGraceToken) {
      if (!licenseManager.verifyGraceToken(this.lastGraceToken)) {
        logger.warn('[BackendSyncService] Offline GraceToken failed cryptographic signature or expiry verification. Grace lease denied.');
        return null;
      }
    } else if (process.env.NODE_ENV === 'production') {
      logger.warn('[BackendSyncService] Missing signed GraceToken in production. Grace lease denied.');
      return null;
    }

    let timestamp = this.lastSyncTimestamp;
    if (!timestamp && this.engine) {
      try {
        const rows = this.engine.query("SELECT last_validated_at FROM cache_metadata WHERE entity_key = 'billing'");
        if (rows && rows[0]?.last_validated_at) {
          timestamp = rows[0].last_validated_at;
          this.lastSyncTimestamp = timestamp;
        }
      } catch { /* ignore */ }
    }
    if (!timestamp) return null;

    const cachedTime = new Date(timestamp).getTime();
    if (isNaN(cachedTime)) return null;

    // Fixed 2-hour TTL constant (7,200,000ms) from FreshnessEvaluator
    const maxGraceMs = FreshnessEvaluator.TTL_POLICIES.subscription_grace * 1000;
    const absoluteExpiresAt = cachedTime + maxGraceMs;

    const currentClockTime = clock ? clock.now() : Date.now();

    // Rollback detection: current time cannot precede the backend's validation timestamp
    if (currentClockTime < cachedTime) {
      logger.warn('[BackendSyncService] System time is earlier than authoritative sync timestamp. Grace lease denied.');
      return null;
    }

    // Hardware monotonic check
    if (this.lastSyncHrtime) {
      const elapsedNs = process.hrtime.bigint() - this.lastSyncHrtime;
      const elapsedMs = Number(elapsedNs / 1000000n);
      if (elapsedMs >= maxGraceMs) {
        logger.warn('[BackendSyncService] Hardware monotonic timer exceeded 2-hour grace period.');
        return null;
      }
    }

    const remainingMs = absoluteExpiresAt - currentClockTime;
    if (remainingMs <= 0) {
      logger.warn('[BackendSyncService] 2-hour operational grace period expired based on sync timestamp.');
      return null;
    }

    return {
      lastValidatedAt: timestamp,
      cachedTime,
      expiresAt: absoluteExpiresAt,
      remainingMs
    };
  }

  /**
   * Starts the background monitor for the 2-hour offline operational grace period.
   * Periodically checks if the grace period has expired while offline.
   * @param {() => void} [onExpired] Optional callback when grace expires (e.g. quarantine execution)
   */
  startGracePeriodMonitor(onExpired) {
    if (this.graceMonitorInterval) return;
    this.graceMonitorInterval = setInterval(async () => {
      if (this.isConnected) {
        this.stopGracePeriodMonitor();
        return;
      }
      const isWithin = this.checkGracePeriod();
      if (!isWithin) {
        logger.warn('[BackendSyncService] Grace monitor tripped: 2-hour operational window expired.');
        if (typeof onExpired === 'function') {
          try { onExpired(); } catch {}
        }
        this.stopGracePeriodMonitor();
      }
    }, 30000);
    if (this.graceMonitorInterval && typeof this.graceMonitorInterval.unref === 'function') {
      this.graceMonitorInterval.unref();
    }
  }

  /**
   * Stops the grace period monitor.
   */
  stopGracePeriodMonitor() {
    if (this.graceMonitorInterval) {
      clearInterval(this.graceMonitorInterval);
      this.graceMonitorInterval = null;
    }
  }

  /**
   * Pulls authoritative automation, accounts, billing, and catalogs state from Backend.
   */
  async pullAuthoritativeSnapshot() {
    const configRepo = repositoryFactory.getConfigRepo();
    const accountsRepo = repositoryFactory.getAccountsRepo();
    const billingRepo = repositoryFactory.getBillingRepo();
    let anyAuthDomainSucceeded = false;

    // 1. Fetch automation configuration and accounts snapshot
    try {
      const autoSnapshot = await this.client.getAutomationSnapshot();
      if (autoSnapshot) {
        anyAuthDomainSucceeded = true;
      }
      if (autoSnapshot?.globalConfig) {
        configRepo.hydrate(autoSnapshot.globalConfig);
      }
      if (Array.isArray(autoSnapshot?.accounts) && autoSnapshot.accounts.length > 0) {
        accountsRepo.hydrate(autoSnapshot.accounts);
        try {
          const { vaultCredentialPipeline } = await import('../runtime-manager/boundary/VaultCredentialPipeline.mjs');
          for (const acc of autoSnapshot.accounts) {
            if (acc?.id && acc?.accountPassword) {
              vaultCredentialPipeline.storeCredential(acc.id, acc.accountPassword);
            }
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not fetch automation snapshot directly');
    }

    // 2. Fetch full betting accounts list
    try {
      const accountsRes = await this.client.getBettingAccounts({ limit: 1000 });
      if (Array.isArray(accountsRes?.viewportAccounts)) {
        anyAuthDomainSucceeded = true;
        accountsRepo.hydrate(accountsRes.viewportAccounts);
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not fetch accounts list directly');
    }

    // 3. Fetch billing snapshot (subscription & invoices)
    try {
      const billingRes = await this.client.getBillingSnapshot();
      if (billingRes) {
        anyAuthDomainSucceeded = true;
        const sub = billingRes.subscription || (billingRes.status ? billingRes : null);
        const invs = billingRes.invoices || [];
        if (typeof billingRepo.hydrate === 'function') {
          billingRepo.hydrate(sub, invs);
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[BackendSyncService] Could not fetch billing snapshot directly');
    }

    // 4. Fetch platform registry and plans catalog with conditional ETag revalidation
    await this.pullPublicCatalogs();

    if (anyAuthDomainSucceeded) {
      this.lastSyncTimestamp = new Date().toISOString();
      this.lastSyncHrtime = process.hrtime.bigint();
      if (clock) {
        await clock.updateAnchor(Date.now()).catch(() => {});
      }
    }
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
        lastSyncTimestamp: this.lastSyncTimestamp || null,
        graceToken: this.lastGraceToken || null,
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
      if (cachePayload.graceToken) {
        this.lastGraceToken = cachePayload.graceToken;
      }
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
   * Executes the physical network call to the backend client for a mutation.
   * @param {string} type
   * @param {any} payload
   */
  async _dispatchMutation(type, payload) {
    let result;
    switch (type) {
      case 'REGISTER_ACCOUNT':
        // NOTE: Do NOT scrub accountPassword! Backend database encrypts it with AES-256-GCM AEAD.
        result = await this.client.createBettingAccount(payload);
        break;

      case 'UPDATE_ACCOUNT_CREDENTIALS':
        result = await this.client.updateBettingAccount(payload.accountId, payload);
        break;

      case 'UPDATE_GLOBAL_CONFIG':
        result = await this.client.updateGlobalConfig(payload.category, payload.values);
        break;

      case 'UPDATE_ACCOUNT_CONFIG':
        result = await this.client.updateAccountConfigOverride(payload.accountId, payload.category, payload.config);
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
    return result;
  }

  /**
   * Flushes pending mutations in the outbox to the Cloud Backend.
   * Applies exponential backoff on retries.
   * @returns {Promise<{ flushed: number, remaining: number }>}
   */
  async flushOutbox() {
    if (!this.isConnected) {
      return { flushed: 0, remaining: this.outbox.length };
    }

    const now = Date.now();
    let flushed = 0;

    for (let i = 0; i < this.outbox.length; i++) {
      const item = this.outbox[i];
      if (item.status !== 'PENDING' || item.nextRetryAt > now) {
        continue;
      }

      try {
        await this._dispatchMutation(item.mutationType, item.payload);
        flushed++;
        if (this.engine) {
          try {
            this.engine.run(`DELETE FROM sync_outbox WHERE id = ?`, [item.id]);
          } catch { /* ignore */ }
        }
        this.outbox.splice(i, 1);
        i--;
      } catch (err) {
        if (err.message?.includes('GENERATION_MISMATCH') || err.code === 'BE_REV_GENERATION_MISMATCH') {
          const email = process.env.OPERATOR_EMAIL || null;
          const password = process.env.OPERATOR_PASSWORD || null;
          if (email && password) {
            logger.warn('[BackendSyncService] Outbox flush detected GENERATION_MISMATCH. Re-authenticating with configured operator credentials...');
            try {
              const authRes = await this.client.initAuth({ email, password });
              if (authRes?.graceToken) this.lastGraceToken = authRes.graceToken;
              await this._dispatchMutation(item.mutationType, item.payload);
              flushed++;
              if (this.engine) {
                try { this.engine.run(`DELETE FROM sync_outbox WHERE id = ?`, [item.id]); } catch { /* ignore */ }
              }
              this.outbox.splice(i, 1);
              i--;
              continue;
            } catch (retryErr) {
              logger.error({ err: retryErr.message }, '[BackendSyncService] Re-authentication retry failed during outbox flush');
            }
          } else {
            logger.warn('[BackendSyncService] Outbox flush detected GENERATION_MISMATCH without configured auto-reauth credentials. Requiring interactive re-authentication.');
            await securityFacade.transitionToDegraded('GENERATION_MISMATCH_REAUTH_REQUIRED').catch(() => {});
            wsServer.broadcast('app:state', { state: 'Unauthenticated', reason: 'GENERATION_MISMATCH' });
            break;
          }
        }

        // If the resource already exists on backend, consider mutation fulfilled
        if (err.code === 'BE_STATE_ACCOUNT_EXISTS' || err.code === 'ACCOUNT_EXISTS' || err.message?.includes('already exists')) {
          logger.info({ item: item.id, type: item.mutationType }, '[BackendSyncService] Resource already exists on Backend; reconciling outbox');
          flushed++;
          if (this.engine) {
            try { this.engine.run(`DELETE FROM sync_outbox WHERE id = ?`, [item.id]); } catch { /* ignore */ }
          }
          this.outbox.splice(i, 1);
          i--;
          continue;
        }

        // If non-retryable protocol failure and max attempts reached, drop from outbox
        if (err.details?.retryable === false && (item.attempts || 0) >= 3) {
          logger.warn({ item: item.id, type: item.mutationType, err: err.message }, '[BackendSyncService] Non-retryable protocol failure; dropping outbox item');
          if (this.engine) {
            try { this.engine.run(`DELETE FROM sync_outbox WHERE id = ?`, [item.id]); } catch { /* ignore */ }
          }
          this.outbox.splice(i, 1);
          i--;
          continue;
        }

        item.attempts = (item.attempts || 0) + 1;
        const delayMs = Math.min(300_000, 1000 * Math.pow(2, item.attempts));
        item.nextRetryAt = Date.now() + delayMs;
        item.lastError = err.message;

        if (this.engine) {
          try {
            this.engine.run(`
              UPDATE sync_outbox
              SET attempts = ?, next_retry_at = ?, last_error = ?
              WHERE id = ?
            `, [item.attempts, item.nextRetryAt, item.lastError, item.id]);
          } catch { /* ignore */ }
        }
      }
    }

    return { flushed, remaining: this.outbox.length };
  }

  /**
   * Synchronizes an ingress mutation with the Cloud Backend.
   * Preserves full account payload including accountPassword per boundary contract.
   * If offline or communication fails, enqueues into persistent retry outbox.
   * @param {'REGISTER_ACCOUNT' | 'UPDATE_GLOBAL_CONFIG' | 'UPDATE_ACCOUNT_CONFIG' | 'TOGGLE_BET_CYCLE' | 'ACCOUNT_ACTION' | 'CANCEL_SUBSCRIPTION' | 'RESUME_SUBSCRIPTION' | 'SUBMIT_SETTINGS'} type 
   * @param {any} payload 
   * @returns {Promise<any>}
   */
  async syncMutation(type, payload) {
    if (!this.isConnected) {
      logger.info({ type }, '[BackendSyncService] Backend offline; mutation enqueued in retry outbox');
      const item = this.enqueueOutbox(type, payload);
      this.saveLocalCache();
      return { localOnly: true, queuedForRetry: true, outboxId: item.id };
    }

    try {
      const result = await this._dispatchMutation(type, payload);
      this.saveLocalCache();
      return result;
    } catch (err) {
      if (err.message?.includes('GENERATION_MISMATCH') || err.code === 'BE_REV_GENERATION_MISMATCH') {
        const email = process.env.OPERATOR_EMAIL || null;
        const password = process.env.OPERATOR_PASSWORD || null;
        if (email && password) {
          logger.warn('[BackendSyncService] GENERATION_MISMATCH detected. Re-authenticating session with configured operator credentials...');
          try {
            const authRes = await this.client.initAuth({ email, password });
            if (authRes?.graceToken) this.lastGraceToken = authRes.graceToken;
            const result = await this._dispatchMutation(type, payload);
            this.saveLocalCache();
            return result;
          } catch (retryErr) {
            logger.error({ err: retryErr.message }, '[BackendSyncService] Re-authentication failed after generation mismatch');
          }
        } else {
          logger.warn('[BackendSyncService] GENERATION_MISMATCH detected without configured auto-reauth credentials. Requiring interactive re-authentication.');
          await securityFacade.transitionToDegraded('GENERATION_MISMATCH_REAUTH_REQUIRED').catch(() => {});
          wsServer.broadcast('app:state', { state: 'Unauthenticated', reason: 'GENERATION_MISMATCH' });
        }
      }

      // If the resource already exists on backend, do not enqueue into retry outbox
      if (err.code === 'BE_STATE_ACCOUNT_EXISTS' || err.code === 'ACCOUNT_EXISTS' || err.message?.includes('already exists')) {
        logger.info({ type }, '[BackendSyncService] Resource already exists on Backend; ignoring duplicate');
        this.saveLocalCache();
        return { exists: true, duplicated: true };
      }

      // Fail-fast on authoritative Backend policy/entitlement/validation rejections (do not enqueue in retry outbox)
      const policyRejectCodes = new Set([
        'ENTITLEMENT_LIMIT_REACHED',
        'BE_PERM_ENTITLEMENT_EXCEEDED',
        'BE_PERM_LICENSE_EXPIRED',
        'BE_PERM_FORBIDDEN',
        'BE_VAL_SCHEMA_VIOLATION',
        'BE_VAL_INVALID_UUID',
        'HTTP_403',
        'HTTP_400'
      ]);
      if (policyRejectCodes.has(err.code) || err.status === 403 || err.status === 400) {
        err.isPolicyRejection = true;
        logger.warn({ type, code: err.code, err: err.message }, '[BackendSyncService] Authoritative Backend policy rejection; failing fast without outbox retry');
        throw err;
      }

      logger.warn({ type, err: err.message }, '[BackendSyncService] Failed to sync mutation directly to Backend; enqueuing in retry outbox');
      const item = this.enqueueOutbox(type, payload);
      this.saveLocalCache();
      return { localOnly: true, queuedForRetry: true, outboxId: item.id, error: err.message };
    }
  }

  /**
   * Shuts down the sync service, disconnecting WebSockets and timers.
   */
  stop() {
    this.isStopping = true;
    this.stopGracePeriodMonitor();
    this.disconnectWebSocket();
  }
}

export const backendSyncService = new BackendSyncService();

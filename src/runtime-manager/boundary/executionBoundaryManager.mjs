// @ts-check
import EventEmitter from 'node:events';
import { PipeTransport } from './pipeTransport.mjs';
import { IdempotencyLedger } from './idempotencyLedger.mjs';
import { ReconciliationCoordinator } from './reconciliationCoordinator.mjs';
import { WatchdogMonitor } from './watchdogMonitor.mjs';
import { SyncMetricsCollector } from './syncMetricsCollector.mjs';
import {
  ExecutionMessageType,
  ExecutionErrorCode,
  createExecutionEnvelope,
  validateExecutionEnvelope
} from '../executionProtocol.mjs';
import { securityFacade } from '../../security-authority/facade.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { AsyncMutex } from '../../shared/AsyncMutex.mjs';
import { ExecutionPayloadBuilder } from './ExecutionPayloadBuilder.mjs';
import { vaultCredentialPipeline } from './VaultCredentialPipeline.mjs';

/**
 * ExecutionBoundaryManager
 * 
 * Encapsulates all Execution Plane interface complexities behind a cohesive facade.
 * Manages Windows Named Pipe communication, wire framing, Protocol v3.0 message envelopes,
 * zero-secret credential compilation, financial idempotency, out-of-band reconciliation,
 * liveness watchdog monitoring, and telemetry synchronization.
 */
export class ExecutionBoundaryManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {PipeTransport} [options.transport]
   * @param {IdempotencyLedger} [options.idempotencyLedger]
   * @param {ReconciliationCoordinator} [options.reconciliationCoordinator]
   * @param {WatchdogMonitor} [options.watchdogMonitor]
   * @param {SyncMetricsCollector} [options.syncMetricsCollector]
   * @param {any} [options.stateStore]
   * @param {any} [options.securityAuthority]
   * @param {number} [options.defaultCommandTimeoutMs=10000]
   */
  constructor({
    transport = null,
    idempotencyLedger = null,
    reconciliationCoordinator = null,
    watchdogMonitor = null,
    syncMetricsCollector = null,
    stateStore = null,
    securityAuthority = null,
    defaultCommandTimeoutMs = 10_000
  } = {}) {
    super();
    this.transport = transport || new PipeTransport();
    this.idempotency = idempotencyLedger || new IdempotencyLedger();
    this.reconciliation = reconciliationCoordinator || new ReconciliationCoordinator();
    this.watchdog = watchdogMonitor || new WatchdogMonitor();
    this.sync = syncMetricsCollector || new SyncMetricsCollector();
    this.stateStore = stateStore || null;
    this.security = securityAuthority || securityFacade;
    this.defaultCommandTimeoutMs = defaultCommandTimeoutMs;
    this.lifecycleMutex = new AsyncMutex();
    this.vault = vaultCredentialPipeline;

    this.engineStatus = 'OFFLINE';
    this.activeBrowserCount = 0;

    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, type: string, traceId: string }>} */
    this.pendingCorrelations = new Map();

    this._bindInternalEvents();
  }

  /**
   * Binds event listeners across encapsulated sub-engines.
   * @private
   */
  _bindInternalEvents() {
    this.transport.on('connection', (connId) => this._handleClientConnected(connId));
    this.transport.on('data', (connId, data) => this._handleIncomingData(connId, data));
    this.transport.on('disconnection', (connId) => this._handleClientDisconnected(connId));
    this.transport.on('error', (err) => this.emit('error', err));

    this.watchdog.on('heartbeat', (payload) => this.emit('heartbeat', payload));
    this.watchdog.on('livenessWarning', (data) => this.emit('livenessWarning', data));
    this.watchdog.on('livenessDegraded', (data) => {
      this.engineStatus = 'DEGRADED';
      this.emit('livenessDegraded', data);
    });
    this.watchdog.on('quarantineRequired', (data) => {
      this.engineStatus = 'DEGRADED_HALTED';
      this.emit('quarantineRequired', data);
    });

    this.reconciliation.on('accountFrozen', (rec) => this.emit('accountFrozen', rec));
    this.reconciliation.on('accountUnfrozen', (rec) => this.emit('accountUnfrozen', rec));
    this.reconciliation.on('reconciliationResolved', (res) => this.emit('reconciliationResolved', res));

    this.sync.on('syncMetrics', (metrics) => this.emit('syncMetrics', metrics));
    this.sync.on('syncDiverged', (alert) => this.emit('syncDiverged', alert));
  }

  // --- Transport & Server Lifecycle ---

  startServer() {
    this.transport.startServer();
    this.watchdog.start();
  }

  stopServer() {
    this.watchdog.stop();
    this.transport.stopServer();

    // Cancel all pending correlation timers
    for (const [msgId, pending] of this.pendingCorrelations.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Transport server stopped'));
      this.pendingCorrelations.delete(msgId);
    }

    this.engineStatus = 'OFFLINE';
    this.activeBrowserCount = 0;
  }

  isConnected() {
    return this.transport.isConnected();
  }

  getActiveConnections() {
    return this.transport.getActiveConnections();
  }

  getActiveBrowserCount() {
    return this.activeBrowserCount;
  }

  getEngineStatus() {
    return this.engineStatus;
  }

  /**
   * Low-level helper to send a typed ExecutionEnvelope without waiting for ACK.
   * @param {string} type
   * @param {any} payload
   * @param {string} [traceId]
   * @returns {boolean}
   */
  sendEnvelope(type, payload, traceId) {
    return /** @type {boolean} */ (this.dispatchEnvelope(type, payload, { traceId, waitForAck: false }));
  }

  // --- Low-Level Typed Dispatch with Request/Reply Correlation ---

  /**
   * Dispatches a typed ExecutionEnvelope across the boundary.
   * If waitForAck is true, returns a promise correlated to the msgId.
   * @param {string} type
   * @param {any} payload
   * @param {object | string} [options] - Options object or string traceId
   * @returns {Promise<any> | boolean}
   */
  dispatchEnvelope(type, payload = {}, options = {}) {
    this.startServer();

    const opts = typeof options === 'string' ? { traceId: options } : (options || {});
    const traceId = opts.traceId;
    const envelope = createExecutionEnvelope(type, payload, traceId, 'CONTROL_PLANE');
    const jsonString = JSON.stringify(envelope);

    if (!opts.waitForAck) {
      const sent = this.transport.broadcast(jsonString);
      return sent > 0;
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs || this.defaultCommandTimeoutMs;
      const timer = setTimeout(() => {
        if (this.pendingCorrelations.has(envelope.msgId)) {
          this.pendingCorrelations.delete(envelope.msgId);
          reject(new Error(`Command ${type} timed out after ${timeoutMs}ms (traceId: ${envelope.traceId})`));
        }
      }, timeoutMs);

      if (timer.unref) {
        timer.unref();
      }

      this.pendingCorrelations.set(envelope.msgId, {
        resolve,
        reject,
        timer,
        type,
        traceId: envelope.traceId
      });

      const sent = this.transport.broadcast(jsonString);
      if (sent === 0) {
        clearTimeout(timer);
        this.pendingCorrelations.delete(envelope.msgId);
        reject(new Error(`No active pipe connection to dispatch command: ${type}`));
      }
    });
  }

  // --- High-Level Command API for Callers (e.g. RuntimeManager) ---

  /**
   * Compiles the authoritative cold-boot LIFECYCLE:INITIALIZE payload from StateStore.
   * Decrypts credentials strictly into temporary memory for this frame; never leaks to disk.
   * @param {string} [traceId]
   * @returns {object}
   */
  compileInitializationPayload(traceId) {
    const store = this.stateStore || getSharedStateStore();
    return ExecutionPayloadBuilder.buildInitializationPayload(store, traceId);
  }

  /**
   * Initializes the Execution Plane with an authoritative payload.
   * @param {object} [initPayload]
   * @param {object} [options]
   */
  initialize(initPayload = null, options = {}) {
    const opts = typeof options === 'string' ? { traceId: options } : (options || {});
    const payload = initPayload || this.compileInitializationPayload(opts.traceId);
    this.engineStatus = 'INITIALIZING';
    return this.dispatchEnvelope(ExecutionMessageType.INITIALIZE, payload, opts);
  }

  /**
   * Alias for initializeWorker to match legacy RuntimeManager method signature.
   * @param {object} [initPayload]
   * @param {object | string} [options]
   */
  initializeWorker(initPayload = null, options = {}) {
    return this.initialize(initPayload, options);
  }

  /**
   * Transitions cluster automation to RUNNING.
   * Gated by SecurityAuthority and serialized via lifecycleMutex.
   * @param {object} [options]
   */
  async startCluster(options = {}) {
    return this.lifecycleMutex.runExclusive(async () => {
      if (this.security.isDegraded()) {
        throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
      }
      return this.dispatchEnvelope(ExecutionMessageType.START_CLUSTER, options.payload || {}, options);
    });
  }

  /**
   * Stops cluster execution gracefully.
   * Serialized via lifecycleMutex to prevent Start/Stop collision.
   * @param {number} [timeoutMs=5000]
   * @param {object} [options]
   */
  async stopCluster(timeoutMs = 5000, options = {}) {
    return this.lifecycleMutex.runExclusive(async () => {
      return this.dispatchEnvelope(ExecutionMessageType.STOP_CLUSTER, { timeoutMs }, options);
    });
  }

  /**
   * Dispatches a tactical bet command with financial idempotency verification.
   * @param {object} betPayload
   * @param {string} [betPayload.idempotencyKey]
   * @param {string} [betPayload.operationId]
   * @param {number} [betPayload.stake]
   * @param {number} [betPayload.odds]
   * @param {object} [options]
   */
  placeBet(betPayload, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }
    if (this.watchdog.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Execution Plane is DEGRADED (Watchdog Alert)');
    }

    // Invariant (Section 3.2 & 8.2): Prevent betting on frozen accounts
    const targetAccounts = betPayload?.targetAccounts || (betPayload?.accountId ? [betPayload.accountId] : []);
    for (const acc of targetAccounts) {
      if (this.isAccountFrozen(acc)) {
        throw new Error(`[EP_STATE_002] Execution Denied: Account [${acc}] is frozen pending reconciliation of an UNKNOWN transaction`);
      }
    }

    const idempotencyKey = betPayload?.idempotencyKey || `idem_${betPayload?.operationId || Date.now()}`;
    const check = this.idempotency.check(idempotencyKey);

    if (check.exists) {
      if (check.status === 'IN_FLIGHT') {
        return { duplicate: true, status: 'IN_FLIGHT', cachedAck: true };
      }
      if (check.status === 'COMPLETED') {
        return { duplicate: true, status: 'COMPLETED', cachedResult: check.cachedResult };
      }
      if (check.status === 'FAILED' && !betPayload?.forceRetry) {
        return { duplicate: true, status: 'FAILED', cachedResult: check.cachedResult, error: 'Operation previously failed. Re-execution requires forceRetry: true' };
      }
    }

    this.idempotency.recordInFlight(idempotencyKey, betPayload?.operationId || 'unknown', betPayload);
    return this.dispatchEnvelope(ExecutionMessageType.PLACE_BET, { ...betPayload, idempotencyKey }, options);
  }

  /**
   * Dispatches a cashout command with financial idempotency verification.
   * @param {object} cashOutPayload
   * @param {object} [options]
   */
  cashOut(cashOutPayload, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }
    if (this.watchdog.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Execution Plane is DEGRADED (Watchdog Alert)');
    }

    // Invariant (Section 3.2 & 8.2): Prevent cashout on frozen account
    const targetAccount = cashOutPayload?.accountId || cashOutPayload?.targetAccount;
    if (targetAccount && this.isAccountFrozen(targetAccount)) {
      throw new Error(`[EP_STATE_002] Execution Denied: Account [${targetAccount}] is frozen pending reconciliation of an UNKNOWN transaction`);
    }

    const idempotencyKey = cashOutPayload?.idempotencyKey || `idem_${cashOutPayload?.operationId || Date.now()}`;
    const check = this.idempotency.check(idempotencyKey);

    if (check.exists) {
      if (check.status === 'IN_FLIGHT') {
        return { duplicate: true, status: 'IN_FLIGHT', cachedAck: true };
      }
      if (check.status === 'COMPLETED') {
        return { duplicate: true, status: 'COMPLETED', cachedResult: check.cachedResult };
      }
      if (check.status === 'FAILED' && !cashOutPayload?.forceRetry) {
        return { duplicate: true, status: 'FAILED', cachedResult: check.cachedResult, error: 'Operation previously failed. Re-execution requires forceRetry: true' };
      }
    }

    this.idempotency.recordInFlight(idempotencyKey, cashOutPayload?.operationId || 'unknown', cashOutPayload);
    return this.dispatchEnvelope(ExecutionMessageType.CASH_OUT, { ...cashOutPayload, idempotencyKey }, options);
  }

  /**
   * Dispatches a tactical validation request.
   * @param {object} validatePayload
   * @param {object} [options]
   */
  validateTactical(validatePayload = {}, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }
    return this.dispatchEnvelope(ExecutionMessageType.VALIDATE, validatePayload, options);
  }

  /**
   * Activates an account browser in the running cluster.
   * Compiles decrypted credentials in temporary memory for IPC transmission.
   * @param {object} accountPayload
   * @param {object} [options]
   */
  activateAccount(accountPayload, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }

    let payload = accountPayload;
    if (accountPayload?.accountUsername) {
      payload = ExecutionPayloadBuilder.buildActivateAccountPayload(accountPayload);
    } else if (accountPayload?.accountId) {
      const store = this.stateStore || getSharedStateStore();
      const account = store.accountsContainer.getById(accountPayload.accountId);
      if (account) {
        payload = ExecutionPayloadBuilder.buildActivateAccountPayload(account);
      }
    }

    return this.dispatchEnvelope(ExecutionMessageType.ACTIVATE_ACCOUNT, payload, options);
  }

  /**
   * Deactivates an account browser in the running cluster.
   * @param {object} deactivatePayload
   * @param {object} [options]
   */
  deactivateAccount(deactivatePayload, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }
    return this.dispatchEnvelope(ExecutionMessageType.DEACTIVATE_ACCOUNT, deactivatePayload, options);
  }

  /**
   * Sets bet-cycle participation for an account browser.
   * @param {string} targetBrowserId
   * @param {boolean} isEnabled
   * @param {object} [options]
   */
  setBetCycle(targetBrowserId, isEnabled, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }
    return this.dispatchEnvelope(ExecutionMessageType.SET_BET_CYCLE, { targetBrowserId, isEnabled }, options);
  }

  /**
   * Hot-reloads configuration category without restarting browsers.
   * @param {string} category
   * @param {object} values
   * @param {object} [options]
   */
  updatePolicy(category, values, options = {}) {
    if (this.security.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: System is in DEGRADED mode (Backend Offline)');
    }
    return this.dispatchEnvelope(ExecutionMessageType.UPDATE_POLICY, { category, values }, options);
  }

  /**
   * Requests a diagnostic state dump from the Execution Plane.
   * Used on reconnection to resynchronize without restarting browsers.
   * @param {object} [options]
   */
  captureSnapshot(options = {}) {
    return this.dispatchEnvelope(ExecutionMessageType.CAPTURE_SNAPSHOT, {}, options);
  }

  /**
   * Reconciles an uncertain operation out-of-band.
   * @param {string} operationId
   * @param {object} [options]
   */
  reconcileOperation(operationId, options = {}) {
    const payload = this.reconciliation.createReconcileRequest(operationId);
    if (!payload) {
      throw new Error(`No pending uncertain operation to reconcile for operationId: ${operationId}`);
    }
    return this.dispatchEnvelope(ExecutionMessageType.RECONCILE_ORDER, payload, options);
  }

  /**
   * Checks if an account is currently frozen due to an UNKNOWN operation.
   * @param {string} accountId
   */
  isAccountFrozen(accountId) {
    return this.reconciliation.isAccountFrozen(accountId);
  }

  /**
   * Returns latest sync metrics snapshot.
   */
  getSyncMetrics() {
    return this.sync.getLatestMetrics();
  }

  // --- Inbound Framing & Message Demultiplexer ---

  /**
   * @param {number} connId
   * @private
   */
  _handleClientConnected(connId) {
    this.emit('clientConnected', connId);
    // On reconnection, query snapshot to reconcile state
    try {
      this.captureSnapshot({ traceId: `reconnect-snap-${connId}` });
    } catch {
      // Ignore if snapshot cannot be requested immediately
    }
  }

  /**
   * @param {number} connId
   * @private
   */
  _handleClientDisconnected(connId) {
    this.emit('clientDisconnected', connId);
    if (!this.transport.isConnected()) {
      this.engineStatus = 'STOPPED';
      this.activeBrowserCount = 0;

      // Fail any remaining in-flight correlations since pipe connection dropped
      for (const [msgId, pending] of this.pendingCorrelations.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Execution Plane disconnected while waiting for correlation: ${pending.type}`));
        this.pendingCorrelations.delete(msgId);
      }

      // Reconcile observed states in StateStore if present
      try {
        const store = this.stateStore || getSharedStateStore();
        if (store && store.lifecycle) {
          const current = store.lifecycle.getState();
          const target = current.desiredState === 'RUNNING' ? 'ABORTED' : 'STOPPED';
          store.lifecycle.setObservedState(target, `PIPE_DISCONNECTED_CONN_${connId}`);
          if (store.accounts && typeof store.accounts.resetObservedStates === 'function') {
            store.accounts.resetObservedStates(`PIPE_DISCONNECTED_CONN_${connId}`);
          }
        }
      } catch {
        // State store might not be initialized yet in isolation
      }
    }
  }

  /**
   * @param {number} connId
   * @param {string} data
   * @private
   */
  _handleIncomingData(connId, data) {
    try {
      const raw = JSON.parse(data);
      const { valid, envelope, error } = validateExecutionEnvelope(raw);

      if (!valid) {
        // Handle legacy heartbeat format gracefully
        if (raw && raw.type === 'HEARTBEAT' && raw.pid) {
          this.watchdog.recordHeartbeat(raw);
          return;
        }
        this.emit('protocolError', { connId, error, raw });
        return;
      }

      this.emit('envelope', envelope);

      // Check if any correlated pending promise matches this msgId / traceId
      if (this.pendingCorrelations.has(envelope.msgId)) {
        const pending = this.pendingCorrelations.get(envelope.msgId);
        clearTimeout(pending.timer);
        this.pendingCorrelations.delete(envelope.msgId);
        pending.resolve(envelope.payload);
      }

      // Demultiplex message types
      switch (envelope.type) {
        case ExecutionMessageType.HEARTBEAT: {
          const { pid, activeBrowsers, engineStatus } = envelope.payload || {};
          this.watchdog.recordHeartbeat(envelope.payload);
          if (typeof activeBrowsers === 'number') this.activeBrowserCount = activeBrowsers;
          if (engineStatus) this.engineStatus = engineStatus;
          break;
        }

        case ExecutionMessageType.STATE_CHANGED: {
          const { state, message } = envelope.payload || {};
          if (state) {
            this.engineStatus = state;
            this.emit('stateChanged', { state, message });
          }
          break;
        }

        case ExecutionMessageType.BROWSER_STATUS: {
          this.emit('browserStatus', envelope.payload);
          break;
        }

        case ExecutionMessageType.OPERATION_ACK: {
          this.emit('operationAck', envelope.payload);
          break;
        }

        case ExecutionMessageType.OPERATION_RESULT: {
          const { operationId, status, idempotencyKey, error, code } = envelope.payload || {};
          
          if (idempotencyKey) {
            if (status === 'COMPLETED' || status === 'SUCCESS') {
              this.idempotency.recordTerminal(idempotencyKey, 'COMPLETED', envelope.payload);
            } else if (status === 'FAILED') {
              this.idempotency.recordTerminal(idempotencyKey, 'FAILED', envelope.payload);
            }
          }

          // Invariant: If outcome is UNKNOWN or EP_TX_001, freeze account lease
          if (status === 'UNKNOWN' || code === ExecutionErrorCode.UNCERTAIN_OUTCOME) {
            const targetAccount = envelope.payload?.accountId || envelope.payload?.targetAccounts?.[0] || 'unknown';
            this.reconciliation.enqueueUncertainOperation({
              operationId,
              accountId: targetAccount,
              idempotencyKey,
              reason: error || 'Atomic bet commitment unconfirmed',
              details: envelope.payload
            });
          }

          this.emit('operationResult', envelope.payload);
          break;
        }

        case ExecutionMessageType.RECONCILIATION_REPORT: {
          const reportResult = this.reconciliation.handleReconciliationReport(envelope.payload);
          this.emit('reconciliationReport', { report: envelope.payload, result: reportResult });
          break;
        }

        case ExecutionMessageType.SNAPSHOT_DUMP: {
          const { engineStatus, activeBrowsers, activeBrowserCount, unresolvedRuns } = envelope.payload || {};
          if (engineStatus) this.engineStatus = engineStatus;
          if (typeof activeBrowserCount === 'number') this.activeBrowserCount = activeBrowserCount;

          // Invariant (Scenarios 1 & 14): Auto-enqueue any unresolved WAL runs to freeze accounts
          if (Array.isArray(unresolvedRuns)) {
            for (const run of unresolvedRuns) {
              if (run.status === 'UNCERTAIN' || run.status === 'PROCESSING' || run.status === 'UNKNOWN') {
                this.reconciliation.enqueueUncertainOperation({
                  operationId: run.operationId || run.runId,
                  accountId: run.accountId,
                  idempotencyKey: run.idempotencyKey,
                  reason: 'RECONNECT_UNRESOLVED_WAL_RUN',
                  details: run
                });
              }
            }
          }

          this.emit('snapshotDump', envelope.payload);
          break;
        }

        case ExecutionMessageType.ODDS_TICK: {
          this.emit('oddsTick', envelope.payload);
          break;
        }

        case ExecutionMessageType.SYNC_METRICS: {
          this.sync.recordMetrics(envelope.payload);
          break;
        }

        case ExecutionMessageType.AUDIT_EVENT: {
          this.emit('auditEvent', envelope.payload);
          break;
        }

        case ExecutionMessageType.UNKNOWN_COMMAND: {
          this.emit('unknownCommand', envelope.payload);
          break;
        }

        default:
          this.emit('unhandledEnvelope', envelope);
          break;
      }
    } catch (e) {
      this.emit('error', new Error(`Failed to route framed IPC payload: ${e.message}`));
    }
  }
}

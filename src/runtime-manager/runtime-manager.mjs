// @ts-check
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionAuthorization } from './execution-authorization.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { runtimeHeartbeat } from './heartbeat.mjs';
import { NativeCore } from '../security-authority/native/security-core.mjs';
import { CommandRouter } from '../command/commandRouter.mjs';
import { 
  ExecutionMessageType, 
  createExecutionEnvelope, 
  validateExecutionEnvelope 
} from './executionProtocol.mjs';
import { operationTracker } from '../state/operationTracker.mjs';
import { wsServer } from '../api-server/websocket/wsServer.mjs';
import { securityFacade } from '../security-authority/facade.mjs';
import { executionBoundaryManager } from './boundary/index.mjs';

/**
 * Orchestrates the spawning, monitoring, typed command delivery, and termination of 
 * automated betting Runtime instances using NativeCore for OS security.
 */
export class RuntimeManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Set<number>} */
    this.activeRuntimes = new Set();
    /** @type {Set<number>} */
    this.activeConnections = new Set();
    this.pipeName = process.env.CONTROL_PLANE_PIPE || `\\\\.\\pipe\\control_plane_secure_ipc_${process.pid}`;
    this.serverStarted = false;
    this.router = new CommandRouter();
    this.engineStatus = 'OFFLINE';
    this.activeBrowserCount = 0;
  }

  stopServer() {
    if (!this.serverStarted) {
      this.activeConnections.clear();
      return;
    }
    try {
      NativeCore.stopSecurePipeServer();
    } catch {}
    this.serverStarted = false;
    this.activeConnections.clear();
  }

  ensureServerStarted() {
    if (this.serverStarted) return;
    if (executionBoundaryManager.transport?.isListening || executionBoundaryManager.isConnected()) {
      return;
    }
    
    NativeCore.startSecurePipeServer(
      this.pipeName,
      (connId) => {
        this.activeConnections.add(connId);
        this.emit('clientConnected', connId);
      },
      (connId, data) => {
        this._handleIncomingData(connId, data);
      },
      (connId) => {
        this.activeConnections.delete(connId);
        this.emit('clientDisconnected', connId);
      }
    );
    this.serverStarted = true;
  }

  /**
   * Internal dispatcher for incoming framed pipe data from execution plane.
   * @param {number} connId 
   * @param {string} data 
   * @private
   */
  _handleIncomingData(connId, data) {
    try {
      const raw = JSON.parse(data);
      const { valid, envelope, error } = validateExecutionEnvelope(raw);
      
      if (!valid) {
        // Fallback for legacy raw payloads if any
        if (raw && raw.type === 'HEARTBEAT' && raw.pid) {
          runtimeHeartbeat.recordHeartbeat(raw.pid);
          return;
        }
        console.warn(`[RuntimeManager] Invalid execution envelope from conn ${connId}: ${error}`);
        return;
      }

      this.emit('envelope', envelope);

      switch (envelope.type) {
        case ExecutionMessageType.HEARTBEAT: {
          const { pid, activeBrowsers, engineStatus } = envelope.payload || {};
          if (pid) runtimeHeartbeat.recordHeartbeat(pid);
          if (typeof activeBrowsers === 'number') this.activeBrowserCount = activeBrowsers;
          if (engineStatus) this.engineStatus = engineStatus;
          break;
        }

        case ExecutionMessageType.STATE_CHANGED: {
          const { state, message } = envelope.payload || {};
          if (state) {
            this.engineStatus = state;
            this.emit('stateChanged', { state, message });
            wsServer.broadcast('automation:delta', {
              type: 'LIFECYCLE_CHANGED',
              lifecycle: state,
              message
            });
          }
          break;
        }

        case ExecutionMessageType.BROWSER_STATUS: {
          this.emit('browserStatus', envelope.payload);
          const payload = envelope.payload || {};
          const accountId = payload.accountId || payload.id;
          if (accountId) {
            wsServer.broadcast('automation:delta', {
              type: 'ACCOUNT_UPDATED',
              accountId,
              partialSnapshot: {
                browserStatus: payload.browserStatus || 'STOPPED',
                accountStatus: payload.accountStatus || 'IDLE',
                observedState: payload.observedState || (payload.browserStatus === 'ACTIVE' ? 'RUNNING' : 'STOPPED'),
                executionStatusReason: payload.executionStatusReason || null
              }
            });
            wsServer.broadcast('accounts:delta', {
              type: 'ACCOUNT_UPDATED',
              accountId,
              partialSnapshot: {
                backendState: payload.browserStatus === 'ACTIVE' ? 'ACTIVE' : 'IDLE',
                statusDescription: payload.browserStatus
              }
            });
          }
          break;
        }

        case ExecutionMessageType.OPERATION_ACK: {
          const { operationId } = envelope.payload || {};
          if (operationId) {
            operationTracker.updateStatus(operationId, 'IN_FLIGHT');
          }
          break;
        }

        case ExecutionMessageType.OPERATION_RESULT: {
          const { operationId, status, metrics, error } = envelope.payload || {};
          if (operationId) {
            if (status === 'SUCCESS') {
              operationTracker.completeOperation(operationId, metrics);
            } else {
              operationTracker.failOperation(operationId, error || 'Operation failed');
            }
            wsServer.broadcast('automation:delta', {
              type: 'OPERATION_COMPLETED',
              operationId,
              status,
              metrics,
              error
            });
          }
          break;
        }

        case ExecutionMessageType.ODDS_TICK: {
          this.emit('oddsTick', envelope.payload);
          break;
        }

        case ExecutionMessageType.AUDIT_EVENT: {
          this.emit('auditEvent', envelope.payload);
          break;
        }

        default:
          Promise.resolve(this.router.route(envelope.payload)).catch((err) => {
            console.error(`[RuntimeManager] Command routing rejected from conn ${connId}: ${err.message}`);
          });
          break;
      }
    } catch (e) {
      console.error(`[RuntimeManager] Failed to route framed IPC payload: ${e.message}`);
    }
  }

  /**
   * Sends a typed ExecutionEnvelope to connected worker(s) across the named pipe.
   * @param {string} type 
   * @param {any} payload 
   * @param {string} [traceId] 
   * @returns {boolean} True if written to at least one connection
   */
  sendEnvelope(type, payload, traceId) {
    this.ensureServerStarted();
    const envelope = createExecutionEnvelope(type, payload, traceId, 'CONTROL_PLANE');
    const jsonString = JSON.stringify(envelope);
    let anyWritten = false;

    for (const connId of this.activeConnections) {
      const ok = NativeCore.writePipe(connId, jsonString);
      if (ok) anyWritten = true;
    }

    return anyWritten;
  }

  // --- High-Level Typed API for Control Plane Command Routing ---

  initializeWorker(initPayload, traceId) {
    return this.sendEnvelope(ExecutionMessageType.INITIALIZE, initPayload, traceId);
  }

  startCluster(options = {}, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.START_CLUSTER, options, traceId);
  }

  stopCluster(timeoutMs = 5000, traceId) {
    return this.sendEnvelope(ExecutionMessageType.STOP_CLUSTER, { timeoutMs }, traceId);
  }

  placeBet(betPayload, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.PLACE_BET, betPayload, traceId);
  }

  cashOut(cashOutPayload, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.CASH_OUT, cashOutPayload, traceId);
  }

  validateTactical(validatePayload = {}, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.VALIDATE, validatePayload, traceId);
  }

  activateAccount(accountPayload, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.ACTIVATE_ACCOUNT, accountPayload, traceId);
  }

  deactivateAccount(deactivatePayload, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.DEACTIVATE_ACCOUNT, deactivatePayload, traceId);
  }

  setBetCycle(targetBrowserId, isEnabled, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.SET_BET_CYCLE, { targetBrowserId, isEnabled }, traceId);
  }

  updatePolicy(category, values, traceId) {
    if (securityFacade.isDegraded()) {
      throw new Error("Execution Denied: Control Plane is in DEGRADED mode (Backend Offline)");
    }
    return this.sendEnvelope(ExecutionMessageType.UPDATE_POLICY, { category, values }, traceId);
  }

  /**
   * Quarantines the Execution Plane: halts active clusters, terminates worker processes,
   * fails in-flight operations, and transitions status to DEGRADED_HALTED.
   * @param {string} [reason]
   */
  quarantineExecution(reason = 'BACKEND_OFFLINE_DEGRADED') {
    this.engineStatus = 'DEGRADED_HALTED';
    this.activeBrowserCount = 0;

    // 1. Dispatch emergency stop over pipe if connected
    if (this.activeConnections.size > 0) {
      this.sendEnvelope(ExecutionMessageType.STOP_CLUSTER, { timeoutMs: 1000, reason });
    }

    // 2. Terminate all active runtime processes
    for (const pid of this.activeRuntimes) {
      try {
        NativeCore.terminateExecutionProcess(pid);
      } catch (err) {
        // Process may already have exited
      }
    }
    this.activeRuntimes.clear();

    // 3. Preserve financial safety: transition in-flight operations to UNCERTAIN, and fail queued operations
    const uncertainOps = operationTracker.quarantineAllPending(`Execution Quarantined: ${reason}`);
    this.emit('uncertainOperations', uncertainOps);

    // 4. Notify frontend console of hard halt
    wsServer.broadcast('automation:delta', {
      type: 'LIFECYCLE_CHANGED',
      lifecycle: 'DEGRADED_HALTED',
      degraded: true,
      reason
    });
    this.emit('executionQuarantined', { reason, uncertainOps });
  }

  /**
   * Attempts to spawn a new runtime instance, gated by Security Authority.
   * Enforces handshake timeout: if child does not connect within handshakeTimeoutMs, process is killed.
   * @param {string} [scriptPath]
   * @param {string} [expectedSha256]
   * @param {object} [options]
   * @param {number} [options.handshakeTimeoutMs=10000]
   */
  spawnRuntime(scriptPath, expectedSha256, options = {}) {
    if (securityFacade.isDegraded() || !executionAuthorization.canStartAutomation()) {
      throw new Error("Security Authority denied automation start: System is in DEGRADED mode (Backend Offline)");
    }

    this.ensureServerStarted();

    let targetScript = scriptPath || process.env.RUNTIME_ENTRY_SCRIPT;
    if (!targetScript) {
      const realWorkerCandidate = path.resolve(__dirname, '../../../bettingAutomation/src/worker/index.mjs');
      const isTest = process.env.NODE_ENV === 'test' ||
                     process.env.npm_lifecycle_event?.includes('test') ||
                     process.env.ACP_USE_MOCK_WORKER === 'true';
      const preferMock = isTest || options.useMockWorker === true;
      if (!preferMock && fs.existsSync(realWorkerCandidate)) {
        targetScript = realWorkerCandidate;
      } else if (options.useDevWorkerFallback !== false) {
        const isDev = process.env.NODE_ENV !== 'production' || process.env.ACP_DEV_MODE === 'true' || isTest;
        if (isDev) {
          targetScript = path.resolve(__dirname, '../../test/fixtures/mock-orchestrated-worker.mjs');
        }
      }
    }

    const handshakeTimeoutMs = options.handshakeTimeoutMs || 10_000;
    let handshakeTimer = null;

    if (targetScript && !process.env.APP_ROOT) {
      const normalizedScript = path.resolve(targetScript);
      const srcIndex = normalizedScript.lastIndexOf(path.sep + 'src' + path.sep);
      const buildIndex = normalizedScript.lastIndexOf(path.sep + 'build' + path.sep);
      if (srcIndex !== -1) {
        process.env.APP_ROOT = normalizedScript.slice(0, srcIndex);
      } else if (buildIndex !== -1) {
        process.env.APP_ROOT = normalizedScript.slice(0, buildIndex);
      }
    }

    const pid = NativeCore.spawnExecutionProcess(this.pipeName, (exitedPid) => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      this.activeRuntimes.delete(exitedPid);
      runtimeHeartbeat.remove(exitedPid);
      if (this.engineStatus !== 'ABORTED') {
        this.engineStatus = 'STOPPED';
      }
      this.emit('runtimeExited', exitedPid);
      executionBoundaryManager.abortConnection(new Error(`Execution Plane process (PID ${exitedPid}) exited prematurely before connection`));
    }, targetScript, expectedSha256);
    
    this.activeRuntimes.add(pid);
    runtimeHeartbeat.recordHeartbeat(pid);
    this.engineStatus = 'STARTING';

    // Start handshake watchdog timer for this child process
    if (handshakeTimeoutMs > 0) {
      handshakeTimer = setTimeout(() => {
        if (this.activeConnections.size === 0 && this.activeRuntimes.has(pid)) {
          console.warn(`[RuntimeManager] Handshake timeout (${handshakeTimeoutMs}ms) exceeded for PID ${pid}. Aborting process.`);
          this.terminateRuntime(pid);
          this.engineStatus = 'ABORTED';
          this.emit('handshakeTimeout', { pid, handshakeTimeoutMs });
          executionBoundaryManager.abortConnection(new Error(`Handshake timeout (${handshakeTimeoutMs}ms) exceeded for PID ${pid}`));
        }
      }, handshakeTimeoutMs);

      if (handshakeTimer.unref) {
        handshakeTimer.unref();
      }

      // Clear timer on first successful client connection
      const onConnected = (connId) => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        if (typeof connId === 'number') {
          this.activeConnections.add(connId);
        }
        this.off('clientConnected', onConnected);
        executionBoundaryManager.off('clientConnected', onConnected);
      };
      this.once('clientConnected', onConnected);
      executionBoundaryManager.once('clientConnected', onConnected);

      if (this.activeConnections.size > 0 || executionBoundaryManager.isConnected()) {
        onConnected();
      }
    }
    
    return pid;
  }

  /**
   * Terminates a specific runtime instance via NativeCore.
   * @param {number} pid 
   */
  terminateRuntime(pid) {
    if (this.activeRuntimes.has(pid)) {
      NativeCore.terminateExecutionProcess(pid);
      this.activeRuntimes.delete(pid);
      runtimeHeartbeat.remove(pid);
    }
  }

  /**
   * Terminates all instances.
   */
  terminateAll() {
    for (const pid of this.activeRuntimes) {
      this.terminateRuntime(pid);
    }
    runtimeHeartbeat.clear();
    this.engineStatus = 'OFFLINE';
    this.stopServer();
  }

  getActiveBrowserCount() {
    return this.activeBrowserCount;
  }

  getEngineStatus() {
    return this.engineStatus;
  }
}

export const runtimeManager = new RuntimeManager();

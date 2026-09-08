// @ts-check
import EventEmitter from 'node:events';
import { executionAuthorization } from './execution-authorization.mjs';
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
    this.pipeName = '\\\\.\\pipe\\control_plane_secure_ipc';
    this.serverStarted = false;
    this.router = new CommandRouter();
    this.engineStatus = 'OFFLINE';
    this.activeBrowserCount = 0;
  }

  ensureServerStarted() {
    if (this.serverStarted) return;
    
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
          wsServer.broadcast('accounts:delta', {
            type: 'ACCOUNT_UPDATED',
            account: envelope.payload
          });
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
          this.router.route(envelope.payload);
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
    return this.sendEnvelope(ExecutionMessageType.START_CLUSTER, options, traceId);
  }

  stopCluster(timeoutMs = 5000, traceId) {
    return this.sendEnvelope(ExecutionMessageType.STOP_CLUSTER, { timeoutMs }, traceId);
  }

  placeBet(betPayload, traceId) {
    return this.sendEnvelope(ExecutionMessageType.PLACE_BET, betPayload, traceId);
  }

  cashOut(cashOutPayload, traceId) {
    return this.sendEnvelope(ExecutionMessageType.CASH_OUT, cashOutPayload, traceId);
  }

  validateTactical(validatePayload = {}, traceId) {
    return this.sendEnvelope(ExecutionMessageType.VALIDATE, validatePayload, traceId);
  }

  activateAccount(accountPayload, traceId) {
    return this.sendEnvelope(ExecutionMessageType.ACTIVATE_ACCOUNT, accountPayload, traceId);
  }

  deactivateAccount(deactivatePayload, traceId) {
    return this.sendEnvelope(ExecutionMessageType.DEACTIVATE_ACCOUNT, deactivatePayload, traceId);
  }

  setBetCycle(targetBrowserId, isEnabled, traceId) {
    return this.sendEnvelope(ExecutionMessageType.SET_BET_CYCLE, { targetBrowserId, isEnabled }, traceId);
  }

  updatePolicy(category, values, traceId) {
    return this.sendEnvelope(ExecutionMessageType.UPDATE_POLICY, { category, values }, traceId);
  }

  /**
   * Attempts to spawn a new runtime instance, gated by Security Authority.
   * @param {string} [scriptPath]
   * @param {string} [expectedSha256]
   */
  spawnRuntime(scriptPath, expectedSha256) {
    if (!executionAuthorization.canStartAutomation()) {
      throw new Error("Security Authority denied automation start");
    }

    this.ensureServerStarted();

    const pid = NativeCore.spawnExecutionProcess(this.pipeName, (exitedPid) => {
      this.activeRuntimes.delete(exitedPid);
      this.engineStatus = 'STOPPED';
      this.emit('runtimeExited', exitedPid);
    }, scriptPath, expectedSha256);
    
    this.activeRuntimes.add(pid);
    runtimeHeartbeat.recordHeartbeat(pid);
    this.engineStatus = 'STARTING';
    
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
    }
  }

  /**
   * Terminates all instances.
   */
  terminateAll() {
    for (const pid of this.activeRuntimes) {
      this.terminateRuntime(pid);
    }
    this.engineStatus = 'OFFLINE';
  }

  getActiveBrowserCount() {
    return this.activeBrowserCount;
  }

  getEngineStatus() {
    return this.engineStatus;
  }
}

export const runtimeManager = new RuntimeManager();

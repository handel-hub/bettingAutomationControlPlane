// @ts-check
import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';

/**
 * Tracks async tactical operations (PLACE_BET, CASH_OUT, VALIDATE).
 * Enforces pessimistic UX: sets globalActionPending and emits deltas.
 */
export class OperationTracker extends EventEmitter {
  constructor() {
    super();
    /** @type {'STARTING' | 'STOPPING' | 'PLACING_BET' | 'CASHING_OUT' | 'VALIDATING' | null} */
    this.currentPendingAction = null;
    /** @type {Map<string, any>} */
    this.operations = new Map();
  }

  getCurrentPendingAction() {
    return this.currentPendingAction;
  }

  /**
   * Enqueues a tactical operation.
   * @param {'STARTING' | 'STOPPING' | 'PLACING_BET' | 'CASHING_OUT' | 'VALIDATING'} actionType
   * @param {object} [metadata]
   * @returns {{ operationId: string, status: 'QUEUED' }}
   */
  startOperation(actionType, metadata = {}) {
    const operationId = typeof ulid === 'function' ? `op_${ulid()}` : `op_${Date.now()}`;
    this.currentPendingAction = actionType;

    const op = {
      operationId,
      actionType,
      status: 'QUEUED',
      startTime: Date.now(),
      metadata
    };

    this.operations.set(operationId, op);
    this.emit('operation:started', op);
    return { operationId, status: 'QUEUED' };
  }

  /**
   * Completes an operation.
   * @param {string} operationId
   * @param {any} result
   */
  completeOperation(operationId, result = {}) {
    const op = this.operations.get(operationId);
    if (op) {
      op.status = 'COMPLETED';
      op.result = result;
      op.completedTime = Date.now();
    }
    this.currentPendingAction = null;
    this.emit('operation:completed', { operationId, op, result });
  }

  /**
   * Updates an operation's status (e.g. IN_FLIGHT).
   * @param {string} operationId
   * @param {string} status
   */
  updateStatus(operationId, status) {
    const op = this.operations.get(operationId);
    if (op) {
      op.status = status;
      this.emit('operation:updated', op);
    }
  }

  /**
   * Retrieves an operation by ID.
   * @param {string} operationId
   */
  getOperation(operationId) {
    return this.operations.get(operationId);
  }

  /**
   * Fails an operation.
   * @param {string} operationId
   * @param {string} errorReason
   */
  failOperation(operationId, errorReason) {
    const op = this.operations.get(operationId);
    if (op) {
      op.status = 'FAILED';
      op.errorReason = errorReason;
      op.completedTime = Date.now();
    }
    this.currentPendingAction = null;
    this.emit('operation:failed', { operationId, op, errorReason });
  }
}

export const operationTracker = new OperationTracker();

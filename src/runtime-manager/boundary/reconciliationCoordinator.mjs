// @ts-check
import EventEmitter from 'node:events';

/**
 * Coordinates out-of-band resolution for operations with UNKNOWN outcome.
 * Freezes target accounts to enforce the single-flight lease invariant,
 * preventing double-betting while transactions are unresolved.
 */
export class ReconciliationCoordinator extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, { accountId: string, operationId: string, idempotencyKey: string, frozenAt: number, reason: string }>} */
    this.frozenAccounts = new Map();
    /** @type {Map<string, { operationId: string, accountId: string, idempotencyKey: string, status: string, enqueuedAt: number, attempts: number, details: any }>} */
    this.pendingReconciliations = new Map();
  }

  /**
   * Freezes an account to prevent new operational leases.
   * @param {string} accountId
   * @param {string} operationId
   * @param {string} [idempotencyKey='']
   * @param {string} [reason='UNKNOWN_TRANSACTION_OUTCOME']
   */
  freezeAccount(accountId, operationId, idempotencyKey = '', reason = 'UNKNOWN_TRANSACTION_OUTCOME') {
    if (!accountId) return;

    const record = {
      accountId,
      operationId,
      idempotencyKey,
      frozenAt: Date.now(),
      reason
    };

    this.frozenAccounts.set(accountId, record);
    this.emit('accountFrozen', record);
    return record;
  }

  /**
   * Unfreezes an account after reconciliation.
   * @param {string} accountId
   */
  unfreezeAccount(accountId) {
    if (!accountId || !this.frozenAccounts.has(accountId)) return false;

    const record = this.frozenAccounts.get(accountId);
    this.frozenAccounts.delete(accountId);
    this.emit('accountUnfrozen', record);
    return true;
  }

  /**
   * Returns true if the account is currently frozen.
   * @param {string} accountId
   */
  isAccountFrozen(accountId) {
    return this.frozenAccounts.has(accountId);
  }

  /**
   * Returns all currently frozen accounts.
   */
  getFrozenAccounts() {
    return Array.from(this.frozenAccounts.values());
  }

  /**
   * Enqueues an operation that reached an UNKNOWN outcome.
   * @param {object} params
   * @param {string} params.operationId
   * @param {string} params.accountId
   * @param {string} [params.idempotencyKey]
   * @param {string} [params.reason]
   * @param {any} [params.details]
   */
  enqueueUncertainOperation({ operationId, accountId, idempotencyKey = '', reason = 'TRANSACTION_UNCERTAIN', details = {} }) {
    this.freezeAccount(accountId, operationId, idempotencyKey, reason);

    const task = {
      operationId,
      accountId,
      idempotencyKey,
      status: 'QUEUED',
      enqueuedAt: Date.now(),
      attempts: 0,
      details
    };

    this.pendingReconciliations.set(operationId, task);
    this.emit('uncertainEnqueued', task);
    return task;
  }

  /**
   * Generates the payload for a TACTICAL:RECONCILE_ORDER envelope.
   * @param {string} operationId
   * @returns {object | null}
   */
  createReconcileRequest(operationId) {
    const task = this.pendingReconciliations.get(operationId);
    if (!task) return null;

    task.status = 'IN_PROGRESS';
    task.attempts++;

    return {
      operationId: task.operationId,
      accountId: task.accountId,
      idempotencyKey: task.idempotencyKey,
      attempts: task.attempts,
      details: task.details
    };
  }

  /**
   * Processes a TACTICAL:RECONCILIATION_REPORT from the Execution Plane.
   * @param {object} report
   * @param {string} report.operationId
   * @param {'RESOLVED_COMMITTED' | 'RESOLVED_LOST' | 'STILL_PENDING'} report.resolutionStatus
   * @param {any} [report.platformOrder]
   */
  handleReconciliationReport(report) {
    const { operationId, resolutionStatus, platformOrder } = report || {};
    const task = this.pendingReconciliations.get(operationId);

    if (!task) {
      return { handled: false, error: `No pending reconciliation found for operationId: ${operationId}` };
    }

    if (resolutionStatus === 'RESOLVED_COMMITTED') {
      task.status = 'COMPLETED';
      this.unfreezeAccount(task.accountId);
      this.pendingReconciliations.delete(operationId);

      const result = { operationId, outcome: 'COMPLETED', platformOrder, task };
      this.emit('reconciliationResolved', result);
      return { handled: true, outcome: 'COMPLETED', result };
    }

    if (resolutionStatus === 'RESOLVED_LOST') {
      task.status = 'FAILED';
      this.unfreezeAccount(task.accountId);
      this.pendingReconciliations.delete(operationId);

      const result = { operationId, outcome: 'FAILED', platformOrder, task };
      this.emit('reconciliationResolved', result);
      return { handled: true, outcome: 'FAILED', result };
    }

    // Still pending, increment attempts and retain freeze
    task.status = 'PENDING_RETRY';
    return { handled: true, outcome: 'PENDING_RETRY', task };
  }

  /**
   * Manual administrative override to resolve a stuck operation and unfreeze account.
   * @param {string} operationId
   * @param {'COMPLETED' | 'FAILED'} forcedOutcome
   * @param {string} [operatorNote='']
   */
  manualResolve(operationId, forcedOutcome, operatorNote = '') {
    const task = this.pendingReconciliations.get(operationId);
    const accountId = task ? task.accountId : null;

    if (accountId) {
      this.unfreezeAccount(accountId);
    }
    this.pendingReconciliations.delete(operationId);

    const result = {
      operationId,
      outcome: forcedOutcome,
      manual: true,
      operatorNote,
      resolvedAt: Date.now()
    };

    this.emit('reconciliationResolved', result);
    return result;
  }

  /**
   * Returns list of pending reconciliations.
   */
  getPendingReconciliations() {
    return Array.from(this.pendingReconciliations.values());
  }
}

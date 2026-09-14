// @ts-check
import EventEmitter from 'node:events';

/**
 * Coordinates out-of-band resolution for operations with UNKNOWN outcome.
 * Freezes target accounts to enforce the single-flight lease invariant,
 * preventing double-betting while transactions are unresolved.
 */
export class ReconciliationCoordinator extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {any} [options.engine=null] - Optional SQLite storage engine for crash survival
   */
  constructor(options = {}) {
    super();
    this.engine = options.engine || null;
    /** @type {Map<string, { accountId: string, operationId: string, idempotencyKey: string, frozenAt: number, reason: string }>} */
    this.frozenAccounts = new Map();
    /** @type {Map<string, { operationId: string, accountId: string, idempotencyKey: string, status: string, enqueuedAt: number, attempts: number, details: any }>} */
    this.pendingReconciliations = new Map();

    if (this.engine) {
      this._initPersistence();
      this._hydrateFromPersistence();
    }
  }

  /**
   * Initializes persistence schema.
   * @private
   */
  _initPersistence() {
    try {
      this.engine.exec(`
        CREATE TABLE IF NOT EXISTS reconciliation_queue (
          operation_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          idempotency_key TEXT,
          status TEXT NOT NULL,
          reason TEXT,
          details_json TEXT,
          enqueued_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          resolved_at INTEGER,
          outcome TEXT
        );
        CREATE TABLE IF NOT EXISTS frozen_accounts (
          account_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          idempotency_key TEXT,
          frozen_at INTEGER NOT NULL,
          reason TEXT
        );
      `);
    } catch { /* ignore */ }
  }

  /**
   * Hydrates frozen accounts and pending uncertain tasks from persistence.
   * @private
   */
  _hydrateFromPersistence() {
    try {
      const frozenRows = this.engine.query(`SELECT account_id, operation_id, idempotency_key, frozen_at, reason FROM frozen_accounts`);
      for (const row of frozenRows) {
        this.frozenAccounts.set(row.account_id, {
          accountId: row.account_id,
          operationId: row.operation_id,
          idempotencyKey: row.idempotency_key,
          frozenAt: row.frozen_at,
          reason: row.reason
        });
      }

      const recRows = this.engine.query(`
        SELECT operation_id, account_id, idempotency_key, status, reason, details_json, enqueued_at, attempts
        FROM reconciliation_queue
        WHERE status NOT IN ('COMPLETED', 'FAILED')
      `);
      for (const row of recRows) {
        this.pendingReconciliations.set(row.operation_id, {
          operationId: row.operation_id,
          accountId: row.account_id,
          idempotencyKey: row.idempotency_key,
          status: row.status,
          enqueuedAt: row.enqueued_at,
          attempts: row.attempts,
          details: row.details_json ? JSON.parse(row.details_json) : {}
        });
      }
    } catch { /* ignore */ }
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

    if (this.engine) {
      try {
        this.engine.run(`
          INSERT OR REPLACE INTO frozen_accounts (account_id, operation_id, idempotency_key, frozen_at, reason)
          VALUES (?, ?, ?, ?, ?)
        `, [accountId, operationId, idempotencyKey, record.frozenAt, reason]);
      } catch { /* ignore */ }
    }

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

    if (this.engine) {
      try {
        this.engine.run(`DELETE FROM frozen_accounts WHERE account_id = ?`, [accountId]);
      } catch { /* ignore */ }
    }

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

    if (this.engine) {
      try {
        this.engine.run(`
          INSERT OR REPLACE INTO reconciliation_queue
          (operation_id, account_id, idempotency_key, status, reason, details_json, enqueued_at, attempts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          operationId,
          accountId,
          idempotencyKey,
          'QUEUED',
          reason,
          JSON.stringify(details || {}),
          task.enqueuedAt,
          0
        ]);
      } catch { /* ignore */ }
    }

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

    if (this.engine) {
      try {
        this.engine.run(`
          UPDATE reconciliation_queue
          SET status = ?, attempts = ?
          WHERE operation_id = ?
        `, ['IN_PROGRESS', task.attempts, operationId]);
      } catch { /* ignore */ }
    }

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

      if (this.engine) {
        try {
          this.engine.run(`
            UPDATE reconciliation_queue
            SET status = ?, outcome = ?, resolved_at = ?
            WHERE operation_id = ?
          `, ['COMPLETED', 'COMPLETED', Date.now(), operationId]);
        } catch { /* ignore */ }
      }

      const result = { operationId, outcome: 'COMPLETED', platformOrder, task };
      this.emit('reconciliationResolved', result);
      return { handled: true, outcome: 'COMPLETED', result };
    }

    if (resolutionStatus === 'RESOLVED_LOST') {
      task.status = 'FAILED';
      this.unfreezeAccount(task.accountId);
      this.pendingReconciliations.delete(operationId);

      if (this.engine) {
        try {
          this.engine.run(`
            UPDATE reconciliation_queue
            SET status = ?, outcome = ?, resolved_at = ?
            WHERE operation_id = ?
          `, ['FAILED', 'FAILED', Date.now(), operationId]);
        } catch { /* ignore */ }
      }

      const result = { operationId, outcome: 'FAILED', platformOrder, task };
      this.emit('reconciliationResolved', result);
      return { handled: true, outcome: 'FAILED', result };
    }

    // Still pending, increment attempts and retain freeze
    task.status = 'PENDING_RETRY';

    if (this.engine) {
      try {
        this.engine.run(`
          UPDATE reconciliation_queue
          SET status = ?, attempts = ?
          WHERE operation_id = ?
        `, ['PENDING_RETRY', task.attempts, operationId]);
      } catch { /* ignore */ }
    }

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

    if (this.engine) {
      try {
        this.engine.run(`
          UPDATE reconciliation_queue
          SET status = ?, outcome = ?, resolved_at = ?
          WHERE operation_id = ?
        `, [forcedOutcome, forcedOutcome, result.resolvedAt, operationId]);
      } catch { /* ignore */ }
    }

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

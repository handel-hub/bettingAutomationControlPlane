// @ts-check

/**
 * 24-Hour Financial Idempotency LRU Ledger.
 * Prevents duplicate execution of tactical operations (placeBet, cashOut)
 * during retries, network glitches, or reconnection.
 */
export class IdempotencyLedger {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAgeMs=86400000] - 24 hours default TTL
   * @param {number} [options.maxEntries=10000] - Maximum ledger capacity
   * @param {any} [options.engine=null] - Optional SQLite storage engine for durable crash resilience
   */
  constructor({ maxAgeMs = 86_400_000, maxEntries = 10_000, engine = null } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.maxEntries = maxEntries;
    this.engine = engine;
    /** @type {Map<string, { idempotencyKey: string, operationId: string, status: 'IN_FLIGHT' | 'COMPLETED' | 'FAILED', createdAt: number, updatedAt: number, cachedResult: any, metadata: any }>} */
    this.records = new Map();

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
        CREATE TABLE IF NOT EXISTS idempotency_ledger (
          idempotency_key TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          cached_result_json TEXT,
          metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_idempotency_updated ON idempotency_ledger(updated_at);
      `);
    } catch { /* ignore */ }
  }

  /**
   * Hydrates unexpired records from SQLite storage engine.
   * @private
   */
  _hydrateFromPersistence() {
    try {
      const now = Date.now();
      const minUpdated = now - this.maxAgeMs;
      const rows = this.engine.query(`
        SELECT idempotency_key, operation_id, status, created_at, updated_at, cached_result_json, metadata_json
        FROM idempotency_ledger
        WHERE updated_at >= ?
        ORDER BY updated_at ASC
      `, [minUpdated]);

      for (const row of rows) {
        this.records.set(row.idempotency_key, {
          idempotencyKey: row.idempotency_key,
          operationId: row.operation_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          cachedResult: row.cached_result_json ? JSON.parse(row.cached_result_json) : null,
          metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {}
        });
      }
    } catch { /* ignore */ }
  }

  /**
   * Checks whether an idempotencyKey has already been processed or is currently in-flight.
   * @param {string} idempotencyKey
   * @returns {{ exists: boolean, status: 'NEW' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED', operationId?: string, cachedResult?: any, record?: any }}
   */
  check(idempotencyKey) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return { exists: false, status: 'NEW' };
    }

    const record = this.records.get(idempotencyKey);
    if (!record) {
      return { exists: false, status: 'NEW' };
    }

    const now = Date.now();
    if (now - record.updatedAt > this.maxAgeMs) {
      this.records.delete(idempotencyKey);
      return { exists: false, status: 'NEW' };
    }

    // Refresh LRU position
    this.records.delete(idempotencyKey);
    this.records.set(idempotencyKey, record);

    return {
      exists: true,
      status: record.status,
      operationId: record.operationId,
      cachedResult: record.cachedResult,
      record
    };
  }

  /**
   * Marks an operation as IN_FLIGHT.
   * @param {string} idempotencyKey
   * @param {string} operationId
   * @param {any} [metadata={}]
   */
  recordInFlight(idempotencyKey, operationId, metadata = {}) {
    this.pruneExpired();

    // Enforce max capacity
    if (this.records.size >= this.maxEntries) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) this.records.delete(oldestKey);
    }

    const now = Date.now();
    const record = {
      idempotencyKey,
      operationId,
      status: /** @type {'IN_FLIGHT'} */ ('IN_FLIGHT'),
      createdAt: now,
      updatedAt: now,
      cachedResult: null,
      metadata
    };

    this.records.set(idempotencyKey, record);

    if (this.engine) {
      try {
        this.engine.run(`
          INSERT OR REPLACE INTO idempotency_ledger
          (idempotency_key, operation_id, status, created_at, updated_at, cached_result_json, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          idempotencyKey,
          operationId,
          'IN_FLIGHT',
          now,
          now,
          null,
          JSON.stringify(metadata || {})
        ]);
      } catch { /* ignore */ }
    }

    return record;
  }

  /**
   * Records a terminal execution outcome (COMPLETED or FAILED).
   * @param {string} idempotencyKey
   * @param {'COMPLETED' | 'FAILED'} status
   * @param {any} [cachedResult=null]
   */
  recordTerminal(idempotencyKey, status, cachedResult = null) {
    const existing = this.records.get(idempotencyKey);
    const now = Date.now();

    if (existing) {
      existing.status = status;
      existing.cachedResult = cachedResult;
      existing.updatedAt = now;
      // Refresh LRU position
      this.records.delete(idempotencyKey);
      this.records.set(idempotencyKey, existing);

      if (this.engine) {
        try {
          this.engine.run(`
            UPDATE idempotency_ledger
            SET status = ?, cached_result_json = ?, updated_at = ?
            WHERE idempotency_key = ?
          `, [
            status,
            cachedResult ? JSON.stringify(cachedResult) : null,
            now,
            idempotencyKey
          ]);
        } catch { /* ignore */ }
      }

      return existing;
    }

    // If no prior in-flight record existed, record fresh terminal
    const record = {
      idempotencyKey,
      operationId: cachedResult?.operationId || 'unknown',
      status,
      createdAt: now,
      updatedAt: now,
      cachedResult,
      metadata: {}
    };

    this.records.set(idempotencyKey, record);

    if (this.engine) {
      try {
        this.engine.run(`
          INSERT OR REPLACE INTO idempotency_ledger
          (idempotency_key, operation_id, status, created_at, updated_at, cached_result_json, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          idempotencyKey,
          record.operationId,
          status,
          now,
          now,
          cachedResult ? JSON.stringify(cachedResult) : null,
          '{}'
        ]);
      } catch { /* ignore */ }
    }

    return record;
  }

  /**
   * Prunes entries older than maxAgeMs.
   * @returns {number} Count of removed entries
   */
  pruneExpired() {
    const now = Date.now();
    let pruned = 0;
    for (const [key, record] of this.records.entries()) {
      if (now - record.updatedAt > this.maxAgeMs) {
        this.records.delete(key);
        pruned++;
      }
    }

    if (this.engine && pruned > 0) {
      try {
        const threshold = now - this.maxAgeMs;
        this.engine.run(`DELETE FROM idempotency_ledger WHERE updated_at < ?`, [threshold]);
      } catch { /* ignore */ }
    }

    return pruned;
  }

  /**
   * Clears the entire ledger.
   */
  clear() {
    this.records.clear();
    if (this.engine) {
      try {
        this.engine.run(`DELETE FROM idempotency_ledger`);
      } catch { /* ignore */ }
    }
  }

  /**
   * Returns current count of stored keys.
   * @returns {number}
   */
  size() {
    return this.records.size;
  }
}

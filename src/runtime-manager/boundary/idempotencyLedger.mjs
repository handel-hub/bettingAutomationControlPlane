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
   */
  constructor({ maxAgeMs = 86_400_000, maxEntries = 10_000 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, { idempotencyKey: string, operationId: string, status: 'IN_FLIGHT' | 'COMPLETED' | 'FAILED', createdAt: number, updatedAt: number, cachedResult: any, metadata: any }>} */
    this.records = new Map();
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
    return pruned;
  }

  /**
   * Clears the entire ledger.
   */
  clear() {
    this.records.clear();
  }

  /**
   * Returns current count of stored keys.
   * @returns {number}
   */
  size() {
    return this.records.size;
  }
}

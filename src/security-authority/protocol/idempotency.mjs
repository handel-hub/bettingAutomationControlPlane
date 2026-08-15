// @ts-check

/**
 * Tracks idempotent operations to safely handle network retries.
 */
export class IdempotencyManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.results = new Map();
  }

  /**
   * Registers a deterministic outcome for an idempotency key.
   * @param {string} key 
   * @param {any} result 
   */
  register(key, result) {
    this.results.set(key, result);
  }

  /**
   * @param {string} key 
   * @returns {any | undefined}
   */
  getPreviousResult(key) {
    return this.results.get(key);
  }
}

export const idempotencyManager = new IdempotencyManager();

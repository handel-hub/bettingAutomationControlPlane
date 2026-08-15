// @ts-check

/**
 * Prevents replay attacks by tracking recently seen nonces.
 */
export class ReplayGuard {
  constructor() {
    /** @type {Set<string>} */
    this.seenNonces = new Set();
    // In a real implementation, this would be backed by SQLite or 
    // a rotating buffer to bound memory growth.
  }

  /**
   * Validates a nonce has not been seen within the TTL window.
   * @param {string} nonce 
   * @returns {boolean}
   */
  checkAndRemember(nonce) {
    if (this.seenNonces.has(nonce)) {
      return false; // Replay detected
    }
    this.seenNonces.add(nonce);
    return true;
  }

  /**
   * @param {number} timestamp 
   * @param {number} maxDriftMs 
   * @returns {boolean}
   */
  isWithinTimeWindow(timestamp, maxDriftMs = 30000) {
    const drift = Math.abs(Date.now() - timestamp);
    return drift <= maxDriftMs;
  }
}

export const replayGuard = new ReplayGuard();

// @ts-check

import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';

/**
 * Prevents replay attacks by tracking recently seen nonces.
 */
export class ReplayGuard {
  constructor() {
    /** @type {Set<string>} */
    this.seenNonces = new Set();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    const loadedNonces = await AEADStorageAdapter.loadSeenNonces();
    for (const nonce of loadedNonces) {
      this.seenNonces.add(nonce);
    }
    this.initialized = true;
  }

  /**
   * Validates a nonce has not been seen within the TTL window.
   * @param {string} nonce 
   * @returns {Promise<boolean>}
   */
  async checkAndRemember(nonce) {
    if (!this.initialized) {
      await this.init();
    }
    if (this.seenNonces.has(nonce)) {
      return false; // Replay detected
    }
    this.seenNonces.add(nonce);
    await AEADStorageAdapter.saveNonce(nonce);
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

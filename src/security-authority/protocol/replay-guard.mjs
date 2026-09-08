// @ts-check

import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';

/**
 * Prevents replay attacks by tracking recently seen nonces.
 * Backed by SQLite bounded TTL cache to prevent memory leaks and restart vulnerabilities.
 */
export class ReplayGuard {
  constructor() {
    this.initialized = false;
    this.evictionInterval = null;
  }

  async init() {
    if (this.initialized) return;
    
    /** @type {Set<string>} */
    this.seenNonces = new Set();
    const loadedNonces = await AEADStorageAdapter.loadSeenNonces();
    for (const nonce of loadedNonces) {
      this.seenNonces.add(nonce);
    }
    
    // Background task to evict nonces older than 30s
    this.evictionInterval = setInterval(async () => {
       await this.evict();
    }, 30000); // Run every 30 seconds
    if (this.evictionInterval && typeof this.evictionInterval.unref === 'function') {
      this.evictionInterval.unref();
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
    
    // Save to SQLite for crash resilience
    await AEADStorageAdapter.saveNonce(nonce, Date.now());
    return true;
  }

  /**
   * Enforces strict Â±30,000ms bound on timestamp.
   * @param {number|bigint} timestamp 
   * @param {number} maxDriftMs 
   * @returns {boolean}
   */
  isWithinTimeWindow(timestamp, maxDriftMs = 30000) {
    const ts = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
    const drift = Math.abs(Date.now() - ts);
    return drift <= maxDriftMs;
  }
  
  async evict() {
      const cutoff = Date.now() - 30000;
      await AEADStorageAdapter.evictOldNonces(cutoff);
      
      // Sync memory cache with DB
      this.seenNonces.clear();
      const loadedNonces = await AEADStorageAdapter.loadSeenNonces();
      for (const nonce of loadedNonces) {
        this.seenNonces.add(nonce);
      }
  }

  shutdown() {
      if (this.evictionInterval) {
          clearInterval(this.evictionInterval);
      }
  }
}

export const replayGuard = new ReplayGuard();

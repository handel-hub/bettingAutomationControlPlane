// @ts-check

import { CryptoProviderNativeWrapper } from '../crypto/bindings.mjs';

/**
 * Manages one-time cryptographic tokens used to bootstrap secure IPC tunnels
 * between the parent Control Plane and the spawned Runtime instances.
 */
export class SpawnTokenManager {
  constructor() {
    /** @type {Map<string, number>} */
    this.issuedTokens = new Map();
  }

  /**
   * Generates a single-use spawn token for a new runtime instance.
   * @returns {string} Hex encoded token
   */
  issueToken() {
    const token = CryptoProviderNativeWrapper.generateRandomBytes(32).toString('hex');
    this.issuedTokens.set(token, Date.now());
    return token;
  }

  /**
   * Validates and consumes a spawn token exactly once.
   * @param {string} token 
   * @param {number} maxAgeMs 
   * @returns {boolean}
   */
  consumeToken(token, maxAgeMs = 10000) {
    const issuedAt = this.issuedTokens.get(token);
    if (!issuedAt) return false;

    // Zeroize / Consume immediately to prevent reuse
    this.issuedTokens.delete(token);

    const age = Date.now() - issuedAt;
    if (age > maxAgeMs) {
      return false; // Token expired
    }

    return true;
  }
}

export const spawnTokenManager = new SpawnTokenManager();

// @ts-check

import { clock } from './clock.mjs';

/**
 * Tracks accumulated offline time to enforce grace period limits
 * before automatically downgrading the Security State.
 */
export class OfflineGrace {
  constructor() {
    /** @type {number | null} */
    this.lastContactWallclock = null;
    this.accumulatedGraceMs = 0;
  }

  /**
   * Records a successful synchronization with the Central Trust.
   */
  recordServerContact() {
    this.lastContactWallclock = clock.now();
    this.accumulatedGraceMs = 0; // Reset
  }

  /**
   * Evaluates if the current offline duration exceeds the allowed grace period.
   * @param {number} maxGraceMs 
   * @returns {boolean}
   */
  isGraceExhausted(maxGraceMs = 7 * 24 * 60 * 60 * 1000) { // Default 7 days
    if (this.lastContactWallclock === null) return true; // Never contacted
    const offlineMs = clock.now() - this.lastContactWallclock;
    return (this.accumulatedGraceMs + offlineMs) > maxGraceMs;
  }
}

export const offlineGrace = new OfflineGrace();

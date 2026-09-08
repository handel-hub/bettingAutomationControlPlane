// @ts-check

import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';
import { NativeCore } from '../native/security-core.mjs';
import { clock } from './clock.mjs';

/**
 * Validates cryptographic Grace Tokens and enforces absolute offline boundaries.
 * Backed by monotonic highest_observed_time in SQLite to prevent rollback attacks.
 */
export class OfflineGrace {
  constructor() {
    this.monitorInterval = null;
    this.isActive = false;
  }

  /**
   * Starts the monotonic time tracking background monitor.
   * This ticks every 30 seconds to update highest_observed_time in DB.
   */
  startMonitor() {
    if (this.isActive) return;
    this.isActive = true;
    
    // Quick initial check
    this._checkTimeBounds().catch(e => console.error("[OfflineGrace] Init bound check failed:", e));

    this.monitorInterval = setInterval(() => {
       this._checkTimeBounds().catch(e => console.error("[OfflineGrace] Monitor tick failed:", e));
    }, 30000);
    if (this.monitorInterval && typeof this.monitorInterval.unref === 'function') {
      this.monitorInterval.unref();
    }
  }

  stopMonitor() {
    this.isActive = false;
    if (this.monitorInterval) {
       clearInterval(this.monitorInterval);
       this.monitorInterval = null;
    }
  }

  /**
   * Checks current OS time against highest_observed_time to detect tampering,
   * then checks if we have exceeded GraceToken.not_after.
   */
  async _checkTimeBounds() {
    const row = await AEADStorageAdapter.getSecurityStateRow();
    if (!row) return; // Uninitialized
    
    const now = clock.now();
    const highestObserved = row.highest_observed_time || 0;

    // 1. Rollback Detection
    if (now < highestObserved) {
       console.error(`[OfflineGrace] CRITICAL: Clock rollback detected! Now: ${now}, Highest: ${highestObserved}`);
       // Trigger sync block via Rust core to immediately halt Execution Plane
       NativeCore.setRevokedSync(true);
       throw new Error("SECURITY_STATE_UNCERTAIN: System clock was rolled back. Terminating offline grace.");
    }

    // 2. Update Highest Observed Time
    // We update it directly using OCC. If there's an OCC conflict, it just means another transition beat us to it,
    // which is fine since the other transition would have updated highest_observed_time anyway.
    if (now > highestObserved) {
        const nextStateData = { ...row, highest_observed_time: now };
        await AEADStorageAdapter.commitTransitionWithOCC(row.state_version, nextStateData, "TIME_TICK");
    }

    // 3. Absolute Expiry Checking
    if (row.state === "OFFLINE_GRACE" && row.graceTokenData) {
        const token = row.graceTokenData;
        
        if (now > token.not_after) {
             console.error(`[OfflineGrace] Grace period EXHAUSTED. Exceeded absolute not_after bound.`);
             NativeCore.setRevokedSync(true);
             
             // Transition to EXPIRED.
             const expiredState = { ...row, state: "EXPIRED", highest_observed_time: now };
             await AEADStorageAdapter.commitTransitionWithOCC(row.state_version + 1, expiredState, "GRACE_EXHAUSTED");
        }
    }
  }

  /**
   * Used during Engine transitions to validate a new token.
   * @param {Object} token 
   * @param {string} token.machine_id
   * @param {number} token.session_generation
   * @param {number} token.not_after
   * @param {string} currentMachineId
   * @param {number} currentGeneration
   * @returns {boolean}
   */
  isValidGraceToken(token, currentMachineId, currentGeneration) {
    if (!token) return false;
    if (token.machine_id !== currentMachineId) return false;
    if (token.session_generation !== currentGeneration) return false;
    if (clock.now() > token.not_after) return false;
    return true;
  }
}

export const offlineGrace = new OfflineGrace();

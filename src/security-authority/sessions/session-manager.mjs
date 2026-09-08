// @ts-check

import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';
import { clock } from '../time/clock.mjs';

/**
 * Manages the lifecycle of a user session.
 * Fully backed by the physical SQLite `secure_state` table to survive process restarts.
 */
export class SessionManager {
  
  /**
   * Reads the current session from the decrypted SQLite state.
   * @returns {Promise<any | null>}
   */
  async getActiveSession() {
    const row = await AEADStorageAdapter.getSecurityStateRow();
    if (!row || !row.session) return null;

    // Terminal states that void the session entirely
    if (row.state === "REVOKED" || row.state === "COMPROMISED") {
      return null;
    }
    
    return row.session;
  }

  /**
   * Checks if the current session is valid and unexpired.
   * Note: This is an active check against the DB projection.
   * @returns {Promise<boolean>}
   */
  async isSessionValid() {
    const row = await AEADStorageAdapter.getSecurityStateRow();
    if (!row || !row.session) return false;

    if (row.state === "REVOKED" || row.state === "COMPROMISED") return false;

    const session = row.session;
    if (session.status !== 'AUTHENTICATED' && session.status !== 'RENEWING') {
      return false;
    }

    // Rely on highest_observed_time for expiration checks to thwart rollback
    const now = row.highest_observed_time || clock.now();
    if (now > session.expiresAt) {
      // Background process (like offline-grace or renewal) should theoretically 
      // handle the DB transition to EXPIRED. Here we just return false dynamically.
      return false;
    }

    return true;
  }

  /**
   * Begins a new session post-authentication via an OCC DB transaction.
   * This is typically driven by `engine.mjs` through transition logic, but 
   * provided here as a helper for constructing the session payload.
   * @param {string} sessionId
   * @param {string} userId 
   * @param {number|bigint} generation 
   * @param {number|bigint} expiresAt 
   * @param {number|bigint} renewAfter 
   * @returns {Object} The session data chunk to inject into the OCC payload
   */
  createSessionPayload(sessionId, userId, generation, expiresAt, renewAfter) {
    return {
      sessionId,
      userId,
      generation,
      expiresAt,
      renewAfter,
      status: 'AUTHENTICATED'
    };
  }

  /**
   * Checks if a session renewal is currently due based on the DB state.
   * @returns {Promise<boolean>}
   */
  async isRenewalDue() {
    const row = await AEADStorageAdapter.getSecurityStateRow();
    if (!row || !row.session) return false;
    if (row.state === "REVOKED" || row.state === "COMPROMISED" || row.state === "OFFLINE_GRACE") return false;

    const now = row.highest_observed_time || clock.now();
    return now >= row.session.renewAfter;
  }
}

export const sessionManager = new SessionManager();

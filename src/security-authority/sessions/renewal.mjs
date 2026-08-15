// @ts-check

import { sessionManager } from './session-manager.mjs';

/**
 * Handles background renewal of active sessions before expiration.
 */
export class SessionRenewal {
  /**
   * Evaluates if the current session is within the renewal window.
   * @param {number} renewalThresholdMs Time before expiration to trigger renewal
   * @returns {boolean}
   */
  shouldRenew(renewalThresholdMs = 5 * 60 * 1000) {
    const session = sessionManager.activeSession;
    if (!session || session.status !== 'ACTIVE') return false;
    
    const timeUntilExpiry = session.expiresAt - Date.now();
    return timeUntilExpiry < renewalThresholdMs && timeUntilExpiry > 0;
  }
}

export const sessionRenewal = new SessionRenewal();

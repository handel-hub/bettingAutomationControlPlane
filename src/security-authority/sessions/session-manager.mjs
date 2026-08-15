// @ts-check

/**
 * Manages the lifecycle of a user session.
 */
export class SessionManager {
  constructor() {
    /** @type {any} */
    this.activeSession = null;
  }

  /**
   * Begins a new session post-authentication.
   * @param {string} userId 
   * @param {number} generation 
   * @param {number} expiresAt 
   */
  startSession(userId, generation, expiresAt) {
    this.activeSession = {
      userId,
      generation,
      expiresAt,
      status: 'ACTIVE'
    };
  }

  /**
   * Checks if the current session is valid and unexpired.
   * @returns {boolean}
   */
  isSessionValid() {
    if (!this.activeSession || this.activeSession.status !== 'ACTIVE') return false;
    if (Date.now() > this.activeSession.expiresAt) {
      this.activeSession.status = 'EXPIRED';
      return false;
    }
    return true;
  }

  /**
   * Revokes the current session.
   */
  revokeSession() {
    if (this.activeSession) {
      this.activeSession.status = 'REVOKED';
    }
  }
}

export const sessionManager = new SessionManager();

// @ts-check

/**
 * Defines strictly typed security errors.
 */
export class SecurityAuthorityError extends Error {
  /**
   * @param {string} code 
   * @param {string} message 
   */
  constructor(code, message) {
    super(message);
    this.name = "SecurityAuthorityError";
    this.code = code;
  }
}

export const ErrorCodes = {
  INVARIANT_VIOLATION: "ERR_INVARIANT_VIOLATION",
  INVALID_TRANSITION: "ERR_INVALID_TRANSITION",
  OCC_CONFLICT: "ERR_OCC_CONFLICT",
  UNAUTHORIZED: "ERR_UNAUTHORIZED",
  INTEGRITY_FAULT: "ERR_INTEGRITY_FAULT",
  REPLAY_DETECTED: "ERR_REPLAY_DETECTED"
};

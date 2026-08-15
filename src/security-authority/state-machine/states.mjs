// @ts-check

/**
 * @typedef {typeof SecurityState[keyof typeof SecurityState]} SecurityStateEnum
 */

export const SecurityState = /** @type {const} */ ({
  UNINITIALIZED: "UNINITIALIZED",
  INITIALIZING: "INITIALIZING",
  SECURITY_STATE_UNCERTAIN: "SECURITY_STATE_UNCERTAIN",
  SECURITY_STATE_READY: "SECURITY_STATE_READY",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  AUTHENTICATING: "AUTHENTICATING",
  AUTH_FAILED: "AUTH_FAILED",
  AUTHENTICATED: "AUTHENTICATED",
  AUTHORIZING: "AUTHORIZING",
  AUTHZ_FAILURE: "AUTHZ_FAILURE",
  OPERATIONAL: "OPERATIONAL",
  RENEWING: "RENEWING",
  OFFLINE_GRACE: "OFFLINE_GRACE",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  INTEGRITY_DEGRADED: "INTEGRITY_DEGRADED",
  TAMPER_SUSPECTED: "TAMPER_SUSPECTED",
  COMPROMISED: "COMPROMISED",
  REAUTHENTICATION_REQUIRED: "REAUTHENTICATION_REQUIRED",
  LOGGING_OUT: "LOGGING_OUT",
  LOGGED_OUT: "LOGGED_OUT",
});

/**
 * @typedef {Object} SecurityStateDataUninitialized
 * @property {typeof SecurityState.UNINITIALIZED} state
 */

/**
 * @typedef {Object} SecurityStateDataUncertain
 * @property {typeof SecurityState.SECURITY_STATE_UNCERTAIN} state
 * @property {"INTERRUPTED_TRANSACTION" | "GENERATION_CAUSAL_VIOLATION"} cause
 * @property {string} [pendingTransactionId]
 */

/**
 * @typedef {Object} SecurityStateDataOperational
 * @property {typeof SecurityState.OPERATIONAL} state
 * @property {import('../persistence/schema.mjs').SessionRow} session
 * @property {import('../persistence/schema.mjs').AuthorizationRow} authorization
 * @property {import('../persistence/schema.mjs').LicenseRow} license
 * @property {import('../persistence/schema.mjs').MachineIdentityRow} machine
 */

/**
 * @typedef {Object} SecurityStateDataOfflineGrace
 * @property {typeof SecurityState.OFFLINE_GRACE} state
 * @property {string} since
 * @property {number} accumulatedMs
 * @property {import('../persistence/schema.mjs').AuthorizationRow} lastGrantedAuthorization
 */

/**
 * @typedef {Object} SecurityStateDataIntegrityIssue
 * @property {typeof SecurityState.INTEGRITY_DEGRADED | typeof SecurityState.TAMPER_SUSPECTED | typeof SecurityState.COMPROMISED} state
 * @property {import('../persistence/schema.mjs').SecurityEventRow} triggeringEvent
 */

/**
 * @typedef {Object} SecurityStateDataGeneric
 * @property {Exclude<SecurityStateEnum, typeof SecurityState.OPERATIONAL | typeof SecurityState.OFFLINE_GRACE | typeof SecurityState.SECURITY_STATE_UNCERTAIN | typeof SecurityState.INTEGRITY_DEGRADED | typeof SecurityState.TAMPER_SUSPECTED | typeof SecurityState.COMPROMISED | typeof SecurityState.UNINITIALIZED>} state
 */

/**
 * @typedef {SecurityStateDataUninitialized | SecurityStateDataUncertain | SecurityStateDataOperational | SecurityStateDataOfflineGrace | SecurityStateDataIntegrityIssue | SecurityStateDataGeneric} SecurityStateData
 */

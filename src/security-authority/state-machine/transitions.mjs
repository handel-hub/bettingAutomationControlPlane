// @ts-check

import { SecurityState } from './states.mjs';

/**
 * @typedef {typeof TransitionEvent[keyof typeof TransitionEvent]} TransitionEventEnum
 */

export const TransitionEvent = /** @type {const} */ ({
  INITIALIZE: "INITIALIZE",
  BOOTSTRAP_COMPLETE: "BOOTSTRAP_COMPLETE",
  INTERRUPTED_TRANSACTION_FOUND: "INTERRUPTED_TRANSACTION_FOUND",
  RECONCILIATION_RESOLVED: "RECONCILIATION_RESOLVED",
  LOGIN_INTENT: "LOGIN_INTENT",
  BACKEND_AUTH_SUCCESS: "BACKEND_AUTH_SUCCESS",
  BACKEND_AUTH_FAILURE: "BACKEND_AUTH_FAILURE",
  AUTHZ_LICENSE_RESOLVED: "AUTHZ_LICENSE_RESOLVED",
  AUTHZ_LICENSE_FAILED: "AUTHZ_LICENSE_FAILED",
  RENEW_THRESHOLD_REACHED: "RENEW_THRESHOLD_REACHED",
  RENEW_SUCCESS: "RENEW_SUCCESS",
  RENEW_BACKEND_UNREACHABLE: "RENEW_BACKEND_UNREACHABLE",
  BACKEND_RECONNECTED: "BACKEND_RECONNECTED",
  OFFLINE_GRACE_EXHAUSTED: "OFFLINE_GRACE_EXHAUSTED",
  SESSION_OR_LICENSE_EXPIRED: "SESSION_OR_LICENSE_EXPIRED",
  BACKEND_REVOCATION: "BACKEND_REVOCATION",
  SIGNIFICANT_TAMPER_SIGNAL: "SIGNIFICANT_TAMPER_SIGNAL",
  CRITICAL_OR_CORRELATED_TAMPER_SIGNAL: "CRITICAL_OR_CORRELATED_TAMPER_SIGNAL",
  USER_REINITIATES: "USER_REINITIATES",
  LOGOUT_INTENT: "LOGOUT_INTENT",
  LOGOUT_SEQUENCE_COMPLETE: "LOGOUT_SEQUENCE_COMPLETE",
});

/**
 * @typedef {Object} TransitionDefinition
 * @property {import('./states.mjs').SecurityStateEnum} currentState
 * @property {TransitionEventEnum} event
 * @property {function(import('./states.mjs').SecurityStateData, any): boolean} guard
 * @property {import('./states.mjs').SecurityStateEnum} nextState
 */

/** @type {TransitionDefinition[]} */
export const Transitions = [
  {
    currentState: SecurityState.UNINITIALIZED,
    event: TransitionEvent.INITIALIZE,
    guard: (state, payload) => payload.singleInstanceLockHeld === true,
    nextState: SecurityState.INITIALIZING
  },
  {
    currentState: SecurityState.INITIALIZING,
    event: TransitionEvent.BOOTSTRAP_COMPLETE,
    guard: (state, payload) => payload.integrityVerified && payload.storageVerified && payload.machineIdentityVerified,
    nextState: SecurityState.SECURITY_STATE_READY
  },
  {
    currentState: SecurityState.INITIALIZING,
    event: TransitionEvent.INTERRUPTED_TRANSACTION_FOUND,
    guard: (state, payload) => payload.pendingTransactionExists || payload.causalViolation,
    nextState: SecurityState.SECURITY_STATE_UNCERTAIN
  },
  {
    currentState: SecurityState.SECURITY_STATE_UNCERTAIN,
    event: TransitionEvent.RECONCILIATION_RESOLVED,
    guard: (state, payload) => payload.authoritativeOutcomeConfirmed === true,
    nextState: SecurityState.SECURITY_STATE_READY // Could also revert to authenticated
  },
  {
    currentState: SecurityState.SECURITY_STATE_READY,
    event: TransitionEvent.LOGIN_INTENT,
    guard: (state, payload) => true,
    nextState: SecurityState.AUTHENTICATING
  },
  {
    currentState: SecurityState.UNAUTHENTICATED,
    event: TransitionEvent.LOGIN_INTENT,
    guard: (state, payload) => true,
    nextState: SecurityState.AUTHENTICATING
  },
  {
    currentState: SecurityState.AUTHENTICATING,
    event: TransitionEvent.BACKEND_AUTH_SUCCESS,
    guard: (state, payload) => payload.nonceValidated === true,
    nextState: SecurityState.AUTHENTICATED
  },
  {
    currentState: SecurityState.AUTHENTICATING,
    event: TransitionEvent.BACKEND_AUTH_FAILURE,
    guard: (state, payload) => true,
    nextState: SecurityState.AUTH_FAILED
  },
  {
    currentState: SecurityState.AUTHENTICATED,
    event: TransitionEvent.AUTHZ_LICENSE_RESOLVED,
    guard: (state, payload) => payload.backendConfirmed === true,
    nextState: SecurityState.OPERATIONAL
  },
  {
    currentState: SecurityState.AUTHENTICATED,
    event: TransitionEvent.AUTHZ_LICENSE_FAILED,
    guard: (state, payload) => true,
    nextState: SecurityState.AUTHZ_FAILURE
  },
  {
    currentState: SecurityState.OPERATIONAL,
    event: TransitionEvent.RENEW_THRESHOLD_REACHED,
    guard: (state, payload) => payload.now >= payload.renewAfter && !payload.renewalMutexHeld,
    nextState: SecurityState.RENEWING
  },
  {
    currentState: SecurityState.RENEWING,
    event: TransitionEvent.RENEW_SUCCESS,
    guard: (state, payload) => payload.responseValidated === true,
    nextState: SecurityState.OPERATIONAL
  },
  {
    currentState: SecurityState.RENEWING,
    event: TransitionEvent.RENEW_BACKEND_UNREACHABLE,
    guard: (state, payload) => true,
    nextState: SecurityState.OFFLINE_GRACE
  },
  {
    currentState: SecurityState.OFFLINE_GRACE,
    event: TransitionEvent.BACKEND_RECONNECTED,
    guard: (state, payload) => payload.handshakePassed === true,
    nextState: SecurityState.OPERATIONAL
  },
  {
    currentState: SecurityState.OFFLINE_GRACE,
    event: TransitionEvent.OFFLINE_GRACE_EXHAUSTED,
    guard: (state, payload) => payload.accumulatedMs > payload.offlineGraceMax,
    nextState: SecurityState.REAUTHENTICATION_REQUIRED
  },
  {
    currentState: SecurityState.OPERATIONAL,
    event: TransitionEvent.SESSION_OR_LICENSE_EXPIRED,
    guard: (state, payload) => payload.now >= payload.expiresAt,
    nextState: SecurityState.EXPIRED
  },
  {
    currentState: SecurityState.OPERATIONAL,
    event: TransitionEvent.BACKEND_REVOCATION,
    guard: (state, payload) => payload.nonceChecked === true,
    nextState: SecurityState.REVOKED
  },
  {
    currentState: SecurityState.OPERATIONAL,
    event: TransitionEvent.SIGNIFICANT_TAMPER_SIGNAL,
    guard: (state, payload) => payload.classification === "SIGNIFICANT",
    nextState: SecurityState.INTEGRITY_DEGRADED
  },
  {
    currentState: SecurityState.INTEGRITY_DEGRADED,
    event: TransitionEvent.CRITICAL_OR_CORRELATED_TAMPER_SIGNAL,
    guard: (state, payload) => payload.classification === "CRITICAL" || payload.correlatedCount >= payload.threshold,
    nextState: SecurityState.TAMPER_SUSPECTED // or COMPROMISED depending on severity
  },
  {
    currentState: SecurityState.REAUTHENTICATION_REQUIRED,
    event: TransitionEvent.USER_REINITIATES,
    guard: (state, payload) => true,
    nextState: SecurityState.AUTHENTICATING
  },
  {
    currentState: SecurityState.OPERATIONAL,
    event: TransitionEvent.LOGOUT_INTENT,
    guard: (state, payload) => true,
    nextState: SecurityState.LOGGING_OUT
  },
  {
    currentState: SecurityState.LOGGING_OUT,
    event: TransitionEvent.LOGOUT_SEQUENCE_COMPLETE,
    guard: (state, payload) => payload.allStepsCompleted === true,
    nextState: SecurityState.LOGGED_OUT
  }
];

export function getTransition(currentState, event) {
  return Transitions.find(t => t.currentState === currentState && t.event === event);
}

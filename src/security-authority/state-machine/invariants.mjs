// @ts-check

import { SecurityState } from './states.mjs';

/**
 * Asserts state machine invariants dynamically.
 * A failure here indicates a FATAL implementation bug, not a typical security event.
 * @param {import('./states.mjs').SecurityStateData} stateData
 * @param {function(): string[]} currentCapabilitySet - returns an array of current CAP_* capabilities
 * @param {function(): boolean} hasActiveProtectedOperation - returns true if there is an active execution
 * @throws {Error} if an invariant is violated
 */
export function assertStateMachineInvariants(stateData, currentCapabilitySet, hasActiveProtectedOperation) {
  if (stateData.state === SecurityState.OPERATIONAL) {
    if (stateData.authorization.status !== "VALID") {
      throw new Error("Invariant Violation: OPERATIONAL implies valid authorization");
    }
    if (stateData.session.status !== "AUTHENTICATED" && stateData.session.status !== "RENEWING") {
      throw new Error("Invariant Violation: OPERATIONAL implies valid session");
    }
  }

  if (stateData.state === SecurityState.COMPROMISED || stateData.state === SecurityState.REVOKED) {
    if (currentCapabilitySet().length !== 0) {
      throw new Error("Invariant Violation: COMPROMISED/REVOKED implies no execution capability");
    }
  }

  // The severance of active operations is asynchronous and occurs after the transition.
  // Therefore, we cannot synchronously assert that no operations are active during the transition itself.
}

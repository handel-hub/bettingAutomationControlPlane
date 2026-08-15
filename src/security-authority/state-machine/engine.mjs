// @ts-check

import { getTransition } from './transitions.mjs';
import { assertStateMachineInvariants } from './invariants.mjs';
import { writeSecurityEvent } from '../audit/event-log.mjs';
import { StorageAdapter } from '../persistence/storage-adapter.mjs';
import { SecurityState } from './states.mjs';
import { Mutex } from '../../shared/mutex.mjs';
import { NativeCore } from '../native/security-core.mjs';

/**
 * @typedef {Object} ExecuteTransitionResult
 * @property {boolean} success
 * @property {import('./states.mjs').SecurityStateData} nextState
 * @property {Error} [error]
 */

/**
 * In-process single-writer mutex for state transitions (§21)
 */
const stateMachineMutex = new Mutex();

/**
 * Validates backend nonce and generation fields if the event payload contains a Backend response.
 * @param {any} payload
 * @returns {boolean}
 */
function validateBackendResponse(payload) {
  // §39 canonical: If the payload contains a backend response, validate nonce + generation fields
  if (payload && payload.isBackendResponse) {
    if (!payload.nonceValidated || !payload.generationValidated) {
      return false; // Stale response, discard silently
    }
  }
  return true;
}

/**
 * Executes a single atomic state transition according to the canonical algorithm.
 * @param {import('./states.mjs').SecurityStateData} currentStateData
 * @param {import('./transitions.mjs').TransitionEventEnum} event
 * @param {any} payload
 * @param {function(): string[]} getCapabilities
 * @param {function(): boolean} hasActiveExecution
 * @returns {Promise<ExecuteTransitionResult>}
 */
export async function executeTransition(currentStateData, event, payload, getCapabilities, hasActiveExecution) {
  // 1. acquire the in-process state-machine mutex
  const release = await stateMachineMutex.acquire();

  try {
    // 2. read current SecurityStateRow to check for OCC conflict before applying logic
    const dbStateRow = await StorageAdapter.getSecurityStateRow();
    if (!dbStateRow) {
      throw new Error("FATAL: Security state row missing from persistence layer.");
    }
    
    // The expected version must be the one we based our logic on, NOT the current DB version.
    // Otherwise, concurrent requests that read a stale state will simply grab the new version
    // inside the mutex and bypass OCC completely.
    const expectedStateVersion = currentStateData.state_version;
    
    if (expectedStateVersion !== dbStateRow.state_version) {
       // A concurrent modification happened. OCC conflict detected early.
       return { success: false, nextState: currentStateData, error: new Error("OCC Conflict: state was modified concurrently") };
    }

    // 3. look up (currentState, event) in the transition table
    const transitionDef = getTransition(currentStateData.state, event);
    if (!transitionDef) {
      await writeSecurityEvent("INVALID_TRANSITION_ATTEMPTED", "WARN", currentStateData, { event, payload });
      return { success: false, nextState: currentStateData, error: new Error("Invalid transition") };
    }

    // 4. evaluate guard
    if (!transitionDef.guard(currentStateData, payload)) {
      await writeSecurityEvent("TRANSITION_GUARD_FAILED", "WARN", currentStateData, { event, payload });
      return { success: false, nextState: currentStateData, error: new Error("Guard failed") };
    }

    // 5. validate nonce + generation fields BEFORE mutation
    if (!validateBackendResponse(payload)) {
      // Discard silently
      await writeSecurityEvent("STALE_RESPONSE_REJECTED", "INFO", currentStateData, { event });
      return { success: false, nextState: currentStateData, error: new Error("Stale backend response discarded") };
    }

    // 6. compute the mutation (next state)
    // Note: computing actual row changes happens inside the persistence logic
    const nextStateData = { ...currentStateData, state: transitionDef.nextState }; // Simplified mutation logic for now
    if (payload.sessionData) nextStateData.session = payload.sessionData;
    if (payload.authorizationData) nextStateData.authorization = payload.authorizationData;
    if (payload.licenseData) nextStateData.license = payload.licenseData;

    // 7-10. BEGIN IMMEDIATE, apply OCC guard, write SecurityEvent, COMMIT
    const commitSuccess = await StorageAdapter.commitTransitionWithOCC(
      expectedStateVersion,
      nextStateData,
      event,
      payload
    );

    if (!commitSuccess) {
      // OCC conflict, rollback occurred, we should retry. For now, bubble up.
      return { success: false, nextState: currentStateData, error: new Error("OCC Conflict") };
    }

    // OCC commit succeeded, increment local version to match what the DB just did
    nextStateData.state_version = expectedStateVersion + 1;

    // 11. update in-memory projection (typically handled by caller DecisionEngine)
    // 12. emit domain event (implemented via EventEmitter locally)
    
    // Check invariants locally before finalizing
    assertStateMachineInvariants(nextStateData, () => getCapabilities(nextStateData), hasActiveExecution);

    // Synchronously update the native FFI revocation flag
    const nonRevokedStates = [
      SecurityState.OPERATIONAL,
      SecurityState.AUTHENTICATED,
      SecurityState.AUTHENTICATING,
      SecurityState.RENEWING,
      SecurityState.OFFLINE_GRACE
    ];
    NativeCore.setRevokedSync(!nonRevokedStates.includes(nextStateData.state));

    return { success: true, nextState: nextStateData };

  } finally {
    // 14. release the state-machine mutex
    release();
  }
}

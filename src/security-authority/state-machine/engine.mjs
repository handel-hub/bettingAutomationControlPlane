// @ts-check

import { getTransition } from './transitions.mjs';
import { assertStateMachineInvariants } from './invariants.mjs';
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
 * Executes a single atomic state transition according to the canonical algorithm.
 * Applies purely LOCAL state transition guards (ignores backend boolean validity assertions).
 * @param {import('./states.mjs').SecurityStateData} currentStateData
 * @param {import('./transitions.mjs').TransitionEventEnum} event
 * @param {any} payload - The strictly validated Envelope V2 payload
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
    
    const expectedStateVersion = currentStateData.state_version;
    
    if (expectedStateVersion !== dbStateRow.state_version) {
       return { success: false, nextState: currentStateData, error: new Error("OCC Conflict: state was modified concurrently") };
    }

    // 3. look up (currentState, event) in the transition table
    const transitionDef = getTransition(currentStateData.state, event);
    if (!transitionDef) {
      await StorageAdapter.writeEvent({ event_type: "INVALID_TRANSITION_ATTEMPTED", severity: "WARN", result: "FAILED" });
      return { success: false, nextState: currentStateData, error: new Error("Invalid transition") };
    }

    // 4. evaluate guard purely based on local projection and cryptographic facts
    if (!transitionDef.guard(currentStateData, payload)) {
      await StorageAdapter.writeEvent({ event_type: "TRANSITION_GUARD_FAILED", severity: "WARN", result: "FAILED" });
      return { success: false, nextState: currentStateData, error: new Error("Guard failed") };
    }

    // Note: Protocol validation (signatures, replay guard, generation bounds) MUST have happened BEFORE this engine call.

    // 6. compute the mutation (next state)
    const nextStateData = { ...currentStateData, state: transitionDef.nextState };
    if (payload && payload.sessionData) nextStateData.session = payload.sessionData;
    if (payload && payload.authorizationData) nextStateData.authorization = payload.authorizationData;
    if (payload && payload.licenseData) nextStateData.license = payload.licenseData;
    if (payload && payload.graceTokenData) nextStateData.graceTokenData = payload.graceTokenData;

    // 7-10. BEGIN IMMEDIATE, apply OCC guard, write SecurityEvent, COMMIT
    const commitSuccess = await StorageAdapter.commitTransitionWithOCC(
      expectedStateVersion,
      nextStateData,
      event
    );

    if (!commitSuccess) {
      return { success: false, nextState: currentStateData, error: new Error("OCC Conflict") };
    }

    // OCC commit succeeded, increment local version to match what the DB just did
    nextStateData.state_version = expectedStateVersion + 1;
    
    // Write successful transition audit log
    await StorageAdapter.writeEvent({ event_type: "STATE_TRANSITION", severity: "INFO", result: "SUCCESS", metadata: { event, nextState: nextStateData.state } });
    
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

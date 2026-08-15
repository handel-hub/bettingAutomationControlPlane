// @ts-check

/**
 * DOMAIN CONTRACT: Session Security
 *
 * Threat model: Attacker attempts to hijack, prolong, or race an active user session.
 * Attacker capability: Can submit stale nonces or execute concurrent login events.
 * Attack objective: Prevent session expiration or restore a revoked session using cached data.
 * Security boundary being attacked: State Machine (DecisionEngine) transition guards.
 * Security invariant(s): 18 - Session Freshness.
 * Concrete attack operation: Attempting to submit BACKEND_AUTH_SUCCESS with an old nonce validation boolean.
 * Expected defensive mechanism: The transition guard explicitly rejects if `nonceValidated` is false.
 * Expected observable result: executeTransition fails with a guard error.
 * What the test DOES NOT prove: Does not prove network-level session cookie hijacking.
 */

import test from 'node:test';
import assert from 'node:assert';
import { executeTransition } from '../../state-machine/engine.mjs';
import { TransitionEvent } from '../../state-machine/transitions.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { setupDb } from './_harness/db.mjs';

test('Session Security Testing', async (t) => {
  await t.test('Guard checks reject BACKEND_AUTH_SUCCESS with stale nonces', async () => {
    const dbPath = './test/databases/test-session-security.db';
    await setupDb(dbPath);

    const initialState = {
      state: SecurityState.AUTHENTICATING,
      state_version: 0
    };
    await StorageAdapter.commitTransitionWithOCC(0, initialState, 'SYSTEM_BOOT');
    const stateRow = await StorageAdapter.getSecurityStateRow();

    // Try to transition with a stale nonce
    // @ts-ignore
    const result = await executeTransition(stateRow, TransitionEvent.BACKEND_AUTH_SUCCESS, {
        nonceValidated: false, // Guard should fail!
        generationValidated: true,
        isBackendResponse: true,
        sessionData: { status: 'AUTHENTICATED' }
      }, () => [], () => false);
      
    assert.strictEqual(result.success, false);
    // @ts-ignore
    assert.match(result.error.message, /Guard failed/);
  });
});

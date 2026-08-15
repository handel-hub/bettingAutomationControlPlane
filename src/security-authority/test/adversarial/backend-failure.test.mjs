// @ts-check

/**
 * DOMAIN CONTRACT: Backend Failure
 *
 * Threat model: Network failure or malicious traffic dropping prevents the Control Plane from reaching the Backend.
 * Attacker capability: Can drop outgoing TCP packets or DNS resolve requests.
 * Attack objective: Cause the system to crash, remain indefinitely authorized, or fail-open.
 * Security boundary being attacked: State Machine Degraded Modes (OFFLINE_GRACE).
 * Security invariant(s): 07 - Offline Grace, 03 - Fail-Closed.
 * Concrete attack operation: Backend renewal intent fails due to timeout or connection refused, triggering RENEW_BACKEND_UNREACHABLE.
 * Expected defensive mechanism: The state machine transitions into OFFLINE_GRACE, preserving capability temporarily until expiration.
 * Expected observable result: State becomes OFFLINE_GRACE instead of crashing or remaining fully OPERATIONAL.
 * What the test DOES NOT prove: Does not prove network-level resilience or retry jitter mechanisms.
 */

import test from 'node:test';
import assert from 'node:assert';
import { executeTransition } from '../../state-machine/engine.mjs';
import { TransitionEvent } from '../../state-machine/transitions.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { setupDb } from './_harness/db.mjs';

test('Backend Failure Testing', async (t) => {
  await t.test('Network failure transitions system to OFFLINE_GRACE', async () => {
    const dbPath = './test/databases/test-backend-failure.db';
    await setupDb(dbPath);

    const initialState = {
      state: SecurityState.RENEWING,
      state_version: 0,
      machine: { machine_generation: 1 },
      authorization: { authorization_revision: 1 },
      session: { status: 'AUTHENTICATED', session_generation: 1 }
    };
    await StorageAdapter.commitTransitionWithOCC(0, initialState, 'SYSTEM_BOOT');
    let stateRow = await StorageAdapter.getSecurityStateRow();

    // Trigger renewal failure
    // @ts-ignore
    const result = await executeTransition(stateRow, TransitionEvent.RENEW_BACKEND_UNREACHABLE, {}, () => [], () => false);
    
    assert.strictEqual(result.success, true, 'Transition to OFFLINE_GRACE must succeed');
    
    const finalRow = await StorageAdapter.getSecurityStateRow();
    // @ts-ignore
    assert.strictEqual(finalRow.state, SecurityState.OFFLINE_GRACE, 'System must degrade to OFFLINE_GRACE on network failure');
  });
});

// @ts-check

/**
 * DOMAIN CONTRACT: Authorization Race
 *
 * Threat model: The backend issues a revocation exactly simultaneously with a local client requesting a capability.
 * Attacker capability: Can time requests perfectly to race asynchronous state machines.
 * Attack objective: Gain unauthorized capability by bypassing the revocation event.
 * Security boundary being attacked: State Machine (DecisionEngine) transition guards.
 * Security invariant(s): 08 - Revocation Priority, 20 - Authorization Monotonicity.
 * Concrete attack operation: Submitting a valid authorization resolution when the system has already hit BACKEND_REVOCATION.
 * Expected defensive mechanism: The execution logic enforces that REVOKED is a terminal capability state; AUTHZ_LICENSE_RESOLVED is not a valid transition from REVOKED.
 * Expected observable result: The system remains in REVOKED and the authorization resolves as an invalid transition error.
 * What the test DOES NOT prove: Does not test network latency jitter or mutex queuing fairness.
 */

import test from 'node:test';
import assert from 'node:assert';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { executeTransition } from '../../state-machine/engine.mjs';
import { TransitionEvent } from '../../state-machine/transitions.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { setupDb } from './_harness/db.mjs';

test('Authorization Race Testing', async (t) => {
  await t.test('Backend Revocation is terminal and overrides delayed Authorization', async () => {
    const dbPath = './test/databases/test-authz-race.db';
    await setupDb(dbPath);

    // Initial state: System is already REVOKED because the network race was won by REVOKE
    const initialState = {
      state: SecurityState.REVOKED,
      state_version: 0,
      session: { status: 'REVOKED' }
    };

    await StorageAdapter.commitTransitionWithOCC(0, initialState, 'SYSTEM_BOOT');
    let stateRow = await StorageAdapter.getSecurityStateRow();

    // Now the delayed AUTHZ_LICENSE_RESOLVED event arrives
    // @ts-ignore
    const authzResult = await executeTransition(stateRow, TransitionEvent.AUTHZ_LICENSE_RESOLVED, {
      backendConfirmed: true,
      authorizationData: { status: 'VALID', capability_set: ['test'] },
      licenseData: { status: 'VALID' }
    }, () => [], () => false);

    assert.strictEqual(authzResult.success, false, 'Authorization must be rejected if state is already revoked');

    const finalRow = await StorageAdapter.getSecurityStateRow();
    
    // System must remain REVOKED, proving monotonicity
    // @ts-ignore
    assert.strictEqual(finalRow.state, SecurityState.REVOKED);
  });
});

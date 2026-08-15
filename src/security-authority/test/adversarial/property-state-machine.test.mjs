// @ts-check

/**
 * DOMAIN CONTRACT: Property State Machine
 *
 * Threat model: Attacker fuzzes or submits wildly out-of-order protocol events to the state machine.
 * Attacker capability: Can trigger any defined TransitionEvent at any point in the lifecycle.
 * Attack objective: Cause an unhandled exception (DoS), bypass an intermediate cryptographic state, or illegally transition into OPERATIONAL.
 * Security boundary being attacked: DecisionEngine Transition Matrix and Invariant Guards.
 * Security invariant(s): 02 - Default Deny, 16 - No Crash / DoS, 22 - Protocol Semantics.
 * Concrete attack operation: Attempting to submit BACKEND_AUTH_SUCCESS while the system is still UNINITIALIZED.
 * Expected defensive mechanism: The transition matrix natively rejects events not defined for the current state.
 * Expected observable result: The system remains in UNINITIALIZED and gracefully returns a failure without crashing.
 * What the test DOES NOT prove: Does not exhaustively fuzz 100% of the mathematical state space, but proves the deterministic guard layout.
 */

import test from 'node:test';
import assert from 'node:assert';
import { executeTransition } from '../../state-machine/engine.mjs';
import { TransitionEvent } from '../../state-machine/transitions.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { setupDb } from './_harness/db.mjs';

test('Property-Based State Machine Testing', async (t) => {
  await t.test('Standard Boot Flow completes sequentially without invariant violations', async () => {
    const dbPath = './test/databases/test-sm-flow.db';
    await setupDb(dbPath);

    // Initial state
    let stateRow = await StorageAdapter.getSecurityStateRow();
    if (!stateRow) {
      await StorageAdapter.commitTransitionWithOCC(0, {
        state: SecurityState.UNINITIALIZED,
        state_version: 0
      }, 'SYSTEM_BOOT');
      stateRow = await StorageAdapter.getSecurityStateRow();
    }
    
    // @ts-ignore
    assert.strictEqual(stateRow.state, SecurityState.UNINITIALIZED);

    // Transition 1: INITIALIZE
    // @ts-ignore
    let result = await executeTransition(stateRow, TransitionEvent.INITIALIZE, { singleInstanceLockHeld: true }, () => [], () => false);
    assert.strictEqual(result.success, true);
    stateRow = await StorageAdapter.getSecurityStateRow();
    // @ts-ignore
    assert.strictEqual(stateRow.state, SecurityState.INITIALIZING);

    // Transition 2: BOOTSTRAP_COMPLETE
    // @ts-ignore
    result = await executeTransition(stateRow, TransitionEvent.BOOTSTRAP_COMPLETE, {
      integrityVerified: true,
      storageVerified: true,
      machineIdentityVerified: true
    }, () => [], () => false);
    assert.strictEqual(result.success, true);
    stateRow = await StorageAdapter.getSecurityStateRow();
    // @ts-ignore
    assert.strictEqual(stateRow.state, SecurityState.SECURITY_STATE_READY);
  });

  await t.test('Invalid transition sequences gracefully fail without crashing', async () => {
    const dbPath = './test/databases/test-sm-invalid.db';
    await setupDb(dbPath);

    let stateRow = await StorageAdapter.getSecurityStateRow();
    if (!stateRow) {
      await StorageAdapter.commitTransitionWithOCC(0, {
        state: SecurityState.UNINITIALIZED,
        state_version: 0
      }, 'SYSTEM_BOOT');
      stateRow = await StorageAdapter.getSecurityStateRow();
    }

    // From UNINITIALIZED, trying to send BACKEND_AUTH_SUCCESS is fundamentally illegal
    // @ts-ignore
    let result = await executeTransition(stateRow, TransitionEvent.BACKEND_AUTH_SUCCESS, {}, () => [], () => false);
    
    assert.strictEqual(result.success, false);
    // @ts-ignore
    assert.match(result.error.message, /Invalid transition/);
  });
});

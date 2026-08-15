// @ts-check

/**
 * DOMAIN CONTRACT: Concurrency
 *
 * Threat model: Local process attempts to overwrite or race security state transitions.
 * Attacker capability: Local code execution, able to trigger concurrent requests.
 * Attack objective: Bypass security invariants by exploiting TOC/TOU races in persistence.
 * Security boundary being attacked: Optimistic Concurrency Control (OCC) and Mutex lock in StorageAdapter.
 * Security invariant(s): 01 - Single Authority, 21 - Concurrency Handling.
 * Concrete attack operation: Two simultaneous attempts to commit version N+1.
 * Expected defensive mechanism: StorageAdapter natively rejects the slower writer due to `state_version` mismatch.
 * Expected observable result: One transaction succeeds, the other fails with OCC conflict.
 * What the test DOES NOT prove: Does not prove network-level idempotency or backend race safety.
 */

import test from 'node:test';
import assert from 'node:assert';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { setupDb } from './_harness/db.mjs';

test('Concurrency & State Machine', async (t) => {
  await t.test('Optimistic Concurrency Control (OCC) safely rejects concurrent writes', async () => {
    const dbPath = './test/databases/test-concurrency.db';
    await setupDb(dbPath);

    const initialState = {
      state: SecurityState.UNINITIALIZED,
      state_version: 0,
    };

    // Transition 1: Initialize
    await StorageAdapter.commitTransitionWithOCC(0, initialState, 'INITIALIZE');

    const expectedStateVersion = 1;

    // Simulate two concurrent requests trying to transition from version 1 to 2
    const nextStateDataA = {
      state: SecurityState.INITIALIZING,
      state_version: expectedStateVersion,
      session: { status: 'A' }
    };

    const nextStateDataB = {
      state: SecurityState.INITIALIZING,
      state_version: expectedStateVersion,
      session: { status: 'B' }
    };

    // Promise.all to fire them at the exact same time
    const results = await Promise.all([
      StorageAdapter.commitTransitionWithOCC(expectedStateVersion, nextStateDataA, 'EVENT_A'),
      StorageAdapter.commitTransitionWithOCC(expectedStateVersion, nextStateDataB, 'EVENT_B')
    ]);

    // One must succeed, one must fail (OCC Conflict)
    assert.ok(results.includes(true), 'At least one commit should succeed');
    assert.ok(results.includes(false), 'At least one commit should fail due to OCC');

    // Verify DB state version is exactly 2
    const dbStateRow = await StorageAdapter.getSecurityStateRow();
    // @ts-ignore
    assert.strictEqual(dbStateRow.state_version, 2);
  });
});

// @ts-check

/**
 * DOMAIN CONTRACT: Crash Recovery
 *
 * Threat model: The Node process is forcefully terminated (SIGKILL) during a state transition.
 * Attacker capability: Local admin can kill the process at any precise millisecond.
 * Attack objective: Leave the security state in a torn or partially authorized condition.
 * Security boundary being attacked: StorageAdapter Transaction Atomicity.
 * Security invariant(s): 03 - Fail-Closed, 14 - Persistence Integrity.
 * Concrete attack operation: We simulate a crash by mocking SQLite `run` to throw an error exactly midway through a commit sequence.
 * Expected defensive mechanism: The Promise rejects, and the database rollback prevents the state from advancing.
 * Expected observable result: The subsequent read from a clean adapter yields the original, pre-transition state.
 * What the test DOES NOT prove: Does not simulate kernel panics or filesystem-level journal corruption.
 */

import test from 'node:test';
import assert from 'node:assert';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { setupDb } from './_harness/db.mjs';

test('Crash Recovery Testing', async (t) => {
  await t.test('Interrupted transition does not tear state (Atomicity)', async () => {
    const dbPath = './test/databases/test-crash.db';
    await setupDb(dbPath);

    const initialState = {
      state: SecurityState.UNINITIALIZED,
      state_version: 0,
    };

    // Commit baseline
    await StorageAdapter.commitTransitionWithOCC(0, initialState, 'INITIALIZE');

    const nextState = {
      state: SecurityState.OPERATIONAL,
      state_version: 1,
      session: { status: 'AUTHENTICATED' }
    };

    // We intentionally mock the internal DB object to throw midway
    // @ts-ignore
    const originalRun = StorageAdapter._db.run.bind(StorageAdapter._db);
    // @ts-ignore
    StorageAdapter._db.run = async (sql, params) => {
      if (sql.includes('UPDATE secure_state')) {
        throw new Error('SIMULATED_SIGKILL');
      }
      return originalRun(sql, params);
    };

    try {
      await StorageAdapter.commitTransitionWithOCC(1, nextState, 'TEST_EVENT');
      assert.fail('Should have thrown SIMULATED_SIGKILL');
    } catch (err) {
      // @ts-ignore
      assert.strictEqual(err.message, 'SIMULATED_SIGKILL');
    } finally {
      // @ts-ignore
      StorageAdapter._db.run = originalRun;
    }

    // Read the state back. It MUST be the initial state (version 1), NOT the operational state.
    const finalStateRow = await StorageAdapter.getSecurityStateRow();
    // @ts-ignore
    assert.strictEqual(finalStateRow.state_version, 1);
    // @ts-ignore
    assert.strictEqual(finalStateRow.state, SecurityState.UNINITIALIZED);
  });
});

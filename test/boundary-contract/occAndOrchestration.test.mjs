// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/state-store/StateStore.mjs';
import { setSharedStateStore } from '../../src/state-store/sharedStateStore.mjs';
import { RevisionConflictError } from '../../src/state-store/types/errors.mjs';
import { executionBoundaryManager } from '../../src/runtime-manager/boundary/index.mjs';
import { commandRouter } from '../../src/command/commandRouter.mjs';
import { Command } from '../../src/command/command.mjs';
import { registerDefaultCommandHandlers } from '../../src/index.mjs';

test('Phase 5 & 6: OCC SQLite Repositories & Orchestration Engine Wiring', async (t) => {
  const store = new StateStore({ dbPath: ':memory:', userId: 'usr_occ_test' });
  store.initialize();
  setSharedStateStore(store);
  registerDefaultCommandHandlers();

  await t.test('Optimistic Concurrency Control rejects stale revision mutations on accounts', () => {
    const acc = store.accounts.upsert({
      id: 'acc-occ-1',
      name: 'SportyBet Alpha',
      platformDisplayName: 'SportyBet',
      accountUsername: 'sporty_alpha',
      accountPassword: 'SecretPassword123!'
    });

    const meta = store.metadataAdapter.get('accounts');
    const currentRev = meta ? meta.revision : 1;

    // Mutate with correct revision
    const updated = store.accounts.updateExecutionState('acc-occ-1', { desiredState: 'RUNNING' }, currentRev);
    assert.equal(updated.desiredState, 'RUNNING');

    // Mutate with stale revision (currentRev is now stale because revision bumped)
    assert.throws(() => {
      store.accounts.updateExecutionState('acc-occ-1', { desiredState: 'STOPPED' }, currentRev);
    }, (err) => err instanceof RevisionConflictError);
  });

  await t.test('Optimistic Concurrency Control rejects stale revision mutations on global config', () => {
    const meta = store.metadataAdapter.get('global_config');
    const currentRev = meta ? meta.revision : 1;

    // Mutate with correct revision
    store.config.updateCategory('pricing', { targetProfit: 45000 }, currentRev);

    // Stale revision mutation
    assert.throws(() => {
      store.config.updateCategory('pricing', { targetProfit: 50000 }, currentRev);
    }, (err) => err instanceof RevisionConflictError);
  });

  await t.test('Orchestration engine dispatches full-document policy update on TOGGLE_BET_CYCLE', async () => {
    let betCycleToggled = null;

    // Mock execution boundary dispatch
    const originalSetBetCycle = executionBoundaryManager.setBetCycle;
    const originalIsConnected = executionBoundaryManager.isConnected;

    executionBoundaryManager.isConnected = () => true;
    executionBoundaryManager.setBetCycle = (browserId, isEnabled, opts) => {
      betCycleToggled = { browserId, isEnabled };
      return true;
    };

    try {
      const cmd = new Command({
        category: 'Persistence',
        type: 'TOGGLE_BET_CYCLE',
        target: 'acc-occ-1',
        payload: { enabled: true },
        traceId: 'trace-occ-toggle'
      });

      const res = await commandRouter.route(cmd);
      assert.equal(res.success, true);
      assert.equal(res.results[0]?.toggled, true);
      assert.equal(betCycleToggled?.browserId, 'acc-occ-1');
      assert.equal(betCycleToggled?.isEnabled, true);
    } finally {
      executionBoundaryManager.setBetCycle = originalSetBetCycle;
      executionBoundaryManager.isConnected = originalIsConnected;
    }
  });

  
  await t.test('Orchestration engine marks account OUT_OF_SYNC if policy dispatch throws error', async () => {
    const originalSetBetCycle = executionBoundaryManager.setBetCycle;
    const originalIsConnected = executionBoundaryManager.isConnected;

    executionBoundaryManager.isConnected = () => true;
    executionBoundaryManager.setBetCycle = () => {
      throw new Error('EPIPE: Broken Pipe');
    };

    try {
      const cmd = new Command({
        category: 'Persistence',
        type: 'TOGGLE_BET_CYCLE',
        target: 'acc-occ-1',
        payload: { enabled: false },
        traceId: 'trace-occ-fail'
      });

      const res = await commandRouter.route(cmd);
      assert.equal(res.success, true);

      // Check account observedState transitioned to OUT_OF_SYNC
      const acc = store.accounts.getById('acc-occ-1');
      assert.equal(acc.observedState, 'OUT_OF_SYNC');
      assert.ok(acc.executionStatusReason.includes('DISPATCH_FAILED'));
    } finally {
      executionBoundaryManager.setBetCycle = originalSetBetCycle;
      executionBoundaryManager.isConnected = originalIsConnected;
    }
  });

  store.close();
});

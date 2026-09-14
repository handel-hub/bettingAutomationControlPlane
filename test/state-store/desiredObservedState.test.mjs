// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../../src/state-store/StateStore.mjs';
import { DesiredLifecycleState, ObservedLifecycleState } from '../../src/state-store/persistence/adapters/LifecycleStateAdapter.mjs';

test('State Foundation: Separation of Desired vs Observed State', async (t) => {
  const store = new StateStore({ dbPath: ':memory:', userId: 'usr_test_state' });
  store.initialize();

  await t.test('System lifecycle initializes with STOPPED for both desired and observed state', () => {
    const state = store.lifecycle.getState();
    assert.equal(state.desiredState, DesiredLifecycleState.STOPPED);
    assert.equal(state.observedState, ObservedLifecycleState.STOPPED);
    assert.equal(typeof state.generation, 'number');
  });

  await t.test('Transitions desired state without mutating observed state', () => {
    const updated = store.lifecycle.setDesiredState(DesiredLifecycleState.RUNNING, 'USER_COMMAND_START');
    assert.equal(updated.desiredState, DesiredLifecycleState.RUNNING);
    assert.equal(updated.observedState, ObservedLifecycleState.STOPPED);
    assert.equal(updated.transitionReason, 'USER_COMMAND_START');
  });

  await t.test('Transitions observed state during handshake and execution without mutating desired state', () => {
    const handshake = store.lifecycle.setObservedState(ObservedLifecycleState.STARTING_HANDSHAKE, 'SPAWN_INIT');
    assert.equal(handshake.desiredState, DesiredLifecycleState.RUNNING);
    assert.equal(handshake.observedState, ObservedLifecycleState.STARTING_HANDSHAKE);

    const running = store.lifecycle.setObservedState(ObservedLifecycleState.RUNNING, 'HMAC_ESTABLISHED');
    assert.equal(running.desiredState, DesiredLifecycleState.RUNNING);
    assert.equal(running.observedState, ObservedLifecycleState.RUNNING);
  });

  await t.test('Account records maintain independent desired and observed execution states', () => {
    const acc = store.accounts.upsert({
      id: 'acc-state-1',
      name: 'SportyBet Runner',
      platformDisplayName: 'SportyBet',
      accountUsername: 'sporty_runner_01',
      desiredState: 'STOPPED',
      observedState: 'STOPPED'
    });

    assert.equal(acc.desiredState, 'STOPPED');
    assert.equal(acc.observedState, 'STOPPED');

    // Operator requests start -> desiredState becomes RUNNING while observed remains STOPPED
    const intentAcc = store.accounts.updateExecutionState('acc-state-1', { desiredState: 'RUNNING' });
    assert.equal(intentAcc.desiredState, 'RUNNING');
    assert.equal(intentAcc.observedState, 'STOPPED');

    // EP confirms activation -> observedState becomes RUNNING
    const activeAcc = store.accounts.updateExecutionState('acc-state-1', { observedState: 'RUNNING' });
    assert.equal(activeAcc.desiredState, 'RUNNING');
    assert.equal(activeAcc.observedState, 'RUNNING');
  });

  await t.test('Boot reset forces observed states to STOPPED while preserving desired states (Crash Recovery)', () => {
    // Both system and account were observed RUNNING
    store.lifecycle.setObservedState(ObservedLifecycleState.RUNNING, 'SIMULATE_ACTIVE');
    store.accounts.updateExecutionState('acc-state-1', { observedState: 'RUNNING' });

    // Simulate system restart
    store.initialize();

    const state = store.lifecycle.getState();
    assert.equal(state.desiredState, DesiredLifecycleState.RUNNING, 'Desired state must be preserved across boot');
    assert.equal(state.observedState, ObservedLifecycleState.STOPPED, 'Observed state must reset to STOPPED');

    const acc = store.accounts.getById('acc-state-1');
    assert.equal(acc.desiredState, 'RUNNING', 'Account desired state preserved');
    assert.equal(acc.observedState, 'STOPPED', 'Account observed state reset to STOPPED on boot');
    assert.equal(acc.executionStatusReason, 'SYSTEM_BOOT_RECOVERY');
  });

  store.close();
});

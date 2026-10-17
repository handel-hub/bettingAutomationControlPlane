// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/state-store/StateStore.mjs';
import { ExecutionPayloadBuilder } from '../src/runtime-manager/boundary/ExecutionPayloadBuilder.mjs';
import { WorkspaceAggregator } from '../src/state/workspaceAggregator.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { registerDefaultCommandHandlers } from '../src/index.mjs';
import { getSharedStateStore } from '../src/state-store/sharedStateStore.mjs';
import { vaultCredentialPipeline } from '../src/runtime-manager/boundary/VaultCredentialPipeline.mjs';

test('Account Selection & Selective Staging Suite', async (t) => {
  registerDefaultCommandHandlers();

  await t.test('1. ExecutionPayloadBuilder compiles ONLY targeted/staged accounts', () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_selection_test' });
    store.initialize();

    // Provision 3 accounts
    store.accounts.upsert({
      id: 'acc_target_1',
      name: 'Alpha Target',
      platformDisplayName: 'SportyBet',
      accountUsername: '08011111111',
      accountPassword: 'Password1!'
    });
    store.accounts.upsert({
      id: 'acc_target_2',
      name: 'Beta Target',
      platformDisplayName: 'BetKing',
      accountUsername: '08022222222',
      accountPassword: 'Password2!'
    });
    store.accounts.upsert({
      id: 'acc_unselected_invalid',
      name: 'Unselected Broken Account',
      platformDisplayName: 'Bet9ja',
      accountUsername: '08033333333',
      accountPassword: '' // Missing password!
    });

    // Request payload targeting ONLY acc_target_2
    const payload = ExecutionPayloadBuilder.buildInitializationPayload(store, 'trace-selective-1', ['acc_target_2']);

    assert.equal(payload.accounts.length, 1, 'Compiled accounts must contain exactly 1 account');
    assert.equal(payload.accounts[0].id, 'acc_target_2');
    assert.equal(payload.accounts[0].role, 'master', 'Single selected account must be master');
    assert.equal(payload.accounts[0].username, '08022222222');
    assert.equal(payload.accounts[0].password, 'Password2!');

    // Notice that acc_unselected_invalid with missing password did NOT throw [CREDENTIAL_MISSING]
    store.close();
  });

  await t.test('2. Multi-account staging sets index 0 as master and subsequent as slave', () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_multi_stage' });
    store.initialize();

    store.accounts.upsert({
      id: 'acc_1',
      name: 'Account One',
      platformDisplayName: 'SportyBet',
      accountUsername: '08011111111',
      accountPassword: 'Password1!'
    });
    store.accounts.upsert({
      id: 'acc_2',
      name: 'Account Two',
      platformDisplayName: 'BetKing',
      accountUsername: '08022222222',
      accountPassword: 'Password2!'
    });

    const payload = ExecutionPayloadBuilder.buildInitializationPayload(store, 'trace-multi', ['acc_2', 'acc_1']);
    assert.equal(payload.accounts.length, 2);
    assert.equal(payload.accounts[0].id, 'acc_2');
    assert.equal(payload.accounts[0].role, 'master');
    assert.equal(payload.accounts[1].id, 'acc_1');
    assert.equal(payload.accounts[1].role, 'slave');

    store.close();
  });

  await t.test('3. Deselecting accounts persists empty fleet without aggressive auto-staging resurrecting them', async () => {
    const accountsRepo = (await import('../src/repositories/repositoryFactory.mjs')).repositoryFactory.getAccountsRepo();
    try {
      await accountsRepo.create({
        id: 'acc_seed_1',
        name: 'Seed 1',
        platformDisplayName: 'SportyBet',
        accountUsername: 'seed_user_1'
      });
      await accountsRepo.create({
        id: 'acc_seed_2',
        name: 'Seed 2',
        platformDisplayName: 'BetKing',
        accountUsername: 'seed_user_2'
      });
    } catch {}

    const aggregator = new WorkspaceAggregator();

    // Cold initial snapshot stages default accounts
    const initialSnapshot = await aggregator.getSnapshot();
    assert.ok(aggregator.hasInitializedStaging, 'hasInitializedStaging must be true after initial boot');
    assert.ok(initialSnapshot.accounts.length >= 2, 'Must stage initial accounts on cold boot');

    const { securityFacade } = await import('../src/security-authority/facade.mjs');
    const origAuth = securityFacade.authorize.bind(securityFacade);
    const origDegraded = securityFacade.isDegraded.bind(securityFacade);
    securityFacade.authorize = () => ({ status: 'OPERATIONAL' });
    securityFacade.isDegraded = () => false;

    try {
      // Operator deactivates all accounts to clear fleet
      for (const acc of initialSnapshot.accounts) {
        aggregator.deactivateAccount(acc.id);
      }

      assert.equal(aggregator.stagedAccountIds.size, 0, 'Staged account IDs must be 0 after deactivation');

      // Subsequent snapshot must NOT re-stage them
      const clearedSnapshot = await aggregator.getSnapshot();
      assert.equal(clearedSnapshot.accounts.length, 0, 'Fleet must remain empty when operator deactivates accounts');
      assert.equal(clearedSnapshot.capabilities.canStartAutomation, false, 'Cannot start automation when 0 accounts staged');
      assert.equal(clearedSnapshot.capabilities.startDisabledReason, 'At least one account must be configured');

      // Operator adds 1 account
      aggregator.activateAccount('acc_test_single');
      assert.equal(aggregator.stagedAccountIds.has('acc_test_single'), true);
    } finally {
      securityFacade.authorize = origAuth;
      securityFacade.isDegraded = origDegraded;
    }
  });

  await t.test('4. REGISTER_ACCOUNT does not auto-stage new accounts into automation fleet', async () => {
    const { securityFacade } = await import('../src/security-authority/facade.mjs');
    const { workspaceAggregator } = await import('../src/state/workspaceAggregator.mjs');
    const origAuth = securityFacade.authorize.bind(securityFacade);
    const origDegraded = securityFacade.isDegraded.bind(securityFacade);
    securityFacade.authorize = () => ({ status: 'OPERATIONAL' });
    securityFacade.isDegraded = () => false;

    workspaceAggregator.stagedAccountIds.clear();
    workspaceAggregator.hasInitializedStaging = true; // Mark as configured

    try {
      const regResult = await commandRouter.route(JSON.stringify({
        protocolVersion: '2.0',
        category: 'Persistence',
        type: 'REGISTER_ACCOUNT',
        payload: {
          name: 'Freshly Added Account',
          platformDisplayName: 'SportyBet',
          accountUsername: '08099999999',
          accountPassword: 'SecretPassword99!'
        },
        messageId: '01M2TESTREGSTAGE000',
        timestamp: new Date().toISOString()
      }));

      assert.equal(regResult.success, true);
      const createdId = regResult.results?.[0]?.id || regResult.data?.id;
      assert.ok(createdId, 'Must return created account ID');

      // Verify it is NOT added to workspaceAggregator.stagedAccountIds
      assert.equal(workspaceAggregator.stagedAccountIds.has(createdId), false, 'New account must not be auto-staged');
    } finally {
      securityFacade.authorize = origAuth;
      securityFacade.isDegraded = origDegraded;
    }
  });
});

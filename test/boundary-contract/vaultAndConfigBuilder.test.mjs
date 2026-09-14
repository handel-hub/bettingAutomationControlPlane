// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultCredentialPipeline } from '../../src/runtime-manager/boundary/VaultCredentialPipeline.mjs';
import { ExecutionPayloadBuilder } from '../../src/runtime-manager/boundary/ExecutionPayloadBuilder.mjs';
import { StateStore } from '../../src/state-store/StateStore.mjs';

test('Phase 3 & 4: Vault Decryption Pipeline & Full-Document Config Builders', async (t) => {
  await t.test('VaultCredentialPipeline stores encrypted credentials and decrypts on-demand', () => {
    const vault = new VaultCredentialPipeline();
    const accountId = 'acc-vault-test-1';
    const secretPassword = 'MySecretPassword#2026!';

    vault.storeCredential(accountId, secretPassword);
    assert.ok(vault.hasCredential(accountId), 'Vault must track stored credential');

    const decrypted = vault.decryptCredential(accountId);
    assert.equal(decrypted, secretPassword, 'Decrypted password must match original');

    vault.evictCredential(accountId);
    assert.equal(vault.hasCredential(accountId), false, 'Evicted credential must no longer be present');
  });

  await t.test('ExecutionPayloadBuilder constructs canonical PascalCase policy document matching EP solver schema', () => {
    const globalConfig = {
      pricing: {
        mode: 'PROFIT_TARGET',
        baseStake: 100,
        targetProfit: 30,
        minimumAcceptableProfit: 0,
        resolutionStrategy: 'CLAMP_THEN_REDUCE_PROFIT',
        platformIncrement: 1,
        selectionPreference: 'ROUND_NUMBERS',
        restorePolicyOnRebet: true
      },
      risk: {
        maxStake: 10000,
        minimumStake: 10,
        autoAcceptOddsChanges: true
      },
      rebet: {
        maxRebetAttempts: 2,
        rebetStakeIncrement: 15
      },
      execution: {
        orderTimeoutMs: 15000,
        navigationTimeoutMs: 8000
      }
    };

    const policy = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig, { betCycleEnabled: true });

    // Verify root PascalCase keys
    assert.ok(policy.BetCycle, 'Must have BetCycle');
    assert.ok(policy.Pricing, 'Must have Pricing');
    assert.ok(policy.Rebet, 'Must have Rebet');
    assert.ok(policy.Execution, 'Must have Execution');
    assert.ok(policy.RiskManagement, 'Must have RiskManagement');

    // Verify subfields
    assert.equal(policy.Pricing.Strategy.Mode, 'PROFIT_TARGET');
    assert.equal(policy.Pricing.Strategy.TargetProfit, 30);
    assert.equal(policy.Pricing.Strategy.ResolutionStrategy, 'CLAMP_THEN_REDUCE_PROFIT');
    assert.equal(policy.Rebet.Strategy.MaxRebetAttempts, 2);
    assert.equal(policy.Execution.Timeouts.ResultTimeoutMs, 15000);
    assert.equal(policy.RiskManagement.Limits.MaxStake, 10000);
    assert.equal(policy.BetCycle.Execution.Enabled, true);
  });

  await t.test('ExecutionPayloadBuilder builds complete LIFECYCLE:INITIALIZE payload with settings, accounts, and policies', () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_init_test' });
    store.initialize();
    store._seedDefaultAccounts();

    const payload = ExecutionPayloadBuilder.buildInitializationPayload(store);

    assert.ok(payload.settings, 'Payload must contain settings');
    assert.ok(Array.isArray(payload.accounts), 'Payload must contain accounts array');
    assert.ok(payload.accounts.length >= 2, 'Accounts array must contain seeded accounts');
    assert.ok(payload.policy, 'Payload must contain policy');
    assert.ok(payload.policy.defaultPolicy, 'Policy must have defaultPolicy');
    assert.ok(payload.policy.accountPolicies, 'Policy must have accountPolicies dictionary');

    // Confirm passwords are not '[PROTECTED]' inside the transient IPC payload
    for (const acc of payload.accounts) {
      assert.notEqual(acc.password, '[PROTECTED]', 'Decrypted password must be provided for browser login');
      assert.ok(acc.password.length > 0, 'Password must not be empty');
    }

    store.close();
  });
});

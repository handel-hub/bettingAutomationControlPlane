// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/state-store/StateStore.mjs';
import { setSharedStateStore } from '../src/state-store/sharedStateStore.mjs';
import { VaultCredentialPipeline } from '../src/runtime-manager/boundary/VaultCredentialPipeline.mjs';
import { ExecutionPayloadBuilder } from '../src/runtime-manager/boundary/ExecutionPayloadBuilder.mjs';

test('Password Persistence & Credential Pipeline Invariants', async (t) => {
  const store = new StateStore({ dbPath: ':memory:', userId: 'test_operator' });
  store.initialize();
  setSharedStateStore(store);

  const vault = new VaultCredentialPipeline();

  await t.test('1. Preserves plaintext password in SQLite and Memory when backend hydrates with masked password', () => {
    const accountData = {
      id: 'acc_test_1',
      name: 'SportyBet Primary',
      platformDisplayName: 'SportyBet',
      accountUsername: '09158683206',
      accountPassword: 'MyStrongPassword123!'
    };

    // Upsert account
    store.accounts.upsert(accountData);
    vault.storeCredential(accountData.id, accountData.accountPassword);

    // Assert initial persistence
    assert.equal(store.accounts.getRawPassword(accountData.id), 'MyStrongPassword123!');
    assert.equal(vault.decryptCredential(accountData.id), 'MyStrongPassword123!');

    // Simulate Cloud Backend Authoritative Snapshot hydration with masked password '********'
    const backendSnapshot = [{
      id: 'acc_test_1',
      name: 'SportyBet Primary',
      platformDisplayName: 'SportyBet',
      accountUsername: '09158683206',
      accountPassword: '********',
      backendState: 'ACTIVE'
    }];

    store.accounts.replaceAll(backendSnapshot);

    // Verify plaintext password was NOT clobbered by cloud mask
    assert.equal(
      store.accounts.getRawPassword(accountData.id),
      'MyStrongPassword123!',
      'SQLite raw password must not be overwritten by backend mask'
    );

    // Clear vault memory cache to test SQLite fallback recovery
    vault.evictCredential(accountData.id);
    assert.equal(
      vault.decryptCredential(accountData.id),
      'MyStrongPassword123!',
      'Vault must restore password from SQLite after memory eviction'
    );
  });

  await t.test('2. Preserves password when backend snapshot reconciles under a different account_id', () => {
    // Evict any previous test data
    store.purgeAll();

    // User registered locally with temporary ID
    const localId = 'local_uuid_abc';
    store.accounts.upsert({
      id: localId,
      name: 'SportyBet Runner',
      platformDisplayName: 'SportyBet',
      accountUsername: '08012345678',
      accountPassword: 'SuperSecretLocalPassword!'
    });

    assert.equal(store.accounts.getRawPassword(localId), 'SuperSecretLocalPassword!');

    // Backend sync returns authoritative Postgres UUID for the same (platform, username)
    const backendId = 'pg_uuid_999';
    store.accounts.upsert({
      id: backendId,
      name: 'SportyBet Runner',
      platformDisplayName: 'SportyBet',
      accountUsername: '08012345678',
      accountPassword: '********'
    });

    // The new ID must have inherited the preserved password
    assert.equal(
      store.accounts.getRawPassword(backendId),
      'SuperSecretLocalPassword!',
      'New ID must inherit preserved password from evicted username conflict'
    );
  });

  await t.test('3. ExecutionPayloadBuilder resolves credentials and pre-flight validates', () => {
    store.purgeAll();

    const validAccount = {
      id: 'acc_exec_valid',
      name: 'SportyBet Master',
      platformDisplayName: 'SportyBet',
      accountUsername: '09158683206',
      accountPassword: 'ValidMasterPassword!'
    };
    store.accounts.upsert(validAccount);

    // 3a. Resolves plaintext password for IPC dispatch
    const payload = ExecutionPayloadBuilder.buildInitializationPayload(store);

    assert.equal(payload.accounts.length, 1);
    assert.equal(payload.accounts[0].password, 'ValidMasterPassword!');

    // 3b. Pre-flight assertion: fails fast if password is missing or masked
    const invalidAccount = {
      id: 'acc_exec_invalid',
      name: 'Invalid Account',
      platformDisplayName: 'SportyBet',
      accountUsername: '07000000000',
      accountPassword: ''
    };
    store.accounts.upsert(invalidAccount);

    assert.throws(() => {
      ExecutionPayloadBuilder.buildInitializationPayload(store);
    }, /\[CREDENTIAL_MISSING\]/);
  });
});

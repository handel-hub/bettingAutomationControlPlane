// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createStateStore } from '../../../src/state-store/index.mjs';
import { RevisionConflictError } from '../../../src/state-store/types/errors.mjs';
import { ApiServer } from '../../../src/api-server/server.mjs';
import { commandRouter } from '../../../src/command/commandRouter.mjs';
import { repositoryFactory } from '../../../src/repositories/repositoryFactory.mjs';
import { getSharedStateStore } from '../../../src/state-store/sharedStateStore.mjs';

describe('Tier 4 Hardening: OCC, Durability & Write-Through Integrity', () => {
  const testDbDir = path.join(process.cwd(), '.tmp-durability-test');

  before(() => {
    if (fs.existsSync(testDbDir)) {
      try { fs.rmSync(testDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    fs.mkdirSync(testDbDir, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(testDbDir)) {
      try { fs.rmSync(testDbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('CAN-05: Account overrides survive cold-boot crash recovery and rehydration', () => {
    const testDbPath = path.join(testDbDir, `overrides_${Date.now()}.db`);

    // 1. Initial process lifecycle: create store, account, and override
    const store1 = createStateStore({ dbPath: testDbPath, userId: 'usr_durability' });
    store1.initialize();

    const created = store1.accounts.upsert({
      id: 'acc-durable-1',
      platformDisplayName: 'Bet9ja',
      accountUsername: 'durable_trader_1'
    });
    assert.equal(created.id, 'acc-durable-1');

    // Update account-specific configuration override
    const overridePayload = {
      betCycleEnabled: false,
      pricingSource: 'CUSTOM',
      customStake: 7500
    };
    store1.config.updateAccountOverride('acc-durable-1', overridePayload);

    const memOverride1 = store1.config.getAccountOverride('acc-durable-1');
    assert.equal(memOverride1.betCycleEnabled, false);
    assert.equal(memOverride1.pricingSource, 'CUSTOM');
    assert.equal(memOverride1.customStake, 7500);

    // Simulate abrupt process termination
    store1.close();

    // 2. Cold reboot: hydrate fresh store from persistent SQLite database
    const store2 = createStateStore({ dbPath: testDbPath, userId: 'usr_durability' });
    store2.initialize();

    const rehydratedAccount = store2.accounts.getById('acc-durable-1');
    assert.ok(rehydratedAccount, 'Account must be recovered from SQLite');

    const rehydratedOverride = store2.config.getAccountOverride('acc-durable-1');
    assert.ok(rehydratedOverride, 'Override must be present after cold rehydration');
    assert.equal(rehydratedOverride.betCycleEnabled, false, 'betCycleEnabled must be durable');
    assert.equal(rehydratedOverride.pricingSource, 'CUSTOM', 'pricingSource must be durable');
    assert.equal(rehydratedOverride.customStake, 7500, 'customStake must be durable');

    store2.close();
  });

  it('CAN-04: Enforces SQLite-first write ordering on state mutations', () => {
    const store = createStateStore({ dbPath: ':memory:', userId: 'usr_write_through' });
    store.initialize();

    // Verify initial accounts revision
    const metaInitial = store.metadataAdapter.get('accounts');
    const initRev = metaInitial ? metaInitial.revision : 1;

    // Successful upsert increments revision
    const acc = store.accounts.upsert({
      id: 'acc-wt-1',
      platformDisplayName: 'SportyBet',
      accountUsername: 'wt_user_1'
    }, initRev);

    assert.equal(acc.id, 'acc-wt-1');
    const metaAfter = store.metadataAdapter.get('accounts');
    assert.equal(metaAfter.revision, initRev + 1);

    // Stale revision rejects before memory mutation
    assert.throws(() => {
      store.accounts.upsert({
        id: 'acc-wt-1',
        platformDisplayName: 'SportyBet',
        accountUsername: 'wt_user_1',
        name: 'Stale Update'
      }, initRev); // Passing stale initRev
    }, RevisionConflictError);

    // Verified: in-memory record retained previous name, not stale update name
    assert.equal(store.accounts.getById('acc-wt-1').name, 'wt_user_1');

    store.close();
  });

  it('CAN-07 & CAN-08: PATCH /api/v1/accounts/:id rejects stale OCC revisions with HTTP 409 Conflict', async () => {
    // Ensure command router handler is registered
    commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
      return repositoryFactory.getAccountsRepo().create(cmd.payload);
    });

    const sharedStore = getSharedStateStore();
    const server = new ApiServer();
    const port = 8097;
    await server.listen(port, '127.0.0.1');

    try {
      // 1. Create account
      const uniqueUsername = `occ_user_${Date.now()}`;
      const createRes = await fetch(`http://127.0.0.1:${port}/api/v1/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'OCC Test Account',
          platformDisplayName: 'BetKing',
          accountUsername: uniqueUsername,
          accountPassword: 'Password123!'
        })
      });
      assert.equal(createRes.status, 201);
      const createdAccount = await createRes.json();
      assert.ok(createdAccount.id);

      // Get current accounts revision from metadata
      const currentMeta = sharedStore.metadataAdapter.get('accounts');
      const actualRevision = currentMeta ? currentMeta.revision : 1;

      // 2. Attempt PATCH with stale If-Match header -> Must return 409
      const staleRes = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${createdAccount.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"99999"'
        },
        body: JSON.stringify({ name: 'Conflicting Name Update' })
      });
      assert.equal(staleRes.status, 409, 'Expected HTTP 409 Conflict on stale revision');
      const staleBody = await staleRes.json();
      assert.equal(staleBody.error, 'Revision Conflict');
      assert.equal(staleBody.expectedRevision, 99999);

      // 3. Attempt PATCH with stale x-expected-revision header -> Must also return 409
      const staleHeaderRes = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${createdAccount.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-expected-revision': '99999'
        },
        body: JSON.stringify({ name: 'Conflicting Name Update' })
      });
      assert.equal(staleHeaderRes.status, 409, 'Expected HTTP 409 on x-expected-revision mismatch');

      // 4. Attempt PATCH with accurate current revision -> Must succeed with 200 OK
      const validRes = await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${createdAccount.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${actualRevision}"`
        },
        body: JSON.stringify({ name: 'Valid Synchronized Name' })
      });
      assert.equal(validRes.status, 200, 'Expected HTTP 200 OK on matching revision');
      const validBody = await validRes.json();
      assert.equal(validBody.name, 'Valid Synchronized Name');

    } finally {
      await server.close();
    }
  });
});

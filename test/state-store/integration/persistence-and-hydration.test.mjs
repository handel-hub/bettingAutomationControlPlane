// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createStateStore } from '../../../src/state-store/index.mjs';
import { MOCK_ACCOUNTS, MOCK_GLOBAL_CONFIG, MOCK_PLANS_CATALOG } from '../fixtures/mockDatasets.mjs';

describe('StateStore Persistence & Hydration Lifecycle', () => {
  const testDbDir = path.join(process.cwd(), '.tmp-lifecycle-test');

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

  it('runs complete persistence, close, and restart hydration lifecycle', () => {
    const testDbPath = path.join(testDbDir, `lifecycle_${Date.now()}_1.db`);
    const userId = 'usr_operator_1';

    // 1. First Boot: Initialize empty store and populate state
    const store1 = createStateStore({ dbPath: testDbPath, userId });
    store1.initialize();

    // Populate data
    store1.accounts.upsert(MOCK_ACCOUNTS[0]);
    store1.accounts.upsert(MOCK_ACCOUNTS[1]);
    store1.config.updateCategory('pricing', { baseStake: 5000 });
    store1.billing.updateSubscription({ currentPlanId: 'pro', status: 'Active' });
    store1.catalogs.replacePlansCatalog(MOCK_PLANS_CATALOG, 'W/"test-etag"');
    store1.notifications.add({ id: 'notif-1', title: 'Boot alert', message: 'Test message' });

    assert.equal(store1.accounts.getAll().length, 2);
    assert.equal(store1.config.getCategory('pricing').baseStake, 5000);
    assert.equal(store1.billing.getSnapshot().currentPlanId, 'pro');

    // Close first instance cleanly
    store1.close();

    // 2. Second Boot: Re-open separate StateStore instance on the same file
    const store2 = createStateStore({ dbPath: testDbPath, userId });
    const stats = store2.initialize();

    assert.ok(stats.durationMs >= 0);
    assert.equal(stats.loadedCounts['accounts'], 2);

    // Verify all persisted state rehydrated properly into memory
    const accounts = store2.accounts.getAll();
    assert.equal(accounts.length, 2);
    const alpha = accounts.find(a => a.accountUsername === 'operator_alpha');
    assert.ok(alpha);
    assert.equal(alpha.accountPassword, '[PROTECTED]');

    const pricing = store2.config.getCategory('pricing');
    assert.equal(pricing.baseStake, 5000);

    const billing = store2.billing.getSnapshot();
    assert.equal(billing.currentPlanId, 'pro');
    assert.equal(billing.status, 'Active');

    const plans = store2.catalogs.getPlansCatalog();
    assert.equal(plans.defaultPlanId, 'pro');

    const notifs = store2.notifications.getAll();
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0].title, 'Boot alert');

    store2.close();
  });

  it('guarantees transaction rollback: simulated error does not persist partial state', () => {
    const store = createStateStore({ dbPath: ':memory:', userId: 'usr_test' });
    store.initialize();

    const initialAccountsCount = store.accounts.getAll().length;

    // Trigger a failed transaction
    assert.throws(() => {
      store.consistencyGroups.executeGroupTransaction('accounts', null, () => {
        store.accountsAdapter.upsert('usr_test', { id: 'temp-1', platformDisplayName: 'SportyBet', accountUsername: 'ghost' });
        throw new Error('Simulated mid-transaction crash');
      });
    }, /Simulated mid-transaction crash/);

    // Verify record was rolled back from SQLite
    const inDb = store.accountsAdapter.listByUser('usr_test');
    assert.equal(inDb.length, initialAccountsCount);

    store.close();
  });
});

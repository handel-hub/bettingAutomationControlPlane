// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore } from '../../../src/state-store/index.mjs';
import { MOCK_ACCOUNTS, MOCK_GLOBAL_CONFIG, MOCK_PLANS_CATALOG } from '../fixtures/mockDatasets.mjs';

describe('StateStore Snapshot Projections & Prelude Parity', () => {
  it('projects atomic Prelude snapshot matching contract specification', () => {
    const store = createStateStore({ dbPath: ':memory:', userId: 'usr_test_prelude' });
    store.initialize();

    store.accounts.upsert(MOCK_ACCOUNTS[0]);
    store.accounts.updateBalance(MOCK_ACCOUNTS[0].id, 142500, '₦');
    store.catalogs.replacePlansCatalog(MOCK_PLANS_CATALOG);

    const prelude = store.getPreludeSnapshot();

    // Verify root envelope
    assert.equal(prelude.topic, 'app:prelude');
    assert.ok(prelude.payload);

    const p = prelude.payload;
    // Verify protocol
    assert.equal(p.protocol.protocolVersion, '1.0.0');

    // Verify user
    assert.equal(p.user.id, 'usr_test_prelude');

    // Verify billing
    assert.ok(p.billing.snapshot);
    assert.ok(p.billing.plansCatalog);
    assert.equal(p.billing.plansCatalog.defaultPlanId, 'pro');

    // Verify accounts
    assert.ok(p.accounts.platformRegistry);
    assert.equal(p.accounts.initialView.viewportAccounts.length, 1);
    assert.equal(p.accounts.initialView.viewportAccounts[0].currentBalance, 142500);

    // Verify automation
    assert.ok(p.automation.snapshot);
    assert.ok(p.automation.snapshot.globalConfig);

    // Verify settings & support
    assert.ok(p.settings.snapshot);
    assert.ok(p.support.snapshot);
    assert.ok(p.system.currentVersion);

    store.close();
  });

  it('memoizes Prelude projection for sub-millisecond retrieval', () => {
    const store = createStateStore({ dbPath: ':memory:', userId: 'usr_memo' });
    store.initialize();

    // Cold projection
    const p1 = store.getPreludeSnapshot();

    // Warm projection - must return exact memoized reference
    const t0 = performance.now();
    const p2 = store.getPreludeSnapshot();
    const t1 = performance.now();

    assert.equal(p1, p2, 'Subsequent call without mutations must return identical memoized reference');
    assert.ok(t1 - t0 < 1.0, 'Memoized access must be faster than 1ms');

    // Mutating state invalidates memoization
    store.config.updateCategory('pricing', { baseStake: 3000 });
    const p3 = store.getPreludeSnapshot();
    assert.notEqual(p1, p3, 'Mutation must invalidate memoized projection');
    assert.equal(p3.payload.automation.snapshot.globalConfig.pricing.baseStake, 3000);

    store.close();
  });

  it('projects paginated and filtered accounts view', () => {
    const store = createStateStore({ dbPath: ':memory:', userId: 'usr_view' });
    store.initialize();

    store.accounts.upsert({ id: 'a-1', platformDisplayName: 'SportyBet', accountUsername: 'sporty_1' });
    store.accounts.upsert({ id: 'a-2', platformDisplayName: 'Bet9ja', accountUsername: 'bet9ja_1' });
    store.accounts.upsert({ id: 'a-3', platformDisplayName: 'SportyBet', accountUsername: 'sporty_2' });

    // Filter by platform / query
    const res = store.getAccountsView({ filterQuery: 'SportyBet' });
    assert.equal(res.viewportAccounts.length, 2);
    assert.equal(res.searchMetadata.totalMatches, 2);

    // Pagination
    const page1 = store.getAccountsView({ offset: 0, limit: 1 });
    assert.equal(page1.viewportAccounts.length, 1);
    assert.equal(page1.searchMetadata.totalMatches, 3);

    store.close();
  });
});

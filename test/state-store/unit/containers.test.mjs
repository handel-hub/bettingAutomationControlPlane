// @ts-check
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccountsContainer } from '../../../src/state-store/memory/AccountsContainer.mjs';
import { AutomationConfigContainer } from '../../../src/state-store/memory/AutomationConfigContainer.mjs';
import { BillingContainer } from '../../../src/state-store/memory/BillingContainer.mjs';
import { CatalogsContainer } from '../../../src/state-store/memory/CatalogsContainer.mjs';
import { SettingsContainer } from '../../../src/state-store/memory/SettingsContainer.mjs';
import { NotificationsContainer } from '../../../src/state-store/memory/NotificationsContainer.mjs';
import { RevisionConflictError, ValidationError } from '../../../src/state-store/types/errors.mjs';
import { MOCK_ACCOUNTS, MOCK_GLOBAL_CONFIG, MOCK_PLANS_CATALOG } from '../fixtures/mockDatasets.mjs';

describe('AccountsContainer Unit Tests', () => {
  let container;

  beforeEach(() => {
    container = new AccountsContainer();
  });

  it('initializes with revision 1 and empty accounts', () => {
    assert.equal(container.revision, 1);
    assert.equal(container.getAll().length, 0);
  });

  it('hydrates accounts and increments revision', () => {
    container.hydrate(MOCK_ACCOUNTS, 10);
    assert.equal(container.revision, 10);
    assert.equal(container.getAll().length, 2);
    const acc1 = container.getById('acc-1');
    assert.ok(acc1);
    assert.equal(acc1.accountUsername, 'operator_alpha');
    assert.equal(acc1.accountPassword, '[PROTECTED]');
  });

  it('enforces composite uniqueness on (platform, username)', () => {
    container.upsert({ id: 'acc-1', platformDisplayName: 'SportyBet', accountUsername: 'operator_alpha' });
    assert.throws(() => {
      container.upsert({ id: 'acc-duplicate', platformDisplayName: 'SportyBet', accountUsername: 'operator_alpha' });
    }, ValidationError);
  });

  it('enforces optimistic concurrency control (OCC) on upsert', () => {
    container.upsert({ id: 'acc-1', platformDisplayName: 'SportyBet', accountUsername: 'alpha' }, 1);
    assert.equal(container.revision, 2);

    // Stale expected revision throws
    assert.throws(() => {
      container.upsert({ id: 'acc-1', platformDisplayName: 'SportyBet', accountUsername: 'alpha_updated' }, 1);
    }, RevisionConflictError);
  });

  it('protects immutability: modifying returned account throws or fails silently', () => {
    container.upsert({ id: 'acc-1', platformDisplayName: 'SportyBet', accountUsername: 'alpha' });
    const acc = container.getById('acc-1');
    assert.throws(() => {
      // @ts-ignore
      acc.name = 'Hacked';
    }, TypeError);
  });
});

describe('AutomationConfigContainer Unit Tests', () => {
  let container;

  beforeEach(() => {
    container = new AutomationConfigContainer();
  });

  it('initializes with all 7 default categories', () => {
    const config = container.getGlobalConfig();
    assert.ok(config.pricing);
    assert.ok(config.risk);
    assert.ok(config.rebet);
    assert.ok(config.proxy);
    assert.ok(config.execution);
    assert.ok(config.browserSpawning);
    assert.ok(config.advancedRuntime);
  });

  it('updates a specific category and increments revision', () => {
    const initialRev = container.revision;
    const result = container.updateCategory('pricing', { baseStake: 2500 }, initialRev);
    assert.equal(result.revision, initialRev + 1);
    assert.equal(container.getCategory('pricing').baseStake, 2500);
  });

  it('rejects invalid category names', () => {
    assert.throws(() => {
      container.updateCategory('nonExistentCategory', { foo: 'bar' });
    }, ValidationError);
  });
});

describe('BillingContainer Unit Tests', () => {
  let container;

  beforeEach(() => {
    container = new BillingContainer('usr_test');
  });

  it('initializes with default subscription', () => {
    const sub = container.getSnapshot();
    assert.equal(sub.status, 'Active');
    assert.equal(sub.userId, 'usr_test');
  });

  it('updates subscription with OCC revision checking', () => {
    const res = container.updateSubscription({ currentPlanId: 'pro', status: 'Active' }, 1);
    assert.equal(res.revision, 2);
    assert.equal(container.getSnapshot().currentPlanId, 'pro');
  });

  it('manages invoices and sorts them descending by date', () => {
    container.addInvoice({ id: 'inv-1', reference: 'ref-1', date: '2026-09-01T00:00:00Z', amount: 5000 });
    container.addInvoice({ id: 'inv-2', reference: 'ref-2', date: '2026-09-05T00:00:00Z', amount: 10000 });
    const invoices = container.getInvoices();
    assert.equal(invoices.length, 2);
    assert.equal(invoices[0].id, 'inv-2'); // Newer date first
  });
});

describe('NotificationsContainer Unit Tests', () => {
  let container;

  beforeEach(() => {
    container = new NotificationsContainer();
  });

  it('appends notifications and caps at 100 with FIFO eviction', () => {
    for (let i = 1; i <= 105; i++) {
      container.add({ id: `notif-${i}`, title: `Alert ${i}`, message: 'Test message' });
    }
    const all = container.getAll();
    assert.equal(all.length, 100);
    assert.equal(all[0].id, 'notif-6'); // Earliest evicted
    assert.equal(all[99].id, 'notif-105');
  });

  it('tracks unread count and marks items read', () => {
    container.add({ id: 'n-1', read: false });
    container.add({ id: 'n-2', read: false });
    assert.equal(container.unreadCount, 2);

    container.markRead('n-1');
    assert.equal(container.unreadCount, 1);

    container.markAllRead();
    assert.equal(container.unreadCount, 0);
  });
});

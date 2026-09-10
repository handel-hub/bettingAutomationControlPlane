// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createStateStore } from '../../../src/state-store/index.mjs';
import { RevisionConflictError } from '../../../src/state-store/types/errors.mjs';
import { MOCK_ACCOUNTS } from '../fixtures/mockDatasets.mjs';

describe('StateStore Scoping, OCC & Disaster Recovery', () => {
  const testDbDir = path.join(process.cwd(), '.tmp-scoping-test');

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

  it('enforces multi-user data scoping on a shared database', () => {
    const testDbPath = path.join(testDbDir, `scoping_${Date.now()}_1.db`);

    // User A
    const storeA = createStateStore({ dbPath: testDbPath, userId: 'usr_alpha' });
    storeA.initialize();
    storeA.accounts.upsert({ id: 'acc-alpha', platformDisplayName: 'SportyBet', accountUsername: 'user_a_acc' });
    storeA.close();

    // User B
    const storeB = createStateStore({ dbPath: testDbPath, userId: 'usr_beta' });
    storeB.initialize();
    assert.equal(storeB.accounts.getAll().length, 0); // Must be isolated!

    storeB.accounts.upsert({ id: 'acc-beta', platformDisplayName: 'Bet9ja', accountUsername: 'user_b_acc' });
    assert.equal(storeB.accounts.getAll().length, 1);
    storeB.close();

    // Recheck User A
    const verifyA = createStateStore({ dbPath: testDbPath, userId: 'usr_alpha' });
    verifyA.initialize();
    assert.equal(verifyA.accounts.getAll().length, 1);
    assert.equal(verifyA.accounts.getAll()[0].id, 'acc-alpha');
    verifyA.close();
  });

  it('purges user data on logout while preserving public reference catalogs', () => {
    const testDbPath = path.join(testDbDir, `logout_${Date.now()}_2.db`);

    const store = createStateStore({ dbPath: testDbPath, userId: 'usr_operator' });
    store.initialize();

    store.accounts.upsert(MOCK_ACCOUNTS[0]);
    store.notifications.add({ id: 'n-1', title: 'Alert' });
    store.catalogs.replacePlatformRegistry([
      { id: 'sportybet', displayName: 'SportyBet Custom', isAvailable: true, status: 'ONLINE' }
    ]);

    assert.equal(store.accounts.getAll().length, 1);

    // Operator logs out
    store.onLogout('usr_operator');

    // User-scoped data is scrubbed
    assert.equal(store.accounts.getAll().length, 0);
    assert.equal(store.notifications.getAll().length, 0);

    // Shared reference catalogs are preserved
    const platforms = store.catalogs.getPlatformRegistry();
    assert.equal(platforms.platforms.length, 1);
    assert.equal(platforms.platforms[0].displayName, 'SportyBet Custom');

    store.close();
  });

  it('rejects stale mutations via Optimistic Concurrency Control (OCC)', () => {
    const store = createStateStore({ dbPath: ':memory:', userId: 'usr_test' });
    store.initialize();

    // Read initial revision
    const currentRev = store.configContainer.revision;

    // Mutate successfully once
    store.config.updateCategory('pricing', { baseStake: 1500 }, currentRev);

    // Second write with stale expected revision must throw RevisionConflictError
    assert.throws(() => {
      store.config.updateCategory('pricing', { baseStake: 2000 }, currentRev);
    }, RevisionConflictError);

    store.close();
  });

  it('self-heals from database file corruption without crashing', () => {
    const testDbPath = path.join(testDbDir, `corrupt_${Date.now()}_4.db`);

    // 1. Create a database with data
    const store = createStateStore({ dbPath: testDbPath, userId: 'usr_test' });
    store.initialize();
    store.accounts.upsert(MOCK_ACCOUNTS[0]);
    store.close();

    // 2. Corrupt the database file intentionally
    fs.writeFileSync(testDbPath, 'CORRUPTED_GARBAGE_BYTES_NOT_A_SQLITE_DATABASE');

    // 3. Initialize should detect corruption, rename file, and recreate fresh DB
    const recoveryStore = createStateStore({ dbPath: testDbPath, userId: 'usr_test' });
    assert.doesNotThrow(() => {
      recoveryStore.initialize();
    });

    // Verify corrupt backup was created
    const files = fs.readdirSync(testDbDir);
    const corruptFiles = files.filter(f => f.includes('corrupt'));
    assert.ok(corruptFiles.length > 0, 'Should have created a .corrupt backup file');

    // Store is fresh and functional
    assert.equal(recoveryStore.accounts.getAll().length, 0);
    recoveryStore.accounts.upsert(MOCK_ACCOUNTS[1]);
    assert.equal(recoveryStore.accounts.getAll().length, 1);

    recoveryStore.close();
  });
});

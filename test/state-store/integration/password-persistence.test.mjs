// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateStore } from '../../../src/state-store/StateStore.mjs';
import { ExecutionPayloadBuilder } from '../../../src/runtime-manager/boundary/ExecutionPayloadBuilder.mjs';

test('Integration: Direct SQLite Password Persistence & Cold-Boot Recovery', async (t) => {
  const tmpDbPath = path.join(os.tmpdir(), `acp_pw_persist_${Date.now()}.db`);
  const userId = 'usr_persist_test';

  t.after(() => {
    try {
      if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
      if (fs.existsSync(`${tmpDbPath}-shm`)) fs.unlinkSync(`${tmpDbPath}-shm`);
    } catch { /* ignore */ }
  });

  let store = new StateStore({ dbPath: tmpDbPath, userId });
  store.initialize();

  const realPassword = 'RealBookmakerPassword#2026!';
  const customAccount = {
    id: 'acc_persist_01',
    name: 'Princess Test',
    platformDisplayName: 'SportyBet',
    accountUsername: '08107992381',
    accountPassword: realPassword,
    backendState: 'ACTIVE'
  };

  await t.test('1. Upsert saves password directly into SQLite', () => {
    const saved = store.accounts.upsert(customAccount);
    assert.equal(saved.accountUsername, '08107992381');
    assert.equal(saved.accountPassword, realPassword);

    // Verify row directly in SQLite
    const row = store.engine.prepare('SELECT account_password FROM accounts_metadata_cache WHERE account_id = ?').get('acc_persist_01');
    assert.ok(row, 'Row must exist in SQLite');
    assert.equal(row.account_password, realPassword, 'SQLite row must contain real plaintext password');
  });

  await t.test('2. ExecutionPayloadBuilder extracts real password for Chrome execution', () => {
    const payload = ExecutionPayloadBuilder.buildInitializationPayload(store);
    const target = payload.accounts.find(a => a.id === 'acc_persist_01');
    assert.ok(target, 'Payload must contain custom account');
    assert.equal(target.password, realPassword, 'Chrome execution payload must receive real password');
    assert.notEqual(target.password, '[PROTECTED]');
    assert.notEqual(target.password, 'Password123!');
  });

  await t.test('3. Prelude projection protects password over public API boundary', () => {
    const envelope = store.getPreludeSnapshot({ lifecycle: 'STOPPED' });
    const prelude = envelope.payload || envelope;
    const viewAcc = prelude.accounts.initialView.viewportAccounts.find(a => a.id === 'acc_persist_01');
    assert.ok(viewAcc, 'Viewport accounts must contain target');
    assert.equal(viewAcc.accountPassword, '[PROTECTED]', 'Prelude projection must mask password to [PROTECTED]');
  });

  await t.test('4. Cold-boot restart hydrates password from SQLite without loss', () => {
    // Simulate process termination
    store.close();

    // Cold-boot new StateStore instance against the same SQLite database file
    const rebootedStore = new StateStore({ dbPath: tmpDbPath, userId });
    rebootedStore.initialize();

    const loaded = rebootedStore.accounts.getById('acc_persist_01');
    assert.ok(loaded, 'Account must hydrate from SQLite on reboot');
    assert.equal(loaded.accountPassword, realPassword, 'Password must survive process restart in SQLite');

    // Verify ExecutionPayloadBuilder on rebooted store
    const rebootedPayload = ExecutionPayloadBuilder.buildInitializationPayload(rebootedStore);
    const rebootedTarget = rebootedPayload.accounts.find(a => a.id === 'acc_persist_01');
    assert.ok(rebootedTarget, 'Rebooted payload must have account');
    assert.equal(rebootedTarget.password, realPassword, 'Rebooted Chrome payload must have real password');

    rebootedStore.close();
  });
});

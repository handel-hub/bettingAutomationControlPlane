// acp-bytenode-compat-lab/tests/m1-sqlite-storage-engine.mjs
// M1: Native better-sqlite3 Storage Engine compatibility tests

import fs from 'node:fs';
import path from 'node:path';
import { SqliteStorageEngine } from '../../src/state-store/persistence/SqliteStorageEngine.mjs';

export function registerM1Tests(harness) {
  harness.test('M1-001', 'better-sqlite3 in-memory open & PRAGMAs', 'M1-StorageEngine', async () => {
    const engine = new SqliteStorageEngine(':memory:');
    engine.open();
    const ok = engine.quickCheck();
    const ver = engine.userVersion();
    engine.close();
    return { quickCheck: ok, version: ver };
  });

  harness.test('M1-002', 'better-sqlite3 CRUD statement preparation', 'M1-StorageEngine', async () => {
    const engine = new SqliteStorageEngine(':memory:');
    engine.open();
    engine.exec(`
      CREATE TABLE test_items (id TEXT PRIMARY KEY, value REAL, title TEXT);
    `);
    const insert = engine.prepare('INSERT INTO test_items (id, value, title) VALUES (?, ?, ?)');
    insert.run('item_1', 42.5, 'Alpha');
    insert.run('item_2', 99.0, 'Beta');

    const select = engine.prepare('SELECT * FROM test_items WHERE id = ?');
    const row = select.get('item_1');

    const update = engine.prepare('UPDATE test_items SET value = ? WHERE id = ?');
    update.run(50.0, 'item_1');
    const updatedRow = select.get('item_1');

    const countStmt = engine.prepare('SELECT COUNT(*) as count FROM test_items');
    const total = countStmt.get().count;
    engine.close();

    if (row.value !== 42.5 || updatedRow.value !== 50.0 || total !== 2) {
      throw new Error(`M1-002 CRUD assertion failed: row=${JSON.stringify(row)}, updated=${JSON.stringify(updatedRow)}`);
    }

    return { initial: row.value, updated: updatedRow.value, total };
  });

  harness.test('M1-003', 'better-sqlite3 atomic transaction commit', 'M1-StorageEngine', async () => {
    const engine = new SqliteStorageEngine(':memory:');
    engine.open();
    engine.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, amount INTEGER);');
    const insert = engine.prepare('INSERT INTO ledger VALUES (?, ?)');

    engine.transaction(() => {
      insert.run('tx1', 100);
      insert.run('tx2', 200);
    });

    const sum = engine.prepare('SELECT SUM(amount) as s FROM ledger').get().s;
    engine.close();

    if (sum !== 300) throw new Error(`Expected sum 300, received ${sum}`);
    return { sum };
  });

  harness.test('M1-004', 'better-sqlite3 transaction rollback on error', 'M1-StorageEngine', async () => {
    const engine = new SqliteStorageEngine(':memory:');
    engine.open();
    engine.exec('CREATE TABLE ledger (id TEXT PRIMARY KEY, amount INTEGER);');
    const insert = engine.prepare('INSERT INTO ledger VALUES (?, ?)');

    let caught = false;
    try {
      engine.transaction(() => {
        insert.run('tx_ok', 100);
        throw new Error('Simulated crash inside transaction');
      });
    } catch (_) {
      caught = true;
    }

    const count = engine.prepare('SELECT COUNT(*) as count FROM ledger').get().count;
    engine.close();

    if (!caught || count !== 0) {
      throw new Error(`Rollback failed: caught=${caught}, remaining_count=${count}`);
    }

    return { rollbackSuccess: true, remainingCount: count };
  });

  harness.test('M1-005', 'better-sqlite3 file-backed persistence & quickCheck', 'M1-StorageEngine', async () => {
    const tmpDir = path.resolve(process.cwd(), '.tmp-compat-lab');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbFile = path.join(tmpDir, 'm1-test.db');
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

    try {
      const engine = new SqliteStorageEngine(dbFile);
      engine.open();
      engine.exec('CREATE TABLE persistence_test (k TEXT PRIMARY KEY, v TEXT);');
      engine.prepare('INSERT INTO persistence_test VALUES (?, ?)').run('ping', 'pong');
      const pass = engine.quickCheck();
      engine.close();

      // Reopen to verify file read
      const engine2 = new SqliteStorageEngine(dbFile);
      engine2.open();
      const val = engine2.prepare('SELECT v FROM persistence_test WHERE k = ?').get('ping').v;
      engine2.close();

      if (val !== 'pong') throw new Error(`Persistence mismatch: ${val}`);
      return { filePersisted: true, value: val, quickCheck: pass };
    } finally {
      try {
        if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
        const wal = `${dbFile}-wal`;
        const shm = `${dbFile}-shm`;
        if (fs.existsSync(wal)) fs.unlinkSync(wal);
        if (fs.existsSync(shm)) fs.unlinkSync(shm);
      } catch {}
    }
  });
}

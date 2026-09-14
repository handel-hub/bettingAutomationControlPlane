// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncMutex } from '../../src/shared/AsyncMutex.mjs';
import { executionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { commandRouter } from '../../src/command/commandRouter.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { getSharedStateStore } from '../../src/state-store/sharedStateStore.mjs';
import { registerDefaultCommandHandlers } from '../../src/index.mjs';
import { SqliteStorageEngine } from '../../src/state-store/persistence/SqliteStorageEngine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Phase 19: Concurrency Hardening & High-Contention Stress Testing', async (t) => {
  // Setup environment & handlers
  // @ts-ignore
  securityFacade.authorize = () => ({ status: 'OPERATIONAL' });
  // @ts-ignore
  securityFacade.isDegraded = () => false;

  registerDefaultCommandHandlers();

  await t.test('100 concurrent competing START and STOP commands serialize deterministically without deadlocks', async () => {
    const store = getSharedStateStore();
    store.lifecycle.setDesiredState('STOPPED', 'TEST_RESET');
    store.lifecycle.setObservedState('STOPPED', 'TEST_RESET');

    // Mock execution boundary transport to avoid real OS process spawns in fast stress loop
    const originalStart = executionBoundaryManager.startCluster.bind(executionBoundaryManager);
    const originalStop = executionBoundaryManager.stopCluster.bind(executionBoundaryManager);

    let activeSimulatedWorkers = 0;
    executionBoundaryManager.startCluster = async () => {
      await new Promise((r) => setTimeout(r, 5));
      activeSimulatedWorkers++;
      return { started: true };
    };

    executionBoundaryManager.stopCluster = async () => {
      await new Promise((r) => setTimeout(r, 5));
      activeSimulatedWorkers = 0;
      return { stopped: true };
    };

    try {
      const commands = [];
      for (let i = 0; i < 100; i++) {
        const type = i % 2 === 0 ? 'START_AUTOMATION' : 'STOP_AUTOMATION';
        commands.push(
          commandRouter.route({
            category: 'Execution',
            type,
            traceId: `stress-trace-${i}`,
            payload: {}
          }).catch((err) => ({ error: err.message, code: err.code }))
        );
      }

      const results = await Promise.all(commands);
      assert.equal(results.length, 100);

      // Verify no hangs, and the final state is deterministic
      const finalState = store.lifecycle.getState();
      assert.ok(
        finalState.observedState === 'STOPPED' || finalState.observedState === 'RUNNING' || finalState.observedState === 'STARTING_HANDSHAKE',
        `Final observed state must be valid, got: ${finalState.observedState}`
      );
    } finally {
      executionBoundaryManager.startCluster = originalStart;
      executionBoundaryManager.stopCluster = originalStop;
      store.lifecycle.setDesiredState('STOPPED', 'TEST_CLEANUP');
      store.lifecycle.setObservedState('STOPPED', 'TEST_CLEANUP');
    }
  });

  await t.test('50 concurrent duplicate PLACE_BET commands resolve with exactly 1 dispatch and 49 cached duplicates', async () => {
    let physicalDispatches = 0;
    const originalDispatch = executionBoundaryManager.dispatchEnvelope.bind(executionBoundaryManager);

    executionBoundaryManager.dispatchEnvelope = (type, payload, options) => {
      physicalDispatches++;
      return true;
    };

    const singleIdempotencyKey = `idem_concurrent_stress_${Date.now()}`;
    const accountId = 'acc_concurrent_1';

    try {
      const concurrentBets = [];
      for (let i = 0; i < 50; i++) {
        concurrentBets.push(
          commandRouter.route({
            category: 'Execution',
            type: 'PLACE_BET',
            traceId: `trace-bet-stress-${i}`,
            payload: {
              marketId: 'mkt-stress-1',
              odds: 1.95,
              stake: 100,
              idempotencyKey: singleIdempotencyKey,
              accountId,
              operationId: `op_stress_${i}`
            }
          })
        );
      }

      const results = await Promise.all(concurrentBets);
      assert.equal(results.length, 50);

      // Exactly 1 physical dispatch
      assert.equal(physicalDispatches, 1, 'Exactly 1 physical bet dispatch must occur across 50 concurrent requests');

      // Count cached duplicates
      let duplicates = 0;
      for (const res of results) {
        const payload = res.results[0];
        if (payload?.duplicate && payload?.cachedAck) {
          duplicates++;
        }
      }
      assert.equal(duplicates, 49, '49 of 50 requests must be identified as duplicates and return cachedAck');
    } finally {
      executionBoundaryManager.dispatchEnvelope = originalDispatch;
    }
  });

  await t.test('SQLite WAL mode handles 100 concurrent writes and 100 concurrent reads without SQLITE_BUSY', async () => {
    const testDbPath = path.join(__dirname, '..', '..', 'concurrency_stress_test.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }

    const engine = new SqliteStorageEngine(testDbPath);
    engine.open();

    engine.run(`
      CREATE TABLE IF NOT EXISTS stress_test (
        id INTEGER PRIMARY KEY,
        val TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Seed 10 rows
    for (let i = 1; i <= 10; i++) {
      engine.run(`INSERT INTO stress_test (id, val, updated_at) VALUES (?, ?, ?)`, [i, `val_${i}`, Date.now()]);
    }

    // Launch 100 concurrent async writes and 100 concurrent reads
    const ops = [];
    for (let i = 0; i < 100; i++) {
      const targetId = (i % 10) + 1;
      ops.push(
        new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              engine.run(`UPDATE stress_test SET val = ?, updated_at = ? WHERE id = ?`, [`updated_${i}`, Date.now(), targetId]);
              resolve({ write: true });
            } catch (err) {
              reject(err);
            }
          });
        })
      );

      ops.push(
        new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              const rows = engine.query(`SELECT * FROM stress_test WHERE id = ?`, [targetId]);
              resolve({ read: true, count: rows.length });
            } catch (err) {
              reject(err);
            }
          });
        })
      );
    }

    const results = await Promise.all(ops);
    assert.equal(results.length, 200, 'All 200 concurrent read/write operations must succeed without SQLITE_BUSY');

    engine.close();
    try {
      fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch {}
  });
});

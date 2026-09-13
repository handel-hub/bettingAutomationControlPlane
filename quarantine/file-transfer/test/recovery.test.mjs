import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RecoveryReconciler } from '../recovery/RecoveryReconciler.mjs';
import { TransfersRepository } from '../database/TransfersRepository.mjs';
import { LocalFileStore } from '../storage/LocalFileStore.mjs';

test('RecoveryReconciler - Startup Recovery Scenarios', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fts-test-recovery-'));
  
  const localFileStore = new LocalFileStore(dataDir);
  await localFileStore.initialize();

  // Create db directory manually for repository
  const fs = await import('fs/promises');
  await fs.mkdir(join(dataDir, 'fts', 'db'), { recursive: true });

  const repo = new TransfersRepository(join(dataDir, 'fts', 'db', 'fts.sqlite3'));
  repo.initialize();

  const queuedTransfers = [];
  const failedTransfers = [];

  const stateMachine = {
    queue: (id) => queuedTransfers.push(id),
    fail: (id, code, msg) => failedTransfers.push({id, code}),
    complete: () => {}
  };

  const reconciler = new RecoveryReconciler(repo, localFileStore, {}, stateMachine, { verifyOnRecovery: false });

  // Seed DB with a RECEIVING transfer
  repo.db.prepare(`
    INSERT INTO transfers (transfer_id, file_id, state, created_at, updated_at)
    VALUES ('t-recv', 'f-recv', 'RECEIVING', datetime('now'), datetime('now'))
  `).run();
  await writeFile(localFileStore.getIncomingPath('t-recv'), 'partial');

  // Seed DB with a QUEUED transfer
  repo.db.prepare(`
    INSERT INTO transfers (transfer_id, file_id, state, created_at, updated_at)
    VALUES ('t-queued', 'f-queued', 'QUEUED', datetime('now'), datetime('now'))
  `).run();
  
  await reconciler.recover();

  assert.strictEqual(failedTransfers.length, 1);
  assert.strictEqual(failedTransfers[0].id, 't-recv');
  assert.strictEqual(failedTransfers[0].code, 'ingestion_interrupted');

  assert.strictEqual(queuedTransfers.length, 1);
  assert.strictEqual(queuedTransfers[0], 't-queued');

  repo.close();
  await rm(dataDir, { recursive: true, force: true });
});

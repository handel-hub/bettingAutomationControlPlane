import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTransferService } from '../index.mjs';
import { Readable } from 'stream';

test('Property/Fuzzing: Random Network Failures', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fts-test-fuzz-'));
  
  const mockBackendClient = {
    initializeTransfer: async () => ({ remoteSessionId: 'sess-' + Math.random(), resumeFromChunkIndex: 0 }),
    uploadChunk: async () => {
      const rand = Math.random();
      if (rand < 0.3) {
        throw new Error('Random network timeout');
      }
      return { acked: true };
    },
    completeTransfer: async ({ contentHash }) => ({ remoteObjectId: 'obj', size: 1000, verifiedHash: contentHash }),
    queryTransferStatus: async () => ({ status: 'uploading', lastAckedChunkIndex: 0 }),
    cancelTransfer: async () => {}
  };

  const fts = new FileTransferService({
    dataDir,
    backendTransferClient: mockBackendClient,
    chunkSize: 100, // 10 chunks per file
    retryPolicy: { hotBaseMs: 1, hotFactor: 1.5, hotMaxMs: 10, hotMaxAttempts: 20 }
  });

  await fts.initialize();
  await fts.start();

  function createStream() {
    return new Readable({
      read() {
        this.push(Buffer.alloc(1000, 'B'));
        this.push(null);
      }
    });
  }

  const numTransfers = 5;
  const promises = [];

  for (let i = 0; i < numTransfers; i++) {
    promises.push(fts.consume(createStream(), { declaredSize: 1000 }));
  }

  await Promise.all(promises);

  let finished = 0;
  const finishPromise = new Promise((resolve) => {
    const checkDone = () => {
      finished++;
      if (finished === numTransfers) resolve();
    };
    fts.on('TransferCompleted', checkDone);
    fts.on('TransferFailed', checkDone);
  });

  await finishPromise;

  const pending = fts.scheduler.transfersRepository.getAllPendingTransfers();
  assert.strictEqual(pending.length, 0, 'No transfers should be left pending');

  await fts.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

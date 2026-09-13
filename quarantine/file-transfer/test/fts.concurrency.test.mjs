import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTransferService } from '../index.mjs';
import { Readable } from 'stream';

test('Concurrency and Backpressure Load Test', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fts-test-concurrency-'));
  
  const mockBackendClient = {
    initializeTransfer: async () => ({ remoteSessionId: 'sess-' + Math.random(), resumeFromChunkIndex: 0 }),
    uploadChunk: async () => {
      await new Promise(r => setTimeout(r, 10)); // simulated latency
      return { acked: true };
    },
    completeTransfer: async ({ contentHash }) => ({ remoteObjectId: 'obj', size: 10 * 1024 * 1024, verifiedHash: contentHash }),
    queryTransferStatus: async () => ({ status: 'uploading', lastAckedChunkIndex: 0 }),
    cancelTransfer: async () => {}
  };

  const fts = new FileTransferService({
    dataDir,
    backendTransferClient: mockBackendClient,
    chunkSize: 2 * 1024 * 1024, // 2MB chunks
    maxConcurrentTransfers: 3,
    maxConcurrentChunkUploads: 2
  });

  await fts.initialize();
  await fts.start();

  const numStreams = 5;
  const streamSize = 10 * 1024 * 1024; // 10MB per stream (50MB total)

  function createDummyStream(size) {
    let bytesSent = 0;
    return new Readable({
      read(sizeToRead) {
        if (bytesSent >= size) {
          this.push(null);
          return;
        }
        const chunk = Buffer.alloc(Math.min(sizeToRead, size - bytesSent), 'A');
        bytesSent += chunk.length;
        this.push(chunk);
      }
    });
  }

  const transferPromises = [];
  for (let i = 0; i < numStreams; i++) {
    transferPromises.push(
      fts.consume(createDummyStream(streamSize), { declaredSize: streamSize })
    );
  }

  const results = await Promise.all(transferPromises);
  assert.strictEqual(results.length, numStreams);

  let completed = 0;
  const completionPromise = new Promise((resolve) => {
    fts.on('TransferCompleted', () => {
      completed++;
      if (completed === numStreams) resolve();
    });
  });

  await completionPromise;
  
  await fts.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

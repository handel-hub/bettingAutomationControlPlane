import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTransferService } from '../index.mjs';
import { Readable } from 'stream';

test('FileTransferService Full Lifecycle', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fts-test-'));
  
  const mockBackendClient = {
    initializeTransfer: async () => {
      return { remoteSessionId: 'sess-123', resumeFromChunkIndex: 0 };
    },
    uploadChunk: async () => {
      return { acked: true };
    },
    completeTransfer: async ({ contentHash }) => {
      return { remoteObjectId: 'obj-456', size: 12, verifiedHash: contentHash };
    },
    queryTransferStatus: async () => {
      return { status: 'uploading', lastAckedChunkIndex: 0 };
    },
    cancelTransfer: async () => {}
  };

  const fts = new FileTransferService({
    dataDir,
    backendTransferClient: mockBackendClient,
    chunkSize: 4 // small chunk size for testing
  });

  await fts.initialize();
  await fts.start();

  async function* generateData() {
    yield Buffer.from('hello ');
    yield Buffer.from('world!');
  }
  
  const source = Readable.from(generateData());

  let acceptedEmitted = false;
  let completedEmitted = false;

  fts.on('TransferAccepted', () => { acceptedEmitted = true; });
  
  const completionPromise = new Promise((resolve) => {
    fts.on('TransferCompleted', (data) => {
      completedEmitted = true;
      resolve(data);
    });
  });

  const consumeResult = await fts.consume(source, { declaredSize: 12, originalFilename: 'test.txt', mimeType: 'text/plain' });
  
  assert.strictEqual(acceptedEmitted, true);
  assert.strictEqual(consumeResult.size, 12);
  
  const completionData = await completionPromise;
  
  assert.strictEqual(completedEmitted, true);
  assert.strictEqual(completionData.transferId, consumeResult.transferId);
  assert.strictEqual(completionData.remoteObjectId, 'obj-456');

  await fts.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

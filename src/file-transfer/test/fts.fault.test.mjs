import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTransferService } from '../index.mjs';
import { Readable } from 'stream';

test('Fault Injection: Hash Mismatch on Completion', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fts-test-fault-'));
  
  const mockBackendClient = {
    initializeTransfer: async () => ({ remoteSessionId: 'sess-123', resumeFromChunkIndex: 0 }),
    uploadChunk: async () => ({ acked: true }),
    completeTransfer: async () => ({ remoteObjectId: 'obj-456', size: 12, verifiedHash: 'BADHASH' }),
    queryTransferStatus: async () => ({ status: 'uploading', lastAckedChunkIndex: 0 }),
    cancelTransfer: async () => {}
  };

  const fts = new FileTransferService({ dataDir, backendTransferClient: mockBackendClient });
  await fts.initialize();
  await fts.start();

  async function* generateData() {
    yield Buffer.from('hello ');
  }
  
  const completionPromise = new Promise((resolve) => {
    fts.on('TransferFailed', (data) => resolve(data));
  });

  await fts.consume(Readable.from(generateData()), { declaredSize: 6, mimeType: 'text/plain' });
  
  const failData = await completionPromise;
  assert.strictEqual(failData.errorCode, 'hash_mismatch');
  assert.strictEqual(failData.retryable, false);

  await fts.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTransferService } from '../index.mjs';
import { Readable } from 'stream';
import fs from 'fs';

test('Hardware Fault: ENOSPC during Ingestion', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'fts-test-enospc-'));
  
  const fts = new FileTransferService({
    dataDir,
    backendTransferClient: {} // irrelevant
  });

  await fts.initialize();
  await fts.start();

  const originalGetIncomingPath = fts.localFileStore.getIncomingPath;
  fts.localFileStore.getIncomingPath = () => {
    // Return an invalid path that will cause createWriteStream to fail
    return join(dataDir, 'invalid_dir_does_not_exist', 'test.part');
  };

  const stream = new Readable({
    read() {
      this.push(Buffer.alloc(100, 'X'));
      this.push(null);
    }
  });

  try {
    await fts.consume(stream, { declaredSize: 100 });
    assert.fail('Should have thrown an I/O error');
  } catch (err) {
    assert.strictEqual(err.code, 'ENOENT', 'Expected an ENOENT error due to invalid path');
  }

  // Restore the monkeypatch
  fts.localFileStore.getIncomingPath = originalGetIncomingPath;

  await fts.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

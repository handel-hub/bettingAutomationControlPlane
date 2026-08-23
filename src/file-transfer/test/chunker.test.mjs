import test from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Chunker } from '../worker/Chunker.mjs';

test('Chunker byte-range and hashing correctness', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chunker-test-'));
  const filePath = join(dir, 'test.bin');
  
  // 15 bytes of data
  const data = Buffer.from('ABCDEFGHIJKLMNOP'); // 16 bytes
  await writeFile(filePath, data);
  
  // Read first 6 bytes
  const chunk1 = await Chunker.readAndHashChunk(filePath, 0, 6);
  assert.strictEqual(chunk1.chunkSize, 6);
  assert.strictEqual(chunk1.data.toString(), 'ABCDEF');
  
  // Read next 6 bytes
  const chunk2 = await Chunker.readAndHashChunk(filePath, 6, 6);
  assert.strictEqual(chunk2.chunkSize, 6);
  assert.strictEqual(chunk2.data.toString(), 'GHIJKL');

  // Read final 4 bytes (remainder)
  const chunk3 = await Chunker.readAndHashChunk(filePath, 12, 6);
  assert.strictEqual(chunk3.chunkSize, 4);
  assert.strictEqual(chunk3.data.toString(), 'MNOP');

  await rm(dir, { recursive: true, force: true });
});

import { createReadStream } from 'fs';
import { RollingHasher } from '../ingestion/RollingHasher.mjs';

export class Chunker {
  static async readAndHashChunk(filePath, offset, size) {
    return new Promise((resolve, reject) => {
      const hasher = new RollingHasher();
      const stream = createReadStream(filePath, { start: offset, end: offset + size - 1 });
      const chunks = [];
      let totalLength = 0;
      
      stream.on('data', (chunk) => {
        hasher.write(chunk);
        chunks.push(chunk);
        totalLength += chunk.length;
      });
      
      stream.on('end', () => {
        hasher.end();
        resolve({
          data: Buffer.concat(chunks, totalLength),
          chunkHash: hasher.getDigest(),
          chunkSize: totalLength
        });
      });
      
      stream.on('error', reject);
      hasher.on('error', reject);
    });
  }
}

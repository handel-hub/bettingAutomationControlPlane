import { Transform } from 'stream';
import crypto from 'crypto';

export class RollingHasher extends Transform {
  constructor(options = {}) {
    super(options);
    this.hashAlgorithm = options.hashAlgorithm || 'sha256';
    this.hasher = crypto.createHash(this.hashAlgorithm);
    this.byteCount = 0;
  }

  _transform(chunk, encoding, callback) {
    this.hasher.update(chunk);
    this.byteCount += chunk.length;
    this.push(chunk);
    callback();
  }

  getDigest(encoding = 'hex') {
    return this.hasher.digest(encoding);
  }

  getByteCount() {
    return this.byteCount;
  }
}

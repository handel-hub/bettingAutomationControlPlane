import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';

export class LocalFileStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.incomingDir = join(dataDir, 'fts', 'storage', 'incoming');
    this.finalizedDir = join(dataDir, 'fts', 'storage', 'finalized');
    this.quarantineDir = join(dataDir, 'fts', 'storage', 'quarantine');
  }

  async initialize() {
    await mkdir(this.incomingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.finalizedDir, { recursive: true, mode: 0o700 });
    await mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });

    // Cross-volume check to ensure rename is actually atomic
    const testIncoming = join(this.incomingDir, '.exdev-check-incoming');
    const testFinalized = join(this.finalizedDir, '.exdev-check-finalized');
    
    try {
      await writeFile(testIncoming, 'test');
      await rename(testIncoming, testFinalized);
      await rm(testFinalized, { force: true });
    } catch (err) {
      if (err.code === 'EXDEV') {
        throw new Error('FTS initialization failed: incoming and finalized directories span multiple devices. Atomic renames are impossible.');
      }
      throw err;
    }
  }

  getIncomingPath(transferId) {
    return join(this.incomingDir, `${transferId}.part`);
  }

  getFinalizedPath(fileId) {
    const shard = fileId.substring(0, 2);
    return join(this.finalizedDir, shard, fileId);
  }

  async finalize(transferId, fileId) {
    const incomingPath = this.getIncomingPath(transferId);
    const finalizedPath = this.getFinalizedPath(fileId);
    const shardDir = join(this.finalizedDir, fileId.substring(0, 2));

    await mkdir(shardDir, { recursive: true, mode: 0o700 });
    await rename(incomingPath, finalizedPath);
    return finalizedPath;
  }

  async cleanupIncoming(transferId) {
    const incomingPath = this.getIncomingPath(transferId);
    try {
      await rm(incomingPath, { force: true });
    } catch (err) {
      // Ignore errors if file doesn't exist
    }
  }
  
  async deleteFinalized(fileId) {
    const finalizedPath = this.getFinalizedPath(fileId);
    try {
      await rm(finalizedPath, { force: true });
    } catch (err) {
      // Ignore errors if file doesn't exist
    }
  }

  async quarantine(fileId, sourcePath) {
    const targetPath = join(this.quarantineDir, fileId);
    try {
      await rename(sourcePath, targetPath);
    } catch (err) {
      // Best effort
    }
  }
  
  async getFileSize(filePath) {
    const fileStat = await stat(filePath);
    return fileStat.size;
  }
}

import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { ulid } from 'ulid';
import { RollingHasher } from './RollingHasher.mjs';

export class IngestionPipeline {
  constructor(localFileStore, transfersRepository, diskSpaceGuard, eventBus) {
    this.localFileStore = localFileStore;
    this.transfersRepository = transfersRepository;
    this.diskSpaceGuard = diskSpaceGuard;
    this.eventBus = eventBus;
  }

  async ingest(sourceStream, metadata) {
    const { declaredSize, originalFilename, mimeType } = metadata;
    
    // 1 & 2. Validate metadata & check disk space
    this.diskSpaceGuard.check(declaredSize);
    
    // 3. Allocate IDs
    const transferId = ulid();
    const fileId = transferId;
    
    const transferRecord = {
      transferId,
      fileId,
      originalFilename,
      mimeType,
      declaredSize
    };

    // 4. INSERT transfers(state='RECEIVING')
    this.transfersRepository.insertTransfer(transferRecord);
    
    const incomingPath = this.localFileStore.getIncomingPath(transferId);
    
    const hasher = new RollingHasher();
    const writeStream = createWriteStream(incomingPath);
    
    try {
      // 5 & 6. Pipe source -> hasher -> file
      await pipeline(sourceStream, hasher, writeStream);
    } catch (err) {
      // 7. On error: abort, delete temp file, FAILED
      await this.localFileStore.cleanupIncoming(transferId);
      this.transfersRepository.failTransfer(transferId, 'ingestion_stream_error');
      throw err;
    }
    
    // 8 & 9. Finalize hash digest
    const digest = hasher.getDigest();
    const actualSize = hasher.getByteCount();

    // Enforce actual vs max file size check post-ingestion
    if (actualSize > this.diskSpaceGuard.maxFileSize) {
      await this.localFileStore.cleanupIncoming(transferId);
      this.transfersRepository.failTransfer(transferId, 'file_too_large');
      throw new Error(`StorageError: Actual size ${actualSize} exceeds maximum allowed size`);
    }

    try {
      // 10. Atomic rename
      const finalizedPath = await this.localFileStore.finalize(transferId, fileId);
      
      // 11. DB commit
      this.transfersRepository.finalizeTransfer(transferId, finalizedPath, actualSize, digest);
      
      const result = {
        transferId,
        fileId,
        size: actualSize,
        contentHash: digest
      };

      this.eventBus.emitTransferEvent('TransferAccepted', result);

      // 12. Resolve
      return result;
    } catch (err) {
      // 3f. finalize rename or fsync fails
      await this.localFileStore.cleanupIncoming(transferId);
      this.transfersRepository.failTransfer(transferId, 'finalize_failed');
      throw err;
    }
  }
}

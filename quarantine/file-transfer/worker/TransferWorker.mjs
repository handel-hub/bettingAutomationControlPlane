import { Chunker } from './Chunker.mjs';

export class TransferWorker {
  constructor(stateMachine, transfersRepository, localFileStore, backendClient, eventBus, config) {
    this.stateMachine = stateMachine;
    this.transfersRepository = transfersRepository;
    this.localFileStore = localFileStore;
    this.backendClient = backendClient;
    this.eventBus = eventBus;
    this.config = config;
  }

  async processTransfer(transferId) {
    const transfer = this.transfersRepository.getTransferRecord(transferId);
    if (!transfer || transfer.cancel_requested) return;

    let remoteSessionId = transfer.remote_session_id;

    if (!remoteSessionId) {
      try {
        const initResult = await this.backendClient.initializeTransfer({
          transferId: transfer.transfer_id,
          fileId: transfer.file_id,
          totalSize: transfer.actual_size,
          totalChunks: Math.ceil(transfer.actual_size / this.config.chunkSize),
          chunkSize: this.config.chunkSize,
          contentHash: transfer.content_hash,
          hashAlgorithm: transfer.hash_algorithm,
          metadata: {
            originalFilename: transfer.original_filename,
            mimeType: transfer.mime_type
          }
        });
        remoteSessionId = initResult.remoteSessionId;
      } catch (err) {
        this.stateMachine.fail(transferId, 'init_error', err.message);
        return;
      }
    }

    this.stateMachine.startUpload(transferId, remoteSessionId, transfer.actual_size);
    
    let pendingChunks = this.transfersRepository.getPendingChunks(transferId);
    const finalizedPath = this.localFileStore.getFinalizedPath(transfer.file_id);
    
    const maxConcurrent = this.config.maxConcurrentChunkUploads;
    const activePromises = new Set();
    
    let transferFailedOrPaused = false;
    
    for (const chunkRecord of pendingChunks) {
      if (transferFailedOrPaused) break;
      
      const tId = this.transfersRepository.getTransferRecord(transferId);
      if (tId.cancel_requested) {
        break;
      }

      const chunkPromise = this.uploadChunkWithRetry(transfer, chunkRecord, finalizedPath, remoteSessionId);
      activePromises.add(chunkPromise);
      
      chunkPromise.finally(() => {
        activePromises.delete(chunkPromise);
      });
      
      if (activePromises.size >= maxConcurrent) {
        const result = await Promise.race(activePromises);
        if (result === 'PAUSED' || result === 'RETRY_WAIT' || result === 'FAILED') {
          transferFailedOrPaused = true;
        }
      }
    }
    
    const results = await Promise.all(activePromises);
    if (results.some(r => r === 'PAUSED' || r === 'RETRY_WAIT' || r === 'FAILED')) {
      transferFailedOrPaused = true;
    }
    
    if (!transferFailedOrPaused && !this.transfersRepository.getTransferRecord(transferId).cancel_requested) {
      const checkPending = this.transfersRepository.getPendingChunks(transferId);
      if (checkPending.length === 0) {
        this.stateMachine.startVerifying(transferId);
        
        try {
          const completeResult = await this.backendClient.completeTransfer({
            remoteSessionId,
            transferId,
            contentHash: transfer.content_hash
          });
          
          if (completeResult.verifiedHash === transfer.content_hash) {
            this.stateMachine.complete(
              transferId, 
              transfer.file_id, 
              completeResult.remoteObjectId, 
              transfer.actual_size, 
              transfer.content_hash
            );
          } else {
            this.stateMachine.fail(transferId, 'hash_mismatch', 'Backend reported hash mismatch');
          }
        } catch (error) {
          this.stateMachine.fail(transferId, 'complete_error', error.message);
        }
      }
    }
  }

  async uploadChunkWithRetry(transfer, chunkRecord, filePath, remoteSessionId) {
    const actualSize = transfer.actual_size;
    const chunkOffset = chunkRecord.chunk_offset;
    let readSize = chunkRecord.chunk_size;
    
    if (chunkOffset + readSize > actualSize) {
      readSize = actualSize - chunkOffset;
    }

    const { data, chunkHash, chunkSize } = await Chunker.readAndHashChunk(filePath, chunkOffset, readSize);
    
    this.transfersRepository.updateChunkState(transfer.transfer_id, chunkRecord.chunk_index, 'UPLOADING', chunkHash);
    
    try {
      const result = await this.backendClient.uploadChunk({
        remoteSessionId,
        transferId: transfer.transfer_id,
        chunkIndex: chunkRecord.chunk_index,
        chunkOffset,
        chunkSize,
        chunkHash,
        hashAlgorithm: transfer.hash_algorithm,
        data
      });
      
      if (result.acked) {
        this.stateMachine.chunkAcked(transfer.transfer_id, chunkRecord.chunk_index);
        this.eventBus.emitTransferEvent('TransferProgress', {
          transferId: transfer.transfer_id,
          chunkIndex: chunkRecord.chunk_index,
          bytesTransferred: chunkOffset + chunkSize,
          totalBytes: actualSize
        });
        return 'ACKED';
      }
      throw new Error('Chunk rejected without explicit error');
    } catch (error) {
      const attempt = chunkRecord.attempts + 1;
      const state = this.stateMachine.chunkFailedRetryable(
        transfer.transfer_id, 
        chunkRecord.chunk_index, 
        attempt, 
        this.config.retryPolicy.hotMaxAttempts,
        error
      );
      return state;
    }
  }
}

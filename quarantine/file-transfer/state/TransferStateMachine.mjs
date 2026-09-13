export class TransferStateMachine {
  constructor(transfersRepository, eventBus, config) {
    this.transfersRepository = transfersRepository;
    this.eventBus = eventBus;
    this.config = config;
  }
  
  queue(transferId) {
    this.transfersRepository.queueTransfer(transferId);
    this.eventBus.emitTransferEvent('TransferQueued', { transferId });
  }

  startUpload(transferId, remoteSessionId, actualSize) {
    const chunkSize = this.config.chunkSize;
    const totalChunks = Math.ceil(actualSize / chunkSize);
    
    const started = this.transfersRepository.startUpload(transferId, chunkSize, totalChunks, remoteSessionId);
    if (started && !remoteSessionId) {
      this.eventBus.emitTransferEvent('TransferStarted', { transferId });
    }
  }

  chunkAcked(transferId, chunkIndex) {
    this.transfersRepository.updateChunkState(transferId, chunkIndex, 'ACKED', null);
  }
  
  chunkFailedRetryable(transferId, chunkIndex, attempt, maxHotAttempts, error) {
    if (attempt >= maxHotAttempts) {
      this.transfersRepository.markPaused(transferId, error.message);
      this.eventBus.emitTransferEvent('TransferPaused', { transferId, pausedReason: error.message, attempts: attempt });
      return 'PAUSED';
    } else {
      const nextRetryMs = Math.min(
        this.config.retryPolicy.hotBaseMs * Math.pow(this.config.retryPolicy.hotFactor, attempt),
        this.config.retryPolicy.hotMaxMs
      );
      const nextRetryAt = new Date(Date.now() + nextRetryMs).toISOString();
      
      this.transfersRepository.updateChunkState(transferId, chunkIndex, 'PENDING', null, error.message);
      this.transfersRepository.markRetrying(transferId, nextRetryAt);
      
      this.eventBus.emitTransferEvent('TransferRetrying', { 
        transferId, chunkIndex, attempt, nextRetryAt, reason: error.message 
      });
      return 'RETRY_WAIT';
    }
  }
  
  startVerifying(transferId) {
    this.transfersRepository.markVerifying(transferId);
  }
  
  complete(transferId, fileId, remoteObjectId, size, contentHash) {
    this.transfersRepository.markCompleted(transferId, remoteObjectId);
    this.eventBus.emitTransferEvent('TransferCompleted', {
      transferId, fileId, remoteObjectId, size, contentHash
    });
  }

  fail(transferId, errorCode, errorDetail) {
    this.transfersRepository.failTransfer(transferId, errorCode);
    this.eventBus.emitTransferEvent('TransferFailed', {
      transferId, retryable: false, errorCode, errorDetail
    });
  }
}

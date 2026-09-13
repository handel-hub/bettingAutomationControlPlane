export class TransferScheduler {
  constructor(transfersRepository, transferWorker, stateMachine, config) {
    this.transfersRepository = transfersRepository;
    this.transferWorker = transferWorker;
    this.stateMachine = stateMachine;
    this.config = config;
    
    this.activeTransfers = new Set();
    this.isShuttingDown = false;
    this.timer = null;
  }
  
  start() {
    this.tick();
  }

  stop() {
    this.isShuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  async tick() {
    if (this.isShuttingDown) return;
    
    try {
      this.admitTransfers();
      this.checkColdRetries();
    } finally {
      if (!this.isShuttingDown) {
        this.timer = setTimeout(() => this.tick(), 5000);
      }
    }
  }

  admitTransfers() {
    if (this.activeTransfers.size >= this.config.maxConcurrentTransfers) {
      return;
    }
    
    const pending = this.transfersRepository.getAllPendingTransfers();
    for (const transfer of pending) {
      if (transfer.state === 'LOCAL_READY') {
        this.stateMachine.queue(transfer.transfer_id);
      }
    }
    
    const readyToUpload = pending.filter(t => 
      !this.activeTransfers.has(t.transfer_id) && 
      (t.state === 'QUEUED' || (t.state === 'RETRY_WAIT' && new Date(t.next_retry_at) <= new Date()))
    );
    
    for (const transfer of readyToUpload) {
      if (this.activeTransfers.size >= this.config.maxConcurrentTransfers) {
        break;
      }
      
      this.activeTransfers.add(transfer.transfer_id);
      
      this.transferWorker.processTransfer(transfer.transfer_id)
        .catch(err => console.error(`Worker failed for ${transfer.transfer_id}`, err))
        .finally(() => {
          this.activeTransfers.delete(transfer.transfer_id);
          if (!this.isShuttingDown) {
            this.admitTransfers();
          }
        });
    }
  }

  checkColdRetries() {
    const allPaused = this.transfersRepository.db.prepare(`
      SELECT * FROM transfers WHERE state = 'PAUSED'
    `).all();
    
    const now = Date.now();
    for (const p of allPaused) {
      const pausedTime = new Date(p.updated_at).getTime();
      if (now - pausedTime > this.config.retryPolicy.coldMaxDurationMs) {
        this.stateMachine.fail(p.transfer_id, 'cold_retry_exhausted', 'Cold retry budget exhausted');
      } else if (now - pausedTime > this.config.retryPolicy.coldIntervalMs) {
        this.stateMachine.queue(p.transfer_id); 
      }
    }
  }
}

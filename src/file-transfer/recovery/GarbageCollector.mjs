export class GarbageCollector {
  constructor(transfersRepository, localFileStore, config) {
    this.transfersRepository = transfersRepository;
    this.localFileStore = localFileStore;
    this.config = config;
    this.timer = null;
    this.isShuttingDown = false;
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
      await this.cleanupExpiredTransfers();
    } catch (err) {
      console.error('GarbageCollector error:', err);
    } finally {
      if (!this.isShuttingDown) {
        // Run once per hour
        this.timer = setTimeout(() => this.tick(), 60 * 60 * 1000);
      }
    }
  }

  async cleanupExpiredTransfers() {
    const retentionMs = this.config.cleanupPolicy.retentionMs;
    const cutoffTime = new Date(Date.now() - retentionMs).toISOString();
    
    // Find transfers that reached terminal state before cutoffTime
    const expired = this.transfersRepository.db.prepare(`
      SELECT * FROM transfers 
      WHERE state IN ('COMPLETED', 'FAILED', 'CANCELLED') 
      AND updated_at < ?
    `).all(cutoffTime);

    for (const t of expired) {
      if (t.state === 'COMPLETED' || t.state === 'FAILED' || t.state === 'CANCELLED') {
        // Only delete file, keep DB record for audit if needed, or delete DB record. 
        // Spec suggests "Garbage-collect completed files".
        if (t.local_path) {
           await this.localFileStore.deleteFinalized(t.file_id);
        }
        
        // Optionally delete the DB record to save space
        this.transfersRepository.db.prepare(`
          DELETE FROM transfers WHERE transfer_id = ?
        `).run(t.transfer_id);
      }
    }
  }
}

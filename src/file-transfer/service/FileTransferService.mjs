import { join } from 'path';
import { mergeConfig } from './config.mjs';
import { EventBus } from '../events/EventBus.mjs';
import { LocalFileStore } from '../storage/LocalFileStore.mjs';
import { TransfersRepository } from '../database/TransfersRepository.mjs';
import { DiskSpaceGuard } from '../ingestion/DiskSpaceGuard.mjs';
import { IngestionPipeline } from '../ingestion/IngestionPipeline.mjs';
import { HttpRequestAdapter } from '../adapters/HttpRequestAdapter.mjs';
import { TransferStateMachine } from '../state/TransferStateMachine.mjs';
import { TransferWorker } from '../worker/TransferWorker.mjs';
import { TransferScheduler } from '../worker/TransferScheduler.mjs';
import { RecoveryReconciler } from '../recovery/RecoveryReconciler.mjs';
import { GarbageCollector } from '../recovery/GarbageCollector.mjs';

export class FileTransferService {
  constructor(userConfig) {
    this.config = mergeConfig(userConfig);
    this.eventBus = new EventBus();
    
    this.localFileStore = new LocalFileStore(this.config.dataDir);
    this.transfersRepository = new TransfersRepository(join(this.config.dataDir, 'fts', 'db', 'fts.sqlite3'));
    
    this.diskSpaceGuard = new DiskSpaceGuard(this.config.maxFileSize);
    
    this.ingestionPipeline = new IngestionPipeline(
      this.localFileStore, 
      this.transfersRepository, 
      this.diskSpaceGuard, 
      this.eventBus
    );
    
    this.httpRequestAdapter = new HttpRequestAdapter(this.ingestionPipeline);
    
    this.stateMachine = new TransferStateMachine(
      this.transfersRepository, 
      this.eventBus, 
      this.config
    );
    
    this.transferWorker = new TransferWorker(
      this.stateMachine,
      this.transfersRepository,
      this.localFileStore,
      this.config.backendTransferClient,
      this.eventBus,
      this.config
    );
    
    this.scheduler = new TransferScheduler(
      this.transfersRepository,
      this.transferWorker,
      this.stateMachine,
      this.config
    );
    
    this.recoveryReconciler = new RecoveryReconciler(
      this.transfersRepository,
      this.localFileStore,
      this.config.backendTransferClient,
      this.stateMachine,
      this.config
    );

    this.garbageCollector = new GarbageCollector(
      this.transfersRepository,
      this.localFileStore,
      this.config
    );
  }

  async initialize() {
    await this.localFileStore.initialize();
    
    const fs = await import('fs/promises');
    await fs.mkdir(join(this.config.dataDir, 'fts', 'db'), { recursive: true, mode: 0o700 });
    
    this.transfersRepository.initialize();
  }

  async start() {
    await this.recoveryReconciler.recover();
    this.scheduler.start();
    this.garbageCollector.start();
  }

  async stop() {
    this.scheduler.stop();
    this.garbageCollector.stop();
  }

  async shutdown() {
    await this.stop();
    this.transfersRepository.close();
  }

  async consume(sourceStream, metadata) {
    return this.ingestionPipeline.ingest(sourceStream, metadata);
  }

  async consumeHttpRequest(req) {
    return this.httpRequestAdapter.consumeHttpRequest(req);
  }

  async cancel(transferId) {
    this.transfersRepository.db.prepare(`
      UPDATE transfers SET cancel_requested = 1 WHERE transfer_id = ?
    `).run(transferId);
    
    const info = this.transfersRepository.db.prepare(`
      UPDATE transfers SET state = 'CANCELLED', cancelled_at = datetime('now') 
      WHERE transfer_id = ? AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
    `).run(transferId);
    
    if (info.changes > 0) {
      this.eventBus.emitTransferEvent('TransferCancelled', { transferId, reason: 'User requested cancel' });
      
      const record = this.transfersRepository.getTransferRecord(transferId);
      if (record && record.remote_session_id) {
        this.config.backendTransferClient.cancelTransfer({
          remoteSessionId: record.remote_session_id,
          transferId
        }).catch(err => console.error('Failed to notify backend of cancellation', err));
      }
    }
  }

  async resume(transferId) {
    this.transfersRepository.db.prepare(`
      UPDATE transfers SET state = 'QUEUED', updated_at = datetime('now')
      WHERE transfer_id = ? AND state = 'PAUSED'
    `).run(transferId);
  }

  async getStatus(transferId) {
    return this.transfersRepository.getTransferRecord(transferId);
  }

  on(event, handler) {
    this.eventBus.on(event, handler);
  }
}

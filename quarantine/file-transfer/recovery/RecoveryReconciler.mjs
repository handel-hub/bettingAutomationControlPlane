import { stat, readdir } from 'fs/promises';
import { join } from 'path';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { RollingHasher } from '../ingestion/RollingHasher.mjs';

export class RecoveryReconciler {
  constructor(transfersRepository, localFileStore, backendClient, stateMachine, config) {
    this.transfersRepository = transfersRepository;
    this.localFileStore = localFileStore;
    this.backendClient = backendClient;
    this.stateMachine = stateMachine;
    this.config = config;
  }
  
  async recover() {
    const nonTerminalStates = ['RECEIVING', 'LOCAL_READY', 'QUEUED', 'UPLOADING', 'RETRY_WAIT', 'VERIFYING'];
    const placeholders = nonTerminalStates.map(() => '?').join(',');
    
    const transfers = this.transfersRepository.db.prepare(`
      SELECT * FROM transfers WHERE state IN (${placeholders})
    `).all(...nonTerminalStates);

    for (const t of transfers) {
      try {
        await this.recoverTransfer(t);
      } catch (err) {
        console.error(`Recovery failed for transfer ${t.transfer_id}`, err);
      }
    }

    // Orphan sweep
    await this.sweepOrphans();
  }

  async recoverTransfer(t) {
    switch (t.state) {
      case 'RECEIVING': {
        // Simple recovery: if it was receiving, we just fail it as we cannot resume an ingestion stream safely
        await this.localFileStore.cleanupIncoming(t.transfer_id);
        this.stateMachine.fail(t.transfer_id, 'ingestion_interrupted', 'Interrupted during receiving');
        break;
      }
      case 'LOCAL_READY':
      case 'QUEUED':
        if (this.config.verifyOnRecovery) {
          const verified = await this.verifyFileHash(t);
          if (!verified) {
             this.stateMachine.fail(t.transfer_id, 'corruption_detected', 'Hash verification failed on recovery');
             await this.localFileStore.quarantine(t.file_id, this.localFileStore.getFinalizedPath(t.file_id));
             break;
          }
        }
        this.stateMachine.queue(t.transfer_id);
        break;
      case 'UPLOADING':
      case 'RETRY_WAIT':
        if (t.remote_session_id) {
          try {
            const status = await this.backendClient.queryTransferStatus({
              remoteSessionId: t.remote_session_id,
              transferId: t.transfer_id
            });
            if (status.lastAckedChunkIndex !== undefined) {
               for (let i = 0; i <= status.lastAckedChunkIndex; i++) {
                 this.transfersRepository.updateChunkState(t.transfer_id, i, 'ACKED', null);
               }
            }
          } catch(err) {
            console.error(`Status query failed for ${t.transfer_id}`, err);
          }
        }
        this.stateMachine.queue(t.transfer_id);
        break;
      case 'VERIFYING':
        try {
          const completeResult = await this.backendClient.completeTransfer({
            remoteSessionId: t.remote_session_id,
            transferId: t.transfer_id,
            contentHash: t.content_hash
          });
          
          if (completeResult.verifiedHash === t.content_hash) {
            this.stateMachine.complete(
              t.transfer_id, 
              t.file_id, 
              completeResult.remoteObjectId, 
              t.actual_size, 
              t.content_hash
            );
          } else {
            this.stateMachine.fail(t.transfer_id, 'hash_mismatch', 'Backend reported hash mismatch');
          }
        } catch(err) {
          console.error(`Verify recovery failed for ${t.transfer_id}`, err);
        }
        break;
    }
  }

  async verifyFileHash(t) {
    try {
      const finalizedPath = this.localFileStore.getFinalizedPath(t.file_id);
      const hasher = new RollingHasher({ hashAlgorithm: t.hash_algorithm });
      const readStream = createReadStream(finalizedPath);
      await pipeline(readStream, hasher);
      return hasher.getDigest() === t.content_hash;
    } catch(e) {
      return false;
    }
  }

  async sweepOrphans() {
    try {
      const incomingDir = this.localFileStore.incomingDir;
      const files = await readdir(incomingDir);
      
      for (const file of files) {
        if (file.endsWith('.part')) {
          const transferId = file.replace('.part', '');
          const record = this.transfersRepository.getTransferRecord(transferId);
          
          // If no record exists, or it's terminal/past receiving, it shouldn't be in incoming/
          if (!record || record.state !== 'RECEIVING') {
            const sourcePath = join(incomingDir, file);
            await this.localFileStore.quarantine(`orphan_${file}`, sourcePath);
          }
        }
      }
    } catch(e) {
      console.error('Failed to sweep orphans', e);
    }
  }
}

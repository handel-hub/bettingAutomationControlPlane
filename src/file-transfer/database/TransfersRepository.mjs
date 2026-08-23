import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class TransfersRepository {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  initialize() {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    
    const hasMigrationsTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    
    if (!hasMigrationsTable) {
      const initSql = readFileSync(join(__dirname, 'schema', '001_init.sql'), 'utf8');
      this.db.exec(initSql);
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))").run(1);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }

  insertTransfer(transfer) {
    const stmt = this.db.prepare(`
      INSERT INTO transfers (
        transfer_id, file_id, original_filename, mime_type, declared_size, 
        state, created_at, updated_at
      ) VALUES (
        @transfer_id, @file_id, @original_filename, @mime_type, @declared_size, 
        @state, @created_at, @updated_at
      )
    `);
    const now = new Date().toISOString();
    stmt.run({
      transfer_id: transfer.transferId,
      file_id: transfer.fileId,
      original_filename: transfer.originalFilename || null,
      mime_type: transfer.mimeType || null,
      declared_size: transfer.declaredSize || null,
      state: 'RECEIVING',
      created_at: now,
      updated_at: now
    });
  }

  finalizeTransfer(transferId, localPath, actualSize, contentHash) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'LOCAL_READY', 
        local_path = @local_path, 
        actual_size = @actual_size, 
        content_hash = @content_hash, 
        local_ready_at = @local_ready_at,
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id AND state = 'RECEIVING'
    `);
    
    const now = new Date().toISOString();
    const info = stmt.run({
      local_path: localPath,
      actual_size: actualSize,
      content_hash: contentHash,
      local_ready_at: now,
      updated_at: now,
      transfer_id: transferId
    });
    
    if (info.changes === 0) {
      throw new Error(`Failed to finalize transfer ${transferId}. Not in RECEIVING state or not found.`);
    }
  }

  failTransfer(transferId, errorCode) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'FAILED', 
        error_code = @error_code,
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id
    `);
    stmt.run({
      error_code: errorCode,
      updated_at: new Date().toISOString(),
      transfer_id: transferId
    });
  }

  queueTransfer(transferId) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'QUEUED', 
        queued_at = @queued_at,
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id AND state IN ('LOCAL_READY', 'PAUSED')
    `);
    const now = new Date().toISOString();
    stmt.run({
      queued_at: now,
      updated_at: now,
      transfer_id: transferId
    });
  }

  getTransfer(transferId) {
    return this.db.prepare(`SELECT * FROM transfers WHERE transfer_id = ?`).get(transferId);
  }

  startUpload(transferId, chunkSize, totalChunks, remoteSessionId) {
    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString();
      const info = this.db.prepare(`
        UPDATE transfers SET 
          state = 'UPLOADING', 
          chunk_size = @chunk_size,
          total_chunks = @total_chunks,
          remote_session_id = COALESCE(@remote_session_id, remote_session_id),
          upload_started_at = COALESCE(upload_started_at, @upload_started_at),
          updated_at = @updated_at
        WHERE transfer_id = @transfer_id AND state IN ('QUEUED', 'RETRY_WAIT')
      `).run({
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        remote_session_id: remoteSessionId,
        upload_started_at: now,
        updated_at: now,
        transfer_id: transferId
      });

      if (info.changes === 0) return false;

      // Only insert chunks if they don't exist
      const existingChunks = this.db.prepare(`SELECT COUNT(*) as count FROM chunks WHERE transfer_id = ?`).get(transferId);
      if (existingChunks.count === 0) {
        const insertChunk = this.db.prepare(`
          INSERT INTO chunks (transfer_id, chunk_index, chunk_offset, chunk_size, chunk_hash, upload_state)
          VALUES (@transfer_id, @chunk_index, @chunk_offset, @chunk_size, '', 'PENDING')
        `);
        for (let i = 0; i < totalChunks; i++) {
          const chunkOffset = i * chunkSize;
          // Last chunk might be smaller but we don't strictly need to know it exactly here, 
          // we can determine it when reading. But we store it as max size initially.
          // Wait, the spec says "total_chunks = ceil(actual_size / chunk_size), computed once at UPLOADING start and persisted (transfers.total_chunks, transfers.chunk_size) — this makes the chunk plan itself deterministic and recoverable without recomputation."
          insertChunk.run({
            transfer_id: transferId,
            chunk_index: i,
            chunk_offset: chunkOffset,
            chunk_size: chunkSize
          });
        }
      }
      return true;
    });

    return transaction();
  }

  getPendingChunks(transferId) {
    return this.db.prepare(`
      SELECT * FROM chunks 
      WHERE transfer_id = ? AND upload_state != 'ACKED'
      ORDER BY chunk_index ASC
    `).all(transferId);
  }

  updateChunkState(transferId, chunkIndex, uploadState, chunkHash, lastError = null) {
    const stmt = this.db.prepare(`
      UPDATE chunks SET 
        upload_state = @upload_state,
        chunk_hash = CASE WHEN @chunk_hash IS NOT NULL THEN @chunk_hash ELSE chunk_hash END,
        last_error = @last_error,
        acked_at = CASE WHEN @upload_state = 'ACKED' THEN @now ELSE acked_at END,
        attempts = CASE WHEN @upload_state = 'PENDING' AND @last_error IS NOT NULL THEN attempts + 1 ELSE attempts END
      WHERE transfer_id = @transfer_id AND chunk_index = @chunk_index
    `);
    stmt.run({
      upload_state: uploadState,
      chunk_hash: chunkHash,
      last_error: lastError,
      now: new Date().toISOString(),
      transfer_id: transferId,
      chunk_index: chunkIndex
    });
  }

  markVerifying(transferId) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'VERIFYING',
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id
    `);
    stmt.run({
      updated_at: new Date().toISOString(),
      transfer_id: transferId
    });
  }

  markCompleted(transferId, remoteObjectId) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'COMPLETED',
        remote_object_id = @remote_object_id,
        completed_at = @completed_at,
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id
    `);
    const now = new Date().toISOString();
    stmt.run({
      remote_object_id: remoteObjectId,
      completed_at: now,
      updated_at: now,
      transfer_id: transferId
    });
  }

  markRetrying(transferId, nextRetryAt) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'RETRY_WAIT',
        next_retry_at = @next_retry_at,
        retry_attempts = retry_attempts + 1,
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id
    `);
    stmt.run({
      next_retry_at: nextRetryAt,
      updated_at: new Date().toISOString(),
      transfer_id: transferId
    });
  }

  markPaused(transferId, reason) {
    const stmt = this.db.prepare(`
      UPDATE transfers SET 
        state = 'PAUSED',
        paused_reason = @paused_reason,
        updated_at = @updated_at
      WHERE transfer_id = @transfer_id
    `);
    stmt.run({
      paused_reason: reason,
      updated_at: new Date().toISOString(),
      transfer_id: transferId
    });
  }

  getTransferRecord(transferId) {
    return this.db.prepare(`SELECT * FROM transfers WHERE transfer_id = ?`).get(transferId);
  }

  getAllPendingTransfers() {
    return this.db.prepare(`
      SELECT * FROM transfers WHERE state IN ('LOCAL_READY', 'QUEUED', 'RETRY_WAIT', 'UPLOADING')
    `).all();
  }
}

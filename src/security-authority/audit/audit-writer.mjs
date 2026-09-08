// @ts-check

import crypto from 'crypto';
import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';

/**
 * Asynchronous background worker for processing the Cryptographic Audit Hash Chain.
 * Ensures that computing hashes and inserting logs does not block critical CP execution paths.
 */
export class AuditWriter {
  constructor() {
    /** @type {any[]} */
    this.queue = [];
    this.isProcessing = false;
    this.intervalId = null;
  }

  /**
   * Starts the background processing loop.
   */
  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.processQueue().catch(e => console.error("[AuditWriter] Loop error:", e));
    }, 1000); // Flush every second
    if (this.intervalId && typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  /**
   * Stops the background loop.
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Pushes an event to the queue for background processing.
   * @param {any} eventPayload 
   */
  enqueue(eventPayload) {
    this.queue.push(eventPayload);
  }

  /**
   * Flushes the queue, computing the cryptographic hash chain locally 
   * and inserting batch records into SQLite.
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    try {
      // Drain current queue
      const batch = this.queue.splice(0, this.queue.length);
      
      // We must fetch the last hash from the DB.
      // Since AEADStorageAdapter encrypts the full row blob, we must decrypt the last one.
      let lastHash = await this._fetchLastEventHash();

      for (const event of batch) {
        // Construct canonical string for hashing
        const eventStr = JSON.stringify(event.metadata || {});
        const prevHashStr = lastHash || "GENESIS_BLOCK";
        
        const newHash = crypto.createHash('sha256')
          .update(prevHashStr)
          .update(eventStr)
          .digest('hex');

        event.prev_event_hash = prevHashStr;
        event.event_hash = newHash;
        
        // Write via AEAD adapter (which encrypts the payload)
        await AEADStorageAdapter.writeEvent(event);
        
        lastHash = newHash;
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Retrieves the last event hash from the SQLite DB.
   * @returns {Promise<string | null>}
   */
  async _fetchLastEventHash() {
    if (!AEADStorageAdapter._db) return null;
    
    // Fetch the most recent event
    const row = await AEADStorageAdapter._db.get(
      'SELECT timestamp, encrypted_blob FROM security_audit_log ORDER BY sequence DESC LIMIT 1'
    );
    
    if (!row) return null;

    try {
      // Audit logs use `timestamp` as the state version in AAD, and 0 for backendGen
      const decodedEvent = AEADStorageAdapter._decryptPayload('audit', row.timestamp, 0, row.encrypted_blob);
      return decodedEvent.event_hash || null;
    } catch (err) {
      console.error("[AuditWriter] Failed to decrypt last audit log. Hash chain broken!");
      return null;
    }
  }
}

export const auditWriter = new AuditWriter();
// Automatically start the background worker
auditWriter.start();

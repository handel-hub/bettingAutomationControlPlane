// @ts-check

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { NativeCore } from '../native/security-core.mjs';

/**
 * AEAD-Authenticated Storage Adapter.
 * All DB operations delegate to SQLite, but use AES-256-GCM via Rust NAPI for encryption/MAC.
 * Binds row ID and state_version to the AAD to prevent row-swapping or rollback to stale states.
 */
export const AEADStorageAdapter = {
  /** @type {import('sqlite').Database | null} */
  _db: null,

  /**
   * Initializes SQLite and creates the encrypted blob table.
   * @param {string} dbPath 
   */
  async initDatabase(dbPath) {
    if (!dbPath) throw new Error("Database path required");
    
    // Initialize Rust crypto layer (generates/fetches root key)
    NativeCore.init();

    this._db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS secure_state (
        key TEXT PRIMARY KEY,
        state_version INTEGER NOT NULL,
        encrypted_blob BLOB NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS security_audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        encrypted_blob BLOB NOT NULL
      );
    `);
  },

  /**
   * Serializes state object to JSON, encrypts it, and returns the blob.
   * AAD binds the key ('singleton') and the state_version.
   * @param {string} key 
   * @param {number} stateVersion 
   * @param {object} payload 
   * @returns {Buffer}
   */
  _encryptPayload(key, stateVersion, payload) {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const aad = Buffer.from(`${key}:${stateVersion}`, 'utf8');
    return NativeCore.encryptAead(plaintext, aad);
  },

  /**
   * Decrypts the blob using AES-256-GCM and verifies AAD.
   * @param {string} key 
   * @param {number} stateVersion 
   * @param {Buffer} encryptedBlob 
   * @returns {object}
   */
  _decryptPayload(key, stateVersion, encryptedBlob) {
    const aad = Buffer.from(`${key}:${stateVersion}`, 'utf8');
    const plaintext = NativeCore.decryptAead(encryptedBlob, aad);
    return JSON.parse(plaintext.toString('utf8'));
  },

  /**
   * Reads the singleton security state row.
   * @returns {Promise<import('./schema.mjs').SecurityStateData | null>}
   */
  async getSecurityStateRow() {
    if (!this._db) throw new Error("Database not initialized");

    const row = await this._db.get(
      'SELECT state_version, encrypted_blob FROM secure_state WHERE key = ?',
      ['singleton']
    );

    if (!row) return null;

    let data;
    try {
      data = this._decryptPayload('singleton', row.state_version, row.encrypted_blob);
    } catch (err) {
      // MAC failed! Cryptographically invalid or tampered row.
      console.error("[AEADStorageAdapter] CRITICAL: Decryption/MAC verification failed for security state!");
      throw new Error("SECURITY_STATE_UNCERTAIN: Database integrity verification failed.");
    }

    let monotonicCounter = NativeCore.getMonotonicCounter();
    const intent = NativeCore.getTransitionIntent();

    if (intent !== -1) {
      if (row.state_version === intent && intent === monotonicCounter + 1) {
        console.warn(`[AEADStorageAdapter] Recovering interrupted transition to state ${intent}`);
        NativeCore.incrementMonotonicCounter();
        monotonicCounter = NativeCore.getMonotonicCounter();
      }
      NativeCore.clearTransitionIntent();
    }

    if (row.state_version !== monotonicCounter) {
      console.error(`[AEADStorageAdapter] CRITICAL: Snapshot rollback or desync detected! DB Version: ${row.state_version}, Monotonic Counter: ${monotonicCounter}`);
      throw new Error("SECURITY_STATE_UNCERTAIN: Database rollback detected.");
    }

    return data;
  },

  /**
   * Commits a state transition atomically using OCC.
   * @param {number} expectedStateVersion
   * @param {import('../state-machine/states.mjs').SecurityStateData} nextStateData
   * @param {string} event
   * @returns {Promise<boolean>} true if commit succeeded, false if OCC conflict
   */
  async commitTransitionWithOCC(expectedStateVersion, nextStateData, event) {
    if (!this._db) throw new Error("Database not initialized");
    
    const nextVersion = expectedStateVersion + 1;
    
    // Augment with metadata
    const payloadToEncrypt = {
      ...nextStateData,
      state_version: nextVersion,
      last_transition: event,
      last_transition_at: new Date().toISOString()
    };

    const encryptedBlob = this._encryptPayload('singleton', nextVersion, payloadToEncrypt);

    // Two-Phase Commit sequence
    NativeCore.setTransitionIntent(nextVersion);

    const result = await this._db.run(
      `UPDATE secure_state 
       SET state_version = ?, encrypted_blob = ? 
       WHERE key = 'singleton' AND state_version = ?`,
      [nextVersion, encryptedBlob, expectedStateVersion]
    );

    if (result.changes === 0) {
      // If the row doesn't exist at all, we INSERT it (only happens at initialization)
      if (expectedStateVersion === 0) {
        const insertResult = await this._db.run(
          `INSERT OR IGNORE INTO secure_state (key, state_version, encrypted_blob) 
           VALUES ('singleton', ?, ?)`,
          [nextVersion, encryptedBlob]
        );
        if (insertResult.changes > 0) {
          NativeCore.incrementMonotonicCounter();
          NativeCore.clearTransitionIntent();
          return true;
        }
      }
      NativeCore.clearTransitionIntent();
      return false; // OCC conflict
    }

    // ENFORCE MONOTONIC COUNTER (INVARIANT 17 - SNAPSHOT ROLLBACK)
    NativeCore.incrementMonotonicCounter();
    NativeCore.clearTransitionIntent();

    return true;
  },

  /**
   * Writes a security event to the audit log with encryption.
   * @param {any} eventRow
   * @returns {Promise<void>}
   */
  async writeEvent(eventRow) {
    if (!this._db) return;

    // Use timestamp as part of AAD
    const ts = Date.now();
    const encryptedBlob = this._encryptPayload('audit', ts, eventRow);

    await this._db.run(
      `INSERT INTO security_audit_log (timestamp, event_type, encrypted_blob) VALUES (?, ?, ?)`,
      [ts, eventRow.event_type || 'UNKNOWN', encryptedBlob]
    );
  }
};

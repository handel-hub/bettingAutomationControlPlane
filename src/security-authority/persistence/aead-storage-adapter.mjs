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

  async initDatabase(dbPath) {
    if (!dbPath) throw new Error("Database path required");
    
    // Initialize Rust crypto layer (generates/fetches root key)
    NativeCore.init();

    this._db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    await this._migrateDatabase(this._db);
  },

  /**
   * Safe schema migration flow using PRAGMA user_version
   * @param {import('sqlite').Database} db
   */
  async _migrateDatabase(db) {
    await db.exec('BEGIN EXCLUSIVE TRANSACTION');
    try {
      const { user_version } = await db.get('PRAGMA user_version');
      let currentVersion = user_version;

      if (currentVersion === 0) {
        // Baseline creation (if fresh install)
        await db.exec(`
          CREATE TABLE IF NOT EXISTS secure_state (
            key TEXT PRIMARY KEY,
            state_version INTEGER NOT NULL,
            backend_generation INTEGER NOT NULL DEFAULT 0,
            encrypted_blob BLOB NOT NULL
          );
          
          CREATE TABLE IF NOT EXISTS security_audit_log (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            encrypted_blob BLOB NOT NULL
          );

          CREATE TABLE IF NOT EXISTS seen_nonces (
            nonce TEXT PRIMARY KEY,
            seen_at INTEGER NOT NULL
          );
        `);
        await db.exec('PRAGMA user_version = 1');
        currentVersion = 1;
      }

      if (currentVersion === 1) {
        // Migration to V2: Add tracking columns for offline grace and epoch
        await db.exec(`
          ALTER TABLE secure_state ADD COLUMN server_epoch INTEGER DEFAULT 0;
          ALTER TABLE secure_state ADD COLUMN highest_observed_time INTEGER DEFAULT 0;
          ALTER TABLE secure_state ADD COLUMN grace_token_signature TEXT;
        `);
        
        // Update existing records with current time to prevent immediate rollback trigger
        const currentTime = Date.now();
        await db.run(`UPDATE secure_state SET highest_observed_time = ?`, [currentTime]);
        
        await db.exec('PRAGMA user_version = 2');
        currentVersion = 2;
      }

      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw new Error(`Database migration failed: ${error.message}`);
    }
  },

  /**
   * Serializes state object to JSON, encrypts it, and returns the blob.
   * AAD binds the key ('singleton'), the state_version, and the backend_generation.
   * @param {string} key 
   * @param {number} stateVersion 
   * @param {number} backendGeneration
   * @param {object} payload 
   * @returns {Buffer}
   */
  _encryptPayload(key, stateVersion, backendGeneration, payload) {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const aad = Buffer.from(`${key}:${stateVersion}:${backendGeneration}`, 'utf8');
    return NativeCore.encryptAead(plaintext, aad);
  },

  /**
   * Decrypts the blob using AES-256-GCM and verifies AAD.
   * @param {string} key 
   * @param {number} stateVersion 
   * @param {number} backendGeneration
   * @param {Buffer} encryptedBlob 
   * @returns {object}
   */
  _decryptPayload(key, stateVersion, backendGeneration, encryptedBlob) {
    const aad = Buffer.from(`${key}:${stateVersion}:${backendGeneration}`, 'utf8');
    const plaintext = NativeCore.decryptAead(encryptedBlob, aad);
    return JSON.parse(plaintext.toString('utf8'));
  },

  /**
   * Reads the singleton security state row.
   * @returns {Promise<any | null>}
   */
  async getSecurityStateRow() {
    if (!this._db) throw new Error("Database not initialized");

    const row = await this._db.get(
      'SELECT state_version, backend_generation, server_epoch, highest_observed_time, grace_token_signature, encrypted_blob FROM secure_state WHERE key = ?',
      ['singleton']
    );

    if (!row) return null;

    let data;
    try {
      data = this._decryptPayload('singleton', row.state_version, row.backend_generation, row.encrypted_blob);
    } catch (err) {
      // MAC failed! Cryptographically invalid or tampered row.
      console.error("[AEADStorageAdapter] CRITICAL: Decryption/MAC verification failed for security state!");
      throw new Error("SECURITY_STATE_UNCERTAIN: Database integrity verification failed.");
    }
    
    // Validate backend-anchored generation for rollback detection
    if (data.session_generation && row.backend_generation !== data.session_generation) {
       console.error(`[AEADStorageAdapter] CRITICAL: Backend generation mismatch! Row: ${row.backend_generation}, Payload: ${data.session_generation}`);
       throw new Error("SECURITY_STATE_UNCERTAIN: Backend generation rollback detected.");
    }
    
    // Inject the fast-query columns into the returned data object for business logic
    data.server_epoch = row.server_epoch;
    data.highest_observed_time = row.highest_observed_time;
    data.grace_token_signature = row.grace_token_signature;

    return data;
  },

  /**
   * Commits a state transition atomically using OCC.
   * @param {number} expectedStateVersion
   * @param {any} nextStateData
   * @param {string} event
   * @returns {Promise<boolean>} true if commit succeeded, false if OCC conflict
   */
  async commitTransitionWithOCC(expectedStateVersion, nextStateData, event) {
    if (!this._db) throw new Error("Database not initialized");
    
    const nextVersion = expectedStateVersion + 1;
    const backendGen = nextStateData.session_generation || 0;
    const serverEpoch = nextStateData.server_epoch || 0;
    const highestTime = nextStateData.highest_observed_time || Date.now();
    const graceSig = nextStateData.grace_token_signature || null;
    
    // Augment with metadata
    const payloadToEncrypt = {
      ...nextStateData,
      state_version: nextVersion,
      last_transition: event,
      last_transition_at: new Date().toISOString()
    };
    
    // Remove the explicit columns from the encrypted blob to avoid duplication, though we can keep them for double-verification.
    delete payloadToEncrypt.server_epoch;
    delete payloadToEncrypt.highest_observed_time;
    delete payloadToEncrypt.grace_token_signature;

    const encryptedBlob = this._encryptPayload('singleton', nextVersion, backendGen, payloadToEncrypt);

    const result = await this._db.run(
      `UPDATE secure_state 
       SET state_version = ?, backend_generation = ?, server_epoch = ?, highest_observed_time = ?, grace_token_signature = ?, encrypted_blob = ? 
       WHERE key = 'singleton' AND state_version = ?`,
      [nextVersion, backendGen, serverEpoch, highestTime, graceSig, encryptedBlob, expectedStateVersion]
    );

    if (result.changes === 0) {
      // If the row doesn't exist at all, we INSERT it (only happens at initialization)
      if (expectedStateVersion === 0) {
        const insertResult = await this._db.run(
          `INSERT OR IGNORE INTO secure_state (key, state_version, backend_generation, server_epoch, highest_observed_time, grace_token_signature, encrypted_blob) 
           VALUES ('singleton', ?, ?, ?, ?, ?, ?)`,
          [nextVersion, backendGen, serverEpoch, highestTime, graceSig, encryptedBlob]
        );
        if (insertResult.changes > 0) {
          return true;
        }
      }
      return false; // OCC conflict
    }

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
    // Audit logs don't use backend_generation, pass 0
    const encryptedBlob = this._encryptPayload('audit', ts, 0, eventRow);

    await this._db.run(
      `INSERT INTO security_audit_log (timestamp, event_type, encrypted_blob) VALUES (?, ?, ?)`,
      [ts, eventRow.event_type || 'UNKNOWN', encryptedBlob]
    );
  },

  /**
   * Loads all previously seen nonces.
   * @returns {Promise<string[]>}
   */
  async loadSeenNonces() {
    if (!this._db) return [];
    const rows = await this._db.all(`SELECT nonce FROM seen_nonces`);
    return rows.map(r => r.nonce);
  },

  /**
   * Saves a newly seen nonce.
   * @param {string} nonce
   * @param {number} seenAt
   * @returns {Promise<void>}
   */
  async saveNonce(nonce, seenAt = Date.now()) {
    if (!this._db) return;
    await this._db.run(
      `INSERT OR IGNORE INTO seen_nonces (nonce, seen_at) VALUES (?, ?)`,
      [nonce, seenAt]
    );
  },
  
  /**
   * Evicts nonces older than the given cutoff time.
   * @param {number} cutoffTimestamp 
   */
  async evictOldNonces(cutoffTimestamp) {
    if (!this._db) return;
    await this._db.run(
      `DELETE FROM seen_nonces WHERE seen_at < ?`,
      [cutoffTimestamp]
    );
  }
};

// @ts-check

import { AEADStorageAdapter } from '../persistence/aead-storage-adapter.mjs';

/**
 * Provides a persistent monotonic clock anchored to backend time and boot-time checks.
 */
export class PersistentClock {
  /**
   * @param {AEADStorageAdapter} storage
   */
  constructor(storage) {
    this.storage = storage;
    this.bootWallclock = Date.now();
    this.bootHrtime = process.hrtime.bigint();
    this.lastKnownTime = 0;
    this.isUncertain = false;
  }

  /**
   * Validates boot time against persistent anchor.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!this.storage._db) {
      throw new Error("Storage not initialized");
    }

    const row = await this.storage._db.get(
      'SELECT state_version, backend_generation, encrypted_blob FROM secure_state WHERE key = ?',
      ['time_anchor']
    );

    if (row) {
      try {
        const data = this.storage._decryptPayload('time_anchor', row.state_version, row.backend_generation, row.encrypted_blob);
        this.lastKnownTime = data.last_known_time || 0;

        // Rollback detection
        if (this.bootWallclock < this.lastKnownTime) {
          console.error(`[PersistentClock] CRITICAL: Clock rollback detected. Boot time ${this.bootWallclock} < Last known time ${this.lastKnownTime}`);
          this.isUncertain = true;
        }
      } catch (err) {
        console.error("[PersistentClock] CRITICAL: Time anchor decryption failed!");
        this.isUncertain = true;
      }
    } else {
      // First boot, set time anchor
      await this.updateAnchor(this.bootWallclock);
    }
  }

  /**
   * Returns current monotonic time by adding hrtime delta to boot wallclock.
   * If the clock is uncertain, throws an error requiring backend sync.
   * @returns {number}
   */
  now() {
    if (this.isUncertain) {
      throw new Error("SECURITY_STATE_UNCERTAIN: Clock rollback detected or time anchor corrupted.");
    }
    const hrDeltaNs = process.hrtime.bigint() - this.bootHrtime;
    const hrDeltaMs = Number(hrDeltaNs / 1000000n);
    return this.bootWallclock + hrDeltaMs;
  }

  /**
   * Updates the persistent time anchor. Usually called on backend sync.
   * @param {number} backendTimestamp 
   */
  async updateAnchor(backendTimestamp) {
    if (!this.storage._db) return;
    
    // We only move time forward
    if (backendTimestamp > this.lastKnownTime) {
      this.lastKnownTime = backendTimestamp;
      
      const nextVersion = Date.now(); // We can just use timestamp as version for time_anchor
      const payload = { last_known_time: this.lastKnownTime };
      const encryptedBlob = this.storage._encryptPayload('time_anchor', nextVersion, 0, payload);
      
      const exists = await this.storage._db.get('SELECT 1 FROM secure_state WHERE key = ?', ['time_anchor']);
      if (exists) {
        await this.storage._db.run(
          'UPDATE secure_state SET state_version = ?, backend_generation = 0, encrypted_blob = ? WHERE key = ?',
          [nextVersion, encryptedBlob, 'time_anchor']
        );
      } else {
        await this.storage._db.run(
          'INSERT INTO secure_state (key, state_version, backend_generation, encrypted_blob) VALUES (?, ?, ?, ?)',
          ['time_anchor', nextVersion, 0, encryptedBlob]
        );
      }

      // If we received a valid backend sync, we are no longer uncertain.
      if (this.isUncertain && this.bootWallclock >= backendTimestamp) {
         this.isUncertain = false;
      }
    }
  }
}

// @ts-check
import { encryptLocalPassword } from '../../persistence/adapters/AccountsAdapter.mjs';

/**
 * Migration 006: Encrypt Any Pre-Existing Plaintext Passwords at Rest.
 *
 * Scans `accounts_metadata_cache` for any non-empty, unmasked `account_password` values
 * that are not yet prefixed with `enc:v1:` and encrypts them in place with AES-256-GCM.
 */
export const migration006 = {
  version: 6,
  name: '006_encrypt_plaintext_passwords',

  /**
   * @param {import('../../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  up(engine) {
    try {
      const rows = engine.prepare(`
        SELECT account_id, account_password
        FROM accounts_metadata_cache
        WHERE account_password IS NOT NULL
          AND account_password != ''
          AND account_password != '[PROTECTED]'
          AND account_password NOT LIKE 'enc:v1:%'
      `).all();

      if (Array.isArray(rows) && rows.length > 0) {
        const updateStmt = engine.prepare(`
          UPDATE accounts_metadata_cache
          SET account_password = ?
          WHERE account_id = ?
        `);
        for (const row of rows) {
          const encrypted = encryptLocalPassword(row.account_password);
          updateStmt.run(encrypted, row.account_id);
        }
      }
    } catch { /* ignore if table absent */ }
  }
};

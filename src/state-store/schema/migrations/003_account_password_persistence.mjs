// @ts-check

/**
 * Migration 003: Direct Account Password Persistence.
 * 
 * Adds `account_password` column to `accounts_metadata_cache` table
 * so that bookmaker login credentials can be stored directly in SQLite
 * and survive restarts without fragile in-memory or encrypted DPAPI caching.
 */
export const migration003 = {
  version: 3,
  name: '003_account_password_persistence',

  /**
   * @param {import('../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  up(engine) {
    engine.exec(`
      ALTER TABLE accounts_metadata_cache ADD COLUMN account_password TEXT NOT NULL DEFAULT '';
    `);
  }
};

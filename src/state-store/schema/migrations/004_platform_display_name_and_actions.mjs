// @ts-check

/**
 * Migration 004: Platform Display Name & Available Actions Persistence.
 * 
 * Adds `platform_display_name` and `available_actions_json` columns to `accounts_metadata_cache`
 * to preserve rich bookmaker branding and dynamic server-driven action contracts in SQLite.
 */
export const migration004 = {
  version: 4,
  name: '004_platform_display_name_and_actions',

  /**
   * @param {import('../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  up(engine) {
    try {
      engine.exec(`
        ALTER TABLE accounts_metadata_cache ADD COLUMN platform_display_name TEXT;
      `);
    } catch { /* column might already exist */ }

    try {
      engine.exec(`
        ALTER TABLE accounts_metadata_cache ADD COLUMN available_actions_json TEXT DEFAULT '["ACTIVATE","DEACTIVATE","DELETE"]';
      `);
    } catch { /* column might already exist */ }
  }
};

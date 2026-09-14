// @ts-check

/**
 * Migration 002: State Foundation - Separation of Desired State from Observed State.
 * 
 * 1. Creates `system_lifecycle_state` table tracking:
 *    - desired_state ('STOPPED' | 'RUNNING')
 *    - observed_state ('STOPPED' | 'STARTING_HANDSHAKE' | 'RUNNING' | 'STOPPING' | 'ABORTED' | 'ERROR_DEGRADED')
 *    - generation (monotonic integer)
 *    - last_transition_at (ISO timestamp)
 *    - transition_reason (string)
 * 
 * 2. Adds `desired_state` and `observed_state` columns to `accounts_metadata_cache`.
 */
export const migration002 = {
  version: 2,
  name: '002_desired_vs_observed_state',

  /**
   * @param {import('../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  up(engine) {
    engine.exec(`
      -- 1. System-wide Lifecycle & Execution Plane State Tracking
      CREATE TABLE IF NOT EXISTS system_lifecycle_state (
          id TEXT PRIMARY KEY DEFAULT 'primary',
          desired_state TEXT NOT NULL DEFAULT 'STOPPED',
          observed_state TEXT NOT NULL DEFAULT 'STOPPED',
          generation INTEGER NOT NULL DEFAULT 1,
          last_transition_at TEXT NOT NULL,
          transition_reason TEXT NOT NULL DEFAULT 'SYSTEM_BOOT'
      );

      -- Seed baseline row if not exists
      INSERT OR IGNORE INTO system_lifecycle_state (
          id, desired_state, observed_state, generation, last_transition_at, transition_reason
      ) VALUES ('primary', 'STOPPED', 'STOPPED', 1, datetime('now'), 'INITIAL_SEEDED');

      -- 2. Add Desired vs Observed State to Accounts Metadata Cache
      -- SQLite supports ALTER TABLE ADD COLUMN
      ALTER TABLE accounts_metadata_cache ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'STOPPED';
      ALTER TABLE accounts_metadata_cache ADD COLUMN observed_state TEXT NOT NULL DEFAULT 'STOPPED';
      ALTER TABLE accounts_metadata_cache ADD COLUMN execution_status_reason TEXT;
    `);
  }
};

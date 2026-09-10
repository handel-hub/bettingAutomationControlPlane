// @ts-check
import { migration001 } from './migrations/001_initial_schema.mjs';

/**
 * Migration manager for ACP State Store SQLite schema.
 * Tracks user_version and applies pending migrations inside atomic transactions.
 */
export class SchemaMigrator {
  /**
   * @param {import('../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   * @param {Array<any>} [migrations]
   */
  constructor(engine, migrations = [migration001]) {
    this.engine = engine;
    this.migrations = migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Returns the current schema version.
   */
  getCurrentVersion() {
    return this.engine.userVersion();
  }

  /**
   * Runs all pending migrations.
   * @returns {number} The updated schema version.
   */
  migrate() {
    let currentVersion = this.getCurrentVersion();
    const pending = this.migrations.filter(m => m.version > currentVersion);

    if (pending.length === 0) {
      return currentVersion;
    }

    for (const migration of pending) {
      this.engine.transaction(() => {
        migration.up(this.engine);
        this.engine.userVersion(migration.version);
      });
      currentVersion = migration.version;
    }

    return currentVersion;
  }
}

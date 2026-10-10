// acp-bytenode-compat-lab/tests/m7-schema-migrator.mjs
// M7: SQLite SchemaMigrator compatibility tests

import { SqliteStorageEngine } from '../../src/state-store/persistence/SqliteStorageEngine.mjs';
import { SchemaMigrator } from '../../src/state-store/schema/SchemaMigrator.mjs';

export function registerM7Tests(harness) {
  let engine = null;
  let migrator = null;

  harness.test('M7-001', 'SchemaMigrator initial baseline detection', 'M7-SchemaMigrator', async () => {
    engine = new SqliteStorageEngine(':memory:');
    engine.open();
    migrator = new SchemaMigrator(engine);

    const initialVer = migrator.getCurrentVersion();
    if (initialVer !== 0) {
      throw new Error(`Expected initial schema version 0, got ${initialVer}`);
    }

    return { initialVersion: initialVer };
  });

  harness.test('M7-002', 'SchemaMigrator sequential migration execution', 'M7-SchemaMigrator', async () => {
    const finalVer = migrator.migrate();

    if (finalVer !== 4) {
      throw new Error(`Expected schema migration to reach version 4, got ${finalVer}`);
    }

    // Verify key tables were created
    const tables = engine.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name IN ('accounts_metadata_cache', 'global_automation_config', 'cache_metadata')
    `).all();

    if (tables.length < 3) {
      throw new Error(`Expected at least 3 schema tables, found: ${JSON.stringify(tables)}`);
    }

    return { migratedVersion: finalVer, tablesCreated: tables.map(t => t.name) };
  });

  harness.test('M7-003', 'SchemaMigrator idempotency on second run', 'M7-SchemaMigrator', async () => {
    const reMigrateVer = migrator.migrate();

    if (reMigrateVer !== 4) {
      throw new Error(`Expected idempotent version 4, got ${reMigrateVer}`);
    }

    engine.close();
    return { idempotent: true, version: reMigrateVer };
  });
}

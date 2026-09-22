// @ts-check

/**
 * Adapter for cache_metadata table.
 * Manages entity ETags, monotonic revisions, and timestamps.
 */
export class MetadataAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Gets metadata for an entity.
   * @param {string} entityKey
   * @returns {{ entityKey: string; etag: string | null; revision: number; cachedAt: string; expiresAt: string | null; lastValidatedAt: string } | null}
   */
  get(entityKey) {
    const row = this.engine.prepare(`
      SELECT entity_key AS entityKey, etag, revision, schema_version AS schemaVersion,
             cached_at AS cachedAt, expires_at AS expiresAt, last_validated_at AS lastValidatedAt
      FROM cache_metadata
      WHERE entity_key = ?
    `).get(entityKey);

    return row ? /** @type {any} */ (row) : null;
  }

  /**
   * Gets all metadata entries.
   * @returns {Map<string, any>}
   */
  getAll() {
    const rows = this.engine.prepare(`
      SELECT entity_key AS entityKey, etag, revision, schema_version AS schemaVersion,
             cached_at AS cachedAt, expires_at AS expiresAt, last_validated_at AS lastValidatedAt
      FROM cache_metadata
    `).all();

    const map = new Map();
    for (const r of rows) {
      map.set(r.entityKey, r);
    }
    return map;
  }

  /**
   * Sets or updates metadata for an entity key.
   * @param {string} entityKey
   * @param {object} params
   * @param {string} [params.etag]
   * @param {number} [params.revision]
   * @param {string} [params.expiresAt]
   * @param {string} [params.lastValidatedAt]
   */
  set(entityKey, { etag = null, revision = 1, expiresAt = null, lastValidatedAt = null } = {}) {
    const now = new Date().toISOString();
    const validatedAt = lastValidatedAt || now;
    this.engine.prepare(`
      INSERT INTO cache_metadata (entity_key, etag, revision, schema_version, cached_at, expires_at, last_validated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(entity_key) DO UPDATE SET
        etag = COALESCE(excluded.etag, cache_metadata.etag),
        revision = excluded.revision,
        cached_at = excluded.cached_at,
        expires_at = excluded.expires_at,
        last_validated_at = excluded.last_validated_at
    `).run(entityKey, etag, revision, now, expiresAt, validatedAt);
  }

  /**
   * Increments revision for an entity key atomically.
   * @param {string} entityKey
   * @returns {number} The updated revision.
   */
  bumpRevision(entityKey) {
    const now = new Date().toISOString();
    const existing = this.get(entityKey);
    const nextRev = existing ? existing.revision + 1 : 1;
    this.set(entityKey, { revision: nextRev });
    return nextRev;
  }

  /**
   * Deletes metadata entry.
   * @param {string} entityKey
   */
  delete(entityKey) {
    this.engine.prepare('DELETE FROM cache_metadata WHERE entity_key = ?').run(entityKey);
  }
}

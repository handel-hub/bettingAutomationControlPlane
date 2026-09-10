// @ts-check
import { RevisionConflictError } from '../types/errors.mjs';

/**
 * Consistency Group Manager.
 * Orchestrates multi-table atomic transactions with monotonic revision increments and OCC validation.
 */
export class ConsistencyGroupManager {
  /**
   * @param {import('./SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   * @param {import('./adapters/MetadataAdapter.mjs').MetadataAdapter} metadataAdapter
   */
  constructor(engine, metadataAdapter) {
    this.engine = engine;
    this.metadataAdapter = metadataAdapter;
  }

  /**
   * Executes a mutating operation inside an atomic SQLite transaction,
   * verifying optimistic concurrency control (OCC) against the entity's current revision.
   * 
   * @template T
   * @param {string} groupKey Entity/Domain key in cache_metadata
   * @param {number | null} expectedRevision
   * @param {(nextRevision: number) => T} mutationFn
   * @returns {{ result: T; revision: number }}
   */
  executeGroupTransaction(groupKey, expectedRevision, mutationFn) {
    return this.engine.transaction(() => {
      const meta = this.metadataAdapter.get(groupKey);
      const currentRevision = meta ? meta.revision : 1;

      if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== currentRevision) {
        throw new RevisionConflictError(groupKey, expectedRevision, currentRevision);
      }

      const nextRevision = currentRevision + 1;

      // Execute domain mutation
      const result = mutationFn(nextRevision);

      // Persist updated revision in cache_metadata atomically
      this.metadataAdapter.set(groupKey, { revision: nextRevision });

      return { result, revision: nextRevision };
    });
  }
}

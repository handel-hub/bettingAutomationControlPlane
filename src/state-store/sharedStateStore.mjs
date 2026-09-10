// @ts-check
import { StateStore } from './StateStore.mjs';

/** @type {StateStore | null} */
let _sharedStore = null;

/**
 * Returns the shared singleton StateStore for the ACP API and WebSocket servers.
 * @param {object} [options]
 * @returns {StateStore}
 */
export function getSharedStateStore(options = {}) {
  if (!_sharedStore) {
    const dbPath = options.dbPath || process.env.ACP_CACHE_DB_PATH || ':memory:';
    const userId = options.userId || process.env.ACP_USER_ID || 'usr_operator';
    _sharedStore = new StateStore({ dbPath, userId });
    _sharedStore.initialize();
  }
  return _sharedStore;
}

/**
 * Explicitly sets the shared StateStore instance (useful for tests or custom boot).
 * @param {StateStore} store
 */
export function setSharedStateStore(store) {
  _sharedStore = store;
}

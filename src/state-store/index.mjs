// @ts-check
import { StateStore } from './StateStore.mjs';

/**
 * Creates an isolated StateStore instance.
 * @param {object} [options]
 * @param {string} [options.dbPath=':memory:']
 * @param {string} [options.userId='usr_default']
 * @returns {StateStore}
 */
export function createStateStore(options = {}) {
  return new StateStore(options);
}

export { StateStore };
export * from './types/errors.mjs';
export * from './types/contracts.mjs';
export { SanitizerGate } from './validation/SanitizerGate.mjs';
export { FreshnessEvaluator } from './hydration/FreshnessEvaluator.mjs';

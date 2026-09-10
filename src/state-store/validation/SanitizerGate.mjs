// @ts-check
import { SecurityViolationError } from '../types/errors.mjs';

/**
 * List of prohibited property names that must NEVER be persisted to SQLite.
 */
const FORBIDDEN_SECRET_KEYS = new Set([
  'accountPassword',
  'password',
  'sessionToken',
  'token',
  'jwt',
  'refreshToken',
  'proxyPassword',
  'proxyAuth',
  'secret',
  'secretKey',
  'cardToken',
  'cvv',
  'authorizationCode'
]);

/**
 * Gatekeeper that sanitizes objects before disk persistence or memory storage,
 * enforcing zero-trust credential isolation.
 */
export class SanitizerGate {
  /**
   * Sanitizes an object by recursively stripping all prohibited secret keys.
   * Does NOT mutate the input object; returns a clean cloned structure.
   * 
   * @template T
   * @param {T} data
   * @param {object} [options]
   * @param {boolean} [options.throwOnDetection=false] If true, throws SecurityViolationError instead of stripping
   * @returns {T}
   */
  static sanitize(data, options = { throwOnDetection: false }) {
    if (data === null || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return /** @type {any} */ (data.map(item => SanitizerGate.sanitize(item, options)));
    }

    const clean = {};
    for (const [key, value] of Object.entries(data)) {
      if (FORBIDDEN_SECRET_KEYS.has(key)) {
        if (key === 'accountPassword' && value === '[PROTECTED]') {
          clean[key] = '[PROTECTED]';
          continue;
        }
        if (options.throwOnDetection) {
          throw new SecurityViolationError(key);
        }
        // In sanitize mode: replace password with safe placeholder or omit
        if (key === 'accountPassword') {
          clean[key] = '[PROTECTED]';
        }
        continue;
      }

      if (value !== null && typeof value === 'object') {
        clean[key] = SanitizerGate.sanitize(value, options);
      } else {
        clean[key] = value;
      }
    }

    return /** @type {T} */ (clean);
  }

  /**
   * Asserts that an object contains zero prohibited secret properties.
   * Throws SecurityViolationError if any secret is discovered.
   * 
   * @param {any} data
   */
  static assertZeroSecrets(data) {
    SanitizerGate.sanitize(data, { throwOnDetection: true });
  }
}

// @ts-check
import { SecurityViolationError } from '../types/errors.mjs';

/**
 * List of prohibited property names that must NEVER be persisted to SQLite.
 */
const FORBIDDEN_SECRET_KEYS = new Set([
  'accountPassword',
  'password',
  'rawPassword',
  'sessionToken',
  'session_token',
  'token',
  'jwt',
  'refreshToken',
  'proxyPassword',
  'proxyAuth',
  'secret',
  'secretKey',
  'cardToken',
  'cvv',
  'authorizationCode',
  'cookies',
  'cookie',
  'credentials',
  'credential',
  'privateKey',
  'private_key'
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

/**
 * Strict projection scrubber for account objects exposed across public boundaries
 * (REST API, WebSocket broadcasts, views).
 * Guarantees that accountPassword is masked to '[PROTECTED]' and all credentials/cookies/tokens are stripped.
 * 
 * @param {any} acc
 * @returns {any}
 */
export function sanitizeAccountForExport(acc) {
  if (acc === null || typeof acc !== 'object') {
    return acc;
  }
  if (Array.isArray(acc)) {
    return acc.map(item => sanitizeAccountForExport(item));
  }

  const clean = SanitizerGate.sanitize(acc);
  clean.accountPassword = '[PROTECTED]';

  // Ensure forbidden fields are completely absent
  delete clean.password;
  delete clean.rawPassword;
  delete clean.cookies;
  delete clean.cookie;
  delete clean.credentials;
  delete clean.credential;
  delete clean.privateKey;
  delete clean.private_key;
  delete clean.session_token;
  delete clean.sessionToken;
  delete clean.token;
  delete clean.jwt;
  delete clean.refreshToken;
  delete clean.secret;
  delete clean.secretKey;
  delete clean.proxyPassword;
  delete clean.proxyAuth;
  delete clean.cardToken;
  delete clean.cvv;
  delete clean.authorizationCode;

  if (clean.effectiveConfig && typeof clean.effectiveConfig === 'object') {
    clean.effectiveConfig = { ...clean.effectiveConfig };
    for (const secretKey of FORBIDDEN_SECRET_KEYS) {
      delete clean.effectiveConfig[secretKey];
    }
  }

  return clean;
}


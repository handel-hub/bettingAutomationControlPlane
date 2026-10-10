// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { securityFacade } from '../../security-authority/facade.mjs';
import { logger } from '../../shared/logging.mjs';

export const authConfig = {
  activeToken: process.env.ACP_AUTH_TOKEN || null,
  requireAuth: process.env.NODE_ENV === 'production' || process.env.ACP_AUTH_REQUIRED === 'true' || Boolean(process.env.ACP_AUTH_TOKEN)
};

/**
 * Initializes or loads the local IPC authentication token.
 * Writes to .acp-ipc-token with 0o600 permissions so the local Frontend console
 * can authenticate across all execution environments.
 * @returns {string}
 */
export function initIpcToken() {
  if (authConfig.activeToken) {
    authConfig.requireAuth = process.env.ACP_AUTH_REQUIRED !== 'false';
    return authConfig.activeToken;
  }

  const ipcTokenPath = path.join(process.cwd(), '.acp-ipc-token');
  let savedToken = null;

  if (!process.env.ACP_AUTH_TOKEN && fs.existsSync(ipcTokenPath)) {
    try {
      const val = fs.readFileSync(ipcTokenPath, 'utf8').trim();
      if (val.length >= 16) {
        savedToken = val;
      }
    } catch {}
  }

  const generated = process.env.ACP_AUTH_TOKEN || savedToken || `ipc_${crypto.randomBytes(32).toString('hex')}`;
  authConfig.activeToken = generated;
  authConfig.requireAuth = process.env.ACP_AUTH_REQUIRED !== 'false';

  try {
    fs.writeFileSync(ipcTokenPath, generated, { encoding: 'utf8', mode: 0o600 });
    logger.info(
      { tokenFile: '.acp-ipc-token', persisted: Boolean(savedToken), requireAuth: authConfig.requireAuth },
      '[Auth] Local IPC authentication token ready'
    );
  } catch (err) {
    logger.warn({ err: err.message }, '[Auth] Could not write .acp-ipc-token file');
  }

  return generated;
}

export const initDevToken = initIpcToken;


/**
 * Validates whether a token string is valid against the active token.
 * @param {string | null | undefined} token
 * @returns {boolean}
 */
export function isValidToken(token) {
  if (!authConfig.requireAuth) return true;
  if (!token || !authConfig.activeToken) return false;

  const provided = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  try {
    // Constant-time comparison
    const bufA = Buffer.from(provided);
    const bufB = Buffer.from(authConfig.activeToken);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Express middleware for authenticating API requests.
 */
export function ingressAuthMiddleware(req, res, next) {
  if (!authConfig.requireAuth) {
    req.user = { id: 'dev-local', role: 'OPERATOR' };
    return next();
  }

  // Exempt health-check and public system pings
  if (req.path === '/api/v1/system/health' || req.path === '/api/v1/system/ping') {
    return next();
  }

  // Enforce header-only authentication for HTTP REST (disallow query param token leak)
  const token = req.headers.authorization || req.headers['x-acp-token'];

  if (!isValidToken(token)) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      code: 'AUTH_001',
      protocolError: {
        code: 'AUTH_001',
        domain: 'AUTH',
        message: 'Missing or invalid authentication token. Provide Authorization: Bearer <token>',
        retryable: false
      },
      message: 'Missing or invalid authentication token. Provide Authorization: Bearer <token>'
    });
  }

  req.user = { id: 'authenticated-operator', role: 'OPERATOR' };
  next();
}

/**
 * Express middleware that rejects execution requests when Control Plane is in degraded mode.
 */
export function requireOperational(req, res, next) {
  if (securityFacade.isDegraded()) {
    return res.status(503).json({
      error: 'DEGRADED_MODE',
      code: 'EXEC_001',
      protocolError: {
        code: 'EXEC_001',
        domain: 'EXECUTION',
        message: 'Control Plane is in DEGRADED mode (Backend or Internet Offline). Execution Plane access is disabled.',
        retryable: true
      },
      message: 'Control Plane is in DEGRADED mode (Backend or Internet Offline). Execution Plane access is disabled.'
    });
  }
  next();
}

/**
 * Creates middleware enforcing a required Security Authority capability.
 * @param {import('../../security-authority/authorization/capabilities.mjs').Capability} capability
 */
export function requireCapability(capability) {
  return (req, res, next) => {
    if (securityFacade.isDegraded()) {
      return res.status(503).json({
        error: 'DEGRADED_MODE',
        message: 'Control Plane is in DEGRADED mode (Backend or Internet Offline). Execution Plane access is disabled.'
      });
    }

    const authz = securityFacade.authorize(capability);
    if (authz.status !== 'OPERATIONAL') {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Missing capability: ${capability}`
      });
    }
    next();
  };
}

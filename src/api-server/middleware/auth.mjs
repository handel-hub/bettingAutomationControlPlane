// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { securityFacade } from '../../security-authority/facade.mjs';
import { logger } from '../../shared/logging.mjs';

export const authConfig = {
  activeToken: process.env.ACP_AUTH_TOKEN || null,
  requireAuth: process.env.NODE_ENV === 'production' || process.env.ACP_AUTH_REQUIRED === 'true'
};

/**
 * Initializes or loads the local development token.
 * Writes to .acp-dev-token for local frontend console discovery.
 * @returns {string}
 */
export function initDevToken() {
  if (authConfig.activeToken) {
    return authConfig.activeToken;
  }

  // Load stable token from disk if exists, otherwise generate
  const tokenPath = path.join(process.cwd(), '.acp-dev-token');
  let savedToken = null;
  if (!process.env.ACP_AUTH_TOKEN && fs.existsSync(tokenPath)) {
    try {
      savedToken = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {}
  }

  const generated = process.env.ACP_AUTH_TOKEN || savedToken || `dev_${crypto.randomBytes(16).toString('hex')}`;
  authConfig.activeToken = generated;
  authConfig.requireAuth = process.env.NODE_ENV === 'production' || process.env.ACP_AUTH_REQUIRED === 'true';

  try {
    if (!savedToken) {
      fs.writeFileSync(tokenPath, generated, { encoding: 'utf8', mode: 0o600 });
      logger.info({ tokenFile: '.acp-dev-token', requireAuth: authConfig.requireAuth }, '[Auth] Ephemeral dev token provisioned');
    } else {
      logger.info({ tokenFile: '.acp-dev-token', requireAuth: authConfig.requireAuth }, '[Auth] Persisted dev token loaded');
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[Auth] Could not write .acp-dev-token file');
  }

  return generated;
}

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

  const headerVal = req.headers.authorization || req.headers['x-acp-token'];
  const queryVal = typeof req.query?.token === 'string' ? req.query.token : null;
  const token = headerVal || queryVal;

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

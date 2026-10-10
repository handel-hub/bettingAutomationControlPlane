// @ts-check
import { Router } from 'express';
import { backendSyncService } from '../../sync/backendSyncService.mjs';
import { securityFacade } from '../../security-authority/facade.mjs';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { wsServer } from '../websocket/wsServer.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { resolveAuthoritativeLifecycleState } from '../../state/lifecycleStateResolver.mjs';

export const authRouter = Router();

/**
 * Helper to broadcast full updated prelude and domain snapshots after auth state change.
 */
async function broadcastAuthTransition() {
  const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
  const lifecycleState = resolveAuthoritativeLifecycleState({ billingSnapshot });

  try {
    const store = getSharedStateStore();
    store.preludeProjection.invalidate();
    const prelude = store.getPreludeSnapshot({
      lifecycleState,
      acpConnected: true,
      backendConnected: backendSyncService.isConnected
    });
    wsServer.broadcast('app:prelude', prelude);
  } catch { /* ignore */ }

  wsServer.broadcast('app:state', lifecycleState);
  wsServer.broadcast('billing:snapshot', billingSnapshot);

  try {
    const accountsView = await repositoryFactory.getAccountsRepo().list();
    wsServer.broadcast('accounts:view', accountsView);
  } catch { /* ignore */ }

  return { lifecycleState, billingSnapshot };
}

/**
 * GET /api/v1/auth/session
 * Returns current operator authentication and authorization state.
 */
authRouter.get('/session', async (_req, res) => {
  const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
  const lifecycleState = resolveAuthoritativeLifecycleState({ billingSnapshot });
  const session = securityFacade.getSessionInfo();
  const license = securityFacade.getLicenseInfo();

  res.json({
    authenticated: Boolean(session && session.status === 'AUTHENTICATED'),
    securityState: securityFacade.getSystemState(),
    lifecycleState,
    session: session
      ? {
          sessionId: session.sessionId,
          userId: session.userId,
          expiresAt: session.expiresAt
        }
      : null,
    license: license || null,
    billingStatus: billingSnapshot?.status || 'Payment_Required'
  });
});

/**
 * POST /api/v1/auth/login
 * Authenticates operator credentials against the authoritative Backend.
 */
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email and password are required.'
      });
    }

    const { authRes, securityResult } = await backendSyncService.authenticateOperator({
      email: String(email).trim(),
      password: String(password)
    });

    const { lifecycleState, billingSnapshot } = await broadcastAuthTransition();

    return res.status(200).json({
      authenticated: true,
      sessionId: authRes.sessionId,
      accountId: authRes.accountId,
      securityStatus: securityResult.status,
      lifecycleState,
      license: authRes.license || null,
      capabilities: authRes.capabilities || [],
      billingStatus: billingSnapshot?.status || 'Payment_Required'
    });
  } catch (err) {
    const status = err.status || (err.code === 'INVALID_CREDENTIALS' ? 401 : 401);
    return res.status(status).json({
      error: err.code || 'AUTHENTICATION_FAILED',
      message: err.message || 'Invalid credentials'
    });
  }
});

/**
 * POST /api/v1/auth/register
 * Registers a new operator account on the authoritative Backend and establishes an authenticated session.
 */
authRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email and password are required.'
      });
    }

    const { authRes, securityResult } = await backendSyncService.registerOperator({
      email: String(email).trim(),
      password: String(password),
      name: name ? String(name).trim() : undefined
    });

    const { lifecycleState, billingSnapshot } = await broadcastAuthTransition();

    return res.status(201).json({
      authenticated: true,
      sessionId: authRes.sessionId,
      accountId: authRes.accountId,
      securityStatus: securityResult.status,
      lifecycleState,
      license: authRes.license || null,
      capabilities: authRes.capabilities || [],
      billingStatus: billingSnapshot?.status || 'Payment_Required'
    });
  } catch (err) {
    const status = err.status || (err.code === 'ACCOUNT_ALREADY_EXISTS' ? 409 : 400);
    return res.status(status).json({
      error: err.code || 'REGISTRATION_FAILED',
      message: err.message || 'Account registration failed'
    });
  }
});

/**
 * POST /api/v1/auth/logout
 * Logs out the current operator session and scrubs local user-scoped state.
 */
authRouter.post('/logout', async (_req, res) => {
  try {
    await backendSyncService.logoutOperator();
    const { lifecycleState } = await broadcastAuthTransition();
    return res.status(200).json({
      authenticated: false,
      lifecycleState
    });
  } catch (err) {
    return res.status(500).json({
      error: 'LOGOUT_FAILED',
      message: err.message || 'Logout failed'
    });
  }
});

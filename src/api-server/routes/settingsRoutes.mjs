// @ts-check
import { Router } from 'express';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { wsServer } from '../websocket/wsServer.mjs';
import { backendClient } from '../../security-authority/protocol/backend-client.mjs';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res) => {
  const snapshot = await repositoryFactory.getSettingsRepo().getSnapshot();
  res.json(snapshot);
});

// POST settings intent with authoritative Step-Up challenge protocol
settingsRouter.post('/intent', async (req, res) => {
  const { type, payload = {}, stepUpSecret } = req.body || {};
  const requestId = `req_${Date.now()}`;

  if (!type) {
    return res.status(400).json({
      requestId,
      status: 'REJECTED',
      message: 'Missing intent type'
    });
  }

  // Check if intent requires Step-Up (including disabling MFA)
  const STEP_UP_REQUIRED = ['DELETE_ACCOUNT', 'UPDATE_PASSWORD', 'CHANGE_PASSWORD', 'CHANGE_EMAIL'];
  const requiresStepUp = STEP_UP_REQUIRED.includes(type) || (type === 'CONFIGURE_MFA' && payload?.enabled === false);
  if (requiresStepUp) {
    const providedSecret = stepUpSecret || payload?.currentPassword || null;
    if (!providedSecret) {
      return res.status(200).json({
        requestId,
        status: 'REQUIRES_STEP_UP',
        section: 'SECURITY',
        message: 'Step-up authorization required (current password or MFA token)'
      });
    }

    // Authoritative step-up verification via Backend (never accept hardcoded 'valid_secret' or length heuristics)
    if (!backendClient.sessionId) {
      return res.status(403).json({
        requestId,
        status: 'CHALLENGE_FAILED',
        section: 'SECURITY',
        message: 'Active authenticated backend session required for step-up verification'
      });
    }

    try {
      const backendAck = await backendClient.submitSettingsIntent({
        type,
        payload,
        stepUpSecret: providedSecret
      });
      if (!backendAck || (backendAck.status !== 'ACCEPTED' && backendAck.status !== 'APPLIED')) {
        return res.status(403).json({
          requestId: backendAck?.requestId || requestId,
          status: backendAck?.status || 'CHALLENGE_FAILED',
          section: backendAck?.section || 'SECURITY',
          message: backendAck?.message || 'Step-up verification failed'
        });
      }
    } catch (err) {
      return res.status(403).json({
        requestId,
        status: 'CHALLENGE_FAILED',
        section: 'SECURITY',
        message: err.message || 'Authoritative step-up verification failed'
      });
    }
  } else if (backendClient.sessionId) {
    try {
      await backendClient.submitSettingsIntent({ type, payload });
    } catch { /* non-sensitive preferences can still update local cache when offline */ }
  }

  // Process local state store mirror update
  const settingsRepo = repositoryFactory.getSettingsRepo();
  let section = 'PROFILE';

  switch (type) {
    case 'UPDATE_PROFILE':
      await settingsRepo.updateProfile({ name: payload.name });
      section = 'PROFILE';
      break;
    case 'CHANGE_EMAIL':
      await settingsRepo.updateProfile({ pendingEmail: payload.email });
      section = 'PROFILE';
      break;
    case 'UPDATE_NOTIFICATIONS':
      await settingsRepo.updateProfile(payload);
      section = 'NOTIFICATIONS';
      break;
    case 'UPDATE_PASSWORD':
    case 'CONFIGURE_MFA':
    case 'REVOKE_SESSIONS':
      section = 'SECURITY';
      break;
    case 'DELETE_ACCOUNT':
      await settingsRepo.updateSecurity({ accountStatus: 'PENDING_DELETION', deletionScheduledAt: new Date(Date.now() + 14 * 86400000).toISOString() });
      section = 'SECURITY';
      break;
    case 'CANCEL_DELETION':
      await settingsRepo.updateSecurity({ accountStatus: 'ACTIVE', deletionScheduledAt: null });
      section = 'SECURITY';
      break;
    case 'UPDATE_PRESENTATION':
    case 'UPDATE_PREFERENCES':
      await settingsRepo.updatePreferences(payload);
      section = 'PRESENTATION';
      break;
  }

  const updatedSnapshot = await settingsRepo.getSnapshot();
  wsServer.broadcast('settings:snapshot', updatedSnapshot);

  return res.json({
    requestId,
    status: 'ACCEPTED',
    section,
    data: updatedSnapshot,
    message: 'Intent applied successfully'
  });
});

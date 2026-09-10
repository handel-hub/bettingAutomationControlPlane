// @ts-check
import { Router } from 'express';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { wsServer } from '../websocket/wsServer.mjs';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res) => {
  const snapshot = await repositoryFactory.getSettingsRepo().getSnapshot();
  res.json(snapshot);
});

// POST settings intent with Step-Up challenge protocol
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

  // Check if intent requires Step-Up
  const STEP_UP_REQUIRED = ['DELETE_ACCOUNT', 'UPDATE_PASSWORD', 'CHANGE_EMAIL'];
  if (STEP_UP_REQUIRED.includes(type)) {
    if (!stepUpSecret) {
      return res.status(200).json({
        requestId,
        status: 'REQUIRES_STEP_UP',
        section: 'SECURITY',
        message: 'Step-up authorization required (current password or MFA token)'
      });
    }

    if (stepUpSecret !== 'valid_secret' && stepUpSecret.length < 6) {
      return res.status(200).json({
        requestId,
        status: 'CHALLENGE_FAILED',
        section: 'SECURITY',
        message: 'Invalid password or verification code'
      });
    }
  }

  // Process mutation
  const settingsRepo = repositoryFactory.getSettingsRepo();
  let section = 'PROFILE';

  switch (type) {
    case 'UPDATE_PROFILE':
      await settingsRepo.updateProfile({ name: payload.name });
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
      await settingsRepo.updateSecurity({ accountStatus: 'PENDING_DELETION', deletionScheduledAt: new Date(Date.now() + 7 * 86400000).toISOString() });
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

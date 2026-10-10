// @ts-check
import { Router } from 'express';
import { securityFacade } from '../../security-authority/facade.mjs';
import { CAPABILITY } from '../../security-authority/authorization/capabilities.mjs';

export const systemRouter = Router();

systemRouter.get('/version', (req, res) => {
  res.json({
    appName: 'Betting Automation Suite',
    currentVersion: 'v0.1.0-alpha',
    hasUpdateDownloaded: false,
    availableVersion: 'v0.2.0'
  });
});

systemRouter.post('/restart-and-update', (req, res) => {
  const authResult = securityFacade.authorize(CAPABILITY.CONFIG_MODIFY);
  if (authResult.status !== 'OPERATIONAL') {
    return res.status(403).json({
      success: false,
      code: 'CAP_001',
      error: authResult.message || 'Action prohibited by Security Authority'
    });
  }
  const { targetVersion } = req.body || {};
  return res.json({
    status: 'ACCEPTED',
    message: `Control Plane accepted restart request for ${targetVersion || 'v0.2.0'}.`
  });
});

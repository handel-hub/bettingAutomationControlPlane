// @ts-check
import { Router } from 'express';

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
  const { targetVersion } = req.body || {};
  res.json({
    status: 'ACCEPTED',
    message: `Control Plane accepted restart request for ${targetVersion || 'v0.2.0'}.`
  });
});

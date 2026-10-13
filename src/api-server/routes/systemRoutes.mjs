// @ts-check
import { Router } from 'express';
import { securityFacade } from '../../security-authority/facade.mjs';
import { CAPABILITY } from '../../security-authority/authorization/capabilities.mjs';

import os from 'node:os';
import { resolveSystemIPv4Addresses } from '../websocket/wsServer.mjs';

export const systemRouter = Router();

systemRouter.get('/network-endpoints', (req, res) => {
  const hostname = os.hostname().toLowerCase();
  const mdnsHostname = `${hostname}.local`;
  const ips = Array.from(resolveSystemIPv4Addresses()).filter(ip => ip !== '127.0.0.1');
  const port = 3000;
  res.json({
    hostname,
    mdnsHostname,
    mdnsUrl: `http://${mdnsHostname}:${port}`,
    ipv4Addresses: ips,
    lanUrls: ips.map(ip => `http://${ip}:${port}`),
    primaryUrl: `http://${mdnsHostname}:${port}`,
    fallbackUrl: ips.length > 0 ? `http://${ips[0]}:${port}` : `http://localhost:${port}`
  });
});

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

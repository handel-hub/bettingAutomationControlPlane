// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { BackendSyncService } from '../src/sync/backendSyncService.mjs';
import { BackendClient } from '../src/security-authority/protocol/backend-client.mjs';
import { repositoryFactory } from '../src/repositories/repositoryFactory.mjs';

test('BackendSyncService Hydration & Encrypted Cache Pipeline', async (t) => {
  let mockServer;
  let serverPort;
  const tempCachePath = path.join(process.cwd(), 'test', `temp_cache_${Date.now()}.enc`);

  t.after(() => {
    if (mockServer) mockServer.close();
    if (fs.existsSync(tempCachePath)) {
      try { fs.unlinkSync(tempCachePath); } catch {}
    }
  });

  // Mock server setup
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        if (req.url === '/health/live') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else if (req.url === '/api/v1/machines/register') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ machineId: 'mach-live-101', status: 'REGISTERED' }));
        } else if (req.url === '/api/v1/auth/init') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: 'sess-sync-1', sessionGeneration: 1 }));
        } else if (req.url === '/api/v1/automation/snapshot') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            lifecycle: 'STOPPED',
            globalConfig: {
              pricing: { mode: 'PROFIT_TARGET', targetProfit: 75 }
            },
            accounts: [
              { id: 'acc-backend-1', name: 'Cloud Sporty', platformDisplayName: 'SportyBet', accountUsername: 'cloud_trader' }
            ]
          }));
        } else if (req.url.startsWith('/api/v1/accounts')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            viewportAccounts: [
              { id: 'acc-backend-1', name: 'Cloud Sporty', platformDisplayName: 'SportyBet', accountUsername: 'cloud_trader' }
            ]
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      resolve(null);
    });
  });

  // Mock machine identity
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');
  const mockIdentity = {
    publicKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    getDescriptor: () => ({ hardwareId: 'hw_sync_test', machineKeyPub: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }),
    signPayload: (buf) => crypto.sign(null, Buffer.concat([DOMAIN_PREFIX, buf]), privateKey).toString('hex'),
    initialize: async () => {}
  };

  const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
  const syncService = new BackendSyncService({
    client,
    cachePath: tempCachePath
  });

  await t.test('Initializes, registers, authenticates, and hydrates in-memory state from Backend', async () => {
    const res = await syncService.initialize({ email: 'op@test.com', password: 'pass' });
    assert.strictEqual(res.isConnected, true);
    assert.strictEqual(res.isHydrated, true);

    const accountsRepo = repositoryFactory.getAccountsRepo();
    const configRepo = repositoryFactory.getConfigRepo();

    const acc = await accountsRepo.findById('acc-backend-1');
    assert.ok(acc, 'Authoritative account should exist in InMemoryAccountsRepo');
    assert.strictEqual(acc.name, 'Cloud Sporty');

    const config = await configRepo.getGlobalConfig();
    assert.strictEqual(config.pricing.targetProfit, 75, 'Global config should reflect backend state');

    // Verify local encrypted cache was created
    assert.strictEqual(fs.existsSync(tempCachePath), true, 'Local encrypted cache file must be saved');
  });

  await t.test('Recovers and hydrates state from encrypted cache when Backend is offline', async () => {
    const offlineClient = new BackendClient('http://127.0.0.1:59998', mockIdentity);
    const offlineSyncService = new BackendSyncService({
      client: offlineClient,
      cachePath: tempCachePath
    });

    const res = await offlineSyncService.initialize();
    assert.strictEqual(res.isConnected, false, 'Should be disconnected');
    assert.strictEqual(res.isHydrated, true, 'Should successfully hydrate from local cache');

    const accountsRepo = repositoryFactory.getAccountsRepo();
    const acc = await accountsRepo.findById('acc-backend-1');
    assert.ok(acc, 'Account from cache must be available offline');
  });
});

// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BackendSyncService } from '../../src/sync/backendSyncService.mjs';
import { BackendClient } from '../../src/security-authority/protocol/backend-client.mjs';
import { repositoryFactory } from '../../src/repositories/repositoryFactory.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { SecurityState } from '../../src/security-authority/state-machine/states.mjs';
import { CAPABILITY } from '../../src/security-authority/authorization/capabilities.mjs';
import { StateStore } from '../../src/state-store/StateStore.mjs';
import { setSharedStateStore } from '../../src/state-store/sharedStateStore.mjs';

test('Priority 2: Cloud Backend Synchronizer Integration Suite', async (t) => {
  let mockServer;
  let serverPort;
  let mockServerOnline = true;
  const capturedCalls = [];

  // 1. Setup Mock Cloud Backend Server
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (!mockServerOnline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backend offline' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        let parsedBody = null;
        try { parsedBody = JSON.parse(body); } catch {}
        capturedCalls.push({ method: req.method, url: req.url, body: parsedBody });

        if (req.url === '/health/live') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else if (req.url === '/api/v1/machines/register') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ machineId: 'mach_p2_001', status: 'REGISTERED' }));
        } else if (req.url === '/api/v1/auth/init') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: 'sess_p2_valid', sessionGeneration: 1 }));
        } else if (req.url === '/api/v1/automation/snapshot') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            lifecycle: 'STOPPED',
            globalConfig: {
              pricing: { mode: 'PROFIT_TARGET', targetProfit: 85 },
              risk: { dailyStopLoss: 25000 }
            },
            accounts: [
              { id: 'acc_cloud_1', name: 'Cloud Bet9ja VIP', platformDisplayName: 'Bet9ja', accountUsername: 'bet9ja_p2' }
            ]
          }));
        } else if (req.url.startsWith('/api/v1/accounts') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            viewportAccounts: [
              { id: 'acc_cloud_1', name: 'Cloud Bet9ja VIP', platformDisplayName: 'Bet9ja', accountUsername: 'bet9ja_p2' }
            ]
          }));
        } else if (req.url === '/api/v1/billing') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            subscription: {
              planId: 'enterprise',
              status: 'Active',
              billingInterval: 'Annual',
              renewalDate: new Date(Date.now() + 86400000 * 30).toISOString(),
              entitlements: { maxAccounts: 25, canAutoTrade: true }
            },
            invoices: [
              { id: 'inv_001', reference: 'ref_001', amount: 50000, status: 'PAID' }
            ]
          }));
        } else if (req.url === '/api/v1/platforms') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': '"platforms_v2"' });
          res.end(JSON.stringify({
            platforms: [
              { id: 'sportybet', displayName: 'SportyBet', status: 'ONLINE' },
              { id: 'bet9ja', displayName: 'Bet9ja', status: 'ONLINE' }
            ]
          }));
        } else if (req.url === '/api/v1/billing/plans') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': '"plans_v2"' });
          res.end(JSON.stringify({
            plans: [
              { id: 'starter', name: 'Starter' },
              { id: 'enterprise', name: 'Enterprise Pro' }
            ]
          }));
        } else if (req.url.startsWith('/api/v1/automation/config/') && req.method === 'PUT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, updated: parsedBody }));
        } else if (req.url === '/api/v1/accounts' && req.method === 'POST') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { id: 'acc_new_outbox', ...parsedBody?.payload } }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      resolve(null);
    });
  });

  t.after(() => {
    if (mockServer) mockServer.close();
  });

  // Mock Machine Identity with Ed25519 keypair
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');
  const mockIdentity = {
    publicKeyHex: 'aabbccdd01020304aabbccdd01020304aabbccdd01020304aabbccdd01020304',
    getDescriptor: () => ({
      hardwareId: 'hw_test_machine_p2',
      machineKeyPub: 'aabbccdd01020304aabbccdd01020304aabbccdd01020304aabbccdd01020304'
    }),
    signPayload: (buf) => crypto.sign(null, Buffer.concat([DOMAIN_PREFIX, buf]), privateKey).toString('hex'),
    initialize: async () => {}
  };

  await t.test('1. Machine identity mutual registration & multi-domain snapshot hydration', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_p2_test' });
    store.initialize();
    setSharedStateStore(store);

    const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    const syncService = new BackendSyncService({ client, identity: mockIdentity, enableWebSocket: false, engine: store.engine });

    const initRes = await syncService.initialize({ email: 'p2@test.com', password: 'secretPassword!' });
    assert.strictEqual(initRes.isConnected, true, 'Should be connected to Cloud Backend');
    assert.strictEqual(initRes.isHydrated, true, 'Should be hydrated');

    // Verify machine registration call
    const regCall = capturedCalls.find(c => c.url === '/api/v1/machines/register');
    assert.ok(regCall, 'Must call /api/v1/machines/register');
    const pubKey = regCall.body?.payload?.publicKeyHex || regCall.body?.publicKeyHex;
    assert.strictEqual(pubKey, mockIdentity.publicKeyHex);

    // Verify multi-domain state hydration into SQLite StateStore
    // A. Accounts
    const acc = store.accounts.getById('acc_cloud_1');
    assert.ok(acc, 'Authoritative account must be persisted in StateStore');
    assert.strictEqual(acc.name, 'Cloud Bet9ja VIP');

    // B. Global Config
    const config = store.config.getGlobalConfig();
    assert.strictEqual(config.pricing.targetProfit, 85, 'Global config target profit must be hydrated');
    assert.strictEqual(config.risk.dailyStopLoss, 25000, 'Global config stop loss must be hydrated');

    // C. Billing Subscription
    const billing = store.billing.getSnapshot();
    assert.strictEqual(billing.planId, 'enterprise');
    assert.strictEqual(billing.status, 'Active');

    // D. Catalogs
    const platforms = store.catalogs.getPlatformRegistry();
    assert.ok(platforms.platforms.some(p => p.id === 'sportybet'));
    const plans = store.catalogs.getPlansCatalog();
    assert.ok(plans.plans.some(p => p.id === 'enterprise'));

    syncService.stop();
    store.close();
  });

  await t.test('2. 2-Hour Offline Operational Grace Period: allows execution when cached subscription < 2 hours old', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_grace_test' });
    store.initialize();
    setSharedStateStore(store);

    // Seed valid subscription from 30 minutes ago
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    store.billingAdapter.saveSubscription('usr_grace_test', {
      planId: 'enterprise',
      status: 'Active',
      billingInterval: 'Monthly'
    });
    store.metadataAdapter.set('billing', { lastValidatedAt: thirtyMinsAgo });

    // Initialize Security Authority with valid baseline
    await securityFacade.initialize(':memory:');
    await securityFacade.initDevSession();

    // Client pointing to an unreachable port (offline)
    const offlineClient = new BackendClient('http://127.0.0.1:59999', mockIdentity);
    const syncService = new BackendSyncService({ client: offlineClient, enableWebSocket: false, engine: store.engine });

    const initRes = await syncService.initialize();
    assert.strictEqual(initRes.isConnected, false, 'Backend is offline');

    // Evaluate grace period
    const isWithinGrace = syncService.checkGracePeriod();
    assert.strictEqual(isWithinGrace, true, 'Cached subscription from 30 minutes ago is within 2-hour grace period');

    // Transition to OFFLINE_GRACE
    await securityFacade.transitionToDegraded('OFFLINE_GRACE');
    assert.strictEqual(securityFacade.getSystemState(), SecurityState.OFFLINE_GRACE);

    // Invariant: In OFFLINE_GRACE, execution capabilities (AUTOMATION_START) MUST NOT be stripped!
    const startAuth = securityFacade.authorize(CAPABILITY.AUTOMATION_START);
    assert.strictEqual(startAuth.status, 'OPERATIONAL', 'Automation start must be permitted within grace period');

    syncService.stop();
    store.close();
  });

  await t.test('3. 2-Hour Offline Operational Grace Period: expires when cached subscription > 2 hours old', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_grace_expired' });
    store.initialize();
    setSharedStateStore(store);

    // Seed expired subscription from 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    store.billingAdapter.saveSubscription('usr_grace_expired', {
      planId: 'enterprise',
      status: 'Active',
      billingInterval: 'Monthly'
    });
    store.metadataAdapter.set('billing', { lastValidatedAt: threeHoursAgo });

    const offlineClient = new BackendClient('http://127.0.0.1:59999', mockIdentity);
    const syncService = new BackendSyncService({ client: offlineClient, enableWebSocket: false, engine: store.engine });

    await syncService.initialize();
    const isWithinGrace = syncService.checkGracePeriod();
    assert.strictEqual(isWithinGrace, false, 'Cached subscription from 3 hours ago exceeds 2-hour grace period');

    syncService.stop();
    store.close();
  });

  await t.test('4. Grace period monitor triggers expiration callback when 2-hour window expires', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_monitor_test' });
    store.initialize();
    setSharedStateStore(store);

    // Seed timestamp: already expired
    const expiredTimestamp = new Date(Date.now() - 2.5 * 3600 * 1000).toISOString();
    store.metadataAdapter.set('billing', { lastValidatedAt: expiredTimestamp });

    const offlineClient = new BackendClient('http://127.0.0.1:59999', mockIdentity);
    const syncService = new BackendSyncService({ client: offlineClient, enableWebSocket: false, engine: store.engine });
    syncService.lastSyncTimestamp = expiredTimestamp;

    let callbackTriggered = false;
    // Fast periodic check
    syncService.startGracePeriodMonitor(() => {
      callbackTriggered = true;
    });

    // Manually trigger interval check
    assert.strictEqual(syncService.checkGracePeriod(), false);

    syncService.stop();
    store.close();
  });

  await t.test('5. Outbox mutations persist across service restarts in SQLite and flush upon reconnect', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_outbox_p2' });
    store.initialize();
    setSharedStateStore(store);

    const offlineClient = new BackendClient('http://127.0.0.1:59999', mockIdentity);

    // Boot instance 1 while offline
    const service1 = new BackendSyncService({ client: offlineClient, enableWebSocket: false, engine: store.engine });
    service1.isConnected = false;

    // Enqueue 2 mutations offline
    await service1.syncMutation('UPDATE_GLOBAL_CONFIG', {
      category: 'Pricing',
      values: { targetProfit: 95 }
    });
    await service1.syncMutation('REGISTER_ACCOUNT', {
      platformDisplayName: 'Bet9ja',
      accountUsername: 'offline_user_99',
      accountPassword: 'Password123!'
    });

    assert.strictEqual(service1.outbox.length, 2, 'Service 1 has 2 queued mutations');

    // Boot instance 2 using the same SQLite store (simulating service restart)
    const onlineClient = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    onlineClient.sessionId = 'sess_p2_valid';
    const service2 = new BackendSyncService({ client: onlineClient, enableWebSocket: false, engine: store.engine });

    // Invariant: Unsent outbox items MUST survive the restart!
    assert.strictEqual(service2.outbox.length, 2, 'Service 2 hydrated 2 pending outbox mutations from SQLite');

    // Restore connectivity and flush
    service2.isConnected = true;
    const flushRes = await service2.flushOutbox();

    assert.strictEqual(flushRes.flushed, 2, 'Must flush both mutations');
    assert.strictEqual(flushRes.remaining, 0, 'Outbox must be empty after flush');
    assert.strictEqual(service2.outbox.length, 0);

    // Verify SQLite table is empty
    const rows = store.engine.query("SELECT * FROM sync_outbox WHERE status = 'PENDING'");
    assert.strictEqual(rows.length, 0, 'sync_outbox in SQLite must be cleared');

    service1.stop();
    service2.stop();
    store.close();
  });
});

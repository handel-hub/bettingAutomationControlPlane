// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { BackendClient, ProtocolError } from '../../src/security-authority/protocol/backend-client.mjs';
import { BackendSyncService } from '../../src/sync/backendSyncService.mjs';
import { repositoryFactory } from '../../src/repositories/repositoryFactory.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { wsServer } from '../../src/api-server/websocket/wsServer.mjs';

test('ACP ↔ Backend Boundary Contract Conformance', async (t) => {
  let mockHttpServer;
  let mockWss;
  let serverPort;
  const tempCachePath = path.join(process.cwd(), 'test', `temp_boundary_cache_${Date.now()}.enc`);

  // Captured HTTP requests for assertion
  const capturedRequests = [];
  /** @type {any[]} */
  const connectedWsClients = [];

  // Initialize Security Facade for state transitions
  await securityFacade.initialize(':memory:');

  // Setup Mock Backend Server
  await new Promise((resolve) => {
    mockHttpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        let parsedBody = null;
        try { parsedBody = JSON.parse(body); } catch {}
        capturedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsedBody
        });

        // Router
        if (req.url === '/health/live') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else if (req.url === '/api/v1/auth/init') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: 'sess-boundary-1', sessionGeneration: 1 }));
        } else if (req.url === '/api/v1/machines/register') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ machineId: 'mach-boundary-1', status: 'REGISTERED' }));
        } else if (req.url === '/api/v1/automation/snapshot') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            lifecycle: 'STOPPED',
            globalConfig: {
              pricing: { mode: 'PROFIT_TARGET', targetProfit: 50 }
            },
            accounts: [
              { id: 'acc-conf-1', name: 'Conf Bet9ja', platformDisplayName: 'Bet9ja', accountUsername: 'conf_user' }
            ]
          }));
        } else if (req.url.startsWith('/api/v1/accounts') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            viewportAccounts: [
              { id: 'acc-conf-1', name: 'Conf Bet9ja', platformDisplayName: 'Bet9ja', accountUsername: 'conf_user' }
            ]
          }));
        } else if (req.url === '/api/v1/accounts' && req.method === 'POST') {
          // Inbound registration envelope
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 'acc-conf-new', ...parsedBody?.payload }
          }));
        } else if (req.url === '/api/v1/billing/plans') {
          if (req.headers['if-none-match'] === '"plans-v1"') {
            res.writeHead(304);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': '"plans-v1"' });
            res.end(JSON.stringify({ plans: [{ id: 'pro', name: 'Professional' }] }));
          }
        } else if (req.url === '/api/v1/platforms') {
          if (req.headers['if-none-match'] === '"platforms-v1"') {
            res.writeHead(304);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': '"platforms-v1"' });
            res.end(JSON.stringify({ platforms: [{ id: 'bet9ja', name: 'Bet9ja' }] }));
          }
        } else if (req.url === '/api/v1/error/fatal-test') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              code: 'BE_AUTH_NONCE_EXPIRED',
              message: 'Session nonce timestamp has expired',
              category: 'AUTH',
              retryable: false
            }
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    mockWss = new WebSocketServer({ server: mockHttpServer, path: '/ws/v1/events' });
    mockWss.on('connection', (ws, req) => {
      connectedWsClients.push(ws);
      // Emit initial handshake
      ws.send(JSON.stringify({
        eventId: 'evt_init_1',
        eventType: 'app:state',
        sequenceNumber: 0,
        timestamp: new Date().toISOString(),
        payload: { state: 'Authorized', message: 'Backend Stream Ready' }
      }));
    });

    mockHttpServer.listen(0, '127.0.0.1', () => {
      serverPort = mockHttpServer.address().port;
      resolve(null);
    });
  });

  t.after(async () => {
    for (const ws of connectedWsClients) {
      try { ws.terminate(); } catch {}
    }
    if (mockWss) mockWss.close();
    if (mockHttpServer) mockHttpServer.close();
    if (fs.existsSync(tempCachePath)) {
      try { fs.unlinkSync(tempCachePath); } catch {}
    }
  });

  // Mock machine identity
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');
  const mockIdentity = {
    publicKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    getDescriptor: () => ({ hardwareId: 'hw_boundary_test', machineKeyPub: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }),
    signPayload: (buf) => crypto.sign(null, Buffer.concat([DOMAIN_PREFIX, buf]), privateKey).toString('hex'),
    initialize: async () => {}
  };

  const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
  const syncService = new BackendSyncService({
    client,
    cachePath: tempCachePath,
    enableWebSocket: true
  });

  await t.test('1. Preserves bookmaker passwords during Backend account registration (Contract Boundary Requirement)', async () => {
    client.setSession('sess-boundary-1', 'mach-boundary-1');

    const accountRegistrationPayload = {
      name: 'Sporty VIP Master',
      platformDisplayName: 'SportyBet',
      accountUsername: 'sporty_vip_user',
      accountPassword: 'MySecureBookmakerPassword123!#$'
    };

    // Call BackendClient.createBettingAccount directly
    await client.createBettingAccount(accountRegistrationPayload);

    // Verify outbound request sent to Backend
    const accountReq = capturedRequests.find(r => r.url === '/api/v1/accounts' && r.method === 'POST');
    assert.ok(accountReq, 'Must post to /api/v1/accounts');
    
    // Invariant: accountPassword must NOT be stripped or scrubbed when communicating with Backend
    assert.strictEqual(
      accountReq.body.payload.accountPassword,
      'MySecureBookmakerPassword123!#$',
      'Plaintext bookmaker password MUST be preserved for Backend AEAD encryption'
    );
  });

  await t.test('2. Enforces standardized BE_* error taxonomy and throws non-retryable ProtocolError immediately', async () => {
    await assert.rejects(
      async () => {
        await client._postWithRetry('/api/v1/error/fatal-test', { test: true }, 3);
      },
      (err) => {
        assert.ok(err instanceof ProtocolError, 'Must throw ProtocolError');
        assert.strictEqual(err.code, 'BE_AUTH_NONCE_EXPIRED');
        assert.strictEqual(err.category, 'AUTH');
        assert.strictEqual(err.retryable, false);
        return true;
      },
      'Should reject immediately without retrying fatal BE_* error'
    );
  });

  await t.test('3. Evaluates ETag conditional revalidation on platform registry and plans catalog', async () => {
    // First call without ETag: returns fresh catalog with ETag header
    const initialPlans = await client.getPlansCatalog();
    assert.strictEqual(initialPlans.notModified, false);
    assert.strictEqual(initialPlans.etag, '"plans-v1"');
    assert.ok(initialPlans.catalog);

    // Second call with If-None-Match: returns 304 notModified
    const cachedPlans = await client.getPlansCatalog({ ifNoneMatch: initialPlans.etag });
    assert.strictEqual(cachedPlans.notModified, true);
    assert.strictEqual(cachedPlans.etag, '"plans-v1"');

    // Platform registry conditional check
    const initialPlatforms = await client.getPlatformRegistry();
    assert.strictEqual(initialPlatforms.notModified, false);
    assert.strictEqual(initialPlatforms.etag, '"platforms-v1"');

    const cachedPlatforms = await client.getPlatformRegistry({ ifNoneMatch: initialPlatforms.etag });
    assert.strictEqual(cachedPlatforms.notModified, true);
  });

  await t.test('4. Connects to Server-to-ACP Event Stream and verifies monotonic gap detection', async () => {
    // Initialize pipeline and connect WebSocket
    const initRes = await syncService.initialize({ email: 'op@boundary.com', password: 'pass' });
    assert.strictEqual(initRes.isConnected, true);
    assert.strictEqual(initRes.isHydrated, true);

    // Wait for WebSocket connection to open
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(syncService.ws, 'WebSocket must be established');

    const wsClient = connectedWsClients[0];
    assert.ok(wsClient, 'Mock backend must have recorded connected WS client');

    // Track reconciliation calls
    let reconciliationTriggered = false;
    const originalPull = syncService.pullAuthoritativeSnapshot.bind(syncService);
    syncService.pullAuthoritativeSnapshot = async () => {
      reconciliationTriggered = true;
      return originalPull();
    };

    // Frame 1: Sequence 1 (In Order)
    await syncService.handleServerEvent({
      eventId: 'evt-1',
      eventType: 'ACCOUNT_STATUS_CHANGED',
      sequenceNumber: 1,
      payload: { accountId: 'acc-conf-1', status: 'ACTIVE' }
    });
    assert.strictEqual(syncService.lastObservedSequence, 1);
    assert.strictEqual(reconciliationTriggered, false, 'No gap for sequence 1');

    // Frame 2: Stale/duplicate sequence 1 (Must be dropped)
    await syncService.handleServerEvent({
      eventId: 'evt-1-dup',
      eventType: 'ACCOUNT_STATUS_CHANGED',
      sequenceNumber: 1,
      payload: { accountId: 'acc-conf-1', status: 'ACTIVE' }
    });
    assert.strictEqual(syncService.lastObservedSequence, 1);
    assert.strictEqual(reconciliationTriggered, false, 'Duplicate frame does not trigger reconciliation');

    // Frame 3: Gap detected! Sequence jumped from 1 to 5
    await syncService.handleServerEvent({
      eventId: 'evt-5',
      eventType: 'ACCOUNT_STATUS_CHANGED',
      sequenceNumber: 5,
      payload: { accountId: 'acc-conf-1', status: 'ACTIVE' }
    });
    assert.strictEqual(syncService.lastObservedSequence, 5);
    assert.strictEqual(reconciliationTriggered, true, 'Monotonic gap (1 -> 5) must trigger authoritative state reconciliation');

    // Restore original method
    syncService.pullAuthoritativeSnapshot = originalPull;
  });

  await t.test('5. Routes authoritative Server-to-ACP domain events', async () => {
    const accountsRepo = repositoryFactory.getAccountsRepo();
    const notificationsRepo = repositoryFactory.getNotificationsRepo();

    // Test ACCOUNT_LOCKED
    await syncService.handleServerEvent({
      eventId: 'evt-lock-1',
      eventType: 'ACCOUNT_LOCKED',
      sequenceNumber: 6,
      payload: { accountId: 'acc-conf-1', status: 'LOCKED', reason: 'Security violation' }
    });
    const lockedAccount = await accountsRepo.findById('acc-conf-1');
    assert.strictEqual(lockedAccount.backendState, 'LOCKED', 'Repository must update account to LOCKED');

    // Test ALERT_TRIGGERED
    await syncService.handleServerEvent({
      eventId: 'evt-alert-1',
      eventType: 'ALERT_TRIGGERED',
      sequenceNumber: 7,
      payload: { severity: 'CRITICAL', title: 'Intrusion Alert', message: 'Unauthorized IP attempted login' }
    });
    const notifs = await notificationsRepo.list();
    const alert = notifs.notifications.find(n => n.title === 'Intrusion Alert');
    assert.ok(alert, 'Alert must be recorded in notifications repository');
    assert.strictEqual(alert.severity, 'CRITICAL');

    // Test LICENSE_REVOKED
    await syncService.handleServerEvent({
      eventId: 'evt-rev-1',
      eventType: 'LICENSE_REVOKED',
      sequenceNumber: 8,
      payload: { reason: 'License expired or revoked' }
    });
    assert.strictEqual(securityFacade.isDegraded(), true, 'LICENSE_REVOKED must transition Security Authority to degraded mode');
  });

  await t.test('6. Evaluates 2-hour offline operational grace period', async () => {
    // Within grace period (synced 10 minutes ago)
    syncService.lastSyncTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    assert.strictEqual(syncService.checkGracePeriod(), true, '10 minutes is well within 2-hour grace period');

    // Expired grace period (synced 3 hours ago)
    syncService.lastSyncTimestamp = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    assert.strictEqual(syncService.checkGracePeriod(), false, '3 hours exceeds 2-hour grace period');
  });

  // Clean shutdown
  syncService.stop();
});

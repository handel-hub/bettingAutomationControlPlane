// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiServer } from '../src/api-server/server.mjs';
import { authConfig, initIpcToken } from '../src/api-server/middleware/auth.mjs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { SecurityState } from '../src/security-authority/state-machine/states.mjs';
import { CAPABILITY } from '../src/security-authority/authorization/capabilities.mjs';
import { BackendClient, backendClient, ProtocolError, Errors } from '../src/security-authority/protocol/backend-client.mjs';
import { CanonicalSerializer } from '../src/security-authority/protocol/canonical-serializer.mjs';
import { BackendSyncService, backendSyncService } from '../src/sync/backendSyncService.mjs';
import { StateStore } from '../src/state-store/StateStore.mjs';
import { setSharedStateStore } from '../src/state-store/sharedStateStore.mjs';
import { resolveAuthoritativeLifecycleState } from '../src/state/lifecycleStateResolver.mjs';
import { PersistentClock } from '../src/security-authority/time/persistent-clock.mjs';
import { StorageAdapter } from '../src/security-authority/persistence/storage-adapter.mjs';
import { registerDefaultCommandHandlers } from '../src/command/registerCommands.mjs';

test('Phase 9: Production-Parity & Dev-Mode Elimination Verification Suite (TV-01 through TV-16)', async (t) => {
  registerDefaultCommandHandlers();
  // Setup Backend Ed25519 signing keypair for protocol envelope verification
  const { publicKey: backendPubKey, privateKey: backendPrivKey } = crypto.generateKeyPairSync('ed25519');
  process.env.PINNED_BACKEND_PUBKEY_HEX = backendPubKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');

  const buildSignedEnvelope = (payloadObj) => {
    const envelope = {
      version: 2,
      timestamp: new Date().toISOString(),
      server_epoch: 1,
      payload: payloadObj,
      generation: 1
    };
    const msg = Buffer.concat([DOMAIN_PREFIX, CanonicalSerializer.serializeBackendResponse(envelope)]);
    const sigHex = crypto.sign(null, msg, backendPrivKey).toString('hex');
    return { ...envelope, ...payloadObj, signatures: { '1': sigHex } };
  };

  // 1. TV-09 & WI-14: Verify initDevSession is completely removed from SecurityFacade
  await t.test('TV-09 / WI-14: SecurityFacade.initDevSession is deleted and runner.cjs enforces SHA-256 integrity by default', () => {
    // @ts-ignore
    assert.strictEqual(typeof securityFacade.initDevSession, 'undefined', 'initDevSession must not exist on securityFacade');

    const pkgJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    assert.ok(!pkgJson.scripts.dev.includes('--dev'), 'package.json dev script must not pass --dev');

    const runnerPath = path.join(process.cwd(), 'dist', 'runner.cjs');
    if (fs.existsSync(runnerPath)) {
      const runnerSource = fs.readFileSync(runnerPath, 'utf8');
      assert.ok(
        runnerSource.includes("process.env.ENFORCE_INTEGRITY !== 'false'"),
        'dist/runner.cjs must enforce bytecode SHA-256 integrity by default'
      );
    }
  });

  // 2. TV-10 & WI-04 & WI-15: StateStore starts empty and Migration 005 purges synthetic dev records
  await t.test('TV-10 / WI-04 / WI-15: StateStore starts with zero synthetic accounts and Migration 005 purges synthetic records', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_clean_boot' });
    store.initialize();

    const accounts = store.accounts.getAll();
    assert.strictEqual(accounts.length, 0, 'Fresh StateStore must not auto-seed synthetic acc-1 / acc-2');

    const billingSnap = store.billing.getSnapshot();
    assert.strictEqual(billingSnap.status, 'Payment_Required', 'Default billing status must be Payment_Required until hydrated');
    assert.strictEqual(billingSnap.currentPlan, 'None');

    // Verify Migration 005 logic on synthetic records
    const { migration005 } = await import('../src/state-store/schema/migrations/005_purge_synthetic_dev_records.mjs');
    store.engine.db.prepare(`
      INSERT INTO accounts_metadata_cache (account_id, user_id, platform_id, name, account_username, last_updated, last_synchronization)
      VALUES ('acc-1', 'default_operator', 'sportybet', 'Default Test Account 1', 'sporty_pro_01', datetime('now'), datetime('now'))
    `).run();
    store.engine.db.prepare(`
      INSERT INTO accounts_metadata_cache (account_id, user_id, platform_id, name, account_username, last_updated, last_synchronization)
      VALUES ('acc-real-99', 'usr_clean_boot', 'sportybet', 'Legit Account', 'legit_trader_99', datetime('now'), datetime('now'))
    `).run();

    // Run migration 005 up() directly
    migration005.up(store.engine);

    const remainingAcc1 = store.engine.db.prepare("SELECT * FROM accounts_metadata_cache WHERE account_id = 'acc-1'").get();
    const remainingReal = store.engine.db.prepare("SELECT * FROM accounts_metadata_cache WHERE account_id = 'acc-real-99'").get();

    assert.strictEqual(remainingAcc1, undefined, 'Synthetic acc-1 must be purged');
    assert.ok(remainingReal, 'Legitimate operator account must be preserved');
    store.close();
  });

  // 3. TV-08 & WI-05: PersistentClock & SQLite Security Authority Persistence
  await t.test('TV-08 / WI-05: PersistentClock persists monotonic reference and halts on clock rollback', async () => {
    await StorageAdapter.initDatabase(':memory:');
    const clock = new PersistentClock(StorageAdapter);

    await clock.initialize();
    const t1 = clock.now();
    assert.ok(t1 > 0, 'PersistentClock must return valid timestamp on initialization');
    assert.strictEqual(clock.isUncertain, false);

    // Simulate clock rollback by advancing the persisted time_anchor 60 seconds into the future and re-initializing
    await clock.updateAnchor(Date.now() + 60000);
    await clock.initialize();
    assert.strictEqual(clock.isUncertain, true, 'Clock must enter uncertain state on rollback');
    assert.throws(
      () => clock.now(),
      /SECURITY_STATE_UNCERTAIN: Clock rollback detected/,
      'PersistentClock.now() must throw SECURITY_STATE_UNCERTAIN when system clock rolls backward'
    );

    // Reset in-memory storage adapter for subsequent tests
    await StorageAdapter.initDatabase(':memory:');
  });

  // 4. TV-11 & WI-06: BackendSyncService Grace Period & Cache Timestamp Integrity
  await t.test('TV-11 / WI-06: BackendSyncService does not forge lastSyncTimestamp on cache load and enforces 2-hour grace window', async () => {
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_grace_verify' });
    store.initialize();
    setSharedStateStore(store);
    await securityFacade.initialize(':memory:');

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const mockIdentity = {
      publicKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      getDescriptor: () => ({ hardwareId: 'hw_grace_verify', machineKeyPub: '0123456789abcdef0123456789abcdef' }),
      signPayload: (buf) => crypto.sign(null, Buffer.concat([DOMAIN_PREFIX, buf]), privateKey).toString('hex'),
      initialize: async () => {}
    };

    const tempCache = path.join(process.cwd(), 'test', `temp_tv11_${Date.now()}.enc`);
    const offlineClient = new BackendClient('http://127.0.0.1:59997', mockIdentity);
    const syncService = new BackendSyncService({ client: offlineClient, cachePath: tempCache, enableWebSocket: false, engine: store.engine });

    // Without any prior validation timestamp, checkGracePeriod() MUST be false
    assert.strictEqual(syncService.checkGracePeriod(), false, 'Grace period must be false when never synced');

    // Save encrypted cache while lastSyncTimestamp is 4 hours ago
    const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    syncService.lastSyncTimestamp = fourHoursAgo;
    syncService.saveLocalCache();

    // Load into a new sync service instance while offline
    const syncService2 = new BackendSyncService({ client: offlineClient, cachePath: tempCache, enableWebSocket: false, engine: store.engine });
    syncService2.lastSyncTimestamp = fourHoursAgo;
    syncService2.loadLocalCache();

    assert.strictEqual(syncService2.lastSyncTimestamp, fourHoursAgo, 'loadLocalCache must preserve original lastSyncTimestamp and not overwrite with now()');
    assert.strictEqual(syncService2.checkGracePeriod(), false, 'Expired cached timestamp must fail 2-hour grace check');

    if (fs.existsSync(tempCache)) {
      try { fs.unlinkSync(tempCache); } catch {}
    }
    store.close();
  });

  // 5. TV-03, TV-04, TV-05, TV-06, TV-07: Full ACP API Server Security, Auth, Capability Gating, Step-Up, and Billing Verification
  await t.test('TV-03..TV-07: End-to-End ACP Ingress Auth, Interactive Login/Register, Capability Gating, Step-Up Verification, and Billing Promotion', async () => {
    let mockBackend;
    let backendPort;
    let mockLicenseStatus = 'PAYMENT_REQUIRED';
    let mockCapabilities = [];

    await new Promise((resolve) => {
      mockBackend = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch {}
          const payload = parsed.payload || parsed;

          if (req.url === '/health/live') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } else if (req.url === '/api/v1/machines/register') {
            const resp = buildSignedEnvelope({ machineId: 'mach_tv_01', status: 'REGISTERED' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resp));
          } else if (req.url === '/api/v1/auth/register' || req.url === '/api/v1/auth/init') {
            const resp = buildSignedEnvelope({
              sessionId: 'sess_tv_01',
              accountId: 'acc_tv_01',
              email: payload.email || 'test@betting.io',
              sessionGeneration: 1,
              nonceValidated: true,
              capabilities: mockCapabilities,
              license: { status: mockLicenseStatus }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resp));
          } else if (req.url === '/api/v1/billing/checkout/verify') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              verified: true,
              status: 'Authorized',
              planId: payload.planId || 'PRO',
              capabilities: Object.values(CAPABILITY),
              license: { status: 'VALID', planId: payload.planId || 'PRO' }
            }));
          } else if (req.url === '/api/v1/settings/intent') {
            // Backend step-up verification: reject 'valid_secret', accept only 'RealOperatorPass!123'
            if (payload.stepUpSecret !== 'RealOperatorPass!123') {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: { code: 'STEP_UP_VERIFICATION_FAILED', message: 'Invalid operator password for step-up verification', retryable: false }
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'APPLIED', section: 'SECURITY' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          }
        });
      });
      mockBackend.listen(0, '127.0.0.1', () => {
        backendPort = mockBackend.address().port;
        resolve(null);
      });
    });

    const store = new StateStore({ dbPath: ':memory:', userId: 'acc_tv_01' });
    store.initialize();
    setSharedStateStore(store);

    await securityFacade.initialize(':memory:');
    await securityFacade.transitionToUnauthenticated();

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const mockIdentity = {
      publicKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      getDescriptor: () => ({ hardwareId: 'hw_tv_01', machineKeyPub: '0123456789abcdef0123456789abcdef' }),
      signPayload: (buf) => crypto.sign(null, Buffer.concat([DOMAIN_PREFIX, buf]), privateKey).toString('hex'),
      initialize: async () => {}
    };

    const client = new BackendClient(`http://127.0.0.1:${backendPort}`, mockIdentity);
    backendClient.endpoint = `http://127.0.0.1:${backendPort}`;
    backendClient.machineIdentity = mockIdentity;
    backendClient.sessionId = 'sess_tv_01';
    backendClient.machineId = 'mach_tv_01';
    backendSyncService.client = client;
    backendSyncService.machineIdentity = mockIdentity;
    backendSyncService.enableWebSocket = false;
    backendSyncService.engine = store.engine;

    // Initialize IPC token and require auth
    const ipcToken = initIpcToken();
    assert.ok(ipcToken.length >= 16, 'initIpcToken must generate or load a valid IPC token');
    assert.strictEqual(authConfig.requireAuth, true, 'authConfig.requireAuth must be true after initIpcToken');

    const apiServer = new ApiServer();
    const acpPort = 8099;
    await apiServer.listen(acpPort, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${acpPort}`;
    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ipcToken}`
    };

    try {
      // TV-03: Request without IPC token is rejected with 401
      const unauthRes = await fetch(`${baseUrl}/api/v1/prelude`);
      assert.strictEqual(unauthRes.status, 401, 'Request without IPC token must return 401');

      // TV-04: Cold unauthenticated state resolves to 'Authentication_Required'
      assert.strictEqual(resolveAuthoritativeLifecycleState(), 'Authentication_Required');

      // TV-04 & TV-05: Register new user without active subscription -> lands in Payment_Required (AUTHENTICATED), NOT OPERATIONAL
      const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ email: 'newuser@betting.io', password: 'RealOperatorPass!123', name: 'New Operator' })
      });
      assert.strictEqual(regRes.status, 201);
      const regBody = await regRes.json();
      assert.strictEqual(regBody.lifecycleState, 'Payment_Required', 'Unpaid registered user must land in Payment_Required');
      assert.strictEqual(securityFacade.getSystemState(), SecurityState.AUTHENTICATED);
      assert.strictEqual(securityFacade.isOperational(), false);

      // TV-06: While in AUTHENTICATED (Payment_Required) without capabilities, mutating endpoints return 403 FORBIDDEN
      const blockedAccRes = await fetch(`${baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Test', platformDisplayName: 'SportyBet', accountUsername: 'u1', accountPassword: 'p1' })
      });
      assert.strictEqual(blockedAccRes.status, 403, 'POST /api/v1/accounts must be rejected with 403 when lacking CAP_ACCOUNT_MANAGE');

      const blockedReconcileRes = await fetch(`${baseUrl}/api/v1/system/restart-and-update`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({})
      });
      assert.strictEqual(blockedReconcileRes.status, 403, 'POST /api/v1/system/restart-and-update must be rejected with 403 when lacking CAP_CONFIG_MODIFY');

      // TV-05: Verify payment checkout promotes SecurityFacade to OPERATIONAL ('Authorized')
      const verifyRes = await fetch(`${baseUrl}/api/v1/billing/checkout/verify`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ reference: 'flw_ref_verified_001', planId: 'PRO' })
      });
      const verifyBody = await verifyRes.json();
      assert.strictEqual(verifyRes.status, 200, `verify failed: ${JSON.stringify(verifyBody)}`);
      assert.strictEqual(verifyBody.verified, true);
      assert.strictEqual(verifyBody.status, 'Authorized');
      assert.strictEqual(securityFacade.getSystemState(), SecurityState.OPERATIONAL, 'Verified checkout must promote SecurityFacade to OPERATIONAL');
      assert.strictEqual(resolveAuthoritativeLifecycleState(), 'Authorized');

      // TV-07: Step-Up Secret Verification rejects hardcoded 'valid_secret' and accepts only real verified password
      const fakeStepUpRes = await fetch(`${baseUrl}/api/v1/settings/intent`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ type: 'CHANGE_PASSWORD', payload: { newPassword: 'NewPass!456' }, stepUpSecret: 'valid_secret' })
      });
      assert.strictEqual(fakeStepUpRes.status, 403, "Hardcoded 'valid_secret' bypass must be rejected with 403");

      const realStepUpRes = await fetch(`${baseUrl}/api/v1/settings/intent`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ type: 'CHANGE_PASSWORD', payload: { newPassword: 'NewPass!456' }, stepUpSecret: 'RealOperatorPass!123' })
      });
      assert.strictEqual(realStepUpRes.status, 200, 'Authentic operator password must pass step-up verification');
      const realStepUpBody = await realStepUpRes.json();
      assert.strictEqual(realStepUpBody.status, 'ACCEPTED');
    } finally {
      authConfig.requireAuth = false;
      await apiServer.close();
      mockBackend.close();
      store.close();
    }
  });
});

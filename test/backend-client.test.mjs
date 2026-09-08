// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import crypto from 'crypto';
import { BackendClient, ProtocolError, Errors } from '../src/security-authority/protocol/backend-client.mjs';

test('BackendClient API & Resilient Connection Testing', async (t) => {
  let mockServer;
  let serverPort;
  let lastReceivedBody = null;
  let lastReceivedHeaders = null;
  let serverHandler = (req, res) => { res.writeHead(200); res.end(JSON.stringify({ status: 'ok' })); };

  // Setup mock server
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      lastReceivedHeaders = req.headers;
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { lastReceivedBody = JSON.parse(body); } catch { lastReceivedBody = body; }
        serverHandler(req, res);
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      resolve(null);
    });
  });

  t.after(() => {
    mockServer.close();
  });

  // Mock machine identity
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');
  const mockIdentity = {
    getDescriptor: () => ({ hardwareId: 'hw_mock_unit_1' }),
    signPayload: (buf) => {
      return crypto.sign(null, Buffer.concat([DOMAIN_PREFIX, buf]), privateKey).toString('hex');
    }
  };

  await t.test('checkHealth returns ok: true when backend is reachable', async () => {
    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    };

    const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    const health = await client.checkHealth();
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.status, 'ok');
  });

  await t.test('checkHealth returns ok: false when backend is down', async () => {
    const deadClient = new BackendClient('http://127.0.0.1:59999', mockIdentity);
    const health = await deadClient.checkHealth();
    assert.strictEqual(health.ok, false);
    assert.ok(health.status.includes('ECONNREFUSED') || health.status.includes('fetch'));
  });

  await t.test('registerMachine sends valid ProtocolEnvelopeV2 and sets machineId', async () => {
    serverHandler = (req, res) => {
      assert.strictEqual(req.url, '/api/v1/machines/register');
      assert.strictEqual(lastReceivedBody.version, 2);
      assert.strictEqual(lastReceivedBody.machineId, 'hw_mock_unit_1');
      assert.strictEqual(typeof lastReceivedBody.signature, 'string');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        machineId: 'backend-mach-uuid-99',
        status: 'REGISTERED'
      }));
    };

    const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    const res = await client.registerMachine(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'inst-uuid-1',
      'sig-dummy'
    );

    assert.strictEqual(res.machineId, 'backend-mach-uuid-99');
    assert.strictEqual(res.status, 'REGISTERED');
    assert.strictEqual(client.machineId, 'backend-mach-uuid-99');
  });

  await t.test('initAuth sets sessionId and updates clientGeneration', async () => {
    serverHandler = (req, res) => {
      assert.strictEqual(req.url, '/api/v1/auth/init');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessionId: 'sess-token-42',
        accountId: 'acc-uuid-100',
        sessionGeneration: 3,
        nonceValidated: true
      }));
    };

    const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    client.machineId = 'backend-mach-uuid-99';

    const res = await client.initAuth({ email: 'test@test.com', password: 'pass' });
    assert.strictEqual(res.sessionId, 'sess-token-42');
    assert.strictEqual(client.sessionId, 'sess-token-42');
    assert.strictEqual(client.clientGeneration, 3);
  });

  await t.test('Fatal protocol errors (e.g. NONCE_EXPIRED) throw immediately without retries', async () => {
    let callCount = 0;
    serverHandler = (req, res) => {
      callCount++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 'NONCE_EXPIRED', message: 'Nonce has expired' }
      }));
    };

    const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    await assert.rejects(
      async () => {
        await client._postWithRetry('/test/fatal', { test: true }, 3);
      },
      (err) => {
        assert.ok(err instanceof ProtocolError);
        assert.strictEqual(err.code, 'NONCE_EXPIRED');
        return true;
      }
    );

    assert.strictEqual(callCount, 1, 'Fatal error must not trigger retry loop');
  });

  await t.test('getAutomationSnapshot and getBettingAccounts pass session headers', async () => {
    serverHandler = (req, res) => {
      assert.strictEqual(req.headers['authorization'], 'Bearer sess-token-42');
      assert.strictEqual(req.headers['x-session-id'], 'sess-token-42');
      assert.strictEqual(req.headers['x-machine-id'], 'mach-1');

      if (req.url === '/api/v1/automation/snapshot') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          lifecycle: 'STOPPED',
          globalConfig: { pricing: { mode: 'PROFIT_TARGET' } },
          accounts: []
        }));
      } else if (req.url.startsWith('/api/v1/accounts')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          viewportAccounts: [{ id: 'acc-1', name: 'Sporty' }]
        }));
      }
    };

    const client = new BackendClient(`http://127.0.0.1:${serverPort}`, mockIdentity);
    client.setSession('sess-token-42', 'mach-1', 1);

    const snapshot = await client.getAutomationSnapshot();
    assert.strictEqual(snapshot.lifecycle, 'STOPPED');
    assert.strictEqual(snapshot.globalConfig.pricing.mode, 'PROFIT_TARGET');

    const accounts = await client.getBettingAccounts();
    assert.strictEqual(accounts.viewportAccounts.length, 1);
    assert.strictEqual(accounts.viewportAccounts[0].name, 'Sporty');
  });
});

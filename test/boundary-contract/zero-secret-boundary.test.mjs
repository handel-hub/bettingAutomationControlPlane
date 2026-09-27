// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../../src/api-server/server.mjs';
import { commandRouter } from '../../src/command/commandRouter.mjs';
import { repositoryFactory } from '../../src/repositories/repositoryFactory.mjs';
import { WebSocket } from 'ws';

test('Boundary Contract: Zero-Secret Masking Boundary', async (t) => {
  // Ensure command handler is registered
  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
    return repositoryFactory.getAccountsRepo().create(cmd.payload);
  });
  commandRouter.register('Persistence', 'ACCOUNT_ACTION', async () => ({ executed: true }));

  let createdAccountId = null;

  const server = new ApiServer();
  const port = 8094;
  await server.listen(port, '127.0.0.1');

  t.after(async () => {
    if (createdAccountId) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/v1/accounts/${createdAccountId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'DELETE_ACCOUNT' })
        });
      } catch {}
    }
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events`;

  await t.test('Account registration masks plaintext password to [PROTECTED] in HTTP response and WS delta', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const receivedDeltas = [];
    ws.on('message', (data) => {
      try {
        const env = JSON.parse(data.toString('utf8'));
        if (env.topic === 'accounts:delta') {
          receivedDeltas.push(env.payload);
        }
      } catch {}
    });

    const plaintextPassword = 'SuperSecretPlaintextPassword_XYZ!#$';
    const uniqueUser = `vault_user_${Date.now()}`;

    const res = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Zero Secret Test Account',
        platformDisplayName: 'Bet9ja',
        accountUsername: uniqueUser,
        accountPassword: plaintextPassword
      })
    });

    assert.equal(res.status, 201);
    const created = await res.json();
    createdAccountId = created.id;

    // Invariant: HTTP response MUST NOT return plaintext password
    assert.notEqual(created.accountPassword, plaintextPassword);
    assert.equal(created.accountPassword, '[PROTECTED]');

    // Wait for WS delta
    await new Promise((r) => setTimeout(r, 200));
    ws.terminate();

    const accountDelta = receivedDeltas.find(d => d.type === 'ACCOUNT_CREATED');
    assert.ok(accountDelta, 'Must receive ACCOUNT_CREATED delta');
    assert.notEqual(accountDelta.partialSnapshot.accountPassword, plaintextPassword);
    assert.equal(accountDelta.partialSnapshot.accountPassword, '[PROTECTED]');
  });

  await t.test('CAN-14: GET /api/v1/accounts and accounts:view never leak plaintext credentials or secret keys', async () => {
    // 1. Verify GET /api/v1/accounts (calling getAccountsView)
    const res = await fetch(`${baseUrl}/api/v1/accounts?limit=100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.viewportAccounts));

    const testAcc = body.viewportAccounts.find(a => a.id === createdAccountId);
    assert.ok(testAcc, 'Created account must be present in viewportAccounts');
    assert.equal(testAcc.accountPassword, '[PROTECTED]');
    assert.equal(testAcc.password, undefined);
    assert.equal(testAcc.rawPassword, undefined);
    assert.equal(testAcc.cookies, undefined);

    // Assert zero accounts across entire viewport contain non-protected password
    for (const acc of body.viewportAccounts) {
      assert.equal(acc.accountPassword, '[PROTECTED]');
      assert.equal(acc.password, undefined);
      assert.equal(acc.rawPassword, undefined);
      assert.equal(acc.cookies, undefined);
      assert.equal(acc.credentials, undefined);
    }

    // 2. Verify GET /api/v1/accounts/:id
    const singleRes = await fetch(`${baseUrl}/api/v1/accounts/${createdAccountId}`);
    assert.equal(singleRes.status, 200);
    const singleBody = await singleRes.json();
    assert.equal(singleBody.accountPassword, '[PROTECTED]');
    assert.equal(singleBody.password, undefined);
    assert.equal(singleBody.rawPassword, undefined);
    assert.equal(singleBody.cookies, undefined);

    // 3. Verify accounts:view broadcast on new WS connect
    const ws = new WebSocket(wsUrl);
    let accountsViewPayload = null;
    ws.on('message', (data) => {
      try {
        const env = JSON.parse(data.toString('utf8'));
        if (env.topic === 'accounts:view') {
          accountsViewPayload = env.payload;
        }
      } catch {}
    });

    await new Promise((resolve) => ws.on('open', resolve));
    await new Promise((r) => setTimeout(r, 200));
    ws.terminate();

    assert.ok(accountsViewPayload, 'Must receive initial accounts:view payload on WS connect');
    assert.ok(Array.isArray(accountsViewPayload.viewportAccounts));
    for (const acc of accountsViewPayload.viewportAccounts) {
      assert.equal(acc.accountPassword, '[PROTECTED]');
      assert.equal(acc.password, undefined);
      assert.equal(acc.rawPassword, undefined);
      assert.equal(acc.cookies, undefined);
    }
  });

  await t.test('CAN-15 / DEF-15: WebSocket rejects untrusted Origin (CSWSH Protection)', async () => {
    // 1. Connection with malicious origin https://evil.com MUST be rejected with HTTP 403
    const evilWs = new WebSocket(wsUrl, {
      headers: {
        Origin: 'https://evil.com'
      }
    });

    let evilRejected = false;
    let evilStatusCode = null;

    evilWs.on('unexpected-response', (req, res) => {
      evilRejected = true;
      evilStatusCode = res.statusCode;
    });

    await new Promise((resolve) => {
      evilWs.on('error', () => resolve(null));
      evilWs.on('close', () => resolve(null));
      evilWs.on('unexpected-response', () => resolve(null));
      setTimeout(resolve, 500);
    });

    assert.ok(evilRejected, 'WebSocket connection with Origin: https://evil.com MUST be rejected');
    assert.equal(evilStatusCode, 403, 'Rejection must be HTTP 403 Forbidden');

    // 2. Connection with allowed origin (http://localhost:3000) MUST succeed
    const legitWs = new WebSocket(wsUrl, {
      headers: {
        Origin: 'http://localhost:3000'
      }
    });

    let legitConnected = false;
    legitWs.on('open', () => {
      legitConnected = true;
      legitWs.close();
    });

    await new Promise((resolve) => {
      legitWs.on('close', resolve);
      legitWs.on('error', resolve);
      setTimeout(resolve, 500);
    });

    assert.ok(legitConnected, 'WebSocket connection with Origin: http://localhost:3000 must connect successfully');
  });
});

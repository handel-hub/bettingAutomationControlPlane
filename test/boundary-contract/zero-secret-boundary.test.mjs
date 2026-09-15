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
});

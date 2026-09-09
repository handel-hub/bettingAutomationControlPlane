// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../src/api-server/server.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { repositoryFactory } from '../src/repositories/repositoryFactory.mjs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { WebSocket } from 'ws';

test('Frontend <-> Control Plane End-to-End Interoperability Test', async (t) => {
  // Authorize all operations for testing
  // @ts-ignore
  securityFacade.authorize = () => ({ status: 'OPERATIONAL' });

  // Register necessary command handlers for tests
  commandRouter.register('Execution', 'START_AUTOMATION', async () => ({ started: true }));
  commandRouter.register('Execution', 'STOP_AUTOMATION', async () => ({ stopped: true }));
  commandRouter.register('Execution', 'PLACE_BET', async (cmd) => ({ operationId: cmd.payload?.operationId }));
  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
    return repositoryFactory.getAccountsRepo().create(cmd.payload);
  });
  commandRouter.register('Persistence', 'TOGGLE_BET_CYCLE', async (cmd) => {
    return repositoryFactory.getConfigRepo().updateAccountConfig(cmd.target, { betCycleEnabled: cmd.payload?.enabled });
  });
  commandRouter.register('Persistence', 'ACCOUNT_ACTION', async () => ({ executed: true }));
  commandRouter.register('Persistence', 'BULK_ACTION', async (cmd) => {
    return repositoryFactory.getAccountsRepo().bulkAction(cmd.payload?.type, cmd.payload?.accountIds);
  });

  const server = new ApiServer();
  const port = 8095;
  await server.listen(port);

  t.after(async () => {
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events`;

  // 1. Test WebSocket initial state delivery
  await t.test('WebSocket delivers complete initial hydration snapshot matching frontend stores', async () => {
    const ws = new WebSocket(wsUrl);

    const receivedTopics = await new Promise((resolve, reject) => {
      const messages = {};
      const timer = setTimeout(() => resolve(messages), 2000);

      ws.on('message', (data) => {
        try {
          const envelope = JSON.parse(data.toString('utf8'));
          messages[envelope.topic] = envelope.payload;
          if (
            messages['app:state'] &&
            messages['automation:snapshot'] &&
            messages['accounts:view'] &&
            messages['billing:snapshot'] &&
            messages['settings:snapshot'] &&
            messages['customerCare:snapshot']
          ) {
            clearTimeout(timer);
            resolve(messages);
          }
        } catch (e) {
          reject(e);
        }
      });

      ws.on('error', reject);
    });

    ws.terminate();

    assert.equal(receivedTopics['app:state'], 'Authorized', 'Expected app:state to be Authorized');
    assert.ok(receivedTopics['automation:snapshot'], 'Expected automation:snapshot');
    assert.ok(receivedTopics['accounts:view'], 'Expected accounts:view');
    assert.ok(Array.isArray(receivedTopics['accounts:view'].viewportAccounts), 'Expected viewportAccounts array');
    assert.ok(receivedTopics['billing:snapshot'], 'Expected billing:snapshot');
    assert.ok(receivedTopics['settings:snapshot'], 'Expected settings:snapshot');
    assert.ok(receivedTopics['customerCare:snapshot'], 'Expected customerCare:snapshot');
  });

  // 2. Test REST operations with real-time WebSocket broadcast propagation
  await t.test('REST operations trigger matching WebSocket deltas in real-time', async () => {
    const ws = new WebSocket(wsUrl);

    // Wait for connection to open
    await new Promise((resolve) => ws.on('open', resolve));

    const deltas = [];
    ws.on('message', (data) => {
      try {
        const envelope = JSON.parse(data.toString('utf8'));
        if (envelope.topic.includes('delta')) {
          deltas.push(envelope);
        }
      } catch (e) {}
    });

    // A. Start Automation via REST
    const startRes = await fetch(`${baseUrl}/api/v1/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(startRes.status, 200);

    // B. Register Account via REST
    const uniqueUsername = `test_interop_${Date.now()}`;
    const accRes = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Interop Test Account',
        platformDisplayName: 'Bet9ja',
        accountUsername: uniqueUsername,
        accountPassword: 'securePassword123'
      })
    });
    assert.equal(accRes.status, 201);
    const createdAccount = await accRes.json();
    assert.equal(createdAccount.accountUsername, uniqueUsername);

    // C. Toggle Bet Cycle
    const toggleRes = await fetch(`${baseUrl}/api/v1/automation/accounts/acc-1/bet-cycle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(toggleRes.status, 200);

    // Give 500ms for WebSocket delivery
    await new Promise((r) => setTimeout(r, 500));
    ws.terminate();

    const lifecycleDelta = deltas.find(d => d.topic === 'automation:delta' && d.payload?.type === 'LIFECYCLE_CHANGED');
    assert.ok(lifecycleDelta, 'Expected LIFECYCLE_CHANGED delta');
    assert.equal(lifecycleDelta.payload.lifecycle, 'RUNNING');

    const accountDelta = deltas.find(d => d.topic === 'accounts:delta' && d.payload?.type === 'ACCOUNT_CREATED');
    assert.ok(accountDelta, 'Expected ACCOUNT_CREATED delta');
    assert.equal(accountDelta.payload.partialSnapshot.accountUsername, uniqueUsername);

    const updateDelta = deltas.find(d => d.topic === 'automation:delta' && d.payload?.type === 'ACCOUNT_UPDATED');
    assert.ok(updateDelta, 'Expected ACCOUNT_UPDATED delta');
    assert.equal(updateDelta.payload.partialSnapshot.betCycleEnabled, false);
  });

  // 3. Test REST Account View query
  await t.test('GET /api/v1/accounts returns filtered and paginated results', async () => {
    const res = await fetch(`${baseUrl}/api/v1/accounts?offset=0&limit=10&filterQuery=`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.viewportAccounts));
    assert.ok(data.viewportAccounts.length > 0);
    assert.ok(data.bulkCapabilities);
    assert.ok(data.searchMetadata);
  });

  // 4. Test Settings Snapshot & Intent
  await t.test('Settings REST endpoints match frontend specifications', async () => {
    const snapRes = await fetch(`${baseUrl}/api/v1/settings`);
    assert.equal(snapRes.status, 200);
    const snap = await snapRes.json();
    assert.ok(snap.profile);
    assert.ok(snap.security);

    const intentRes = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'UPDATE_PROFILE',
        payload: { name: 'Updated Name' }
      })
    });
    assert.equal(intentRes.status, 200);
    const ack = await intentRes.json();
    assert.equal(ack.status, 'ACCEPTED');
  });
});

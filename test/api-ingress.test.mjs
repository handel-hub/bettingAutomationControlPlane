// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../src/api-server/server.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { WebSocket } from 'ws';

test('API Ingress & WebSocket Integration', async (t) => {
  // Register handlers in commandRouter
  commandRouter.register('Execution', 'START_AUTOMATION', async () => ({ started: true }));
  commandRouter.register('Execution', 'STOP_AUTOMATION', async () => ({ stopped: true }));
  commandRouter.register('Execution', 'PLACE_BET', async (cmd) => ({ operationId: cmd.payload?.operationId }));
  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async () => ({ registered: true }));
  commandRouter.register('Persistence', 'TOGGLE_BET_CYCLE', async () => ({ toggled: true }));
  commandRouter.register('Persistence', 'ACCOUNT_ACTION', async () => ({ executed: true }));
  commandRouter.register('Persistence', 'BULK_ACTION', async () => ({ bulkExecuted: true }));

  const server = new ApiServer();
  // Listen on random high port
  const port = 8090;
  await server.listen(port);

  t.after(async () => {
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Test GET /api/v1/automation/snapshot
  await t.test('GET /api/v1/automation/snapshot returns valid snapshot', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lifecycle, 'STOPPED');
    assert.ok(body.capabilities.canStartAutomation);
    assert.ok(Array.isArray(body.accounts));
  });

  // 2. Test POST /api/v1/automation/operations/place-bet returns 202 QUEUED
  await t.test('POST /api/v1/automation/operations/place-bet returns 202 QUEUED', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/operations/place-bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stake: 250, odds: 2.1 })
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.ok(body.operationId.startsWith('op_'));
    assert.equal(body.status, 'QUEUED');
  });

  // 3. Test PATCH /api/v1/automation/accounts/acc-1/bet-cycle
  await t.test('PATCH /api/v1/automation/accounts/acc-1/bet-cycle updates participation', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/accounts/acc-1/bet-cycle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accountId, 'acc-1');
    assert.equal(body.betCycleEnabled, false);
  });

  // 4. Test Settings Intent Step-Up Challenge
  await t.test('POST /api/v1/settings/intent responds with REQUIRES_STEP_UP for sensitive actions', async () => {
    const res = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'DELETE_ACCOUNT', payload: {} })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'REQUIRES_STEP_UP');
    assert.equal(body.section, 'SECURITY');
  });

  // 5. Test WebSocket handshake
  await t.test('WebSocket /ws/v1/events receives initial state handshake', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/events`);

    const receivedTopics = await new Promise((resolve, reject) => {
      const topics = [];
      const timer = setTimeout(() => resolve(topics), 1500);

      ws.on('message', (data) => {
        try {
          const envelope = JSON.parse(data.toString('utf8'));
          topics.push(envelope.topic);
          if (topics.includes('automation:snapshot') && topics.includes('billing:snapshot')) {
            clearTimeout(timer);
            resolve(topics);
          }
        } catch (e) {
          reject(e);
        }
      });

      ws.on('error', reject);
    });

    ws.terminate();
    assert.ok(receivedTopics.includes('app:state'), 'Missing app:state topic');
    assert.ok(receivedTopics.includes('automation:snapshot'), 'Missing automation:snapshot topic');
    assert.ok(receivedTopics.includes('billing:snapshot'), 'Missing billing:snapshot topic');
    assert.ok(receivedTopics.includes('settings:snapshot'), 'Missing settings:snapshot topic');
  });
});

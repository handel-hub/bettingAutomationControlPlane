// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../../src/api-server/server.mjs';
import { WebSocket } from 'ws';

test('Boundary Contract: Catalogs, Routes & WebSocket Heartbeat', async (t) => {
  const server = new ApiServer();
  const port = 8093;
  await server.listen(port, '127.0.0.1');

  t.after(async () => {
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events`;

  await t.test('GET /api/v1/platforms returns PlatformRegistrySnapshot', async () => {
    const res = await fetch(`${baseUrl}/api/v1/platforms`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-protocol-version'), '2.0');
    const data = await res.json();
    assert.ok(data.defaultPlatformId);
    assert.ok(Array.isArray(data.platforms));
    assert.ok(data.platforms.some(p => p.id === 'sportybet'));
  });

  await t.test('GET /api/v1/billing/plans returns SubscriptionPlansCatalog', async () => {
    const res = await fetch(`${baseUrl}/api/v1/billing/plans`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-protocol-version'), '2.0');
    const data = await res.json();
    assert.ok(data.defaultPlanId);
    assert.ok(Array.isArray(data.plans));
    assert.ok(data.plans.some(p => p.id === 'starter'));
  });

  await t.test('GET /api/v1/automation/strategy-catalog returns AutomationStrategyCatalog', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/strategy-catalog`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-protocol-version'), '2.0');
    const data = await res.json();
    assert.ok(Array.isArray(data.pricingModes));
    assert.ok(Array.isArray(data.resolutionStrategies));
    assert.ok(Array.isArray(data.proxyAllocationModes));
    assert.ok(Array.isArray(data.slaveModes));
  });

  await t.test('POST /api/v1/notifications/:id/read and POST /read-all function and broadcast deltas', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const deltas = [];
    ws.on('message', (data) => {
      try {
        const env = JSON.parse(data.toString('utf8'));
        if (env.topic === 'notifications:delta') {
          deltas.push(env.payload);
        }
      } catch {}
    });

    // 1. POST /:id/read
    const readRes = await fetch(`${baseUrl}/api/v1/notifications/notif-1/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(readRes.status, 200);

    // 2. POST /read-all
    const readAllRes = await fetch(`${baseUrl}/api/v1/notifications/read-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(readAllRes.status, 200);

    await new Promise((r) => setTimeout(r, 200));
    ws.terminate();

    assert.ok(deltas.some(d => d.type === 'NOTIFICATION_READ' && d.id === 'notif-1'));
    assert.ok(deltas.some(d => d.type === 'ALL_READ'));
  });

  await t.test('POST /api/v1/settings/intent handles UPDATE_PRESENTATION', async () => {
    const res = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'UPDATE_PRESENTATION',
        payload: { theme: 'dark', density: 'compact' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ACCEPTED');
    assert.equal(data.data.presentationPreferences.theme, 'dark');
    assert.equal(data.data.presentationPreferences.density, 'compact');
  });

  await t.test('WebSocket system:ping responds with system:pong heartbeat', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const pongReceived = new Promise((resolve) => {
      ws.on('message', (data) => {
        try {
          const env = JSON.parse(data.toString('utf8'));
          if (env.topic === 'system:pong') {
            resolve(env.payload);
          }
        } catch {}
      });
    });

    ws.send(JSON.stringify({ topic: 'system:ping' }));

    const pong = await pongReceived;
    assert.equal(pong.status, 'PONG');
    assert.ok(pong.serverTime);
    ws.terminate();
  });
});

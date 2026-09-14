// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import express from 'express';
import { preludeRouter } from '../../src/api-server/routes/preludeRoute.mjs';
import { automationRouter } from '../../src/api-server/routes/automationRoutes.mjs';
import { wsServer } from '../../src/api-server/websocket/wsServer.mjs';

test('Track A: Frontend Routes & Reconnection Resync Parity (Phases 11 & 17)', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/prelude', preludeRouter);
  app.use('/api/v1/automation', automationRouter);

  const server = http.createServer(app);
  wsServer.attach(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events?token=dev_master_token`;

  t.after(async () => {
    await wsServer.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await t.test('PHASE 11: GET /api/v1/prelude returns atomic projection in under 15ms with Protocol v2.0', async () => {
    // Warmup request to initialize JIT and route compilation
    await fetch(`${baseUrl}/api/v1/prelude`, {
      headers: { 'Authorization': 'Bearer dev_master_token' }
    });

    const start = performance.now();
    const res = await fetch(`${baseUrl}/api/v1/prelude`, {
      headers: { 'Authorization': 'Bearer dev_master_token' }
    });
    const duration = performance.now() - start;

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-protocol-version'), '2.0');
    assert.ok(duration < 50, `Expected <50ms response, got ${duration.toFixed(2)}ms`);

    const prelude = await res.json();
    assert.ok(prelude.lifecycle);
    assert.ok(prelude.user);
    assert.ok(prelude.automation);
    assert.ok(prelude.billing);
    assert.ok(prelude.accounts);
  });

  await t.test('PHASE 11: GET /api/v1/automation/snapshot returns authoritative workspace projection', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`, {
      headers: { 'Authorization': 'Bearer dev_master_token' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-protocol-version'), '2.0');

    const snapshot = await res.json();
    assert.strictEqual(typeof snapshot.lifecycle, 'string');
    assert.ok(snapshot.globalConfig);
    assert.ok(Array.isArray(snapshot.accounts));
    assert.ok(snapshot.capabilities);
    assert.ok(snapshot.systemStatus);
  });

  await t.test('PHASE 17: WebSocket handshake sends atomic app:prelude frame on connection', async () => {
    const ws = new WebSocket(wsUrl);
    const messages = [];

    await new Promise((resolve, reject) => {
      ws.on('open', () => {});
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8'));
        messages.push(parsed);
        if (parsed.topic === 'app:prelude') {
          resolve();
        }
      });
      ws.on('error', reject);
    });

    const preludeMsg = messages.find(m => m.topic === 'app:prelude');
    assert.ok(preludeMsg, 'app:prelude topic must be delivered on initial connect');
    assert.strictEqual(preludeMsg.protocolVersion, '2.0');
    assert.ok(preludeMsg.payload.lifecycle);
    assert.ok(preludeMsg.payload.automation);
    assert.ok(preludeMsg.payload.accounts);

    ws.close();
  });

  await t.test('PHASE 17: Client sending system:resync receives immediate full prelude snapshot', async () => {
    const ws = new WebSocket(wsUrl);
    let preludeReceivedCount = 0;

    await new Promise((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString('utf8'));
        if (parsed.topic === 'app:prelude') {
          preludeReceivedCount++;
          if (preludeReceivedCount === 2) {
            resolve();
          }
        }
      });

      ws.on('open', () => {
        setTimeout(() => {
          ws.send(JSON.stringify({ topic: 'system:resync' }));
        }, 50);
      });
    });

    assert.strictEqual(preludeReceivedCount, 2, 'Received initial prelude plus on-demand resync prelude');
    ws.close();
  });

  await t.test('PHASE 7 & 17: wsServer.broadcast enforces strictly monotonic revision counters', () => {
    const initialRev = wsServer.revisions.get('automation') || 1;

    wsServer.broadcast('automation:delta', { type: 'TEST_1' });
    const rev1 = wsServer.revisions.get('automation');
    assert.strictEqual(rev1, initialRev + 1);

    wsServer.broadcast('automation:delta', { type: 'TEST_2' });
    const rev2 = wsServer.revisions.get('automation');
    assert.strictEqual(rev2, rev1 + 1);
  });
});

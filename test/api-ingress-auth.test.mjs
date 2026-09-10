// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../src/api-server/server.mjs';
import { authConfig } from '../src/api-server/middleware/auth.mjs';
import { WebSocket } from 'ws';

test('API Ingress Authentication & Token Security Boundary', async (t) => {
  const server = new ApiServer();
  const port = 8098;
  await server.listen(port, '127.0.0.1');

  // Enforce auth for this test suite
  const originalRequireAuth = authConfig.requireAuth;
  const originalToken = authConfig.activeToken;
  authConfig.requireAuth = true;
  authConfig.activeToken = 'test-secret-token-xyz-12345';

  t.after(async () => {
    authConfig.requireAuth = originalRequireAuth;
    authConfig.activeToken = originalToken;
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test('Unauthenticated request to protected endpoint returns 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'UNAUTHORIZED');
  });

  await t.test('Request with invalid Bearer token returns 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`, {
      headers: {
        'Authorization': 'Bearer wrong-token-value'
      }
    });
    assert.equal(res.status, 401);
  });

  await t.test('Request with valid Bearer token returns 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`, {
      headers: {
        'Authorization': 'Bearer test-secret-token-xyz-12345'
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.capabilities);
  });

  await t.test('Request with valid X-ACP-Token header returns 200 OK', async () => {
    const res = await fetch(`${baseUrl}/api/v1/automation/snapshot`, {
      headers: {
        'X-ACP-Token': 'test-secret-token-xyz-12345'
      }
    });
    assert.equal(res.status, 200);
  });

  await t.test('WebSocket connection without token is closed with 4401 Unauthorized', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/events`);
    const closePromise = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    const { code, reason } = await closePromise;
    assert.equal(code, 4401);
    assert.equal(reason, 'Unauthorized');
  });

  await t.test('WebSocket connection with valid token query parameter connects successfully', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/events?token=test-secret-token-xyz-12345`);
    const openPromise = new Promise((resolve, reject) => {
      ws.on('open', () => resolve(true));
      ws.on('error', reject);
    });

    const opened = await openPromise;
    assert.equal(opened, true);
    ws.close();
  });
});

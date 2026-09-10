// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../../src/api-server/server.mjs';
import { WebSocket } from 'ws';

test('Boundary Contract: Prelude Handshake & Atomic Projections', async (t) => {
  const server = new ApiServer();
  const port = 8092;
  await server.listen(port, '127.0.0.1');

  t.after(async () => {
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events`;

  await t.test('WebSocket connection delivers atomic app:prelude frame alongside domain snapshots', async () => {
    const ws = new WebSocket(wsUrl);

    const received = await new Promise((resolve, reject) => {
      const messages = {};
      const timer = setTimeout(() => resolve(messages), 3000);

      ws.on('message', (data) => {
        try {
          const envelope = JSON.parse(data.toString('utf8'));
          messages[envelope.topic] = envelope.payload;
          if (messages['app:prelude'] && messages['automation:snapshot']) {
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

    // 1. Verify app:prelude structure
    const prelude = received['app:prelude'];
    assert.ok(prelude, 'Must receive app:prelude');
    assert.equal(prelude.lifecycle.state, 'Authorized');
    assert.ok(prelude.protocol.protocolVersion);
    assert.ok(prelude.billing.snapshot);
    assert.ok(prelude.billing.plansCatalog);
    assert.ok(prelude.accounts.platformRegistry);
    assert.ok(prelude.accounts.initialView);
    assert.ok(prelude.automation.snapshot);
    assert.ok(prelude.automation.strategyCatalog);
    assert.ok(prelude.settings.snapshot);
    assert.ok(prelude.support.snapshot);
    assert.ok(Array.isArray(prelude.notifications.items));
    assert.ok(prelude.system.version);

    // 2. Verify backward-compatible domain snapshots delivered simultaneously
    assert.equal(received['app:state'], 'Authorized');
    assert.ok(received['automation:snapshot']);
    assert.ok(received['billing:snapshot']);
    assert.ok(received['billing:plans']);
    assert.ok(received['platforms:registry']);
    assert.ok(received['automation:strategy']);
    assert.ok(received['accounts:view']);
  });

  await t.test('GET /api/v1/prelude returns complete atomic PreludeSnapshot', async () => {
    const res = await fetch(`${baseUrl}/api/v1/prelude`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-protocol-version'), '2.0');

    const prelude = await res.json();
    assert.ok(prelude.protocol);
    assert.ok(prelude.billing.plansCatalog);
    assert.ok(prelude.accounts.platformRegistry);
    assert.ok(prelude.automation.strategyCatalog);
    assert.ok(prelude.settings.snapshot);
  });
});

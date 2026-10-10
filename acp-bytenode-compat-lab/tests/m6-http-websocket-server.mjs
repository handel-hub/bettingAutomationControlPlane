// acp-bytenode-compat-lab/tests/m6-http-websocket-server.mjs
// M6: Express HTTP & WebSocket loopback server compatibility tests

import http from 'node:http';
import { WebSocket } from 'ws';
import { ApiServer } from '../../src/api-server/server.mjs';
import { initDevToken, authConfig } from '../../src/api-server/middleware/auth.mjs';
import { wsServer } from '../../src/api-server/websocket/wsServer.mjs';

export function registerM6Tests(harness) {
  let serverInstance = null;
  let boundPort = 0;
  let token = null;

  harness.test('M6-001', 'ApiServer start & listen on ephemeral port', 'M6-HttpWsServer', async () => {
    token = initDevToken();

    serverInstance = new ApiServer();
    await serverInstance.listen(0, '127.0.0.1');

    boundPort = serverInstance.server.address().port;
    if (!boundPort || boundPort <= 0) {
      throw new Error(`Failed to bind ephemeral port: ${boundPort}`);
    }

    return { boundPort, tokenAvailable: Boolean(token) };
  });

  harness.test('M6-002', 'Express HTTP ingress route dispatch', 'M6-HttpWsServer', async () => {
    if (!boundPort) throw new Error('Server not bound');

    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: boundPort,
        path: '/api/v1/system/version',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-ACP-Token': token,
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('error', reject);
      req.end();
    });

    if (result.status !== 200) {
      throw new Error(`Expected HTTP 200, received ${result.status}: ${result.body}`);
    }

    return { httpStatus: result.status, receivedBytes: result.body.length };
  });

  harness.test('M6-003', 'WebSocket stream connection & broadcast delivery', 'M6-HttpWsServer', async () => {
    if (!boundPort) throw new Error('Server not bound');

    const wsUrl = `ws://127.0.0.1:${boundPort}/ws/v1/events?token=${token}`;
    const ws = new WebSocket(wsUrl);

    const received = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket broadcast timeout after 5000ms'));
      }, 5000);

      ws.on('open', () => {
        // Broadcast delta from server
        setTimeout(() => {
          wsServer.broadcast('automation:delta', {
            type: 'COMPAT_TEST_PULSE',
            timestamp: Date.now(),
          });
        }, 50);
      });

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.topic === 'automation:delta' || parsed.payload?.type === 'COMPAT_TEST_PULSE') {
            clearTimeout(timer);
            ws.close();
            resolve(parsed);
          }
        } catch (_) {}
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    return { wsReceived: true, event: received.event || received.type };
  });

  harness.test('M6-004', 'ApiServer clean teardown & port release', 'M6-HttpWsServer', async () => {
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = null;
    }
    return { closed: true };
  });
}

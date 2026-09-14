// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiServer } from '../../src/api-server/server.mjs';
import { runtimeManager } from '../../src/runtime-manager/runtime-manager.mjs';
import { executionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { NativeCore } from '../../src/security-authority/native/security-core.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { registerDefaultCommandHandlers } from '../../src/index.mjs';
import { initDevToken } from '../../src/api-server/middleware/auth.mjs';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Phase 20: Full End-to-End Multi-Process Integration Test', async (t) => {
  NativeCore.init();
  const devToken = initDevToken();
  // @ts-ignore
  securityFacade.authorize = () => ({ status: 'OPERATIONAL' });
  // @ts-ignore
  securityFacade.isDegraded = () => false;

  registerDefaultCommandHandlers();

  // Configure runtimeManager to spawn the mock orchestrated worker
  const workerScript = path.resolve(__dirname, '..', 'fixtures', 'mock-orchestrated-worker.mjs');
  const originalSpawn = runtimeManager.spawnRuntime.bind(runtimeManager);
  runtimeManager.spawnRuntime = (script) => {
    return originalSpawn(script || workerScript);
  };

  const server = new ApiServer();
  const port = 8098;
  await server.listen(port, '127.0.0.1');

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events?token=${devToken}`;

  t.after(async () => {
    runtimeManager.terminateAll();
    executionBoundaryManager.stopServer();
    NativeCore.stopSecurePipeServer();
    await server.close();
    runtimeManager.spawnRuntime = originalSpawn;
  });

  await t.test('executes complete business lifecycle: Prelude -> Register -> Start -> Bet -> Stop', async () => {
    // 1. Connect WebSocket client & receive app:prelude
    const ws = new WebSocket(wsUrl);
    const receivedTopics = new Map();
    const deltas = [];

    ws.on('message', (data) => {
      try {
        const env = JSON.parse(data.toString('utf8'));
        receivedTopics.set(env.topic, env.payload);
        if (env.topic && env.topic.includes('delta')) {
          deltas.push(env);
        }
      } catch {}
    });

    await new Promise((resolve) => ws.on('open', resolve));

    // Await initial prelude
    const startPreludeWait = Date.now();
    while (!receivedTopics.has('app:prelude') && Date.now() - startPreludeWait < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(receivedTopics.has('app:prelude'), 'WebSocket client must receive atomic app:prelude frame');

    // 2. Register Account via REST
    const username = `e2e_user_${Date.now()}`;
    const accRes = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${devToken}`
      },
      body: JSON.stringify({
        name: 'E2E Account',
        platformDisplayName: 'Bet9ja',
        accountUsername: username,
        accountPassword: 'Password123!'
      })
    });
    assert.equal(accRes.status, 201);
    const createdAcc = await accRes.json();
    assert.equal(createdAcc.accountPassword, '[PROTECTED]');

    // 3. Start Automation via REST (Spawns worker process via IPC)
    const startRes = await fetch(`${baseUrl}/api/v1/automation/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${devToken}`
      },
      body: JSON.stringify({})
    });
    assert.equal(startRes.status, 200);

    // Wait for worker process connection & running state
    const startRunningWait = Date.now();
    while (runtimeManager.activeConnections.size === 0 && Date.now() - startRunningWait < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(runtimeManager.activeConnections.size, 1, 'Child process must connect and authenticate over IPC');

    // 4. Place Bet via REST
    const betTrace = `e2e-bet-trace-${Date.now()}`;
    const betRes = await fetch(`${baseUrl}/api/v1/automation/operations/place-bet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${devToken}`,
        'X-Trace-Id': betTrace
      },
      body: JSON.stringify({
        marketId: 'mkt-e2e-1',
        odds: 1.85,
        stake: 200,
        idempotencyKey: `idem_${betTrace}`,
        accountId: createdAcc.id
      })
    });
    assert.equal(betRes.status, 202);
    const betData = await betRes.json();
    assert.ok(betData.operationId);

    // 5. Stop Automation via REST
    const stopRes = await fetch(`${baseUrl}/api/v1/automation/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${devToken}`
      },
      body: JSON.stringify({})
    });
    assert.equal(stopRes.status, 200);

    // Give 500ms for clean child exit
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(runtimeManager.activeRuntimes.size, 0, 'Worker child process must terminate cleanly');

    ws.terminate();
  });
});

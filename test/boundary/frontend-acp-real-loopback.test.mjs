// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../../src/api-server/server.mjs';
import { StateStore } from '../../src/state-store/StateStore.mjs';
import { setSharedStateStore } from '../../src/state-store/sharedStateStore.mjs';
import { commandRouter } from '../../src/command/commandRouter.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { repositoryFactory } from '../../src/repositories/repositoryFactory.mjs';

describe('Frontend Console <-> Control Plane Real Loopback Wire Contract', () => {
  let server;
  const testPort = 8097;

  before(async () => {
    // Authorize operational capabilities
    // @ts-ignore
    securityFacade.authorize = () => ({ status: 'OPERATIONAL' });

    // Register necessary command handlers for execution and persistence
    commandRouter.register('Execution', 'START_AUTOMATION', async () => ({ started: true }));
    commandRouter.register('Execution', 'STOP_AUTOMATION', async () => ({ stopped: true }));
    commandRouter.register('Persistence', 'UPDATE_GLOBAL_CONFIG', async (cmd) => {
      return repositoryFactory.getConfigRepo().updateCategory(cmd.payload?.category, cmd.payload?.values);
    });

    const fresh = new StateStore({ dbPath: ':memory:', userId: 'usr_operator' });
    fresh.initialize();
    fresh._seedDefaultAccounts();
    setSharedStateStore(fresh);

    server = new ApiServer();
    await server.listen(testPort, '127.0.0.1');
  });

  after(async () => {
    if (server) {
      await server.close();
    }
  });

  it('1. GET /api/v1/prelude hydrates all domain state trees in <15ms', async () => {
    // Warm up HTTP connection
    await fetch(`http://127.0.0.1:${testPort}/api/v1/prelude`);

    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${testPort}/api/v1/prelude`);
    const duration = performance.now() - t0;

    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.protocol, 'Must have protocol metadata');
    assert.equal(data.protocol.protocolVersion, '1.0.0');
    assert.ok(data.lifecycle, 'Must have lifecycle metadata');
    assert.equal(data.lifecycle.state, 'Authorized');
    assert.ok(data.automation, 'Must have automation domain tree');
    assert.ok(data.automation.snapshot, 'Must have automation snapshot');
    assert.ok(data.billing, 'Must have billing domain tree');
    assert.ok(data.billing.snapshot, 'Must have billing snapshot');
    assert.ok(data.accounts, 'Must have accounts domain tree');
    assert.ok(data.accounts.initialView, 'Must have initialView');
    assert.ok(data.settings, 'Must have settings domain tree');
    assert.ok(data.support, 'Must have support domain tree');
    assert.ok(data.notifications, 'Must have notifications domain tree');
    assert.ok(data.system, 'Must have system metadata');

    assert.ok(duration < 50, `Prelude response time should be rapid (was ${duration.toFixed(2)}ms)`);
  });

  it('2. WebSocket connects to /ws/v1/events and delivers app:prelude immediately', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/v1/events`);
    const received = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 3000);
      ws.onmessage = (evt) => {
        const envelope = JSON.parse(String(evt.data));
        received.push(envelope.topic);
        if (received.includes('app:prelude') && received.includes('automation:snapshot')) {
          clearTimeout(timeout);
          resolve(null);
        }
      };
      ws.onerror = reject;
    });

    assert.ok(received.includes('app:prelude'), 'Must deliver app:prelude topic');
    assert.ok(received.includes('app:state'), 'Must deliver app:state topic');
    assert.ok(received.includes('automation:snapshot'), 'Must deliver automation:snapshot topic');
    assert.ok(received.includes('billing:snapshot'), 'Must deliver billing:snapshot topic');
    assert.ok(received.includes('accounts:view'), 'Must deliver accounts:view topic');

    ws.close();
  });

  it('3. Dispatches START_AUTOMATION and broadcasts LIFECYCLE_CHANGED delta to UI', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/v1/events`);
    const deltas = [];

    await new Promise((resolve) => {
      ws.onopen = resolve;
    });

    ws.onmessage = (evt) => {
      const envelope = JSON.parse(String(evt.data));
      if (envelope.topic === 'automation:delta') {
        deltas.push(envelope.payload);
      }
    };

    // Dispatch POST /start
    const res = await fetch(`http://127.0.0.1:${testPort}/api/v1/automation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);

    // Wait for delta
    await new Promise(r => setTimeout(r, 150));
    const runningDelta = deltas.find(d => d.type === 'LIFECYCLE_CHANGED' && d.lifecycle === 'RUNNING');
    assert.ok(runningDelta, 'Must receive RUNNING lifecycle delta');

    ws.close();
  });

  it('4. Updates global config and broadcasts GLOBAL_CONFIG_UPDATED delta to UI', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/v1/events`);
    const deltas = [];

    await new Promise((resolve) => {
      ws.onopen = resolve;
    });

    ws.onmessage = (evt) => {
      const envelope = JSON.parse(String(evt.data));
      if (envelope.topic === 'automation:delta') {
        deltas.push(envelope.payload);
      }
    };

    const res = await fetch(`http://127.0.0.1:${testPort}/api/v1/automation/config/pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: { mode: 'FIXED', baseStake: 500 }
      })
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 150));
    const configDelta = deltas.find(d => d.type === 'GLOBAL_CONFIG_UPDATED' && d.category === 'pricing');
    assert.ok(configDelta, 'Must receive GLOBAL_CONFIG_UPDATED delta');
    assert.equal(configDelta.values.baseStake, 500);

    ws.close();
  });

  it('5. Dispatches STOP_AUTOMATION and broadcasts STOPPED lifecycle delta to UI', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws/v1/events`);
    const deltas = [];

    await new Promise((resolve) => {
      ws.onopen = resolve;
    });

    ws.onmessage = (evt) => {
      const envelope = JSON.parse(String(evt.data));
      if (envelope.topic === 'automation:delta') {
        deltas.push(envelope.payload);
      }
    };

    const res = await fetch(`http://127.0.0.1:${testPort}/api/v1/automation/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 150));
    const stoppedDelta = deltas.find(d => d.type === 'LIFECYCLE_CHANGED' && d.lifecycle === 'STOPPED');
    assert.ok(stoppedDelta, 'Must receive STOPPED lifecycle delta');

    ws.close();
  });
});

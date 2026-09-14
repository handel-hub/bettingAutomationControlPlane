// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ExecutionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { RuntimeManager } from '../../src/runtime-manager/runtime-manager.mjs';
import { StateStore } from '../../src/state-store/StateStore.mjs';
import { NativeCore } from '../../src/security-authority/native/security-core.mjs';
import { executionAuthorization } from '../../src/runtime-manager/execution-authorization.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';

test('Execution Boundary Lifecycle & Failure Handling (Phase 7)', async (t) => {
  NativeCore.init();
  executionAuthorization.canStartAutomation = () => true;
  securityFacade.isDegraded = () => false;

  await t.test('ExecutionBoundaryManager rejects pending correlations and resets observed states upon transport disconnect', async () => {
    class MockTransport extends EventEmitter {
      constructor() {
        super();
        this._connected = true;
      }
      startServer() {}
      stopServer() { this._connected = false; }
      broadcast() { return 1; }
      isConnected() { return this._connected; }
      getActiveConnections() { return this._connected ? [1] : []; }
    }

    const transport = new MockTransport();
    const store = new StateStore({ dbPath: ':memory:', userId: 'usr_phase7' });
    store.initialize();
    store.lifecycle.setDesiredState('RUNNING', 'TEST_START');
    store.lifecycle.setObservedState('RUNNING', 'TEST_RUNNING');

    const boundary = new ExecutionBoundaryManager({
      transport: /** @type {any} */ (transport),
      stateStore: store
    });

    // Dispatch a command with waitForAck
    const pendingPromise = boundary.dispatchEnvelope('TACTICAL:PLACE_BET', { stake: 100 }, { waitForAck: true, timeoutMs: 5000 });

    assert.strictEqual(boundary.pendingCorrelations.size, 1, 'One pending correlation should be registered');

    // Simulate pipe disconnect
    transport._connected = false;
    transport.emit('disconnection', 1);

    // Verify correlation rejects with pipe disconnect error
    await assert.rejects(
      pendingPromise,
      /Execution Plane disconnected while waiting for correlation/
    );
    assert.strictEqual(boundary.pendingCorrelations.size, 0, 'Pending correlations should be cleared');

    // Verify StateStore observedState transitioned to ABORTED (desired was RUNNING)
    const lifecycleState = store.lifecycle.getState();
    assert.strictEqual(lifecycleState.desiredState, 'RUNNING');
    assert.strictEqual(lifecycleState.observedState, 'ABORTED');

    store.close();
  });

  await t.test('RuntimeManager enforces handshake timeout and terminates child process if unauthenticated', async () => {
    const rm = new RuntimeManager();
    let timeoutFired = false;

    rm.on('handshakeTimeout', ({ pid }) => {
      timeoutFired = true;
    });

    rm.ensureServerStarted = () => {};

    // Spawn with a short 50ms handshake timeout
    const pid = rm.spawnRuntime(undefined, undefined, { handshakeTimeoutMs: 50 });
    assert.ok(pid > 0);
    assert.strictEqual(rm.engineStatus, 'STARTING');

    // Wait 150ms for timeout to fire
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(timeoutFired, 'handshakeTimeout event should have fired');
    assert.strictEqual(rm.engineStatus, 'ABORTED', 'Engine status should transition to ABORTED');

    rm.terminateAll();
  });
});

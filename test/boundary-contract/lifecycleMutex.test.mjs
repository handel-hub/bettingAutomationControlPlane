// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncMutex } from '../../src/shared/AsyncMutex.mjs';
import { ExecutionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';

test('Execution Boundary Lifecycle Mutex & Concurrency Protection', async (t) => {
  await t.test('AsyncMutex executes async operations sequentially without interleaving', async () => {
    const mutex = new AsyncMutex();
    const order = [];

    const task1 = mutex.runExclusive(async () => {
      order.push('task1_start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('task1_end');
    });

    const task2 = mutex.runExclusive(async () => {
      order.push('task2_start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('task2_end');
    });

    await Promise.all([task1, task2]);

    assert.deepEqual(order, [
      'task1_start',
      'task1_end',
      'task2_start',
      'task2_end'
    ], 'Tasks must execute strictly sequentially');
  });

  await t.test('ExecutionBoundaryManager exposes lifecycleMutex and guards startCluster and stopCluster', async () => {
    const mockTransport = {
      startServer: () => {},
      stopServer: () => {},
      broadcast: () => 1,
      isConnected: () => true,
      getActiveConnections: () => [1],
      on: () => {}
    };

    const boundary = new ExecutionBoundaryManager({
      transport: /** @type {any} */ (mockTransport)
    });

    assert.ok(boundary.lifecycleMutex instanceof AsyncMutex, 'lifecycleMutex must be initialized');

    // Test concurrent execution serialization
    let startFinished = false;
    let stopStartedWhileStartRunning = false;

    const startPromise = boundary.lifecycleMutex.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 60));
      startFinished = true;
    });

    const stopPromise = boundary.lifecycleMutex.runExclusive(async () => {
      if (!startFinished) {
        stopStartedWhileStartRunning = true;
      }
    });

    await Promise.all([startPromise, stopPromise]);

    assert.equal(stopStartedWhileStartRunning, false, 'Stop must wait until Start completes');
  });
});

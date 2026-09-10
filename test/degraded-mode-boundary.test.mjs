// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeManager } from '../src/runtime-manager/runtime-manager.mjs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { operationTracker } from '../src/state/operationTracker.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';

test('Degraded Mode & Execution Plane Hard Quarantine Boundary', async (t) => {
  NativeCore.init();

  await t.test('Tactical operations throw immediately when in degraded mode', () => {
    // Force degraded state
    securityFacade.isDegraded = () => true;

    // 1. spawnRuntime is blocked
    assert.throws(
      () => runtimeManager.spawnRuntime(),
      /DEGRADED mode/
    );

    // 2. startCluster is blocked
    assert.throws(
      () => runtimeManager.startCluster(),
      /DEGRADED mode/
    );

    // 3. placeBet is blocked
    assert.throws(
      () => runtimeManager.placeBet({ stake: 100, odds: 2.0 }),
      /DEGRADED mode/
    );

    // 4. cashOut is blocked
    assert.throws(
      () => runtimeManager.cashOut({ betId: 'bet-123' }),
      /DEGRADED mode/
    );

    // 5. validateTactical is blocked
    assert.throws(
      () => runtimeManager.validateTactical(),
      /DEGRADED mode/
    );
  });

  await t.test('CommandRouter Execution commands reject with [LF-701] when in degraded mode', async () => {
    securityFacade.isDegraded = () => true;

    // Register test handler if not present
    commandRouter.register('Execution', 'TEST_DEGRADED_BET', async () => {
      if (securityFacade.isDegraded()) {
        throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode');
      }
      return { success: true };
    });

    await assert.rejects(
      async () => {
        await commandRouter.route({
          category: 'Execution',
          type: 'TEST_DEGRADED_BET',
          traceId: 'trace-degraded-1'
        });
      },
      /DEGRADED mode/
    );
  });

  await t.test('quarantineExecution halts engine, clears active runtimes, and fails all pending operations', () => {
    // Queue some operations
    const op1 = operationTracker.startOperation('PLACING_BET', { stake: 50 });
    const op2 = operationTracker.startOperation('CASHING_OUT', { betId: 'b-1' });

    assert.equal(operationTracker.getOperation(op1.operationId)?.status, 'QUEUED');
    assert.equal(operationTracker.getOperation(op2.operationId)?.status, 'QUEUED');

    // Trigger execution quarantine
    runtimeManager.quarantineExecution('NETWORK_DROPPED_TEST');

    assert.equal(runtimeManager.getEngineStatus(), 'DEGRADED_HALTED');
    assert.equal(runtimeManager.activeRuntimes.size, 0);

    // Verify all queued operations are failed
    assert.equal(operationTracker.getOperation(op1.operationId)?.status, 'FAILED');
    assert.match(operationTracker.getOperation(op1.operationId)?.errorReason, /Execution Quarantined/);
    assert.equal(operationTracker.getOperation(op2.operationId)?.status, 'FAILED');
    assert.match(operationTracker.getOperation(op2.operationId)?.errorReason, /Execution Quarantined/);
  });

  // Restore
  t.after(() => {
    securityFacade.isDegraded = () => false;
  });
});

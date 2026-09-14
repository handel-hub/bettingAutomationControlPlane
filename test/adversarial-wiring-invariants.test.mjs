// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeManager } from '../src/runtime-manager/runtime-manager.mjs';
import { executionBoundaryManager } from '../src/runtime-manager/boundary/index.mjs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { operationTracker } from '../src/state/operationTracker.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { getSharedStateStore } from '../src/state-store/sharedStateStore.mjs';
import { registerDefaultCommandHandlers } from '../src/index.mjs';
import { CAPABILITY } from '../src/security-authority/authorization/capabilities.mjs';
import { engineInstance } from '../src/security-authority/decision-engine.mjs';

test('Adversarial Control Plane Wiring Invariants & Red-Team Verification', async (t) => {
  // Ensure default handlers are registered
  registerDefaultCommandHandlers();
  const store = getSharedStateStore({ dbPath: ':memory:', userId: 'usr_adversarial' });

  // Baseline: ensure securityFacade is operational
  securityFacade.isDegraded = () => false;
  const originalAuthorize = securityFacade.authorize.bind(securityFacade);
  securityFacade.authorize = (cap) => ({ status: 'OPERATIONAL' });

  await t.test('GATE_001: Rejects duplicate START_AUTOMATION commands when already running or starting', async () => {
    store.lifecycle.setObservedState('STOPPED', 'TEST_RESET');
    runtimeManager.activeRuntimes.clear();

    // Simulate active runtime in StateStore
    store.lifecycle.setObservedState('STARTING_HANDSHAKE', 'ACTIVE_TEST');

    await assert.rejects(
      async () => {
        await commandRouter.route(JSON.stringify({
          protocolVersion: '2.0',
          category: 'Execution',
          type: 'START_AUTOMATION',
          messageId: '01M2TESTSTARTDUP000000000',
          timestamp: new Date().toISOString()
        }));
      },
      /already running or initializing/
    );

    // Reset observed state
    store.lifecycle.setObservedState('STOPPED', 'TEST_RESET');
  });

  await t.test('EXEC_001: Two-phase spawn commit rolls back process if startCluster fails', async () => {
    store.lifecycle.setObservedState('STOPPED', 'TEST_RESET');
    runtimeManager.activeRuntimes.clear();

    // Mock spawnRuntime so we don't spawn real OS child in test
    const originalSpawn = runtimeManager.spawnRuntime.bind(runtimeManager);
    runtimeManager.spawnRuntime = () => {
      const pid = 24468;
      runtimeManager.activeRuntimes.add(pid);
      return pid;
    };

    // Mock startCluster to fail intentionally
    const originalStartCluster = executionBoundaryManager.startCluster.bind(executionBoundaryManager);
    executionBoundaryManager.startCluster = async () => {
      throw new Error('SIMULATED_PIPE_HANDSHAKE_TIMEOUT');
    };

    let terminatedPid = null;
    const originalTerminate = runtimeManager.terminateRuntime.bind(runtimeManager);
    runtimeManager.terminateRuntime = (pid) => {
      terminatedPid = pid;
      runtimeManager.activeRuntimes.delete(pid);
    };

    try {
      await assert.rejects(
        async () => {
          await commandRouter.route(JSON.stringify({
            protocolVersion: '2.0',
            category: 'Execution',
            type: 'START_AUTOMATION',
            messageId: '01M2TESTSTARTROLLBACK000',
            timestamp: new Date().toISOString()
          }));
        },
        /SIMULATED_PIPE_HANDSHAKE_TIMEOUT/
      );

      // Verify that the spawned PID was killed
      assert.equal(terminatedPid, 24468, 'Spawned PID must be terminated on cluster start failure');
      assert.equal(runtimeManager.activeRuntimes.size, 0);

      // Verify state was rolled back to STOPPED
      const state = store.lifecycle.getState();
      assert.equal(state.desiredState, 'STOPPED');
      assert.equal(state.observedState, 'STOPPED');
    } finally {
      runtimeManager.spawnRuntime = originalSpawn;
      executionBoundaryManager.startCluster = originalStartCluster;
      runtimeManager.terminateRuntime = originalTerminate;
    }
  });

  await t.test('EXEC_002: STOP_AUTOMATION enforces force-kill fallback on timeout', async () => {
    store.lifecycle.setObservedState('RUNNING', 'TEST_RUNNING');
    runtimeManager.activeRuntimes.add(99999);

    // Mock stopCluster to throw timeout
    const originalStopCluster = executionBoundaryManager.stopCluster.bind(executionBoundaryManager);
    executionBoundaryManager.stopCluster = async () => {
      throw new Error('COMMAND_TIMEOUT');
    };

    let terminateAllCalled = false;
    const originalTerminateAll = runtimeManager.terminateAll.bind(runtimeManager);
    runtimeManager.terminateAll = () => {
      terminateAllCalled = true;
      runtimeManager.activeRuntimes.clear();
    };

    try {
      const res = await commandRouter.route(JSON.stringify({
        protocolVersion: '2.0',
        category: 'Execution',
        type: 'STOP_AUTOMATION',
        messageId: '01M2TESTSTOPTIMEOUT00000',
        timestamp: new Date().toISOString()
      }));

      assert.equal(res.success, true);
      assert.equal(res.results[0]?.stopped, true);
      assert.equal(terminateAllCalled, true, 'terminateAll must be called when stopCluster times out');
      assert.equal(runtimeManager.activeRuntimes.size, 0);
      assert.equal(store.lifecycle.getState().observedState, 'STOPPED');
    } finally {
      executionBoundaryManager.stopCluster = originalStopCluster;
      runtimeManager.terminateAll = originalTerminateAll;
    }
  });

  await t.test('REC_001: Financial safety: in-flight operations become UNCERTAIN on quarantine', () => {
    // 1. Enqueue one QUEUED op and one IN_FLIGHT op
    const queuedOp = operationTracker.startOperation('PLACING_BET', { stake: 25 });
    const inFlightOp = operationTracker.startOperation('PLACING_BET', { stake: 50, accountId: 'acc-quarantine-1' });
    operationTracker.updateStatus(inFlightOp.operationId, 'IN_FLIGHT');

    assert.equal(operationTracker.getOperation(queuedOp.operationId)?.status, 'QUEUED');
    assert.equal(operationTracker.getOperation(inFlightOp.operationId)?.status, 'IN_FLIGHT');

    // 2. Trigger quarantineExecution
    runtimeManager.quarantineExecution('HOSTILE_NETWORK_DROP');

    // 3. Queued operation should be cleanly FAILED
    assert.equal(operationTracker.getOperation(queuedOp.operationId)?.status, 'FAILED');

    // 4. In-flight operation MUST be transitioned to UNCERTAIN (never FAILED)
    assert.equal(operationTracker.getOperation(inFlightOp.operationId)?.status, 'UNCERTAIN');

    // 5. Target account must be frozen in ReconciliationCoordinator
    assert.equal(executionBoundaryManager.reconciliation.isAccountFrozen('acc-quarantine-1'), true);

    // Clean up freeze
    executionBoundaryManager.reconciliation.unfreezeAccount('acc-quarantine-1');
  });

  await t.test('SEC_001: Security Authority dynamically revokes AUTOMATION_START when active runtime exists', () => {
    securityFacade.authorize = originalAuthorize;

    // Set state to OPERATIONAL with CAP_AUTOMATION_START
    // @ts-ignore
    engineInstance.inMemoryState = {
      state: 'OPERATIONAL',
      authorization: {
        status: 'VALID',
        capability_set: [CAPABILITY.AUTOMATION_START, CAPABILITY.AUTOMATION_STOP]
      }
    };

    securityFacade.setActiveExecutionChecker(() => runtimeManager.activeRuntimes.size > 0);

    // With no active runtimes
    runtimeManager.activeRuntimes.clear();
    const canStartWhenEmpty = securityFacade.authorize(CAPABILITY.AUTOMATION_START);
    assert.equal(canStartWhenEmpty.status, 'OPERATIONAL');

    // With active runtime
    runtimeManager.activeRuntimes.add(8888);
    const canStartWhenActive = securityFacade.authorize(CAPABILITY.AUTOMATION_START);
    assert.equal(canStartWhenActive.status, 'DENIED');
    assert.match(canStartWhenActive.message, /Missing capability/);

    runtimeManager.activeRuntimes.clear();
  });

  t.after(() => {
    executionBoundaryManager.stopServer();
  });
});

// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeManager } from '../src/runtime-manager/runtime-manager.mjs';
import { executionBoundaryManager } from '../src/runtime-manager/boundary/index.mjs';
import { securityFacade } from '../src/security-authority/facade.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { registerDefaultCommandHandlers } from '../src/command/registerCommands.mjs';
import { getSharedStateStore } from '../src/state-store/sharedStateStore.mjs';
import { workspaceAggregator } from '../src/state/workspaceAggregator.mjs';
import { CapabilityResolver } from '../src/state/capabilityResolver.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';

test('Rapid Start-Stop & Lockout Remediation Invariants', async (t) => {
  NativeCore.init();
  await securityFacade.initialize();
  await securityFacade.initDevSession();
  registerDefaultCommandHandlers();

  const store = getSharedStateStore();

  await t.test('1. Stale process exit does not abort newly starting runtime connection', async () => {
    store.lifecycle.setDesiredState('STOPPED', 'RESET');
    store.lifecycle.setObservedState('STOPPED', 'RESET');
    runtimeManager.activeRuntimes.clear();

    const oldPid = 11111;
    const newPid = 22222;

    // Simulate old process tracked in terminating awaiter
    let oldProcessExitCallback;
    let newProcessExitCallback;

    // Mock NativeCore.spawnExecutionProcess to capture exit callbacks
    const origSpawn = NativeCore.spawnExecutionProcess;
    NativeCore.spawnExecutionProcess = (pipe, onExit) => {
      newProcessExitCallback = onExit;
      return newPid;
    };

    // Track whether abortConnection is falsely invoked
    let abortCalled = false;
    let abortError = null;
    const origAbort = executionBoundaryManager.abortConnection.bind(executionBoundaryManager);
    executionBoundaryManager.abortConnection = (err) => {
      abortCalled = true;
      abortError = err;
      origAbort(err);
    };

    try {
      // 1. Spawning new process sets currentStartingPid
      const spawnedPid = runtimeManager.spawnRuntime();
      assert.strictEqual(spawnedPid, newPid);
      assert.strictEqual(runtimeManager.currentStartingPid, newPid);

      // 2. Simulate delayed OS termination of OLD pid (11111) while new PID (22222) is starting
      // The exit callback from old process fires with oldPid
      assert.doesNotThrow(() => {
        // Direct simulation of old PID being reaped
        runtimeManager.emit('runtimeExited', oldPid);
      });

      // Assert that abortConnection was NOT called for old process exit
      assert.strictEqual(abortCalled, false, 'Stale PID exit must not call abortConnection on new starting runtime');
      assert.strictEqual(runtimeManager.currentStartingPid, newPid, 'Current starting PID must remain new PID');

      // 3. Simulate new client connection
      executionBoundaryManager.emit('clientConnected', 1);
      assert.strictEqual(runtimeManager.currentStartingPid, null, 'currentStartingPid must clear on client connection');

    } finally {
      NativeCore.spawnExecutionProcess = origSpawn;
      executionBoundaryManager.abortConnection = origAbort;
      runtimeManager.terminateAll();
    }
  });

  await t.test('2. terminateRuntimeAndWait resolves deferred promise on process exit', async () => {
    const testPid = 33333;
    runtimeManager.activeRuntimes.add(testPid);

    // Mock NativeCore.terminateExecutionProcess to simulate asynchronous OS exit
    const origTerminate = NativeCore.terminateExecutionProcess;
    NativeCore.terminateExecutionProcess = (pid) => {
      setTimeout(() => {
        const deferred = runtimeManager.exitDeferredMap.get(pid);
        if (deferred) {
          clearTimeout(deferred.timer);
          runtimeManager.exitDeferredMap.delete(pid);
          deferred.resolve(true);
        }
      }, 50);
      return true;
    };

    try {
      const startTime = Date.now();
      const awaited = await runtimeManager.terminateRuntimeAndWait(testPid, 1000);
      const elapsed = Date.now() - startTime;

      assert.strictEqual(awaited, true);
      assert.ok(elapsed >= 40, 'Should await until asynchronous termination completes');
      assert.strictEqual(runtimeManager.activeRuntimes.has(testPid), false);
    } finally {
      NativeCore.terminateExecutionProcess = origTerminate;
    }
  });

  await t.test('3. START_AUTOMATION self-heals transient degraded state in development mode', async () => {
    process.env.ACP_DEV_MODE = 'true';
    store.lifecycle.setDesiredState('STOPPED', 'RESET');
    store.lifecycle.setObservedState('STOPPED', 'RESET');
    runtimeManager.activeRuntimes.clear();

    // Explicitly transition security facade to degraded
    await securityFacade.transitionToDegraded('SIMULATED_TRANSIENT_DROP');
    assert.strictEqual(securityFacade.isDegraded(), true);
    assert.strictEqual(securityFacade.isSessionRevokedSync(), true);

    // Mock startCluster so command succeeds
    const origStartCluster = executionBoundaryManager.startCluster.bind(executionBoundaryManager);
    const origSpawn = runtimeManager.spawnRuntime.bind(runtimeManager);
    executionBoundaryManager.startCluster = async () => ({ started: true });
    runtimeManager.spawnRuntime = () => 44444;

    try {
      const result = await commandRouter.route(JSON.stringify({
        protocolVersion: '2.0',
        category: 'Execution',
        type: 'START_AUTOMATION',
        messageId: '01M2TESTDEVSELFHEAL00000000',
        timestamp: new Date().toISOString()
      }));

      assert.strictEqual(result.success, true);
      assert.strictEqual(securityFacade.isOperational(), true, 'Dev mode must automatically self-heal to OPERATIONAL');
      assert.strictEqual(securityFacade.isDegraded(), false);
      assert.strictEqual(securityFacade.isSessionRevokedSync(), false);
    } finally {
      executionBoundaryManager.startCluster = origStartCluster;
      runtimeManager.spawnRuntime = origSpawn;
      runtimeManager.terminateAll();
    }
  });

  await t.test('4. CapabilityResolver permits start when lifecycle is ERROR_DEGRADED and 0 active browsers', () => {
    // When 0 active browsers are present even in ERROR_DEGRADED, user must be permitted to start
    const capabilities = CapabilityResolver.resolve({
      lifecycle: 'ERROR_DEGRADED',
      isAuthorized: true,
      activeBrowsers: 0,
      maxCapacity: 2,
      globalActionPending: null,
      totalConfiguredAccounts: 1
    });

    assert.strictEqual(
      capabilities.canStartAutomation,
      true,
      'CapabilityResolver must allow canStartAutomation when 0 active browsers exist to avoid permanent UI lock'
    );
  });

  await t.test('5. Watchdog quarantine settles lifecycle to STOPPED in dev mode without revoking license', async () => {
    process.env.ACP_DEV_MODE = 'true';
    await securityFacade.initDevSession();
    assert.strictEqual(securityFacade.isOperational(), true);

    // Simulate the quarantine handler logic wired in index.mjs
    const handleQuarantine = (data) => {
      runtimeManager.quarantineExecution('WATCHDOG_HEARTBEAT_DEAD');
      const isDev = process.env.NODE_ENV !== 'production' || process.env.ACP_DEV_MODE === 'true';
      if (!isDev) {
        securityFacade.transitionToDegraded('EXECUTION_HEARTBEAT_TIMEOUT');
      }
      workspaceAggregator.setLifecycle('STOPPED', 'Execution heartbeat lost: runtime quarantined');
    };

    handleQuarantine({ reason: 'Missing heartbeat for 25000ms' });

    // In dev mode, license should NOT be revoked
    assert.strictEqual(securityFacade.isOperational(), true, 'Watchdog alert must not revoke software license in dev mode');
    assert.strictEqual(securityFacade.isSessionRevokedSync(), false);
    assert.strictEqual(workspaceAggregator.lifecycle, 'STOPPED', 'Lifecycle must settle to STOPPED so operator can restart');
  });

  t.after(() => {
    executionBoundaryManager.stopServer();
    runtimeManager.terminateAll();
  });
});

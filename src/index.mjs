// @ts-check
import { apiServer } from './api-server/server.mjs';
import { commandRouter } from './command/commandRouter.mjs';
import { securityFacade } from './security-authority/facade.mjs';
import { operationTracker } from './state/operationTracker.mjs';
import { wsServer } from './api-server/websocket/wsServer.mjs';
import { logger } from './shared/logging.mjs';
import { repositoryFactory } from './repositories/repositoryFactory.mjs';
import { backendSyncService } from './sync/backendSyncService.mjs';
import { runtimeManager } from './runtime-manager/runtime-manager.mjs';
import { executionBoundaryManager } from './runtime-manager/boundary/index.mjs';
import { workspaceAggregator } from './state/workspaceAggregator.mjs';
import { initDevToken } from './api-server/middleware/auth.mjs';
import { ExecutionPayloadBuilder } from './runtime-manager/boundary/ExecutionPayloadBuilder.mjs';
import { getSharedStateStore } from './state-store/sharedStateStore.mjs';
import { SanitizerGate } from './state-store/validation/SanitizerGate.mjs';

/**
 * Registers default Ingress Command Handlers into CommandRouter.
 * Execution commands are strictly gated by Security Authority and Degraded Mode.
 */
export function registerDefaultCommandHandlers() {
  // Execution category - Guarded strictly: Execution Plane is disabled in degraded mode
  commandRouter.register('Execution', 'START_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] START_AUTOMATION executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }

    return executionBoundaryManager.lifecycleMutex.runExclusive(async () => {
      const store = getSharedStateStore();
      const currentLifecycle = store.lifecycle.getState();

      // Invariant: Prevent duplicate process spawns
      if (
        currentLifecycle.observedState === 'RUNNING' ||
        currentLifecycle.observedState === 'STARTING_HANDSHAKE' ||
        runtimeManager.activeRuntimes.size > 0
      ) {
        throw new Error('[LF-701] Execution Denied: Automation is already running or initializing');
      }

      // 1. Record Desired State = RUNNING
      store.lifecycle.setDesiredState('RUNNING', 'USER_COMMAND_START');

      // 2. Start IPC server & spawn worker
      executionBoundaryManager.startServer();
      let pid;
      try {
        pid = runtimeManager.spawnRuntime();
      } catch (spawnErr) {
        store.lifecycle.setDesiredState('STOPPED', 'SPAWN_FAILED');
        store.lifecycle.setObservedState('STOPPED', 'SPAWN_FAILED');
        workspaceAggregator.setLifecycle('STOPPED', 'SPAWN_FAILED');
        throw spawnErr;
      }

      // 3. Mark observed state = STARTING_HANDSHAKE
      store.lifecycle.setObservedState('STARTING_HANDSHAKE', `PID_${pid}_SPAWNED`);
      workspaceAggregator.setLifecycle('STARTING');

      // 4. Two-Phase Spawn Commit: Send startCluster instruction over pipe with rollback on failure
      try {
        await executionBoundaryManager.startCluster({ traceId: cmd.traceId });
      } catch (clusterErr) {
        logger.error({ err: clusterErr.message, pid }, '[Command] Failed to start cluster on newly spawned runtime. Rolling back process.');
        runtimeManager.terminateRuntime(pid);
        executionBoundaryManager.stopServer();
        store.lifecycle.setDesiredState('STOPPED', 'START_CLUSTER_FAILED');
        store.lifecycle.setObservedState('STOPPED', 'START_CLUSTER_FAILED');
        workspaceAggregator.setLifecycle('STOPPED', 'START_CLUSTER_FAILED');
        throw clusterErr;
      }

      return { started: true, pid };
    });
  });

  commandRouter.register('Execution', 'STOP_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] STOP_AUTOMATION executing');
    return executionBoundaryManager.lifecycleMutex.runExclusive(async () => {
      // 1. Record Desired State = STOPPED
      const store = getSharedStateStore();
      store.lifecycle.setDesiredState('STOPPED', 'USER_COMMAND_STOP');
      store.lifecycle.setObservedState('STOPPING', 'USER_COMMAND_STOP');

      // 2. Dispatch graceful stop to Execution Plane with force-kill fallback
      try {
        await executionBoundaryManager.stopCluster(3000, { traceId: cmd.traceId });
      } catch (stopErr) {
        logger.warn({ err: stopErr.message }, '[Command] Graceful stopCluster timed out or failed. Enforcing force-kill fallback.');
        runtimeManager.terminateAll();
      } finally {
        // Enforce physical process termination
        if (runtimeManager.activeRuntimes.size > 0) {
          runtimeManager.terminateAll();
        }
        executionBoundaryManager.stopServer();
        // 3. Update Observed State = STOPPED
        store.lifecycle.setObservedState('STOPPED', 'STOP_COMPLETED');
        workspaceAggregator.setLifecycle('STOPPED');
      }

      return { stopped: true };
    });
  });

  commandRouter.register('Execution', 'PLACE_BET', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] PLACE_BET executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const result = executionBoundaryManager.placeBet(cmd.payload, { traceId: cmd.traceId });
    if (result && typeof result === 'object' && result.duplicate) {
      return { operationId: cmd.payload?.operationId, ...result };
    }
    return { operationId: cmd.payload?.operationId, queued: true, sent: result };
  });

  commandRouter.register('Execution', 'CASH_OUT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] CASH_OUT executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const result = executionBoundaryManager.cashOut(cmd.payload, { traceId: cmd.traceId });
    if (result && typeof result === 'object' && result.duplicate) {
      return { operationId: cmd.payload?.operationId, ...result };
    }
    return { operationId: cmd.payload?.operationId, queued: true, sent: result };
  });

  commandRouter.register('Execution', 'VALIDATE', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] VALIDATE executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = executionBoundaryManager.validateTactical(cmd.payload, { traceId: cmd.traceId });
    return { valid: true, sent };
  });

  commandRouter.register('Execution', 'ACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, payload: cmd.payload }, '[Command] ACTIVATE_ACCOUNT executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = executionBoundaryManager.activateAccount({ accountId: cmd.target }, { traceId: cmd.traceId });
    return { activated: true, accountId: cmd.target, sent };
  });

  commandRouter.register('Execution', 'DEACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, payload: cmd.payload }, '[Command] DEACTIVATE_ACCOUNT executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = executionBoundaryManager.deactivateAccount({ accountId: cmd.target }, { traceId: cmd.traceId });
    return { deactivated: true, accountId: cmd.target, sent };
  });

  // Persistence category
  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, platform: cmd.payload?.platformDisplayName, payload: SanitizerGate.sanitize(cmd.payload) }, '[Command] REGISTER_ACCOUNT executing');
    const created = await repositoryFactory.getAccountsRepo().create(cmd.payload);
    try {
      const store = getSharedStateStore();
      store.accounts.upsert(created);
    } catch { /* ignore */ }
    try {
      await backendSyncService.syncMutation('REGISTER_ACCOUNT', cmd.payload);
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for REGISTER_ACCOUNT');
    }
    return created;
  });

  commandRouter.register('Persistence', 'ACCOUNT_ACTION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, action: cmd.payload?.actionType, target: cmd.target, payload: cmd.payload }, '[Command] ACCOUNT_ACTION executed');
    return { executed: true };
  });

  commandRouter.register('Persistence', 'BULK_ACTION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, type: cmd.payload?.type, count: cmd.payload?.accountIds?.length, payload: cmd.payload }, '[Command] BULK_ACTION executed');
    return { bulkExecuted: true };
  });

  commandRouter.register('Persistence', 'TOGGLE_BET_CYCLE', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, enabled: cmd.payload?.enabled, payload: cmd.payload }, '[Command] TOGGLE_BET_CYCLE executed');
    const updated = await repositoryFactory.getConfigRepo().updateAccountConfig(cmd.target, { betCycleEnabled: cmd.payload?.enabled });
    
    // Orchestration Dispatch: Send SET_BET_CYCLE and full policy update to Execution Plane
    try {
      if (executionBoundaryManager.isConnected()) {
        executionBoundaryManager.setBetCycle(cmd.target, Boolean(cmd.payload?.enabled), { traceId: cmd.traceId });
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Failed to dispatch SET_BET_CYCLE to Execution Plane');
      try {
        const store = getSharedStateStore();
        store.accounts.updateExecutionState(cmd.target, {
          observedState: 'OUT_OF_SYNC',
          executionStatusReason: `DISPATCH_FAILED: ${err.message}`
        });
      } catch { /* ignore */ }
    }

    try {
      await backendSyncService.syncMutation('TOGGLE_BET_CYCLE', { accountId: cmd.target, enabled: cmd.payload?.enabled });
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for TOGGLE_BET_CYCLE');
    }

    return { toggled: true, enabled: cmd.payload?.enabled, updated };
  });

  commandRouter.register('Persistence', 'UPDATE_ACCOUNT_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, category: cmd.payload?.category, payload: cmd.payload }, '[Command] UPDATE_ACCOUNT_CONFIG executed');
    const updates = {};
    const cat = cmd.payload?.category;
    const isCustom = String(cmd.payload?.source || 'custom').toLowerCase() === 'custom';
    const sourceVal = isCustom ? 'custom' : 'global';
    const valuesVal = isCustom ? (cmd.payload?.values ?? null) : null;

    if (cat === 'pricing' || cat === 'Pricing') {
      updates.pricingSource = sourceVal;
      updates.customPricing = valuesVal;
    } else if (cat === 'risk' || cat === 'Risk') {
      updates.riskSource = sourceVal;
      updates.customRisk = valuesVal;
    } else if (cat === 'rebet' || cat === 'Rebet') {
      updates.rebetSource = sourceVal;
      updates.customRebet = valuesVal;
    } else if (cat) {
      updates[cat] = valuesVal;
    }
    const updated = await repositoryFactory.getConfigRepo().updateAccountConfig(cmd.target, updates);

    // Orchestration Dispatch: Build full account policy and dispatch UPDATE_POLICY
    try {
      if (executionBoundaryManager.isConnected()) {
        const store = getSharedStateStore();
        const globalConfig = store.configContainer.getGlobalConfig();
        const fullPolicy = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig, updated);
        const account = store.accountsContainer?.getById?.(cmd.target);
        const targetUsername = account?.accountUsername;

        if (!isCustom) {
          // Reverting to global for this category -> reset the specific category in Execution Plane
          executionBoundaryManager.resetPolicy(cmd.target, { traceId: cmd.traceId, accountId: cmd.target, category: cat });
          if (targetUsername && targetUsername !== cmd.target) {
            executionBoundaryManager.resetPolicy(targetUsername, { traceId: cmd.traceId, accountId: targetUsername, category: cat });
          }
        }

        executionBoundaryManager.updatePolicy(cmd.payload?.category || 'Staking', fullPolicy, { traceId: cmd.traceId, accountId: cmd.target });
        if (targetUsername && targetUsername !== cmd.target) {
          executionBoundaryManager.updatePolicy(cmd.payload?.category || 'Staking', fullPolicy, { traceId: cmd.traceId, accountId: targetUsername });
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Failed to dispatch UPDATE_ACCOUNT_CONFIG to Execution Plane');
      try {
        const store = getSharedStateStore();
        store.accounts.updateExecutionState(cmd.target, {
          observedState: 'OUT_OF_SYNC',
          executionStatusReason: `DISPATCH_FAILED: ${err.message}`
        });
      } catch { /* ignore */ }
    }

    try {
      await backendSyncService.syncMutation('UPDATE_ACCOUNT_CONFIG', { accountId: cmd.target, category: cmd.payload?.category, config: cmd.payload?.values });
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for UPDATE_ACCOUNT_CONFIG');
    }

    return { updated: true, accountConfig: updated };
  });

  commandRouter.register('Persistence', 'RESET_ACCOUNT_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, payload: cmd.payload }, '[Command] RESET_ACCOUNT_CONFIG executed');
    const updates = {
      pricingSource: 'global',
      customPricing: null,
      riskSource: 'global',
      customRisk: null,
      rebetSource: 'global',
      customRebet: null
    };
    const updated = await repositoryFactory.getConfigRepo().updateAccountConfig(cmd.target, updates);
    try {
      if (executionBoundaryManager.isConnected()) {
        executionBoundaryManager.resetPolicy(cmd.target, { traceId: cmd.traceId, accountId: cmd.target });
        const store = getSharedStateStore();
        const account = store.accountsContainer?.getById?.(cmd.target);
        if (account?.accountUsername && account.accountUsername !== cmd.target) {
          executionBoundaryManager.resetPolicy(account.accountUsername, { traceId: cmd.traceId, accountId: account.accountUsername });
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Failed to dispatch RESET_POLICY to Execution Plane');
    }

    try {
      await backendSyncService.syncMutation('RESET_ACCOUNT_CONFIG', { accountId: cmd.target });
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for RESET_ACCOUNT_CONFIG');
    }

    return { reset: true, accountConfig: updated };
  });

  commandRouter.register('Persistence', 'UPDATE_GLOBAL_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, category: cmd.payload?.category, payload: cmd.payload }, '[Command] UPDATE_GLOBAL_CONFIG executing');
    const updated = await repositoryFactory.getConfigRepo().updateCategory(cmd.payload.category, cmd.payload.values);
    try {
      const store = getSharedStateStore();
      store.config.updateCategory(cmd.payload.category, cmd.payload.values);
    } catch { /* ignore */ }
    
    // Orchestration Dispatch: Broadcast full-document policy update to Execution Plane
    try {
      if (executionBoundaryManager.isConnected()) {
        const store = getSharedStateStore();
        const globalConfig = store.configContainer.getGlobalConfig();
        const fullPolicy = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig);
        executionBoundaryManager.updatePolicy(cmd.payload?.category, fullPolicy, { traceId: cmd.traceId });

        // Dual-plane defense: Re-assert tailored policies for accounts with custom overrides
        const accounts = typeof store.accountsContainer?.getAll === 'function' ? store.accountsContainer.getAll() : [];
        const isCustomSource = (s) => String(s || '').toLowerCase() === 'custom';

        for (const acc of accounts) {
          const overrides = typeof store.configContainer?.getAccountOverride === 'function'
            ? store.configContainer.getAccountOverride(acc.id)
            : {};
          const hasCustomOverrides = isCustomSource(overrides?.pricingSource) || isCustomSource(overrides?.riskSource) || isCustomSource(overrides?.rebetSource);
          if (hasCustomOverrides) {
            const accPolicy = ExecutionPayloadBuilder.buildPolicyDocument(globalConfig, overrides);
            const targetAccount = acc.accountUsername || acc.id;
            executionBoundaryManager.updatePolicy(null, accPolicy, {
              traceId: cmd.traceId,
              accountId: targetAccount
            });
            if (acc.id && acc.accountUsername && acc.id !== acc.accountUsername) {
              executionBoundaryManager.updatePolicy(null, accPolicy, {
                traceId: cmd.traceId,
                accountId: acc.id
              });
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Failed to dispatch UPDATE_GLOBAL_CONFIG to Execution Plane');
    }

    try {
      await backendSyncService.syncMutation('UPDATE_GLOBAL_CONFIG', cmd.payload);
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for UPDATE_GLOBAL_CONFIG');
    }
    return updated;
  });

  // Billing category
  commandRouter.register('Billing', 'VERIFY_CHECKOUT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, reference: cmd.payload?.reference }, '[Command] VERIFY_CHECKOUT executed');
    return { verified: true };
  });
}

// Wire operation tracker events to WebSocket deltas
operationTracker.on('operation:completed', ({ operationId, op, result }) => {
  const traceId = op?.metadata?.traceId || operationTracker.getOperation(operationId)?.metadata?.traceId;
  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: null }
  }, { correlationId: operationId, traceId });
});

operationTracker.on('operation:failed', ({ operationId, op, errorReason }) => {
  const traceId = op?.metadata?.traceId || operationTracker.getOperation(operationId)?.metadata?.traceId;
  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: null }
  }, { correlationId: operationId, traceId });
});

// Synchronize runtime manager events with workspace snapshot
runtimeManager.on('stateChanged', ({ state, message }) => {
  workspaceAggregator.setLifecycle(state, message);
});

runtimeManager.on('runtimeExited', (pid) => {
  logger.warn({ pid }, '[RuntimeManager] Runtime worker process exited');
  try {
    const store = getSharedStateStore();
    const currentState = store.lifecycle.getState();
    const exitReason = `PROCESS_EXIT_PID_${pid}`;
    const targetObserved = currentState.desiredState === 'RUNNING' ? 'ABORTED' : 'STOPPED';

    store.lifecycle.setObservedState(targetObserved, exitReason);
    store.accounts.resetObservedStates(exitReason);
    workspaceAggregator.setLifecycle('STOPPED', exitReason);

    // Broadcast deltas to connected clients
    wsServer.broadcast('automation:delta', {
      type: 'LIFECYCLE_CHANGED',
      lifecycle: targetObserved,
      desiredState: currentState.desiredState,
      observedState: targetObserved,
      reason: exitReason
    });
  } catch (err) {
    logger.error({ err: err.message }, '[RuntimeManager] Error updating observed states on runtime exit');
    workspaceAggregator.setLifecycle('STOPPED');
  }
});

// Wire Execution Boundary Manager events
executionBoundaryManager.on('clientConnected', (connId) => {
  runtimeManager.activeConnections.add(connId);
  runtimeManager.emit('clientConnected', connId);
});

executionBoundaryManager.on('clientDisconnected', (connId) => {
  runtimeManager.activeConnections.delete(connId);
  runtimeManager.emit('clientDisconnected', connId);
});

executionBoundaryManager.on('quarantineRequired', (data) => {
  logger.warn({ data }, '[ExecutionBoundary] Quarantine required by watchdog. Quarantining runtime.');
  runtimeManager.quarantineExecution('WATCHDOG_HEARTBEAT_DEAD');
  securityFacade.transitionToDegraded('EXECUTION_HEARTBEAT_TIMEOUT');
  workspaceAggregator.setLifecycle('ERROR_DEGRADED', 'Execution heartbeat lost: runtime quarantined');
});

executionBoundaryManager.on('livenessDegraded', (data) => {
  logger.warn({ data }, '[ExecutionBoundary] Execution plane liveness degraded');
  workspaceAggregator.setLifecycle('DEGRADED', 'Execution process liveness degraded');
});

// Wire uncertain operations into ReconciliationCoordinator to preserve financial safety
runtimeManager.on('uncertainOperations', (uncertainOps) => {
  if (Array.isArray(uncertainOps)) {
    for (const op of uncertainOps) {
      const targetAccount = op.metadata?.accountId || op.metadata?.targetAccounts?.[0] || 'unknown';
      try {
        executionBoundaryManager.reconciliation.enqueueUncertainOperation({
          operationId: op.operationId,
          accountId: targetAccount,
          idempotencyKey: op.metadata?.idempotencyKey || `idem_${op.operationId}`,
          reason: op.uncertainReason || 'EXECUTION_QUARANTINED',
          details: op
        });
      } catch (err) {
        logger.warn({ err: err.message }, '[RuntimeManager] Failed to enqueue uncertain operation to reconciliation coordinator');
      }
    }
  }
});

async function bootstrap() {
  try {
    logger.info('========================================================');
    logger.info('   Betting Automation Control Plane (ACP) - v0.1.0-alpha');
    logger.info('========================================================');

    // 1. Initialize Security Facade & Encrypted State Persistence
    await securityFacade.initialize();
    logger.info('[SecurityAuthority] Security engine and persistent store initialized');

    // Wire dynamic execution check for Security Authority capability evaluation
    securityFacade.setActiveExecutionChecker(() => runtimeManager.activeRuntimes.size > 0);

    // 2. Initialize Ingress Token for Local Dev & Console Interop
    const devToken = initDevToken();
    logger.info({ devToken }, '[SecurityAuthority] Ingress access token active');

    // 3. Register Commands
    registerDefaultCommandHandlers();

    // 4. Initialize Backend Synchronization & Hydration Pipeline (Blocking prerequisite)
    const isDev = process.env.NODE_ENV !== 'production' && process.env.ACP_FORCE_DEGRADED !== 'true';

    try {
      const syncResult = await backendSyncService.initialize();
      if (!syncResult.isConnected) {
        if (isDev) {
          logger.info('[ControlPlane] Cloud Backend offline in development mode.');
          logger.info('[ControlPlane] Activating Local Developer Operational Mode (Full Capabilities & Standby Lifecycle).');
          await securityFacade.initDevSession();
          const store = getSharedStateStore();
          store.lifecycle.setDesiredState('STOPPED', 'DEV_MODE_READY');
          store.lifecycle.setObservedState('STOPPED', 'DEV_MODE_READY');
          workspaceAggregator.setLifecycle('STOPPED', 'Local Dev Mode Ready');
        } else {
          logger.warn('[ControlPlane] Backend/Internet offline. Entering DEGRADED mode (Execution Plane strictly quarantined)');
          await securityFacade.transitionToDegraded('BACKEND_OFFLINE_AT_BOOT');
          runtimeManager.quarantineExecution('BACKEND_OFFLINE_AT_BOOT');
          workspaceAggregator.setLifecycle('ERROR_DEGRADED', 'Backend offline: Execution Plane disabled');
        }
      } else {
        logger.info('[ControlPlane] Backend synchronization pipeline connected & operational');
      }
    } catch (syncErr) {
      if (isDev) {
        logger.info({ err: syncErr.message }, '[ControlPlane] Backend sync unavailable in development mode. Activating Local Developer Operational Mode.');
        await securityFacade.initDevSession();
        const store = getSharedStateStore();
        store.lifecycle.setDesiredState('STOPPED', 'DEV_MODE_READY');
        store.lifecycle.setObservedState('STOPPED', 'DEV_MODE_READY');
        workspaceAggregator.setLifecycle('STOPPED', 'Local Dev Mode Ready');
      } else {
        logger.warn({ error: syncErr.message }, '[ControlPlane] Backend sync error. Entering DEGRADED mode');
        await securityFacade.transitionToDegraded('BACKEND_SYNC_FAILURE');
        runtimeManager.quarantineExecution('BACKEND_SYNC_FAILURE');
        workspaceAggregator.setLifecycle('ERROR_DEGRADED', 'Backend sync failure: Execution Plane disabled');
      }
    }

    // 5. Start API & WebSocket Server on Loopback ONLY AFTER State and Backend are Ready
    const port = Number(process.env.PORT) || 8000;
    const host = process.env.HOST || '127.0.0.1';
    await apiServer.listen(port, host);

    logger.info(`[ControlPlane] Ready for Next.js console connections at http://${host}:${port}`);
    logger.info(`[ControlPlane] WebSocket stream active at ws://${host}:${port}/ws/v1/events`);
  } catch (err) {
    logger.fatal({ err: err.message, stack: err.stack }, '[ControlPlane] Fatal startup error');
    process.exit(1);
  }
}

// Graceful shutdown handling
const shutdown = async (signal) => {
  logger.info({ signal }, '[ControlPlane] Graceful shutdown initiated');
  try {
    executionBoundaryManager.stopServer();
    runtimeManager.quarantineExecution(`SHUTDOWN_${signal}`);
    await apiServer.close();
    logger.info('[ControlPlane] Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[ControlPlane] Error during shutdown');
    process.exit(1);
  }
};

import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootstrap();
}


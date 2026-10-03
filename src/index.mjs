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
import { getSharedStateStore } from './state-store/sharedStateStore.mjs';
export { registerDefaultCommandHandlers } from './command/registerCommands.mjs';
import { registerDefaultCommandHandlers } from './command/registerCommands.mjs';

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

runtimeManager.on('fleetReadiness', (readiness) => {
  workspaceAggregator.setFleetReadiness(readiness);
});

runtimeManager.on('runtimeExited', (pid) => {
  logger.warn({ pid }, '[RuntimeManager] Runtime worker process exited');
  try {
    const store = getSharedStateStore();
    const currentState = store.lifecycle.getState();

    // If a new runtime is already active or starting, ignore stale exit from older terminated process
    const isNewRuntimeActive = runtimeManager.activeRuntimes.size > 0 || runtimeManager.currentStartingPid !== null;
    if (currentState.desiredState === 'RUNNING' && isNewRuntimeActive && !runtimeManager.activeRuntimes.has(pid)) {
      logger.info({ pid }, '[RuntimeManager] Stale runtimeExited event ignored; active/starting runtime unaffected');
      return;
    }

    const exitReason = `PROCESS_EXIT_PID_${pid}`;
    const targetObserved = currentState.desiredState === 'RUNNING' ? 'ABORTED' : 'STOPPED';

    store.lifecycle.setObservedState(targetObserved, exitReason);
    store.accounts.resetObservedStates(exitReason);
    workspaceAggregator.setLifecycle(targetObserved, exitReason);
    workspaceAggregator.setFleetReadiness(null);

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

executionBoundaryManager.on('stateChanged', ({ state, message }) => {
  logger.info({ state, message }, `[ExecutionBoundary] Engine state transitioned to ${state}`);
  try {
    const store = getSharedStateStore();
    let observed = state;
    if (state === 'READY' || state === 'RUNNING') {
      observed = 'RUNNING';
      executionBoundaryManager.getFleetReadiness().catch(() => {});
    } else if (state === 'STOPPED' || state === 'OFFLINE') {
      observed = 'STOPPED';
      workspaceAggregator.setFleetReadiness(null);
      wsServer.broadcast('automation:delta', {
        type: 'FLEET_READINESS_CHANGED',
        readiness: null
      });
    } else if (state === 'ERROR' || state === 'DEGRADED') {
      observed = 'ERROR_DEGRADED';
    }

    store.lifecycle.setObservedState(observed, message || 'EXECUTION_STATE_CHANGED');
    workspaceAggregator.setLifecycle(observed, message);
    wsServer.broadcast('automation:delta', {
      type: 'LIFECYCLE_CHANGED',
      lifecycle: observed,
      message
    });
  } catch (err) {
    logger.error({ err: err.message }, '[ExecutionBoundary] Error handling stateChanged event');
  }
});

executionBoundaryManager.on('browserStatus', (payload) => {
  logger.info({ payload }, `[ExecutionBoundary] Browser status update received for [${payload.browserId || payload.accountId}]`);
  try {
    const store = getSharedStateStore();
    let accountId = payload.accountId || payload.id;
    const username = payload.accountUsername || payload.username;

    // Resolve canonical accountId if only username is present
    if (!accountId && username && store && store.accountsContainer) {
      const allAccounts = store.accountsContainer.getAll();
      const match = allAccounts.find(a => a.accountUsername === username);
      if (match) accountId = match.id;
    }

    if (accountId) {
      if (payload.browserStatus === 'ACTIVE' || payload.accountStatus === 'IN_USE') {
        workspaceAggregator.activateAccount(accountId);
      } else if (payload.browserStatus === 'STOPPED') {
        workspaceAggregator.activeAccountIds.delete(accountId);
      }

      if (store && store.accounts && typeof store.accounts.updateExecutionState === 'function') {
        store.accounts.updateExecutionState(accountId, {
          observedState: payload.observedState || (payload.browserStatus === 'ACTIVE' ? 'RUNNING' : 'STOPPED'),
          executionStatusReason: payload.executionStatusReason || null
        });
      }

      // Broadcast real-time interactive delta to frontend automation store
      wsServer.broadcast('automation:delta', {
        type: 'ACCOUNT_UPDATED',
        accountId,
        partialSnapshot: {
          browserStatus: payload.browserStatus || 'STOPPED',
          accountStatus: payload.accountStatus || 'IDLE',
          observedState: payload.observedState || (payload.browserStatus === 'ACTIVE' ? 'RUNNING' : 'STOPPED'),
          executionStatusReason: payload.executionStatusReason || null
        }
      });

      // Broadcast updated browser counts to automation store
      const activeCount = typeof payload.activeBrowsers === 'number' 
        ? payload.activeBrowsers 
        : workspaceAggregator.activeAccountIds.size;
      wsServer.broadcast('automation:delta', {
        type: 'STATUS_UPDATED',
        partialStatus: {
          activeBrowsers: activeCount
        }
      });

      // Also broadcast to accounts store
      wsServer.broadcast('accounts:delta', {
        type: 'ACCOUNT_UPDATED',
        accountId,
        partialSnapshot: {
          backendState: payload.browserStatus === 'ACTIVE' ? 'ACTIVE' : 'IDLE',
          statusDescription: payload.browserStatus
        }
      });
    }
  } catch (err) {
    logger.error({ err: err.message }, '[ExecutionBoundary] Error handling browserStatus event');
  }
});

executionBoundaryManager.on('quarantineRequired', (data) => {
  logger.warn({ data }, '[ExecutionBoundary] Quarantine required by watchdog. Quarantining runtime.');
  runtimeManager.quarantineExecution('WATCHDOG_HEARTBEAT_DEAD');
  
  // Decouple local worker process stall from global security authority license revocation
  const isDev = process.env.NODE_ENV !== 'production' || process.env.ACP_DEV_MODE === 'true';
  if (!isDev) {
    securityFacade.transitionToDegraded('EXECUTION_HEARTBEAT_TIMEOUT');
  }

  // Cleanly settle execution plane state to STOPPED so operator can restart without ACP restart
  workspaceAggregator.setLifecycle('STOPPED', 'Execution heartbeat lost: runtime quarantined');
  try {
    const store = getSharedStateStore();
    store.lifecycle.setDesiredState('STOPPED', 'WATCHDOG_QUARANTINE');
    store.lifecycle.setObservedState('STOPPED', 'WATCHDOG_QUARANTINE');
  } catch {}

  wsServer.broadcast('automation:delta', {
    type: 'LIFECYCLE_CHANGED',
    lifecycle: 'STOPPED',
    message: 'Worker process unresponsive: execution halted cleanly'
  });
});

executionBoundaryManager.on('livenessDegraded', (data) => {
  logger.warn({ data }, '[ExecutionBoundary] Execution plane liveness degraded');
  workspaceAggregator.setLifecycle('DEGRADED', 'Execution process liveness degraded');
});

executionBoundaryManager.on('fleetReadiness', (readiness) => {
  workspaceAggregator.setFleetReadiness(readiness);
  logger.info({
    state: readiness?.state,
    ready: readiness?.ready,
    severity: readiness?.severity,
    reason: readiness?.reason,
    epoch: readiness?.epoch
  }, `[ExecutionBoundary] Received FLEET_READINESS from Engine: state=${readiness?.state}, ready=${readiness?.ready}`);
  wsServer.broadcast('automation:delta', {
    type: 'FLEET_READINESS_CHANGED',
    readiness
  });
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
    initDevToken();
    logger.info('[SecurityAuthority] Ingress access token active');

    // 3. Register Commands
    registerDefaultCommandHandlers();

    // 4. Initialize Shared StateStore & Wire SQLite Engine to BackendSyncService
    const store = getSharedStateStore();
    backendSyncService.setEngine(store.engine);

    const isExplicitDev = process.env.ACP_DEV_MODE === 'true' || 
                          process.env.NODE_ENV === 'development' || 
                          process.argv.includes('--dev');
    const isDev = isExplicitDev && 
                  process.env.ACP_FORCE_DEGRADED !== 'true' && 
                  process.env.NODE_ENV !== 'production';

    // Anti-tamper grace lease handler: strictly anchored to authoritative backend snapshot
    const handleOfflineOrError = async (contextMsg) => {
      const lease = backendSyncService.getOfflineGraceLease();
      if (lease) {
        logger.warn(`[ControlPlane] ${contextMsg}. Valid cached subscription found within 2-hour operational grace period.`);
        logger.info(`[ControlPlane] Entering OFFLINE_GRACE mode. Grace period expires at ${new Date(lease.expiresAt).toISOString()} (${Math.round(lease.remainingMs / 60000)}m remaining).`);
        await securityFacade.enterOfflineGrace(lease);
        store.lifecycle.setDesiredState('STOPPED', 'OFFLINE_GRACE_READY');
        store.lifecycle.setObservedState('STOPPED', 'OFFLINE_GRACE_READY');
        workspaceAggregator.setLifecycle('STOPPED', `Operating in Offline Grace Period (${contextMsg})`);

        // Start background grace monitor to quarantine when 2-hour window expires
        backendSyncService.startGracePeriodMonitor(() => {
          logger.warn('[ControlPlane] 2-hour offline grace window expired. Quarantining execution.');
          runtimeManager.quarantineExecution('OFFLINE_GRACE_EXPIRED');
          workspaceAggregator.setLifecycle('ERROR_DEGRADED', 'Offline grace period expired: Execution Plane disabled');
        });
      } else {
        logger.warn(`[ControlPlane] ${contextMsg} and no valid grace period. Entering DEGRADED mode (Execution Plane strictly quarantined)`);
        await securityFacade.transitionToDegraded('BACKEND_OFFLINE_NO_GRACE');
        runtimeManager.quarantineExecution('BACKEND_OFFLINE_NO_GRACE');
        workspaceAggregator.setLifecycle('ERROR_DEGRADED', `${contextMsg}: Execution Plane disabled`);
      }
    };

    try {
      const syncResult = await backendSyncService.initialize();
      if (!syncResult.isConnected) {
        if (isDev) {
          logger.info('[ControlPlane] Cloud Backend offline in development mode.');
          logger.info('[ControlPlane] Activating Local Developer Operational Mode (Full Capabilities & Standby Lifecycle).');
          await securityFacade.initDevSession();
          store.lifecycle.setDesiredState('STOPPED', 'DEV_MODE_READY');
          store.lifecycle.setObservedState('STOPPED', 'DEV_MODE_READY');
          workspaceAggregator.setLifecycle('STOPPED', 'Local Dev Mode Ready');
        } else {
          await handleOfflineOrError('Cloud Backend offline');
        }
      } else {
        logger.info('[ControlPlane] Backend synchronization pipeline connected & operational');
        if (syncResult.session) {
          await securityFacade.establishSession(syncResult.session);
        } else if (isDev) {
          logger.warn('[ControlPlane] Backend connected but failed to issue authoritative operator session. Activating Local Developer Operational Mode.');
          await securityFacade.initDevSession();
          store.lifecycle.setDesiredState('STOPPED', 'DEV_MODE_READY');
          store.lifecycle.setObservedState('STOPPED', 'DEV_MODE_READY');
          workspaceAggregator.setLifecycle('STOPPED', 'Local Dev Mode Ready');
        }
      }
    } catch (syncErr) {
      if (isDev) {
        logger.info({ err: syncErr.message }, '[ControlPlane] Backend sync unavailable in development mode. Activating Local Developer Operational Mode.');
        await securityFacade.initDevSession();
        store.lifecycle.setDesiredState('STOPPED', 'DEV_MODE_READY');
        store.lifecycle.setObservedState('STOPPED', 'DEV_MODE_READY');
        workspaceAggregator.setLifecycle('STOPPED', 'Local Dev Mode Ready');
      } else {
        await handleOfflineOrError(`Backend sync error: ${syncErr.message}`);
      }
    }

    // 6. Start API & WebSocket Server on Loopback ONLY AFTER State and Backend are Ready
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
    backendSyncService.stop();
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
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  bootstrap();
}


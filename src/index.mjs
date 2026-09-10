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
import { workspaceAggregator } from './state/workspaceAggregator.mjs';
import { initDevToken } from './api-server/middleware/auth.mjs';

/**
 * Registers default Ingress Command Handlers into CommandRouter.
 * Execution commands are strictly gated by Security Authority and Degraded Mode.
 */
function registerDefaultCommandHandlers() {
  // Execution category - Guarded strictly: Execution Plane is disabled in degraded mode
  commandRouter.register('Execution', 'START_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] START_AUTOMATION executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const pid = runtimeManager.spawnRuntime();
    runtimeManager.startCluster({ traceId: cmd.traceId });
    workspaceAggregator.setLifecycle('STARTING');
    return { started: true, pid };
  });

  commandRouter.register('Execution', 'STOP_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] STOP_AUTOMATION executing');
    runtimeManager.stopCluster(3000, cmd.traceId);
    workspaceAggregator.setLifecycle('STOPPED');
    return { stopped: true };
  });

  commandRouter.register('Execution', 'PLACE_BET', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] PLACE_BET executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = runtimeManager.placeBet(cmd.payload, cmd.traceId);
    return { operationId: cmd.payload?.operationId, queued: true, sent };
  });

  commandRouter.register('Execution', 'CASH_OUT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] CASH_OUT executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = runtimeManager.cashOut(cmd.payload, cmd.traceId);
    return { operationId: cmd.payload?.operationId, queued: true, sent };
  });

  commandRouter.register('Execution', 'VALIDATE', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] VALIDATE executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = runtimeManager.validateTactical(cmd.payload, cmd.traceId);
    return { valid: true, sent };
  });

  commandRouter.register('Execution', 'ACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target }, '[Command] ACTIVATE_ACCOUNT executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = runtimeManager.activateAccount({ accountId: cmd.target }, cmd.traceId);
    return { activated: true, accountId: cmd.target, sent };
  });

  commandRouter.register('Execution', 'DEACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target }, '[Command] DEACTIVATE_ACCOUNT executing');
    if (securityFacade.isDegraded()) {
      throw new Error('[LF-701] Execution Denied: Control Plane is in DEGRADED mode (Backend or Internet Offline)');
    }
    const sent = runtimeManager.deactivateAccount({ accountId: cmd.target }, cmd.traceId);
    return { deactivated: true, accountId: cmd.target, sent };
  });

  // Persistence category
  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, platform: cmd.payload?.platformDisplayName }, '[Command] REGISTER_ACCOUNT executing');
    const created = await repositoryFactory.getAccountsRepo().create(cmd.payload);
    backendSyncService.syncMutation('REGISTER_ACCOUNT', cmd.payload).catch(err => {
      logger.warn({ err: err.message }, '[Command] Async backend sync failed for REGISTER_ACCOUNT');
    });
    return created;
  });

  commandRouter.register('Persistence', 'ACCOUNT_ACTION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, action: cmd.payload?.actionType, target: cmd.target }, '[Command] ACCOUNT_ACTION executed');
    return { executed: true };
  });

  commandRouter.register('Persistence', 'BULK_ACTION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, type: cmd.payload?.type, count: cmd.payload?.accountIds?.length }, '[Command] BULK_ACTION executed');
    return { bulkExecuted: true };
  });

  commandRouter.register('Persistence', 'TOGGLE_BET_CYCLE', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, enabled: cmd.payload?.enabled }, '[Command] TOGGLE_BET_CYCLE executed');
    const updated = await repositoryFactory.getConfigRepo().updateAccountConfig(cmd.target, { betCycleEnabled: cmd.payload?.enabled });
    return { toggled: true, enabled: cmd.payload?.enabled, updated };
  });

  commandRouter.register('Persistence', 'UPDATE_ACCOUNT_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, category: cmd.payload?.category }, '[Command] UPDATE_ACCOUNT_CONFIG executed');
    const updated = await repositoryFactory.getConfigRepo().updateAccountConfig(cmd.target, { [cmd.payload?.category]: cmd.payload?.values });
    return { updated: true, accountConfig: updated };
  });

  commandRouter.register('Persistence', 'UPDATE_GLOBAL_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, category: cmd.payload?.category }, '[Command] UPDATE_GLOBAL_CONFIG executing');
    const updated = await repositoryFactory.getConfigRepo().updateCategory(cmd.payload.category, cmd.payload.values);
    backendSyncService.syncMutation('UPDATE_GLOBAL_CONFIG', cmd.payload).catch(err => {
      logger.warn({ err: err.message }, '[Command] Async backend sync failed for UPDATE_GLOBAL_CONFIG');
    });
    return updated;
  });

  // Billing category
  commandRouter.register('Billing', 'VERIFY_CHECKOUT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, reference: cmd.payload?.reference }, '[Command] VERIFY_CHECKOUT executed');
    return { verified: true };
  });
}

// Wire operation tracker events to WebSocket deltas
operationTracker.on('operation:completed', ({ operationId, result }) => {
  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: null }
  });
});

operationTracker.on('operation:failed', ({ operationId, errorReason }) => {
  wsServer.broadcast('automation:delta', {
    type: 'STATUS_UPDATED',
    systemStatus: { globalActionPending: null }
  });
});

// Synchronize runtime manager events with workspace snapshot
runtimeManager.on('stateChanged', ({ state, message }) => {
  workspaceAggregator.setLifecycle(state, message);
});

runtimeManager.on('runtimeExited', (pid) => {
  logger.warn({ pid }, '[RuntimeManager] Runtime worker process exited');
  workspaceAggregator.setLifecycle('STOPPED');
});

async function bootstrap() {
  try {
    logger.info('========================================================');
    logger.info('   Betting Automation Control Plane (ACP) - v0.1.0-alpha');
    logger.info('========================================================');

    // 1. Initialize Security Facade & Encrypted State Persistence
    await securityFacade.initialize();
    logger.info('[SecurityAuthority] Security engine and persistent store initialized');

    // 2. Initialize Ingress Token for Local Dev & Console Interop
    const devToken = initDevToken();
    logger.info({ devToken }, '[SecurityAuthority] Ingress access token active');

    // 3. Register Commands
    registerDefaultCommandHandlers();

    // 4. Start API & WebSocket Server on Loopback
    const port = Number(process.env.PORT) || 8000;
    const host = process.env.HOST || '127.0.0.1';
    await apiServer.listen(port, host);

    logger.info(`[ControlPlane] Ready for Next.js console connections at http://${host}:${port}`);
    logger.info(`[ControlPlane] WebSocket stream active at ws://${host}:${port}/ws/v1/events`);

    // 5. Initialize Backend Synchronization & Hydration Pipeline
    try {
      const syncResult = await backendSyncService.initialize();
      if (!syncResult.isConnected) {
        logger.warn('[ControlPlane] Backend/Internet offline. Entering DEGRADED mode (Execution Plane strictly quarantined)');
        await securityFacade.transitionToDegraded('BACKEND_OFFLINE_AT_BOOT');
        runtimeManager.quarantineExecution('BACKEND_OFFLINE_AT_BOOT');
        workspaceAggregator.setLifecycle('ERROR_DEGRADED', 'Backend offline: Execution Plane disabled');
      } else {
        logger.info('[ControlPlane] Backend synchronization pipeline connected & operational');
      }
    } catch (syncErr) {
      logger.warn({ error: syncErr.message }, '[ControlPlane] Backend sync error. Entering DEGRADED mode');
      await securityFacade.transitionToDegraded('BACKEND_SYNC_FAILURE');
      runtimeManager.quarantineExecution('BACKEND_SYNC_FAILURE');
      workspaceAggregator.setLifecycle('ERROR_DEGRADED', 'Backend sync failure: Execution Plane disabled');
    }
  } catch (err) {
    logger.fatal({ err: err.message, stack: err.stack }, '[ControlPlane] Fatal startup error');
    process.exit(1);
  }
}

// Graceful shutdown handling
const shutdown = async (signal) => {
  logger.info({ signal }, '[ControlPlane] Graceful shutdown initiated');
  try {
    runtimeManager.quarantineExecution(`SHUTDOWN_${signal}`);
    await apiServer.close();
    logger.info('[ControlPlane] Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[ControlPlane] Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

bootstrap();


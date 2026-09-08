// @ts-check
import { apiServer } from './api-server/server.mjs';
import { commandRouter } from './command/commandRouter.mjs';
import { securityFacade } from './security-authority/facade.mjs';
import { operationTracker } from './state/operationTracker.mjs';
import { wsServer } from './api-server/websocket/wsServer.mjs';
import { logger } from './shared/logging.mjs';
import { repositoryFactory } from './repositories/repositoryFactory.mjs';
import { backendSyncService } from './sync/backendSyncService.mjs';

/**
 * Registers default Ingress Command Handlers into CommandRouter.
 * Connects persistence commands to InMemoryRepos and initiates asynchronous backend sync.
 */
function registerDefaultCommandHandlers() {
  // Execution category
  commandRouter.register('Execution', 'START_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] START_AUTOMATION executed');
    return { started: true };
  });

  commandRouter.register('Execution', 'STOP_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] STOP_AUTOMATION executed');
    return { stopped: true };
  });

  commandRouter.register('Execution', 'PLACE_BET', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] PLACE_BET executed');
    return { operationId: cmd.payload?.operationId, queued: true };
  });

  commandRouter.register('Execution', 'CASH_OUT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] CASH_OUT executed');
    return { operationId: cmd.payload?.operationId, queued: true };
  });

  commandRouter.register('Execution', 'VALIDATE', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] VALIDATE executed');
    return { valid: true };
  });

  commandRouter.register('Execution', 'ACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target }, '[Command] ACTIVATE_ACCOUNT executed');
    return { activated: true, accountId: cmd.target };
  });

  commandRouter.register('Execution', 'DEACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target }, '[Command] DEACTIVATE_ACCOUNT executed');
    return { deactivated: true, accountId: cmd.target };
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

async function bootstrap() {
  try {
    logger.info('========================================================');
    logger.info('   Betting Automation Control Plane (ACP) - v0.1.0-alpha');
    logger.info('========================================================');

    // 1. Initialize Security Facade
    try {
      await securityFacade.initialize();
      logger.info('[SecurityAuthority] Security engine initialized');
    } catch (secErr) {
      logger.warn({ error: secErr.message }, '[SecurityAuthority] Native binding deferred or mock mode active');
    }

    // 2. Register Commands
    registerDefaultCommandHandlers();

    // 3. Start API & WebSocket Server
    const port = Number(process.env.PORT) || 8000;
    await apiServer.listen(port);

    logger.info(`[ControlPlane] Ready for Next.js console connections at http://localhost:${port}`);
    logger.info(`[ControlPlane] WebSocket stream active at ws://localhost:${port}/ws/v1/events`);

    // 4. Initialize Backend Synchronization & Hydration Pipeline
    try {
      await backendSyncService.initialize();
      logger.info('[ControlPlane] Backend synchronization pipeline initialized');
    } catch (syncErr) {
      logger.warn({ error: syncErr.message }, '[ControlPlane] Backend sync initialization warning; operating in local mode');
    }
  } catch (err) {

    logger.fatal({ err }, '[ControlPlane] Fatal startup error');
    process.exit(1);
  }
}

bootstrap();

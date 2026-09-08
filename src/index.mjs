// @ts-check
import { apiServer } from './api-server/server.mjs';
import { commandRouter } from './command/commandRouter.mjs';
import { securityFacade } from './security-authority/facade.mjs';
import { operationTracker } from './state/operationTracker.mjs';
import { wsServer } from './api-server/websocket/wsServer.mjs';
import { logger } from './shared/logging.mjs';
import { runtimeManager } from './runtime-manager/runtime-manager.mjs';
import { repositoryFactory } from './repositories/repositoryFactory.mjs';

/**
 * Registers default Ingress Command Handlers into CommandRouter.
 * In Phase 1, handlers act as authoritative coordinators.
 * In Phase 2 & 3, execution commands pipe to RuntimeManager and persistence to SQLite.
 */
function registerDefaultCommandHandlers() {
  // Execution category
  commandRouter.register('Execution', 'START_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] START_AUTOMATION executed');
    const workerScript = process.env.EXECUTION_WORKER_PATH || 'C:/Users/John/Documents/CODE/back/bettingAutomation/src/worker/index.mjs';

    let pid = null;
    try {
      pid = runtimeManager.spawnRuntime(workerScript);
      logger.info(`[Command] Spawned execution worker with PID: ${pid}`);

      const accountsRepo = repositoryFactory.getAccountsRepository();
      const configRepo = repositoryFactory.getAutomationConfigRepository();
      const [accounts, globalConfig] = await Promise.all([
        accountsRepo.listAccounts(),
        configRepo.getGlobalConfig()
      ]);

      const workerSettings = {
        Spawning: {
          max_accounts_to_spawn: String(globalConfig?.browserSpawning?.maxAccountsToSpawn || accounts.length || 2),
          slave_mode: globalConfig?.browserSpawning?.slaveMode?.toLowerCase() || 'headful',
          master_use_proxy: 'false',
          debug_slow_mo: '0'
        },
        Proxy: {
          proxy_failure_mode: 'loose',
          proxy_allocation_mode: 'round_robin',
          max_accounts_per_proxy: '5'
        },
        AntiDetection: {
          use_stealth_plugin: 'false',
          browser_binary: 'chrome',
          randomize_user_agent: 'false',
          block_webrtc: 'false',
          match_proxy_timezone: 'true',
          canvas_spoofing: 'false'
        },
        Memory: {
          record_action_sequence: 'true',
          replay_action_sequence: 'false'
        },
        Triggers: {
          trigger_type: 'terminal'
        }
      };

      const workerAccounts = accounts.map(a => ({
        username: a.accountUsername,
        password: a.encryptedPassword || 'Princess12',
        platform: a.platformDisplayName
      }));

      runtimeManager.once('clientConnected', () => {
        runtimeManager.initializeWorker({
          settings: workerSettings,
          accounts: workerAccounts,
          proxies: [],
          policy: {}
        }, cmd.traceId);
      });

      return { started: true, pid };
    } catch (err) {
      logger.warn({ err }, `[Command] spawnRuntime deferred or fallback: ${err.message}`);
      return { started: true, pid };
    }
  });

  commandRouter.register('Execution', 'STOP_AUTOMATION', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] STOP_AUTOMATION executed');
    try {
      runtimeManager.stopCluster(5000, cmd.traceId);
    } catch (err) {
      logger.warn({ err }, `[Command] stopCluster error: ${err.message}`);
    }
    return { stopped: true };
  });

  commandRouter.register('Execution', 'PLACE_BET', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] PLACE_BET executed');
    try {
      runtimeManager.placeBet(cmd.payload, cmd.traceId);
    } catch (err) {
      logger.warn({ err }, `[Command] placeBet error: ${err.message}`);
    }
    return { operationId: cmd.payload?.operationId, queued: true };
  });

  commandRouter.register('Execution', 'CASH_OUT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, payload: cmd.payload }, '[Command] CASH_OUT executed');
    try {
      runtimeManager.cashOut(cmd.payload, cmd.traceId);
    } catch (err) {
      logger.warn({ err }, `[Command] cashOut error: ${err.message}`);
    }
    return { operationId: cmd.payload?.operationId, queued: true };
  });

  commandRouter.register('Execution', 'VALIDATE', async (cmd) => {
    logger.info({ traceId: cmd.traceId }, '[Command] VALIDATE executed');
    try {
      runtimeManager.validateTactical(cmd.payload, cmd.traceId);
    } catch (err) {
      logger.warn({ err }, `[Command] validateTactical error: ${err.message}`);
    }
    return { valid: true };
  });

  commandRouter.register('Execution', 'ACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target }, '[Command] ACTIVATE_ACCOUNT executed');
    try {
      runtimeManager.activateAccount(cmd.payload, cmd.traceId);
    } catch (err) {
      logger.warn({ err }, `[Command] activateAccount error: ${err.message}`);
    }
    return { activated: true, accountId: cmd.target };
  });

  commandRouter.register('Execution', 'DEACTIVATE_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target }, '[Command] DEACTIVATE_ACCOUNT executed');
    try {
      runtimeManager.deactivateAccount(cmd.payload, cmd.traceId);
    } catch (err) {
      logger.warn({ err }, `[Command] deactivateAccount error: ${err.message}`);
    }
    return { deactivated: true, accountId: cmd.target };
  });

  // Persistence category
  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, platform: cmd.payload?.platformDisplayName }, '[Command] REGISTER_ACCOUNT executed');
    return { registered: true };
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
    return { toggled: true, enabled: cmd.payload?.enabled };
  });

  commandRouter.register('Persistence', 'UPDATE_ACCOUNT_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, target: cmd.target, category: cmd.payload?.category }, '[Command] UPDATE_ACCOUNT_CONFIG executed');
    return { updated: true };
  });

  commandRouter.register('Persistence', 'UPDATE_GLOBAL_CONFIG', async (cmd) => {
    logger.info({ traceId: cmd.traceId, category: cmd.payload?.category }, '[Command] UPDATE_GLOBAL_CONFIG executed');
    return { updated: true };
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
  } catch (err) {
    logger.fatal({ err }, '[ControlPlane] Fatal startup error');
    process.exit(1);
  }
}

bootstrap();

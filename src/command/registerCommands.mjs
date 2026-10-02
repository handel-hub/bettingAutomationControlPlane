// @ts-check
import { commandRouter } from './commandRouter.mjs';
import { securityFacade } from '../security-authority/facade.mjs';
import { logger } from '../shared/logging.mjs';
import { repositoryFactory } from '../repositories/repositoryFactory.mjs';
import { backendSyncService } from '../sync/backendSyncService.mjs';
import { runtimeManager } from '../runtime-manager/runtime-manager.mjs';
import { executionBoundaryManager } from '../runtime-manager/boundary/index.mjs';
import { workspaceAggregator } from '../state/workspaceAggregator.mjs';
import { ExecutionPayloadBuilder } from '../runtime-manager/boundary/ExecutionPayloadBuilder.mjs';
import { getSharedStateStore } from '../state-store/sharedStateStore.mjs';
import { SanitizerGate } from '../state-store/validation/SanitizerGate.mjs';

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

  commandRouter.register('Execution', 'EMERGENCY_STOP', async (cmd) => {
    logger.warn({ traceId: cmd.traceId, reason: cmd.payload?.reason }, '[Command] EMERGENCY_STOP received! Immediate hard containment initiated.');
    return executionBoundaryManager.lifecycleMutex.runExclusive(async () => {
      const store = getSharedStateStore();
      store.lifecycle.setDesiredState('STOPPED', 'EMERGENCY_STOP');
      store.lifecycle.setObservedState('STOPPING', 'EMERGENCY_STOP');

      // 1. Force kill execution runtimes and sever pipes immediately
      try {
        await executionBoundaryManager.stopCluster(0, { traceId: cmd.traceId });
      } catch {
        runtimeManager.terminateAll();
      } finally {
        runtimeManager.terminateAll();
        executionBoundaryManager.stopServer();
      }

      // 2. Freeze all active account leases
      try {
        const snapshot = await workspaceAggregator.getSnapshot();
        for (const acc of snapshot.accounts || []) {
          executionBoundaryManager.freezeAccountLease(acc.id, 'EMERGENCY_STOP');
        }
      } catch {}

      // 3. Mark observed state STOPPED
      store.lifecycle.setObservedState('STOPPED', 'EMERGENCY_STOP_COMPLETED');
      workspaceAggregator.setLifecycle('STOPPED');

      logger.warn({ traceId: cmd.traceId }, '[Command] EMERGENCY_STOP completed: all runtimes killed, account leases frozen.');
      return { emergencyStopped: true, halted: true };
    });
  });

  commandRouter.register('System', 'EMERGENCY_STOP', async (cmd) => {
    const handler = commandRouter.handlers.get('Execution')?.get('EMERGENCY_STOP')?.[0];
    if (handler) return handler(cmd);
    return { emergencyStopped: true };
  });

  commandRouter.register('Execution', 'CANCEL_ALL_BETS', async (cmd) => {
    logger.warn({ traceId: cmd.traceId }, '[Command] CANCEL_ALL_BETS executing');
    try {
      const snapshot = await workspaceAggregator.getSnapshot();
      for (const acc of snapshot.accounts || []) {
        executionBoundaryManager.freezeAccountLease(acc.id, 'CANCEL_ALL_BETS');
      }
    } catch {}
    return { cancelled: true, message: 'All betting leases frozen and pending wagers halted' };
  });

  commandRouter.register('Execution', 'FREEZE_ACCOUNT', async (cmd) => {
    const targetAccountId = cmd.target || cmd.payload?.accountId;
    logger.warn({ traceId: cmd.traceId, accountId: targetAccountId }, '[Command] FREEZE_ACCOUNT executing');
    if (targetAccountId) {
      executionBoundaryManager.freezeAccountLease(targetAccountId, cmd.payload?.reason || 'OPERATOR_FREEZE');
      return { frozen: true, accountId: targetAccountId };
    }
    return { frozen: false, error: 'No accountId specified' };
  });

  commandRouter.register('Execution', 'VIEW_STATUS', async (cmd) => {
    return {
      status: 'OK',
      systemState: securityFacade.getSystemState(),
      lifecycle: workspaceAggregator.lifecycle,
      activeBrowsers: workspaceAggregator.activeAccountIds.size,
      fleetReadiness: runtimeManager.getLatestFleetReadiness()
    };
  });

  commandRouter.register('System', 'VIEW_STATUS', async (cmd) => {
    return {
      status: 'OK',
      systemState: securityFacade.getSystemState(),
      lifecycle: workspaceAggregator.lifecycle,
      activeBrowsers: workspaceAggregator.activeAccountIds.size,
      fleetReadiness: runtimeManager.getLatestFleetReadiness()
    };
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

  commandRouter.register('Persistence', 'REGISTER_ACCOUNT', async (cmd) => {
    logger.info({ traceId: cmd.traceId, platform: cmd.payload?.platformDisplayName, payload: SanitizerGate.sanitize(cmd.payload) }, '[Command] REGISTER_ACCOUNT executing');
    let created = await repositoryFactory.getAccountsRepo().create(cmd.payload);
    try {
      const store = getSharedStateStore();
      store.accounts.upsert(created);
    } catch { /* ignore */ }
    workspaceAggregator.stageAccount(created.id);
    try {
      const syncResult = await backendSyncService.syncMutation('REGISTER_ACCOUNT', {
        id: created.id,
        ...cmd.payload
      });
      if (syncResult && syncResult.id && syncResult.id !== created.id) {
        const oldId = created.id;
        try {
          const store = getSharedStateStore();
          store.accounts.delete(oldId);
          created = { ...created, id: syncResult.id };
          store.accounts.upsert(created);
        } catch { /* ignore */ }
        workspaceAggregator.unstageAccount(oldId);
        workspaceAggregator.stageAccount(created.id);
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for REGISTER_ACCOUNT');
    }
    return created;
  });

  commandRouter.register('Persistence', 'ACCOUNT_ACTION', async (cmd) => {
    logger.info({ traceId: cmd.traceId, action: cmd.payload?.actionType, target: cmd.target, payload: cmd.payload }, '[Command] ACCOUNT_ACTION executed');
    try {
      await backendSyncService.syncMutation('ACCOUNT_ACTION', {
        accountId: cmd.target,
        action: cmd.payload?.actionType
      });
    } catch (err) {
      logger.warn({ err: err.message }, '[Command] Backend sync queued in outbox for ACCOUNT_ACTION');
    }
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

// @ts-check
import { repositoryFactory } from '../repositories/repositoryFactory.mjs';
import { CapabilityResolver } from './capabilityResolver.mjs';
import { operationTracker } from './operationTracker.mjs';
import { getSharedStateStore } from '../state-store/sharedStateStore.mjs';

/**
 * Aggregates live system state, account statuses, configuration,
 * and dynamic capabilities to produce the canonical AutomationWorkspaceSnapshot.
 */
export class WorkspaceAggregator {
  constructor() {
    /** @type {'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR_DEGRADED'} */
    this.lifecycle = 'STOPPED';
    this.lifecycleMessage = undefined;
    /** @type {Set<string>} active account IDs with live browser processes */
    this.activeAccountIds = new Set();
  }

  setLifecycle(lifecycle, message = undefined) {
    this.lifecycle = lifecycle;
    this.lifecycleMessage = message;
    try {
      const store = getSharedStateStore();
      if (store && store.lifecycle) {
        store.lifecycle.setObservedState(lifecycle, message || 'WORKSPACE_AGGREGATOR_UPDATE');
      }
    } catch { /* ignore */ }
  }

  activateAccount(accountId) {
    this.activeAccountIds.add(accountId);
  }

  deactivateAccount(accountId) {
    this.activeAccountIds.delete(accountId);
  }

  async getSnapshot() {
    const configRepo = repositoryFactory.getConfigRepo();
    const accountsRepo = repositoryFactory.getAccountsRepo();

    const [globalConfig, { viewportAccounts: accounts }] = await Promise.all([
      configRepo.getGlobalConfig(),
      accountsRepo.list()
    ]);

    const activeBrowsers = this.activeAccountIds.size;
    const maxCapacity = globalConfig.browserSpawning.maxAccountsToSpawn || 2;
    const globalActionPending = operationTracker.getCurrentPendingAction();

    // Map DB accounts into AccountAutomationSnapshot
    const accountSnapshots = await Promise.all(accounts.map(async (acc) => {
      const overrides = await configRepo.getAccountConfig(acc.id);
      const isBrowserActive = this.activeAccountIds.has(acc.id);

      return {
        id: acc.id,
        name: acc.name,
        platformDisplayName: acc.platformDisplayName,
        accountUsername: acc.accountUsername,
        accountStatus: isBrowserActive ? 'IN_USE' : 'IDLE',
        browserStatus: isBrowserActive ? 'ACTIVE' : 'STOPPED',
        desiredState: acc.desiredState || (isBrowserActive ? 'RUNNING' : 'STOPPED'),
        observedState: acc.observedState || (isBrowserActive ? 'RUNNING' : 'STOPPED'),
        executionStatusReason: acc.executionStatusReason || null,
        betCycleEnabled: overrides.betCycleEnabled ?? true,
        pricingSource: overrides.pricingSource || 'GLOBAL',
        riskSource: overrides.riskSource || 'GLOBAL',
        rebetSource: overrides.rebetSource || 'GLOBAL',
        customPricing: overrides.customPricing,
        customRisk: overrides.customRisk,
        customRebet: overrides.customRebet,
        pendingOperation: null,
        canActivate: !isBrowserActive && activeBrowsers < maxCapacity,
        canDeactivate: isBrowserActive,
        canToggleBetCycle: true
      };
    }));

    const capabilities = CapabilityResolver.resolve({
      lifecycle: this.lifecycle,
      isAuthorized: true,
      activeBrowsers,
      maxCapacity,
      globalActionPending,
      totalConfiguredAccounts: accounts.length
    });

    const engineStatus = this.lifecycle === 'RUNNING' 
      ? 'RUNNING' 
      : this.lifecycle === 'STOPPED' 
        ? 'READY' 
        : 'ERROR';

    return {
      lifecycle: this.lifecycle,
      lifecycleMessage: this.lifecycleMessage,
      capabilities,
      globalConfig,
      accounts: accountSnapshots,
      systemStatus: {
        acpConnected: true,
        engineStatus,
        backendConnected: true,
        activeBrowsers,
        totalConfiguredCapacity: maxCapacity
      },
      globalActionPending
    };
  }
}

export const workspaceAggregator = new WorkspaceAggregator();

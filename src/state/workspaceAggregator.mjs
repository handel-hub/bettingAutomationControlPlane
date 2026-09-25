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
    /** @type {Set<string>} staged account IDs ready in automation */
    this.stagedAccountIds = new Set();
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

  startAutomation() {
    this.setLifecycle('RUNNING', 'Execution engine active and processing');
    // Start browsers for all currently staged accounts
    for (const id of this.stagedAccountIds) {
      this.activeAccountIds.add(id);
    }
  }

  stopAutomation() {
    this.setLifecycle('STOPPED', 'Execution engine standby');
    // Stop all active browser processes
    this.activeAccountIds.clear();
  }

  activateAccount(accountId) {
    this.stagedAccountIds.add(accountId);
    this.activeAccountIds.add(accountId);
  }

  deactivateAccount(accountId) {
    this.stagedAccountIds.delete(accountId);
    this.activeAccountIds.delete(accountId);
  }

  stageAccount(accountId) {
    this.stagedAccountIds.add(accountId);
  }

  unstageAccount(accountId) {
    this.stagedAccountIds.delete(accountId);
    this.activeAccountIds.delete(accountId);
  }

  async getSnapshot() {
    const configRepo = repositoryFactory.getConfigRepo();
    const accountsRepo = repositoryFactory.getAccountsRepo();

    const [globalConfig, accountsRes] = await Promise.all([
      configRepo.getGlobalConfig(),
      accountsRepo.list()
    ]);
    const accounts = accountsRes?.viewportAccounts || [];
    const maxCapacity = globalConfig?.browserSpawning?.maxAccountsToSpawn || 2;

    // Auto-stage non-suspended accounts if stagedAccountIds is empty or has no match
    const nonSuspendedAccounts = accounts.filter(acc => acc.backendState !== 'SUSPENDED');
    const hasAnyStaged = nonSuspendedAccounts.some(acc => this.stagedAccountIds.has(acc.id));
    if (!hasAnyStaged && nonSuspendedAccounts.length > 0) {
      for (const acc of nonSuspendedAccounts.slice(0, maxCapacity)) {
        this.stagedAccountIds.add(acc.id);
      }
    }

    // Only accounts that are NOT SUSPENDED and are staged in automation
    const stagedAccounts = accounts.filter(acc => 
      acc.backendState !== 'SUSPENDED' && this.stagedAccountIds.has(acc.id)
    );

    const activeBrowsers = this.activeAccountIds.size;
    const globalActionPending = operationTracker.getCurrentPendingAction();

    // Map DB accounts into AccountAutomationSnapshot
    const accountSnapshots = await Promise.all(stagedAccounts.map(async (acc) => {
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
        currentBalance: Number(acc.lastKnownBalance || acc.currentBalance) || 0,
        currencySymbol: acc.currencySymbol || '₦',
        activeBetsCount: acc.activeBetsCount || 0,
        exposure: acc.exposure || 0,
        successRatePercent: acc.successRatePercent !== undefined ? acc.successRatePercent : 100.0,
        canActivate: !isBrowserActive && activeBrowsers < maxCapacity,
        canDeactivate: true,
        canToggleBetCycle: true
      };
    }));

    const capabilities = CapabilityResolver.resolve({
      lifecycle: this.lifecycle,
      isAuthorized: true,
      activeBrowsers,
      maxCapacity,
      globalActionPending,
      totalConfiguredAccounts: stagedAccounts.length
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

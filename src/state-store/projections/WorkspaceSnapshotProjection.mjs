// @ts-check

/**
 * Projects the canonical AutomationWorkspaceSnapshot combining in-memory configuration,
 * account records, and instantaneous runtime execution parameters.
 */
export class WorkspaceSnapshotProjection {
  /**
   * Projects complete AutomationWorkspaceSnapshot.
   * 
   * @param {import('../memory/AutomationConfigContainer.mjs').AutomationConfigContainer} configContainer
   * @param {import('../memory/AccountsContainer.mjs').AccountsContainer} accountsContainer
   * @param {object} runtimeState
   * @returns {Readonly<any>}
   */
  static project(configContainer, accountsContainer, runtimeState = {}) {
    const globalConfig = configContainer.getGlobalConfig();
    const accounts = accountsContainer.getAll();
    const activeBrowsers = runtimeState.activeBrowsers || 0;
    const maxCapacity = globalConfig.browserSpawning.maxAccountsToSpawn || 4;
    const lifecycle = runtimeState.lifecycle || 'STOPPED';

    const stagedAccountIds = (runtimeState.stagedAccountIds instanceof Set)
      ? runtimeState.stagedAccountIds
      : null;

    const eligibleAccounts = accounts.filter(acc => {
      if (acc.backendState === 'SUSPENDED') return false;
      if (stagedAccountIds) return stagedAccountIds.has(acc.id);
      return true;
    });

    const accountSnapshots = eligibleAccounts.map(acc => {
      const overrides = configContainer.getAccountOverride(acc.id);
      const isBrowserActive = (runtimeState.activeAccountIds instanceof Set)
        ? runtimeState.activeAccountIds.has(acc.id)
        : false;
      const bal = accountsContainer.getBalance(acc.id);

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
        betCycleEnabled: overrides.betCycleEnabled !== false,
        pricingSource: overrides.pricingSource || 'GLOBAL',
        riskSource: overrides.riskSource || 'GLOBAL',
        rebetSource: overrides.rebetSource || 'GLOBAL',
        effectiveConfig: { 
          baseStake: overrides.baseStake ?? globalConfig.pricing.baseStake, 
          source: overrides.pricingSource || 'GLOBAL' 
        },
        currentBalance: bal.balance,
        currencySymbol: bal.currencySymbol,
        activeBetsCount: 0,
        exposure: 0,
        successRatePercent: 100.0,
        pendingOperation: acc.pendingOperation || null,
        canActivate: !isBrowserActive && activeBrowsers < maxCapacity,
        canDeactivate: true,
        canToggleBetCycle: true
      };
    });

    const engineStatus = lifecycle === 'RUNNING'
      ? 'RUNNING'
      : lifecycle === 'STOPPED'
        ? 'READY'
        : 'ERROR';

    return Object.freeze({
      lifecycle,
      lifecycleMessage: runtimeState.lifecycleMessage,
      capabilities: runtimeState.capabilities || {
        canStartAutomation: lifecycle === 'STOPPED' && eligibleAccounts.length > 0,
        canStopAutomation: lifecycle === 'RUNNING',
        canPlaceBet: lifecycle === 'RUNNING' && activeBrowsers > 0,
        canCashOut: lifecycle === 'RUNNING' && activeBrowsers > 0,
        canValidate: lifecycle === 'RUNNING',
        canActivateAccount: lifecycle === 'STOPPED' && activeBrowsers < maxCapacity,
        activateAccountDisabledReason: lifecycle !== 'STOPPED' ? 'Cannot add accounts while automation is running' : undefined,
        canDeactivateAccount: activeBrowsers > 0,
        canIncreaseBrowserCount: activeBrowsers < maxCapacity,
        canDecreaseBrowserCount: activeBrowsers > 1,
        canToggleBetCycle: true,
        canEditPricing: true,
        canEditRisk: true,
        canEditRebet: true,
        canEditProxy: lifecycle === 'STOPPED',
        canEditExecution: true
      },
      globalConfig,
      accounts: accountSnapshots,
      systemStatus: {
        acpConnected: true,
        engineStatus,
        backendConnected: runtimeState.backendConnected !== false,
        activeBrowsers,
        totalConfiguredCapacity: maxCapacity
      },
      globalActionPending: runtimeState.globalActionPending || null
    });
  }
}

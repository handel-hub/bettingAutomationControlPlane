// @ts-check

/**
 * Authoritative capability resolution engine.
 * The frontend never derives permissions; ACP calculates and provides them.
 */
export class CapabilityResolver {
  /**
   * @param {object} params
   * @param {string} params.lifecycle - 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR_DEGRADED'
   * @param {boolean} [params.isAuthorized=true] - Operator authorized and licensed
   * @param {string} [params.authorizationReason] - Reason why authorization was denied
   * @param {boolean} [params.hasActiveRuntime=false] - Whether an execution process is alive
   * @param {number} params.activeBrowsers - Count of live active browser processes
   * @param {number} params.maxCapacity - Max accounts allowed to spawn
   * @param {string | null} params.globalActionPending - In-flight operation
   * @param {number} params.totalConfiguredAccounts - Total configured eligible accounts
   */
  static resolve({
    lifecycle = 'STOPPED',
    isAuthorized = true,
    authorizationReason = undefined,
    hasActiveRuntime = false,
    activeBrowsers = 0,
    maxCapacity = 2,
    globalActionPending = null,
    totalConfiguredAccounts = 0
  }) {
    const isRunning = lifecycle === 'RUNNING';
    const isStopped = lifecycle === 'STOPPED' || (lifecycle === 'ERROR_DEGRADED' && activeBrowsers === 0);
    const hasActiveBrowsers = activeBrowsers > 0;
    const hasPendingAction = globalActionPending !== null;

    // Start / Stop capabilities
    const canStartAutomation = isAuthorized && !hasActiveRuntime && isStopped && totalConfiguredAccounts > 0 && !hasPendingAction;
    const startDisabledReason = !canStartAutomation
      ? (!isStopped
          ? (isRunning ? 'Automation is already running' : 'Automation is currently transitioning')
          : hasActiveRuntime
            ? 'Automation runtime process is currently active'
            : !isAuthorized
              ? (authorizationReason || 'Operation prohibited by Security Authority')
              : totalConfiguredAccounts === 0
                ? 'At least one account must be configured'
                : hasPendingAction
                   ? 'Operation in progress'
                   : undefined)
      : undefined;

    const canStopAutomation = isRunning || lifecycle === 'STARTING';
    const stopDisabledReason = !canStopAutomation 
      ? (isStopped ? 'Automation is already stopped' : undefined) 
      : undefined;

    // Tactical operations
    const canPlaceBet = isRunning && hasActiveBrowsers && !hasPendingAction;
    const placeBetDisabledReason = !canPlaceBet
      ? (!isRunning ? 'Automation must be running to place bets' : !hasActiveBrowsers ? 'No active browsers available' : 'Operation in progress')
      : undefined;

    const canCashOut = isRunning && hasActiveBrowsers && !hasPendingAction;
    const cashOutDisabledReason = !canCashOut
      ? (!isRunning ? 'Automation must be running to cash out' : !hasActiveBrowsers ? 'No active browsers available' : 'Operation in progress')
      : undefined;

    const canValidate = isRunning && !hasPendingAction;
    const validateDisabledReason = !canValidate
      ? (!isRunning ? 'Automation must be running to validate sessions' : 'Operation in progress')
      : undefined;

    // Browser capacity operations
    const canActivateAccount = isStopped && activeBrowsers < maxCapacity && !hasPendingAction;
    const activateAccountDisabledReason = !canActivateAccount
      ? (isRunning ? 'Cannot add accounts while automation is running' : activeBrowsers >= maxCapacity ? 'Browser capacity limit reached' : hasPendingAction ? 'Operation in progress' : undefined)
      : undefined;
    const canDeactivateAccount = activeBrowsers > 0 && !hasPendingAction;
    const canIncreaseBrowserCount = isStopped || (activeBrowsers < maxCapacity);
    const canDecreaseBrowserCount = activeBrowsers > 1;

    // Per-account and config capabilities
    const canToggleBetCycle = true;
    const canEditPricing = true;
    const canEditRisk = true;
    const canEditRebet = true;
    const canEditProxy = isStopped; // Invariant: changing proxy mode while running is forbidden
    const canEditExecution = true;

    // Derived canonical capability tokens matching Security Authority & Backend contracts
    const rawCapabilities = [];
    if (canStartAutomation) rawCapabilities.push('CAP_AUTOMATION_START');
    if (canStopAutomation) rawCapabilities.push('CAP_AUTOMATION_STOP');
    if (canPlaceBet) rawCapabilities.push('CAP_TACTICAL_BET');
    if (canCashOut) rawCapabilities.push('CAP_CASH_OUT');
    if (canValidate) rawCapabilities.push('CAP_FILE_UPLOAD');
    if (canEditPricing) rawCapabilities.push('CAP_CONFIG_MODIFY');

    const capabilities = {
      canStartAutomation,
      startDisabledReason,
      canStopAutomation,
      stopDisabledReason,
      canPlaceBet,
      placeBetDisabledReason,
      canCashOut,
      cashOutDisabledReason,
      canValidate,
      validateDisabledReason,
      canActivateAccount,
      activateAccountDisabledReason,
      canDeactivateAccount,
      canIncreaseBrowserCount,
      canDecreaseBrowserCount,
      canToggleBetCycle,
      canEditPricing,
      canEditRisk,
      canEditRebet,
      canEditProxy,
      canEditExecution,
      rawCapabilities
    };

    // Non-enumerable helper to ensure backward/forward interoperability in test harnesses and Node runtimes
    Object.defineProperty(capabilities, 'includes', {
      value: function includes(cap) {
        if (!cap || typeof cap !== 'string') return false;
        if (cap in this && typeof this[cap] === 'boolean') {
          return this[cap];
        }
        const tokenMap = {
          CAP_AUTOMATION_START: this.canStartAutomation,
          CAP_AUTOMATION_STOP: this.canStopAutomation,
          CAP_TACTICAL_BET: this.canPlaceBet,
          CAP_BET_PLACE: this.canPlaceBet,
          CAP_CASH_OUT: this.canCashOut,
          CAP_BET_CASHOUT: this.canCashOut,
          CAP_FILE_UPLOAD: this.canValidate,
          CAP_BET_VALIDATE: this.canValidate,
          CAP_CONFIG_MODIFY: this.canEditPricing
        };
        if (cap in tokenMap) {
          return Boolean(tokenMap[cap]);
        }
        if (Array.isArray(this.rawCapabilities)) {
          return this.rawCapabilities.includes(cap);
        }
        return false;
      },
      enumerable: false,
      configurable: true,
      writable: true
    });

    return capabilities;
  }
}

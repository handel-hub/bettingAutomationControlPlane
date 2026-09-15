// @ts-check

/**
 * Standard contracts and default factory structures for the ACP State Store.
 * Reconciles frontend-backend-acp-contract.md and acp-sqlite-cacheability-audit.md.
 */

/**
 * Default global automation configuration (7 categories).
 */
export function createDefaultGlobalConfig() {
  return {
    pricing: {
      mode: 'PROFIT_TARGET',
      baseStake: 1000,
      targetProfit: 30000,
      minimumAcceptableProfit: 5000,
      resolutionStrategy: 'CLAMP_THEN_REDUCE_PROFIT',
      platformIncrement: 100,
      selectionPreference: 'ROUND_NUMBERS',
      restorePolicyOnRebet: true
    },
    risk: {
      autoAcceptOddsChanges: true,
      maxStake: 10000,
      minimumStake: 10,
      abortOnMarketSuspend: true,
      maxAllowedOddsDriftPercent: 5,
      stopLossThreshold: 25000,
      maxOpenOrdersTotal: 10,
      emergencyKillswitchActive: false
    },
    rebet: {
      maxRebetAttempts: 3,
      restorePolicyOnRebet: true,
      rebetDelayMs: 1500,
      exponentialBackoff: true,
      backoffMultiplier: 1.5,
      haltOnRepeatedRejection: true
    },
    proxy: {
      proxyAllocationMode: 'round_robin',
      proxyFailureMode: 'strict',
      maxAccountsPerProxy: 3,
      masterUseProxy: false,
      connectionTimeoutMs: 5000,
      rotateOnRateLimit: true,
      customDnsServers: ['1.1.1.1', '8.8.8.8']
    },
    execution: {
      timeouts: {
        resultTimeoutMs: 30000,
        navigationTimeoutMs: 10000,
        loginTimeoutMs: 15000,
        decisionFreshnessTTLMs: 5000,
        reconciliationTimeoutMs: 12000
      },
      retries: {
        maxExecutionRetries: 2,
        maxRecoveryAttempts: 3,
        recoveryBaseDelayMs: 1000
      },
      keyboardTypingDelayMs: 40,
      maxRecordedActions: 50,
      orderTimeoutMs: 8000,
      retryCount: 2,
      enforceOrderSequencing: true,
      interPlatformDelayMs: 250,
      pacingStrategy: 'AGGRESSIVE'
    },
    browserSpawning: {
      slaveMode: 'headful',
      maxAccountsToSpawn: 4,
      masterUseProxy: false,
      debugSlowMo: 0,
      spawnStaggerIntervalMs: 1200,
      headlessMemorySaver: false,
      enableGpuAcceleration: true
    },
    advancedRuntime: {
      browserBinary: 'chrome',
      useStealthPlugin: true,
      randomizeUserAgent: true,
      blockWebRTC: true,
      matchProxyTimezone: true,
      canvasSpoofing: true,
      disableWebRtc: true,
      spoofAudioContext: true,
      isolateCookiesPerSession: true,
      customUserAgentOverride: ''
    }
  };
}

/**
 * Default subscription snapshot.
 * @param {string} [userId]
 */
export function createDefaultSubscriptionSnapshot(userId = 'usr_default') {
  return {
    userId,
    currentPlan: 'Starter',
    currentPlanId: 'starter',
    price: 5000,
    currency: 'NGN',
    currencySymbol: '₦',
    status: 'Active',
    billingInterval: 'Monthly',
    renewalDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    expirationDate: null,
    entitlements: {
      maxAccounts: 3,
      maxConcurrentBrowsers: 2,
      allowedPlatformIds: ['sportybet', 'bet9ja', 'betking', '1xbet'],
      stealthAntidetectEnabled: false,
      priorityScanning: false
    },
    availableActions: ['CHANGE_PLAN', 'CANCEL_SUBSCRIPTION', 'UPDATE_PAYMENT'],
    notices: []
  };
}

/**
 * Default plans catalog.
 */
export function createDefaultPlansCatalog() {
  return {
    defaultPlanId: 'pro',
    annualDiscountPercent: 20,
    taxRate: 0.075,
    currency: 'NGN',
    currencySymbol: '₦',
    plans: [
      {
        id: 'starter',
        name: 'Starter',
        tagline: 'For individual operators getting started',
        description: 'Essential single-market trading tools with basic browser allocation.',
        monthlyPrice: 5000,
        annualPrice: 48000,
        popular: false,
        pricing: {
          monthlyPrice: 5000,
          annualPrice: 48000,
          currency: 'NGN',
          currencySymbol: '₦'
        },
        features: ['Up to 3 Connected Accounts', 'Standard Execution Speed', 'Email Alert Notifications'],
        entitlements: { maxAccounts: 3, maxConcurrentBrowsers: 2 }
      },
      {
        id: 'pro',
        name: 'Pro',
        tagline: 'Optimal for professional day arbitrageurs',
        description: 'Advanced multi-bookmaker routing, dedicated proxy chaining, and stealth execution.',
        monthlyPrice: 10000,
        annualPrice: 96000,
        popular: true,
        pricing: {
          monthlyPrice: 10000,
          annualPrice: 96000,
          currency: 'NGN',
          currencySymbol: '₦'
        },
        features: ['Up to 10 Connected Accounts', 'High-Priority Odds Scanning', 'Stealth Antidetect Profiling'],
        entitlements: { maxAccounts: 10, maxConcurrentBrowsers: 6 }
      }
    ]
  };
}

/**
 * Default platform registry.
 */
export function createDefaultPlatformRegistry() {
  return {
    defaultPlatformId: 'sportybet',
    platforms: [
      { id: 'sportybet', displayName: 'SportyBet', status: 'ONLINE', isAvailable: true, iconUrl: null, sortOrder: 1 },
      { id: 'bet9ja', displayName: 'Bet9ja', status: 'ONLINE', isAvailable: true, iconUrl: null, sortOrder: 2 },
      { id: 'betking', displayName: 'BetKing', status: 'ONLINE', isAvailable: true, iconUrl: null, sortOrder: 3 },
      { id: '1xbet', displayName: '1xBet', status: 'ONLINE', isAvailable: true, iconUrl: null, sortOrder: 4 }
    ]
  };
}

/**
 * Default user settings.
 * @param {string} [userId]
 */
export function createDefaultUserSettings(userId = 'usr_default') {
  return {
    userId,
    profile: {
      status: 'AVAILABLE',
      data: {
        name: 'Operator',
        email: 'operator@betting-automation.internal',
        pendingEmail: null,
        avatarUrl: null
      }
    },
    security: {
      status: 'AVAILABLE',
      data: {
        accountStatus: 'ACTIVE',
        deletionScheduledAt: null,
        mfaEnabled: false,
        activeSessions: 1
      }
    },
    presentationPreferences: {
      theme: 'light',
      density: 'comfortable'
    },
    notifications: {
      status: 'AVAILABLE',
      data: {
        emailAlerts: true,
        pushAlerts: false,
        weeklyReport: true
      }
    },
    capabilities: {
      canChangeName: true,
      canChangeEmail: true,
      canChangePassword: true,
      canConfigureMFA: true,
      canRevokeSessions: true,
      canDeleteAccount: false,
      canCancelDeletion: false
    }
  };
}

/**
 * Default automation strategy options catalog.
 */
export const DEFAULT_STRATEGY_CATALOG = Object.freeze({
  pricingModes: [
    { id: 'PROFIT_TARGET', label: 'Profit Target', description: 'Calculate stake to reach target profit margin', enabled: true },
    { id: 'FIXED', label: 'Fixed Stake', description: 'Flat stake amount placed on every eligible market', enabled: true }
  ],
  resolutionStrategies: [
    { id: 'CLAMP_THEN_REDUCE_PROFIT', label: 'Clamp Then Reduce Profit', description: 'Clamp stake to maximum threshold and accept reduced profit', enabled: true },
    { id: 'ABORT', label: 'Abort', description: 'Reject bet order immediately if odds drift', enabled: true }
  ],
  selectionPreferences: [
    { id: 'ROUND_NUMBERS', label: 'Round Numbers', description: 'Round calculated stakes to nearest round unit', enabled: true },
    { id: 'EXACT', label: 'Exact', description: 'Execute mathematically exact stake calculation', enabled: true }
  ],
  proxyAllocationModes: [
    { id: 'round_robin', label: 'Round Robin (Distribute Evenly)', description: 'Cycle through proxy pool sequentially', enabled: true },
    { id: 'sticky', label: 'Sticky Session (Dedicated Per Runner)', description: 'Keep runner locked to single residential IP', enabled: true },
    { id: 'random', label: 'Random Selection', description: 'Pick random proxy from pool on every request', enabled: true }
  ],
  proxyFailureModes: [
    { id: 'loose', label: 'Loose (Fallback to Direct Connection)', description: 'Continue automation without proxy if proxy node fails', enabled: true },
    { id: 'strict', label: 'Strict (Fail Fast if Proxy Fails)', description: 'Pause automation immediately if proxy connection breaks', enabled: true }
  ],
  slaveModes: [
    { id: 'headful', label: 'Headful (Visible on Desktop)', description: 'Launch visible browser windows for live monitoring', enabled: true },
    { id: 'headless', label: 'Headless (Background Process)', description: 'Run headless background processes for minimal RAM consumption', enabled: true }
  ],
  supportedBrowserBinaries: [
    { id: 'chrome', label: 'Google Chrome (Installed system binary)', description: 'Recommended for high antidetect fidelity', enabled: true },
    { id: 'chromium', label: 'Chromium Engine', description: 'Bundled standalone Chromium engine', enabled: true },
    { id: 'firefox', label: 'Mozilla Firefox', description: 'Gecko rendering engine', enabled: false }
  ]
});

export function createDefaultStrategyCatalog() {
  return JSON.parse(JSON.stringify(DEFAULT_STRATEGY_CATALOG));
}


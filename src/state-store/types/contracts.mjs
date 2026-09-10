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
      maxAllowedOddsDriftPercent: 5,
      stopLossThreshold: 25000,
      maxOpenOrdersTotal: 10,
      emergencyKillswitchActive: false
    },
    rebet: {
      maxRebetAttempts: 3,
      rebetDelayMs: 1500,
      exponentialBackoff: true,
      backoffMultiplier: 1.5,
      haltOnRepeatedRejection: true
    },
    proxy: {
      proxyAllocationMode: 'round_robin',
      proxyFailureMode: 'strict',
      maxAccountsPerProxy: 3,
      connectionTimeoutMs: 5000,
      rotateOnRateLimit: true,
      customDnsServers: ['1.1.1.1', '8.8.8.8']
    },
    execution: {
      orderTimeoutMs: 8000,
      retryCount: 2,
      enforceOrderSequencing: true,
      interPlatformDelayMs: 250,
      pacingStrategy: 'AGGRESSIVE'
    },
    browserSpawning: {
      slaveMode: 'headful',
      maxAccountsToSpawn: 4,
      spawnStaggerIntervalMs: 1200,
      headlessMemorySaver: false,
      enableGpuAcceleration: true
    },
    advancedRuntime: {
      browserBinary: 'chrome',
      useStealthPlugin: true,
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

// @ts-check

/**
 * Authoritative test fixtures matching Section 5.3 of frontend-backend-acp-contract.md.
 */

export const MOCK_ACCOUNTS = [
  {
    id: 'acc-1',
    name: 'SportyBet Primary',
    platformDisplayName: 'SportyBet',
    platformId: 'sportybet',
    accountUsername: 'operator_alpha',
    backendState: 'READY',
    presentationCategory: 'Healthy',
    statusDescription: 'Active & Synchronized',
    isSelectable: true,
    availableActions: ['DEACTIVATE', 'DELETE'],
    pendingOperation: null,
    tags: ['Production', 'Fast-Odds'],
    lastKnownBalance: 142500,
    currencySymbol: '₦',
    lastUpdated: '2026-09-10T00:30:00.000Z',
    lastSynchronization: '2026-09-10T00:45:00.000Z'
  },
  {
    id: 'acc-2',
    name: 'Bet9ja Secondary',
    platformDisplayName: 'Bet9ja',
    platformId: 'bet9ja',
    accountUsername: 'operator_beta',
    backendState: 'ACTIVE',
    presentationCategory: 'Healthy',
    statusDescription: 'Operating normally',
    isSelectable: true,
    availableActions: ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
    pendingOperation: null,
    tags: ['Backup'],
    lastKnownBalance: 85000,
    currencySymbol: '₦',
    lastUpdated: '2026-09-10T00:30:00.000Z',
    lastSynchronization: '2026-09-10T00:45:00.000Z'
  }
];

export const MOCK_GLOBAL_CONFIG = {
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

export const MOCK_PLANS_CATALOG = {
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
      pricing: { monthlyPrice: 5000, annualPrice: 48000, currency: 'NGN', currencySymbol: '₦' },
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
      pricing: { monthlyPrice: 10000, annualPrice: 96000, currency: 'NGN', currencySymbol: '₦' },
      features: ['Up to 10 Connected Accounts', 'High-Priority Odds Scanning', 'Stealth Antidetect Profiling'],
      entitlements: { maxAccounts: 10, maxConcurrentBrowsers: 6 }
    }
  ]
};

export const MOCK_NOTIFICATIONS = [
  {
    id: 'notif-1',
    timestamp: '2026-09-10T00:40:00.000Z',
    severity: 'SUCCESS',
    category: 'AUTOMATION',
    title: 'Target Profit Reached',
    message: 'Account SportyBet Primary reached target profit of ₦30,000 for market #4928.',
    read: false,
    isRead: false
  },
  {
    id: 'notif-2',
    timestamp: '2026-09-10T00:20:00.000Z',
    severity: 'WARNING',
    category: 'SYSTEM',
    title: 'Proxy Node Latency Spike',
    message: 'Residential proxy node response time exceeded 480ms.',
    read: false,
    isRead: false
  }
];

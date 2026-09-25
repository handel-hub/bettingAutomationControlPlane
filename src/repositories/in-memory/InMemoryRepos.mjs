// @ts-check
import { 
  IAccountsRepository, 
  IAutomationConfigRepository, 
  IBillingRepository, 
  ISettingsRepository, 
  INotificationsRepository 
} from '../IRepositories.mjs';

export class InMemoryAccountsRepo extends IAccountsRepository {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.accounts = new Map();
    this._seed();
  }

  _seed() {
    this._isSeeded = true;
    const acc1 = {
      id: 'acc-1',
      name: 'SportyBet Primary',
      platformDisplayName: 'SportyBet',
      accountUsername: 'sporty_pro_01',
      accountPassword: '••••••••',
      backendState: 'ACTIVE',
      presentationCategory: 'Healthy',
      statusDescription: 'Operating normally',
      isSelectable: true,
      availableActions: ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
      pendingOperation: null,
      tags: ['primary', 'vip'],
      lastUpdated: new Date().toISOString(),
      lastSynchronization: new Date().toISOString()
    };
    const acc2 = {
      id: 'acc-2',
      name: 'Bet9ja Secondary',
      platformDisplayName: 'Bet9ja',
      accountUsername: 'bet9ja_runner_02',
      accountPassword: '••••••••',
      backendState: 'ACTIVE',
      presentationCategory: 'Healthy',
      statusDescription: 'Operating normally',
      isSelectable: true,
      availableActions: ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
      pendingOperation: null,
      tags: ['backup'],
      lastUpdated: new Date().toISOString(),
      lastSynchronization: new Date().toISOString()
    };
    this.accounts.set(acc1.id, acc1);
    this.accounts.set(acc2.id, acc2);
  }

  /**
   * Hydrates repository with authoritative accounts from Cloud Backend or local cache.
   * Preserves active browser and runtime states if already active in memory.
   * @param {Array<any>} accountsList 
   */
  hydrate(accountsList) {
    if (!Array.isArray(accountsList) || accountsList.length === 0) return;

    // Clear seed data upon receiving real accounts
    if (this._isSeeded) {
      this.accounts.clear();
      this._isSeeded = false;
    }

    for (const remoteAcc of accountsList) {
      const existing = this.accounts.get(remoteAcc.id);
      if (existing) {
        this.accounts.set(remoteAcc.id, {
          ...remoteAcc,
          accountStatus: existing.accountStatus || remoteAcc.accountStatus || 'IDLE',
          browserStatus: existing.browserStatus || remoteAcc.browserStatus || 'STOPPED',
          lastSynchronization: new Date().toISOString()
        });
      } else {
        this.accounts.set(remoteAcc.id, {
          ...remoteAcc,
          accountStatus: remoteAcc.accountStatus || 'IDLE',
          browserStatus: remoteAcc.browserStatus || 'STOPPED',
          lastSynchronization: new Date().toISOString()
        });
      }
    }
  }


  async list(filters = {}, pagination = { offset: 0, limit: 50 }) {
    let items = Array.from(this.accounts.values());
    if (filters.filterQuery) {
      const q = filters.filterQuery.toLowerCase();
      items = items.filter(a => a.name.toLowerCase().includes(q) || a.accountUsername.toLowerCase().includes(q));
    }
    const offset = Number(pagination.offset) || 0;
    const limit = Number(pagination.limit) || 50;
    const viewportAccounts = items.slice(offset, offset + limit);

    return {
      viewportAccounts,
      bulkCapabilities: {
        supportedOperations: ['BULK_DELETE', 'BULK_ACTIVATE', 'BULK_DEACTIVATE'],
        maximumSelection: 20,
        requiresConfirmation: true,
        canRunWhileAutomationActive: true
      },
      searchMetadata: {
        totalCount: items.length,
        currentFilters: [],
        appliedTags: [],
        savedSearches: [],
        recentSearches: []
      }
    };
  }

  async findById(id) {
    return this.accounts.get(id) || null;
  }

  async findByPlatformAndUsername(platform, username) {
    const p = platform.toLowerCase();
    const u = username.toLowerCase();
    for (const acc of this.accounts.values()) {
      if (acc.platformDisplayName.toLowerCase() === p && acc.accountUsername.toLowerCase() === u) {
        return acc;
      }
    }
    return null;
  }

  async create(accountData) {
    const existing = await this.findByPlatformAndUsername(accountData.platformDisplayName, accountData.accountUsername);
    if (existing) {
      const err = new Error(`Account with platform '${accountData.platformDisplayName}' and username '${accountData.accountUsername}' already exists.`);
      err['code'] = 'ACCOUNT_ALREADY_EXISTS';
      err['status'] = 409;
      throw err;
    }

    const id = accountData.id || `acc-${Date.now()}`;
    const newAccount = {
      id,
      name: accountData.name || accountData.accountUsername,
      platformDisplayName: accountData.platformDisplayName,
      accountUsername: accountData.accountUsername,
      accountPassword: '••••••••',
      backendState: 'ACTIVE',
      presentationCategory: 'Healthy',
      statusDescription: 'Operating normally',
      isSelectable: true,
      availableActions: ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
      pendingOperation: null,
      tags: accountData.tags || [],
      lastUpdated: new Date().toISOString(),
      lastSynchronization: new Date().toISOString()
    };

    this.accounts.set(id, newAccount);
    return newAccount;
  }

  async update(id, updates) {
    const acc = this.accounts.get(id);
    if (!acc) return null;
    const updated = { ...acc, ...updates, lastUpdated: new Date().toISOString() };
    this.accounts.set(id, updated);
    return updated;
  }

  async delete(id) {
    return this.accounts.delete(id);
  }

  async bulkAction(type, ids) {
    let successful = 0;
    let failed = 0;
    const errors = [];

    for (const id of ids) {
      const acc = this.accounts.get(id);
      if (!acc) {
        failed++;
        errors.push({ id, reason: 'Account not found' });
        continue;
      }
      if (type === 'BULK_DELETE') {
        this.accounts.delete(id);
        successful++;
      } else if (type === 'BULK_ACTIVATE') {
        acc.backendState = 'ACTIVE';
        acc.presentationCategory = 'Healthy';
        successful++;
      } else if (type === 'BULK_DEACTIVATE') {
        acc.backendState = 'SUSPENDED';
        acc.presentationCategory = 'Neutral';
        successful++;
      }
    }

    return { operation: type, successful, failed, errors };
  }
}

export class InMemoryConfigRepo extends IAutomationConfigRepository {
  constructor() {
    super();
    this.globalConfig = {
      pricing: {
        mode: 'PROFIT_TARGET',
        baseStake: 100,
        targetProfit: 30,
        minimumAcceptableProfit: 0,
        resolutionStrategy: 'CLAMP_THEN_REDUCE_PROFIT',
        platformIncrement: 1,
        selectionPreference: 'ROUND_NUMBERS',
        restorePolicyOnRebet: true
      },
      risk: {
        autoAcceptOddsChanges: false,
        maxStake: 10000,
        minimumStake: 10,
        abortOnMarketSuspend: true
      },
      rebet: {
        maxRebetAttempts: 3,
        restorePolicyOnRebet: true
      },
      proxy: {
        proxyFailureMode: 'loose',
        proxyAllocationMode: 'round_robin',
        maxAccountsPerProxy: 5,
        masterUseProxy: false
      },
      execution: {
        timeouts: {
          resultTimeoutMs: 30000,
          navigationTimeoutMs: 10000,
          loginTimeoutMs: 15000,
          decisionFreshnessTTLMs: 3000,
          reconciliationTimeoutMs: 120000
        },
        retries: {
          maxExecutionRetries: 3,
          maxRecoveryAttempts: 3,
          recoveryBaseDelayMs: 2000
        },
        keyboardTypingDelayMs: 250,
        maxRecordedActions: 1000
      },
      browserSpawning: {
        maxAccountsToSpawn: 2,
        slaveMode: 'headful',
        masterUseProxy: false,
        debugSlowMo: 0
      },
      advancedRuntime: {
        useStealthPlugin: false,
        browserBinary: 'chrome',
        randomizeUserAgent: false,
        blockWebRTC: false,
        matchProxyTimezone: true,
        canvasSpoofing: false
      }
    };

    /** @type {Map<string, any>} */
    this.accountConfigs = new Map();
  }

  /**
   * Hydrates configuration with authoritative global and per-account settings from Backend or local cache.
   * @param {Object} [globalConfig]
   * @param {Record<string, any>} [accountConfigs]
   */
  hydrate(globalConfig, accountConfigs = {}) {
    if (globalConfig && typeof globalConfig === 'object') {
      for (const [cat, vals] of Object.entries(globalConfig)) {
        if (this.globalConfig[cat] && typeof vals === 'object') {
          this.globalConfig[cat] = { ...this.globalConfig[cat], ...vals };
        } else if (vals && typeof vals === 'object') {
          this.globalConfig[cat] = vals;
        }
      }
    }
    if (accountConfigs && typeof accountConfigs === 'object') {
      for (const [accId, cfg] of Object.entries(accountConfigs)) {
        this.accountConfigs.set(accId, cfg);
      }
    }
  }

  async getGlobalConfig() {
    return JSON.parse(JSON.stringify(this.globalConfig));
  }


  async updateCategory(category, values) {
    if (!this.globalConfig[category]) {
      throw new Error(`Unknown configuration category: ${category}`);
    }
    this.globalConfig[category] = { ...this.globalConfig[category], ...values };
    return this.getGlobalConfig();
  }

  async getAccountConfig(accountId) {
    return this.accountConfigs.get(accountId) || {
      betCycleEnabled: true,
      pricingSource: 'GLOBAL',
      riskSource: 'GLOBAL',
      rebetSource: 'GLOBAL'
    };
  }

  async updateAccountConfig(accountId, updates) {
    const current = await this.getAccountConfig(accountId);
    const updated = { ...current, ...updates };
    this.accountConfigs.set(accountId, updated);
    return updated;
  }
}

export class InMemoryBillingRepo extends IBillingRepository {
  constructor() {
    super();
    this.snapshot = {
      currentPlan: 'Pro',
      price: 10000,
      currency: '₦',
      status: 'Active',
      billingInterval: 'Monthly',
      renewalDate: new Date(Date.now() + 30 * 86400000).toISOString(),
      expirationDate: null,
      availableActions: ['UPDATE_PAYMENT', 'CANCEL_SUBSCRIPTION'],
      notices: [],
      paymentMethod: {
        cardBrand: 'Mastercard',
        last4: '4081',
        expMonth: '12',
        expYear: '2028'
      },
      invoices: [
        {
          id: 'inv_101',
          reference: 'PSTK-REC-89214',
          date: new Date().toISOString(),
          amount: 10000,
          status: 'Paid',
          receiptUrl: 'https://paystack.com/receipt/sample'
        }
      ]
    };
  }

  async getSnapshot() {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  async updateSubscription(updates) {
    this.snapshot = { ...this.snapshot, ...updates };
    return this.getSnapshot();
  }

  async addInvoice(invoice) {
    this.snapshot.invoices = this.snapshot.invoices || [];
    this.snapshot.invoices.unshift(invoice);
    return invoice;
  }

  async verifyReference(reference) {
    return {
      status: 'Authorized',
      snapshot: await this.getSnapshot()
    };
  }
}

export class InMemorySettingsRepo extends ISettingsRepository {
  constructor() {
    super();
    this.snapshot = {
      profile: {
        status: 'AVAILABLE',
        data: {
          name: 'Chief Operator',
          email: 'operator@bettingautomation.io',
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
      automationPreferences: {
        status: 'AVAILABLE',
        data: {
          defaultExecutionMode: 'auto',
          maxConcurrentRuns: 2
        }
      },
      notifications: {
        status: 'AVAILABLE',
        data: {
          emailAlerts: true,
          pushAlerts: true,
          weeklyReport: true
        }
      },
      presentationPreferences: {
        theme: 'dark',
        density: 'comfortable'
      },
      capabilities: {
        canChangeName: true,
        canChangeEmail: true,
        canChangePassword: true,
        canConfigureMFA: true,
        canRevokeSessions: true,
        canDeleteAccount: true,
        canCancelDeletion: false
      }
    };
  }

  async getSnapshot() {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  async updateProfile(updates) {
    if (this.snapshot.profile.data) {
      this.snapshot.profile.data = { ...this.snapshot.profile.data, ...updates };
    }
    return this.getSnapshot();
  }

  async updateSecurity(updates) {
    if (this.snapshot.security.data) {
      this.snapshot.security.data = { ...this.snapshot.security.data, ...updates };
    }
    return this.getSnapshot();
  }

  async updatePreferences(updates) {
    this.snapshot.presentationPreferences = { ...this.snapshot.presentationPreferences, ...updates };
    return this.getSnapshot();
  }
}

export class InMemoryNotificationsRepo extends INotificationsRepository {
  constructor() {
    super();
    /** @type {any[]} */
    this.notifications = [
      {
        id: 'notif-1',
        timestamp: new Date().toISOString(),
        severity: 'INFO',
        category: 'SYSTEM',
        title: 'Control Plane Online',
        message: 'Betting Automation Control Plane v0.1.0-alpha initialized.',
        read: false
      }
    ];
  }

  async list(options = {}) {
    let list = [...this.notifications];
    if (options.unreadOnly) {
      list = list.filter(n => !n.read);
    }
    if (options.severity && options.severity !== 'ALL') {
      list = list.filter(n => n.severity === options.severity);
    }
    const unreadCount = this.notifications.filter(n => !n.read).length;
    return { notifications: list, unreadCount };
  }

  async add(notification) {
    const notif = {
      id: notification.id || `notif-${Date.now()}`,
      timestamp: new Date().toISOString(),
      severity: notification.severity || 'INFO',
      category: notification.category || 'SYSTEM',
      title: notification.title,
      message: notification.message,
      read: false,
      metadata: notification.metadata || {}
    };
    this.notifications.unshift(notif);
    return notif;
  }

  async markRead(id) {
    const n = this.notifications.find(item => item.id === id);
    if (n) n.read = true;
    return { success: true, id };
  }

  async markAllRead() {
    let markedCount = 0;
    for (const n of this.notifications) {
      if (!n.read) {
        n.read = true;
        markedCount++;
      }
    }
    return { success: true, markedCount };
  }

  async delete(id) {
    this.notifications = this.notifications.filter(n => n.id !== id);
    return { success: true, id };
  }

  async clearAll() {
    this.notifications = [];
    return { success: true };
  }
}

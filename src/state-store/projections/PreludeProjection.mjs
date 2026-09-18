// @ts-check

/**
 * Compiles the complete, immutable atomic Prelude payload matching Section 5.3
 * of frontend-backend-acp-contract.md.
 * Memoizes the projection against container revision keys for microsecond retrieval.
 */
export class PreludeProjection {
  constructor() {
    this._cachedPayload = null;
    this._cachedRevisionKey = null;
  }

  /**
   * Clears memoized projection cache.
   */
  invalidate() {
    this._cachedPayload = null;
    this._cachedRevisionKey = null;
  }

  /**
   * Projects atomic Prelude payload.
   * 
   * @param {string} userId
   * @param {object} containers
   * @param {import('../memory/AccountsContainer.mjs').AccountsContainer} containers.accounts
   * @param {import('../memory/AutomationConfigContainer.mjs').AutomationConfigContainer} containers.config
   * @param {import('../memory/BillingContainer.mjs').BillingContainer} containers.billing
   * @param {import('../memory/CatalogsContainer.mjs').CatalogsContainer} containers.catalogs
   * @param {import('../memory/SettingsContainer.mjs').SettingsContainer} containers.settings
   * @param {import('../memory/NotificationsContainer.mjs').NotificationsContainer} containers.notifications
   * @param {object} [runtimeState]
   * @returns {Readonly<any>}
   */
  project(userId, containers, runtimeState = {}) {
    const revisionKey = `${containers.accounts.revision}:${containers.config.revision}:${containers.billing.revision}:${containers.catalogs.revision}:${containers.settings.revision}:${containers.notifications.revision}`;

    if (this._cachedPayload && this._cachedRevisionKey === revisionKey) {
      return this._cachedPayload;
    }

    const now = new Date().toISOString();
    const settingsSnapshot = containers.settings.getSnapshot();
    const userProfile = settingsSnapshot.profile.data;
    const billingSnapshot = containers.billing.getSnapshot();
    const plansCatalog = containers.catalogs.getPlansCatalog();
    const platformRegistry = containers.catalogs.getPlatformRegistry();
    const accounts = containers.accounts.getAll();
    const globalConfig = containers.config.getGlobalConfig();
    const strategyCatalog = containers.catalogs.getStrategyCatalog();
    const notifs = containers.notifications.getAll();

    // Map accounts to initial view
    const viewportAccounts = accounts.map(acc => {
      const bal = containers.accounts.getBalance(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        platformDisplayName: acc.platformDisplayName,
        accountUsername: acc.accountUsername,
        accountPassword: '[PROTECTED]',
        backendState: acc.backendState,
        presentationCategory: acc.presentationCategory,
        statusDescription: acc.statusDescription,
        isSelectable: acc.isSelectable,
        availableActions: acc.availableActions,
        pendingOperation: acc.pendingOperation,
        tags: acc.tags,
        lastUpdated: acc.lastUpdated,
        lastSynchronization: acc.lastSynchronization,
        currentBalance: bal.balance,
        currencySymbol: bal.currencySymbol
      };
    });

    const payload = {
      protocol: {
        protocolVersion: '1.0.0',
        serverTime: now,
        acpInstanceId: 'acp-local-node-01',
        environment: 'production'
      },
      lifecycle: {
        state: runtimeState.lifecycleState || 'Authorized',
        message: runtimeState.lifecycleMessage || 'Control Plane operational and synchronized'
      },
      user: {
        id: userId,
        name: userProfile.name || 'Operator',
        email: userProfile.email || 'operator@betting-automation.internal',
        avatarUrl: userProfile.avatarUrl || null,
        role: 'OPERATOR'
      },
      billing: {
        snapshot: billingSnapshot,
        plansCatalog: plansCatalog
      },
      accounts: {
        platformRegistry: platformRegistry,
        initialView: {
          viewportAccounts: viewportAccounts,
          bulkCapabilities: {
            supportedOperations: ['BULK_ACTIVATE', 'BULK_DEACTIVATE', 'BULK_DELETE'],
            maximumSelection: 20,
            requiresConfirmation: true,
            canRunWhileAutomationActive: false
          },
          searchMetadata: {
            totalCount: viewportAccounts.length,
            totalMatches: viewportAccounts.length,
            returnedOffset: 0,
            currentFilters: [],
            appliedTags: [],
            savedSearches: [],
            recentSearches: [],
            activeFilterSummary: 'All Accounts'
          }
        }
      },
      automation: {
        strategyCatalog: strategyCatalog,
        snapshot: {
          lifecycle: runtimeState.lifecycle || runtimeState.automationLifecycle || 'STOPPED',
          lifecycleMessage: runtimeState.lifecycleMessage || runtimeState.automationMessage || 'Execution engine standby',
          capabilities: runtimeState.capabilities || runtimeState.automationCapabilities || {
            canStartAutomation: true,
            canStopAutomation: false,
            canPlaceBet: false,
            canCashOut: false,
            canValidate: false,
            canActivateAccount: true,
            canDeactivateAccount: false,
            canIncreaseBrowserCount: true,
            canDecreaseBrowserCount: false,
            canToggleBetCycle: true,
            canEditPricing: true,
            canEditRisk: true,
            canEditRebet: true,
            canEditProxy: true,
            canEditExecution: true
          },
          globalConfig: globalConfig,
          accounts: (Array.isArray(runtimeState.automationAccounts) && runtimeState.automationAccounts.length > 0)
            ? runtimeState.automationAccounts.filter(acc => acc.backendState !== 'SUSPENDED' && acc.status !== 'SUSPENDED') 
            : viewportAccounts
                .filter(acc => acc.backendState === 'ACTIVE' && (
                  runtimeState.stagedAccountIds instanceof Set && runtimeState.stagedAccountIds.size > 0
                    ? runtimeState.stagedAccountIds.has(acc.id) 
                    : true
                ))
                .map(acc => ({
                  id: acc.id,
                  name: acc.name,
                  platformDisplayName: acc.platformDisplayName,
                  accountUsername: acc.accountUsername,
                  status: acc.backendState,
                  activeBetsCount: 0,
                  betCycleEnabled: true,
                  currencySymbol: acc.currencySymbol,
                  currentBalance: acc.currentBalance,
                  exposure: 0,
                  successRatePercent: 100.0,
                  effectiveConfig: { baseStake: globalConfig.pricing.baseStake, source: 'GLOBAL' },
                  pricingSource: 'GLOBAL',
                  riskSource: 'GLOBAL',
                  rebetSource: 'GLOBAL',
                  pendingOperation: null,
                  canActivate: true,
                  canDeactivate: true,
                  canToggleBetCycle: true
                })),
          systemStatus: {
            acpConnected: true,
            engineStatus: runtimeState.engineStatus || 'READY',
            backendConnected: runtimeState.backendConnected !== false,
            activeBrowsers: runtimeState.activeBrowsers || 0,
            totalConfiguredCapacity: globalConfig.browserSpawning.maxAccountsToSpawn || 4
          },
          globalActionPending: runtimeState.globalActionPending || null
        }
      },
      settings: {
        snapshot: settingsSnapshot
      },
      support: {
        snapshot: {
          openTicketCount: 0,
          contactMethods: [
            { id: 'ticket', title: 'Support Ticket', description: 'Create a priority support request', actionType: 'INTERNAL_ROUTE', actionTarget: '/workspace/support/tickets/new', available: true },
            { id: 'discord', title: 'Discord Community', description: 'Join professional operators', actionType: 'EXTERNAL_LINK', actionTarget: 'https://discord.gg/betting-automation', available: true }
          ],
          documentationState: { cached: true, rootCategory: 'guides' },
          documentationLastSync: now,
          systemHealthSummary: 'Healthy'
        }
      },
      notifications: {
        unreadCount: containers.notifications.unreadCount,
        items: notifs.slice(0, 20)
      },
      system: {
        appName: 'Betting Automation Console',
        version: 'v1.4.1',
        currentVersion: 'v1.4.1',
        hasUpdateDownloaded: false,
        availableVersion: 'v1.4.1',
        nodeEnvironment: process.env.NODE_ENV || 'production'
      }
    };

    const envelope = Object.freeze({
      topic: 'app:prelude',
      payload: Object.freeze(payload)
    });

    this._cachedPayload = envelope;
    this._cachedRevisionKey = revisionKey;

    return envelope;
  }
}

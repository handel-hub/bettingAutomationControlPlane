// @ts-check
import fs from 'fs';
import path from 'path';
import { SqliteStorageEngine } from './persistence/SqliteStorageEngine.mjs';
import { SchemaMigrator } from './schema/SchemaMigrator.mjs';
import { MetadataAdapter } from './persistence/adapters/MetadataAdapter.mjs';
import { AccountsAdapter } from './persistence/adapters/AccountsAdapter.mjs';
import { ConfigAdapter } from './persistence/adapters/ConfigAdapter.mjs';
import { BillingAdapter } from './persistence/adapters/BillingAdapter.mjs';
import { CatalogsAdapter } from './persistence/adapters/CatalogsAdapter.mjs';
import { SettingsAdapter } from './persistence/adapters/SettingsAdapter.mjs';
import { NotificationsAdapter } from './persistence/adapters/NotificationsAdapter.mjs';
import { LifecycleStateAdapter, DesiredLifecycleState, ObservedLifecycleState } from './persistence/adapters/LifecycleStateAdapter.mjs';
import { ConsistencyGroupManager } from './persistence/ConsistencyGroupManager.mjs';
import { AccountsContainer } from './memory/AccountsContainer.mjs';
import { AutomationConfigContainer } from './memory/AutomationConfigContainer.mjs';
import { BillingContainer } from './memory/BillingContainer.mjs';
import { CatalogsContainer } from './memory/CatalogsContainer.mjs';
import { SettingsContainer } from './memory/SettingsContainer.mjs';
import { NotificationsContainer } from './memory/NotificationsContainer.mjs';
import { HydrationPipeline } from './hydration/HydrationPipeline.mjs';
import { PreludeProjection } from './projections/PreludeProjection.mjs';
import { WorkspaceSnapshotProjection } from './projections/WorkspaceSnapshotProjection.mjs';
import { DatabaseCorruptError } from './types/errors.mjs';

/**
 * StateStore: Central ACP In-Memory State and SQLite Materialized Cache Subsystem.
 */
export class StateStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dbPath=':memory:']
   * @param {string} [options.userId='usr_default']
   */
  constructor(options = {}) {
    this.dbPath = options.dbPath || ':memory:';
    this.userId = options.userId || 'usr_default';
    this._isHydrated = false;

    // 1. Persistence Layer
    this.engine = new SqliteStorageEngine(this.dbPath);
    this.migrator = new SchemaMigrator(this.engine);
    this.metadataAdapter = new MetadataAdapter(this.engine);
    this.accountsAdapter = new AccountsAdapter(this.engine);
    this.configAdapter = new ConfigAdapter(this.engine);
    this.billingAdapter = new BillingAdapter(this.engine);
    this.catalogsAdapter = new CatalogsAdapter(this.engine);
    this.settingsAdapter = new SettingsAdapter(this.engine);
    this.notificationsAdapter = new NotificationsAdapter(this.engine);
    this.lifecycleAdapter = new LifecycleStateAdapter(this.engine);
    this.consistencyGroups = new ConsistencyGroupManager(this.engine, this.metadataAdapter);

    // 2. Memory Layer
    this.accountsContainer = new AccountsContainer();
    this.configContainer = new AutomationConfigContainer();
    this.billingContainer = new BillingContainer(this.userId);
    this.catalogsContainer = new CatalogsContainer();
    this.settingsContainer = new SettingsContainer(this.userId);
    this.notificationsContainer = new NotificationsContainer();

    // 3. Hydration & Projections
    this.hydrationPipeline = new HydrationPipeline({
      metadata: this.metadataAdapter,
      accounts: this.accountsAdapter,
      config: this.configAdapter,
      billing: this.billingAdapter,
      catalogs: this.catalogsAdapter,
      settings: this.settingsAdapter,
      notifications: this.notificationsAdapter
    });
    this.preludeProjection = new PreludeProjection();

    // 4. Bind public domain sub-APIs
    this._bindDomainApis();
  }

  get isHydratedState() {
    return this._isHydrated;
  }

  /**
   * Initializes the State Store, runs schema migrations, and executes startup hydration.
   * If database corruption is detected, automatically quarantines and recreates clean database.
   * 
   * @param {object} [options]
   * @param {string} [options.userId]
   * @returns {{ durationMs: number; loadedCounts: Record<string, number>; staleDomains: Array<string> }}
   */
  initialize(options = {}) {
    if (options.userId) {
      this.userId = options.userId;
    }

    try {
      this.engine.open();
      this.engine.quickCheck();
    } catch (err) {
      const msg = err.message ? err.message.toLowerCase() : '';
      if (
        err instanceof DatabaseCorruptError ||
        msg.includes('corrupt') ||
        msg.includes('file is not a database') ||
        msg.includes('malformed') ||
        msg.includes('unsupported')
      ) {
        this._handleDatabaseCorruption();
      } else {
        throw err;
      }
    }

    // Run schema migrations
    this.migrator.migrate();

    // Reset observed states on boot to enforce KILL_ON_JOB_CLOSE guarantees
    this.lifecycleAdapter.resetObservedStateOnBoot('SYSTEM_BOOT_RECOVERY');
    this.accountsAdapter.resetObservedStatesOnBoot(this.userId);

    // Execute hydration pipeline
    const stats = this.hydrate(this.userId);
    this.accountsContainer.resetObservedStatesOnBoot();

    return stats;
  }

  /**
   * Seeds baseline accounts when cold booting an unpopulated database.
   * @private
   */
  _seedDefaultAccounts() {
    const now = new Date().toISOString();
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
      lastKnownBalance: 154200,
      currencySymbol: '₦',
      lastUpdated: now,
      lastSynchronization: now
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
      lastKnownBalance: 48950,
      currencySymbol: '₦',
      lastUpdated: now,
      lastSynchronization: now
    };
    this.accounts.upsert(acc1);
    this.accounts.upsert(acc2);
  }

  /**
   * Re-hydrates state for the active user.
   * @param {string} [userId]
   */
  hydrate(userId = null) {
    if (userId) this.userId = userId;
    const stats = this.hydrationPipeline.hydrate(this.userId, {
      accounts: this.accountsContainer,
      config: this.configContainer,
      billing: this.billingContainer,
      catalogs: this.catalogsContainer,
      settings: this.settingsContainer,
      notifications: this.notificationsContainer
    });
    this._isHydrated = true;
    this.preludeProjection.invalidate();
    return stats;
  }

  /**
   * Self-healing corruption handler: quarantines corrupt DB file and creates clean database.
   */
  _handleDatabaseCorruption() {
    this.engine.close();
    if (this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
      const corruptPath = `${this.dbPath}.corrupt.${Date.now()}`;
      try {
        fs.renameSync(this.dbPath, corruptPath);
        if (fs.existsSync(`${this.dbPath}-wal`)) {
          fs.renameSync(`${this.dbPath}-wal`, `${corruptPath}-wal`);
        }
        if (fs.existsSync(`${this.dbPath}-shm`)) {
          fs.renameSync(`${this.dbPath}-shm`, `${corruptPath}-shm`);
        }
      } catch { /* ignore */ }
    }
    // Re-open clean database
    this.engine.open();
  }

  /**
   * Closes database and cleans up.
   */
  close() {
    this.engine.close();
    this._isHydrated = false;
    this.preludeProjection.invalidate();
  }

  /**
   * Handles user logout: scrubs all user-scoped data from SQLite and memory,
   * while preserving public reference catalogs.
   * 
   * @param {string} [targetUserId]
   */
  onLogout(targetUserId = null) {
    const uId = targetUserId || this.userId;
    this.engine.transaction(() => {
      this.accountsAdapter.deleteAllForUser(uId);
      this.configAdapter.deleteForUser(uId);
      this.billingAdapter.deleteForUser(uId);
      this.settingsAdapter.deleteForUser(uId);
      this.notificationsAdapter.deleteForUser(uId);
    });

    this.accountsContainer.reset();
    this.configContainer.reset();
    this.billingContainer.reset(uId);
    this.settingsContainer.reset(uId);
    this.notificationsContainer.reset();
    this.preludeProjection.invalidate();
  }

  /**
   * Drops all data and resets all containers (test/reset only).
   */
  purgeAll() {
    this.engine.transaction(() => {
      this.engine.exec(`
        DELETE FROM accounts_metadata_cache;
        DELETE FROM global_automation_config;
        DELETE FROM subscription_cache;
        DELETE FROM invoices_cache;
        DELETE FROM platform_registry_cache;
        DELETE FROM plans_catalog_cache;
        DELETE FROM automation_strategy_catalog_cache;
        DELETE FROM user_settings_cache;
        DELETE FROM documentation_cache;
        DELETE FROM notifications_cache;
        DELETE FROM cache_metadata;
      `);
    });

    this.accountsContainer.reset();
    this.configContainer.reset();
    this.billingContainer.reset(this.userId);
    this.catalogsContainer.reset();
    this.settingsContainer.reset(this.userId);
    this.notificationsContainer.reset();
    this.preludeProjection.invalidate();
  }

  // --- PROJECTIONS ---

  /**
   * Returns the memoized atomic Prelude snapshot.
   * @param {object} [runtimeState]
   */
  getPreludeSnapshot(runtimeState = {}) {
    return this.preludeProjection.project(this.userId, {
      accounts: this.accountsContainer,
      config: this.configContainer,
      billing: this.billingContainer,
      catalogs: this.catalogsContainer,
      settings: this.settingsContainer,
      notifications: this.notificationsContainer
    }, runtimeState);
  }

  /**
   * Returns the canonical AutomationWorkspaceSnapshot.
   * @param {object} [runtimeState]
   */
  getWorkspaceSnapshot(runtimeState = {}) {
    return WorkspaceSnapshotProjection.project(this.configContainer, this.accountsContainer, runtimeState);
  }

  /**
   * Returns a filtered and paginated accounts view.
   * @param {object} [query]
   */
  getAccountsView(query = {}) {
    const offset = Number(query.offset) || 0;
    const limit = Number(query.limit) || 50;
    const filterQuery = (query.filterQuery || '').toLowerCase();

    let accounts = this.accountsContainer.getAll();
    if (filterQuery) {
      accounts = accounts.filter(a =>
        a.name.toLowerCase().includes(filterQuery) ||
        a.accountUsername.toLowerCase().includes(filterQuery) ||
        (a.platformDisplayName && a.platformDisplayName.toLowerCase().includes(filterQuery))
      );
    }

    const totalMatches = accounts.length;
    const slice = accounts.slice(offset, offset + limit);

    return {
      viewportAccounts: slice.map(acc => {
        const bal = this.accountsContainer.getBalance(acc.id);
        return {
          ...acc,
          currentBalance: bal.balance,
          currencySymbol: bal.currencySymbol
        };
      }),
      bulkCapabilities: {
        supportedOperations: ['BULK_ACTIVATE', 'BULK_DEACTIVATE', 'BULK_DELETE'],
        maximumSelection: 20,
        requiresConfirmation: true,
        canRunWhileAutomationActive: false
      },
      searchMetadata: {
        totalMatches,
        returnedOffset: offset,
        activeFilterSummary: filterQuery ? `Filter: "${filterQuery}"` : 'All Accounts'
      }
    };
  }

  // --- INTERNAL DOMAIN BINDINGS ---

  _bindDomainApis() {
    // Accounts domain
    this.accounts = {
      getById: (id) => this.accountsContainer.getById(id),
      getAll: () => this.accountsContainer.getAll(),
      getBalance: (id) => this.accountsContainer.getBalance(id),
      updateBalance: (id, bal, sym) => this.accountsContainer.updateBalance(id, bal, sym),
      upsert: (account, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('accounts', expectedRevision, (nextRev) => {
          const res = this.accountsContainer.upsert(account);
          this.accountsAdapter.upsert(this.userId, res.account);
          this.preludeProjection.invalidate();
          return res.account;
        }).result;
      },
      delete: (id, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('accounts', expectedRevision, (nextRev) => {
          this.accountsAdapter.delete(this.userId, id);
          const deleted = this.accountsContainer.delete(id);
          this.preludeProjection.invalidate();
          return deleted;
        }).result;
      },
      updateExecutionState: (id, stateUpdate, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('accounts', expectedRevision, (nextRev) => {
          const res = this.accountsContainer.updateExecutionState(id, stateUpdate);
          if (res) {
            this.accountsAdapter.upsert(this.userId, res.account);
            this.preludeProjection.invalidate();
            return res.account;
          }
          return null;
        }).result;
      },
      replaceAll: (accountsList) => {
        return this.consistencyGroups.executeGroupTransaction('accounts', null, (nextRev) => {
          this.accountsAdapter.replaceAll(this.userId, accountsList);
          this.accountsContainer.hydrate(accountsList, nextRev);
          this.preludeProjection.invalidate();
          return accountsList;
        }).result;
      },
      resetObservedStates: (reason = 'PROCESS_EXIT') => {
        return this.consistencyGroups.executeGroupTransaction('accounts', null, (nextRev) => {
          this.accountsAdapter.resetObservedStates(this.userId, reason);
          this.accountsContainer.resetObservedStates(reason);
          this.preludeProjection.invalidate();
          return true;
        }).result;
      }
    };

    // System Lifecycle & Desired vs Observed State Domain
    this.lifecycle = {
      getState: () => this.lifecycleAdapter.get(),
      setDesiredState: (desiredState, reason) => {
        const state = this.lifecycleAdapter.setDesiredState(desiredState, reason);
        this.preludeProjection.invalidate();
        return state;
      },
      setObservedState: (observedState, reason) => {
        const state = this.lifecycleAdapter.setObservedState(observedState, reason);
        this.preludeProjection.invalidate();
        return state;
      }
    };

    // Config domain
    this.config = {
      getGlobalConfig: () => this.configContainer.getGlobalConfig(),
      getCategory: (cat) => this.configContainer.getCategory(cat),
      updateCategory: (category, values, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('global_config', expectedRevision, (nextRev) => {
          const res = this.configContainer.updateCategory(category, values);
          this.configAdapter.save(this.userId, this.configContainer._globalConfig);
          this.preludeProjection.invalidate();
          return res.updatedValues;
        }).result;
      },
      getAccountOverride: (accId) => this.configContainer.getAccountOverride(accId),
      updateAccountOverride: (accId, updates, expectedRevision) => {
        const res = this.configContainer.updateAccountOverride(accId, updates, expectedRevision);
        this.preludeProjection.invalidate();
        return res.updated;
      }
    };

    // Billing domain
    this.billing = {
      getSnapshot: () => this.billingContainer.getSnapshot(),
      getInvoices: () => this.billingContainer.getInvoices(),
      updateSubscription: (updates, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('billing', expectedRevision, (nextRev) => {
          const res = this.billingContainer.updateSubscription(updates, expectedRevision);
          this.billingAdapter.saveSubscription(this.userId, res.subscription);
          this.preludeProjection.invalidate();
          return res.subscription;
        }).result;
      },
      addInvoice: (invoice) => {
        return this.consistencyGroups.executeGroupTransaction('billing', null, (nextRev) => {
          this.billingAdapter.saveInvoice(this.userId, invoice);
          this.billingContainer.addInvoice(invoice);
          this.preludeProjection.invalidate();
          return invoice;
        }).result;
      }
    };

    // Catalogs domain
    this.catalogs = {
      getPlansCatalog: () => this.catalogsContainer.getPlansCatalog(),
      getPlatformRegistry: () => this.catalogsContainer.getPlatformRegistry(),
      getStrategyCatalog: () => this.catalogsContainer.getStrategyCatalog(),
      replacePlansCatalog: (catalog, etag = null) => {
        this.catalogsAdapter.savePlansCatalog(catalog, etag);
        this.catalogsContainer.replacePlansCatalog(catalog, etag);
        this.metadataAdapter.set('plans_catalog', { etag, revision: this.catalogsContainer.revision });
        this.preludeProjection.invalidate();
      },
      replacePlatformRegistry: (platforms, etag = null) => {
        this.catalogsAdapter.replacePlatformRegistry(platforms, etag);
        this.catalogsContainer.replacePlatformRegistry(platforms, etag);
        this.metadataAdapter.set('platform_registry', { etag, revision: this.catalogsContainer.revision });
        this.preludeProjection.invalidate();
      },
      replaceStrategyCatalog: (catalog) => {
        this.catalogsAdapter.saveStrategyCatalog(catalog);
        this.catalogsContainer.replaceStrategyCatalog(catalog);
        this.preludeProjection.invalidate();
      }
    };

    // Settings domain
    this.settings = {
      getSnapshot: () => this.settingsContainer.getSnapshot(),
      updateProfile: (profile, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('settings', expectedRevision, (nextRev) => {
          const res = this.settingsContainer.updateProfile(profile, expectedRevision);
          this.settingsAdapter.save(this.userId, res.settings);
          this.preludeProjection.invalidate();
          return res.settings;
        }).result;
      },
      updatePresentation: (prefs, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('settings', expectedRevision, (nextRev) => {
          const res = this.settingsContainer.updatePresentation(prefs, expectedRevision);
          this.settingsAdapter.save(this.userId, res.settings);
          this.preludeProjection.invalidate();
          return res.settings;
        }).result;
      },
      updateSecurity: (sec, expectedRevision) => {
        return this.consistencyGroups.executeGroupTransaction('settings', expectedRevision, (nextRev) => {
          const res = this.settingsContainer.updateSecurity(sec, expectedRevision);
          this.settingsAdapter.save(this.userId, res.settings);
          this.preludeProjection.invalidate();
          return res.settings;
        }).result;
      },
      updatePreferences: (prefs, expectedRevision) => {
        return this.settings.updatePresentation(prefs, expectedRevision);
      }
    };

    // Notifications domain
    this.notifications = {
      getAll: () => this.notificationsContainer.getAll(),
      getUnreadCount: () => this.notificationsContainer.unreadCount,
      getSnapshot: () => ({
        notifications: this.notificationsContainer.getAll(),
        unreadCount: this.notificationsContainer.unreadCount
      }),
      add: (notif) => {
        const record = this.notificationsContainer.add(notif);
        this.notificationsAdapter.save(this.userId, record);
        this.preludeProjection.invalidate();
        return record;
      },
      append: (notif) => this.notifications.add(notif),
      markRead: (id) => {
        const changed = this.notificationsContainer.markRead(id);
        if (changed) {
          this.notificationsAdapter.markRead(this.userId, id);
          this.preludeProjection.invalidate();
        }
        return changed;
      },
      markAllRead: () => {
        const changed = this.notificationsContainer.markAllRead();
        if (changed) {
          this.notificationsAdapter.markAllRead(this.userId);
          this.preludeProjection.invalidate();
        }
        return changed;
      },
      delete: (id) => {
        const deleted = this.notificationsContainer.delete(id);
        if (deleted) {
          this.preludeProjection.invalidate();
        }
        return deleted;
      }
    };
  }
}

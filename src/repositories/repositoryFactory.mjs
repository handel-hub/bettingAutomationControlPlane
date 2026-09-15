// @ts-check
import { getSharedStateStore } from '../state-store/sharedStateStore.mjs';

/**
 * StateStoreAccountsAdapter: bridges repository interface directly to SQLite WAL StateStore.
 */
class StateStoreAccountsAdapter {
  get accounts() {
    return getSharedStateStore().accountsContainer._accounts;
  }

  async list(filters = {}, pagination = { offset: 0, limit: 50 }) {
    const store = getSharedStateStore();
    return store.getAccountsView({ ...filters, ...pagination });
  }

  async findById(id) {
    const store = getSharedStateStore();
    return store.accounts.getById(id);
  }

  async findByPlatformAndUsername(platform, username) {
    const store = getSharedStateStore();
    return store.accountsContainer.findByPlatformAndUsername(platform, username);
  }

  async create(accountData) {
    const store = getSharedStateStore();
    return store.accounts.upsert(accountData);
  }

  async update(id, updates) {
    const store = getSharedStateStore();
    const existing = store.accounts.getById(id) || {};
    return store.accounts.upsert({ ...existing, ...updates, id });
  }

  async delete(id) {
    const store = getSharedStateStore();
    return store.accounts.delete(id);
  }

  async bulkAction(type, ids) {
    const store = getSharedStateStore();
    let successful = 0;
    let failed = 0;
    const errors = [];
    const accountIds = Array.isArray(ids) ? ids : [];

    for (const id of accountIds) {
      const acc = store.accounts.getById(id);
      if (!acc) {
        failed++;
        errors.push({ id, reason: 'Account not found' });
        continue;
      }
      if (type === 'BULK_DELETE') {
        store.accounts.delete(id);
        successful++;
      } else if (type === 'BULK_ACTIVATE') {
        store.accounts.upsert({
          ...acc,
          backendState: 'ACTIVE',
          presentationCategory: 'Healthy'
        });
        successful++;
      } else if (type === 'BULK_DEACTIVATE') {
        store.accounts.upsert({
          ...acc,
          backendState: 'SUSPENDED',
          presentationCategory: 'Neutral'
        });
        successful++;
      }
    }

    return { operation: type, successful, failed, errors };
  }

  hydrate(accountsList) {
    if (!Array.isArray(accountsList)) return;
    const store = getSharedStateStore();
    store.accounts.replaceAll(accountsList);
  }
}

/**
 * StateStoreConfigAdapter: bridges configuration repository to SQLite WAL StateStore.
 */
class StateStoreConfigAdapter {
  async getGlobalConfig() {
    const store = getSharedStateStore();
    return store.config.getGlobalConfig();
  }

  async getCategory(category) {
    const store = getSharedStateStore();
    return store.config.getCategory(category);
  }

  async updateCategory(category, values) {
    const store = getSharedStateStore();
    return store.config.updateCategory(category, values);
  }

  async getAccountConfig(accountId) {
    const store = getSharedStateStore();
    return store.config.getAccountOverride(accountId) || {};
  }

  async updateAccountConfig(accountId, updates) {
    const store = getSharedStateStore();
    return store.config.updateAccountOverride(accountId, updates);
  }

  hydrate(globalConfig) {
    if (!globalConfig) return;
    const store = getSharedStateStore();
    store.configContainer.hydrate(globalConfig);
  }
}

/**
 * StateStoreBillingAdapter: bridges billing repository to SQLite WAL StateStore.
 */
class StateStoreBillingAdapter {
  async getSnapshot() {
    const store = getSharedStateStore();
    return store.billing.getSnapshot();
  }

  async updateSubscription(updates) {
    const store = getSharedStateStore();
    return store.billing.updateSubscription(updates);
  }

  async addInvoice(invoice) {
    const store = getSharedStateStore();
    return store.billing.addInvoice(invoice);
  }

  async verifyReference(reference) {
    const store = getSharedStateStore();
    store.billing.updateSubscription({ status: 'Active' });
    return { verified: true, snapshot: store.billing.getSnapshot() };
  }
}

/**
 * StateStoreSettingsAdapter: bridges settings repository to SQLite WAL StateStore.
 */
class StateStoreSettingsAdapter {
  async getSnapshot() {
    const store = getSharedStateStore();
    return store.settings.getSnapshot();
  }

  async updateProfile(updates) {
    const store = getSharedStateStore();
    return store.settings.updateProfile(updates);
  }

  async updateSecurity(updates) {
    const store = getSharedStateStore();
    return store.settings.updateSecurity(updates);
  }

  async updatePreferences(updates) {
    const store = getSharedStateStore();
    return store.settings.updatePreferences(updates);
  }

  async updatePresentation(updates) {
    const store = getSharedStateStore();
    return store.settings.updatePresentation(updates);
  }
}

/**
 * StateStoreNotificationsAdapter: bridges notifications repository to SQLite WAL StateStore.
 */
class StateStoreNotificationsAdapter {
  async getSnapshot() {
    const store = getSharedStateStore();
    return store.notifications.getSnapshot();
  }

  async list(options = {}) {
    const store = getSharedStateStore();
    const snapshot = store.notifications.getSnapshot();
    let list = snapshot.notifications;
    if (options && options.severity) {
      list = list.filter(n => n.severity === options.severity);
    }
    return { notifications: list, unreadCount: snapshot.unreadCount };
  }

  async append(notification) {
    const store = getSharedStateStore();
    return store.notifications.append(notification);
  }

  async add(notification) {
    const store = getSharedStateStore();
    return store.notifications.append(notification);
  }

  async markRead(id) {
    const store = getSharedStateStore();
    return store.notifications.markRead(id);
  }

  async markAllRead() {
    const store = getSharedStateStore();
    return store.notifications.markAllRead();
  }

  async delete(id) {
    const store = getSharedStateStore();
    return store.notifications.delete(id);
  }
}

/**
 * RepositoryFactory: Canonical facade delegating 100% of domain persistence
 * to the SQLite WAL StateStore singleton (getSharedStateStore).
 */
class RepositoryFactory {
  constructor() {
    this.accountsRepo = new StateStoreAccountsAdapter();
    this.configRepo = new StateStoreConfigAdapter();
    this.billingRepo = new StateStoreBillingAdapter();
    this.settingsRepo = new StateStoreSettingsAdapter();
    this.notificationsRepo = new StateStoreNotificationsAdapter();
  }

  getAccountsRepo() { return this.accountsRepo; }
  getConfigRepo() { return this.configRepo; }
  getBillingRepo() { return this.billingRepo; }
  getSettingsRepo() { return this.settingsRepo; }
  getNotificationsRepo() { return this.notificationsRepo; }
}

export const repositoryFactory = new RepositoryFactory();

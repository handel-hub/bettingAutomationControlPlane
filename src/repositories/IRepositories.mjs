// @ts-check

/**
 * Standard data-access interfaces for the Control Plane.
 * Decouples API routes from specific database implementations.
 */

export class IAccountsRepository {
  async list(filters = {}, pagination = { offset: 0, limit: 50 }) { throw new Error('Not implemented'); }
  async findById(id) { throw new Error('Not implemented'); }
  async findByPlatformAndUsername(platform, username) { throw new Error('Not implemented'); }
  async create(account) { throw new Error('Not implemented'); }
  async update(id, updates) { throw new Error('Not implemented'); }
  async delete(id) { throw new Error('Not implemented'); }
  async bulkAction(type, ids) { throw new Error('Not implemented'); }
}

export class IAutomationConfigRepository {
  async getGlobalConfig() { throw new Error('Not implemented'); }
  async updateCategory(category, values) { throw new Error('Not implemented'); }
  async getAccountConfig(accountId) { throw new Error('Not implemented'); }
  async updateAccountConfig(accountId, updates) { throw new Error('Not implemented'); }
}

export class IBillingRepository {
  async getSnapshot() { throw new Error('Not implemented'); }
  async updateSubscription(updates) { throw new Error('Not implemented'); }
  async addInvoice(invoice) { throw new Error('Not implemented'); }
  async verifyReference(reference) { throw new Error('Not implemented'); }
}

export class ISettingsRepository {
  async getSnapshot() { throw new Error('Not implemented'); }
  async updateProfile(updates) { throw new Error('Not implemented'); }
  async updateSecurity(updates) { throw new Error('Not implemented'); }
  async updatePreferences(updates) { throw new Error('Not implemented'); }
}

export class INotificationsRepository {
  async list(options = {}) { throw new Error('Not implemented'); }
  async add(notification) { throw new Error('Not implemented'); }
  async markRead(id) { throw new Error('Not implemented'); }
  async markAllRead() { throw new Error('Not implemented'); }
  async delete(id) { throw new Error('Not implemented'); }
  async clearAll() { throw new Error('Not implemented'); }
}

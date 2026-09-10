// @ts-check
import { SanitizerGate } from '../../validation/SanitizerGate.mjs';

/**
 * Persistence adapter for accounts_metadata_cache.
 */
export class AccountsAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Lists all accounts for a specific user.
   * @param {string} userId
   * @returns {Array<any>}
   */
  listByUser(userId) {
    const rows = this.engine.prepare(`
      SELECT account_id AS id, user_id AS userId, name, platform_id AS platformId,
             account_username AS accountUsername, last_known_balance AS lastKnownBalance,
             currency_symbol AS currencySymbol, backend_state AS backendState,
             presentation_category AS presentationCategory, status_description AS statusDescription,
             tags_json AS tagsJson, effective_config_json AS effectiveConfigJson,
             last_updated AS lastUpdated, last_synchronization AS lastSynchronization
      FROM accounts_metadata_cache
      WHERE user_id = ?
      ORDER BY last_updated DESC
    `).all(userId);

    return rows.map(r => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      platformId: r.platformId,
      platformDisplayName: r.name,
      accountUsername: r.accountUsername,
      accountPassword: '[PROTECTED]',
      lastKnownBalance: r.lastKnownBalance,
      currencySymbol: r.currencySymbol,
      backendState: r.backendState,
      presentationCategory: r.presentationCategory,
      statusDescription: r.statusDescription,
      isSelectable: true,
      availableActions: ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
      pendingOperation: null,
      tags: JSON.parse(r.tagsJson || '[]'),
      effectiveConfig: r.effectiveConfigJson ? JSON.parse(r.effectiveConfigJson) : null,
      lastUpdated: r.lastUpdated,
      lastSynchronization: r.lastSynchronization
    }));
  }

  /**
   * Upserts a single account record.
   * @param {string} userId
   * @param {any} account
   */
  upsert(userId, account) {
    SanitizerGate.assertZeroSecrets(account);

    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(account.tags || []);
    const effectiveConfigJson = account.effectiveConfig ? JSON.stringify(account.effectiveConfig) : null;
    const platformId = (account.platformId || account.platformDisplayName || 'unknown').toLowerCase();

    this.engine.prepare(`
      INSERT INTO accounts_metadata_cache (
        account_id, user_id, name, platform_id, account_username,
        last_known_balance, currency_symbol, backend_state, presentation_category,
        status_description, tags_json, effective_config_json, last_updated, last_synchronization
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        name = excluded.name,
        platform_id = excluded.platform_id,
        account_username = excluded.account_username,
        last_known_balance = excluded.last_known_balance,
        currency_symbol = excluded.currency_symbol,
        backend_state = excluded.backend_state,
        presentation_category = excluded.presentation_category,
        status_description = excluded.status_description,
        tags_json = excluded.tags_json,
        effective_config_json = excluded.effective_config_json,
        last_updated = excluded.last_updated,
        last_synchronization = excluded.last_synchronization
    `).run(
      account.id,
      userId,
      account.name || account.accountUsername,
      platformId,
      account.accountUsername,
      Number(account.lastKnownBalance || account.currentBalance) || 0.0,
      account.currencySymbol || '₦',
      account.backendState || 'READY',
      account.presentationCategory || 'Healthy',
      account.statusDescription || 'Active & Synchronized',
      tagsJson,
      effectiveConfigJson,
      account.lastUpdated || now,
      account.lastSynchronization || now
    );
  }

  /**
   * Deletes an account.
   * @param {string} userId
   * @param {string} accountId
   */
  delete(userId, accountId) {
    const info = this.engine.prepare('DELETE FROM accounts_metadata_cache WHERE user_id = ? AND account_id = ?').run(userId, accountId);
    return info.changes > 0;
  }

  /**
   * Replaces all accounts for a user atomically.
   * @param {string} userId
   * @param {Array<any>} accounts
   */
  replaceAll(userId, accounts) {
    this.engine.transaction(() => {
      this.engine.prepare('DELETE FROM accounts_metadata_cache WHERE user_id = ?').run(userId);
      for (const acc of accounts) {
        this.upsert(userId, acc);
      }
    });
  }

  /**
   * Deletes all accounts for a user (logout purge).
   * @param {string} userId
   */
  deleteAllForUser(userId) {
    this.engine.prepare('DELETE FROM accounts_metadata_cache WHERE user_id = ?').run(userId);
  }
}

// @ts-check

const CANONICAL_PLATFORM_NAMES = {
  sportybet: 'SportyBet',
  bet9ja: 'Bet9ja',
  betking: 'BetKing',
  '1xbet': '1xBet',
  betway: 'Betway',
  bet365: 'Bet365',
  pinnacle: 'Pinnacle'
};

function formatPlatformDisplayName(rawPlatform, fallback) {
  if (!rawPlatform) return fallback || 'Unknown';
  const clean = String(rawPlatform).trim();
  const lower = clean.toLowerCase().replace(/\s+/g, '');
  return CANONICAL_PLATFORM_NAMES[lower] || clean;
}

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
             platform_display_name AS platformDisplayName,
             account_username AS accountUsername, account_password AS accountPassword,
             last_known_balance AS lastKnownBalance,
             currency_symbol AS currencySymbol, backend_state AS backendState,
             presentation_category AS presentationCategory, status_description AS statusDescription,
             available_actions_json AS availableActionsJson,
             tags_json AS tagsJson, effective_config_json AS effectiveConfigJson,
             desired_state AS desiredState, observed_state AS observedState,
             execution_status_reason AS executionStatusReason,
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
      platformDisplayName: formatPlatformDisplayName(r.platformDisplayName || r.platformId, r.name),
      accountUsername: r.accountUsername,
      accountPassword: r.accountPassword || '[PROTECTED]',
      lastKnownBalance: r.lastKnownBalance,
      currencySymbol: r.currencySymbol,
      backendState: r.backendState,
      desiredState: r.desiredState || 'STOPPED',
      observedState: r.observedState || 'STOPPED',
      executionStatusReason: r.executionStatusReason || null,
      presentationCategory: r.presentationCategory,
      statusDescription: r.statusDescription,
      isSelectable: true,
      availableActions: r.availableActionsJson ? JSON.parse(r.availableActionsJson) : ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
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
    const now = new Date().toISOString();
    const tagsJson = JSON.stringify(account.tags || []);
    const effectiveConfigJson = account.effectiveConfig ? JSON.stringify(account.effectiveConfig) : null;
    const platformId = (account.platformId || account.platformDisplayName || 'unknown').toLowerCase();
    const platformDisplayName = account.platformDisplayName || account.name || platformId;
    const availableActionsJson = account.availableActions ? JSON.stringify(account.availableActions) : null;

    const isMaskedPassword = !account.accountPassword ||
      account.accountPassword === '[PROTECTED]' ||
      account.accountPassword.includes('***') ||
      account.accountPassword.includes('•••');
    const passwordToStore = isMaskedPassword ? '' : account.accountPassword;

    this.engine.prepare(`
      INSERT INTO accounts_metadata_cache (
        account_id, user_id, name, platform_id, platform_display_name, account_username, account_password,
        last_known_balance, currency_symbol, backend_state, presentation_category,
        status_description, available_actions_json, tags_json, effective_config_json,
        desired_state, observed_state, execution_status_reason,
        last_updated, last_synchronization
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        name = excluded.name,
        platform_id = excluded.platform_id,
        platform_display_name = COALESCE(excluded.platform_display_name, accounts_metadata_cache.platform_display_name),
        account_username = excluded.account_username,
        account_password = CASE 
          WHEN excluded.account_password != '' 
               AND excluded.account_password != '[PROTECTED]' 
               AND excluded.account_password NOT LIKE '%***%' 
               AND excluded.account_password NOT LIKE '%•••%'
          THEN excluded.account_password 
          ELSE accounts_metadata_cache.account_password 
        END,
        last_known_balance = CASE
          WHEN excluded.last_known_balance > 0 THEN excluded.last_known_balance
          ELSE accounts_metadata_cache.last_known_balance
        END,
        currency_symbol = excluded.currency_symbol,
        backend_state = excluded.backend_state,
        presentation_category = excluded.presentation_category,
        status_description = excluded.status_description,
        available_actions_json = COALESCE(excluded.available_actions_json, accounts_metadata_cache.available_actions_json),
        tags_json = excluded.tags_json,
        effective_config_json = excluded.effective_config_json,
        desired_state = COALESCE(excluded.desired_state, accounts_metadata_cache.desired_state),
        observed_state = COALESCE(excluded.observed_state, accounts_metadata_cache.observed_state),
        execution_status_reason = excluded.execution_status_reason,
        last_updated = excluded.last_updated,
        last_synchronization = excluded.last_synchronization
    `).run(
      account.id,
      userId,
      account.name || account.accountUsername,
      platformId,
      platformDisplayName,
      account.accountUsername,
      passwordToStore,
      Number(account.lastKnownBalance || account.currentBalance) || 0.0,
      account.currencySymbol || '₦',
      account.backendState || 'READY',
      account.presentationCategory || 'Healthy',
      account.statusDescription || 'Active & Synchronized',
      availableActionsJson,
      tagsJson,
      effectiveConfigJson,
      account.desiredState || 'STOPPED',
      account.observedState || 'STOPPED',
      account.executionStatusReason || null,
      account.lastUpdated || now,
      account.lastSynchronization || now
    );
  }

  /**
   * Force resets observed state to STOPPED for all accounts upon boot or process exit.
   * Satisfies KILL_ON_JOB_CLOSE guarantee.
   * @param {string} userId
   * @param {string} [reason='SYSTEM_BOOT_RECOVERY']
   */
  resetObservedStatesOnBoot(userId, reason = 'SYSTEM_BOOT_RECOVERY') {
    this.engine.prepare(`
      UPDATE accounts_metadata_cache
      SET observed_state = 'STOPPED',
          execution_status_reason = ?
      WHERE user_id = ?
    `).run(reason, userId);
  }

  /**
   * Resets observed state to STOPPED for all accounts of a user.
   * @param {string} userId
   * @param {string} [reason='PROCESS_EXIT']
   */
  resetObservedStates(userId, reason = 'PROCESS_EXIT') {
    this.resetObservedStatesOnBoot(userId, reason);
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
   * Replaces all accounts for a user non-destructively.
   * Preserves existing real credentials, positive balances, and execution states.
   * @param {string} userId
   * @param {Array<any>} accounts
   */
  replaceAll(userId, accounts) {
    this.engine.transaction(() => {
      const accountList = Array.isArray(accounts) ? accounts : [];
      for (const acc of accountList) {
        this.upsert(userId, acc);
      }
      if (accountList.length > 0) {
        const incomingIds = accountList.map(a => a.id).filter(Boolean);
        if (incomingIds.length > 0) {
          const placeholders = incomingIds.map(() => '?').join(',');
          this.engine.prepare(`
            DELETE FROM accounts_metadata_cache 
            WHERE user_id = ? AND account_id NOT IN (${placeholders})
          `).run(userId, ...incomingIds);
        }
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

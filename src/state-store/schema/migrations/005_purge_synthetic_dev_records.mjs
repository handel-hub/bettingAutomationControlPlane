// @ts-check

/**
 * Migration 005: Purge Synthetic Dev Records.
 *
 * Surgically removes legacy synthetic seed rows (`acc-1` sporty_pro_01, `acc-2` bet9ja_runner_02,
 * `dev-account` operator@local, and unverified default Starter subscriptions) while preserving
 * all legitimate operator-created accounts, custom configurations, and persisted state.
 */
export const migration005 = {
  version: 5,
  name: '005_purge_synthetic_dev_records',

  /**
   * @param {import('../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  up(engine) {
    try {
      engine.exec(`
        DELETE FROM accounts_metadata_cache
        WHERE account_id IN ('acc-1', 'acc-2')
          AND account_username IN ('sporty_pro_01', 'bet9ja_runner_02');
      `);
    } catch { /* ignore if table absent */ }

    try {
      engine.exec(`
        DELETE FROM subscription_cache
        WHERE user_id IN ('dev-account', 'usr_default')
          AND LOWER(plan_id) = 'starter';
      `);
    } catch { /* ignore if table absent */ }

    try {
      engine.exec(`
        DELETE FROM user_settings_cache
        WHERE user_id = 'dev-account'
           OR email = 'operator@local';
      `);
    } catch { /* ignore if table absent */ }
  }
};

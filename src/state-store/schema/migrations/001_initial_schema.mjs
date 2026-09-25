// @ts-check

/**
 * Migration 001: Baseline schema defining all 11 ACP State Store tables and indexes.
 */
export const migration001 = {
  version: 1,
  name: '001_initial_schema',

  /**
   * @param {import('../persistence/SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  up(engine) {
    engine.exec(`
      -- 1. Cache Metadata & Revalidation Tracking
      CREATE TABLE IF NOT EXISTS cache_metadata (
          entity_key TEXT PRIMARY KEY,
          etag TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          schema_version INTEGER NOT NULL DEFAULT 1,
          cached_at TEXT NOT NULL,
          expires_at TEXT,
          last_validated_at TEXT NOT NULL
      );

      -- 2. Subscription Plans Catalog (C3 Reference)
      CREATE TABLE IF NOT EXISTS plans_catalog_cache (
          catalog_id TEXT PRIMARY KEY,
          default_plan_id TEXT NOT NULL,
          annual_discount_percent INTEGER NOT NULL DEFAULT 20,
          tax_rate REAL NOT NULL DEFAULT 0.075,
          currency TEXT NOT NULL DEFAULT 'NGN',
          currency_symbol TEXT NOT NULL DEFAULT '₦',
          plans_json TEXT NOT NULL,
          etag TEXT,
          cached_at TEXT NOT NULL
      );

      -- 3. Active Subscription & Entitlements Snapshot (C3 + C5)
      CREATE TABLE IF NOT EXISTS subscription_cache (
          user_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          status TEXT NOT NULL,
          billing_interval TEXT NOT NULL DEFAULT 'Monthly',
          renewal_date TEXT,
          expiration_date TEXT,
          entitlements_json TEXT NOT NULL,
          available_actions_json TEXT NOT NULL,
          notices_json TEXT NOT NULL DEFAULT '[]',
          cached_at TEXT NOT NULL
      );

      -- 4. Invoices History (C3)
      CREATE TABLE IF NOT EXISTS invoices_cache (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          reference TEXT NOT NULL UNIQUE,
          date TEXT NOT NULL,
          amount REAL NOT NULL,
          status TEXT NOT NULL,
          plan_name TEXT,
          billing_interval TEXT,
          receipt_url TEXT,
          subtotal REAL,
          tax_amount REAL,
          tax_rate REAL,
          currency TEXT NOT NULL DEFAULT 'NGN',
          currency_symbol TEXT NOT NULL DEFAULT '₦',
          cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_user_date ON invoices_cache(user_id, date DESC);

      -- 5. Platform Registry Catalog (C4 Reference)
      CREATE TABLE IF NOT EXISTS platform_registry_cache (
          platform_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          icon_url TEXT,
          status TEXT NOT NULL DEFAULT 'ONLINE',
          is_available INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          etag TEXT,
          cached_at TEXT NOT NULL
      );

      -- 6. Connected Accounts Metadata (C3 Primary)
      CREATE TABLE IF NOT EXISTS accounts_metadata_cache (
          account_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          platform_id TEXT NOT NULL,
          platform_display_name TEXT,
          account_username TEXT NOT NULL,
          last_known_balance REAL NOT NULL DEFAULT 0.0,
          currency_symbol TEXT NOT NULL DEFAULT '₦',
          backend_state TEXT NOT NULL DEFAULT 'READY',
          presentation_category TEXT NOT NULL DEFAULT 'Healthy',
          status_description TEXT NOT NULL DEFAULT 'Active & Synchronized',
          available_actions_json TEXT DEFAULT '["ACTIVATE","DEACTIVATE","DELETE"]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          effective_config_json TEXT,
          last_updated TEXT NOT NULL,
          last_synchronization TEXT NOT NULL,
          CONSTRAINT uq_platform_user UNIQUE (user_id, platform_id, account_username)
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts_metadata_cache(user_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts_metadata_cache(platform_id);

      -- 7. Global Automation Configuration (C3 Primary)
      CREATE TABLE IF NOT EXISTS global_automation_config (
          config_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          pricing_json TEXT NOT NULL,
          risk_json TEXT NOT NULL,
          rebet_json TEXT NOT NULL,
          proxy_json TEXT NOT NULL,
          execution_json TEXT NOT NULL,
          spawning_json TEXT NOT NULL,
          runtime_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      -- 8. Automation Strategy Options Catalog (C4 Reference)
      CREATE TABLE IF NOT EXISTS automation_strategy_catalog_cache (
          catalog_id TEXT PRIMARY KEY,
          strategies_json TEXT NOT NULL,
          binary_version TEXT NOT NULL,
          cached_at TEXT NOT NULL
      );

      -- 9. User Settings & Profile (C3)
      CREATE TABLE IF NOT EXISTS user_settings_cache (
          user_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          pending_email TEXT,
          avatar_url TEXT,
          mfa_enabled INTEGER NOT NULL DEFAULT 0,
          active_sessions_count INTEGER NOT NULL DEFAULT 1,
          theme_preference TEXT NOT NULL DEFAULT 'light',
          density_preference TEXT NOT NULL DEFAULT 'comfortable',
          email_alerts INTEGER NOT NULL DEFAULT 1,
          push_alerts INTEGER NOT NULL DEFAULT 0,
          weekly_report INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
      );

      -- 10. Documentation Knowledge Base (C4 Reference)
      CREATE TABLE IF NOT EXISTS documentation_cache (
          doc_id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content_markdown TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          etag TEXT NOT NULL,
          cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_docs_category ON documentation_cache(category, sort_order ASC);

      -- 11. Persistent Notifications (C3)
      CREATE TABLE IF NOT EXISTS notifications_cache (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          severity TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          is_read INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT,
          cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifs_user_time ON notifications_cache(user_id, timestamp DESC);
    `);
  }
};

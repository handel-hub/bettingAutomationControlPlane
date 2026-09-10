// @ts-check
import { createDefaultPlansCatalog, createDefaultPlatformRegistry } from '../../types/contracts.mjs';

/**
 * Persistence adapter for public reference catalogs:
 * Plans, Platforms, Strategies, and Documentation.
 */
export class CatalogsAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  // --- PLANS CATALOG ---

  /**
   * Loads subscription plans catalog.
   */
  getPlansCatalog() {
    const row = this.engine.prepare(`
      SELECT catalog_id AS catalogId, default_plan_id AS defaultPlanId,
             annual_discount_percent AS annualDiscountPercent, tax_rate AS taxRate,
             currency, currency_symbol AS currencySymbol, plans_json AS plansJson,
             etag, cached_at AS cachedAt
      FROM plans_catalog_cache
      LIMIT 1
    `).get();

    if (!row) {
      return createDefaultPlansCatalog();
    }

    return {
      defaultPlanId: row.defaultPlanId,
      annualDiscountPercent: row.annualDiscountPercent,
      taxRate: row.taxRate,
      currency: row.currency,
      currencySymbol: row.currencySymbol,
      plans: JSON.parse(row.plansJson || '[]'),
      etag: row.etag,
      cachedAt: row.cachedAt
    };
  }

  /**
   * Saves or replaces plans catalog.
   * @param {any} catalog
   * @param {string} [etag]
   */
  savePlansCatalog(catalog, etag = null) {
    const now = new Date().toISOString();
    this.engine.prepare(`
      INSERT INTO plans_catalog_cache (
        catalog_id, default_plan_id, annual_discount_percent, tax_rate,
        currency, currency_symbol, plans_json, etag, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(catalog_id) DO UPDATE SET
        default_plan_id = excluded.default_plan_id,
        annual_discount_percent = excluded.annual_discount_percent,
        tax_rate = excluded.tax_rate,
        currency = excluded.currency,
        currency_symbol = excluded.currency_symbol,
        plans_json = excluded.plans_json,
        etag = excluded.etag,
        cached_at = excluded.cached_at
    `).run(
      'default_plans_v1',
      catalog.defaultPlanId || 'pro',
      catalog.annualDiscountPercent !== undefined ? catalog.annualDiscountPercent : 20,
      catalog.taxRate !== undefined ? catalog.taxRate : 0.075,
      catalog.currency || 'NGN',
      catalog.currencySymbol || '₦',
      JSON.stringify(catalog.plans || []),
      etag || catalog.etag || null,
      now
    );
  }

  // --- PLATFORM REGISTRY ---

  /**
   * Loads platform registry.
   */
  getPlatformRegistry() {
    const rows = this.engine.prepare(`
      SELECT platform_id AS id, display_name AS displayName, icon_url AS iconUrl,
             status, is_available AS isAvailable, sort_order AS sortOrder,
             etag, cached_at AS cachedAt
      FROM platform_registry_cache
      ORDER BY sort_order ASC
    `).all();

    if (rows.length === 0) {
      return createDefaultPlatformRegistry();
    }

    return {
      defaultPlatformId: 'sportybet',
      platforms: rows.map(r => ({
        id: r.id,
        displayName: r.displayName,
        iconUrl: r.iconUrl,
        status: r.status,
        isAvailable: !!r.isAvailable,
        sortOrder: r.sortOrder
      }))
    };
  }

  /**
   * Replaces the entire platform registry atomically.
   * @param {Array<any>} platforms
   * @param {string} [etag]
   */
  replacePlatformRegistry(platforms, etag = null) {
    const now = new Date().toISOString();
    this.engine.transaction(() => {
      this.engine.prepare('DELETE FROM platform_registry_cache').run();
      const insert = this.engine.prepare(`
        INSERT INTO platform_registry_cache (
          platform_id, display_name, icon_url, status, is_available, sort_order, etag, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of platforms) {
        insert.run(
          p.id,
          p.displayName,
          p.iconUrl || null,
          p.status || 'ONLINE',
          p.isAvailable !== false ? 1 : 0,
          p.sortOrder || 0,
          etag,
          now
        );
      }
    });
  }

  // --- STRATEGY OPTIONS CATALOG ---

  /**
   * Loads strategy options catalog.
   */
  getStrategyCatalog() {
    const row = this.engine.prepare(`
      SELECT catalog_id AS catalogId, strategies_json AS strategiesJson,
             binary_version AS binaryVersion, cached_at AS cachedAt
      FROM automation_strategy_catalog_cache
      LIMIT 1
    `).get();

    return row ? JSON.parse(row.strategiesJson) : null;
  }

  /**
   * Saves strategy options catalog.
   * @param {any} catalog
   * @param {string} [binaryVersion='1.0.0']
   */
  saveStrategyCatalog(catalog, binaryVersion = '1.0.0') {
    const now = new Date().toISOString();
    this.engine.prepare(`
      INSERT INTO automation_strategy_catalog_cache (catalog_id, strategies_json, binary_version, cached_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(catalog_id) DO UPDATE SET
        strategies_json = excluded.strategies_json,
        binary_version = excluded.binary_version,
        cached_at = excluded.cached_at
    `).run('strategy_options_v1', JSON.stringify(catalog), binaryVersion, now);
  }
}

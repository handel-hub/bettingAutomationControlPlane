// @ts-check
import { FreshnessEvaluator } from './FreshnessEvaluator.mjs';

/**
 * Hydration Pipeline.
 * Reconstitutes in-memory state containers from SQLite persistent cache.
 * Implements graceful recovery from partial or corrupted individual records.
 */
export class HydrationPipeline {
  /**
   * @param {object} adapters
   * @param {import('../persistence/adapters/MetadataAdapter.mjs').MetadataAdapter} adapters.metadata
   * @param {import('../persistence/adapters/AccountsAdapter.mjs').AccountsAdapter} adapters.accounts
   * @param {import('../persistence/adapters/ConfigAdapter.mjs').ConfigAdapter} adapters.config
   * @param {import('../persistence/adapters/BillingAdapter.mjs').BillingAdapter} adapters.billing
   * @param {import('../persistence/adapters/CatalogsAdapter.mjs').CatalogsAdapter} adapters.catalogs
   * @param {import('../persistence/adapters/SettingsAdapter.mjs').SettingsAdapter} adapters.settings
   * @param {import('../persistence/adapters/NotificationsAdapter.mjs').NotificationsAdapter} adapters.notifications
   */
  constructor(adapters) {
    this.adapters = adapters;
  }

  /**
   * Hydrates all memory containers for a specific user from SQLite storage.
   * 
   * @param {string} userId
   * @param {object} containers
   * @param {import('../memory/AccountsContainer.mjs').AccountsContainer} containers.accounts
   * @param {import('../memory/AutomationConfigContainer.mjs').AutomationConfigContainer} containers.config
   * @param {import('../memory/BillingContainer.mjs').BillingContainer} containers.billing
   * @param {import('../memory/CatalogsContainer.mjs').CatalogsContainer} containers.catalogs
   * @param {import('../memory/SettingsContainer.mjs').SettingsContainer} containers.settings
   * @param {import('../memory/NotificationsContainer.mjs').NotificationsContainer} containers.notifications
   * @returns {{ durationMs: number; loadedCounts: Record<string, number>; staleDomains: Array<string> }}
   */
  hydrate(userId, containers) {
    const startTime = Date.now();
    const staleDomains = [];
    const loadedCounts = {};

    // 1. Load Metadata
    const metadataMap = this.adapters.metadata.getAll();

    // 2. Hydrate Catalogs (Public Reference Data)
    try {
      const plansCatalog = this.adapters.catalogs.getPlansCatalog();
      const platformRegistry = this.adapters.catalogs.getPlatformRegistry();
      const strategyCatalog = this.adapters.catalogs.getStrategyCatalog();
      const plansMeta = metadataMap.get('plans_catalog');
      const platformMeta = metadataMap.get('platform_registry');

      containers.catalogs.hydrate(
        plansCatalog,
        platformRegistry?.platforms || [],
        strategyCatalog,
        {
          plansEtag: plansMeta?.etag,
          platformEtag: platformMeta?.etag,
          revision: Math.max(plansMeta?.revision || 1, platformMeta?.revision || 1)
        }
      );
      loadedCounts['platforms'] = platformRegistry?.platforms?.length || 0;
    } catch (err) {
      // Fall back to default catalog structures
      containers.catalogs.reset();
    }

    // 3. Hydrate Global Config & Overrides
    try {
      const configMeta = metadataMap.get('global_config');
      const globalConfig = this.adapters.config.get(userId);
      containers.config.hydrate(globalConfig, {}, configMeta?.revision || 1);
      loadedCounts['config'] = 7;
    } catch (err) {
      containers.config.reset();
    }

    // 4. Hydrate Connected Accounts
    try {
      const accountsMeta = metadataMap.get('accounts');
      const accountsList = this.adapters.accounts.listByUser(userId);
      containers.accounts.hydrate(accountsList, accountsMeta?.revision || 1);
      loadedCounts['accounts'] = accountsList.length;

      // Check balance freshness
      if (accountsMeta?.lastValidatedAt && !FreshnessEvaluator.isFresh(accountsMeta.lastValidatedAt, FreshnessEvaluator.TTL_POLICIES.account_balances)) {
        containers.accounts.markBalancesStale();
        staleDomains.push('accounts.balances');
      }
    } catch (err) {
      containers.accounts.reset();
    }

    // 5. Hydrate Subscription & Invoices
    try {
      const billingMeta = metadataMap.get('billing');
      const subscription = this.adapters.billing.getSubscription(userId);
      const invoices = this.adapters.billing.listInvoices(userId, 50);
      containers.billing.hydrate(subscription, invoices, billingMeta?.revision || 1);
      loadedCounts['invoices'] = invoices.length;

      // Evaluate 2-hour subscription grace period
      if (billingMeta?.lastValidatedAt && !FreshnessEvaluator.isSubscriptionWithinGracePeriod(billingMeta.lastValidatedAt)) {
        containers.billing.markStale();
        staleDomains.push('billing.subscription');
      }
    } catch (err) {
      containers.billing.reset(userId);
    }

    // 6. Hydrate User Settings & Presentation
    try {
      const settingsMeta = metadataMap.get('settings');
      const settings = this.adapters.settings.get(userId);
      containers.settings.hydrate(settings, settingsMeta?.revision || 1);
      loadedCounts['settings'] = 1;
    } catch (err) {
      containers.settings.reset(userId);
    }

    // 7. Hydrate Notifications Feed
    try {
      const notifsMeta = metadataMap.get('notifications');
      const notifsList = this.adapters.notifications.list(userId, 100);
      containers.notifications.hydrate(notifsList, notifsMeta?.revision || 1);
      loadedCounts['notifications'] = notifsList.length;
    } catch (err) {
      containers.notifications.reset();
    }

    const durationMs = Date.now() - startTime;
    return { durationMs, loadedCounts, staleDomains };
  }
}

// @ts-check

/**
 * Evaluates TTL-based freshness for cached ACP datasets.
 */
export class FreshnessEvaluator {
  /**
   * Domain TTL policies in seconds.
   */
  static TTL_POLICIES = {
    account_balances: 30,           // 30s TTL
    subscription_grace: 7200,       // 2 hours operational grace period
    support_ticket_count: 60,       // 60s TTL
    system_update: 300,             // 5 minutes TTL
    platform_registry: 86400,       // 24 hours
    plans_catalog: 604800,          // 7 days
    documentation: 2592000          // 30 days
  };

  /**
   * Checks whether a cache entry is fresh or stale.
   * @param {string | Date} cachedAt
   * @param {number} ttlSeconds
   * @returns {boolean} True if still fresh; false if stale.
   */
  static isFresh(cachedAt, ttlSeconds) {
    if (!cachedAt) return false;
    const cachedTime = new Date(cachedAt).getTime();
    if (isNaN(cachedTime)) return false;
    return (Date.now() - cachedTime) < (ttlSeconds * 1000);
  }

  /**
   * Evaluates subscription operational grace period (2 hours max).
   * @param {string | Date} lastValidatedAt
   */
  static isSubscriptionWithinGracePeriod(lastValidatedAt) {
    return FreshnessEvaluator.isFresh(lastValidatedAt, FreshnessEvaluator.TTL_POLICIES.subscription_grace);
  }
}

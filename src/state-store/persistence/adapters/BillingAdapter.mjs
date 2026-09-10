// @ts-check
import { SanitizerGate } from '../../validation/SanitizerGate.mjs';
import { createDefaultSubscriptionSnapshot } from '../../types/contracts.mjs';

/**
 * Persistence adapter for subscription_cache and invoices_cache.
 */
export class BillingAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Loads subscription snapshot for a user.
   * @param {string} userId
   * @returns {any}
   */
  getSubscription(userId) {
    const row = this.engine.prepare(`
      SELECT user_id AS userId, plan_id AS planId, status, billing_interval AS billingInterval,
             renewal_date AS renewalDate, expiration_date AS expirationDate,
             entitlements_json AS entitlementsJson, available_actions_json AS availableActionsJson,
             notices_json AS noticesJson, cached_at AS cachedAt
      FROM subscription_cache
      WHERE user_id = ?
    `).get(userId);

    if (!row) {
      return createDefaultSubscriptionSnapshot(userId);
    }

    const entitlements = JSON.parse(row.entitlementsJson || '{}');
    const availableActions = JSON.parse(row.availableActionsJson || '[]');
    const notices = JSON.parse(row.noticesJson || '[]');

    return {
      userId: row.userId,
      currentPlanId: row.planId,
      currentPlan: row.planId.charAt(0).toUpperCase() + row.planId.slice(1),
      status: row.status,
      billingInterval: row.billingInterval,
      renewalDate: row.renewalDate,
      expirationDate: row.expirationDate,
      entitlements,
      availableActions,
      notices,
      cachedAt: row.cachedAt
    };
  }

  /**
   * Saves subscription snapshot for a user.
   * @param {string} userId
   * @param {any} subscription
   */
  saveSubscription(userId, subscription) {
    SanitizerGate.assertZeroSecrets(subscription);
    const now = new Date().toISOString();
    const planId = subscription.planId || subscription.currentPlanId || 'starter';

    this.engine.prepare(`
      INSERT INTO subscription_cache (
        user_id, plan_id, status, billing_interval, renewal_date,
        expiration_date, entitlements_json, available_actions_json, notices_json, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        status = excluded.status,
        billing_interval = excluded.billing_interval,
        renewal_date = excluded.renewal_date,
        expiration_date = excluded.expiration_date,
        entitlements_json = excluded.entitlements_json,
        available_actions_json = excluded.available_actions_json,
        notices_json = excluded.notices_json,
        cached_at = excluded.cached_at
    `).run(
      userId,
      planId,
      subscription.status || 'Active',
      subscription.billingInterval || 'Monthly',
      subscription.renewalDate || null,
      subscription.expirationDate || null,
      JSON.stringify(subscription.entitlements || {}),
      JSON.stringify(subscription.availableActions || []),
      JSON.stringify(subscription.notices || []),
      now
    );
  }

  /**
   * Loads recent cached invoices for a user.
   * @param {string} userId
   * @param {number} [limit=50]
   * @returns {Array<any>}
   */
  listInvoices(userId, limit = 50) {
    const rows = this.engine.prepare(`
      SELECT id, user_id AS userId, reference, date, amount, status,
             plan_name AS planName, billing_interval AS billingInterval,
             receipt_url AS receiptUrl, subtotal, tax_amount AS taxAmount,
             tax_rate AS taxRate, currency, currency_symbol AS currencySymbol, cached_at AS cachedAt
      FROM invoices_cache
      WHERE user_id = ?
      ORDER BY date DESC
      LIMIT ?
    `).all(userId, limit);

    return rows;
  }

  /**
   * Adds or replaces an invoice record.
   * @param {string} userId
   * @param {any} invoice
   */
  saveInvoice(userId, invoice) {
    SanitizerGate.assertZeroSecrets(invoice);
    const now = new Date().toISOString();

    this.engine.prepare(`
      INSERT INTO invoices_cache (
        id, user_id, reference, date, amount, status, plan_name,
        billing_interval, receipt_url, subtotal, tax_amount, tax_rate,
        currency, currency_symbol, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reference = excluded.reference,
        date = excluded.date,
        amount = excluded.amount,
        status = excluded.status,
        plan_name = excluded.plan_name,
        billing_interval = excluded.billing_interval,
        receipt_url = excluded.receipt_url,
        subtotal = excluded.subtotal,
        tax_amount = excluded.tax_amount,
        tax_rate = excluded.tax_rate,
        currency = excluded.currency,
        currency_symbol = excluded.currency_symbol,
        cached_at = excluded.cached_at
    `).run(
      invoice.id || `inv_${Date.now()}`,
      userId,
      invoice.reference,
      invoice.date || now,
      Number(invoice.amount) || 0,
      invoice.status || 'Paid',
      invoice.planName || null,
      invoice.billingInterval || null,
      invoice.receiptUrl || null,
      invoice.subtotal !== undefined ? Number(invoice.subtotal) : null,
      invoice.taxAmount !== undefined ? Number(invoice.taxAmount) : null,
      invoice.taxRate !== undefined ? Number(invoice.taxRate) : null,
      invoice.currency || 'NGN',
      invoice.currencySymbol || '₦',
      now
    );
  }

  /**
   * Purges billing and invoice data for a user (logout purge).
   * @param {string} userId
   */
  deleteForUser(userId) {
    this.engine.prepare('DELETE FROM subscription_cache WHERE user_id = ?').run(userId);
    this.engine.prepare('DELETE FROM invoices_cache WHERE user_id = ?').run(userId);
  }
}

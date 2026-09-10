// @ts-check
import { RevisionConflictError } from '../types/errors.mjs';
import { createDefaultSubscriptionSnapshot } from '../types/contracts.mjs';
import { PayloadValidators } from '../validation/PayloadValidators.mjs';

/**
 * Normalized in-memory container for Billing, Subscription, and Invoices.
 */
export class BillingContainer {
  /**
   * @param {string} [userId]
   */
  constructor(userId = 'usr_default') {
    this._userId = userId;
    /** @type {any} */
    this._subscription = createDefaultSubscriptionSnapshot(userId);
    /** @type {Map<string, any>} */
    this._invoices = new Map();
    /** @type {number} */
    this._revision = 1;
    /** @type {string} */
    this._lastUpdated = new Date().toISOString();
    /** @type {boolean} */
    this._isStale = false;
  }

  get revision() {
    return this._revision;
  }

  get lastUpdated() {
    return this._lastUpdated;
  }

  get isStale() {
    return this._isStale;
  }

  reset(userId = 'usr_default') {
    this._userId = userId;
    this._subscription = createDefaultSubscriptionSnapshot(userId);
    this._invoices.clear();
    this._revision = 1;
    this._lastUpdated = new Date().toISOString();
    this._isStale = false;
  }

  /**
   * Hydrates subscription and invoices from persistent store.
   * @param {any} [subscription]
   * @param {Array<any>} [invoicesList]
   * @param {number} [revision]
   */
  hydrate(subscription = null, invoicesList = [], revision = null) {
    if (subscription && typeof subscription === 'object') {
      PayloadValidators.validateSubscription(subscription);
      this._subscription = Object.freeze(JSON.parse(JSON.stringify(subscription)));
    } else {
      this._subscription = Object.freeze(createDefaultSubscriptionSnapshot(this._userId));
    }

    this._invoices.clear();
    if (Array.isArray(invoicesList)) {
      for (const inv of invoicesList) {
        this._invoices.set(inv.id || inv.reference, Object.freeze(JSON.parse(JSON.stringify(inv))));
      }
    }

    if (revision !== null && typeof revision === 'number') {
      this._revision = revision;
    } else {
      this._revision += 1;
    }
    this._lastUpdated = new Date().toISOString();
    this._isStale = false;
  }

  /**
   * Returns a frozen copy of the active subscription snapshot.
   * @returns {Readonly<any>}
   */
  getSnapshot() {
    return this._subscription;
  }

  /**
   * Returns all cached invoices sorted descending by date.
   * @returns {ReadonlyArray<any>}
   */
  getInvoices() {
    const list = Array.from(this._invoices.values());
    list.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
    return Object.freeze(list);
  }

  /**
   * Updates the subscription snapshot with OCC revision check.
   * @param {any} updates
   * @param {number} [expectedRevision]
   */
  updateSubscription(updates, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('subscription', expectedRevision, this._revision);
    }
    const updated = {
      ...this._subscription,
      ...updates,
      lastUpdated: new Date().toISOString()
    };
    PayloadValidators.validateSubscription(updated);

    this._subscription = Object.freeze(updated);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
    this._isStale = false;

    return { subscription: this._subscription, revision: this._revision };
  }

  /**
   * Adds or replaces an invoice.
   * @param {any} invoice
   */
  addInvoice(invoice) {
    const key = invoice.id || invoice.reference;
    this._invoices.set(key, Object.freeze(JSON.parse(JSON.stringify(invoice))));
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Marks subscription state as stale.
   */
  markStale() {
    this._isStale = true;
  }
}

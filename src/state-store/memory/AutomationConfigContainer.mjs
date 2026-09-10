// @ts-check
import { RevisionConflictError } from '../types/errors.mjs';
import { createDefaultGlobalConfig } from '../types/contracts.mjs';
import { PayloadValidators } from '../validation/PayloadValidators.mjs';

/**
 * Normalized in-memory container for Global Automation Configuration and per-account overrides.
 * Tracks monotonic revision and prevents partial/corrupt configuration states.
 */
export class AutomationConfigContainer {
  constructor() {
    /** @type {any} */
    this._globalConfig = createDefaultGlobalConfig();
    /** @type {Map<string, any>} */
    this._accountOverrides = new Map();
    /** @type {number} */
    this._revision = 1;
    /** @type {string} */
    this._lastUpdated = new Date().toISOString();
  }

  get revision() {
    return this._revision;
  }

  get lastUpdated() {
    return this._lastUpdated;
  }

  reset() {
    this._globalConfig = createDefaultGlobalConfig();
    this._accountOverrides.clear();
    this._revision = 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Hydrates the configuration container.
   * @param {any} [globalConfig]
   * @param {Record<string, any>} [accountOverrides]
   * @param {number} [revision]
   */
  hydrate(globalConfig = null, accountOverrides = {}, revision = null) {
    if (globalConfig && typeof globalConfig === 'object') {
      PayloadValidators.validateGlobalConfig(globalConfig);
      this._globalConfig = JSON.parse(JSON.stringify(globalConfig));
    } else {
      this._globalConfig = createDefaultGlobalConfig();
    }

    this._accountOverrides.clear();
    if (accountOverrides && typeof accountOverrides === 'object') {
      for (const [accId, overrides] of Object.entries(accountOverrides)) {
        this._accountOverrides.set(accId, Object.freeze(JSON.parse(JSON.stringify(overrides))));
      }
    }

    if (revision !== null && typeof revision === 'number') {
      this._revision = revision;
    } else {
      this._revision += 1;
    }
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Returns a deep-frozen representation of the global configuration.
   * @returns {Readonly<any>}
   */
  getGlobalConfig() {
    return Object.freeze(JSON.parse(JSON.stringify(this._globalConfig)));
  }

  /**
   * Returns a specific configuration category.
   * @param {string} category
   */
  getCategory(category) {
    if (!this._globalConfig[category]) {
      throw new Error(`Unknown configuration category: [${category}]`);
    }
    return Object.freeze(JSON.parse(JSON.stringify(this._globalConfig[category])));
  }

  /**
   * Updates a single configuration category with OCC revision checking.
   * @param {string} category
   * @param {any} values
   * @param {number} [expectedRevision]
   * @returns {{ category: string; updatedValues: any; revision: number }}
   */
  updateCategory(category, values, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('global_config', expectedRevision, this._revision);
    }
    PayloadValidators.validateCategoryValues(category, values);

    this._globalConfig[category] = {
      ...this._globalConfig[category],
      ...values
    };
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();

    return {
      category,
      updatedValues: this.getCategory(category),
      revision: this._revision
    };
  }

  /**
   * Returns configuration overrides for a specific account.
   * @param {string} accountId
   */
  getAccountOverride(accountId) {
    return this._accountOverrides.get(accountId) || Object.freeze({
      betCycleEnabled: true,
      pricingSource: 'GLOBAL',
      riskSource: 'GLOBAL',
      rebetSource: 'GLOBAL'
    });
  }

  /**
   * Updates configuration overrides for a specific account.
   * @param {string} accountId
   * @param {any} updates
   * @param {number} [expectedRevision]
   */
  updateAccountOverride(accountId, updates, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('account_config', expectedRevision, this._revision);
    }

    const current = this.getAccountOverride(accountId);
    const updated = Object.freeze({ ...current, ...updates });
    this._accountOverrides.set(accountId, updated);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();

    return { accountId, updated, revision: this._revision };
  }
}

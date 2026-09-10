// @ts-check
import { createDefaultPlansCatalog, createDefaultPlatformRegistry } from '../types/contracts.mjs';

/**
 * In-memory container for public reference catalogs:
 * Subscription Plans, Platform Registry, and Strategy Options.
 */
export class CatalogsContainer {
  constructor() {
    /** @type {any} */
    this._plansCatalog = createDefaultPlansCatalog();
    /** @type {Map<string, any>} */
    this._platformRegistry = new Map();
    /** @type {any} */
    this._strategyCatalog = null;
    /** @type {string | null} */
    this._plansEtag = null;
    /** @type {string | null} */
    this._platformEtag = null;
    /** @type {number} */
    this._revision = 1;
    /** @type {string} */
    this._lastUpdated = new Date().toISOString();

    // Populate default platforms
    const defaultRegistry = createDefaultPlatformRegistry();
    for (const p of defaultRegistry.platforms) {
      this._platformRegistry.set(p.id, Object.freeze(p));
    }
  }

  get revision() {
    return this._revision;
  }

  get lastUpdated() {
    return this._lastUpdated;
  }

  get plansEtag() {
    return this._plansEtag;
  }

  get platformEtag() {
    return this._platformEtag;
  }

  reset() {
    this._plansCatalog = createDefaultPlansCatalog();
    this._platformRegistry.clear();
    const defaultRegistry = createDefaultPlatformRegistry();
    for (const p of defaultRegistry.platforms) {
      this._platformRegistry.set(p.id, Object.freeze(p));
    }
    this._strategyCatalog = null;
    this._plansEtag = null;
    this._platformEtag = null;
    this._revision = 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Hydrates catalogs.
   * @param {any} [plansCatalog]
   * @param {Array<any>} [platformsList]
   * @param {any} [strategyCatalog]
   * @param {object} [metadata]
   */
  hydrate(plansCatalog = null, platformsList = [], strategyCatalog = null, metadata = {}) {
    if (plansCatalog && typeof plansCatalog === 'object') {
      this._plansCatalog = Object.freeze(JSON.parse(JSON.stringify(plansCatalog)));
    } else {
      this._plansCatalog = Object.freeze(createDefaultPlansCatalog());
    }

    if (Array.isArray(platformsList) && platformsList.length > 0) {
      this._platformRegistry.clear();
      for (const p of platformsList) {
        this._platformRegistry.set(p.id, Object.freeze(JSON.parse(JSON.stringify(p))));
      }
    }

    if (strategyCatalog && typeof strategyCatalog === 'object') {
      this._strategyCatalog = Object.freeze(JSON.parse(JSON.stringify(strategyCatalog)));
    }

    if (metadata.plansEtag) this._plansEtag = metadata.plansEtag;
    if (metadata.platformEtag) this._platformEtag = metadata.platformEtag;
    if (metadata.revision) this._revision = metadata.revision;

    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Returns plans catalog.
   */
  getPlansCatalog() {
    return this._plansCatalog;
  }

  /**
   * Returns platform registry.
   */
  getPlatformRegistry() {
    const list = Array.from(this._platformRegistry.values());
    list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return Object.freeze({
      defaultPlatformId: 'sportybet',
      platforms: list
    });
  }

  /**
   * Returns strategy options catalog.
   */
  getStrategyCatalog() {
    return this._strategyCatalog;
  }

  /**
   * Replaces plans catalog atomically.
   * @param {any} catalog
   * @param {string} [etag]
   */
  replacePlansCatalog(catalog, etag = null) {
    this._plansCatalog = Object.freeze(JSON.parse(JSON.stringify(catalog)));
    if (etag) this._plansEtag = etag;
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Replaces platform registry atomically.
   * @param {Array<any>} platforms
   * @param {string} [etag]
   */
  replacePlatformRegistry(platforms, etag = null) {
    this._platformRegistry.clear();
    for (const p of platforms) {
      this._platformRegistry.set(p.id, Object.freeze(JSON.parse(JSON.stringify(p))));
    }
    if (etag) this._platformEtag = etag;
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Replaces strategy catalog atomically.
   * @param {any} catalog
   */
  replaceStrategyCatalog(catalog) {
    this._strategyCatalog = Object.freeze(JSON.parse(JSON.stringify(catalog)));
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
  }
}

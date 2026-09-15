// @ts-check
import { ulid } from 'ulid';
import { RevisionConflictError, ValidationError } from '../types/errors.mjs';
import { SanitizerGate } from '../validation/SanitizerGate.mjs';

/**
 * Normalized in-memory container for Connected Accounts and DOM Balances.
 * Tracks monotonic revision and enforces composite uniqueness.
 */
export class AccountsContainer {
  constructor() {
    /** @type {Map<string, any>} */
    this._accounts = new Map();
    /** @type {Map<string, { balance: number; currencySymbol: string; lastUpdated: string; isStale: boolean }>} */
    this._balances = new Map();
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

  /**
   * Resets the container to cold initial state.
   */
  reset() {
    this._accounts.clear();
    this._balances.clear();
    this._revision = 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Hydrates the container from persistent storage or backend.
   * @param {Array<any>} accountsList
   * @param {number} [revision]
   */
  hydrate(accountsList, revision = null) {
    this._accounts.clear();
    if (Array.isArray(accountsList)) {
      for (const raw of accountsList) {
        const sanitized = {
          ...SanitizerGate.sanitize(raw),
          accountPassword: '[PROTECTED]'
        };
        this._accounts.set(sanitized.id, Object.freeze(sanitized));
        if (sanitized.lastKnownBalance !== undefined) {
          this._balances.set(sanitized.id, {
            balance: Number(sanitized.lastKnownBalance) || 0,
            currencySymbol: sanitized.currencySymbol || '₦',
            lastUpdated: sanitized.lastUpdated || new Date().toISOString(),
            isStale: false
          });
        }
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
   * Returns a frozen account object by ID.
   * @param {string} id
   * @returns {any | null}
   */
  getById(id) {
    return this._accounts.get(id) || null;
  }

  /**
   * Returns all accounts as a frozen array.
   * @returns {ReadonlyArray<any>}
   */
  getAll() {
    return Object.freeze(Array.from(this._accounts.values()));
  }

  /**
   * Finds an account by platform and username.
   * @param {string} platform
   * @param {string} username
   * @returns {any | null}
   */
  findByPlatformAndUsername(platform, username) {
    const p = platform.toLowerCase();
    const u = username.toLowerCase();
    for (const acc of this._accounts.values()) {
      const accPlatform = (acc.platformDisplayName || acc.platformId || '').toLowerCase();
      if (accPlatform === p && acc.accountUsername.toLowerCase() === u) {
        return acc;
      }
    }
    return null;
  }

  /**
   * Returns balance metadata for an account.
   * @param {string} id
   */
  getBalance(id) {
    return this._balances.get(id) || { balance: 0, currencySymbol: '₦', lastUpdated: this._lastUpdated, isStale: true };
  }

  /**
   * Upserts an account into the container.
   * Enforces composite uniqueness on (platform, username) and OCC revision check.
   * 
   * @param {any} accountData
   * @param {number} [expectedRevision]
   * @returns {{ account: any; revision: number }}
   */
  upsert(accountData, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('accounts', expectedRevision, this._revision);
    }

    const platform = accountData.platformDisplayName || accountData.platformId;
    const existing = this.findByPlatformAndUsername(platform, accountData.accountUsername);
    if (existing && existing.id !== accountData.id) {
      throw new ValidationError(`Account with platform '${platform}' and username '${accountData.accountUsername}' already exists.`);
    }

    const now = new Date().toISOString();
    const sanitized = SanitizerGate.sanitize(accountData);

    const record = {
      id: sanitized.id || ('acc_' + ulid()),
      name: sanitized.name || sanitized.accountUsername,
      platformId: sanitized.platformId || platform.toLowerCase(),
      platformDisplayName: sanitized.platformDisplayName || platform,
      accountUsername: sanitized.accountUsername,
      accountPassword: '[PROTECTED]',
      backendState: sanitized.backendState || 'ACTIVE',
      desiredState: sanitized.desiredState || 'STOPPED',
      observedState: sanitized.observedState || 'STOPPED',
      executionStatusReason: sanitized.executionStatusReason || null,
      presentationCategory: sanitized.presentationCategory || 'Healthy',
      statusDescription: sanitized.statusDescription || 'Active & Synchronized',
      isSelectable: sanitized.isSelectable !== false,
      availableActions: Array.isArray(sanitized.availableActions) ? sanitized.availableActions : ['ACTIVATE', 'DEACTIVATE', 'DELETE'],
      pendingOperation: sanitized.pendingOperation || null,
      tags: Array.isArray(sanitized.tags) ? sanitized.tags : [],
      lastUpdated: now,
      lastSynchronization: sanitized.lastSynchronization || now
    };

    this._accounts.set(record.id, Object.freeze(record));
    this._revision += 1;
    this._lastUpdated = now;

    return { account: record, revision: this._revision };
  }

  /**
   * Updates state attributes (desiredState, observedState) for an account.
   * @param {string} id
   * @param {{ desiredState?: string, observedState?: string, executionStatusReason?: string }} stateUpdate
   * @param {number} [expectedRevision]
   */
  updateExecutionState(id, stateUpdate, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('accounts', expectedRevision, this._revision);
    }

    const current = this._accounts.get(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const updated = {
      ...current,
      desiredState: stateUpdate.desiredState !== undefined ? stateUpdate.desiredState : current.desiredState,
      observedState: stateUpdate.observedState !== undefined ? stateUpdate.observedState : current.observedState,
      executionStatusReason: stateUpdate.executionStatusReason !== undefined ? stateUpdate.executionStatusReason : current.executionStatusReason,
      lastUpdated: now
    };

    this._accounts.set(id, Object.freeze(updated));
    this._revision += 1;
    this._lastUpdated = now;

    return { account: updated, revision: this._revision };
  }

  /**
   * Force resets observed state to STOPPED for all in-memory accounts.
   * @param {string} [reason='SYSTEM_BOOT_RECOVERY']
   */
  resetObservedStatesOnBoot(reason = 'SYSTEM_BOOT_RECOVERY') {
    const now = new Date().toISOString();
    for (const [id, acc] of this._accounts.entries()) {
      this._accounts.set(id, Object.freeze({
        ...acc,
        observedState: 'STOPPED',
        executionStatusReason: reason,
        lastUpdated: now
      }));
    }
    this._revision += 1;
    this._lastUpdated = now;
  }

  /**
   * Alias for resetObservedStatesOnBoot.
   * @param {string} [reason='PROCESS_EXIT']
   */
  resetObservedStates(reason = 'PROCESS_EXIT') {
    this.resetObservedStatesOnBoot(reason);
  }

  /**
   * Deletes an account by ID with OCC check.
   * @param {string} id
   * @param {number} [expectedRevision]
   * @returns {boolean}
   */
  delete(id, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('accounts', expectedRevision, this._revision);
    }

    const deleted = this._accounts.delete(id);
    if (deleted) {
      this._balances.delete(id);
      this._revision += 1;
      this._lastUpdated = new Date().toISOString();
    }
    return deleted;
  }

  /**
   * Updates an account's live balance.
   * @param {string} id
   * @param {number} balance
   * @param {string} [currencySymbol]
   */
  updateBalance(id, balance, currencySymbol = '₦') {
    const acc = this._accounts.get(id);
    if (!acc) return false;

    const now = new Date().toISOString();
    this._balances.set(id, {
      balance: Number(balance) || 0,
      currencySymbol,
      lastUpdated: now,
      isStale: false
    });
    this._lastUpdated = now;
    return true;
  }

  /**
   * Marks account balances as stale when TTL expires.
   */
  markBalancesStale() {
    for (const [id, meta] of this._balances.entries()) {
      this._balances.set(id, { ...meta, isStale: true });
    }
  }
}

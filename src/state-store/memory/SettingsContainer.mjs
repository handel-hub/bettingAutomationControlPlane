// @ts-check
import { RevisionConflictError } from '../types/errors.mjs';
import { createDefaultUserSettings } from '../types/contracts.mjs';

/**
 * Normalized in-memory container for User Settings, Profile, and Security state.
 */
export class SettingsContainer {
  /**
   * @param {string} [userId]
   */
  constructor(userId = 'usr_default') {
    this._userId = userId;
    /** @type {any} */
    this._settings = createDefaultUserSettings(userId);
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

  reset(userId = 'usr_default') {
    this._userId = userId;
    this._settings = createDefaultUserSettings(userId);
    this._revision = 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Hydrates settings container.
   * @param {any} [settings]
   * @param {number} [revision]
   */
  hydrate(settings = null, revision = null) {
    if (settings && typeof settings === 'object') {
      this._settings = Object.freeze(JSON.parse(JSON.stringify(settings)));
    } else {
      this._settings = Object.freeze(createDefaultUserSettings(this._userId));
    }

    if (revision !== null && typeof revision === 'number') {
      this._revision = revision;
    } else {
      this._revision += 1;
    }
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Returns a frozen copy of the complete settings snapshot.
   */
  getSnapshot() {
    return this._settings;
  }

  /**
   * Updates profile section with OCC.
   * @param {any} profileData
   * @param {number} [expectedRevision]
   */
  updateProfile(profileData, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('settings_profile', expectedRevision, this._revision);
    }
    const updated = {
      ...this._settings,
      profile: {
        ...this._settings.profile,
        data: {
          ...this._settings.profile.data,
          ...profileData
        }
      }
    };
    this._settings = Object.freeze(updated);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();

    return { settings: this._settings, revision: this._revision };
  }

  /**
   * Updates presentation preferences (theme, density).
   * @param {any} prefs
   * @param {number} [expectedRevision]
   */
  updatePresentation(prefs, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('settings_presentation', expectedRevision, this._revision);
    }
    const updated = {
      ...this._settings,
      presentationPreferences: {
        ...this._settings.presentationPreferences,
        ...prefs
      }
    };
    this._settings = Object.freeze(updated);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();

    return { settings: this._settings, revision: this._revision };
  }

  /**
   * Updates security section with OCC.
   * @param {any} sec
   * @param {number} [expectedRevision]
   */
  updateSecurity(sec, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== this._revision) {
      throw new RevisionConflictError('settings_security', expectedRevision, this._revision);
    }
    const updated = {
      ...this._settings,
      security: {
        ...this._settings.security,
        ...sec
      }
    };
    this._settings = Object.freeze(updated);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();

    return { settings: this._settings, revision: this._revision };
  }
}

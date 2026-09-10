// @ts-check
import { SanitizerGate } from '../../validation/SanitizerGate.mjs';
import { createDefaultUserSettings } from '../../types/contracts.mjs';

/**
 * Persistence adapter for user_settings_cache.
 */
export class SettingsAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Loads user settings.
   * @param {string} userId
   */
  get(userId) {
    const row = this.engine.prepare(`
      SELECT user_id AS userId, name, email, pending_email AS pendingEmail,
             avatar_url AS avatarUrl, mfa_enabled AS mfaEnabled,
             active_sessions_count AS activeSessionsCount, theme_preference AS themePreference,
             density_preference AS densityPreference, email_alerts AS emailAlerts,
             push_alerts AS pushAlerts, weekly_report AS weeklyReport, updated_at AS updatedAt
      FROM user_settings_cache
      WHERE user_id = ?
    `).get(userId);

    if (!row) {
      return createDefaultUserSettings(userId);
    }

    return {
      userId: row.userId,
      profile: {
        status: 'AVAILABLE',
        data: {
          name: row.name,
          email: row.email,
          pendingEmail: row.pendingEmail,
          avatarUrl: row.avatarUrl
        }
      },
      security: {
        status: 'AVAILABLE',
        data: {
          accountStatus: 'ACTIVE',
          deletionScheduledAt: null,
          mfaEnabled: !!row.mfaEnabled,
          activeSessions: row.activeSessionsCount
        }
      },
      presentationPreferences: {
        theme: row.themePreference,
        density: row.densityPreference
      },
      notifications: {
        status: 'AVAILABLE',
        data: {
          emailAlerts: !!row.emailAlerts,
          pushAlerts: !!row.pushAlerts,
          weeklyReport: !!row.weeklyReport
        }
      },
      capabilities: {
        canChangeName: true,
        canChangeEmail: true,
        canChangePassword: true,
        canConfigureMFA: true,
        canRevokeSessions: true,
        canDeleteAccount: false,
        canCancelDeletion: false
      }
    };
  }

  /**
   * Saves user settings.
   * @param {string} userId
   * @param {any} settings
   */
  save(userId, settings) {
    SanitizerGate.assertZeroSecrets(settings);
    const now = new Date().toISOString();
    const profile = settings.profile?.data || {};
    const security = settings.security?.data || {};
    const pres = settings.presentationPreferences || {};
    const notifs = settings.notifications?.data || {};

    this.engine.prepare(`
      INSERT INTO user_settings_cache (
        user_id, name, email, pending_email, avatar_url,
        mfa_enabled, active_sessions_count, theme_preference,
        density_preference, email_alerts, push_alerts, weekly_report, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        pending_email = excluded.pending_email,
        avatar_url = excluded.avatar_url,
        mfa_enabled = excluded.mfa_enabled,
        active_sessions_count = excluded.active_sessions_count,
        theme_preference = excluded.theme_preference,
        density_preference = excluded.density_preference,
        email_alerts = excluded.email_alerts,
        push_alerts = excluded.push_alerts,
        weekly_report = excluded.weekly_report,
        updated_at = excluded.updated_at
    `).run(
      userId,
      profile.name || 'Operator',
      profile.email || 'operator@betting-automation.internal',
      profile.pendingEmail || null,
      profile.avatarUrl || null,
      security.mfaEnabled ? 1 : 0,
      security.activeSessions || 1,
      pres.theme || 'light',
      pres.density || 'comfortable',
      notifs.emailAlerts !== false ? 1 : 0,
      notifs.pushAlerts ? 1 : 0,
      notifs.weeklyReport !== false ? 1 : 0,
      now
    );
  }

  /**
   * Deletes user settings (logout purge).
   * @param {string} userId
   */
  deleteForUser(userId) {
    this.engine.prepare('DELETE FROM user_settings_cache WHERE user_id = ?').run(userId);
  }
}

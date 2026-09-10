// @ts-check

/**
 * Persistence adapter for notifications_cache.
 */
export class NotificationsAdapter {
  /**
   * @param {import('../SqliteStorageEngine.mjs').SqliteStorageEngine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Lists notifications for a user, up to limit.
   * @param {string} userId
   * @param {number} [limit=100]
   * @returns {Array<any>}
   */
  list(userId, limit = 100) {
    const rows = this.engine.prepare(`
      SELECT id, user_id AS userId, timestamp, severity, category,
             title, message, is_read AS isRead, metadata_json AS metadataJson,
             cached_at AS cachedAt
      FROM notifications_cache
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(userId, limit);

    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      severity: r.severity,
      category: r.category,
      title: r.title,
      message: r.message,
      read: !!r.isRead,
      isRead: !!r.isRead,
      metadata: r.metadataJson ? JSON.parse(r.metadataJson) : null
    }));
  }

  /**
   * Appends or updates a notification. Automatically prunes records past the 100 most recent.
   * @param {string} userId
   * @param {any} notif
   */
  save(userId, notif) {
    const now = new Date().toISOString();
    const id = notif.id || `notif_${Date.now()}`;

    this.engine.transaction(() => {
      this.engine.prepare(`
        INSERT INTO notifications_cache (
          id, user_id, timestamp, severity, category, title, message, is_read, metadata_json, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          is_read = excluded.is_read,
          cached_at = excluded.cached_at
      `).run(
        id,
        userId,
        notif.timestamp || now,
        notif.severity || 'INFO',
        notif.category || 'SYSTEM',
        notif.title || '',
        notif.message || '',
        (notif.read || notif.isRead) ? 1 : 0,
        notif.metadata ? JSON.stringify(notif.metadata) : null,
        now
      );

      // Prune past 100 items for this user
      this.engine.prepare(`
        DELETE FROM notifications_cache
        WHERE user_id = ? AND id NOT IN (
          SELECT id FROM notifications_cache
          WHERE user_id = ?
          ORDER BY timestamp DESC
          LIMIT 100
        )
      `).run(userId, userId);
    });
  }

  /**
   * Marks a notification as read.
   * @param {string} userId
   * @param {string} id
   */
  markRead(userId, id) {
    const info = this.engine.prepare(`
      UPDATE notifications_cache SET is_read = 1 WHERE user_id = ? AND id = ?
    `).run(userId, id);
    return info.changes > 0;
  }

  /**
   * Marks all notifications as read for a user.
   * @param {string} userId
   */
  markAllRead(userId) {
    const info = this.engine.prepare(`
      UPDATE notifications_cache SET is_read = 1 WHERE user_id = ?
    `).run(userId);
    return info.changes > 0;
  }

  /**
   * Deletes all notifications for a user (logout purge).
   * @param {string} userId
   */
  deleteForUser(userId) {
    this.engine.prepare('DELETE FROM notifications_cache WHERE user_id = ?').run(userId);
  }
}

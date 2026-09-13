// @ts-check

/**
 * Normalized in-memory container for System Notifications.
 * Enforces a FIFO cap of 100 items and tracks unread count.
 */
export class NotificationsContainer {
  constructor() {
    /** @type {Map<string, any>} */
    this._notifications = new Map();
    /** @type {number} */
    this._unreadCount = 0;
    /** @type {number} */
    this._revision = 1;
    /** @type {string} */
    this._lastUpdated = new Date().toISOString();
  }

  get revision() {
    return this._revision;
  }

  get unreadCount() {
    return this._unreadCount;
  }

  get lastUpdated() {
    return this._lastUpdated;
  }

  reset() {
    this._notifications.clear();
    this._unreadCount = 0;
    this._revision = 1;
    this._lastUpdated = new Date().toISOString();
  }

  /**
   * Hydrates notifications feed.
   * @param {Array<any>} items
   * @param {number} [revision]
   */
  hydrate(items = [], revision = null) {
    this._notifications.clear();
    this._unreadCount = 0;

    if (Array.isArray(items)) {
      // Sort newest first
      const sorted = [...items].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      for (const item of sorted.slice(0, 100)) {
        this._notifications.set(item.id, Object.freeze(JSON.parse(JSON.stringify(item))));
        if (!item.isRead && !item.read) {
          this._unreadCount += 1;
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
   * Returns all cached notifications as a frozen array.
   */
  getAll() {
    return Object.freeze(Array.from(this._notifications.values()));
  }

  /**
   * Appends a new notification. Automatically evicts the oldest item if > 100 items.
   * @param {any} notification
   */
  add(notification) {
    const id = notification.id || `notif-${Date.now()}`;
    const record = Object.freeze({
      id,
      timestamp: notification.timestamp || new Date().toISOString(),
      severity: notification.severity || 'INFO',
      category: notification.category || 'SYSTEM',
      title: notification.title || '',
      message: notification.message || '',
      read: !!notification.read || !!notification.isRead,
      isRead: !!notification.read || !!notification.isRead,
      metadata: notification.metadata || null
    });

    // FIFO eviction if cap reached
    if (this._notifications.size >= 100) {
      const oldestKey = this._notifications.keys().next().value;
      if (oldestKey) {
        const oldest = this._notifications.get(oldestKey);
        if (oldest && !oldest.read) {
          this._unreadCount = Math.max(0, this._unreadCount - 1);
        }
        this._notifications.delete(oldestKey);
      }
    }

    this._notifications.set(id, record);
    if (!record.read) {
      this._unreadCount += 1;
    }
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();

    return record;
  }

  append(notification) {
    return this.add(notification);
  }

  delete(id) {
    const existing = this._notifications.get(id);
    if (!existing) return false;
    if (!existing.read) {
      this._unreadCount = Math.max(0, this._unreadCount - 1);
    }
    this._notifications.delete(id);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
    return true;
  }

  /**
   * Marks a single notification as read.
   * @param {string} id
   */
  markRead(id) {
    const existing = this._notifications.get(id);
    if (!existing || existing.read) return false;

    const updated = Object.freeze({
      ...existing,
      read: true,
      isRead: true
    });
    this._notifications.set(id, updated);
    this._unreadCount = Math.max(0, this._unreadCount - 1);
    this._revision += 1;
    this._lastUpdated = new Date().toISOString();
    return true;
  }

  /**
   * Marks all notifications as read.
   */
  markAllRead() {
    let changed = false;
    for (const [id, item] of this._notifications.entries()) {
      if (!item.read) {
        this._notifications.set(id, Object.freeze({ ...item, read: true, isRead: true }));
        changed = true;
      }
    }
    if (changed) {
      this._unreadCount = 0;
      this._revision += 1;
      this._lastUpdated = new Date().toISOString();
    }
    return changed;
  }
}

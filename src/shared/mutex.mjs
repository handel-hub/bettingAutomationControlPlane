// @ts-check

/**
 * A simple in-memory single-writer Mutex for synchronization within the Node.js event loop.
 */
export class Mutex {
  constructor() {
    /** @type {Array<function(): void>} */
    this._queue = [];
    this._locked = false;
  }

  /**
   * Acquires the lock. Returns a function to release it.
   * @returns {Promise<function(): void>}
   */
  async acquire() {
    return new Promise(resolve => {
      const lockAcquired = () => {
        this._locked = true;
        resolve(() => this.release());
      };

      if (!this._locked) {
        lockAcquired();
      } else {
        this._queue.push(lockAcquired);
      }
    });
  }

  /**
   * Releases the lock and grants it to the next waiter, if any.
   */
  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      if (next) {
        // Execute next tick to avoid deep call stacks
        setTimeout(next, 0);
      }
    } else {
      this._locked = false;
    }
  }
}

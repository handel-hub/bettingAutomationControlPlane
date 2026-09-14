// @ts-check

/**
 * Async Mutex for serializing asynchronous operations across lifecycle boundaries.
 */
export class AsyncMutex {
  constructor() {
    /** @type {Promise<void>} */
    this._queue = Promise.resolve();
    this._isLocked = false;
  }

  get isLocked() {
    return this._isLocked;
  }

  /**
   * Acquires the mutex lock and returns a release function.
   * @returns {Promise<() => void>}
   */
  async acquire() {
    let release;
    const ticket = new Promise((resolve) => {
      release = resolve;
    });

    const previous = this._queue;
    this._queue = previous.then(() => ticket);

    await previous;
    this._isLocked = true;

    return () => {
      this._isLocked = false;
      release();
    };
  }

  /**
   * Executes a task under the exclusive lock.
   * @template T
   * @param {() => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  async runExclusive(task) {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }
}

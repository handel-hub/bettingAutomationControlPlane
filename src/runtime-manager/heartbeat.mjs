// @ts-check

/**
 * Monitors the liveliness and integrity of spawned Runtime processes.
 */
export class RuntimeHeartbeat {
  constructor() {
    /** @type {Map<number, number>} */
    this.lastSeen = new Map();
  }

  /**
   * Records a valid heartbeat from a runtime process.
   * @param {number} pid 
   */
  recordHeartbeat(pid) {
    this.lastSeen.set(pid, Date.now());
  }

  /**
   * Checks for dead or stalled processes.
   * @param {number} timeoutMs 
   * @returns {number[]} Array of stalled PIDs
   */
  getStalledProcesses(timeoutMs = 15000) {
    const now = Date.now();
    const stalled = [];
    for (const [pid, timestamp] of this.lastSeen.entries()) {
      if (now - timestamp > timeoutMs) {
        stalled.push(pid);
      }
    }
    return stalled;
  }

  /**
   * Clears a terminated PID from tracking.
   * @param {number} pid
   */
  remove(pid) {
    this.lastSeen.delete(pid);
  }

  /**
   * Clears all tracking records.
   */
  clear() {
    this.lastSeen.clear();
  }
}

export const runtimeHeartbeat = new RuntimeHeartbeat();

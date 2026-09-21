// @ts-check
import EventEmitter from 'node:events';

/**
 * Multi-Tiered Liveness Watchdog Monitor.
 * Ingests TELEMETRY:HEARTBEAT frames and triggers tiered alerts at 3s, 5s, and 10s.
 */
export class WatchdogMonitor extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.checkIntervalMs=500]
   * @param {number} [options.warningTimeoutMs=3000]
   * @param {number} [options.degradedTimeoutMs=5000]
   * @param {number} [options.quarantineTimeoutMs=10000]
   */
  constructor({
    checkIntervalMs = 500,
    warningTimeoutMs = 3000,
    degradedTimeoutMs = 5000,
    quarantineTimeoutMs = 10000
  } = {}) {
    super();
    this.checkIntervalMs = checkIntervalMs;
    this.warningTimeoutMs = warningTimeoutMs;
    this.degradedTimeoutMs = degradedTimeoutMs;
    this.quarantineTimeoutMs = quarantineTimeoutMs;

    /** @type {'OFFLINE' | 'HEALTHY' | 'UNRESPONSIVE' | 'DEGRADED' | 'QUARANTINE_REQUIRED'} */
    this.livenessState = 'OFFLINE';
    /** @type {number} */
    this.lastHeartbeatTimestamp = 0;
    /** @type {any} */
    this.lastHeartbeatPayload = null;
    /** @type {NodeJS.Timeout | null} */
    this._timer = null;
  }

  /**
   * Resets internal tracking state to clean initial baseline.
   */
  reset() {
    this.livenessState = 'OFFLINE';
    this.lastHeartbeatTimestamp = 0;
    this.lastHeartbeatPayload = null;
  }

  /**
   * Starts periodic watchdog checks.
   */
  start() {
    this.reset();
    if (this._timer) return;
    this._timer = setInterval(() => this.checkLiveness(), this.checkIntervalMs);
    if (this._timer.unref) {
      this._timer.unref();
    }
  }

  /**
   * Stops periodic watchdog checks.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.reset();
  }

  /**
   * Records an authenticated heartbeat frame from the worker.
   * @param {object} [payload={}]
   */
  recordHeartbeat(payload = {}) {
    const now = Date.now();
    this.lastHeartbeatTimestamp = now;
    this.lastHeartbeatPayload = payload;

    const previousState = this.livenessState;
    this.livenessState = 'HEALTHY';

    if (previousState === 'UNRESPONSIVE' || previousState === 'DEGRADED' || previousState === 'QUARANTINE_REQUIRED') {
      this.emit('livenessRecovered', { previousState, timestamp: now });
    }

    this.emit('heartbeat', payload);
  }

  /**
   * Checks heartbeat freshness against tiered timeout thresholds.
   */
  checkLiveness() {
    if (this.lastHeartbeatTimestamp === 0) {
      return; // Not yet initialized with first heartbeat
    }

    const elapsed = Date.now() - this.lastHeartbeatTimestamp;

    if (elapsed >= this.quarantineTimeoutMs) {
      if (this.livenessState !== 'QUARANTINE_REQUIRED') {
        this.livenessState = 'QUARANTINE_REQUIRED';
        this.emit('quarantineRequired', {
          elapsed,
          lastSeen: this.lastHeartbeatTimestamp,
          reason: `Missing heartbeat for ${elapsed}ms (exceeded ${this.quarantineTimeoutMs}ms)`
        });
      }
      return;
    }

    if (elapsed >= this.degradedTimeoutMs) {
      if (this.livenessState !== 'DEGRADED' && this.livenessState !== 'QUARANTINE_REQUIRED') {
        this.livenessState = 'DEGRADED';
        this.emit('livenessDegraded', {
          elapsed,
          lastSeen: this.lastHeartbeatTimestamp,
          reason: `Missing heartbeat for ${elapsed}ms (exceeded ${this.degradedTimeoutMs}ms)`
        });
      }
      return;
    }

    if (elapsed >= this.warningTimeoutMs) {
      if (this.livenessState === 'HEALTHY') {
        this.livenessState = 'UNRESPONSIVE';
        this.emit('livenessWarning', {
          elapsed,
          lastSeen: this.lastHeartbeatTimestamp,
          reason: `Missing heartbeat for ${elapsed}ms (exceeded ${this.warningTimeoutMs}ms)`
        });
      }
    }
  }

  /**
   * Returns true if worker is responsive and healthy.
   */
  isHealthy() {
    return this.livenessState === 'HEALTHY';
  }

  /**
   * Returns true if circuit breaker should trip.
   */
  isDegraded() {
    return this.livenessState === 'DEGRADED' || this.livenessState === 'QUARANTINE_REQUIRED';
  }

  /**
   * Returns current liveness state string.
   */
  getLivenessState() {
    return this.livenessState;
  }

  /**
   * Returns last heartbeat details.
   */
  getLastHeartbeat() {
    return {
      timestamp: this.lastHeartbeatTimestamp,
      elapsed: this.lastHeartbeatTimestamp ? Date.now() - this.lastHeartbeatTimestamp : null,
      payload: this.lastHeartbeatPayload
    };
  }
}

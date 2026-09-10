// @ts-check
import EventEmitter from 'node:events';

/**
 * Collects and evaluates Master/Slave Global Event Sequence (GES)
 * and scroll synchronization metrics across the Execution Plane boundary.
 */
export class SyncMetricsCollector extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAcceptableDrift=5] - Maximum GES drift before alert
   */
  constructor({ maxAcceptableDrift = 5 } = {}) {
    super();
    this.maxAcceptableDrift = maxAcceptableDrift;
    this.latestMetrics = null;
    this.lastRecordedAt = 0;
  }

  /**
   * Ingests a TELEMETRY:SYNC_METRICS payload from the Execution Plane.
   * @param {object} payload
   * @param {number} [payload.masterGes]
   * @param {Array<{ browserId: string, currentGes: number, drift: number, consecutiveGaps?: number, syncState: string, scrollDriftPx?: number }>} [payload.slaves]
   * @param {string} [payload.clusterSyncState]
   */
  recordMetrics(payload) {
    if (!payload || typeof payload !== 'object') return;

    this.lastRecordedAt = Date.now();
    this.latestMetrics = {
      masterGes: Number(payload.masterGes) || 0,
      slaves: Array.isArray(payload.slaves) ? payload.slaves : [],
      clusterSyncState: payload.clusterSyncState || 'OPTIMAL',
      recordedAt: this.lastRecordedAt
    };

    // Check for diverged slaves
    const divergedSlaves = this.latestMetrics.slaves.filter(s =>
      Math.abs(s.drift) > this.maxAcceptableDrift || s.syncState === 'DESYNCHRONIZED'
    );

    if (divergedSlaves.length > 0 || this.latestMetrics.clusterSyncState === 'DIVERGED') {
      this.emit('syncDiverged', {
        clusterSyncState: this.latestMetrics.clusterSyncState,
        divergedSlaves,
        masterGes: this.latestMetrics.masterGes,
        recordedAt: this.lastRecordedAt
      });
    }

    this.emit('syncMetrics', this.latestMetrics);
    return this.latestMetrics;
  }

  /**
   * Returns the latest synchronization snapshot.
   */
  getLatestMetrics() {
    return this.latestMetrics;
  }

  /**
   * Returns true if cluster synchronization is optimal or acceptable.
   */
  isSynchronized() {
    if (!this.latestMetrics) return true; // No data yet, assume neutral
    return this.latestMetrics.clusterSyncState === 'OPTIMAL' || this.latestMetrics.clusterSyncState === 'CONVERGING';
  }

  /**
   * Returns the highest drift value currently reported across all active slaves.
   */
  getMaxDrift() {
    if (!this.latestMetrics || !this.latestMetrics.slaves.length) return 0;
    return Math.max(...this.latestMetrics.slaves.map(s => Math.abs(s.drift || 0)));
  }
}

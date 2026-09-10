// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncMetricsCollector } from '../../src/runtime-manager/boundary/syncMetricsCollector.mjs';

test('SyncMetricsCollector - Master/Slave GES Total Ordering & Drift Telemetry', async (t) => {
  await t.test('ingests optimal metrics and reports synchronized state', () => {
    const collector = new SyncMetricsCollector({ maxAcceptableDrift: 5 });

    let received = null;
    collector.on('syncMetrics', (m) => { received = m; });

    collector.recordMetrics({
      masterGes: 100,
      slaves: [
        { browserId: 'slave_0', currentGes: 100, drift: 0, syncState: 'SYNCHRONIZED', scrollDriftPx: 0 },
        { browserId: 'slave_1', currentGes: 99, drift: 1, syncState: 'SYNCHRONIZED', scrollDriftPx: 5 }
      ],
      clusterSyncState: 'OPTIMAL'
    });

    assert.ok(received);
    assert.strictEqual(received.masterGes, 100);
    assert.strictEqual(received.slaves.length, 2);
    assert.strictEqual(collector.isSynchronized(), true);
    assert.strictEqual(collector.getMaxDrift(), 1);
  });

  await t.test('emits syncDiverged when slave drift exceeds threshold or cluster is DIVERGED', () => {
    const collector = new SyncMetricsCollector({ maxAcceptableDrift: 3 });

    let divergedAlert = null;
    collector.on('syncDiverged', (alert) => {
      divergedAlert = alert;
    });

    collector.recordMetrics({
      masterGes: 200,
      slaves: [
        { browserId: 'slave_0', currentGes: 200, drift: 0, syncState: 'SYNCHRONIZED' },
        { browserId: 'slave_1', currentGes: 194, drift: 6, syncState: 'DESYNCHRONIZED' }
      ],
      clusterSyncState: 'DIVERGED'
    });

    assert.ok(divergedAlert);
    assert.strictEqual(divergedAlert.divergedSlaves.length, 1);
    assert.strictEqual(divergedAlert.divergedSlaves[0].browserId, 'slave_1');
    assert.strictEqual(collector.isSynchronized(), false);
    assert.strictEqual(collector.getMaxDrift(), 6);
  });
});

// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchdogMonitor } from '../../src/runtime-manager/boundary/watchdogMonitor.mjs';

test('WatchdogMonitor - Tiered Liveness Thresholds & Heartbeat Ingestion', async (t) => {
  await t.test('records heartbeat and transitions to HEALTHY', () => {
    const watchdog = new WatchdogMonitor();
    assert.strictEqual(watchdog.getLivenessState(), 'OFFLINE');

    let heartbeatEvent = null;
    watchdog.on('heartbeat', (p) => { heartbeatEvent = p; });

    watchdog.recordHeartbeat({ pid: 1234, engineStatus: 'RUNNING' });

    assert.strictEqual(watchdog.getLivenessState(), 'HEALTHY');
    assert.strictEqual(watchdog.isHealthy(), true);
    assert.strictEqual(watchdog.isDegraded(), false);
    assert.ok(heartbeatEvent);
    assert.strictEqual(heartbeatEvent.pid, 1234);
  });

  await t.test('transitions through tiered thresholds: 3s warning, 5s degraded, 10s quarantine (scaled for test)', async () => {
    // Scaled down timeouts for fast unit test: 20ms, 40ms, 80ms
    const watchdog = new WatchdogMonitor({
      checkIntervalMs: 10,
      warningTimeoutMs: 20,
      degradedTimeoutMs: 40,
      quarantineTimeoutMs: 80
    });

    let warningFired = false;
    let degradedFired = false;
    let quarantineFired = false;

    watchdog.on('livenessWarning', () => { warningFired = true; });
    watchdog.on('livenessDegraded', () => { degradedFired = true; });
    watchdog.on('quarantineRequired', () => { quarantineFired = true; });

    watchdog.start();
    watchdog.recordHeartbeat({ pid: 5678 });

    // 1. Wait for warning
    const startWarn = Date.now();
    while (!warningFired && Date.now() - startWarn < 200) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(warningFired, true);
    assert.strictEqual(watchdog.getLivenessState(), 'UNRESPONSIVE');

    // 2. Wait for degraded
    const startDeg = Date.now();
    while (!degradedFired && Date.now() - startDeg < 200) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(degradedFired, true);
    assert.strictEqual(watchdog.isDegraded(), true);

    // 3. Wait for quarantine
    const startQuar = Date.now();
    while (!quarantineFired && Date.now() - startQuar < 300) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(quarantineFired, true);
    assert.strictEqual(watchdog.getLivenessState(), 'QUARANTINE_REQUIRED');

    // 4. Test recovery when a fresh heartbeat arrives
    let recoveredFired = false;
    watchdog.on('livenessRecovered', () => { recoveredFired = true; });

    watchdog.recordHeartbeat({ pid: 5678 });
    assert.strictEqual(recoveredFired, true);
    assert.strictEqual(watchdog.getLivenessState(), 'HEALTHY');
    assert.strictEqual(watchdog.isHealthy(), true);

    watchdog.stop();
  });
});

// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { PipeTransport } from '../../src/runtime-manager/boundary/pipeTransport.mjs';
import { MockTransport } from './mock-transport.mjs';
import { ExecutionMessageType, ExecutionErrorCode } from '../../src/runtime-manager/executionProtocol.mjs';

test('ACP ↔ Execution Plane Boundary Contract - Logical Invariants Verification', async (t) => {
  function createFixture() {
    const mockTransport = new MockTransport();
    const pipeTransport = new PipeTransport({ customAdapter: mockTransport });
    const mockSecurity = { isDegraded: () => false };
    const mockStore = {
      configContainer: { toSettingsIniObject: () => ({}) },
      accountsContainer: { getAll: () => [] }
    };

    const manager = new ExecutionBoundaryManager({
      transport: pipeTransport,
      securityAuthority: mockSecurity,
      stateStore: mockStore,
      defaultCommandTimeoutMs: 500
    });

    manager.startServer();
    mockTransport.simulateClientConnect(1);

    return { manager, mockTransport, mockSecurity };
  }

  await t.test('Invariant 1: UNCERTAIN outcome freezes account lease, rejecting subsequent bets with EP_STATE_002', () => {
    const { manager, mockTransport } = createFixture();

    // 1. Initial bet is placed on acc_sporty_01
    manager.placeBet({
      operationId: 'op_atomic_01',
      idempotencyKey: 'idem_atomic_01',
      targetAccounts: ['acc_sporty_01'],
      stake: 200
    });

    // 2. Execution Plane encounters unconfirmed settlement timeout -> emits UNKNOWN / EP_TX_001
    mockTransport.simulateIncomingData(1, JSON.stringify({
      msgId: 'msg_res_uncertain',
      traceId: 'trace_res_uncertain',
      type: ExecutionMessageType.OPERATION_RESULT,
      timestamp: Date.now(),
      source: 'EXECUTION_PLANE',
      payload: {
        operationId: 'op_atomic_01',
        status: 'UNKNOWN',
        code: ExecutionErrorCode.UNCERTAIN_OUTCOME,
        accountId: 'acc_sporty_01',
        error: 'DOM settlement timed out after atomic click committed'
      }
    }));

    // 3. Invariant check: Account must now be frozen
    assert.strictEqual(manager.isAccountFrozen('acc_sporty_01'), true);

    // 4. Invariant check: Subsequent placeBet must be REJECTED with EP_STATE_002
    assert.throws(
      () => manager.placeBet({
        operationId: 'op_atomic_02',
        targetAccounts: ['acc_sporty_01'],
        stake: 200
      }),
      (err) => {
        assert.ok(err.message.includes('EP_STATE_002'));
        assert.ok(err.message.includes('acc_sporty_01'));
        assert.ok(err.message.includes('frozen pending reconciliation'));
        return true;
      }
    );

    // 5. Invariant check: Subsequent cashOut must also be REJECTED with EP_STATE_002
    assert.throws(
      () => manager.cashOut({
        operationId: 'op_cashout_01',
        accountId: 'acc_sporty_01'
      }),
      (err) => {
        assert.ok(err.message.includes('EP_STATE_002'));
        return true;
      }
    );

    // 6. Healthy accounts are NOT affected
    assert.strictEqual(manager.isAccountFrozen('acc_sporty_02'), false);
    assert.doesNotThrow(() => manager.placeBet({
      operationId: 'op_atomic_healthy',
      targetAccounts: ['acc_sporty_02'],
      stake: 100
    }));

    // 7. Unfreezing occurs only when reconciliation resolves
    mockTransport.simulateIncomingData(1, JSON.stringify({
      msgId: 'msg_reconcile_report',
      traceId: 'trace_reconcile',
      type: ExecutionMessageType.RECONCILIATION_REPORT,
      timestamp: Date.now(),
      source: 'EXECUTION_PLANE',
      payload: {
        operationId: 'op_atomic_01',
        resolutionStatus: 'RESOLVED_COMMITTED',
        platformOrder: { orderId: 'ORD-SP-123' }
      }
    }));

    assert.strictEqual(manager.isAccountFrozen('acc_sporty_01'), false);

    // 8. After unfreezing, betting is restored
    assert.doesNotThrow(() => manager.placeBet({
      operationId: 'op_atomic_restored',
      targetAccounts: ['acc_sporty_01'],
      stake: 200
    }));

    manager.stopServer();
  });

  await t.test('Invariant 2: Financial Idempotency - FAILED operations require forceRetry: true to re-execute', () => {
    const { manager, mockTransport } = createFixture();

    // 1. Place initial bet
    manager.placeBet({
      operationId: 'op_failed_1',
      idempotencyKey: 'idem_fail_test',
      stake: 100
    });

    // 2. Mark operation as FAILED in terminal result
    mockTransport.simulateIncomingData(1, JSON.stringify({
      msgId: 'msg_fail',
      traceId: 'trace_fail',
      type: ExecutionMessageType.OPERATION_RESULT,
      timestamp: Date.now(),
      source: 'EXECUTION_PLANE',
      payload: {
        operationId: 'op_failed_1',
        idempotencyKey: 'idem_fail_test',
        status: 'FAILED',
        error: 'Market suspended'
      }
    }));

    const sentCountBefore = mockTransport.sentPayloads.length;

    // 3. Retry without forceRetry: true -> intercepted by ledger and rejected
    const retryWithoutForce = manager.placeBet({
      operationId: 'op_failed_1_retry',
      idempotencyKey: 'idem_fail_test',
      stake: 100
    });
    assert.strictEqual(retryWithoutForce.duplicate, true);
    assert.strictEqual(retryWithoutForce.status, 'FAILED');
    assert.ok(retryWithoutForce.error.includes('forceRetry: true'));
    assert.strictEqual(mockTransport.sentPayloads.length, sentCountBefore); // Not dispatched to transport

    // 4. Retry WITH forceRetry: true -> successfully dispatches to transport
    const retryWithForce = manager.placeBet({
      operationId: 'op_failed_1_retry_forced',
      idempotencyKey: 'idem_fail_test',
      stake: 100,
      forceRetry: true
    });
    assert.strictEqual(retryWithForce, true);
    assert.strictEqual(mockTransport.sentPayloads.length, sentCountBefore + 1);

    manager.stopServer();
  });

  await t.test('Invariant 3: Reconnection & Snapshot Dump automatically enqueues unresolved WAL runs and freezes accounts', () => {
    const { manager, mockTransport } = createFixture();

    assert.strictEqual(manager.isAccountFrozen('acc_wal_01'), false);

    // Simulate Execution Plane reconnecting after crash and dumping WAL snapshot with an UNCERTAIN run
    mockTransport.simulateIncomingData(1, JSON.stringify({
      msgId: 'msg_snap_dump',
      traceId: 'trace_snap_dump',
      type: ExecutionMessageType.SNAPSHOT_DUMP,
      timestamp: Date.now(),
      source: 'EXECUTION_PLANE',
      payload: {
        engineStatus: 'READY',
        activeBrowserCount: 2,
        unresolvedRuns: [
          {
            runId: 'wal_run_991',
            accountId: 'acc_wal_01',
            idempotencyKey: 'idem_wal_991',
            status: 'UNCERTAIN',
            stake: 350
          }
        ]
      }
    }));

    // Invariant check: Account from unresolved WAL run must be frozen immediately
    assert.strictEqual(manager.isAccountFrozen('acc_wal_01'), true);
    assert.strictEqual(manager.getEngineStatus(), 'READY');

    manager.stopServer();
  });

  await t.test('Invariant 4: Liveness Watchdog degraded mode halts inbound tactical commands (Circuit Breaker)', () => {
    const { manager, mockTransport } = createFixture();

    // Simulate watchdog tripping degraded mode (e.g. 5s missing heartbeat)
    manager.watchdog.livenessState = 'DEGRADED';

    assert.throws(
      () => manager.placeBet({ operationId: 'op_circuit_test', stake: 100 }),
      (err) => {
        assert.ok(err.message.includes('Execution Plane is DEGRADED'));
        return true;
      }
    );

    assert.throws(
      () => manager.cashOut({ operationId: 'op_cashout_test' }),
      (err) => {
        assert.ok(err.message.includes('Execution Plane is DEGRADED'));
        return true;
      }
    );

    // Once liveness recovers, circuit breaker resets
    manager.watchdog.recordHeartbeat({ pid: 1001, engineStatus: 'RUNNING' });
    assert.doesNotThrow(() => manager.placeBet({ operationId: 'op_circuit_recovered', stake: 100 }));

    manager.stopServer();
  });
});

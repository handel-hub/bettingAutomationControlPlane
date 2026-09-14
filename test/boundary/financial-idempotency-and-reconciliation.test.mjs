// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyLedger } from '../../src/runtime-manager/boundary/idempotencyLedger.mjs';
import { ReconciliationCoordinator } from '../../src/runtime-manager/boundary/reconciliationCoordinator.mjs';
import { ExecutionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { SqliteStorageEngine } from '../../src/state-store/persistence/SqliteStorageEngine.mjs';

test('Track B: Financial Idempotency & Out-of-Band Reconciliation (Phases 15 & 21)', async (t) => {
  await t.test('PHASE 15: 10 identical bet commands result in exactly 1 transmission and 9 cached responses', () => {
    let broadcastCount = 0;
    const mockTransport = {
      startServer: () => {},
      stopServer: () => {},
      broadcast: () => {
        broadcastCount++;
        return 1;
      },
      isConnected: () => true,
      getActiveConnections: () => 1,
      on: () => {}
    };

    const mockSecurity = {
      isDegraded: () => false
    };

    const mockWatchdog = {
      start: () => {},
      stop: () => {},
      isDegraded: () => false,
      on: () => {}
    };

    const manager = new ExecutionBoundaryManager({
      // @ts-ignore
      transport: mockTransport,
      // @ts-ignore
      securityAuthority: mockSecurity,
      // @ts-ignore
      watchdogMonitor: mockWatchdog
    });

    const idempotencyKey = 'idem_bet_unique_123';
    const betPayload = {
      idempotencyKey,
      operationId: 'op_bet_001',
      accountId: 'acc_01',
      stake: 500,
      odds: 2.1
    };

    const results = [];
    for (let i = 0; i < 10; i++) {
      const res = manager.placeBet(betPayload);
      results.push(res);
    }

    assert.strictEqual(broadcastCount, 1, 'Only 1 message was physically broadcast to transport');
    assert.strictEqual(results.length, 10);
    // First result is dispatch result (boolean true from broadcast)
    assert.strictEqual(results[0], true);

    // Remaining 9 results must be cached in-flight deduplications
    for (let i = 1; i < 10; i++) {
      assert.strictEqual(results[i].duplicate, true);
      assert.strictEqual(results[i].status, 'IN_FLIGHT');
      assert.strictEqual(results[i].cachedAck, true);
    }

    manager.stopServer();
  });

  await t.test('PHASE 15: Terminal COMPLETED cached result is returned on retry', () => {
    const ledger = new IdempotencyLedger();
    ledger.recordInFlight('idem_key_comp', 'op_c1');
    ledger.recordTerminal('idem_key_comp', 'COMPLETED', { orderId: 'ORD-999', stakePlaced: 100 });

    const check = ledger.check('idem_key_comp');
    assert.strictEqual(check.exists, true);
    assert.strictEqual(check.status, 'COMPLETED');
    assert.strictEqual(check.cachedResult.orderId, 'ORD-999');
  });

  await t.test('PHASE 15 & 21: Interrupted bet freezes account and rejects subsequent bets with EP_STATE_002', () => {
    const coordinator = new ReconciliationCoordinator();
    const manager = new ExecutionBoundaryManager({
      reconciliationCoordinator: coordinator,
      // @ts-ignore
      securityAuthority: { isDegraded: () => false },
      // @ts-ignore
      watchdogMonitor: { start: () => {}, stop: () => {}, isDegraded: () => false, on: () => {} },
      // @ts-ignore
      transport: { startServer: () => {}, stopServer: () => {}, broadcast: () => 1, isConnected: () => true, on: () => {} }
    });

    // 1. Initial bet succeeds
    const bet1 = manager.placeBet({
      idempotencyKey: 'idem_b1',
      accountId: 'acc_beta',
      stake: 200,
      odds: 1.85
    });
    assert.strictEqual(bet1, true);

    // 2. Failure occurs: bet enters UNCERTAIN state and enqueues to ReconciliationCoordinator
    coordinator.enqueueUncertainOperation({
      operationId: 'op_uncertain_beta',
      accountId: 'acc_beta',
      idempotencyKey: 'idem_b1',
      reason: 'PIPE_TIMEOUT_DURING_SETTLEMENT'
    });

    assert.strictEqual(manager.isAccountFrozen('acc_beta'), true);

    // 3. Subsequent bet on frozen account acc_beta MUST be rejected with EP_STATE_002
    assert.throws(() => {
      manager.placeBet({
        idempotencyKey: 'idem_b2',
        accountId: 'acc_beta',
        stake: 100,
        odds: 2.0
      });
    }, (err) => {
      assert.match(err.message, /\[EP_STATE_002\] Execution Denied: Account \[acc_beta\] is frozen/);
      return true;
    });

    // 4. Different account acc_gamma should NOT be frozen
    assert.strictEqual(manager.isAccountFrozen('acc_gamma'), false);
    const betGamma = manager.placeBet({
      idempotencyKey: 'idem_b3',
      accountId: 'acc_gamma',
      stake: 100,
      odds: 2.0
    });
    assert.strictEqual(betGamma, true);

    manager.stopServer();
  });

  await t.test('PHASE 21: RESOLVED_COMMITTED report unfreezes account and allows subsequent bets', () => {
    const coordinator = new ReconciliationCoordinator();
    const manager = new ExecutionBoundaryManager({
      reconciliationCoordinator: coordinator,
      // @ts-ignore
      securityAuthority: { isDegraded: () => false },
      // @ts-ignore
      watchdogMonitor: { start: () => {}, stop: () => {}, isDegraded: () => false, on: () => {} },
      // @ts-ignore
      transport: { startServer: () => {}, stopServer: () => {}, broadcast: () => 1, isConnected: () => true, on: () => {} }
    });

    coordinator.enqueueUncertainOperation({
      operationId: 'op_rec_commit',
      accountId: 'acc_commit_test',
      idempotencyKey: 'idem_commit_1',
      reason: 'CRASH_SIMULATION'
    });

    assert.strictEqual(manager.isAccountFrozen('acc_commit_test'), true);

    // Receive reconciliation report from bookmaker polling
    const outcome = coordinator.handleReconciliationReport({
      operationId: 'op_rec_commit',
      resolutionStatus: 'RESOLVED_COMMITTED',
      platformOrder: { slipId: 'SLIP-4432', verifiedStake: 250 }
    });

    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.outcome, 'COMPLETED');
    assert.strictEqual(manager.isAccountFrozen('acc_commit_test'), false);

    // Subsequent bet is now accepted
    const nextBet = manager.placeBet({
      idempotencyKey: 'idem_commit_2',
      accountId: 'acc_commit_test',
      stake: 250,
      odds: 1.5
    });
    assert.strictEqual(nextBet, true);

    manager.stopServer();
  });

  await t.test('PHASE 21: RESOLVED_LOST report unfreezes account', () => {
    const coordinator = new ReconciliationCoordinator();
    coordinator.enqueueUncertainOperation({
      operationId: 'op_rec_lost',
      accountId: 'acc_lost_test',
      idempotencyKey: 'idem_lost_1',
      reason: 'NETWORK_DROP'
    });

    assert.strictEqual(coordinator.isAccountFrozen('acc_lost_test'), true);

    const outcome = coordinator.handleReconciliationReport({
      operationId: 'op_rec_lost',
      resolutionStatus: 'RESOLVED_LOST',
      platformOrder: null
    });

    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.outcome, 'FAILED');
    assert.strictEqual(coordinator.isAccountFrozen('acc_lost_test'), false);
  });

  await t.test('PHASE 21: manualResolve administrative override unfreezes account with audit note', () => {
    const coordinator = new ReconciliationCoordinator();
    coordinator.enqueueUncertainOperation({
      operationId: 'op_rec_manual',
      accountId: 'acc_manual_test',
      idempotencyKey: 'idem_manual_1',
      reason: 'UNVERIFIED_BY_API'
    });

    assert.strictEqual(coordinator.isAccountFrozen('acc_manual_test'), true);

    let eventFired = false;
    coordinator.on('reconciliationResolved', (res) => {
      eventFired = true;
      assert.strictEqual(res.manual, true);
      assert.strictEqual(res.operatorNote, 'Confirmed manually with bookmaker support');
      assert.strictEqual(res.outcome, 'COMPLETED');
    });

    const res = coordinator.manualResolve('op_rec_manual', 'COMPLETED', 'Confirmed manually with bookmaker support');
    assert.strictEqual(res.outcome, 'COMPLETED');
    assert.strictEqual(eventFired, true);
    assert.strictEqual(coordinator.isAccountFrozen('acc_manual_test'), false);
  });

  await t.test('PHASE 16 & 21: SQLite persistence survives restarts, keeping unresolved accounts frozen', () => {
    const engine = new SqliteStorageEngine(':memory:');
    engine.open();

    // 1. First instance with SQLite engine
    const coordinator1 = new ReconciliationCoordinator({ engine });
    coordinator1.enqueueUncertainOperation({
      operationId: 'op_persist_1',
      accountId: 'acc_persist_crash',
      idempotencyKey: 'idem_p1',
      reason: 'POWER_LOSS_SIMULATION'
    });

    assert.strictEqual(coordinator1.isAccountFrozen('acc_persist_crash'), true);

    // 2. Simulate process restart: instantiate new coordinator with same engine
    const coordinator2 = new ReconciliationCoordinator({ engine });

    // Invariant: Account must STILL be frozen on boot!
    assert.strictEqual(coordinator2.isAccountFrozen('acc_persist_crash'), true);
    assert.strictEqual(coordinator2.getPendingReconciliations().length, 1);
    assert.strictEqual(coordinator2.getPendingReconciliations()[0].operationId, 'op_persist_1');

    // 3. Resolve it in coordinator2
    coordinator2.handleReconciliationReport({
      operationId: 'op_persist_1',
      resolutionStatus: 'RESOLVED_COMMITTED',
      platformOrder: { orderId: 'RECOVERED_1' }
    });

    assert.strictEqual(coordinator2.isAccountFrozen('acc_persist_crash'), false);

    // 4. Simulate third reboot: should no longer be frozen
    const coordinator3 = new ReconciliationCoordinator({ engine });
    assert.strictEqual(coordinator3.isAccountFrozen('acc_persist_crash'), false);
    assert.strictEqual(coordinator3.getPendingReconciliations().length, 0);

    engine.close();
  });
});

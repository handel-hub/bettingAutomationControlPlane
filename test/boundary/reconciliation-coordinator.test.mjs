// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconciliationCoordinator } from '../../src/runtime-manager/boundary/reconciliationCoordinator.mjs';

test('ReconciliationCoordinator - Out-of-Band Resolution & Account Lease Freezing', async (t) => {
  await t.test('freezes account and prevents new operational leases on UNKNOWN transaction', () => {
    const coordinator = new ReconciliationCoordinator();
    let eventFired = false;

    coordinator.on('accountFrozen', (record) => {
      eventFired = true;
      assert.strictEqual(record.accountId, 'acc_01');
      assert.strictEqual(record.operationId, 'op_bet_1');
    });

    coordinator.freezeAccount('acc_01', 'op_bet_1', 'idem_1', 'DOM_TIMEOUT');

    assert.strictEqual(eventFired, true);
    assert.strictEqual(coordinator.isAccountFrozen('acc_01'), true);
    assert.strictEqual(coordinator.isAccountFrozen('acc_02'), false);
    assert.strictEqual(coordinator.getFrozenAccounts().length, 1);
  });

  await t.test('enqueues uncertain operation and generates TACTICAL:RECONCILE_ORDER request', () => {
    const coordinator = new ReconciliationCoordinator();

    const task = coordinator.enqueueUncertainOperation({
      operationId: 'op_uncertain_1',
      accountId: 'acc_01',
      idempotencyKey: 'idem_u1',
      reason: 'PIPE_DISCONNECTED_DURING_SETTLEMENT',
      details: { stake: 500 }
    });

    assert.strictEqual(task.status, 'QUEUED');
    assert.strictEqual(coordinator.isAccountFrozen('acc_01'), true);

    const requestPayload = coordinator.createReconcileRequest('op_uncertain_1');
    assert.ok(requestPayload);
    assert.strictEqual(requestPayload.operationId, 'op_uncertain_1');
    assert.strictEqual(requestPayload.attempts, 1);
    assert.strictEqual(task.status, 'IN_PROGRESS');
  });

  await t.test('handles TACTICAL:RECONCILIATION_REPORT with RESOLVED_COMMITTED and unfreezes account', () => {
    const coordinator = new ReconciliationCoordinator();
    coordinator.enqueueUncertainOperation({
      operationId: 'op_to_resolve_1',
      accountId: 'acc_01',
      idempotencyKey: 'idem_r1'
    });

    assert.strictEqual(coordinator.isAccountFrozen('acc_01'), true);

    let resolvedEvent = null;
    coordinator.on('reconciliationResolved', (res) => {
      resolvedEvent = res;
    });

    const report = {
      operationId: 'op_to_resolve_1',
      resolutionStatus: /** @type {'RESOLVED_COMMITTED'} */ ('RESOLVED_COMMITTED'),
      platformOrder: { orderId: 'SP-99881', verifiedStake: 500 }
    };

    const outcome = coordinator.handleReconciliationReport(report);
    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.outcome, 'COMPLETED');
    assert.strictEqual(coordinator.isAccountFrozen('acc_01'), false);
    assert.ok(resolvedEvent);
    assert.strictEqual(resolvedEvent.outcome, 'COMPLETED');
  });

  await t.test('handles TACTICAL:RECONCILIATION_REPORT with RESOLVED_LOST and unfreezes account', () => {
    const coordinator = new ReconciliationCoordinator();
    coordinator.enqueueUncertainOperation({
      operationId: 'op_to_resolve_2',
      accountId: 'acc_02',
      idempotencyKey: 'idem_r2'
    });

    const outcome = coordinator.handleReconciliationReport({
      operationId: 'op_to_resolve_2',
      resolutionStatus: 'RESOLVED_LOST',
      platformOrder: null
    });

    assert.strictEqual(outcome.handled, true);
    assert.strictEqual(outcome.outcome, 'FAILED');
    assert.strictEqual(coordinator.isAccountFrozen('acc_02'), false);
  });

  await t.test('supports manualResolve operator override', () => {
    const coordinator = new ReconciliationCoordinator();
    coordinator.enqueueUncertainOperation({
      operationId: 'op_stuck',
      accountId: 'acc_03',
      idempotencyKey: 'idem_stuck'
    });

    assert.strictEqual(coordinator.isAccountFrozen('acc_03'), true);

    const manualRes = coordinator.manualResolve('op_stuck', 'COMPLETED', 'Verified via platform portal');
    assert.strictEqual(manualRes.outcome, 'COMPLETED');
    assert.strictEqual(manualRes.manual, true);
    assert.strictEqual(coordinator.isAccountFrozen('acc_03'), false);
    assert.strictEqual(coordinator.getPendingReconciliations().length, 0);
  });
});

// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyLedger } from '../../src/runtime-manager/boundary/idempotencyLedger.mjs';

test('IdempotencyLedger - Financial De-duplication & LRU Invariants', async (t) => {
  await t.test('initializes empty and returns NEW for unseen keys', () => {
    const ledger = new IdempotencyLedger();
    const result = ledger.check('idem_key_001');
    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.status, 'NEW');
  });

  await t.test('records IN_FLIGHT state and recognizes duplicate in-flight requests', () => {
    const ledger = new IdempotencyLedger();
    ledger.recordInFlight('idem_key_100', 'op_100', { stake: 250 });

    const check = ledger.check('idem_key_100');
    assert.strictEqual(check.exists, true);
    assert.strictEqual(check.status, 'IN_FLIGHT');
    assert.strictEqual(check.operationId, 'op_100');
  });

  await t.test('records terminal COMPLETED state and returns cached result on retry', () => {
    const ledger = new IdempotencyLedger();
    ledger.recordInFlight('idem_key_200', 'op_200');

    const terminalResult = {
      operationId: 'op_200',
      status: 'COMPLETED',
      stakePlaced: 500,
      receiptId: 'SP-9912'
    };
    ledger.recordTerminal('idem_key_200', 'COMPLETED', terminalResult);

    const check = ledger.check('idem_key_200');
    assert.strictEqual(check.exists, true);
    assert.strictEqual(check.status, 'COMPLETED');
    assert.deepStrictEqual(check.cachedResult, terminalResult);
  });

  await t.test('records terminal FAILED state', () => {
    const ledger = new IdempotencyLedger();
    ledger.recordInFlight('idem_key_300', 'op_300');
    ledger.recordTerminal('idem_key_300', 'FAILED', { error: 'Insufficient balance' });

    const check = ledger.check('idem_key_300');
    assert.strictEqual(check.exists, true);
    assert.strictEqual(check.status, 'FAILED');
  });

  await t.test('evicts entries older than maxAgeMs TTL', () => {
    const ledger = new IdempotencyLedger({ maxAgeMs: 50 }); // 50ms TTL
    ledger.recordInFlight('expiring_key', 'op_exp');

    // Initially present
    assert.strictEqual(ledger.check('expiring_key').exists, true);

    // After wait
    return new Promise((resolve) => {
      setTimeout(() => {
        const check = ledger.check('expiring_key');
        assert.strictEqual(check.exists, false);
        assert.strictEqual(check.status, 'NEW');
        resolve();
      }, 60);
    });
  });

  await t.test('enforces maxEntries capacity by evicting oldest LRU keys', () => {
    const ledger = new IdempotencyLedger({ maxEntries: 3 });
    ledger.recordInFlight('key1', 'op1');
    ledger.recordInFlight('key2', 'op2');
    ledger.recordInFlight('key3', 'op3');
    assert.strictEqual(ledger.size(), 3);

    // Adding 4th should evict key1
    ledger.recordInFlight('key4', 'op4');
    assert.strictEqual(ledger.size(), 3);
    assert.strictEqual(ledger.check('key1').exists, false);
    assert.strictEqual(ledger.check('key2').exists, true);
    assert.strictEqual(ledger.check('key4').exists, true);
  });
});

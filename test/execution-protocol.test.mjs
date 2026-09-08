// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import { 
  ExecutionMessageType, 
  createExecutionEnvelope, 
  validateExecutionEnvelope 
} from '../src/runtime-manager/executionProtocol.mjs';

test('Execution Protocol & Wire Contract Specification', async (t) => {
  await t.test('creates valid ExecutionEnvelope with ULID and defaults', () => {
    const envelope = createExecutionEnvelope(ExecutionMessageType.PLACE_BET, {
      operationId: 'op-01',
      stake: 500,
      odds: 1.85
    }, 'trace-abc');

    assert.ok(envelope.msgId, 'Must generate valid ULID msgId');
    assert.strictEqual(envelope.traceId, 'trace-abc');
    assert.strictEqual(envelope.type, ExecutionMessageType.PLACE_BET);
    assert.strictEqual(envelope.source, 'CONTROL_PLANE');
    assert.strictEqual(envelope.payload.stake, 500);
    assert.ok(envelope.timestamp > 0);

    const validation = validateExecutionEnvelope(envelope);
    assert.strictEqual(validation.valid, true);
  });

  await t.test('validates all canonical message types', () => {
    const requiredTypes = [
      ExecutionMessageType.INITIALIZE,
      ExecutionMessageType.START_CLUSTER,
      ExecutionMessageType.STOP_CLUSTER,
      ExecutionMessageType.PLACE_BET,
      ExecutionMessageType.CASH_OUT,
      ExecutionMessageType.VALIDATE,
      ExecutionMessageType.ACTIVATE_ACCOUNT,
      ExecutionMessageType.DEACTIVATE_ACCOUNT,
      ExecutionMessageType.SET_BET_CYCLE,
      ExecutionMessageType.UPDATE_POLICY,
      ExecutionMessageType.HEARTBEAT,
      ExecutionMessageType.STATE_CHANGED,
      ExecutionMessageType.BROWSER_STATUS,
      ExecutionMessageType.OPERATION_ACK,
      ExecutionMessageType.OPERATION_RESULT,
      ExecutionMessageType.ODDS_TICK,
      ExecutionMessageType.AUDIT_EVENT
    ];

    assert.strictEqual(requiredTypes.length, 17, 'Must have 17 canonical message types');

    for (const msgType of requiredTypes) {
      const env = createExecutionEnvelope(msgType, { sample: true });
      const res = validateExecutionEnvelope(env);
      assert.strictEqual(res.valid, true, `Message type ${msgType} must validate successfully`);
    }
  });

  await t.test('rejects malformed envelopes', () => {
    assert.strictEqual(validateExecutionEnvelope(null).valid, false);
    assert.strictEqual(validateExecutionEnvelope({}).valid, false);
    assert.strictEqual(validateExecutionEnvelope({ msgId: '123' }).valid, false);
    assert.strictEqual(validateExecutionEnvelope({
      msgId: '123',
      traceId: 'tr-1',
      type: 'INVALID',
      timestamp: Date.now(),
      source: 'UNKNOWN_SOURCE',
      payload: {}
    }).valid, false);
  });
});

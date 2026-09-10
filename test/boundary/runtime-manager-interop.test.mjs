// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { PipeTransport } from '../../src/runtime-manager/boundary/pipeTransport.mjs';
import { MockTransport } from './mock-transport.mjs';
import { ExecutionMessageType } from '../../src/runtime-manager/executionProtocol.mjs';

test('ExecutionBoundaryManager - RuntimeManager API Parity & Interoperability', async (t) => {
  const mockTransport = new MockTransport();
  const pipeTransport = new PipeTransport({ customAdapter: mockTransport });
  const mockSecurity = { isDegraded: () => false };
  const mockStore = {
    configContainer: { toSettingsIniObject: () => ({}) },
    accountsContainer: { getAll: () => [] }
  };

  const facade = new ExecutionBoundaryManager({
    transport: pipeTransport,
    securityAuthority: mockSecurity,
    stateStore: mockStore,
    defaultCommandTimeoutMs: 500
  });

  await t.test('has complete API method parity with RuntimeManager execution methods', () => {
    const requiredMethods = [
      'initialize',
      'initializeWorker',
      'startCluster',
      'stopCluster',
      'placeBet',
      'cashOut',
      'validateTactical',
      'activateAccount',
      'deactivateAccount',
      'setBetCycle',
      'updatePolicy',
      'sendEnvelope',
      'getEngineStatus',
      'getActiveBrowserCount',
      'isConnected'
    ];

    for (const methodName of requiredMethods) {
      assert.strictEqual(
        typeof facade[methodName],
        'function',
        `ExecutionBoundaryManager must expose method: ${methodName}`
      );
    }
  });

  await t.test('accepts string traceId arguments matching legacy RuntimeManager calling conventions', () => {
    facade.startServer();
    mockTransport.simulateClientConnect(1);

    // 1. initializeWorker(payload, traceIdString)
    mockTransport.clearSent();
    facade.initializeWorker({ settings: {} }, 'trace-init-legacy');
    let lastSent = mockTransport.getLastSentPayload();
    assert.strictEqual(lastSent.parsed.traceId, 'trace-init-legacy');
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.INITIALIZE);

    // 2. placeBet(payload, traceIdString)
    mockTransport.clearSent();
    facade.placeBet({ operationId: 'op_legacy_1', stake: 100 }, 'trace-bet-legacy');
    lastSent = mockTransport.getLastSentPayload();
    assert.strictEqual(lastSent.parsed.traceId, 'trace-bet-legacy');
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.PLACE_BET);

    // 3. setBetCycle(targetBrowserId, isEnabled, traceIdString)
    mockTransport.clearSent();
    facade.setBetCycle('slave_0', false, 'trace-cycle-legacy');
    lastSent = mockTransport.getLastSentPayload();
    assert.strictEqual(lastSent.parsed.traceId, 'trace-cycle-legacy');
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.SET_BET_CYCLE);
    assert.deepStrictEqual(lastSent.parsed.payload, { targetBrowserId: 'slave_0', isEnabled: false });

    // 4. updatePolicy(category, values, traceIdString)
    mockTransport.clearSent();
    facade.updatePolicy('Staking', { maxStake: 500 }, 'trace-policy-legacy');
    lastSent = mockTransport.getLastSentPayload();
    assert.strictEqual(lastSent.parsed.traceId, 'trace-policy-legacy');
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.UPDATE_POLICY);
    assert.deepStrictEqual(lastSent.parsed.payload, { category: 'Staking', values: { maxStake: 500 } });

    // 5. stopCluster(timeoutMs, traceIdString)
    mockTransport.clearSent();
    facade.stopCluster(3000, 'trace-stop-legacy');
    lastSent = mockTransport.getLastSentPayload();
    assert.strictEqual(lastSent.parsed.traceId, 'trace-stop-legacy');
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.STOP_CLUSTER);

    facade.stopServer();
  });
});

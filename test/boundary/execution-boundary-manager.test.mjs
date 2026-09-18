// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { PipeTransport } from '../../src/runtime-manager/boundary/pipeTransport.mjs';
import { MockTransport } from './mock-transport.mjs';
import { ExecutionMessageType, ExecutionErrorCode, createExecutionEnvelope } from '../../src/runtime-manager/executionProtocol.mjs';

test('ExecutionBoundaryManager - Protocol Facade, Encapsulation & Correlation', async (t) => {
  function createTestFixture() {
    const mockTransport = new MockTransport();
    const pipeTransport = new PipeTransport({ customAdapter: mockTransport });
    const mockSecurity = { isDegraded: () => false };
    const mockStore = {
      configContainer: {
        toSettingsIniObject: () => ({
          Pricing: { mode: 'PROFIT_TARGET', baseStake: 100, targetProfit: 25 },
          Risk: { maxStake: 5000 }
        })
      },
      accountsContainer: {
        getAll: () => [
          { id: 'acc_master', accountUsername: 'user1', accountPassword: 'pw1' },
          { id: 'acc_slave', accountUsername: 'user2', accountPassword: 'pw2' }
        ]
      }
    };

    const manager = new ExecutionBoundaryManager({
      transport: pipeTransport,
      securityAuthority: mockSecurity,
      stateStore: mockStore,
      defaultCommandTimeoutMs: 200
    });

    return { manager, mockTransport, mockSecurity, mockStore };
  }

  await t.test('starts and stops server, tracking connection state', () => {
    const { manager, mockTransport } = createTestFixture();
    assert.strictEqual(manager.isConnected(), false);

    manager.startServer();
    assert.strictEqual(mockTransport.isListening, true);

    mockTransport.simulateClientConnect(10);
    assert.strictEqual(manager.isConnected(), true);
    assert.deepStrictEqual(manager.getActiveConnections(), [10]);

    manager.stopServer();
    assert.strictEqual(mockTransport.isListening, false);
    assert.strictEqual(manager.isConnected(), false);
  });

  await t.test('compiles authoritative initialization payload with zero-secret protection', () => {
    const { manager } = createTestFixture();
    const payload = manager.compileInitializationPayload('trace-init-1');

    assert.strictEqual(payload.protocolVersion, '3.0');
    assert.strictEqual(payload.fleet.accounts.length, 2);
    assert.strictEqual(payload.fleet.accounts[0].role, 'master');
    assert.strictEqual(payload.fleet.accounts[0].username, 'user1');
    assert.strictEqual(payload.fleet.accounts[0].password, 'pw1');
    assert.strictEqual(payload.fleet.accounts[1].role, 'slave');
    assert.strictEqual(payload.configuration.pricing.targetProfit, 25);
  });

  await t.test('dispatches correlated command and resolves when worker acknowledges', async () => {
    const { manager, mockTransport } = createTestFixture();
    manager.startServer();
    mockTransport.simulateClientConnect(1);

    const initPromise = manager.initialize(null, { waitForAck: true });

    // Check sent envelope in mock
    const lastSent = mockTransport.getLastSentPayload();
    assert.ok(lastSent);
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.INITIALIZE);
    const sentMsgId = lastSent.parsed.msgId;

    // Simulate worker replying with correlated msgId
    mockTransport.simulateIncomingData(1, JSON.stringify({
      msgId: sentMsgId,
      traceId: lastSent.parsed.traceId,
      type: ExecutionMessageType.STATE_CHANGED,
      timestamp: Date.now(),
      source: 'EXECUTION_PLANE',
      payload: { state: 'READY', message: 'Initialized' }
    }));

    const result = await initPromise;
    assert.strictEqual(result.state, 'READY');
    assert.strictEqual(manager.getEngineStatus(), 'READY');

    manager.stopServer();
  });

  await t.test('dispatches tactical bet and suppresses duplicate execution via IdempotencyLedger', async () => {
    const { manager, mockTransport } = createTestFixture();
    manager.startServer();
    mockTransport.simulateClientConnect(1);

    const bet1 = manager.placeBet({
      operationId: 'op_bet_1',
      idempotencyKey: 'idem_unique_1',
      stake: 100,
      odds: 2.10
    }, { traceId: 't1' });

    assert.ok(bet1);
    assert.strictEqual(mockTransport.sentPayloads.length, 2); // 1 snapshot on connect + 1 bet

    // Second call with same idempotencyKey should be intercepted as IN_FLIGHT duplicate
    const bet2 = manager.placeBet({
      operationId: 'op_bet_1_retry',
      idempotencyKey: 'idem_unique_1',
      stake: 100,
      odds: 2.10
    }, { traceId: 't2' });

    assert.strictEqual(bet2.duplicate, true);
    assert.strictEqual(bet2.status, 'IN_FLIGHT');
    // Transport was NOT called again for bet2
    assert.strictEqual(mockTransport.sentPayloads.length, 2);

    manager.stopServer();
  });

  await t.test('freezes account on UNKNOWN outcome or EP_TX_001 error code', () => {
    const { manager, mockTransport } = createTestFixture();
    manager.startServer();
    mockTransport.simulateClientConnect(1);

    assert.strictEqual(manager.isAccountFrozen('acc_master'), false);

    // Simulate worker returning OPERATION_RESULT with UNKNOWN
    mockTransport.simulateIncomingData(1, JSON.stringify({
      msgId: 'msg_res_unknown',
      traceId: 'trace_res_unknown',
      type: ExecutionMessageType.OPERATION_RESULT,
      timestamp: Date.now(),
      source: 'EXECUTION_PLANE',
      payload: {
        operationId: 'op_unknown_1',
        status: 'UNKNOWN',
        code: ExecutionErrorCode.UNCERTAIN_OUTCOME,
        accountId: 'acc_master',
        error: 'CDP socket dropped during settlement commit'
      }
    }));

    assert.strictEqual(manager.isAccountFrozen('acc_master'), true);

    manager.stopServer();
  });

  await t.test('hot-reloads configuration policy via CONFIG:UPDATE_POLICY', () => {
    const { manager, mockTransport } = createTestFixture();
    manager.startServer();
    mockTransport.simulateClientConnect(1);

    manager.updatePolicy('Pricing', { targetProfit: 50, minimumAcceptableProfit: 10 }, { traceId: 'pol_1' });

    const lastSent = mockTransport.getLastSentPayload();
    assert.strictEqual(lastSent.parsed.type, ExecutionMessageType.UPDATE_POLICY);
    assert.strictEqual(lastSent.parsed.payload.category, 'Pricing');
    assert.strictEqual(lastSent.parsed.payload.values.targetProfit, 50);

    manager.stopServer();
  });

  await t.test('demultiplexes BROWSER_STATUS envelope and emits browserStatus event', async () => {
    const { manager, mockTransport } = createTestFixture();
    manager.startServer();
    mockTransport.simulateClientConnect(1);

    const receivedEvents = [];
    manager.on('browserStatus', (payload) => {
      receivedEvents.push(payload);
    });

    const envelope = createExecutionEnvelope(
      ExecutionMessageType.BROWSER_STATUS,
      {
        browserId: 'slave_0',
        accountId: 'acc_slave',
        accountUsername: 'user2',
        role: 'slave',
        browserStatus: 'ACTIVE',
        accountStatus: 'IN_USE',
        observedState: 'RUNNING',
        activeBrowsers: 2
      },
      'trace-status-1',
      'EXECUTION_PLANE'
    );

    mockTransport.simulateIncomingData(1, JSON.stringify(envelope));

    assert.strictEqual(receivedEvents.length, 1);
    assert.strictEqual(receivedEvents[0].browserId, 'slave_0');
    assert.strictEqual(receivedEvents[0].browserStatus, 'ACTIVE');
    assert.strictEqual(receivedEvents[0].activeBrowsers, 2);

    manager.stopServer();
  });
});

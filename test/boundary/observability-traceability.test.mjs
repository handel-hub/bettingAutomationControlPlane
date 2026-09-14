// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer } from '../../src/api-server/server.mjs';
import { commandRouter } from '../../src/command/commandRouter.mjs';
import { executionBoundaryManager } from '../../src/runtime-manager/boundary/executionBoundaryManager.mjs';
import { securityFacade } from '../../src/security-authority/facade.mjs';
import { registerDefaultCommandHandlers } from '../../src/index.mjs';
import { WebSocket } from 'ws';

test('Phase 18: Observability & Causal Traceability Invariants', async (t) => {
  // Mock security authorization to allow execution commands
  // @ts-ignore
  securityFacade.authorize = () => ({ status: 'OPERATIONAL' });
  // @ts-ignore
  securityFacade.isDegraded = () => false;

  registerDefaultCommandHandlers();

  const server = new ApiServer();
  const port = 8096;
  await server.listen(port, '127.0.0.1');

  t.after(async () => {
    await server.close();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/v1/events`;

  await t.test('propagates traceId from HTTP header through Command to ExecutionBoundary and WS delta', async () => {
    const customTraceId = `trace-e2e-${Date.now()}`;
    let capturedEnvelope = null;

    // Spy on dispatchEnvelope
    const originalDispatch = executionBoundaryManager.dispatchEnvelope.bind(executionBoundaryManager);
    executionBoundaryManager.dispatchEnvelope = (type, payload, options) => {
      capturedEnvelope = { type, payload, options };
      return true;
    };

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.on('open', resolve));

    const receivedDeltas = [];
    ws.on('message', (data) => {
      try {
        const env = JSON.parse(data.toString('utf8'));
        if (env.topic === 'automation:delta') {
          receivedDeltas.push(env);
        }
      } catch {}
    });

    try {
      const res = await fetch(`${baseUrl}/api/v1/automation/operations/place-bet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Id': customTraceId
        },
        body: JSON.stringify({
          marketId: 'mkt-trace-1',
          odds: 2.1,
          stake: 50,
          idempotencyKey: `idem_${customTraceId}`,
          accountId: 'acc_trace_1'
        })
      });

      assert.equal(res.status, 202);
      assert.equal(res.headers.get('x-trace-id'), customTraceId);

      // Verify execution envelope received the traceId
      assert.ok(capturedEnvelope, 'ExecutionBoundaryManager must have received dispatched envelope');
      assert.equal(capturedEnvelope.options?.traceId, customTraceId);

      // Give 200ms for WS delta propagation
      await new Promise((r) => setTimeout(r, 200));

      const matchingDelta = receivedDeltas.find(d => d.traceId === customTraceId);
      assert.ok(matchingDelta, 'WebSocket delta must carry the causal traceId');
      assert.ok(matchingDelta.correlationId, 'WebSocket delta must carry correlationId');
    } finally {
      executionBoundaryManager.dispatchEnvelope = originalDispatch;
      ws.terminate();
    }
  });

  await t.test('CommandRouter generates traceId if omitted and tracks ingress metrics', async () => {
    const metricsBefore = commandRouter.getIngressMetrics();

    let handledTraceId = null;
    commandRouter.register('System', 'TRACE_TEST', async (cmd) => {
      handledTraceId = cmd.traceId;
      return { ok: true };
    });

    const result = await commandRouter.route({
      category: 'System',
      type: 'TRACE_TEST',
      payload: {}
    });

    assert.equal(result.success, true);
    assert.ok(handledTraceId, 'CommandRouter must assign a traceId when none is provided');
    assert.ok(typeof handledTraceId === 'string' && handledTraceId.length > 5);

    const metricsAfter = commandRouter.getIngressMetrics();
    assert.equal(metricsAfter.received, metricsBefore.received + 1);
    assert.equal(metricsAfter.routed, metricsBefore.routed + 1);
  });
});

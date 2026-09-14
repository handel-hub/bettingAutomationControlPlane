// @ts-check
import { SecureIpcClient } from '../../src/runtime-manager/ipc-client.mjs';
import { ExecutionMessageType } from '../../src/runtime-manager/executionProtocol.mjs';

async function main() {
  const pipePath = process.env.CONTROL_PLANE_PIPE;
  if (!pipePath) {
    process.exit(1);
  }

  // 1. Read session key
  const sessionKey = await SecureIpcClient.readSessionKeyFromStdin();

  // 2. Connect and authenticate
  const client = new SecureIpcClient(pipePath);
  await client.connect(sessionKey);

  // 3. Start telemetry heartbeat
  client.startHeartbeat(1000, () => ({
    activeBrowsers: 1,
    engineStatus: 'READY'
  }));

  // 4. Ingress command handling
  client.on('envelope', async (envelope) => {
    const { type, payload, traceId } = envelope;

    switch (type) {
      case ExecutionMessageType.INITIALIZE: {
        client.sendEnvelope(ExecutionMessageType.STATE_CHANGED, {
          state: 'READY',
          message: 'Automation controller initialized'
        }, traceId);
        break;
      }

      case ExecutionMessageType.START_CLUSTER: {
        client.sendEnvelope(ExecutionMessageType.STATE_CHANGED, {
          state: 'RUNNING',
          message: 'Automation cluster started'
        }, traceId);
        break;
      }

      case ExecutionMessageType.PLACE_BET: {
        const { operationId } = payload;
        client.sendEnvelope(ExecutionMessageType.OPERATION_ACK, {
          operationId,
          status: 'IN_FLIGHT'
        }, traceId);

        // Simulate execution completion
        setTimeout(() => {
          client.sendEnvelope(ExecutionMessageType.OPERATION_RESULT, {
            operationId,
            status: 'SUCCESS',
            metrics: { cycles: 1 }
          }, traceId);
        }, 50);
        break;
      }

      case ExecutionMessageType.CASH_OUT: {
        const { operationId } = payload;
        client.sendEnvelope(ExecutionMessageType.OPERATION_ACK, {
          operationId,
          status: 'IN_FLIGHT'
        }, traceId);

        setTimeout(() => {
          client.sendEnvelope(ExecutionMessageType.OPERATION_RESULT, {
            operationId,
            status: 'SUCCESS',
            metrics: { cashedOut: true }
          }, traceId);
        }, 50);
        break;
      }

      case ExecutionMessageType.STOP_CLUSTER: {
        client.sendEnvelope(ExecutionMessageType.STATE_CHANGED, {
          state: 'STOPPED',
          message: 'Shutdown clean'
        }, traceId);
        setTimeout(() => {
          process.exit(0);
        }, 50);
        break;
      }
    }
  });
}

main().catch((err) => {
  console.error('[mock-worker error]:', err);
  process.exit(1);
});

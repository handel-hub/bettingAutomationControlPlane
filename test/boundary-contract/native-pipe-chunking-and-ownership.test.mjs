// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCore } from '../../src/security-authority/native/security-core.mjs';
import { ExecutionMessageType, createExecutionEnvelope } from '../../src/runtime-manager/executionProtocol.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Tier 5 Native Boundary Hardening: Named Pipe Chunking & Ownership (CAN-12 & CAN-13)', async (t) => {
  NativeCore.init();

  await t.test('CAN-13: Single-instance owner protection & safe server lifecycle', async () => {
    const pipePath = `\\\\.\\pipe\\acp_single_owner_test_${Date.now()}`;

    let connected = false;
    NativeCore.startSecurePipeServer(
      pipePath,
      () => { connected = true; },
      () => {},
      () => { connected = false; }
    );

    // Attempting to start a second server while running must be safely ignored/handled
    assert.doesNotThrow(() => {
      NativeCore.startSecurePipeServer(pipePath, () => {}, () => {}, () => {});
    });

    // Cleanly stop server
    NativeCore.stopSecurePipeServer();
    assert.equal(connected, false);
  });

  await t.test('CAN-12: Complete chunked transmission of large payload (>64KB) over Windows Named Pipe', async () => {
    const pipePath = `\\\\.\\pipe\\acp_chunked_test_${Date.now()}`;
    const workerScript = path.join(__dirname, '..', 'fixtures', 'test-worker.mjs');

    let clientConnected = false;
    let connectedConnId = null;
    let receivedEchoAck = null;

    NativeCore.startSecurePipeServer(
      pipePath,
      (connId) => {
        clientConnected = true;
        connectedConnId = connId;
      },
      (connId, data) => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'ECHO_ACK') {
            receivedEchoAck = parsed;
          }
        } catch {
          // ignore parse errors
        }
      },
      (connId) => {
        clientConnected = false;
      }
    );

    // Spawn authenticated worker child
    let childPid = null;
    childPid = NativeCore.spawnExecutionProcess(pipePath, () => {}, workerScript);
    assert.ok(childPid > 0, `Worker PID must be valid (> 0), got: ${childPid}`);

    try {
      // Wait for authentication and connection
      const connectDeadline = Date.now() + 8000;
      while (!clientConnected && Date.now() < connectDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(clientConnected, 'Worker must successfully authenticate and connect via native pipe');
      assert.ok(connectedConnId !== null);

      // Create a large payload (> 80KB to exceed standard 64KB Windows Named Pipe buffer)
      const dataLength = 85 * 1024; // 85KB
      const largeDataString = 'X'.repeat(dataLength);
      const jsonPayload = JSON.stringify({
        type: 'ECHO_LARGE',
        data: largeDataString
      });
      assert.ok(jsonPayload.length > 85000, `Payload must exceed 85KB, actual: ${jsonPayload.length}`);

      // Transmit large frame via writePipe
      const writeSuccess = NativeCore.writePipe(connectedConnId, jsonPayload);
      assert.equal(writeSuccess, true, 'Chunked writePipe must succeed for large frame');

      // Wait for worker response
      const ackDeadline = Date.now() + 8000;
      while (!receivedEchoAck && Date.now() < ackDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(receivedEchoAck, 'Worker must receive complete un-truncated frame and reply with ECHO_ACK');
      assert.equal(receivedEchoAck.type, 'ECHO_ACK');
      assert.equal(receivedEchoAck.length, dataLength, 'Received data length must exactly match sent length');

    } finally {
      // Clean up child and pipe server
      if (childPid) {
        NativeCore.terminateExecutionProcess(childPid);
      }
      NativeCore.stopSecurePipeServer();
    }
  });
});

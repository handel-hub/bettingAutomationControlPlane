// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Native Secure Pipe & Process Attestation (Phase 2)', async (t) => {
  NativeCore.init();

  const pipePath = '\\\\.\\pipe\\control_plane_test_attestation_' + Date.now();
  const workerScript = path.join(__dirname, 'fixtures', 'test-worker.mjs');

  await t.test('spawns child via NativeCore and performs mutual HMAC authentication', async () => {
    let clientConnected = false;
    let receivedHeartbeat = null;
    let connectedConnId = null;

    // 1. Start Secure Pipe Server in NativeCore
    NativeCore.startSecurePipeServer(
      pipePath,
      (connId) => {
        clientConnected = true;
        connectedConnId = connId;
      },
      (connId, data) => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'HEARTBEAT') {
            receivedHeartbeat = parsed;
          }
        } catch (e) {
          // parse error
        }
      },
      (connId) => {
        clientConnected = false;
      }
    );

    // 2. Spawn Child Process via NativeCore
    let exitedPid = null;
    const pid = NativeCore.spawnExecutionProcess(pipePath, (exitPid) => {
      exitedPid = exitPid;
    }, workerScript);

    assert.ok(pid > 0, `Spawned PID must be greater than 0, got: ${pid}`);

    // 3. Wait for client to authenticate and send heartbeat
    const start = Date.now();
    while (!receivedHeartbeat && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(clientConnected, 'Native pipe client must be authenticated and connected.');
    assert.ok(receivedHeartbeat, 'Must receive authenticated HEARTBEAT from worker child.');
    assert.strictEqual(receivedHeartbeat.pid, pid, 'Heartbeat PID must match spawned PID.');

    // 4. Test bidirectional messaging: write message to worker via NativeCore
    const writeOk = NativeCore.writePipe(connectedConnId, JSON.stringify({ type: 'ACK', status: 'OK' }));
    assert.strictEqual(writeOk, true, 'Server writePipe must succeed.');

    // 5. Terminate the child process via NativeCore
    const termOk = NativeCore.terminateExecutionProcess(pid);
    assert.strictEqual(termOk, true, 'terminateExecutionProcess must return true.');

    // 6. Stop pipe server
    NativeCore.stopSecurePipeServer();
  });
});

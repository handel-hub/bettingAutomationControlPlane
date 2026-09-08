// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeManager } from '../src/runtime-manager/runtime-manager.mjs';
import { ExecutionMessageType } from '../src/runtime-manager/executionProtocol.mjs';
import { operationTracker } from '../src/state/operationTracker.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';
import { executionAuthorization } from '../src/runtime-manager/execution-authorization.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('End-to-End Control Plane <-> Execution Plane Orchestration Contract', async (t) => {
  NativeCore.init();
  executionAuthorization.canStartAutomation = () => true;

  const workerScript = path.resolve(__dirname, 'fixtures', 'mock-orchestrated-worker.mjs');

  await t.test('spawns, initializes, routes tactical commands, updates policies, and cleanly shuts down', async () => {
    try {
      // 1. Spawning through RuntimeManager with OS security
      let exitedPid = null;
      runtimeManager.on('runtimeExited', (pid) => {
        exitedPid = pid;
      });

      const pid = runtimeManager.spawnRuntime(workerScript);
      assert.ok(pid > 0, `Worker process spawned with valid PID: ${pid}`);

      // Wait for connection
      const startConn = Date.now();
      while (runtimeManager.activeConnections.size === 0 && Date.now() - startConn < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(runtimeManager.activeConnections.size, 1, 'Named pipe client connected & authenticated');

      // 2. LIFECYCLE:INITIALIZE
      let readyStateReceived = false;
      runtimeManager.on('stateChanged', ({ state }) => {
        if (state === 'READY') {
          readyStateReceived = true;
        }
      });

      const initTrace = 'trace-init-' + Date.now();
      const initSent = runtimeManager.initializeWorker({
        settings: { Spawning: { max_accounts_to_spawn: '1' } },
        accounts: [{ username: '08107992381', password: 'pw' }],
        proxies: [],
        policy: { Staking: { baseStake: 100 } }
      }, initTrace);
      assert.ok(initSent, 'initializeWorker envelope sent to worker');

      const startReady = Date.now();
      while (!readyStateReceived && Date.now() - startReady < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(readyStateReceived, 'Worker sent LIFECYCLE:STATE_CHANGED (READY)');
      assert.strictEqual(runtimeManager.getEngineStatus(), 'READY');

      // 3. TACTICAL:PLACE_BET and OPERATION_ACK
      const { operationId: opId } = operationTracker.startOperation('PLACING_BET', { stake: 100 });
      assert.strictEqual(operationTracker.getOperation(opId)?.status, 'QUEUED');

      let ackReceived = false;
      const onEnvelope = (envelope) => {
        if (envelope.type === ExecutionMessageType.OPERATION_ACK && envelope.payload?.operationId === opId) {
          ackReceived = true;
        }
      };
      runtimeManager.on('envelope', onEnvelope);

      const betSent = runtimeManager.placeBet({
        operationId: opId,
        stake: 100,
        odds: 1.75
      }, 'trace-bet-1');
      assert.ok(betSent, 'placeBet envelope sent');

      const startAck = Date.now();
      while (!ackReceived && Date.now() - startAck < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ackReceived, 'Worker sent TACTICAL:OPERATION_ACK for bet operation');
      const opStatus = operationTracker.getOperation(opId)?.status;
      assert.ok(opStatus === 'IN_FLIGHT' || opStatus === 'COMPLETED', `Operation status must be IN_FLIGHT or COMPLETED, got ${opStatus}`);

      // 4. FLEET:SET_BET_CYCLE
      const setCycleSent = runtimeManager.setBetCycle('slave_0', false, 'trace-cycle-1');
      assert.ok(setCycleSent, 'setBetCycle envelope sent');

      // 5. CONFIG:UPDATE_POLICY
      const updatePolicySent = runtimeManager.updatePolicy('Staking', { maxStake: 500 }, 'trace-pol-1');
      assert.ok(updatePolicySent, 'updatePolicy envelope sent');

      // 6. Stop cluster gracefully
      let stoppedReceived = false;
      runtimeManager.on('stateChanged', ({ state }) => {
        if (state === 'STOPPED') {
          stoppedReceived = true;
        }
      });

      const stopSent = runtimeManager.stopCluster(3000, 'trace-stop-1');
      assert.ok(stopSent, 'stopCluster envelope sent');

      const startStop = Date.now();
      while (!stoppedReceived && Date.now() - startStop < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(stoppedReceived, 'Worker sent LIFECYCLE:STATE_CHANGED (STOPPED)');

      // 7. Cleanup
      runtimeManager.off('envelope', onEnvelope);
      runtimeManager.terminateRuntime(pid);
      NativeCore.stopSecurePipeServer();
    } catch (err) {
      console.error('=== E2E TEST CAUGHT ERROR ===:', err);
      throw err;
    }
  });
});

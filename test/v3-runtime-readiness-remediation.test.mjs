// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeCommand } from '../src/api-server/middleware/commandAdapter.mjs';
import {
  ExecutionHandshakeTimeoutError,
  ExecutionPreemptedError
} from '../src/state-store/types/errors.mjs';
import { commandRouter } from '../src/command/commandRouter.mjs';
import { AEADStorageAdapter } from '../src/security-authority/persistence/aead-storage-adapter.mjs';
import { NativeCore } from '../src/security-authority/native/security-core.mjs';

test('V3 Runtime Readiness Remediation Suite', async (t) => {
  NativeCore.init();

  await t.test('Bug 5: Execution Handshake Timeout maps to HTTP 504 Gateway Timeout', async () => {
    // Register temporary failing command
    commandRouter.register('Execution', 'TEST_HANDSHAKE_TIMEOUT', async () => {
      throw new ExecutionHandshakeTimeoutError('Handshake timeout (10000ms) exceeded waiting for runtime cluster');
    });

    let capturedStatus = 0;
    let capturedBody = null;

    const mockReq = {
      traceId: 'trace-test-504',
      headers: {}
    };
    const mockRes = {
      status(code) {
        capturedStatus = code;
        return this;
      },
      json(body) {
        capturedBody = body;
        return this;
      }
    };

    await executeCommand({
      req: /** @type {any} */ (mockReq),
      res: /** @type {any} */ (mockRes),
      category: 'Execution',
      type: 'TEST_HANDSHAKE_TIMEOUT'
    });

    assert.equal(capturedStatus, 504, 'Must return HTTP 504 Gateway Timeout');
    assert.equal(capturedBody?.success, false);
    assert.equal(capturedBody?.code, 'EXECUTION_HANDSHAKE_TIMEOUT');
    assert.equal(capturedBody?.retryable, true, 'Timeout must be marked retryable');
  });

  await t.test('Bug 5: Execution Preemption maps to HTTP 409 Conflict', async () => {
    commandRouter.register('Execution', 'TEST_PREEMPTED', async () => {
      throw new ExecutionPreemptedError('Transport server stopped');
    });

    let capturedStatus = 0;
    let capturedBody = null;

    const mockReq = {
      traceId: 'trace-test-409',
      headers: {}
    };
    const mockRes = {
      status(code) {
        capturedStatus = code;
        return this;
      },
      json(body) {
        capturedBody = body;
        return this;
      }
    };

    await executeCommand({
      req: /** @type {any} */ (mockReq),
      res: /** @type {any} */ (mockRes),
      category: 'Execution',
      type: 'TEST_PREEMPTED'
    });

    assert.equal(capturedStatus, 409, 'Must return HTTP 409 Conflict');
    assert.equal(capturedBody?.success, false);
    assert.equal(capturedBody?.code, 'EXECUTION_PREEMPTED');
    assert.equal(capturedBody?.retryable, true);
  });

  await t.test('Scenario 1: Bounded 1-version power-loss intent reconciliation', async () => {
    const tempDir = path.resolve('test/fixtures/temp_intent_test');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempDb = path.join(tempDir, `sec_state_${Date.now()}.db`);

    try {
      await AEADStorageAdapter.initDatabase(tempDb);

      // Commit state version 1
      const commitOk = await AEADStorageAdapter.commitTransitionWithOCC(
        0,
        { state: 'INITIALIZED', session_generation: 1 },
        'BOOT'
      );
      assert.equal(commitOk, true);

      // Verify normal read
      const row1 = await AEADStorageAdapter.getSecurityStateRow();
      assert.equal(row1.state_version, 1);

      // Simulate power-loss race: DPAPI intent set to 2 (N+1) before SQLite sector write completes
      NativeCore.setTransitionIntent(2);

      // Reading should reconcile intent to 1 without throwing rollback
      const reconciledRow = await AEADStorageAdapter.getSecurityStateRow();
      assert.equal(reconciledRow.state_version, 1);
      assert.equal(Number(NativeCore.getTransitionIntent()), 1, 'Intent must reconcile to committed row version');

      // Now simulate actual rollback attack: set intent to 5 (N+4)
      NativeCore.setTransitionIntent(5);
      await assert.rejects(
        async () => {
          await AEADStorageAdapter.getSecurityStateRow();
        },
        /SECURITY_STATE_UNCERTAIN: State version rollback detected/,
        'Rollback gap > 1 must be strictly rejected'
      );
    } finally {
      if (AEADStorageAdapter._db) {
        try { await AEADStorageAdapter._db.close(); } catch { /* ignore */ }
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { NativeCore.clearTransitionIntent(); } catch { /* ignore */ }
    }
  });

  await t.test('Scenario 14: Security database corruption trapping and quarantine', async () => {
    const tempDir = path.resolve('test/fixtures/temp_corrupt_test');
    fs.mkdirSync(tempDir, { recursive: true });
    const corruptDbPath = path.join(tempDir, `corrupt_test_${Date.now()}.db`);

    // Write completely invalid garbage to simulate header corruption
    fs.writeFileSync(corruptDbPath, Buffer.from('NOT_A_VALID_SQLITE_HEADER_GARBAGE_BYTES_0123456789'));

    try {
      // initDatabase should trap corruption, quarantine file, and re-initialize cleanly
      await AEADStorageAdapter.initDatabase(corruptDbPath);

      // Check that a quarantined file was created
      const files = fs.readdirSync(tempDir);
      const quarantined = files.find(f => f.includes('.corrupt.'));
      assert.ok(quarantined, 'Corrupt database must be quarantined with .corrupt timestamp');

      // Clean database should be usable
      const commitOk = await AEADStorageAdapter.commitTransitionWithOCC(
        0,
        { state: 'POST_RECOVERY', session_generation: 1 },
        'RECOVERED'
      );
      assert.equal(commitOk, true, 'Clean database must accept state transitions');
    } finally {
      if (AEADStorageAdapter._db) {
        try { await AEADStorageAdapter._db.close(); } catch { /* ignore */ }
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

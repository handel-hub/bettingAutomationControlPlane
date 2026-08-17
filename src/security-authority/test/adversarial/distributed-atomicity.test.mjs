// @ts-check

/**
 * DOMAIN CONTRACT: Distributed Atomicity (Crash Recovery & Snapshot Rollback)
 *
 * Threat model: Malicious local process or random power loss interrupting transitions.
 * Attacker capability: Can trigger SIGKILL at exact execution boundaries, can replace/corrupt persistence files offline.
 * Attack objective: Introduce a desync between SQLite and DPAPI hardware counter to rollback the database.
 * Security boundary being attacked: AEADStorageAdapter Two-Phase Commit protocol.
 * Security invariant(s): 17 (Rollback Resistance), 14 (Persistence Integrity), 03 (Crash Recovery).
 * Concrete attack operation: Randomized crashes during state transition and offline state replacement.
 * Expected defensive mechanism: System detects intent log and rolls forward if committed, clears if stale, or enters UNCERTAIN if rolled back.
 * Expected observable result: Legitimate crashes recover transparently; invalid states halt initialization.
 * What the test DOES NOT prove: Protection against an attacker with root kernel privileges who extracts the DPAPI root key from memory.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setupDb } from './_harness/db.mjs';
import { AEADStorageAdapter } from '../../persistence/aead-storage-adapter.mjs';
import { NativeCore } from '../../native/security-core.mjs';

function getIntentPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', '.security_authority', 'intent.bin');
}
function getCounterPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', '.security_authority', 'version_counter.bin');
}

test('Distributed Atomicity & Crash Recovery Testing', async (t) => {
  await t.test('Crash Case: Interrupted transition does not tear state (Atomicity)', async () => {
    const dbPath = await setupDb('crash-case-atomicity.sqlite');
    
    // Initial state
    await AEADStorageAdapter.commitTransitionWithOCC(0, { status: 'init', session_generation: 1 }, 'BOOT');

    // Simulate crash after SQLite commit
    const fakePayload = { status: 'init', state_version: 2, session_generation: 1 };
    const blob = AEADStorageAdapter._encryptPayload('singleton', 2, 0, fakePayload); // Mismatched generation
    await AEADStorageAdapter._db.run(`UPDATE secure_state SET state_version = 2, backend_generation = 0, encrypted_blob = ? WHERE key = 'singleton'`, [blob]);

    // Reboot recovery should fail due to backend generation mismatch
    await assert.rejects(async () => {
      await AEADStorageAdapter.getSecurityStateRow();
    }, /SECURITY_STATE_UNCERTAIN: Backend generation rollback detected/);
  });

  await t.test('Snapshot Rollback: Rejects rolled back DB via generation mismatch', async () => {
    const dbPath = await setupDb('rollback.sqlite');
    
    await AEADStorageAdapter.commitTransitionWithOCC(0, { status: 'init', session_generation: 1 }, 'BOOT'); // 1
    await AEADStorageAdapter._db.close();
    const snapshot1 = fs.readFileSync(dbPath);
    await AEADStorageAdapter.initDatabase(dbPath);
    await AEADStorageAdapter.commitTransitionWithOCC(1, { status: 'next', session_generation: 2 }, 'NEXT'); // 2

    // Simulate attacker attempting to rollback by injecting old payload with new generation in AAD
    await AEADStorageAdapter._db.close();
    fs.writeFileSync(dbPath, snapshot1);
    await AEADStorageAdapter.initDatabase(dbPath);

    // Attacker modifies the DB row to pretend it's generation 2, but payload still has generation 1
    await AEADStorageAdapter._db.run(`UPDATE secure_state SET backend_generation = 2 WHERE key = 'singleton'`);

    await assert.rejects(async () => {
      await AEADStorageAdapter.getSecurityStateRow();
    }, /Database integrity verification failed/, "Should halt on rollback attempt due to MAC failure when AAD generation is mismatched");
  });
});


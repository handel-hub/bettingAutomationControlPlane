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

  await t.test('Crash Case B: Recovers when crashed after SQLite commit but before DPAPI counter', async () => {
    const dbPath = await setupDb('crash-case-b.sqlite');
    
    // Initial state
    await AEADStorageAdapter.commitTransitionWithOCC(0, { status: 'init' }, 'BOOT');
    assert.strictEqual(NativeCore.getMonotonicCounter(), 1);

    // Simulate crash after SQLite commit
    NativeCore.setTransitionIntent(2);
    const fakePayload = { status: 'init', state_version: 2 };
    const blob = AEADStorageAdapter._encryptPayload('singleton', 2, fakePayload);
    await AEADStorageAdapter._db.run(`UPDATE secure_state SET state_version = 2, encrypted_blob = ? WHERE key = 'singleton'`, [blob]);
    // CRASH OCCURS HERE! (Counter remains 1)

    // Reboot recovery
    await assert.doesNotReject(async () => {
      const row = await AEADStorageAdapter.getSecurityStateRow();
      assert.strictEqual(row.status, 'init'); // Note: Since the payload was manually faked with UPDATE, the state data remains 'init' but version is 2
    }, "Should transparently recover by rolling forward counter");

    assert.strictEqual(NativeCore.getMonotonicCounter(), 2, "Counter should be rolled forward");
    assert.strictEqual(fs.existsSync(getIntentPath()), false, "Intent should be cleared");
  });

  await t.test('Crash Case A: Clears intent if crashed before SQLite commit', async () => {
    const dbPath = await setupDb('crash-case-a.sqlite');
    
    await AEADStorageAdapter.commitTransitionWithOCC(0, { status: 'init' }, 'BOOT');
    assert.strictEqual(NativeCore.getMonotonicCounter(), 1);

    // Simulate crash after Intent write
    NativeCore.setTransitionIntent(2);
    // CRASH OCCURS HERE! (SQLite remains 1)

    // Reboot recovery
    await assert.doesNotReject(async () => {
      await AEADStorageAdapter.getSecurityStateRow();
    }, "Should clear stale intent and boot normally");

    assert.strictEqual(NativeCore.getMonotonicCounter(), 1, "Counter should remain 1");
    assert.strictEqual(fs.existsSync(getIntentPath()), false, "Intent should be cleared");
  });

  await t.test('Snapshot Rollback (Case H): Rejects older DB without intent', async () => {
    const dbPath = await setupDb('rollback.sqlite');
    
    await AEADStorageAdapter.commitTransitionWithOCC(0, { status: 'init' }, 'BOOT'); // 1
    await AEADStorageAdapter._db.close();
    const snapshot1 = fs.readFileSync(dbPath);
    await AEADStorageAdapter.initDatabase(dbPath);
    await AEADStorageAdapter.commitTransitionWithOCC(1, { status: 'next' }, 'NEXT'); // 2

    // Restore snapshot 1
    await AEADStorageAdapter._db.close();
    fs.writeFileSync(dbPath, snapshot1);
    await AEADStorageAdapter.initDatabase(dbPath);

    await assert.rejects(async () => {
      await AEADStorageAdapter.getSecurityStateRow();
    }, /SECURITY_STATE_UNCERTAIN: Database rollback detected/, "Should halt on rollback");
  });

  await t.test('Malicious Intent (Case J/L): Rejects DB rollback even if intent is forged', async () => {
    const dbPath = await setupDb('malicious-intent.sqlite');
    
    await AEADStorageAdapter.commitTransitionWithOCC(0, { status: 'init' }, 'BOOT'); // 1
    await AEADStorageAdapter._db.close();
    const snapshot1 = fs.readFileSync(dbPath);
    await AEADStorageAdapter.initDatabase(dbPath);
    await AEADStorageAdapter.commitTransitionWithOCC(1, { status: 'next' }, 'NEXT'); // 2

    // Restore snapshot 1 and inject fake intent claiming a transition to 1
    await AEADStorageAdapter._db.close();
    fs.writeFileSync(dbPath, snapshot1);
    await AEADStorageAdapter.initDatabase(dbPath);
    NativeCore.setTransitionIntent(1);

    // Reboot (Counter is 2, DB is 1, Intent is 1)
    await assert.rejects(async () => {
      await AEADStorageAdapter.getSecurityStateRow();
    }, /SECURITY_STATE_UNCERTAIN: Database rollback detected/, "Intent shouldn't bypass counter strict equality check");
  });

});

// @ts-check

/**
 * DOMAIN CONTRACT: Machine Identity
 *
 * Threat model: Control Plane is migrated to an unauthorized virtual machine or hardware host.
 * Attacker capability: Can clone the disk image, including the SQLite DB and file system.
 * Attack objective: Extract and run the authenticated authority on an attacker-controlled machine.
 * Security boundary being attacked: OS Secret Store (DPAPI) and NativeCore initialization.
 * Security invariant(s): 04 - Hardware Root.
 * Concrete attack operation: Attempting to boot the system with an invalid, foreign, or corrupted DPAPI root key.
 * Expected defensive mechanism: CryptUnprotectData fails, NativeCore fails to extract the root key, and `verifyMachineIdentitySync` returns false. The engine fails the BOOTSTRAP_COMPLETE transition.
 * Expected observable result: Transition fails with "Guard failed"; system remains stuck in INITIALIZING.
 * What the test DOES NOT prove: Does not prove that DPAPI cannot be bypassed by an advanced persistent threat extracting DPAPI master keys from LSASS.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeTransition } from '../../state-machine/engine.mjs';
import { TransitionEvent } from '../../state-machine/transitions.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { NativeCore } from '../../native/security-core.mjs';
import { setupDb } from './_harness/db.mjs';

test('Machine Identity Testing', async (t) => {
  await t.test('Native DPAPI boundary rejects corrupted or foreign root keys', async () => {
    // 1. Initialize native core so a valid key is generated
    NativeCore.init();

    // 2. Locate the key path
    const configDir = process.platform === 'win32' 
      ? path.join(process.env.APPDATA || '', '.security_authority')
      : path.join(os.homedir(), '.config', '.security_authority');
    const keyPath = path.join(configDir, 'root_key.bin');

    assert.strictEqual(fs.existsSync(keyPath), true, 'root_key.bin must be created by native core');
    
    // Backup the valid key
    const backupPath = keyPath + '.bak';
    fs.copyFileSync(keyPath, backupPath);

    // 3. Setup a fresh DB
    const dbPath = './test/databases/test-machine-identity-native.db';
    await setupDb(dbPath);

    const initialState = {
      state: SecurityState.INITIALIZING,
      state_version: 0
    };
    await StorageAdapter.commitTransitionWithOCC(0, initialState, 'SYSTEM_BOOT');
    const stateRow = await StorageAdapter.getSecurityStateRow();

    // 4. Corrupt the DPAPI blob (simulating a migration to a new machine where unprotect fails,
    // or an attacker supplying a fake blob)
    const validBlob = fs.readFileSync(keyPath);
    const corruptedBlob = Buffer.from(validBlob);
    corruptedBlob[corruptedBlob.length - 1] ^= 0xFF; // flip bits in the DPAPI payload
    fs.writeFileSync(keyPath, corruptedBlob);

    try {
      // 5. Verify the hardware identity check synchronously
      const isIdentityValid = NativeCore.verifyMachineIdentitySync();
      assert.strictEqual(isIdentityValid, false, 'NativeCore MUST return false for corrupted/foreign DPAPI blob');

      // 6. Demonstrate that the State Machine fails to bootstrap
      let transitionThrew = false;
      try {
        // @ts-ignore
        await executeTransition(stateRow, TransitionEvent.BOOTSTRAP_COMPLETE, {
            integrityVerified: true, 
            storageVerified: true,
            machineIdentityVerified: isIdentityValid 
          }, () => [], () => false);
      } catch (err) {
        transitionThrew = true;
        assert.match(err.message, /Database integrity verification failed/);
      }
        
      assert.strictEqual(transitionThrew, true, 'DecisionEngine MUST reject bootstrap by failing closed if identity is invalid');

    } finally {
      // Restore valid key so other tests don't break
      fs.copyFileSync(backupPath, keyPath);
      fs.unlinkSync(backupPath);
    }
  });
});

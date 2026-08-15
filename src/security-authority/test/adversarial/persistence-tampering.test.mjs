// @ts-check

/**
 * DOMAIN CONTRACT: Persistence Tampering
 *
 * Threat model: Local process or user with disk access modifies the SQLite persistence layer.
 * Attacker capability: Full local read/write access to the `.db` files while the process is stopped or running.
 * Attack objective: Corrupt or escalate local authority by injecting data or rolling back state versions.
 * Security boundary being attacked: AEADStorageAdapter (AES-GCM encryption/authentication boundary).
 * Security invariant(s): 05 - Tamper-Evident, 09 - Persistence Integrity.
 * Concrete attack operation: Bit-flipping the MAC tag or modifying the plaintext `state_version` AAD.
 * Expected defensive mechanism: The AES-GCM decryption synchronously fails authentication, halting the read.
 * Expected observable result: The StorageAdapter throws an integrity verification failure, converting to SECURITY_STATE_UNCERTAIN.
 * What the test DOES NOT prove: Does not prove protection against complete database deletion or offline cloning.
 */

import test from 'node:test';
import assert from 'node:assert';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { StorageAdapter } from '../../persistence/storage-adapter.mjs';
import { SecurityState } from '../../state-machine/states.mjs';
import { setupDb, getAbsoluteDbPath } from './_harness/db.mjs';

test('Persistence & Integrity Testing', async (t) => {
  await t.test('MAC validation failure on corrupted blob halts engine', async () => {
    const dbPath = './test/databases/test-integrity-blob.db';
    const absolutePath = await setupDb(dbPath);

    // Commit an initial valid state
    const nextState = {
      state: SecurityState.OPERATIONAL,
      state_version: 0,
      session: { status: 'AUTHENTICATED' },
      authorization: { status: 'VALID', capability_set: ['test'] },
      license: { status: 'VALID' },
      machine: { status: 'VERIFIED' }
    };
    await StorageAdapter.commitTransitionWithOCC(0, nextState, 'TEST_EVENT');

    // Read the db and corrupt it
    const db = await open({ filename: absolutePath, driver: sqlite3.Database });
    const row = await db.get(`SELECT encrypted_blob FROM secure_state WHERE key = 'singleton'`);
    
    // Flip a bit in the encrypted blob
    const corruptedBlob = Buffer.from(row.encrypted_blob);
    corruptedBlob[corruptedBlob.length - 1] ^= 0x01; // flip last byte (Auth tag)

    await db.run(`UPDATE secure_state SET encrypted_blob = ? WHERE key = 'singleton'`, [corruptedBlob]);
    await db.close();

    // Now try to read using StorageAdapter
    await assert.rejects(
      async () => {
        await StorageAdapter.getSecurityStateRow();
      },
      /SECURITY_STATE_UNCERTAIN: Database integrity verification failed/,
      'Should throw an integrity error on corrupted MAC'
    );
  });

  await t.test('AAD validation failure on modified state_version halts engine', async () => {
    const dbPath = './test/databases/test-integrity-aad.db';
    const absolutePath = await setupDb(dbPath);

    const nextState = {
      state: SecurityState.OPERATIONAL,
      state_version: 0,
      session: { status: 'AUTHENTICATED' },
      authorization: { status: 'VALID', capability_set: ['test'] },
      license: { status: 'VALID' },
      machine: { status: 'VERIFIED' }
    };
    await StorageAdapter.commitTransitionWithOCC(0, nextState, 'TEST_EVENT');

    // Read the db and corrupt state_version ONLY
    const db = await open({ filename: absolutePath, driver: sqlite3.Database });
    
    // Change state_version from 1 to 2
    await db.run(`UPDATE secure_state SET state_version = ? WHERE key = 'singleton'`, [2]);
    await db.close();

    // Now try to read using StorageAdapter
    await assert.rejects(
      async () => {
        await StorageAdapter.getSecurityStateRow();
      },
      /SECURITY_STATE_UNCERTAIN: Database integrity verification failed/,
      'Should throw an integrity error due to AAD mismatch'
    );
  });
});

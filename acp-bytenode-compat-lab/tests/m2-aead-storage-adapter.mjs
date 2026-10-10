// acp-bytenode-compat-lab/tests/m2-aead-storage-adapter.mjs
// M2: AEAD-Authenticated SQLite Storage Adapter compatibility tests

import fs from 'node:fs';
import path from 'node:path';
import { AEADStorageAdapter } from '../../src/security-authority/persistence/aead-storage-adapter.mjs';

export function registerM2Tests(harness) {
  const tmpDir = path.resolve(process.cwd(), '.tmp-compat-lab');
  const dbPath = path.join(tmpDir, 'm2-security-aead.db');

  harness.test('M2-001', 'AEADStorageAdapter database init & migration', 'M2-AEADStorage', async () => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    await AEADStorageAdapter.initDatabase(dbPath);
    if (!AEADStorageAdapter._db) throw new Error('Database instance was not initialized');
    return { initialized: true };
  });

  harness.test('M2-002', 'AEADStorageAdapter encrypted state save & read', 'M2-AEADStorage', async () => {
    const testState = {
      sessionId: 'sess_test_123',
      capabilities: ['EXEC_ALL', 'READ_WAL'],
      timestamp: Date.now(),
      session_generation: 0,
    };

    const committed = await AEADStorageAdapter.commitTransitionWithOCC(0, testState, 'INIT');
    if (!committed) throw new Error('commitTransitionWithOCC failed at version 0');

    const retrieved = await AEADStorageAdapter.getSecurityStateRow();

    if (!retrieved || retrieved.sessionId !== testState.sessionId) {
      throw new Error(`State mismatch: expected ${testState.sessionId}, got ${retrieved?.sessionId}`);
    }

    return { saved: true, sessionId: retrieved.sessionId, version: retrieved.state_version };
  });

  harness.test('M2-003', 'AEADStorageAdapter nonce tracking & replay check', 'M2-AEADStorage', async () => {
    const nonce = `nonce_${Date.now()}_abc`;
    const seenBefore = (await AEADStorageAdapter.loadSeenNonces()).includes(nonce);
    await AEADStorageAdapter.saveNonce(nonce);
    const seenAfter = (await AEADStorageAdapter.loadSeenNonces()).includes(nonce);

    if (seenBefore !== false || seenAfter !== true) {
      throw new Error(`Nonce check failed: before=${seenBefore}, after=${seenAfter}`);
    }

    return { nonceRegistered: true };
  });

  harness.test('M2-004', 'AEADStorageAdapter tampering MAC verification error', 'M2-AEADStorage', async () => {
    // Manually corrupt the encrypted blob in SQLite table
    await AEADStorageAdapter._db.run(`
      UPDATE secure_state 
      SET encrypted_blob = X'00112233445566778899AABBCCDDEEFF' 
      WHERE key = 'singleton'
    `);

    let threw = false;
    try {
      await AEADStorageAdapter.getSecurityStateRow();
    } catch (_) {
      threw = true;
    }

    if (!threw) {
      throw new Error('Expected MAC verification error on corrupted blob, but query succeeded!');
    }

    if (AEADStorageAdapter._db) {
      await AEADStorageAdapter._db.close();
      AEADStorageAdapter._db = null;
    }

    return { tamperDetected: true };
  });
}

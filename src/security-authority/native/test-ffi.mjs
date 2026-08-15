// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import { NativeCore } from './security-core.mjs';

test('Native FFI Bindings Testing', async (t) => {
  await t.test('NativeCore Initialization and Encryption (DPAPI bound)', async () => {
    // init() internally verifies/generates the OS-bound secret using DPAPI
    NativeCore.init();
    
    const plaintext = Buffer.from('Ultra Secret Boot Material');
    const aad = Buffer.from('version-0');
    
    // Encrypt the secret
    const ciphertext = NativeCore.encryptAead(plaintext, aad);
    
    assert.ok(Buffer.isBuffer(ciphertext), 'Ciphertext should be a buffer');
    assert.notStrictEqual(ciphertext.toString('hex'), plaintext.toString('hex'), 'Ciphertext should differ from plaintext');
    
    // Decrypt the secret
    const decrypted = NativeCore.decryptAead(ciphertext, aad);
    
    assert.ok(Buffer.isBuffer(decrypted), 'Decrypted output should be a buffer');
    assert.strictEqual(decrypted.toString('utf8'), plaintext.toString('utf8'), 'Decrypted text must match original plaintext');
  });

  await t.test('Synchronous Revocation Gating', async () => {
    // Initial state
    NativeCore.setRevokedSync(false);
    assert.strictEqual(NativeCore.isRevokedSync(), false, 'Should not be revoked initially');

    // Trigger revocation
    NativeCore.setRevokedSync(true);
    assert.strictEqual(NativeCore.isRevokedSync(), true, 'Should be revoked natively');

    // Reset for other tests
    NativeCore.setRevokedSync(false);
  });

  await t.test('GetNamedPipeClientProcessId requires valid connId', async () => {
    // We pass an invalid connId
    assert.throws(() => {
      NativeCore.getNamedPipeClientProcessId(99999);
    }, /Unknown connection ID/);
  });
});

// acp-bytenode-compat-lab/tests/m3-native-security-core.mjs
// M3: Rust N-API NativeCore Addon compatibility tests

import crypto from 'node:crypto';
import { NativeCore } from '../../src/security-authority/native/security-core.mjs';

export function registerM3Tests(harness) {
  harness.test('M3-001', 'NativeCore initialization & machine identity check', 'M3-NativeCore', async () => {
    NativeCore.init();
    const verified = NativeCore.verifyMachineIdentitySync();
    if (typeof verified !== 'boolean') {
      throw new Error(`Expected boolean from verifyMachineIdentitySync, got ${typeof verified}`);
    }
    return { initialized: true, verified };
  });

  harness.test('M3-002', 'NativeCore raw AES-256-GCM AEAD encryption roundtrip', 'M3-NativeCore', async () => {
    const key = crypto.randomBytes(32);
    const plaintext = Buffer.from('control_plane_payload_secret_123');
    const ciphertext = NativeCore.rawEncryptAead(key, plaintext);
    const decrypted = NativeCore.rawDecryptAead(key, ciphertext);

    if (decrypted.toString('utf8') !== plaintext.toString('utf8')) {
      throw new Error('Raw AEAD roundtrip payload mismatch');
    }
    return { roundtripVerified: true, cipherLength: ciphertext.length };
  });

  harness.test('M3-003', 'NativeCore hardware-bound AEAD encrypt/decrypt with AAD', 'M3-NativeCore', async () => {
    const plaintext = Buffer.from('persisted_account_token');
    const aad = Buffer.from('metadata_v1_account_01');
    const ciphertext = NativeCore.encryptAead(plaintext, aad);
    const decrypted = NativeCore.decryptAead(ciphertext, aad);

    if (decrypted.toString('utf8') !== plaintext.toString('utf8')) {
      throw new Error('Hardware-bound AEAD roundtrip payload mismatch');
    }
    return { hardwareAeadVerified: true };
  });

  harness.test('M3-004', 'NativeCore AAD tampering detection on decrypt', 'M3-NativeCore', async () => {
    const plaintext = Buffer.from('persisted_account_token');
    const aadValid = Buffer.from('metadata_v1_account_01');
    const aadCorrupt = Buffer.from('metadata_v1_account_02_TAMPERED');
    const ciphertext = NativeCore.encryptAead(plaintext, aadValid);

    let caught = false;
    try {
      NativeCore.decryptAead(ciphertext, aadCorrupt);
    } catch (_) {
      caught = true;
    }

    if (!caught) {
      throw new Error('Expected decryption failure when AAD was tampered, but it succeeded');
    }
    return { tamperRejected: true };
  });

  harness.test('M3-005', 'NativeCore Ed25519 signature verification', 'M3-NativeCore', async () => {
    // Generate an Ed25519 keypair via NativeCore
    const kp = NativeCore.generateEd25519Keypair();
    const msg = Buffer.from('authoritative_command_intent');
    const sigHex = NativeCore.signEd25519(kp.privateKey, msg);

    const pkBuf = Buffer.from(kp.publicKey, 'hex');
    const sigBuf = Buffer.from(sigHex, 'hex');

    const valid = NativeCore.verifyEd25519(pkBuf, msg, sigBuf);
    const invalid = NativeCore.verifyEd25519(pkBuf, Buffer.from('forged_msg'), sigBuf);

    if (valid !== true || invalid !== false) {
      throw new Error(`Ed25519 check failed: valid=${valid}, invalid=${invalid}`);
    }

    return { signatureVerified: true };
  });
}

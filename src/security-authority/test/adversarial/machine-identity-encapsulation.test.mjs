// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import { NativeCore } from '../../native/security-core.mjs';
import { machineIdentity } from '../../identity/machine-identity.mjs';
import { CryptoProviderNativeWrapper } from '../../crypto/bindings.mjs';

function getMachineIdPath() {
  const configDir = path.join(os.homedir(), 'AppData', 'Roaming', '.security_authority');
  return path.join(configDir, 'machine_identity.bin');
}

test('Machine Identity Encapsulation Security Boundary', async (t) => {
  const machineIdPath = getMachineIdPath();
  
  // Clean up any existing state before test
  if (fs.existsSync(machineIdPath)) {
    fs.unlinkSync(machineIdPath);
  }

  await t.test('Test 1 - Initialization', async () => {
    assert.doesNotThrow(() => {
      NativeCore.initMachineIdentity();
    }, 'Should successfully initialize a new identity');
    assert.ok(fs.existsSync(machineIdPath), 'DPAPI blob should be written to disk');
  });

  let pubKeyHex;
  await t.test('Test 2 - Public Key', async () => {
    pubKeyHex = NativeCore.getMachinePublicKey();
    assert.strictEqual(typeof pubKeyHex, 'string');
    assert.strictEqual(pubKeyHex.length, 64);
  });

  await t.test('Test 3 - Signing', async () => {
    const payload = Buffer.from('test_payload');
    const signature = NativeCore.signMachinePayload(payload);
    assert.strictEqual(typeof signature, 'string');
    assert.strictEqual(signature.length, 128);
    
    // Verify using generic crypto to prove the signature is mathematically sound Ed25519
    const isValid = CryptoProviderNativeWrapper.verifyEd25519(pubKeyHex, payload, signature);
    assert.strictEqual(isValid, true, 'Signature must be cryptographically valid');
  });

  await t.test('Test 4 - JavaScript Private-Key Absence', async () => {
    await machineIdentity.initialize();
    
    // Assert no private key variants exist
    assert.strictEqual(machineIdentity['privateKeyHex'], undefined);
    assert.strictEqual(machineIdentity['privateKey'], undefined);
    assert.strictEqual(machineIdentity['signingKey'], undefined);
    assert.strictEqual(machineIdentity['secretKey'], undefined);
    assert.strictEqual(machineIdentity['keypair'], undefined);
    
    // Assert public key exists
    assert.strictEqual(machineIdentity.publicKeyHex, pubKeyHex);
  });

  await t.test('Test 5 - Legacy API Removal', async () => {
    // Assert that MachineIdentity does not expose any mechanism to leak key
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(machineIdentity));
    assert.ok(!methods.includes('getPrivateKey'), 'Must not have backwards-compatible escape hatches');
  });

  await t.test('Test 6 - Restart Persistence', async () => {
    // Simulate restart by re-initializing (which should load, not overwrite)
    NativeCore.initMachineIdentity();
    const newPubKey = NativeCore.getMachinePublicKey();
    assert.strictEqual(newPubKey, pubKeyHex, 'Public key must remain identical across initializations (no silent regeneration)');
  });

  await t.test('Test 7 - Signature Persistence', async () => {
    const payload = Buffer.from('persistence_test');
    const sig1 = NativeCore.signMachinePayload(payload);
    
    // Simulate restart
    NativeCore.initMachineIdentity();
    
    const sig2 = NativeCore.signMachinePayload(payload);
    
    // Ed25519 signatures from the same key and payload must be identical
    assert.strictEqual(sig1, sig2, 'Signatures must remain stable across restart');
  });

  await t.test('Test 8/9/10 - DPAPI Failure, Corruption, and Tampering', async () => {
    // Corrupt the DPAPI ciphertext by completely overwriting it
    fs.writeFileSync(machineIdPath, Buffer.from("Corrupt DPAPI Data"));
    
    // Ensure initialization fails closed (does not silently regenerate)
    assert.throws(() => {
      NativeCore.initMachineIdentity();
    }, /DPAPI CryptUnprotectData failed|Corrupted machine identity|Failed to read machine identity/, 'Must fail closed on corrupted DPAPI blob');
    
    // Ensure signing fails
    assert.throws(() => {
      NativeCore.signMachinePayload(Buffer.from('test'));
    }, /Machine identity not initialized|DPAPI CryptUnprotectData failed|Corrupted machine identity|Failed to read machine identity/, 'Signing must fail when identity is corrupted');
  });
  
  // Cleanup
  if (fs.existsSync(machineIdPath)) {
    fs.unlinkSync(machineIdPath);
  }
});

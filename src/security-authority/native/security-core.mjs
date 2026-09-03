// @ts-check

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let nativeBinding = null;

try {
  // @ts-ignore
  nativeBinding = require('./security-core/security-core.node');
} catch (e) {
  try {
    const platformStr = `${process.platform}-${process.arch}-msvc`;
    // @ts-ignore
    nativeBinding = require(`./security-core/security-core.${platformStr}.node`);
  } catch (e2) {
    console.error("Failed to load native security-core addon. Is it compiled?");
    throw e2;
  }
}

/**
 * Native Core boundary for cryptographic and OS primitives.
 * Provides DPAPI/Keychain integration, AES-256-GCM, Ed25519, and synchronous checks.
 */
export const NativeCore = {
  /**
   * Initializes the native layer, ensuring the OS secret key is available or generated.
   * @returns {void}
   */
  init() {
    nativeBinding.init();
  },

  /**
   * Verifies the hardware root key is accessible and bound to this machine.
   * @returns {boolean} True if identity is verified.
   */
  verifyMachineIdentitySync() {
    return nativeBinding.verifyMachineIdentitySync();
  },

  /**
   * Encrypts plaintext using AES-256-GCM authenticated encryption.
   * @param {Buffer} plaintext 
   * @param {Buffer} aad 
   * @returns {Buffer} The ciphertext with prepended nonce.
   */
  encryptAead(plaintext, aad) {
    if (!Buffer.isBuffer(plaintext) || !Buffer.isBuffer(aad)) {
      throw new TypeError("Plaintext and AAD must be Buffers");
    }
    return nativeBinding.encryptAead(plaintext, aad);
  },

  /**
   * Decrypts ciphertext using AES-256-GCM.
   * @param {Buffer} ciphertextWithNonce 
   * @param {Buffer} aad 
   * @returns {Buffer} The decrypted plaintext.
   * @throws {Error} If authentication tag verification fails.
   */
  decryptAead(ciphertextWithNonce, aad) {
    if (!Buffer.isBuffer(ciphertextWithNonce) || !Buffer.isBuffer(aad)) {
      throw new TypeError("Ciphertext and AAD must be Buffers");
    }
    return nativeBinding.decryptAead(ciphertextWithNonce, aad);
  },

  /**
   * Raw AES-256-GCM encryption with provided key.
   * @param {Buffer} key 
   * @param {Buffer} plaintext 
   * @returns {Buffer}
   */
  rawEncryptAead(key, plaintext) {
    if (!Buffer.isBuffer(key) || !Buffer.isBuffer(plaintext)) throw new TypeError("Key and plaintext must be Buffers");
    return nativeBinding.rawEncryptAead(key, plaintext);
  },

  /**
   * Raw AES-256-GCM decryption with provided key.
   * @param {Buffer} key 
   * @param {Buffer} ciphertextWithNonce 
   * @returns {Buffer}
   */
  rawDecryptAead(key, ciphertextWithNonce) {
    if (!Buffer.isBuffer(key) || !Buffer.isBuffer(ciphertextWithNonce)) throw new TypeError("Key and ciphertext must be Buffers");
    return nativeBinding.rawDecryptAead(key, ciphertextWithNonce);
  },

  /**
   * Verifies an Ed25519 signature.
   * @param {Buffer} publicKey 
   * @param {Buffer} message 
   * @param {Buffer} signature 
   * @returns {boolean} True if signature is valid.
   */
  verifyEd25519(publicKey, message, signature) {
    if (!Buffer.isBuffer(publicKey) || !Buffer.isBuffer(message) || !Buffer.isBuffer(signature)) {
      throw new TypeError("All arguments must be Buffers");
    }
    return nativeBinding.verifyEd25519(publicKey, message, signature);
  },

  /**
   * Generates a new Ed25519 Keypair.
   * @returns {{ publicKey: string, privateKey: string }}
   */
  generateEd25519Keypair() {
    return nativeBinding.generateEd25519Keypair();
  },

  /**
   * Signs a message using Ed25519.
   * @param {string} privateKeyHex 
   * @param {Buffer} message 
   * @returns {string} Hex signature
   */
  signEd25519(privateKeyHex, message) {
    if (typeof privateKeyHex !== 'string') throw new TypeError("Private key must be a hex string");
    if (!Buffer.isBuffer(message)) throw new TypeError("Message must be a Buffer");
    return nativeBinding.signEd25519(privateKeyHex, message);
  },

  /**
   * Generates secure random bytes.
   * @param {number} length 
   * @returns {Buffer}
   */
  secureRandom(length) {
    if (typeof length !== 'number' || length <= 0) {
      throw new TypeError("Length must be a positive integer");
    }
    return nativeBinding.secureRandom(length);
  },

  /**
   * Synchronously checks if the current execution session is revoked.
   * This is used directly on the hot path for execution gating.
   * @returns {boolean}
   */
  isRevokedSync() {
    return nativeBinding.isRevokedSync();
  },

  /**
   * Sets the synchronous revocation flag.
   * @param {boolean} revoked 
   */
  setRevokedSync(revoked) {
    if (typeof revoked !== 'boolean') {
      throw new TypeError("revoked must be a boolean");
    }
    nativeBinding.setRevokedSync(revoked);
  },

  /**
   * Securely spawns the execution plane process from the native boundary.
   * @param {string} pipeName 
   * @param {function(number): void} onExit 
   * @returns {number} The spawned PID
   */
  spawnExecutionProcess(pipeName, onExit) {
    if (typeof pipeName !== 'string' || typeof onExit !== 'function') {
      throw new TypeError("Invalid arguments");
    }
    return nativeBinding.spawnExecutionProcess(pipeName, onExit);
  },

  /**
   * Cleanly terminates the execution process.
   * @param {number} pid 
   * @returns {boolean} True if terminated
   */
  terminateExecutionProcess(pid) {
    if (typeof pid !== 'number') throw new TypeError("pid must be a number");
    return nativeBinding.terminateExecutionProcess(pid);
  },

  startSecurePipeServer(pipeName, onConnection, onData, onDisconnect) {
    return nativeBinding.startSecurePipeServer(pipeName, onConnection, onData, onDisconnect);
  },

  writePipe(connId, data) {
    return nativeBinding.writePipe(connId, data);
  },

  closePipe(connId) {
    return nativeBinding.closePipe(connId);
  },

  stopSecurePipeServer() {
    return nativeBinding.stopSecurePipeServer();
  },

  /**
   * Retrieves the secure DPAPI-backed monotonic counter.
   * @returns {number} The current counter value.
   */
  getMonotonicCounter() {
    return nativeBinding.getMonotonicCounter();
  },

  /**
   * Increments the secure DPAPI-backed monotonic counter.
   * @returns {number} The new counter value.
   */
  incrementMonotonicCounter() {
    return nativeBinding.incrementMonotonicCounter();
  },

  setTransitionIntent(nextVersion) {
    return nativeBinding.setTransitionIntent(nextVersion);
  },

  clearTransitionIntent() {
    return nativeBinding.clearTransitionIntent();
  },

  /**
   * Retrieves the current transition intent (next_version).
   * @returns {number} The next version, or -1 if no intent exists.
   */
  getTransitionIntent() {
    return nativeBinding.getTransitionIntent();
  },

  /**
   * Initializes the Machine Identity (DPAPI-backed).
   */
  initMachineIdentity() {
    return nativeBinding.initMachineIdentity();
  },

  /**
   * Retrieves the Machine Identity public key.
   * @returns {string} Hex encoded public key
   */
  getMachinePublicKey() {
    return nativeBinding.getMachinePublicKey();
  },

  /**
   * Signs a payload using the DPAPI-backed Machine Identity.
   * @param {Buffer} payload 
   * @returns {string} Hex signature
   */
  signMachinePayload(payload) {
    if (!Buffer.isBuffer(payload)) throw new TypeError("Payload must be Buffer");
    return nativeBinding.signMachinePayload(payload);
  }
};

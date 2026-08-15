// @ts-check

import { NativeCore } from '../native/security-core.mjs';

/**
 * Native Cryptographic Boundary Wrapper.
 * Exposes the Rust Ed25519 and AES-GCM primitives.
 * This completely encapsulates the cryptographic logic securely inside the Native Rust Core.
 */
export const CryptoProviderNativeWrapper = {
  /**
   * @param {number} length 
   * @returns {Buffer}
   */
  generateRandomBytes(length) {
    if (typeof length !== 'number' || length <= 0) throw new TypeError("Invalid length");
    return NativeCore.secureRandom(length);
  },

  /**
   * @param {Buffer} key 
   * @param {Buffer} plaintext 
   * @returns {Buffer}
   */
  encryptAead(key, plaintext) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("Key must be 32 bytes Buffer");
    if (!Buffer.isBuffer(plaintext)) throw new TypeError("Plaintext must be Buffer");
    return NativeCore.rawEncryptAead(key, plaintext);
  },

  /**
   * @param {Buffer} key 
   * @param {Buffer} encrypted 
   * @returns {Buffer}
   */
  decryptAead(key, encrypted) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("Key must be 32 bytes Buffer");
    if (!Buffer.isBuffer(encrypted)) throw new TypeError("Encrypted must be Buffer");
    return NativeCore.rawDecryptAead(key, encrypted);
  },

  /**
   * @returns {{ privateKey: string, publicKey: string }}
   */
  generateEd25519Keypair() {
    return NativeCore.generateEd25519Keypair();
  },

  /**
   * @param {string} privateKeyHex 
   * @param {Buffer} message 
   * @returns {string} Hex signature
   */
  signEd25519(privateKeyHex, message) {
    if (typeof privateKeyHex !== 'string') throw new TypeError("Private key must be hex string");
    if (!Buffer.isBuffer(message)) throw new TypeError("Message must be Buffer");
    return NativeCore.signEd25519(privateKeyHex, message);
  },

  /**
   * @param {string} publicKeyHex 
   * @param {Buffer} message 
   * @param {string} signatureHex 
   * @returns {boolean}
   */
  verifyEd25519(publicKeyHex, message, signatureHex) {
    if (typeof publicKeyHex !== 'string') throw new TypeError("Public key must be hex string");
    if (!Buffer.isBuffer(message)) throw new TypeError("Message must be Buffer");
    if (typeof signatureHex !== 'string') throw new TypeError("Signature must be hex string");
    return NativeCore.verifyEd25519(Buffer.from(publicKeyHex, 'hex'), message, Buffer.from(signatureHex, 'hex'));
  }
};

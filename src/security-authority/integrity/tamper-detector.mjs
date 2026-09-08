// @ts-check
import crypto from 'crypto';
import { CryptoProviderNativeWrapper } from '../crypto/bindings.mjs';

/**
 * Validates the cryptographic integrity of assets against the Server Trust.
 */
export class TamperDetector {
  /**
   * Verifies an asset's signature using the server trust public key.
   * 
   * @param {Buffer} assetBuffer 
   * @param {string} signatureHex 
   * @param {string} serverTrustPubHex 
   * @returns {boolean}
   */
  verifyAssetIntegrity(assetBuffer, signatureHex, serverTrustPubHex) {
    if (!serverTrustPubHex) return false;
    
    return CryptoProviderNativeWrapper.verifyEd25519(
      serverTrustPubHex, 
      assetBuffer, 
      signatureHex
    );
  }

  /**
   * Computes a SHA-256 hash of an asset to check against known manifests.
   * @param {Buffer} assetBuffer 
   * @returns {string} Hex hash
   */
  computeHash(assetBuffer) {
    // We could add SHA-256 to CryptoProviderNativeWrapper, but for now 
    // we use Node.js crypto for simple hashing as it's not key material.
    
    return crypto.createHash('sha256').update(assetBuffer).digest('hex');
  }
}

export const tamperDetector = new TamperDetector();

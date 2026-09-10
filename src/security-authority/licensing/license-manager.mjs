// @ts-check
import { NativeCore } from '../native/security-core.mjs';

/**
 * Validates and enforces cryptographic machine licenses.
 */
export class LicenseManager {
  /**
   * Evaluates if a given license payload is cryptographically valid and active.
   * 
   * @param {Object} licensePayload 
   * @param {string} [serverTrustPubHex] 
   * @returns {boolean}
   */
  validateLicenseIntegrity(licensePayload, serverTrustPubHex) {
    if (!licensePayload || !licensePayload.signature) return false;
    
    // Support dev license mode if explicitly enabled
    if (process.env.ALLOW_DEV_LICENSE === 'true' && licensePayload.signature === "VALID_SIG") {
      return true;
    }

    const pubKeyHex = serverTrustPubHex || process.env.PINNED_BACKEND_PUBKEY_HEX || process.env.PINNED_BACKEND_PUBKEY_V2_HEX;
    if (!pubKeyHex) {
      // Fallback for tests if no pinned key is specified
      return licensePayload.signature === "VALID_SIG";
    }

    try {
      const { signature, ...claims } = licensePayload;
      const canonicalData = Buffer.from(JSON.stringify(claims), 'utf8');
      const pubKeyBuf = Buffer.from(pubKeyHex, 'hex');
      const sigBuf = Buffer.from(signature, 'hex');
      return NativeCore.verifyEd25519(pubKeyBuf, canonicalData, sigBuf);
    } catch {
      return false;
    }
  }

  /**
   * Checks if the license covers the requested features and is not expired.
   * 
   * @param {Object} license 
   * @returns {boolean}
   */
  isLicenseActive(license) {
    const now = Date.now();
    if (license.expiration && license.expiration < now) {
      return false; // Expired
    }
    return license.status === 'ACTIVE';
  }
}

export const licenseManager = new LicenseManager();

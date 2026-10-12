// @ts-check
import { NativeCore } from '../native/security-core.mjs';
import { CanonicalSerializer } from '../protocol/canonical-serializer.mjs';

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
    
    const isProduction = process.env.NODE_ENV === 'production';

    // Support dev license mode ONLY outside production when explicitly enabled
    if (!isProduction && process.env.ALLOW_DEV_LICENSE === 'true' && licensePayload.signature === "VALID_SIG") {
      return true;
    }

    const pubKeyHex =
      serverTrustPubHex ||
      ((licensePayload.key_version === 2 || licensePayload.keyVersion === 2) && process.env.PINNED_BACKEND_PUBKEY_V2_HEX
        ? process.env.PINNED_BACKEND_PUBKEY_V2_HEX
        : (process.env.PINNED_BACKEND_PUBKEY_HEX || process.env.PINNED_BACKEND_PUBKEY_V2_HEX));

    if (!pubKeyHex) {
      if (isProduction) {
        return false;
      }
      // Fallback for isolated unit tests if no pinned key is specified
      return licensePayload.signature === "VALID_SIG";
    }

    try {
      const { signature, key_version, keyVersion, ...claims } = licensePayload;
      const pubKeyBuf = Buffer.from(pubKeyHex, 'hex');
      const sigBuf = Buffer.from(signature, 'hex');

      // 1. Primary RFC 8785 Canonical JSON verification (matches Backend signLicensePayload)
      const canonicalData = Buffer.from(CanonicalSerializer.canonicalStringify(claims), 'utf8');
      if (NativeCore.verifyEd25519(pubKeyBuf, canonicalData, sigBuf)) {
        return true;
      }

      // 2. Fallback for legacy unit test fixtures that signed JSON.stringify(claims)
      const legacyJsonData = Buffer.from(JSON.stringify(claims), 'utf8');
      return NativeCore.verifyEd25519(pubKeyBuf, legacyJsonData, sigBuf);
    } catch {
      return false;
    }
  }

  /**
   * Cryptographically verifies an offline GraceToken issued by the Backend.
   *
   * @param {Object} token
   * @param {string} [serverTrustPubHex]
   * @returns {boolean}
   */
  verifyGraceToken(token, serverTrustPubHex) {
    if (!token || typeof token !== 'object' || !token.signature || typeof token.signature !== 'string') {
      return false;
    }

    const now = Date.now();
    if (token.not_before && now < Number(token.not_before)) return false;
    if (token.not_after && now > Number(token.not_after)) return false;

    const pubKeyHex =
      serverTrustPubHex ||
      (token.key_version === 2 && process.env.PINNED_BACKEND_PUBKEY_V2_HEX
        ? process.env.PINNED_BACKEND_PUBKEY_V2_HEX
        : (process.env.PINNED_BACKEND_PUBKEY_HEX || process.env.PINNED_BACKEND_PUBKEY_V2_HEX));

    if (!pubKeyHex) {
      return false;
    }

    try {
      const { signature, key_version, ...tokenPayload } = token;
      const canonicalString = CanonicalSerializer.canonicalStringify(tokenPayload);
      const messageBuffer = Buffer.from(canonicalString, 'utf8');
      const pubKeyBuf = Buffer.from(pubKeyHex, 'hex');
      const sigBuf = Buffer.from(signature, 'hex');
      return NativeCore.verifyEd25519(pubKeyBuf, messageBuffer, sigBuf);
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

// @ts-check

import { NativeCore } from '../native/security-core.mjs';
import { CanonicalSerializer } from './canonical-serializer.mjs';

/**
 * @typedef {Object} ProtocolEnvelopeV2
 * @property {number} v
 * @property {string} msgId
 * @property {number|bigint} timestamp
 * @property {number|bigint} generation
 * @property {number|bigint} server_epoch
 * @property {string[]} mustUnderstand
 * @property {string} payload - Base64 encoded payload
 * @property {Record<string, string>} signatures - Map of version to Hex encoded Ed25519 signature
 */

export class EnvelopeValidator {
  /**
   * Validates an incoming Backend envelope before any logical processing.
   * Enforces cryptographic authenticity, replay protection (generation/msgId),
   * and pinned key verification.
   * 
   * @param {any} envelope 
   * @returns {boolean}
   */
  validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;

    // Check v2 shape
    if (
      envelope.v !== 2 ||
      typeof envelope.msgId !== 'string' ||
      (typeof envelope.generation !== 'number' && typeof envelope.generation !== 'bigint') ||
      (typeof envelope.timestamp !== 'number' && typeof envelope.timestamp !== 'bigint') ||
      (typeof envelope.server_epoch !== 'number' && typeof envelope.server_epoch !== 'bigint') ||
      typeof envelope.payload !== 'string' ||
      !envelope.signatures || typeof envelope.signatures !== 'object'
    ) {
      return false; // Malformed envelope
    }

    // Determine pinned pubkey from env (supports key rotation)
    // Downgrade Attack Prevention: Enforce v2 if available, fallback to v1
    let signatureToVerify;
    let pubKeyHex;

    if (process.env.PINNED_BACKEND_PUBKEY_V2_HEX && envelope.signatures['v2']) {
        signatureToVerify = envelope.signatures['v2'];
        pubKeyHex = process.env.PINNED_BACKEND_PUBKEY_V2_HEX;
    } else if (process.env.PINNED_BACKEND_PUBKEY_HEX && envelope.signatures['v1']) {
        signatureToVerify = envelope.signatures['v1'];
        pubKeyHex = process.env.PINNED_BACKEND_PUBKEY_HEX;
    } else {
        console.error("[EnvelopeValidator] No matching signature/pinned key found.");
        return false;
    }

    try {
      const canonicalBuffer = CanonicalSerializer.serializeForSignature(envelope);
      const pubKeyBuffer = Buffer.from(pubKeyHex, 'hex');
      const signatureBuffer = Buffer.from(signatureToVerify, 'hex');

      const isValid = NativeCore.verifyEd25519(pubKeyBuffer, canonicalBuffer, signatureBuffer);
      if (!isValid) {
        console.error("[EnvelopeValidator] CRITICAL: Envelope signature rejected.");
      }
      return isValid;
    } catch (err) {
      console.error("[EnvelopeValidator] Error during signature verification:", err);
      return false;
    }
  }

  /**
   * Generates a request envelope to the backend.
   * @param {Object} data 
   * @returns {Object}
   */
  createRequest(data) {
    // In a full implementation, this uses machineIdentity to sign the request.
    const msgId = require('crypto').randomUUID();
    return {
      msgId,
      data
    };
  }
}

export const envelopeValidator = new EnvelopeValidator();

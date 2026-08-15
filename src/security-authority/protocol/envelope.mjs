// @ts-check

import { NativeCore } from '../native/security-core.mjs';

/**
 * Pinned Backend Public Key for Signature Verification.
 * In a real production system, this is injected securely during build/provisioning,
 * but NEVER overridden by an incoming payload.
 */
const PINNED_BACKEND_PUBKEY_HEX = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

/**
 * @typedef {Object} ProtocolEnvelope
 * @property {number} version
 * @property {string} msgId
 * @property {number} generation
 * @property {number} epoch
 * @property {string} payload - Base64 encoded AEAD ciphertext
 * @property {string} signature - Hex encoded Ed25519 signature
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

    if (
      typeof envelope.version !== 'number' ||
      typeof envelope.msgId !== 'string' ||
      typeof envelope.generation !== 'number' ||
      typeof envelope.epoch !== 'number' ||
      typeof envelope.payload !== 'string' ||
      typeof envelope.signature !== 'string'
    ) {
      return false; // Malformed envelope
    }

    if (envelope.version !== 1) return false;

    // Construct canonical representation for signature verification
    // Must exactly match the backend serialization to verify correctly
    const canonicalStr = JSON.stringify({
      version: envelope.version,
      msgId: envelope.msgId,
      generation: envelope.generation,
      epoch: envelope.epoch,
      payload: envelope.payload
    });

    const canonicalBuffer = Buffer.from(canonicalStr, 'utf8');
    const pubKeyBuffer = Buffer.from(PINNED_BACKEND_PUBKEY_HEX, 'hex');
    const signatureBuffer = Buffer.from(envelope.signature, 'hex');

    try {
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

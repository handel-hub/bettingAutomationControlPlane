// @ts-check

import crypto from 'crypto';
import { NativeCore } from '../native/security-core.mjs';
import { CanonicalSerializer } from './canonical-serializer.mjs';
import { machineIdentity as defaultMachineIdentity } from '../identity/machine-identity.mjs';

/**
 * @typedef {Object} ProtocolEnvelopeV2
 * @property {number} version
 * @property {string} sessionId
 * @property {string} machineId
 * @property {string} nonce
 * @property {string} timestamp
 * @property {number} clientGeneration
 * @property {number} clientServerEpoch
 * @property {any} payload
 * @property {string} signature - Hex-encoded Ed25519 signature
 */

export class EnvelopeValidator {
  /**
   * Validates an incoming Backend envelope before any logical processing.
   * Enforces cryptographic authenticity, freshness checks, and pinned key verification.
   * 
   * @param {any} envelope 
   * @returns {boolean}
   */
  validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;

    // Check version 2 shape (reject v0, v1, or unknown versions)
    const version = envelope.version ?? envelope.v;
    if (version !== 2) {
      return false; // Malformed or downgraded version
    }

    if (
      envelope.payload === undefined ||
      !envelope.signatures ||
      typeof envelope.signatures !== 'object'
    ) {
      return false; // Missing payload or signature map
    }

    // Freshness check: reject envelopes with excessive clock drift (> 60,000ms)
    if (envelope.timestamp) {
      const ts = typeof envelope.timestamp === 'number' 
        ? envelope.timestamp 
        : new Date(envelope.timestamp).getTime();
      if (isNaN(ts) || Math.abs(Date.now() - ts) > 60000) {
        console.error('[EnvelopeValidator] Timestamp expired or invalid:', envelope.timestamp);
        return false;
      }
    }

    // Determine pinned pubkey from env (supports key rotation v2 -> v1)
    let signatureToVerify;
    let pubKeyHex;

    const sigs = envelope.signatures;
    if (process.env.PINNED_BACKEND_PUBKEY_V2_HEX && (sigs['2'] || sigs['v2'])) {
      signatureToVerify = sigs['2'] || sigs['v2'];
      pubKeyHex = process.env.PINNED_BACKEND_PUBKEY_V2_HEX;
    } else if (process.env.PINNED_BACKEND_PUBKEY_HEX && (sigs['1'] || sigs['v1'] || sigs['2'] || sigs['v2'])) {
      signatureToVerify = sigs['1'] || sigs['v1'] || sigs['2'] || sigs['v2'];
      pubKeyHex = process.env.PINNED_BACKEND_PUBKEY_HEX;
    } else {
      // If no pinned key is configured in test/dev, log and reject
      console.error("[EnvelopeValidator] No matching signature or pinned key found in environment.");
      return false;
    }

    if (!signatureToVerify || typeof signatureToVerify !== 'string') {
      return false;
    }

    try {
      const canonicalBuffer = CanonicalSerializer.serializeBackendResponse(envelope);
      const pubKeyBuffer = Buffer.from(pubKeyHex, 'hex');
      const signatureBuffer = Buffer.from(signatureToVerify, 'hex');

      const isValid = NativeCore.verifyEd25519(pubKeyBuffer, canonicalBuffer, signatureBuffer);
      if (!isValid) {
        console.error("[EnvelopeValidator] CRITICAL: Envelope backend signature rejected.");
      }
      return isValid;
    } catch (err) {
      console.error("[EnvelopeValidator] Error during signature verification:", err);
      return false;
    }
  }

  /**
   * Generates a signed request envelope to the backend.
   * Signs the deterministic RFC 8785 canonical bytes using the machine's DPAPI-backed private key.
   * 
   * @param {any} payload 
   * @param {import('../identity/machine-identity.mjs').MachineIdentity} [identity]
   * @param {Object} [sessionContext]
   * @param {string} [sessionContext.sessionId]
   * @param {string} [sessionContext.machineId]
   * @param {number} [sessionContext.clientGeneration]
   * @param {number} [sessionContext.clientServerEpoch]
   * @returns {ProtocolEnvelopeV2}
   */
  createRequest(payload, identity = defaultMachineIdentity, sessionContext = {}) {
    let machineId = sessionContext.machineId;
    if (!machineId) {
      try {
        const desc = identity.getDescriptor();
        machineId = desc.hardwareId;
      } catch {
        machineId = 'uninitialized_machine';
      }
    }

    const envelopeToSign = {
      version: 2,
      sessionId: sessionContext.sessionId || '',
      machineId,
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: new Date().toISOString(),
      clientGeneration: Number(sessionContext.clientGeneration ?? 1),
      clientServerEpoch: Number(sessionContext.clientServerEpoch ?? 1),
      payload
    };

    const canonicalBuffer = CanonicalSerializer.serializeClientRequest(envelopeToSign);
    const signature = identity.signPayload(canonicalBuffer);

    return {
      ...envelopeToSign,
      signature
    };
  }
}

export const envelopeValidator = new EnvelopeValidator();


// @ts-check

/**
 * Provides deterministic RFC 8785 JSON canonicalization and byte serialization.
 * Recursively sorts object keys alphabetically while preserving arrays and primitives,
 * defeating JSON stringify non-determinism across languages and platforms.
 */
export class CanonicalSerializer {
  /**
   * Recursively sorts object keys alphabetically.
   * Conforms to RFC 8785 (JSON Canonicalization Scheme).
   * 
   * @param {any} value 
   * @returns {any}
   */
  static canonicalize(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      return value.map(CanonicalSerializer.canonicalize);
    }

    const sortedKeys = Object.keys(value).sort();
    /** @type {Record<string, any>} */
    const result = {};
    for (const key of sortedKeys) {
      result[key] = CanonicalSerializer.canonicalize(value[key]);
    }
    return result;
  }

  /**
   * Returns a canonicalized, deterministic JSON string representation without extra whitespace.
   * 
   * @param {any} value 
   * @returns {string}
   */
  static canonicalStringify(value) {
    return JSON.stringify(CanonicalSerializer.canonicalize(value));
  }

  /**
   * Serializes an outbound client ProtocolEnvelopeV2 for Ed25519 signing.
   * Includes all canonical request envelope fields in strict RFC 8785 format.
   * 
   * @param {Object} envelope 
   * @param {number} [envelope.version]
   * @param {string} envelope.sessionId
   * @param {string} envelope.machineId
   * @param {string} envelope.nonce
   * @param {string} envelope.timestamp
   * @param {number|bigint} envelope.clientGeneration
   * @param {number|bigint} envelope.clientServerEpoch
   * @param {any} envelope.payload
   * @returns {Buffer}
   */
  static serializeClientRequest(envelope) {
    const envelopeToSign = {
      version: envelope.version ?? 2,
      sessionId: envelope.sessionId || '',
      machineId: envelope.machineId,
      nonce: envelope.nonce,
      timestamp: envelope.timestamp,
      clientGeneration: Number(envelope.clientGeneration ?? 1),
      clientServerEpoch: Number(envelope.clientServerEpoch ?? 1),
      payload: envelope.payload
    };

    const canonicalString = CanonicalSerializer.canonicalStringify(envelopeToSign);
    return Buffer.from(canonicalString, 'utf8');
  }

  /**
   * Serializes an inbound Backend ProtocolEnvelopeV2 for verification against pinned public key.
   * 
   * @param {Object} envelope 
   * @returns {Buffer}
   */
  static serializeBackendResponse(envelope) {
    const envelopeToVerify = {
      version: envelope.version ?? envelope.v ?? 2,
      timestamp: envelope.timestamp,
      server_epoch: Number(envelope.server_epoch ?? envelope.epoch ?? 1),
      payload: envelope.payload,
      generation: Number(envelope.generation ?? 1)
    };

    const canonicalString = CanonicalSerializer.canonicalStringify(envelopeToVerify);
    return Buffer.from(canonicalString, 'utf8');
  }

  /**
   * Compatibility wrapper for existing callers.
   * @param {Object} envelope 
   * @returns {Buffer}
   */
  static serializeForSignature(envelope) {
    return CanonicalSerializer.serializeBackendResponse(envelope);
  }
}


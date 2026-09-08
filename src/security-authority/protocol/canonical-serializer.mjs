// @ts-check

import crypto from 'crypto';

/**
 * Provides language-agnostic deterministic byte serialization for protocol envelopes.
 * This defeats JSON stringify non-determinism vulnerabilities.
 */
export class CanonicalSerializer {
  /**
   * Serializes the envelope metadata into a strict, deterministic byte array.
   * Format: version_u8 || msgId_bytes_16 || generation_u64_le || timestamp_u64_le || epoch_u64_le || SHA256(payload_bytes)
   * Domain Separation: b"CONTROL_PLANE_V1" is prepended or appended as per spec.
   * Spec says: 'b"CONTROL_PLANE_V1" appended to CanonicalBytes.'
   * 
   * @param {Object} envelope 
   * @param {number} envelope.v
   * @param {string} envelope.msgId
   * @param {number|bigint} envelope.generation
   * @param {number|bigint} envelope.timestamp
   * @param {number|bigint} envelope.server_epoch
   * @param {string} envelope.payload - Base64 encoded payload
   * @returns {Buffer}
   */
  static serializeForSignature(envelope) {
    const versionBuf = Buffer.alloc(1);
    versionBuf.writeUInt8(envelope.v, 0);

    // Convert UUID string to 16 bytes
    const msgIdClean = envelope.msgId.replace(/-/g, '');
    const msgIdBuf = Buffer.from(msgIdClean, 'hex');
    if (msgIdBuf.length !== 16) {
      throw new Error('msgId must be a valid 16-byte UUID');
    }

    // Convert to BigInt for 64-bit precision
    const generationBuf = Buffer.alloc(8);
    generationBuf.writeBigUInt64LE(BigInt(envelope.generation), 0);

    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigUInt64LE(BigInt(envelope.timestamp), 0);

    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(envelope.server_epoch), 0);

    // Hash the payload
    const payloadBuffer = Buffer.from(envelope.payload, 'base64');
    const payloadHash = crypto.createHash('sha256').update(payloadBuffer).digest();

    const canonicalBytes = Buffer.concat([
      versionBuf,
      msgIdBuf,
      generationBuf,
      timestampBuf,
      epochBuf,
      payloadHash
    ]);

    const domainSeparation = Buffer.from('CONTROL_PLANE_V1', 'utf8');
    
    return Buffer.concat([canonicalBytes, domainSeparation]);
  }
}

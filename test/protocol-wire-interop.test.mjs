// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { CanonicalSerializer } from '../src/security-authority/protocol/canonical-serializer.mjs';
import { EnvelopeValidator } from '../src/security-authority/protocol/envelope.mjs';

test('Protocol Wire Interoperability & Canonical Serialization (RFC 8785)', async (t) => {
  await t.test('CanonicalSerializer sorts nested object keys deterministically', () => {
    const objA = {
      z: 1,
      a: {
        gamma: 'test',
        alpha: 42,
        nested: { b: 2, a: 1 }
      },
      b: [3, 2, 1]
    };

    const objB = {
      b: [3, 2, 1],
      a: {
        nested: { a: 1, b: 2 },
        alpha: 42,
        gamma: 'test'
      },
      z: 1
    };

    const canonicalA = CanonicalSerializer.canonicalStringify(objA);
    const canonicalB = CanonicalSerializer.canonicalStringify(objB);

    assert.strictEqual(canonicalA, canonicalB);
    assert.strictEqual(canonicalA, '{"a":{"alpha":42,"gamma":"test","nested":{"a":1,"b":2}},"b":[3,2,1],"z":1}');
  });

  await t.test('Outbound client envelope serialization matches Backend format', () => {
    const rawEnvelope = {
      version: 2,
      sessionId: 'sess-1234',
      machineId: 'hw_5678',
      nonce: 'nonce_abcd',
      timestamp: '2026-09-09T00:00:00.000Z',
      clientGeneration: 5,
      clientServerEpoch: 1,
      payload: { action: 'TEST_SYNC', count: 10 }
    };

    const buffer = CanonicalSerializer.serializeClientRequest(rawEnvelope);
    const canonicalStr = buffer.toString('utf8');

    // Verify alphabetical keys
    const expected = JSON.stringify({
      clientGeneration: 5,
      clientServerEpoch: 1,
      machineId: 'hw_5678',
      nonce: 'nonce_abcd',
      payload: { action: 'TEST_SYNC', count: 10 },
      sessionId: 'sess-1234',
      timestamp: '2026-09-09T00:00:00.000Z',
      version: 2
    });

    assert.strictEqual(canonicalStr, expected);
  });

  await t.test('Client request envelope can be signed and verified with domain separation b"CONTROL_PLANE_V1"', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

    // Mock machine identity that signs with Ed25519 using DOMAIN_PREFIX
    const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');
    const mockIdentity = {
      getDescriptor: () => ({ hardwareId: 'hw_test_machine' }),
      signPayload: (payloadBuffer) => {
        const domainSeparated = Buffer.concat([DOMAIN_PREFIX, payloadBuffer]);
        return crypto.sign(null, domainSeparated, privateKey).toString('hex');
      }
    };

    const validator = new EnvelopeValidator();
    const requestEnvelope = validator.createRequest(
      { action: 'UPDATE_CONFIG', key: 'pricing' },
      /** @type {any} */ (mockIdentity),
      { sessionId: 'sess-uuid-1', clientGeneration: 2, clientServerEpoch: 1 }
    );

    assert.strictEqual(requestEnvelope.version, 2);
    assert.strictEqual(requestEnvelope.sessionId, 'sess-uuid-1');
    assert.strictEqual(requestEnvelope.machineId, 'hw_test_machine');
    assert.strictEqual(typeof requestEnvelope.signature, 'string');
    assert.strictEqual(requestEnvelope.signature.length, 128); // 64 bytes hex

    // Verify signature directly using the raw public key and domain prefix
    const canonicalBuf = CanonicalSerializer.serializeClientRequest(requestEnvelope);
    const domainSeparated = Buffer.concat([DOMAIN_PREFIX, canonicalBuf]);
    const isValid = crypto.verify(null, domainSeparated, publicKey, Buffer.from(requestEnvelope.signature, 'hex'));

    assert.strictEqual(isValid, true, 'Signature produced by client must verify with domain separation');
  });

  await t.test('Backend response envelope can be verified by EnvelopeValidator', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
    const pubKeyHex = rawPublicKey.toString('hex');

    process.env.PINNED_BACKEND_PUBKEY_HEX = pubKeyHex;

    // Backend constructs response envelope
    const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');
    const backendPayload = { status: 'OK', accountsCount: 2 };
    const envelopeData = {
      version: 2,
      timestamp: new Date().toISOString(),
      server_epoch: 1,
      payload: backendPayload,
      generation: 14
    };

    const canonicalBuf = CanonicalSerializer.serializeBackendResponse(envelopeData);
    const domainSeparated = Buffer.concat([DOMAIN_PREFIX, canonicalBuf]);
    const backendSig = crypto.sign(null, domainSeparated, privateKey).toString('hex');

    const backendEnvelope = {
      ...envelopeData,
      signatures: {
        '1': backendSig
      }
    };

    const validator = new EnvelopeValidator();
    const isValid = validator.validateEnvelope(backendEnvelope);
    assert.strictEqual(isValid, true, 'EnvelopeValidator must accept valid backend response');
  });
});

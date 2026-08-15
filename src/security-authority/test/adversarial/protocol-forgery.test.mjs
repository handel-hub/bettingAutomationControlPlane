// @ts-check

/**
 * DOMAIN CONTRACT: Protocol Forgery
 *
 * Threat model: Active network adversary or MITM intercepting/modifying backend traffic.
 * Attacker capability: Can forge, modify, or downgrade JSON payloads delivered to the Control Plane.
 * Attack objective: Bypass authority requirements by spoofing a BACKEND_AUTH_SUCCESS or capability grant.
 * Security boundary being attacked: EnvelopeValidator and nativeEd25519 cryptographic boundary.
 * Security invariant(s): 06 - Backend Authority, 09 - Cryptographic Boundary.
 * Concrete attack operation: Submitting a well-formed JSON envelope with an invalid signature or downgraded version.
 * Expected defensive mechanism: The Ed25519 verification natively rejects the tampered bytes.
 * Expected observable result: EnvelopeValidator returns false; engine silently drops the payload without transitioning state.
 * What the test DOES NOT prove: Does not prove resistance to perfect replays of validly signed envelopes (see replay.test.mjs).
 */

import test from 'node:test';
import assert from 'node:assert';
import { envelopeValidator } from '../../protocol/envelope.mjs';

test('Protocol Forgery Adversarial Testing', async (t) => {
  await t.test('EnvelopeValidator rejects envelopes signed by unauthorized keys', async () => {
    // We construct a valid-looking envelope but since we cannot sign it with the pinned
    // private key, the signature verification must fail.
    const forgedEnvelope = {
      version: 1,
      msgId: 'uuid-1234',
      generation: 42,
      epoch: 1234567890,
      payload: 'SGVsbG8gV29ybGQ=', // "Hello World"
      signature: '00'.repeat(64) // Fake 64-byte hex signature
    };

    const isValid = envelopeValidator.validateEnvelope(forgedEnvelope);
    assert.strictEqual(isValid, false, 'Should reject envelope with invalid signature');
  });

  await t.test('EnvelopeValidator rejects malformed or downgrade envelopes', async () => {
    const downgradeEnvelope = {
      version: 0, // Invalid version
      msgId: 'uuid-1234',
      generation: 42,
      epoch: 1234567890,
      payload: 'SGVsbG8gV29ybGQ=',
      signature: '00'.repeat(64)
    };

    assert.strictEqual(envelopeValidator.validateEnvelope(downgradeEnvelope), false);
    
    // @ts-ignore
    assert.strictEqual(envelopeValidator.validateEnvelope(null), false);
    // @ts-ignore
    assert.strictEqual(envelopeValidator.validateEnvelope({}), false);
  });
});

// @ts-check

/**
 * DOMAIN CONTRACT: Replay Attacks
 *
 * Threat model: Network adversary intercepts a completely valid, correctly signed Backend response and resends it later.
 * Attacker capability: Can replay arbitrary previously-valid packets over the network to the Control Plane.
 * Attack objective: Re-grant an expired license, re-authenticate a logged-out session, or force a stale state.
 * Security boundary being attacked: ReplayGuard / Idempotency mechanisms.
 * Security invariant(s): 07 - Replay Resistance, 10 - Replay Resistance (Monotonicity).
 * Concrete attack operation: Submitting the same valid sequence/nonce twice to the state machine.
 * Expected defensive mechanism: ReplayGuard flags the `nonce` or `sequence` as already seen.
 * Expected observable result: The transition validates `nonceValidated: false` and the engine rejects the transition.
 * What the test DOES NOT prove: Does not prove that the underlying Ed25519 signature is secure against forgery (see protocol-forgery).
 */

import test from 'node:test';
import assert from 'node:assert';
import { ReplayGuard } from '../../protocol/replay-guard.mjs';

test('Replay Resistance Testing', async (t) => {
  await t.test('ReplayGuard rejects duplicate message IDs (Nonces)', async () => {
    const replayGuard = new ReplayGuard();
    const messageId = 'msg-auth-12345';

    // First delivery should succeed
    const firstDelivery = await replayGuard.checkAndRemember(messageId);
    assert.strictEqual(firstDelivery, true, 'First delivery of the message should be valid');

    // Second delivery of the EXACT SAME message should fail
    const secondDelivery = await replayGuard.checkAndRemember(messageId);
    assert.strictEqual(secondDelivery, false, 'Second delivery of the same message ID must be rejected as a replay');
  });

  await t.test('ReplayGuard resets on new security epoch', async () => {
    let replayGuard = new ReplayGuard();
    const messageId = 'msg-auth-12345';

    assert.strictEqual(await replayGuard.checkAndRemember(messageId), true, 'First delivery');
    assert.strictEqual(await replayGuard.checkAndRemember(messageId), false, 'Already used in epoch 1');
    
    // Changing the epoch simulates a new session/machine generation where nonces restart
    // In our architecture, a new generation means a new ReplayGuard instance is created
    replayGuard = new ReplayGuard();
    const newEpochDelivery = await replayGuard.checkAndRemember(messageId);
    assert.strictEqual(newEpochDelivery, true, 'Message ID should be valid again in a completely new epoch');
  });
});

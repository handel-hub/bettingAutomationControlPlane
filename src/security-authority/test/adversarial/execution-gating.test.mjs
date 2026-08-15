// @ts-check

/**
 * DOMAIN CONTRACT: Execution Gating
 *
 * Threat model: An already running CDP proxy connection is active when authorization is revoked natively.
 * Attacker capability: Has an open TCP/Pipe stream to the browser that was previously authorized.
 * Attack objective: Continue executing commands after the Security Authority has transitioned to REVOKED or OFFLINE_GRACE expired.
 * Security boundary being attacked: SecureCdpProxy / NativeCore revocation synchronization.
 * Security invariant(s): 12 - Execution Gating, 08 - Revocation Priority.
 * Concrete attack operation: Attempting to read/write from a PassThrough stream after `NativeCore.setRevokedSync(true)` is called.
 * Expected defensive mechanism: SecureCdpProxy detects the revocation synchronously on data writes and engages the kill switch.
 * Expected observable result: Proxied streams are immediately destroyed; `null` is returned for subsequent reads.
 * What the test DOES NOT prove: Does not prove that the CDP target process itself is forcefully killed (that is RuntimeManager's job).
 */

import test from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'stream';
import { NativeCore } from '../../native/security-core.mjs';
import { SecureCdpProxy } from '../../execution/cdp-proxy.mjs';

test('Execution Gating Testing', async (t) => {
  await t.test('CDP Proxy synchronously destroys streams when revoked', async () => {
    const browserOut = new PassThrough();
    const browserIn = new PassThrough();
    const consumerOut = new PassThrough();
    const consumerIn = new PassThrough();

    let killCalled = false;
    SecureCdpProxy.proxyStreams(browserOut, browserIn, consumerOut, consumerIn, () => {
      killCalled = true;
    });

    // Revocation state is false
    NativeCore.setRevokedSync(false);
    
    // Write data, should proxy fine
    browserOut.write('data1');
    const chunk1 = consumerOut.read();
    assert.strictEqual(chunk1.toString(), 'data1');

    // Revoke the session natively
    NativeCore.setRevokedSync(true);

    // Write data, should trigger kill switch and block data
    browserOut.write('data2');
    const chunk2 = consumerOut.read();

    assert.strictEqual(chunk2, null); // Nothing was proxied
    assert.strictEqual(killCalled, true); // Kill switch was engaged
  });
});

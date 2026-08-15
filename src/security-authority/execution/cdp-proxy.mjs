// @ts-check

import { NativeCore } from '../native/security-core.mjs';

/**
 * Execution Gating Boundary.
 * This proxy sits between the Control Plane and the Browser/Runtime's --remote-debugging-pipe.
 * It synchronously evaluates cryptographic revocation state before forwarding ANY CDP traffic.
 */
export class SecureCdpProxy {
  /**
   * Proxies a pair of readable/writable streams (from the Browser's stdio)
   * to another pair of readable/writable streams (e.g. to the Control Plane consumer).
   * 
   * @param {NodeJS.ReadableStream} browserOut 
   * @param {NodeJS.WritableStream} browserIn 
   * @param {NodeJS.WritableStream} consumerOut 
   * @param {NodeJS.ReadableStream} consumerIn 
   * @param {Function} killRuntime Asynchronous kill switch if revocation is detected.
   */
  static proxyStreams(browserOut, browserIn, consumerOut, consumerIn, killRuntime) {
    
    // Proxy Browser -> Consumer
    browserOut.on('data', (chunk) => {
      // SYNCHRONOUS REVOCATION GATING
      if (NativeCore.isRevokedSync()) {
        console.warn("[SecureCdpProxy] CRITICAL: Execution gated. Session is revoked.");
        killRuntime();
        return;
      }
      consumerOut.write(chunk);
    });

    // Proxy Consumer -> Browser
    consumerIn.on('data', (chunk) => {
      // SYNCHRONOUS REVOCATION GATING
      if (NativeCore.isRevokedSync()) {
        console.warn("[SecureCdpProxy] CRITICAL: Execution gated. Session is revoked.");
        killRuntime();
        return;
      }
      browserIn.write(chunk);
    });
  }
}

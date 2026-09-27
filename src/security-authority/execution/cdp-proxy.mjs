// @ts-check

import { NativeCore } from '../native/security-core.mjs';

/**
 * Execution Gating Boundary.
 * This proxy sits between the Control Plane and the Browser/Runtime's --remote-debugging-pipe.
 * It synchronously evaluates cryptographic revocation state before forwarding ANY CDP traffic.
 */
export class SecureCdpProxy {
  /** @type {Set<{ browserOut: NodeJS.ReadableStream, browserIn: NodeJS.WritableStream, consumerOut: NodeJS.WritableStream, consumerIn: NodeJS.ReadableStream, killRuntime: Function }>} */
  static activeProxies = new Set();

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
    if (NativeCore.isRevokedSync()) {
      console.warn("[SecureCdpProxy] CRITICAL: Execution gated. Session is revoked at proxy initialization.");
      killRuntime();
      return;
    }

    const proxyRecord = { browserOut, browserIn, consumerOut, consumerIn, killRuntime };
    SecureCdpProxy.activeProxies.add(proxyRecord);

    const cleanup = () => {
      SecureCdpProxy.activeProxies.delete(proxyRecord);
    };

    browserOut.once('close', cleanup);
    browserIn.once('close', cleanup);
    consumerOut.once('close', cleanup);
    consumerIn.once('close', cleanup);

    // Proxy Browser -> Consumer
    browserOut.on('data', (chunk) => {
      // SYNCHRONOUS REVOCATION GATING
      if (NativeCore.isRevokedSync()) {
        console.warn("[SecureCdpProxy] CRITICAL: Execution gated. Session is revoked.");
        SecureCdpProxy.activeProxies.delete(proxyRecord);
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
        SecureCdpProxy.activeProxies.delete(proxyRecord);
        killRuntime();
        return;
      }
      browserIn.write(chunk);
    });
  }

  /**
   * Immediately severs all active CDP proxy connections and terminates runtimes.
   */
  static closeAll() {
    const proxies = Array.from(SecureCdpProxy.activeProxies);
    SecureCdpProxy.activeProxies.clear();
    for (const p of proxies) {
      try {
        p.killRuntime();
      } catch (err) {
        console.error("[SecureCdpProxy] Error killing runtime during closeAll:", err);
      }
      try {
        if (typeof p.consumerOut?.end === 'function') p.consumerOut.end();
        if (typeof p.browserIn?.end === 'function') p.browserIn.end();
      } catch {}
    }
  }
}

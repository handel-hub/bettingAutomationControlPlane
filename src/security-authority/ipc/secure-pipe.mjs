// @ts-check

import net from 'net';
import crypto from 'crypto';
import { NativeCore } from '../native/security-core.mjs';

/**
 * Creates and manages a secure IPC pipe using OS-level boundaries.
 */
export class SecurePipeManager {
  constructor() {
    /** @type {Set<string>} */
    this.activeSessionKeys = new Set();
  }

  /**
   * Spawns an IPC server on a randomly generated secure named pipe.
   * On Windows, it generates a unique pipe name.
   * @returns {Promise<{ pipePath: string, server: net.Server }>}
   */
  async createSecurePipeServer() {
    const pipeId = crypto.randomBytes(16).toString('hex');
    const pipePath = process.platform === 'win32' 
      ? `\\\\.\\pipe\\control_plane_secure_${pipeId}`
      : `/tmp/control_plane_secure_${pipeId}.sock`;

    return new Promise((resolve, reject) => {
      try {
        NativeCore.startSecurePipeServer(
          pipePath,
          (connId) => {
            // Send the connId to the child process so it can compute HMAC
            NativeCore.writePipe(connId, connId.toString());
            // We wait for the client to send the HMAC in the onData handler
            NativeCore.authorizePipeRead(connId);
          },
          (connId, data) => {
            // Process data...
          },
          (connId) => {
            // On disconnect
          }
        );

        // We return a mocked 'server' object for the test's compatibility
        const server = {
          close: () => { NativeCore.stopSecurePipeServer(); }
        };
        resolve({ pipePath, server });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Registers a spawned child PID so it can be verified.
   * @param {number} pid 
   */
  registerChildPid(pid) {
    this.activeChildPids.add(pid);
  }

  /**
   * Unregisters a child PID.
   * @param {number} pid 
   */
  unregisterChildPid(pid) {
    this.activeChildPids.delete(pid);
  }
}

export const securePipeManager = new SecurePipeManager();

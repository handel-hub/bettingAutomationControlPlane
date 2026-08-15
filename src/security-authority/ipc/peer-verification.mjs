// @ts-check

import { NativeCore } from '../native/security-core.mjs';

/**
 * Validates the origin of IPC connections to ensure only authenticated
 * child processes can connect to the Control Plane sockets.
 * Uses OS-level primitives (GetNamedPipeClientProcessId) to verify the client.
 */
export class IpcPeerVerification {
  /**
   * Verifies the connecting peer's PID against known spawned processes.
   * Extracts the true PID from the OS pipe handle using the connection ID.
   * @param {number} connId The native pipe connection ID
   * @param {Set<number>} activeChildPids 
   * @returns {boolean}
   */
  verifyPeerPid(connId, activeChildPids) {
    if (typeof connId !== 'number' || !activeChildPids) return false;
    
    try {
      const clientPid = NativeCore.getNamedPipeClientProcessId(connId);
      return activeChildPids.has(clientPid);
    } catch (err) {
      console.error("[IpcPeerVerification] Failed to resolve peer process ID:", err);
      return false;
    }
  }
}

export const ipcPeerVerification = new IpcPeerVerification();

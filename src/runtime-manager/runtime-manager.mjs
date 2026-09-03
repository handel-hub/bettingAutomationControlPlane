// @ts-check

import { executionAuthorization } from './execution-authorization.mjs';
import { runtimeHeartbeat } from './heartbeat.mjs';
import { NativeCore } from '../security-authority/native/security-core.mjs';
import { CommandRouter } from '../command/commandRouter.mjs';

/**
 * Orchestrates the spawning, monitoring, and termination of 
 * automated betting Runtime instances using NativeCore for OS security.
 */
export class RuntimeManager {
  constructor() {
    /** @type {Set<number>} */
    this.activeRuntimes = new Set();
    this.pipeName = '\\\\.\\pipe\\control_plane_secure_ipc';
    this.serverStarted = false;
    this.router = new CommandRouter();
  }

  ensureServerStarted() {
    if (this.serverStarted) return;
    
    NativeCore.startSecurePipeServer(
      this.pipeName,
      (connId) => {
        console.log(`[RuntimeManager] Native IPC Client Connected: ${connId}`);
      },
      (connId, data) => {
        try {
          const payload = JSON.parse(data);
          if (payload && payload.type === 'HEARTBEAT' && payload.pid) {
            runtimeHeartbeat.recordHeartbeat(payload.pid);
          } else {
            this.router.route(payload);
          }
        } catch (e) {
          console.error(`[RuntimeManager] Failed to route framed IPC payload: ${e}`);
        }
      },
      (connId) => {
        console.log(`[RuntimeManager] Native IPC Client Disconnected: ${connId}`);
      }
    );
    this.serverStarted = true;
  }

  /**
   * Attempts to spawn a new runtime instance, gated by Security Authority.
   */
  spawnRuntime() {
    if (!executionAuthorization.canStartAutomation()) {
      throw new Error("Security Authority denied automation start");
    }

    this.ensureServerStarted();

    const pid = NativeCore.spawnExecutionProcess(this.pipeName, (exitedPid) => {
      this.activeRuntimes.delete(exitedPid);
      console.log(`[RuntimeManager] Process ${exitedPid} exited.`);
    });
    
    this.activeRuntimes.add(pid);
    runtimeHeartbeat.recordHeartbeat(pid);
    
    return pid;
  }

  /**
   * Terminates a specific runtime instance via NativeCore.
   * @param {number} pid 
   */
  terminateRuntime(pid) {
    if (this.activeRuntimes.has(pid)) {
      NativeCore.terminateExecutionProcess(pid);
      this.activeRuntimes.delete(pid);
    }
  }

  /**
   * Terminates all instances.
   */
  terminateAll() {
    for (const pid of this.activeRuntimes) {
      this.terminateRuntime(pid);
    }
  }
}

export const runtimeManager = new RuntimeManager();

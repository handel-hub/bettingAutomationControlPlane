// @ts-check

import { executionAuthorization } from './execution-authorization.mjs';
import { runtimeHeartbeat } from './heartbeat.mjs';
import { spawn } from 'child_process';
import crypto from 'crypto';

/**
 * Orchestrates the spawning, monitoring, and termination of 
 * automated betting Runtime instances in isolated processes.
 */
export class RuntimeManager {
  constructor() {
    /** @type {Map<number, import('child_process').ChildProcess>} */
    this.activeRuntimes = new Map();
  }

  /**
   * Attempts to spawn a new runtime instance, gated by Security Authority.
   */
  spawnRuntime() {
    if (!executionAuthorization.canStartAutomation()) {
      throw new Error("Security Authority denied automation start");
    }

    const sessionKey = crypto.randomBytes(32);
    
    // Spawn the isolated runtime process, passing the session key via stdin
    const child = spawn('node', ['path/to/runtime/entry.mjs'], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    
    child.stdin.write(sessionKey);

    if (child.pid) {
      this.activeRuntimes.set(child.pid, child);
      runtimeHeartbeat.recordHeartbeat(child.pid);

      child.on('message', (msg) => {
        // Handle heartbeat and IPC
        // @ts-ignore
        if (msg && msg.type === 'HEARTBEAT') {
          // @ts-ignore
          runtimeHeartbeat.recordHeartbeat(child.pid);
        }
      });

      child.on('exit', () => {
        // @ts-ignore
        this.activeRuntimes.delete(child.pid);
      });
    }

    return child;
  }

  /**
   * Terminates a specific runtime instance.
   * @param {number} pid 
   */
  terminateRuntime(pid) {
    const child = this.activeRuntimes.get(pid);
    if (child) {
      child.kill('SIGKILL');
      this.activeRuntimes.delete(pid);
    }
  }

  /**
   * Terminates all instances.
   */
  terminateAll() {
    for (const pid of this.activeRuntimes.keys()) {
      this.terminateRuntime(pid);
    }
  }
}

export const runtimeManager = new RuntimeManager();

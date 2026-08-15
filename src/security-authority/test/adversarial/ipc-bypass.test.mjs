// @ts-check

/**
 * DOMAIN CONTRACT: IPC Bypass
 *
 * Threat model: Malicious local process attempting to hijack or connect to the Control Plane's IPC pipe.
 * Attacker capability: Can execute arbitrary code locally under the same or different OS user, can attempt to open Named Pipes.
 * Attack objective: Send unauthorized commands directly to the Chrome instance or inject fake results into the Control Plane.
 * Security boundary being attacked: SecurePipeManager and OS-level Named Pipe Access Control.
 * Security invariant(s): 13 - Local IPC Isolation.
 * Concrete attack operation: A newly spawned process (not in the authorized PID list) attempts to connect to the Pipe.
 * Expected defensive mechanism: SecurePipeManager intercepts the connection, checks peer PID, and actively destroys the socket.
 * Expected observable result: The unauthorized child process receives an immediate ECONNRESET or socket close event.
 * What the test DOES NOT prove: Does not prove that a highly privileged attacker (e.g., SYSTEM) cannot hook the Node.js process memory.
 * UNVERIFIED: OS-level ACLs (e.g. Windows SECURITY_DESCRIPTOR) are not fully asserted here, only the Node.js peer-PID gating is verified.
 */

import test from 'node:test';
import assert from 'node:assert';
import net from 'net';
import { spawn } from 'child_process';
import { securePipeManager } from '../../ipc/secure-pipe.mjs';

test('IPC Bypass Testing', async (t) => {
  await t.test('SecurePipeManager rejects connections from unauthorized PIDs', async () => {
    // 1. Create secure pipe server
    const { pipePath, server } = await securePipeManager.createSecurePipeServer();

    // 2. Spawn an unauthorized child process that tries to connect to the pipe
    const script = `
      const net = require('net');
      const socket = net.connect('${pipePath.replace(/\\/g, '\\\\')}');
      socket.on('error', (err) => { process.exit(1); });
      socket.on('close', () => { process.exit(2); });
      socket.write('hello');
    `;

    const child = spawn(process.execPath, ['-e', script]);
    
    // Do NOT register the child PID in securePipeManager
    // securePipeManager.registerChildPid(child.pid);

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    server.close();

    // The connection should be instantly destroyed by the server, 
    // causing the socket 'close' or 'error' event to fire in the child.
    // Exit code 1 or 2 implies rejection.
    assert.ok(exitCode === 1 || exitCode === 2, 'Unauthorized connection should be rejected and socket closed.');
  });
});

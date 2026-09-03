// @ts-check

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { NativeCore } from '../../native/security-core.mjs';

test('IPC Bypass Testing', async (t) => {
  await t.test('NativeCore rejects connections from un-spawned PIDs', async () => {
    const pipePath = '\\\\.\\pipe\\control_plane_secure_test_pipe';

    // 1. Ensure server is started via NativeCore directly
    NativeCore.startSecurePipeServer(
      pipePath,
      (connId) => {},
      (connId, data) => {},
      (connId) => {}
    );

    // 2. Spawn an unauthorized child process that tries to connect to the pipe
    const script = `
      const net = require('net');
      const socket = net.connect('${pipePath.replace(/\\/g, '\\\\')}');
      socket.on('error', (err) => { process.exit(1); });
      socket.on('close', () => { process.exit(2); });
      setTimeout(() => process.exit(0), 1000);
    `;

    const child = spawn(process.execPath, ['-e', script]);
    
    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    NativeCore.stopSecurePipeServer();

    // The connection should be instantly destroyed by the server since the PID is not in ACTIVE_EXECUTION_HANDLES
    // Exit code 1 or 2 implies rejection.
    assert.ok(exitCode === 1 || exitCode === 2, 'Unauthorized connection should be rejected and socket closed.');
  });
});

// acp-bytenode-compat-lab/tests/m4-named-pipe-ipc.mjs
// M4: Windows Named Pipe IPC & Native Handle Security tests

import { spawn } from 'node:child_process';
import process from 'node:process';
import { NativeCore } from '../../src/security-authority/native/security-core.mjs';

export function registerM4Tests(harness) {
  const pipePath = `\\\\.\\pipe\\acp_compat_lab_pipe_${process.pid}`;

  harness.test('M4-001', 'NativeCore named pipe server lifecycle', 'M4-NamedPipeIPC', async () => {
    NativeCore.init();
    NativeCore.startSecurePipeServer(
      pipePath,
      (connId) => {},
      (connId, data) => {},
      (connId) => {}
    );

    NativeCore.stopSecurePipeServer();
    return { lifecycleClean: true };
  });

  harness.test('M4-002', 'NativeCore named pipe security gate rejects un-spawned PIDs', 'M4-NamedPipeIPC', async () => {
    NativeCore.startSecurePipeServer(
      pipePath,
      (connId) => {},
      (connId, data) => {},
      (connId) => {}
    );

    const script = `
      const net = require('net');
      const socket = net.connect('${pipePath.replace(/\\/g, '\\\\')}');
      socket.on('error', () => process.exit(1));
      socket.on('close', () => process.exit(2));
      setTimeout(() => process.exit(0), 1000);
    `;

    const child = spawn(process.execPath, ['-e', script]);
    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    NativeCore.stopSecurePipeServer();

    if (exitCode !== 1 && exitCode !== 2) {
      throw new Error(`Expected connection rejection (code 1 or 2), received exit code ${exitCode}`);
    }

    return { connectionRejectedAsExpected: true, exitCode };
  });

  harness.test('M4-003', 'NativeCore monotonic counter tracking', 'M4-NamedPipeIPC', async () => {
    const c1 = NativeCore.getMonotonicCounter();
    const c2 = NativeCore.incrementMonotonicCounter();
    const c3 = NativeCore.getMonotonicCounter();

    if (c2 !== c1 + 1 || c3 !== c2) {
      throw new Error(`Counter mismatch: c1=${c1}, c2=${c2}, c3=${c3}`);
    }

    return { initial: c1, incremented: c2, current: c3 };
  });
}

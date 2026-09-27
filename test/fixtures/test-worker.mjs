// @ts-check
import { SecureIpcClient } from '../../src/runtime-manager/ipc-client.mjs';

async function main() {
  const pipePath = process.env.CONTROL_PLANE_PIPE;
  if (!pipePath) {
    process.exit(1);
  }

  // 1. Read the 32-byte ephemeral session key from stdin
  const sessionKey = await SecureIpcClient.readSessionKeyFromStdin();

  // 2. Connect to the pipe and authenticate
  const client = new SecureIpcClient(pipePath);
  await client.connect(sessionKey);

  // 3. Send initial heartbeat
  client.send({
    type: 'HEARTBEAT',
    pid: process.pid,
    timestamp: Date.now()
  });

  client.on('message', (msg) => {
    if (msg.type === 'ECHO_LARGE') {
      client.send({
        type: 'ECHO_ACK',
        length: msg.data ? msg.data.length : 0
      });
    }
  });
}

main().catch((err) => {
  console.error('[test-worker fatal error]:', err);
  process.exit(1);
});

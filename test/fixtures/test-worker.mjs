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
    // Keep running until terminated
  });
}

main().catch((err) => {
  console.error('[test-worker fatal error]:', err);
  process.exit(1);
});

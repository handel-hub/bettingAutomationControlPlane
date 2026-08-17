import net from 'net';
import crypto from 'crypto';

export class IpcHandshakeClient {
  /**
   * Reads exactly 32 bytes from stdin to get the session key.
   * @returns {Promise<Buffer>}
   */
  static async readSessionKeyFromStdin() {
    return new Promise((resolve, reject) => {
      const onReadable = () => {
        const chunk = process.stdin.read(32);
        if (chunk !== null) {
          process.stdin.removeListener('readable', onReadable);
          resolve(chunk);
        }
      };
      process.stdin.on('readable', onReadable);
      process.stdin.on('error', reject);
      process.stdin.on('end', () => reject(new Error('stdin ended before session key read')));
    });
  }

  /**
   * Connects to the pipe and performs HMAC auth.
   * @param {string} pipePath
   * @param {Buffer} sessionKey
   * @returns {Promise<net.Socket>}
   */
  static async connectAndAuthenticate(pipePath, sessionKey) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      
      socket.once('data', (connIdBuf) => {
        try {
          const hmac = crypto.createHmac('sha256', sessionKey);
          hmac.update('IPC_AUTH' + connIdBuf.toString('utf8'));
          const authMac = hmac.digest();
          socket.write(authMac);
          resolve(socket);
        } catch (e) {
          reject(e);
        }
      });
      
      socket.on('error', reject);
    });
  }
}

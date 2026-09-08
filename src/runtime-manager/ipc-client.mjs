// @ts-check
import net from 'node:net';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { createExecutionEnvelope, validateExecutionEnvelope, ExecutionMessageType } from './executionProtocol.mjs';

/**
 * Secure IPC Client that connects to the Control Plane Windows Named Pipe.
 * Performs the initial 32-byte mutual HMAC-SHA256 authentication handshake
 * using the ephemeral session key received via stdin.
 */
export class SecureIpcClient extends EventEmitter {
  /**
   * @param {string} [pipePath]
   */
  constructor(pipePath) {
    super();
    this.pipePath = pipePath || process.env.CONTROL_PLANE_PIPE || '\\\\.\\pipe\\control_plane_secure_ipc';
    /** @type {net.Socket | null} */
    this.socket = null;
    this.authenticated = false;
    this._rxBuffer = Buffer.alloc(0);
    this._heartbeatInterval = null;
  }

  /**
   * Reads the 32-byte session key from process.stdin.
   * @returns {Promise<Buffer>}
   */
  static async readSessionKeyFromStdin() {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalLength = 0;

      const onData = (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
        if (totalLength >= 32) {
          cleanup();
          const fullBuf = Buffer.concat(chunks);
          resolve(fullBuf.subarray(0, 32));
        }
      };

      const onEnd = () => {
        cleanup();
        const fullBuf = Buffer.concat(chunks);
        if (fullBuf.length >= 32) {
          resolve(fullBuf.subarray(0, 32));
        } else {
          reject(new Error(`Failed to read 32-byte session key from stdin, got ${fullBuf.length} bytes`));
        }
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      function cleanup() {
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('end', onEnd);
        process.stdin.removeListener('error', onError);
      }

      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onError);

      process.stdin.resume();

      const buffered = process.stdin.read();
      if (buffered) {
        onData(buffered);
      }
    });
  }

  /**
   * Connects to the Control Plane and performs the HMAC-SHA256 handshake.
   * @param {Buffer} sessionKey - 32-byte ephemeral key from stdin
   * @returns {Promise<void>}
   */
  async connect(sessionKey) {
    if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 32) {
      throw new Error('Session key must be exactly 32 bytes');
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath, () => {
        // Compute mutual HMAC-SHA256 response: HMAC(sessionKey, "IPC_AUTH" + process.pid)
        const mac = crypto.createHmac('sha256', sessionKey);
        mac.update('IPC_AUTH' + process.pid);
        const hmacResponse = mac.digest(); // 32 bytes

        // Transmit authentication token immediately
        socket.write(hmacResponse, (err) => {
          if (err) {
            reject(err);
            return;
          }
          this.authenticated = true;
          this.socket = socket;
          this.emit('authenticated');
          resolve();
        });
      });

      socket.on('data', (chunk) => {
        this._handleData(chunk);
      });

      socket.on('error', (err) => {
        this.emit('error', err);
        if (!this.authenticated) {
          reject(err);
        }
      });

      socket.on('close', () => {
        this.authenticated = false;
        this.socket = null;
        if (this._heartbeatInterval) {
          clearInterval(this._heartbeatInterval);
          this._heartbeatInterval = null;
        }
        this.emit('close');
      });
    });
  }

  /**
   * Sends a typed ExecutionEnvelope to the Control Plane.
   * @param {string} type - Member of ExecutionMessageType
   * @param {any} payload - Payload data
   * @param {string} [traceId] - Distributed trace identifier
   */
  sendEnvelope(type, payload, traceId) {
    const envelope = createExecutionEnvelope(type, payload, traceId, 'EXECUTION_PLANE');
    return this.send(envelope);
  }

  /**
   * Sends a JSON message with a 4-byte big-endian length prefix.
   * @param {any} message
   */
  send(message) {
    if (!this.socket || !this.authenticated) {
      throw new Error('IPC client is not connected or authenticated');
    }

    const jsonStr = JSON.stringify(message);
    const payload = Buffer.from(jsonStr, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);

    return this.socket.write(Buffer.concat([header, payload]));
  }

  /**
   * Starts periodic heartbeat transmission to the Control Plane.
   * @param {number} [intervalMs=3000]
   * @param {function(): object} [telemetryProvider]
   */
  startHeartbeat(intervalMs = 3000, telemetryProvider = () => ({})) {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    this._heartbeatInterval = setInterval(() => {
      if (this.authenticated) {
        try {
          const telemetry = telemetryProvider();
          this.sendEnvelope(ExecutionMessageType.HEARTBEAT, {
            pid: process.pid,
            timestamp: Date.now(),
            ...telemetry
          });
        } catch {
          // Ignore heartbeat send failure
        }
      }
    }, intervalMs);
    if (this._heartbeatInterval.unref) {
      this._heartbeatInterval.unref();
    }
  }

  /**
   * Internal parser for 4-byte framed messages.
   * @param {Buffer} chunk
   * @private
   */
  _handleData(chunk) {
    this._rxBuffer = Buffer.concat([this._rxBuffer, chunk]);

    while (this._rxBuffer.length >= 4) {
      const msgLen = this._rxBuffer.readUInt32BE(0);
      if (this._rxBuffer.length < 4 + msgLen) {
        // Wait for more chunks to complete the message frame
        break;
      }

      const frameData = this._rxBuffer.subarray(4, 4 + msgLen);
      this._rxBuffer = this._rxBuffer.subarray(4 + msgLen);

      try {
        const jsonStr = frameData.toString('utf8');
        const rawEnvelope = JSON.parse(jsonStr);
        const { valid, envelope } = validateExecutionEnvelope(rawEnvelope);
        if (valid) {
          this.emit('envelope', envelope);
          this.emit('message', envelope);
        } else {
          this.emit('message', rawEnvelope);
        }
      } catch (e) {
        this.emit('error', new Error(`Corrupted frame payload: ${e.message}`));
      }
    }
  }

  /**
   * Disconnects the IPC client.
   */
  disconnect() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.authenticated = false;
  }
}

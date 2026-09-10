// @ts-check
import EventEmitter from 'node:events';
import { NativeCore } from '../../security-authority/native/security-core.mjs';

/**
 * Encapsulates Windows Named Pipe IPC socket management, client tracking,
 * and wire framing for the Execution Plane boundary.
 */
export class PipeTransport extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.pipeName]
   * @param {typeof NativeCore} [options.nativeCore]
   * @param {object} [options.customAdapter] - Pluggable mock transport for unit testing
   */
  constructor({
    pipeName = '\\\\.\\pipe\\control_plane_secure_ipc',
    nativeCore = NativeCore,
    customAdapter = null
  } = {}) {
    super();
    this.pipeName = pipeName;
    this.native = nativeCore;
    this.customAdapter = customAdapter;
    /** @type {Set<number>} */
    this.activeConnections = new Set();
    this.isListening = false;
  }

  /**
   * Starts the named pipe server listener.
   */
  startServer() {
    if (this.isListening) return;

    if (this.customAdapter) {
      this.customAdapter.startServer(
        this.pipeName,
        (connId) => this._onConnect(connId),
        (connId, data) => this._onData(connId, data),
        (connId) => this._onDisconnect(connId)
      );
      this.isListening = true;
      return;
    }

    try {
      this.native.startSecurePipeServer(
        this.pipeName,
        (connId) => this._onConnect(connId),
        (connId, data) => this._onData(connId, data),
        (connId) => this._onDisconnect(connId)
      );
      this.isListening = true;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Stops the named pipe server and drops connections.
   */
  stopServer() {
    if (!this.isListening) return;

    if (this.customAdapter) {
      if (typeof this.customAdapter.stopServer === 'function') {
        this.customAdapter.stopServer();
      }
    } else {
      try {
        this.native.stopSecurePipeServer();
      } catch {
        // Ignore errors on shutdown
      }
    }

    this.activeConnections.clear();
    this.isListening = false;
  }

  /**
   * Writes a string payload to a specific connection.
   * @param {number} connId
   * @param {string} payloadString
   * @returns {boolean}
   */
  write(connId, payloadString) {
    if (!this.activeConnections.has(connId)) {
      return false;
    }

    if (this.customAdapter) {
      return this.customAdapter.writePipe(connId, payloadString);
    }

    try {
      return this.native.writePipe(connId, payloadString);
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Broadcasts a string payload to all active client connections.
   * @param {string} payloadString
   * @returns {number} Number of successful writes
   */
  broadcast(payloadString) {
    let sentCount = 0;
    for (const connId of this.activeConnections) {
      if (this.write(connId, payloadString)) {
        sentCount++;
      }
    }
    return sentCount;
  }

  /**
   * Returns true if at least one client is connected.
   * @returns {boolean}
   */
  isConnected() {
    return this.activeConnections.size > 0;
  }

  /**
   * Returns copy of active connection IDs.
   * @returns {number[]}
   */
  getActiveConnections() {
    return Array.from(this.activeConnections);
  }

  /**
   * @param {number} connId
   * @private
   */
  _onConnect(connId) {
    this.activeConnections.add(connId);
    this.emit('connection', connId);
  }

  /**
   * @param {number} connId
   * @param {string} data
   * @private
   */
  _onData(connId, data) {
    this.emit('data', connId, data);
  }

  /**
   * @param {number} connId
   * @private
   */
  _onDisconnect(connId) {
    this.activeConnections.delete(connId);
    this.emit('disconnection', connId);
  }
}

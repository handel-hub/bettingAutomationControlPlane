// @ts-check
import EventEmitter from 'node:events';

/**
 * High-fidelity in-memory mock transport for testing boundary components
 * without touching Windows Named Pipes or OS sockets.
 */
export class MockTransport extends EventEmitter {
  constructor() {
    super();
    this.activeConnections = new Set();
    this.sentPayloads = [];
    this.isListening = false;
    this._onConnect = null;
    this._onData = null;
    this._onDisconnect = null;
  }

  startServer(pipeName, onConnect, onData, onDisconnect) {
    this.isListening = true;
    this._onConnect = onConnect;
    this._onData = onData;
    this._onDisconnect = onDisconnect;
  }

  stopServer() {
    this.isListening = false;
    this.activeConnections.clear();
  }

  writePipe(connId, payloadString) {
    if (!this.activeConnections.has(connId)) return false;
    this.sentPayloads.push({ connId, payloadString, timestamp: Date.now() });
    return true;
  }

  // --- Test Simulation Helpers ---

  simulateClientConnect(connId = 1) {
    this.activeConnections.add(connId);
    if (this._onConnect) {
      this._onConnect(connId);
    }
  }

  simulateIncomingData(connId, payloadString) {
    if (this._onData) {
      this._onData(connId, payloadString);
    }
  }

  simulateClientDisconnect(connId = 1) {
    this.activeConnections.delete(connId);
    if (this._onDisconnect) {
      this._onDisconnect(connId);
    }
  }

  getLastSentPayload() {
    if (this.sentPayloads.length === 0) return null;
    const last = this.sentPayloads[this.sentPayloads.length - 1];
    return {
      ...last,
      parsed: JSON.parse(last.payloadString)
    };
  }

  clearSent() {
    this.sentPayloads = [];
  }
}

// @ts-check
import { WebSocketServer, WebSocket } from 'ws';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { commandRouter } from '../../command/commandRouter.mjs';
import { logger } from '../../shared/logging.mjs';

class WsStreamer {
  constructor() {
    /** @type {WebSocketServer | null} */
    this.wss = null;
  }

  /**
   * Binds WebSocket server to existing HTTP server.
   * @param {import('http').Server} httpServer
   */
  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws/v1/events' });

    this.wss.on('connection', async (ws, req) => {
      logger.info({ remoteAddress: req.socket.remoteAddress }, '[WebSocket] Client connected on /ws/v1/events');

      // 1. Send initial state handshake matching Section 5
      try {
        const automationSnapshot = await workspaceAggregator.getSnapshot();
        const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
        const settingsSnapshot = await repositoryFactory.getSettingsRepo().getSnapshot();

        this.send(ws, 'app:state', 'Authorized');
        this.send(ws, 'automation:snapshot', automationSnapshot);
        this.send(ws, 'billing:snapshot', billingSnapshot);
        this.send(ws, 'settings:snapshot', settingsSnapshot);
      } catch (err) {
        logger.error({ err }, '[WebSocket] Error sending initial handshake');
      }

      // 2. Handle inbound command intents from client
      ws.on('message', async (data) => {
        try {
          const raw = data.toString('utf8');
          await commandRouter.route(raw);
        } catch (err) {
          logger.warn({ err: err.message }, '[WebSocket] Error handling inbound client message');
          this.send(ws, 'app:error', { error: err.message });
        }
      });

      ws.on('close', () => {
        logger.debug('[WebSocket] Client disconnected');
      });
    });
  }

  /**
   * Broadcasts a typed envelope to all connected clients.
   * @param {string} topic
   * @param {any} payload
   */
  broadcast(topic, payload) {
    if (!this.wss) return;
    const msg = JSON.stringify({
      topic,
      timestamp: new Date().toISOString(),
      payload
    });

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /**
   * Sends a message to a specific client.
   * @param {WebSocket} ws
   * @param {string} topic
   * @param {any} payload
   */
  send(ws, topic, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        topic,
        timestamp: new Date().toISOString(),
        payload
      }));
    }
  }

  /**
   * Closes the WebSocket server and terminates all active client sockets.
   * @returns {Promise<void>}
   */
  close() {
    if (!this.wss) return Promise.resolve();
    for (const client of this.wss.clients) {
      try {
        client.terminate();
      } catch (e) {}
    }
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      this.wss.close(done);
      setTimeout(done, 100).unref();
    });
  }
}

export const wsServer = new WsStreamer();

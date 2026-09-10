// @ts-check
import { WebSocketServer, WebSocket } from 'ws';
import { workspaceAggregator } from '../../state/workspaceAggregator.mjs';
import { repositoryFactory } from '../../repositories/repositoryFactory.mjs';
import { commandRouter } from '../../command/commandRouter.mjs';
import { logger } from '../../shared/logging.mjs';
import { isValidToken } from '../middleware/auth.mjs';
import { getSharedStateStore } from '../../state-store/sharedStateStore.mjs';
import { DEFAULT_STRATEGY_CATALOG } from '../../state-store/types/contracts.mjs';
import { operationTracker } from '../../state/operationTracker.mjs';

class WsStreamer {
  constructor() {
    /** @type {WebSocketServer | null} */
    this.wss = null;
    /** @type {Map<string, number>} domain revision tracking */
    this.revisions = new Map([
      ['automation', 1],
      ['accounts', 1],
      ['billing', 1],
      ['settings', 1],
      ['notifications', 1],
      ['catalogs', 1]
    ]);
  }

  /**
   * Binds WebSocket server to existing HTTP server.
   * @param {import('http').Server} httpServer
   */
  attach(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws/v1/events' });

    this.wss.on('connection', async (ws, req) => {
      // Authenticate WebSocket connection
      const parsedUrl = new URL(req.url || '', 'http://localhost');
      const token = req.headers['authorization'] || 
                    req.headers['x-acp-token'] || 
                    parsedUrl.searchParams.get('token') ||
                    req.headers['sec-websocket-protocol'];

      if (!isValidToken(token)) {
        logger.warn({ remoteAddress: req.socket.remoteAddress }, '[WebSocket] Unauthorized connection rejected');
        ws.close(4401, 'Unauthorized');
        return;
      }

      logger.info({ remoteAddress: req.socket.remoteAddress }, '[WebSocket] Client connected on /ws/v1/events');

      // 1. Send complete initial state handshake (Dual Emission: Atomic Prelude + Unpacked Topics)
      try {
        const store = getSharedStateStore();
        const automationSnapshot = await workspaceAggregator.getSnapshot();
        const billingSnapshot = await repositoryFactory.getBillingRepo().getSnapshot();
        const settingsSnapshot = await repositoryFactory.getSettingsRepo().getSnapshot();
        const accountsView = await repositoryFactory.getAccountsRepo().list({}, { offset: 0, limit: 50 });
        const notificationsData = await repositoryFactory.getNotificationsRepo().list({ unreadOnly: false, severity: 'ALL' });
        
        const runtimeState = {
          lifecycleState: 'Authorized',
          automationLifecycle: workspaceAggregator.lifecycle,
          automationMessage: workspaceAggregator.lifecycleMessage,
          automationCapabilities: automationSnapshot.capabilities,
          automationAccounts: automationSnapshot.accounts,
          systemStatus: automationSnapshot.systemStatus,
          globalActionPending: operationTracker.getCurrentPendingAction()
        };

        const preludePayload = store.getPreludeSnapshot(runtimeState);

        const customerCarePayload = {
          openTicketCount: 0,
          contactMethods: [
            { id: '1', title: 'Support Ticket', description: 'Create a new support request', actionType: 'INTERNAL_ROUTE', actionTarget: '/workspace/support/tickets/new', available: true },
            { id: '2', title: 'Live Chat', description: 'Chat with an agent', actionType: 'INTERNAL_ROUTE', actionTarget: '/workspace/support/chat', available: true },
            { id: '3', title: 'Discord Community', description: 'Join other users', actionType: 'EXTERNAL_LINK', actionTarget: 'https://discord.com', available: true }
          ],
          documentationState: { cached: true },
          documentationLastSync: new Date().toISOString(),
          systemHealthSummary: 'Healthy'
        };

        // Emit Protocol v2.0 monolithic atomic prelude
        this.send(ws, 'app:prelude', preludePayload.payload || preludePayload);

        // Emit backward-compatible individual domain topics
        this.send(ws, 'app:state', 'Authorized');
        this.send(ws, 'automation:snapshot', automationSnapshot);
        this.send(ws, 'billing:snapshot', billingSnapshot);
        this.send(ws, 'billing:plans', store.catalogs.getPlansCatalog());
        this.send(ws, 'platforms:registry', store.catalogs.getPlatformRegistry());
        this.send(ws, 'automation:strategy', store.catalogs.getStrategyCatalog() || DEFAULT_STRATEGY_CATALOG);
        this.send(ws, 'accounts:view', accountsView);
        this.send(ws, 'settings:snapshot', settingsSnapshot);
        this.send(ws, 'customerCare:snapshot', customerCarePayload);
        this.send(ws, 'notifications:snapshot', notificationsData);
        this.send(ws, 'system:update', { hasUpdateDownloaded: false, version: 'v0.2.0' });

      } catch (err) {
        logger.error({ err }, '[WebSocket] Error sending initial handshake');
      }

      // 2. Handle inbound command intents and heartbeat from client
      ws.on('message', async (data) => {
        try {
          const raw = data.toString('utf8');
          
          // Heartbeat check
          if (raw === 'ping') {
            this.send(ws, 'system:pong', { status: 'PONG', serverTime: new Date().toISOString() });
            return;
          }

          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {}

          if (parsed && (parsed.topic === 'system:ping' || parsed.type === 'PING')) {
            this.send(ws, 'system:pong', { status: 'PONG', serverTime: new Date().toISOString() });
            return;
          }

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
   * @param {string} [correlationId]
   */
  broadcast(topic, payload, correlationId) {
    if (!this.wss) return;

    // Determine domain for revision increment
    const domainPrefix = topic.split(':')[0] || 'system';
    const currentRev = (this.revisions.get(domainPrefix) || 1) + 1;
    this.revisions.set(domainPrefix, currentRev);

    const msg = JSON.stringify({
      protocolVersion: '2.0',
      topic,
      revision: currentRev,
      timestamp: new Date().toISOString(),
      ...(correlationId ? { correlationId } : {}),
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
   * @param {string} [correlationId]
   */
  send(ws, topic, payload, correlationId) {
    if (ws.readyState === WebSocket.OPEN) {
      const domainPrefix = topic.split(':')[0] || 'system';
      const currentRev = this.revisions.get(domainPrefix) || 1;

      ws.send(JSON.stringify({
        protocolVersion: '2.0',
        topic,
        revision: currentRev,
        timestamp: new Date().toISOString(),
        ...(correlationId ? { correlationId } : {}),
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

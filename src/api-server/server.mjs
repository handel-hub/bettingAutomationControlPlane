// @ts-check
import express from 'express';
import { createServer } from 'node:http';
import { traceIdMiddleware } from './middleware/traceId.mjs';
import { rawBodySaver } from './middleware/rawBody.mjs';
import { automationRouter } from './routes/automationRoutes.mjs';
import { accountsRouter } from './routes/accountsRoutes.mjs';
import { billingRouter } from './routes/billingRoutes.mjs';
import { settingsRouter } from './routes/settingsRoutes.mjs';
import { notificationsRouter } from './routes/notificationsRoutes.mjs';
import { systemRouter } from './routes/systemRoutes.mjs';
import { supportRouter } from './routes/supportRoutes.mjs';
import { wsServer } from './websocket/wsServer.mjs';
import { logger } from '../shared/logging.mjs';

export class ApiServer {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this._configure();
  }

  _configure() {
    // CORS headers
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id, X-Request-Id, x-paystack-signature');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Trace ID & JSON parsing with rawBody retention
    this.app.use(traceIdMiddleware);
    this.app.use(express.json({ verify: rawBodySaver }));

    // Mount 7 Domain Routers
    this.app.use('/api/v1/automation', automationRouter);
    this.app.use('/api/v1/accounts', accountsRouter);
    this.app.use('/api/v1/billing', billingRouter);
    this.app.use('/api/v1/settings', settingsRouter);
    this.app.use('/api/v1/notifications', notificationsRouter);
    this.app.use('/api/v1/system', systemRouter);
    this.app.use('/api/v1/support', supportRouter);

    // Attach WebSocket server
    wsServer.attach(this.server);
  }

  /**
   * Starts listening on the specified port.
   * @param {number} [port=8000]
   * @returns {Promise<number>}
   */
  async listen(port = 8000) {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        logger.info(`[ApiServer] Listening on HTTP & WebSocket port ${port}`);
        resolve(port);
      });
    });
  }

  /**
   * Closes the server.
   */
  async close() {
    if (typeof this.server.closeAllConnections === 'function') {
      this.server.closeAllConnections();
    }
    await wsServer.close();
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export const apiServer = new ApiServer();

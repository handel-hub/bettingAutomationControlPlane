// @ts-check
import express from 'express';
import { createServer } from 'node:http';
import { traceIdMiddleware } from './middleware/traceId.mjs';
import { rawBodySaver } from './middleware/rawBody.mjs';
import { ingressAuthMiddleware } from './middleware/auth.mjs';
import { automationRouter } from './routes/automationRoutes.mjs';
import { accountsRouter } from './routes/accountsRoutes.mjs';
import { billingRouter } from './routes/billingRoutes.mjs';
import { settingsRouter } from './routes/settingsRoutes.mjs';
import { notificationsRouter } from './routes/notificationsRoutes.mjs';
import { systemRouter } from './routes/systemRoutes.mjs';
import { supportRouter } from './routes/supportRoutes.mjs';
import { platformsRouter } from './routes/platformsRoutes.mjs';
import { preludeRouter } from './routes/preludeRoute.mjs';
import { authRouter } from './routes/authRoutes.mjs';
import { wsServer, isAllowedOrigin, resolveSystemIPv4Addresses } from './websocket/wsServer.mjs';
import { logger } from '../shared/logging.mjs';
import { SanitizerGate } from '../state-store/validation/SanitizerGate.mjs';

const DEFAULT_PORTS = [3000, 3001, 5000, 8000];

function buildAllowedOrigins() {
  const origins = new Set();
  const machineHostname = os.hostname().toLowerCase();
  const hosts = ['localhost', machineHostname, `${machineHostname}.local`, ...resolveSystemIPv4Addresses()];
  for (const host of hosts) {
    for (const port of DEFAULT_PORTS) {
      origins.add(`http://${host}:${port}`);
    }
  }
  if (process.env.ALLOWED_ORIGINS) {
    for (const custom of process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)) {
      origins.add(custom);
    }
  }
  return origins;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();

export class ApiServer {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this._configure();
  }

  _configure() {
    // CORS headers - validated origin check
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        if (isAllowedOrigin(origin) || ALLOWED_ORIGINS.has(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        } else {
          return res.status(403).json({ error: 'Forbidden: Untrusted Origin' });
        }
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id, X-Request-Id, x-paystack-signature, X-ACP-Token');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Trace ID & JSON parsing with rawBody retention
    this.app.use(traceIdMiddleware);
    this.app.use(express.json({ verify: rawBodySaver }));

    // Ingress Authentication Middleware
    this.app.use(ingressAuthMiddleware);

    // Ingress HTTP Request & Payload Logger
    this.app.use((req, res, next) => {
      if (req.method !== 'OPTIONS') {
        const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
        const payload = hasBody ? SanitizerGate.sanitize(req.body) : undefined;
        logger.info({
          traceId: req.traceId,
          method: req.method,
          url: req.originalUrl || req.url,
          payload
        }, `[HTTP Ingress] ${req.method} ${req.originalUrl || req.url}`);
      }
      next();
    });

    // Mount Domain Routers
    this.app.use('/api/v1/auth', authRouter);
    this.app.use('/api/v1/automation', automationRouter);
    this.app.use('/api/v1/accounts', accountsRouter);
    this.app.use('/api/v1/billing', billingRouter);
    this.app.use('/api/v1/settings', settingsRouter);
    this.app.use('/api/v1/notifications', notificationsRouter);
    this.app.use('/api/v1/system', systemRouter);
    this.app.use('/api/v1/support', supportRouter);
    this.app.use('/api/v1/platforms', platformsRouter);
    this.app.use('/api/v1/prelude', preludeRouter);

    // Attach WebSocket server
    wsServer.attach(this.server);
  }

  /**
   * Starts listening on the specified port and host (defaults to 0.0.0.0 for loopback + LAN/mobile access).
   * @param {number} [port=8000]
   * @param {string} [host='0.0.0.0']
   * @returns {Promise<number>}
   */
  async listen(port = 8000, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        logger.info(`[ApiServer] Listening on HTTP & WebSocket ${host}:${port}`);
        resolve(port);
      };

      this.server.once('error', onError);
      this.server.listen(port, host, onListening);
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

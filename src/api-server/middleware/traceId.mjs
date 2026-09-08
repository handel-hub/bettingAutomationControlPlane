// @ts-check
import { ulid } from 'ulid';

export function traceIdMiddleware(req, res, next) {
  const traceId = req.headers['x-trace-id'] || req.headers['x-request-id'] || (typeof ulid === 'function' ? ulid() : Date.now().toString(36));
  req.traceId = String(traceId);
  res.setHeader('X-Trace-Id', req.traceId);
  next();
}

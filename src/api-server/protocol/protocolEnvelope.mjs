// @ts-check
import { ulid } from 'ulid';

/**
 * Universal Protocol v2.0 Error Codes
 */
export const ProtocolErrorCode = {
  AUTH_UNAUTHORIZED: 'AUTH_001',
  AUTH_SESSION_EXPIRED: 'AUTH_002',
  AUTH_STEP_UP_REQUIRED: 'AUTH_003',
  CAPABILITY_DENIED: 'CAP_001',
  CAPABILITY_QUOTA_EXCEEDED: 'CAP_002',
  STATE_OCC_CONFLICT: 'STATE_001',
  STATE_INVALID_TRANSITION: 'STATE_002',
  VALIDATION_FAILED: 'VAL_001',
  VALIDATION_ZERO_SECRET_VIOLATION: 'VAL_002',
  EXECUTION_PLANE_UNAVAILABLE: 'EXEC_001',
  EXECUTION_TIMEOUT: 'EXEC_002',
  BACKEND_UNAVAILABLE: 'BACK_001'
};

/**
 * Builds a structured machine-readable ProtocolError.
 * 
 * @param {object} params
 * @param {string} params.code
 * @param {'AUTH' | 'CAPABILITY' | 'STATE' | 'VALIDATION' | 'EXECUTION' | 'BACKEND'} params.domain
 * @param {string} params.message
 * @param {string} [params.field]
 * @param {boolean} [params.retryable=false]
 * @param {Record<string, any>} [params.details]
 * @returns {object}
 */
export function buildProtocolError({ code, domain, message, field, retryable = false, details = {} }) {
  return {
    code,
    domain,
    message,
    ...(field ? { field } : {}),
    retryable,
    details
  };
}

/**
 * Builds an outbound ServerResponseEnvelope for HTTP responses and WS command ACKs.
 * 
 * @param {object} params
 * @param {string} [params.messageId]
 * @param {string} [params.correlationId]
 * @param {string} [params.causationId]
 * @param {'ACCEPTED' | 'COMPLETED' | 'REJECTED' | 'REQUIRES_STEP_UP' | 'ERROR'} [params.status='COMPLETED']
 * @param {number} [params.revision=1]
 * @param {any} [params.data]
 * @param {object} [params.error]
 * @returns {object}
 */
export function buildResponseEnvelope({
  messageId = ulid(),
  correlationId = ulid(),
  causationId = '',
  status = 'COMPLETED',
  revision = 1,
  data = null,
  error = null
}) {
  return {
    protocolVersion: '2.0',
    messageId,
    correlationId,
    causationId: causationId || correlationId,
    timestamp: new Date().toISOString(),
    status,
    revision,
    ...(data !== null && data !== undefined ? { data } : {}),
    ...(error ? { error } : {})
  };
}

/**
 * Builds an outbound ServerEventEnvelope for WebSocket broadcasts and deltas.
 * 
 * @param {object} params
 * @param {string} params.topic
 * @param {any} params.payload
 * @param {number} [params.revision=1]
 * @param {string} [params.correlationId]
 * @param {string} [params.messageId]
 * @returns {object}
 */
export function buildEventEnvelope({
  topic,
  payload,
  revision = 1,
  correlationId,
  messageId = ulid()
}) {
  return {
    protocolVersion: '2.0',
    messageId,
    ...(correlationId ? { correlationId } : {}),
    timestamp: new Date().toISOString(),
    topic,
    revision,
    payload
  };
}

/**
 * Validates an inbound client request envelope.
 * 
 * @param {any} rawEnvelope
 * @returns {{ valid: boolean; error?: string; envelope?: any }}
 */
export function validateClientRequestEnvelope(rawEnvelope) {
  if (!rawEnvelope || typeof rawEnvelope !== 'object') {
    return { valid: false, error: 'Request envelope must be an object' };
  }

  // Allow legacy requests without envelope if category and type or body exists
  if (!rawEnvelope.protocolVersion && !rawEnvelope.messageId) {
    return { valid: true, envelope: rawEnvelope };
  }

  if (rawEnvelope.protocolVersion && rawEnvelope.protocolVersion !== '2.0' && rawEnvelope.protocolVersion !== '1.0.0') {
    return { valid: false, error: `Unsupported protocolVersion: ${rawEnvelope.protocolVersion}` };
  }

  return { valid: true, envelope: rawEnvelope };
}

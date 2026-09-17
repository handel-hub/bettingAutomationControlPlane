// @ts-check
import { ulid } from 'ulid';

/**
 * Standardized Message Types for Control Plane <-> Execution Plane Communication.
 */
export const ExecutionMessageType = /** @type {const} */ ({
  // Inbound Requests (CP -> EP)
  INITIALIZE: 'LIFECYCLE:INITIALIZE',
  START_CLUSTER: 'LIFECYCLE:START_CLUSTER',
  STOP_CLUSTER: 'LIFECYCLE:STOP_CLUSTER',
  PLACE_BET: 'TACTICAL:PLACE_BET',
  CASH_OUT: 'TACTICAL:CASH_OUT',
  VALIDATE: 'TACTICAL:VALIDATE',
  RECONCILE_ORDER: 'TACTICAL:RECONCILE_ORDER',
  ACTIVATE_ACCOUNT: 'FLEET:ACTIVATE_ACCOUNT',
  DEACTIVATE_ACCOUNT: 'FLEET:DEACTIVATE_ACCOUNT',
  SET_BET_CYCLE: 'FLEET:SET_BET_CYCLE',
  UPDATE_POLICY: 'CONFIG:UPDATE_POLICY',
  RESET_POLICY: 'CONFIG:RESET_POLICY',
  CAPTURE_SNAPSHOT: 'DIAGNOSTIC:CAPTURE_SNAPSHOT',

  // Outbound Telemetry & Data (EP -> CP)
  HEARTBEAT: 'TELEMETRY:HEARTBEAT',
  STATE_CHANGED: 'LIFECYCLE:STATE_CHANGED',
  BROWSER_STATUS: 'FLEET:BROWSER_STATUS',
  OPERATION_ACK: 'TACTICAL:OPERATION_ACK',
  OPERATION_RESULT: 'TACTICAL:OPERATION_RESULT',
  RECONCILIATION_REPORT: 'TACTICAL:RECONCILIATION_REPORT',
  ODDS_TICK: 'DATA:ODDS_TICK',
  SNAPSHOT_DUMP: 'DATA:SNAPSHOT_DUMP',
  AUDIT_EVENT: 'SECURITY:AUDIT_EVENT',
  SYNC_METRICS: 'TELEMETRY:SYNC_METRICS',
  UNKNOWN_COMMAND: 'PROTOCOL:UNKNOWN_COMMAND'
});

/**
 * Standardized Machine-Readable Error Codes for Execution Plane Boundary.
 */
export const ExecutionErrorCode = /** @type {const} */ ({
  MALFORMED_COMMAND: 'EP_CMD_001',
  CONTRACT_VIOLATION: 'EP_CMD_002',
  INVALID_ENGINE_STATE: 'EP_STATE_001',
  ACCOUNT_BUSY: 'EP_STATE_002',
  SESSION_EXPIRED: 'EP_AUTH_001',
  LOGIN_FAILED: 'EP_AUTH_002',
  LOCATOR_NOT_FOUND: 'EP_DOM_001',
  OVERLAY_BLOCKED: 'EP_DOM_002',
  MARKET_SUSPENDED: 'EP_DOM_003',
  ODDS_DRIFT_INTERRUPT: 'EP_DOM_004',
  MAX_GES_GAPS_EXCEEDED: 'EP_SYNC_001',
  CONVERGENCE_TIMEOUT: 'EP_SYNC_002',
  HEAL_ATTEMPTS_EXHAUSTED: 'EP_RECOVERY_001',
  UNCERTAIN_OUTCOME: 'EP_TX_001'
});

/**
 * Formal 8-state Execution Results Taxonomy.
 */
export const ExecutionResultState = /** @type {const} */ ({
  ACCEPTED: 'ACCEPTED',
  STARTED: 'STARTED',
  PROGRESS: 'PROGRESS',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Creates a canonical execution envelope.
 * @template T
 * @param {string} type - Member of ExecutionMessageType
 * @param {T} payload - Business payload
 * @param {string} [traceId] - Distributed trace identifier
 * @param {'CONTROL_PLANE' | 'EXECUTION_PLANE'} [source='CONTROL_PLANE']
 * @returns {{ msgId: string, traceId: string, type: string, timestamp: number, source: string, payload: T }}
 */
export function createExecutionEnvelope(type, payload, traceId, source = 'CONTROL_PLANE') {
  if (!type || typeof type !== 'string') {
    throw new TypeError('Execution envelope requires a valid string type');
  }

  return {
    msgId: ulid(),
    traceId: traceId || ulid(),
    type,
    timestamp: Date.now(),
    source,
    payload: payload || /** @type {T} */ ({})
  };
}

/**
 * Validates an incoming execution envelope structure.
 * @param {any} raw
 * @returns {{ valid: boolean, envelope?: any, error?: string }}
 */
export function validateExecutionEnvelope(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Envelope must be a non-null object' };
  }

  const { msgId, traceId, type, timestamp, source, payload } = raw;

  if (typeof msgId !== 'string' || !msgId) {
    return { valid: false, error: 'Missing or invalid msgId (must be string)' };
  }
  if (typeof traceId !== 'string' || !traceId) {
    return { valid: false, error: 'Missing or invalid traceId (must be string)' };
  }
  if (typeof type !== 'string' || !type) {
    return { valid: false, error: 'Missing or invalid type (must be string)' };
  }
  if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp <= 0) {
    return { valid: false, error: 'Missing or invalid timestamp (must be positive number)' };
  }
  if (source !== 'CONTROL_PLANE' && source !== 'EXECUTION_PLANE') {
    return { valid: false, error: `Invalid source [${source}], must be CONTROL_PLANE or EXECUTION_PLANE` };
  }
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    return { valid: false, error: 'Missing or invalid payload (must be object)' };
  }

  return { valid: true, envelope: raw };
}

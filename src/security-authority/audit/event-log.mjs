// @ts-check

import crypto from 'crypto';
import { auditWriter } from './audit-writer.mjs';

/**
 * Validates that no secret material is included in the metadata.
 * Implements the never-log policy from canonical §40.
 * @param {Record<string, unknown>} metadata
 */
function scrubMetadata(metadata) {
  const forbiddenKeys = ['password', 'secret', 'key', 'token', 'credential', 'private'];
  for (const [k, v] of Object.entries(metadata)) {
    const lowerK = k.toLowerCase();
    if (forbiddenKeys.some(fk => lowerK.includes(fk))) {
      metadata[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      scrubMetadata(/** @type {Record<string, unknown>} */(v));
    }
  }
}

/**
 * Enqueues a security event for asynchronous, non-blocking cryptographic logging.
 * @param {string} eventType
 * @param {"INFO" | "WARN" | "SIGNIFICANT" | "CRITICAL"} severity
 * @param {any} stateData
 * @param {Record<string, unknown>} [metadata]
 * @returns {Promise<void>}
 */
export async function writeSecurityEvent(eventType, severity, stateData, metadata = {}) {
  const safeMetadata = structuredClone(metadata);
  scrubMetadata(safeMetadata);

  const eventRow = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    severity: severity,
    timestamp: new Date().toISOString(),
    session_generation: stateData && stateData.session ? stateData.session.session_generation : null,
    machine_generation: stateData && stateData.machine ? stateData.machine.machine_generation : null,
    authorization_revision: stateData && stateData.authorization ? stateData.authorization.authorization_revision : null,
    transaction_id: safeMetadata.transaction_id ? String(safeMetadata.transaction_id) : null,
    result: safeMetadata.result || "RECORDED",
    metadata: safeMetadata,
    prev_event_hash: null, // populated asynchronously by auditWriter
    event_hash: null       // populated asynchronously by auditWriter
  };

  // Push to the background worker to avoid blocking the main CP execution path
  auditWriter.enqueue(eventRow);
}

// @ts-check

import { StorageAdapter } from '../persistence/storage-adapter.mjs';

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
 * Writes a security event to the log.
 * @param {string} eventType
 * @param {"INFO" | "WARN" | "SIGNIFICANT" | "CRITICAL"} severity
 * @param {import('../state-machine/states.mjs').SecurityStateData} stateData
 * @param {Record<string, unknown>} metadata
 * @returns {Promise<void>}
 */
export async function writeSecurityEvent(eventType, severity, stateData, metadata) {
  const safeMetadata = structuredClone(metadata);
  scrubMetadata(safeMetadata);

  // In a real implementation this would integrate with StorageAdapter or Crypto to generate event_hash.
  // Using a mock hashing strategy for structural completion.
  const eventRow = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    severity: severity,
    timestamp: new Date().toISOString(),
    session_generation: stateData.state === 'OPERATIONAL' ? stateData.session.session_generation : null,
    machine_generation: stateData.state === 'OPERATIONAL' ? stateData.machine.machine_generation : null,
    authorization_revision: stateData.state === 'OPERATIONAL' ? stateData.authorization.authorization_revision : null,
    transaction_id: metadata.transaction_id ? String(metadata.transaction_id) : null,
    result: "RECORDED",
    metadata: safeMetadata,
    prev_event_hash: null, // to be populated by storage layer chain
    event_hash: "PENDING_HASH" // to be computed by storage layer
  };

  await StorageAdapter.writeEvent(eventRow);
}

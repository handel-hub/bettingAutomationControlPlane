// @ts-check

/**
 * Custom Error classes for the ACP State Store subsystem.
 */

export class StateStoreError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'STATE_STORE_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class RevisionConflictError extends StateStoreError {
  /**
   * @param {string} entityKey
   * @param {number} expectedRevision
   * @param {number} actualRevision
   */
  constructor(entityKey, expectedRevision, actualRevision) {
    super(
      `Optimistic Concurrency Conflict on [${entityKey}]: Expected revision ${expectedRevision}, but found revision ${actualRevision}.`,
      'ERR_REVISION_CONFLICT'
    );
    this.entityKey = entityKey;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class DatabaseCorruptError extends StateStoreError {
  /**
   * @param {string} details
   */
  constructor(details) {
    super(`Database integrity check failed: ${details}`, 'ERR_DB_CORRUPT');
    this.details = details;
  }
}

export class ValidationError extends StateStoreError {
  /**
   * @param {string} message
   * @param {any} [details]
   */
  constructor(message, details = null) {
    super(message, 'ERR_VALIDATION_FAILED');
    this.details = details;
  }
}

export class SecurityViolationError extends StateStoreError {
  /**
   * @param {string} field
   */
  constructor(field) {
    super(`Security policy violation: Prohibited secret field '${field}' detected in state payload.`, 'ERR_SECRET_VIOLATION');
    this.field = field;
  }
}

export class UnhydratedStateError extends StateStoreError {
  /**
   * @param {string} domain
   */
  constructor(domain) {
    super(`Domain [${domain}] cannot be accessed prior to State Store hydration.`, 'ERR_UNHYDRATED_STATE');
    this.domain = domain;
  }
}

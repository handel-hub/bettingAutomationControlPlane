export class FTSError extends Error {
  constructor(message, code, isRetryable = false) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.isRetryable = isRetryable;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class StorageError extends FTSError {
  constructor(message, isRetryable = false) {
    super(message, 'STORAGE_ERROR', isRetryable);
  }
}

export class DatabaseError extends FTSError {
  constructor(message) {
    super(message, 'DATABASE_ERROR', false);
  }
}

export class BackendError extends FTSError {
  constructor(message, isRetryable = true) {
    super(message, 'BACKEND_ERROR', isRetryable);
  }
}

export class ValidationError extends FTSError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR', false);
  }
}

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE transfers (
  transfer_id       TEXT PRIMARY KEY,
  file_id           TEXT NOT NULL,
  original_filename TEXT,
  mime_type         TEXT,
  declared_size     INTEGER,
  actual_size       INTEGER,
  state             TEXT NOT NULL,
  local_path        TEXT,
  content_hash      TEXT,
  hash_algorithm    TEXT NOT NULL DEFAULT 'sha256',
  chunk_size        INTEGER,
  total_chunks      INTEGER,
  remote_session_id TEXT,
  remote_object_id  TEXT,
  retry_attempts    INTEGER NOT NULL DEFAULT 0,
  next_retry_at     TEXT,
  paused_reason      TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  error_detail      TEXT,
  created_at        TEXT NOT NULL,
  local_ready_at    TEXT,
  queued_at         TEXT,
  upload_started_at TEXT,
  completed_at      TEXT,
  cancelled_at      TEXT,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_transfers_state         ON transfers(state);
CREATE INDEX idx_transfers_next_retry_at ON transfers(next_retry_at) WHERE state = 'RETRY_WAIT';

CREATE TABLE chunks (
  transfer_id  TEXT NOT NULL REFERENCES transfers(transfer_id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  chunk_offset INTEGER NOT NULL,
  chunk_size   INTEGER NOT NULL,
  chunk_hash   TEXT NOT NULL,
  upload_state TEXT NOT NULL DEFAULT 'PENDING',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  acked_at     TEXT,
  PRIMARY KEY (transfer_id, chunk_index)
);

CREATE INDEX idx_chunks_transfer_state ON chunks(transfer_id, upload_state);

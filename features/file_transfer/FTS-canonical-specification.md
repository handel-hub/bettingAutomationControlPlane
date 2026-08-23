# File Transfer Service (FTS) — Canonical Engineering Specification & Implementation Plan

**Scope note:** No separate FTS design document was attached to this task — only the instructions document that requested this synthesis. Per your confirmation, that instructions document (its sections 1–21) is treated here as the authoritative source spec. Everything below is derived from it. Where it left something genuinely undecided, it's marked **`OPEN DECISION`** with a recommended default rather than silently invented as a hard requirement.

---

## A. Specification Synthesis

The FTS is a **self-contained infrastructure subsystem** of the Control Plane. Its entire job is: take bytes in from _something_, get them durably onto local disk fast, tell the caller "done" the moment that's true, and then — on its own schedule, in the background — get those same bytes to a remote Backend, chunk by chunk, with retries, and tell the caller "actually done" when the remote side confirms it too.

The one sentence that governs every other decision in this document: **the FTS knows nothing above it and controls nothing about how it's reached.** It doesn't know HTTP, it doesn't know WebSockets, it doesn't know auth, it doesn't know what the file _means_ to the application. It receives bytes through an injected source abstraction and sends bytes out through an injected `BackendTransferClient`. Everything in between — durability, state, chunking, hashing, retry, recovery — is the FTS's own problem and nobody else's.

This produces two independent completion signals, not one:

1. **Local durability** (fast, synchronous from the caller's perspective) — the file is safely on disk and recorded in the FTS's own SQLite database. The Runtime can return `202 Accepted` the instant this resolves.
2. **Remote durability** (slow, asynchronous) — the file has been chunked, uploaded, and verified against the remote Backend. The FTS emits `TransferCompleted` when this happens; the Runtime reacts to that event however the application layer wants to (update its own DB, push a WebSocket message, etc.).

The FTS never conflates these two. A file can be `LOCAL_READY` for a long time before it's `COMPLETED`, and that's the whole point of the architecture — it decouples "the user's upload succeeded" from "the file is fully synced to the cloud."

---

## B. Architecture

### B.1 Components and ownership

| Component                                               | Owns                                                                                                                           | Does NOT own                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Runtime** (outside FTS)                               | HTTP responses, WebSocket push, authN/authZ, application DB, business logic, deciding what a `TransferCompleted` event _means_ | File bytes, transfer state, retry logic                       |
| **FTS facade** (`FileTransferService`)                  | Lifecycle (`initialize/start/stop/shutdown`), public API surface, wiring the subsystems below together                         | Transport protocols, application semantics                    |
| **Ingestion adapters**                                  | Turning a transport-specific source (HTTP request, future WS frames, etc.) into the FTS's generic stream contract              | Anything past that translation                                |
| **Ingestion pipeline**                                  | Streaming write-to-disk, incremental hashing, backpressure from source to disk                                                 | Chunked upload, retry                                         |
| **Local file store**                                    | Directory layout, temp/finalized paths, atomic rename, orphan detection                                                        | Metadata (that's SQLite's job)                                |
| **SQLite database**                                     | Transfer + chunk metadata, state, retry bookkeeping                                                                            | The bytes themselves                                          |
| **State machine**                                       | Legal transitions, guards, side-effect ordering                                                                                | The mechanics of what a side effect does                      |
| **Chunking/hashing**                                    | Splitting a finalized file into byte ranges, computing chunk + whole-file hashes                                               | Network transport                                             |
| **Transfer scheduler/worker**                           | Concurrency-bounded background transfer execution, admission control                                                           | Backend protocol details                                      |
| **`BackendTransferClient`** (injected, external to FTS) | Wire protocol to the remote Backend                                                                                            | Local state, retry _policy_ (it just executes what it's told) |
| **Recovery reconciler**                                 | Startup-time reconciliation of DB state vs. disk vs. remote                                                                    | Steady-state operation                                        |
| **Event bus**                                           | Emitting FTS facts as events                                                                                                   | Deciding what those facts mean                                |
| **Security Authority** (external, sibling subsystem)    | Auth, licensing, machine identity, anti-tamper                                                                                 | File transfer of any kind                                     |

### B.2 Data flow

```
Runtime
  │  raw request stream + metadata
  ▼
HttpRequestAdapter.consumeHttpRequest(req)     ← thin adapter, HTTP-aware
  │  normalizes to generic Source
  ▼
FileTransferService.consume(source, metadata)  ← core entry point, transport-agnostic
  │
  ▼
IngestionPipeline
  │  stream → incoming/<transferId>.part, incremental SHA-256
  │  on stream end: fsync
  ▼
LocalFileStore.finalize()
  │  atomic rename incoming/ → finalized/<shard>/<fileId>
  ▼
TransfersRepository (single SQLite transaction)
  │  INSERT/UPDATE: state=LOCAL_READY, localPath, size, contentHash
  ▼
Promise resolves ──────────────────────────► Runtime returns HTTP 202
  │
  │ (independently, on a background scheduler tick)
  ▼
TransferScheduler admits transfer (concurrency slot available)
  │
  ▼
TransferWorker: UPLOADING
  │  Chunker reads finalized file in fixed-size byte ranges (streaming, disk-backed)
  │  each chunk hashed, handed to BackendTransferClient.uploadChunk()
  ▼
BackendTransferClient ──────────────────────► Remote Backend
  │  (protocol opaque to FTS: HTTP/QUIC/whatever)
  ▼
All chunks ACKED → VERIFYING → BackendTransferClient.completeTransfer()
  │
  ▼
COMPLETED ──── EventBus.emit(TransferCompleted{transferId, fileId, remoteObjectId, size, contentHash})
                                                    │
                                                    ▼
                                              Runtime reacts
```

### B.3 Trust boundary (see also §L "Security Authority interaction")

```
        Security Authority                Runtime                    FTS
     (auth/licensing/identity) ──authorizes──► (owns the decision) ──► consume()/cancel()
                                                    │
                                     supplies an already-authenticated
                                     BackendTransferClient instance
                                                    │
                                                    ▼
                                                   FTS (never sees credentials)
```

---

## C. State Machine Specification

### C.1 States

| State         | Persisted?     | Meaning                                                                                                      |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `RECEIVING`   | Yes            | Bytes are actively streaming into a temp file; not yet durable                                               |
| `LOCAL_READY` | Yes            | File is durably on disk + committed to SQLite; local durability achieved                                     |
| `QUEUED`      | Yes            | Eligible for background transfer, waiting for a scheduler slot                                               |
| `UPLOADING`   | Yes            | Actively sending chunks to the Backend                                                                       |
| `RETRY_WAIT`  | Yes            | A chunk failed with a retryable error; waiting on backoff timer                                              |
| `PAUSED`      | Yes            | Retry budget for the current "hot" retry tier exhausted; waiting for a slow cold-retry tick or manual resume |
| `VERIFYING`   | Yes            | All chunks ACKED; awaiting `completeTransfer` confirmation                                                   |
| `COMPLETED`   | Yes (terminal) | Remote Backend has confirmed and verified the whole file                                                     |
| `FAILED`      | Yes (terminal) | Non-retryable failure, or retry budget fully exhausted                                                       |
| `CANCELLED`   | Yes (terminal) | Cancelled by caller before completion                                                                        |

**`LOCAL_FINALIZING` deliberately does not exist as a persisted state.** The seed list in the source doc proposed it, but persisting a separate row-state for "mid-finalization" creates an ambiguous crash window: was the rename done? Was the hash recorded? Instead, finalization (fsync → atomic rename → DB commit) is designed as a single all-or-nothing step from the caller's perspective — the row is `RECEIVING` right up until one atomic transaction flips it straight to `LOCAL_READY` with path/size/hash all committed together. If the process dies mid-finalization, the row is still (accurately) `RECEIVING`, and recovery is self-healing (see §F.8 / §L). This is a deliberate deviation from the seed list, not an oversight.

### C.2 Transition table

| #   | From             | Event                                | Guard                                                         | Persistence op                                                                            | Side effect                                                                                              | To                              |
| --- | ---------------- | ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | _(none)_         | `consume()` called                   | storage has headroom (soft check)                             | `INSERT transfers(state='RECEIVING', ...)`                                                | open temp file, begin rolling hash                                                                       | `RECEIVING`                     |
| 2   | `RECEIVING`      | stream ends cleanly, fsync succeeds  | bytes written, no stream error                                | _(none yet)_                                                                              | finalize hash digest                                                                                     | `RECEIVING` → finalize (see #3) |
| 3   | `RECEIVING`      | finalize: rename + DB commit succeed | rename succeeded                                              | single tx: `UPDATE state='LOCAL_READY', localPath, actualSize, contentHash, localReadyAt` | resolve `consume()` promise                                                                              | `LOCAL_READY`                   |
| 3f  | `RECEIVING`      | finalize: rename or fsync fails      | —                                                             | `UPDATE state='FAILED', error='finalize_failed'`                                          | delete temp file, reject `consume()` promise                                                             | `FAILED`                        |
| 4   | `LOCAL_READY`    | scheduler admission                  | none (automatic, immediate unless global concurrency cap hit) | `UPDATE state='QUEUED', queuedAt`                                                         | emit `TransferQueued`                                                                                    | `QUEUED`                        |
| 5   | `QUEUED`         | worker slot assigned                 | concurrency slot free, `cancelRequested=false`                | `UPDATE state='UPLOADING', uploadStartedAt` (first time only)                             | if no `remoteSessionId`: call `initializeTransfer`; emit `TransferStarted`                               | `UPLOADING`                     |
| 6   | `UPLOADING`      | chunk ACKED                          | —                                                             | `UPDATE chunks SET uploadState='ACKED', ackedAt`                                          | emit `TransferProgress`                                                                                  | `UPLOADING` (self-loop)         |
| 7   | `UPLOADING`      | chunk fails, retryable               | attempts < maxHotAttempts                                     | `UPDATE chunks SET attempts+=1, lastError`; `UPDATE transfers SET nextRetryAt`            | emit `TransferRetrying`                                                                                  | `RETRY_WAIT`                    |
| 8   | `RETRY_WAIT`     | backoff elapses                      | `cancelRequested=false`                                       | —                                                                                         | retry same chunk                                                                                         | `UPLOADING`                     |
| 8f  | `RETRY_WAIT`     | hot attempts exhausted               | attempts ≥ maxHotAttempts                                     | `UPDATE state='PAUSED', pausedReason`                                                     | emit `TransferPaused` _(extension — see note below)_                                                     | `PAUSED`                        |
| 9   | `PAUSED`         | cold-retry tick or manual `resume()` | `cancelRequested=false`                                       | `UPDATE state='QUEUED'`                                                                   | —                                                                                                        | `QUEUED`                        |
| 10  | `UPLOADING`      | last chunk ACKED                     | all chunks `ACKED`                                            | `UPDATE state='VERIFYING'`                                                                | call `completeTransfer()`                                                                                | `VERIFYING`                     |
| 11  | `VERIFYING`      | Backend confirms hash match          | —                                                             | `UPDATE state='COMPLETED', completedAt, remoteObjectId`                                   | emit `TransferCompleted`                                                                                 | `COMPLETED`                     |
| 11f | `VERIFYING`      | Backend reports hash mismatch        | —                                                             | `UPDATE state='FAILED', error='hash_mismatch'`                                            | emit `TransferFailed{retryable:false}`                                                                   | `FAILED`                        |
| 12  | any non-terminal | `cancel()` called                    | state ∉ {COMPLETED, FAILED, CANCELLED}                        | `UPDATE state='CANCELLED', cancelledAt`                                                   | best-effort `cancelTransfer()` if session exists; cleanup per retention policy; emit `TransferCancelled` | `CANCELLED`                     |

**Note on `TransferPaused`:** the seed event list (§H below / source §12) didn't include a distinct "paused" event, only `TransferFailed`. Reusing `TransferFailed` for a _non-terminal_ pause is misleading (Runtime would reasonably treat `TransferFailed` as final). This document adds `TransferPaused` as a small, justified extension to the event contract rather than overloading `TransferFailed`'s meaning — flagged here as a deviation, not silently introduced.

Invalid transitions (e.g., `cancel()` on an already-`COMPLETED` row, a chunk ACK arriving for a `CANCELLED` transfer) are no-ops that log a warning and do not throw — they're expected races (see §N Concurrency), not invariant violations.

---

## D. Database Specification

### D.1 Location, driver, and pragmas

- **Location:** `<dataDir>/fts/db/fts.sqlite3` (own file, own directory — never shares a database with the Security Authority or the main Control Plane DB, per requirement).
- **Driver:** `better-sqlite3` recommended (synchronous, single Node process, plays well with a single-writer model — matches the concurrency model in §N).
- **Pragmas:**
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;      -- see trade-off note below
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ```
  `OPEN DECISION`: WAL + `synchronous=NORMAL` is a common performance-oriented pairing and is safe against _corruption_, but can lose the most recent commit(s) on power loss (not on process crash). Given priority 2 is crash safety and priority 1 is correctness, this document defaults to `FULL`. If profiling shows the fsync cost on the finalize/commit path is unacceptable, revisit — but don't flip this without re-deriving the crash-consistency argument in §F.2.

### D.2 Schema

```sql
-- 001_init.sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE transfers (
  transfer_id       TEXT PRIMARY KEY,       -- ULID; == file_id (see D.3)
  file_id           TEXT NOT NULL,
  original_filename TEXT,
  mime_type         TEXT,
  declared_size     INTEGER,                -- advisory only (e.g. Content-Length); never trusted for correctness
  actual_size       INTEGER,                -- set at finalize; authoritative
  state             TEXT NOT NULL,          -- enum, see C.1
  local_path        TEXT,                   -- set at finalize
  content_hash      TEXT,                   -- whole-file hash, set at finalize
  hash_algorithm    TEXT NOT NULL DEFAULT 'sha256',
  chunk_size        INTEGER,                -- set at UPLOADING start
  total_chunks      INTEGER,
  remote_session_id TEXT,                   -- from initializeTransfer(); null until then
  remote_object_id  TEXT,                   -- from completeTransfer()
  retry_attempts    INTEGER NOT NULL DEFAULT 0,   -- hot-tier attempts for the *current* chunk
  next_retry_at     TEXT,
  paused_reason      TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  error_detail      TEXT,                   -- JSON, sanitized (see §K observability — never raw backend payloads with secrets)
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
  upload_state TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | UPLOADING | ACKED | FAILED
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  acked_at     TEXT,
  PRIMARY KEY (transfer_id, chunk_index)
);

CREATE INDEX idx_chunks_transfer_state ON chunks(transfer_id, upload_state);
```

`OPEN DECISION`: a `transfer_events` append-only audit table (transfer_id, event_type, payload_json, ts) was considered for observability/debugging replay value. Not included by default (the doc didn't ask for an audit log, and every persistent field must have a reason) — but flagged here as a low-cost addition if post-hoc debugging of production transfer histories becomes a need. If added, it's pure audit trail, never read by the state machine itself.

### D.3 Why `transfer_id == file_id`

One ingested file → one transfer record. The spec doesn't describe a scenario where the same physical file needs multiple independent concurrent remote transfer attempts, so this document collapses the two identifiers rather than inventing a many-to-many relationship that has no requirement backing it. `remote_session_id` (not the transfer_id) is what changes if a remote session has to be abandoned and re-initialized — it's a separate column precisely so re-initialization doesn't require a new transfer/file identity.

### D.4 Transaction boundaries

- **Ingestion → LOCAL_READY**: one transaction. `path + size + hash + state` commit atomically. This is the single most important transaction in the system — see §F.2.
- **Per-chunk ACK**: one transaction per chunk (`UPDATE chunks ...`), independent of other chunks' transactions — chunks are individually and durably tracked so resumption never has to guess.
- **State transitions** (`QUEUED→UPLOADING`, `UPLOADING→VERIFYING`, etc.): single-row updates, each its own transaction. No multi-row transactions needed outside of finalize, because chunk rows and their parent transfer row don't need atomicity with each other — chunk ACKs are individually durable and the transfer's aggregate state (`all chunks ACKED`) is _derived_ at read time, not maintained as duplicated state that could drift out of sync.

### D.5 Concurrency at the DB layer

Single writer connection (see §N). Readers (e.g., a status-query API) may use a second read-only connection, since WAL permits concurrent readers without blocking the writer.

---

## E. Storage Specification

### E.1 Directory layout

```
<dataDir>/fts/
  db/
    fts.sqlite3
    fts.sqlite3-wal
    fts.sqlite3-shm
  storage/
    incoming/                 -- <transfer_id>.part   (write target during RECEIVING)
    finalized/
      <first 2 hex chars of file_id>/<file_id>   -- sharded to avoid huge flat directories
    quarantine/                -- corrupted/orphaned files moved here, never silently deleted
```

### E.2 Naming and identifiers

- **`file_id` / `transfer_id`**: ULID (lexicographically sortable by creation time — useful for ordered scans during recovery/cleanup, unlike a plain UUIDv4).
- **Temp file**: `incoming/<transfer_id>.part` — the `.part` suffix makes orphan temp files trivially identifiable during a directory scan.
- **Finalized file**: `finalized/<file_id[0:2]>/<file_id>` — no extension; MIME type lives in the DB, not the filename, since the FTS shouldn't encode application semantics into paths.

### E.3 Atomic finalization and crash-consistency ordering

The required ordering, and why:

```
1. stream ingestion  (bytes → incoming/<id>.part, rolling hash updated incrementally)
2. flush + fsync     (incoming/<id>.part is now durable at that path — but not yet "the file")
3. rename             (incoming/<id>.part → finalized/<shard>/<id> — POSIX rename is atomic within
                        the same filesystem/volume; this is why incoming/ and finalized/ MUST be on
                        the same volume, not e.g. a tmpfs incoming/ with a persistent-disk finalized/)
4. SQLite transaction (commit path + size + hash + state=LOCAL_READY, together, atomically)
5. resolve promise    (only AFTER step 4 commits — this is the actual "durability achieved" signal)
```

Step 3 before step 4 is deliberate: if the process dies between them, the file already exists at its deterministic finalized path, and recovery (§F.8) can compute its hash/size directly from disk and complete the DB commit itself — self-healing. If the ordering were reversed (DB commit before rename), a crash in between would leave SQLite asserting a `localPath` that doesn't exist yet — exactly the invariant violation the spec explicitly prohibits ("SQLite metadata must never claim a file is durable when the underlying file is not").

`OPEN DECISION`: whether `incoming/` and `finalized/` must be guaranteed same-volume is a deployment/config concern (a misconfigured `dataDir` split across mounts would silently turn "atomic rename" into "copy + delete," which is not atomic). Recommend a startup self-check: write a test file to `incoming/`, attempt `fs.rename` into `finalized/`, and fail fast at `initialize()` if it errors with `EXDEV`.

### E.4 Cleanup, orphans, disk pressure

- **Orphan detection**: at recovery time, any `incoming/*.part` file with no corresponding `RECEIVING` row (or whose row is already terminal) is an orphan → moved to `quarantine/` (not deleted — see below) and logged.
- **Corruption detection**: `finalized/` files are content-addressed by their recorded `content_hash`; a periodic (or recovery-time, if `verifyOnRecovery` is enabled) re-hash mismatch → row transitions to `FAILED`, file moved to `quarantine/`.
- **Quarantine, not delete**: anything the FTS is unsure about goes to `quarantine/` first. Actual deletion is a separate, explicit, lower-frequency cleanup job with its own retention window (`OPEN DECISION`: default retention not specified by the source spec — recommend 7 days, configurable).
- **Disk-full behavior**: `DiskSpaceGuard` does a soft pre-flight check against `declared_size` (if provided) before opening the temp file; if the OS write itself fails with `ENOSPC` mid-stream, that's a `StorageError` (retryable at the _ingestion_ level only in the sense that the caller can retry the whole upload later — an in-flight `RECEIVING` row that hits `ENOSPC` goes straight to `FAILED`, temp file deleted, since there's nothing to resume from a partial disk-full write).
- **Permissions**: storage directories created `0700` (owner-only) — this is a local-machine, single-owner-process assumption consistent with the Control Plane's desktop-automation context (see §L).
- **Max file size**: `OPEN DECISION` — no numeric limit was specified. Recommend a configurable `maxFileSize` enforced during ingestion (abort + `FAILED` if exceeded), defaulting to something conservative (e.g. 5 GiB) until product requirements say otherwise.

---

## F. Algorithms

### F.1 Ingestion (`consume(source, metadata)`)

```
1. Validate metadata (soft): suggestedFilename, mimeType, declaredSize (advisory).
2. DiskSpaceGuard.check(declaredSize) — soft pre-flight; proceed even if declaredSize absent.
3. Allocate transfer_id = file_id = ULID().
4. INSERT transfers(state='RECEIVING', declared_size, created_at) — transfer now exists,
   even though nothing durable yet. (This row existing is itself useful: a status query for
   an in-flight upload has something to return.)
5. Open incoming/<transfer_id>.part for write.
6. Pipe source → RollingHasher (Transform, updates SHA-256 incrementally) → write stream,
   using Node's pipeline() so backpressure is automatic end-to-end.
7. On source error: abort, delete temp file, UPDATE state='FAILED', reject promise.
8. On stream end: fsync the file descriptor.
9. digest = RollingHasher.final()
10. LocalFileStore.finalize(transfer_id) → atomic rename (see E.3).
11. Single transaction: UPDATE state='LOCAL_READY', local_path, actual_size, content_hash=digest,
    local_ready_at=now.
12. Resolve consume() promise with { transferId, fileId, size, contentHash }.
```

Never buffers the whole file in memory — bytes flow source → hash → disk in a single streaming pipeline.

### F.2 Crash-consistency (see E.3 for the canonical ordering; this is the invariant it protects)

**Invariant:** _A row is `LOCAL_READY` if and only if `finalized/<file_id>` exists, is fully written, and its content matches `content_hash`._ Every recovery procedure exists to re-establish this invariant after an arbitrary crash point, never to assume it.

### F.3 Chunking

- File-based, not stream-based: chunking reads the **finalized** file (already durable) via `fs.createReadStream({ start, end })` per byte range — never the original ingestion stream. This is what makes chunking independently resumable after a crash, hours later, without any connection to the original request.
- Fixed logical chunk size, default 8 MiB, configurable per-instance. Rationale: large enough to keep per-chunk DB-row and network-round-trip overhead low, small enough to keep retry granularity and memory footprint (§G backpressure) reasonable. `OPEN DECISION`: no chunk size was specified in the source; 8 MiB is a starting default, not a requirement.
- `total_chunks = ceil(actual_size / chunk_size)`, computed once at `UPLOADING` start and persisted (`transfers.total_chunks`, `transfers.chunk_size`) — this makes the chunk plan itself deterministic and recoverable without recomputation.
- Chunk rows (`chunks` table) are all pre-inserted (`state=PENDING`) at the same time `total_chunks` is set, one `INSERT` per chunk in a single transaction — this is what lets recovery ask "which chunks are missing" as a pure SQL query rather than reconstructing chunk plans from scratch.

### F.4 Hashing

- Whole-file hash: computed once, incrementally, during ingestion (F.1 step 6) — never a second full-file read pass. SHA-256 (`node:crypto`).
- Chunk hash: computed at chunk-read time during upload (streaming the chunk's byte range through a hash transform as it's read), not precomputed during ingestion — chunks aren't known to exist as a concept until `UPLOADING` begins.
- Final verification: `completeTransfer()` is called with the whole-file `content_hash`; the Backend is expected to verify against what it received and return a verification result (see §G contract). A mismatch is `FAILED` (see C.2 #11f) — not silently retried, because it indicates either local corruption or a Backend-side reconstruction bug, neither of which resolves itself with more attempts.

### F.5 Uploading

```
for each chunk where upload_state != 'ACKED' (ordered by chunk_index):
  read byte range [chunk_offset, chunk_offset+chunk_size) from finalized file (streaming)
  compute chunk_hash on the fly
  UPDATE chunks SET upload_state='UPLOADING'
  result = BackendTransferClient.uploadChunk({ remoteSessionId, transferId, chunkIndex,
             chunkOffset, chunkSize, chunkHash, hashAlgorithm:'sha256', data })
  if result.acked:
    UPDATE chunks SET upload_state='ACKED', acked_at=now
    emit TransferProgress
  else:
    classify failure (§F.9) → RETRY_WAIT or PAUSED or FAILED
respects maxConcurrentChunkUploads (§G) — chunks within this loop are dispatched up to
that concurrency limit, not strictly one-at-a-time
```

### F.6 Retries

Two tiers, both required by the "don't retry forever, don't give up too soon" tension in the source spec:

- **Hot tier** (per-chunk, `RETRY_WAIT`): exponential backoff, base 500 ms, factor 2, cap 60 s, `maxHotAttempts` (default 8) before escalating to `PAUSED`. `OPEN DECISION`: exact numbers are defaults, not requirements — the _shape_ (exponential, capped, bounded attempts) is the actual requirement.
- **Cold tier** (`PAUSED`): fixed longer interval (default every 10 minutes) OR manual `resume()`. A `maxColdDuration` (default 24 h) bounds total time a transfer can sit `PAUSED` before it's declared `FAILED` outright — otherwise a permanently-unreachable Backend leaves rows paused forever.

### F.7 Completion

```
when all chunks ACKED:
  UPDATE state='VERIFYING'
  result = BackendTransferClient.completeTransfer({ remoteSessionId, transferId, contentHash })
  if result.verifiedHash === contentHash:
    UPDATE state='COMPLETED', remote_object_id=result.remoteObjectId, completed_at=now
    emit TransferCompleted{ transferId, fileId, remoteObjectId, size, contentHash }
  else:
    UPDATE state='FAILED', error_code='hash_mismatch'
    emit TransferFailed{ retryable:false }
```

### F.8 Recovery (executed once, at `start()`, before the scheduler begins accepting new admissions)

| Row found in state...              | Recovery action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECEIVING`                        | Check if `finalized/<file_id>` already exists (rename may have completed before the crash). If yes: recompute hash+size from disk, commit the same transaction F.1 step 11 would have — self-healing, transitions to `LOCAL_READY`. If no: delete orphaned `incoming/<id>.part` if present, transition to `FAILED('ingestion_interrupted_by_restart')`. (Safe: the original HTTP request is gone regardless post-restart; the caller never received a 202 for this row, so nothing upstream depends on it.) |
| `LOCAL_READY`, `QUEUED`            | Verify `finalized/<file_id>` still exists (optionally re-hash if `verifyOnRecovery` config is set). Re-enter at `QUEUED`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `UPLOADING`, `RETRY_WAIT`          | If `remote_session_id` set: call `queryTransferStatus()` to get the Backend's authoritative `lastAckedChunkIndex`; reconcile local `chunks` rows against it (resolves "did my ack response get lost" ambiguity — §F.9). Re-enter at `QUEUED` (scheduler re-admits fresh rather than assuming a live `UPLOADING` context).                                                                                                                                                                                   |
| `PAUSED`                           | Leave as-is; cold-retry timer picks it up on its own schedule.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `VERIFYING`                        | Re-attempt `completeTransfer()` (idempotent by `remoteSessionId` + `contentHash` — see §G). If the Backend already completed it, this returns the existing `remoteObjectId` and the row moves straight to `COMPLETED` without re-uploading anything.                                                                                                                                                                                                                                                        |
| `COMPLETED`, `FAILED`, `CANCELLED` | No action (terminal). Eligible for the separate cleanup/retention job.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Separately: scan `incoming/` for any `.part` file whose `transfer_id` doesn't match a live `RECEIVING` row at all (crash happened before the `INSERT` in F.1 step 4, or the row was later purged) → orphan → `quarantine/`.

### F.9 Cancellation

```
cancel(transferId):
  UPDATE transfers SET cancel_requested=1
  (in-memory scheduler also marks it, for workers currently mid-loop to notice without a DB round-trip)

worker loop checks cancel_requested before dispatching each chunk;
on detection:
  stop dispatching further chunks (in-flight ones are allowed to finish or timeout naturally)
  if remote_session_id exists: best-effort BackendTransferClient.cancelTransfer() (failure here is
    logged, not escalated — cancellation is a local decision the FTS honors regardless of whether
    the Backend acknowledges it)
  UPDATE state='CANCELLED', cancelled_at=now
  cleanup local file per retention policy (OPEN DECISION: default = keep file in finalized/ until
  the normal retention job runs, not immediate delete — avoids losing data on an accidental cancel)
  emit TransferCancelled
```

---

## G. API Contracts

### G.1 Public FTS interface

```js
const fts = new FileTransferService({
  dataDir,                      // required — root of fts/ storage+db tree
  backendTransferClient,        // required — injected, see G.2
  chunkSize,                    // optional, default 8 * 1024 * 1024
  maxFileSize,                  // optional, OPEN DECISION default (see E.4)
  maxConcurrentTransfers,       // optional, default 3
  maxConcurrentChunkUploads,    // optional, default 4 (per transfer)
  retryPolicy,                  // optional, overrides F.6 defaults
  verifyOnRecovery,             // optional boolean, default false
});

await fts.initialize();   // open DB, run migrations, ensure storage dirs, same-volume self-check
await fts.start();        // run recovery (F.8), start scheduler + cold-retry timer
await fts.stop();         // graceful: stop admitting new work, let in-flight chunk uploads finish
                           //   up to a configurable timeout, checkpoint WAL, close DB
await fts.shutdown();     // stop() + release all resources; not restartable after this

const result = await fts.consume(source, metadata);
// source: Readable | AsyncIterable<Buffer>
// metadata: { suggestedFilename?, mimeType?, declaredSize? }
// result: { transferId, fileId, size, contentHash }
// resolves at LOCAL_READY (per F.1), NOT at COMPLETED

const result = await fts.consumeHttpRequest(req);
// thin adapter: HttpRequestAdapter derives source + metadata (Content-Length → declaredSize,
// Content-Type → mimeType) from `req`, then delegates to consume(). No HTTP concepts exist
// past this function.

await fts.cancel(transferId);
await fts.resume(transferId);          // manual escape from PAUSED
const status = await fts.getStatus(transferId);  // read-only query, any state

fts.on('TransferAccepted', ...)        // see §H for full event list
```

**On whether both `consume()` and `consumeHttpRequest()` should exist (source §3 explicitly asks this): yes.** Rejected alternative #1 — only `consumeHttpRequest()`: forces every future transport (WebSocket frames, a local file-path import, a test harness) to either fake an HTTP `req` object or duplicate the ingestion pipeline, both bad. Rejected alternative #2 — only `consume()`, no HTTP adapter at all: pushes the "how do I turn a Node HTTP request into a generic byte source" boilerplate onto every Runtime call site, duplicated across the codebase instead of solved once. The thin-adapter pattern (adapter → generic core) is the only option that keeps the FTS transport-agnostic _and_ keeps call sites simple. Same pattern should apply to any future transport (`consumeFilePath()`, `consumeWebSocketFrames()`), all delegating to the same `consume()`.

### G.2 `BackendTransferClient` (injected interface — FTS defines the contract, does not implement it)

```js
/**
 * @typedef {Object} BackendTransferClient
 * @property {(args: {transferId, fileId, totalSize, totalChunks, chunkSize, contentHash,
 *   hashAlgorithm, metadata}) => Promise<{remoteSessionId, resumeFromChunkIndex}>} initializeTransfer
 *   Idempotent keyed by transferId — repeated calls after an ambiguous failure return the
 *   existing session rather than creating a duplicate.
 *
 * @property {(args: {remoteSessionId, transferId, chunkIndex, chunkOffset, chunkSize,
 *   chunkHash, hashAlgorithm, data}) => Promise<{acked, chunkIndex}>} uploadChunk
 *   Idempotent keyed by (remoteSessionId, chunkIndex, chunkHash) — safe to call twice for the
 *   same chunk (e.g. after a timeout whose response was actually in flight).
 *
 * @property {(args: {remoteSessionId, transferId, contentHash}) =>
 *   Promise<{remoteObjectId, size, verifiedHash}>} completeTransfer
 *   Idempotent keyed by (remoteSessionId, contentHash) — calling twice returns the same
 *   remoteObjectId rather than erroring or duplicating.
 *
 * @property {(args: {remoteSessionId, transferId}) =>
 *   Promise<{status, lastAckedChunkIndex, remoteObjectId?}>} queryTransferStatus
 *   Read-only. Authoritative source of truth for reconciling local ACK state after a crash (F.8).
 *
 * @property {(args: {remoteSessionId, transferId}) => Promise<void>} cancelTransfer
 *   Best-effort; failure here does not block local CANCELLED transition (F.9).
 */
```

**Timeout semantics**: every call above has an FTS-enforced timeout (`OPEN DECISION` default 30 s for `uploadChunk`, 15 s for the others) independent of whatever timeout the client's own transport uses — a hung Backend call must not hang the worker loop forever.

---

## H. Event Contracts

| Event               | Payload                                                      | Emitted when                        |
| ------------------- | ------------------------------------------------------------ | ----------------------------------- |
| `TransferAccepted`  | `{ transferId, fileId, size, contentHash }`                  | `LOCAL_READY` reached (C.2 #3)      |
| `TransferQueued`    | `{ transferId }`                                             | C.2 #4                              |
| `TransferStarted`   | `{ transferId, remoteSessionId }`                            | C.2 #5                              |
| `TransferProgress`  | `{ transferId, chunkIndex, bytesTransferred, totalBytes }`   | each chunk ACK (C.2 #6)             |
| `TransferRetrying`  | `{ transferId, chunkIndex, attempt, nextRetryAt, reason }`   | C.2 #7                              |
| `TransferPaused`¹   | `{ transferId, pausedReason, attempts }`                     | C.2 #8f                             |
| `TransferCompleted` | `{ transferId, fileId, remoteObjectId, size, contentHash }`  | C.2 #11                             |
| `TransferFailed`    | `{ transferId, retryable: boolean, errorCode, errorDetail }` | C.2 #3f, #11f, cold-tier exhaustion |
| `TransferCancelled` | `{ transferId, reason }`                                     | C.2 #12                             |

¹ Extension beyond the source spec's seed list — see the note under §C.2. Every payload is FTS-fact-shaped (ids, sizes, hashes, timestamps), never an application-level instruction — the Runtime decides what any of this _means_.

---

## I. Folder/File Structure

```
file-transfer/
  index.mjs                       # public facade re-export
  service/
    FileTransferService.mjs       # orchestrator — wires every subsystem below together
    lifecycle.mjs                 # initialize/start/stop/shutdown sequencing
    config.mjs                    # option defaults + validation
  adapters/
    HttpRequestAdapter.mjs        # consumeHttpRequest(req) → generic Source; the ONLY file
                                   #   in the whole tree allowed to import an HTTP type
    StreamSourceAdapter.mjs       # normalizes Readable/AsyncIterable → internal Source contract
  ingestion/
    IngestionPipeline.mjs         # F.1 orchestration
    RollingHasher.mjs             # incremental-hash Transform stream
    DiskSpaceGuard.mjs            # pre-flight + ENOSPC handling
  storage/
    LocalFileStore.mjs            # temp/finalized paths, atomic rename, orphan scan
    PathScheme.mjs                # pure fileId → sharded-path functions (easy to unit test)
  database/
    connection.mjs                # single-writer connection, WAL pragmas, same-volume check
    migrations/001_init.sql
    migrate.mjs
    TransfersRepository.mjs
    ChunksRepository.mjs
  state/
    TransferStateMachine.mjs      # C.2's transition table, executable — the one place transitions
                                   #   are legal to perform
  chunking/
    Chunker.mjs                   # byte-range planning + streaming chunk reads
  hashing/
    hash.mjs                      # thin node:crypto wrapper (chunk hash + whole-file hash)
  transfer/
    TransferScheduler.mjs         # concurrency-bounded admission (QUEUED → UPLOADING)
    TransferWorker.mjs            # drives one transfer through UPLOADING/RETRY_WAIT/VERIFYING
    RetryPolicy.mjs                # backoff calculation + retryable/non-retryable classification
  backend/
    BackendTransferClient.mjs     # JSDoc typedef only — no implementation lives in this repo
  recovery/
    RecoveryReconciler.mjs        # F.8, run once at start()
  events/
    EventBus.mjs
    eventTypes.mjs
  errors/
    FTSError.mjs                  # base class
    ValidationError.mjs
    StorageError.mjs
    DatabaseError.mjs
    StreamError.mjs
    HashError.mjs
    BackendError.mjs
    TimeoutError.mjs
    CancellationError.mjs
    RecoveryError.mjs
    InvariantViolationError.mjs   # never expected in normal operation; see §K
  observability/
    logger.mjs                    # structured logging, correlation ids, redaction (§K)
    metrics.mjs
  tests/
    unit/ integration/ crash/ property/ concurrency/ fault-injection/
```

Each top-level directory maps to exactly one row of the ownership table in §B.1 — this is deliberate; if a change touches two of these directories at once, that's usually a sign a responsibility leaked across a boundary it shouldn't have.

---

## J. Implementation Plan

| Phase | Objective                                                                                | Key files                                                             | Depends on                 |
| ----- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------- |
| 0     | Spec synthesis                                                                           | _(this document)_                                                     | —                          |
| 1     | Project structure, error hierarchy, config validation, `BackendTransferClient` typedef   | `errors/*`, `service/config.mjs`, `backend/BackendTransferClient.mjs` | 0                          |
| 2     | SQLite persistence: connection, migrations, both repositories                            | `database/*`                                                          | 1                          |
| 3     | Local file storage: path scheme, atomic finalize, same-volume check                      | `storage/*`                                                           | 1                          |
| 4     | Ingestion pipeline + rolling hash + disk guard, `consume()` end-to-end (no adapters yet) | `ingestion/*`                                                         | 2, 3                       |
| 5     | HTTP adapter (`consumeHttpRequest`)                                                      | `adapters/*`                                                          | 4                          |
| 6     | State machine (executable transition table, guards)                                      | `state/*`                                                             | 2                          |
| 7     | Chunking + hashing                                                                       | `chunking/*`, `hashing/*`                                             | 3, 6                       |
| 8     | Transfer scheduler + worker (UPLOADING → VERIFYING → COMPLETED), no retry/recovery yet   | `transfer/*`                                                          | 6, 7                       |
| 9     | Retry policy (hot + cold tiers)                                                          | `transfer/RetryPolicy.mjs`                                            | 8                          |
| 10    | Recovery reconciler (F.8, all six row-state paths)                                       | `recovery/*`                                                          | 2, 3, 8, 9                 |
| 11    | Event system wired through every phase above                                             | `events/*`                                                            | 4–10 (retrofit emit calls) |
| 12    | Lifecycle (`initialize/start/stop/shutdown`), graceful shutdown draining                 | `service/lifecycle.mjs`                                               | all above                  |
| 13    | Observability (structured logs, metrics, redaction)                                      | `observability/*`                                                     | all above                  |
| 14    | Fault-injection + concurrency + crash-recovery test suites at full breadth               | `tests/crash,concurrency,fault-injection`                             | 12                         |
| 15    | Runtime integration (outside this repo)                                                  | —                                                                     | 5, 11, 12                  |

Dependency graph is intentionally linear-ish with a few forks (5 and 6/7 can proceed in parallel after 4; 9 and 10 both need 8 but not each other) — no phase requires redesigning a decision from an earlier phase, per the source spec's explicit goal.

---

## K. Test Plan

- **Unit**: state transitions (every row of C.2, including invalid ones as documented no-ops), `Chunker` byte-range math (including odd remainders), hashing correctness, `RetryPolicy` backoff calculation (hot + cold), error classification (§ table below), `PathScheme` shard derivation.
- **Integration**: real SQLite file + real filesystem — ingest → finalize → verify DB+disk agreement; full happy-path transfer against a fake in-memory `BackendTransferClient`; event emission order for a full lifecycle.
- **Crash tests**: kill the process (`process.exit()` / `SIGKILL` a child process, don't just throw in-process) at each of the 8 named crash points in §L, then assert the `F.8` table's action actually happens on next `start()`.
- **Property-based**: random sequences of chunk ack/fail/timeout interleaved with random cancel/pause calls; assert the state machine never reaches an undefined state and the `LOCAL_READY ⇒ file exists` invariant never breaks.
- **Concurrency**: N simultaneous `consume()` calls; simultaneous transfers competing for `maxConcurrentTransfers`; a chunk ACK arriving concurrently with a `cancel()` call (race in C.2 note); shutdown while workers are mid-chunk.
- **Fault injection**: `ENOSPC` mid-write; corrupted `finalized/` file (bit-flip after finalize) caught by `verifyOnRecovery`; SQLite file made read-only mid-run; `BackendTransferClient` returning malformed responses (missing fields), duplicate acks, and connection drops mid-`uploadChunk`.
- **Recovery tests**: seed a DB + storage directory directly into each of the six recovery-relevant states (F.8 table) without going through normal operation, `start()`, assert the documented outcome.

### Failure classification (drives retryable/non-retryable in F.6/F.9)

| Failure                              | Class                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Network timeout / connection reset   | retryable (hot)                                                                                                    |
| Backend unavailable (repeated)       | retryable → escalates to cold (PAUSED)                                                                             |
| Partial chunk upload                 | retryable (re-send same chunk)                                                                                     |
| Duplicate chunk ack                  | non-error — idempotent no-op, not a failure at all                                                                 |
| Malformed backend response           | retryable (hot) up to limit, then non-retryable/FAILED                                                             |
| Hash mismatch at chunk level         | retryable once (re-read+re-hash locally first — may be transient), then non-retryable if local hash confirms clean |
| Hash mismatch at completeTransfer    | non-retryable (FAILED)                                                                                             |
| Disk full during ingestion           | non-retryable at the row level (FAILED); caller may retry as a _new_ upload                                        |
| Permission failure (storage)         | non-retryable (FAILED), surfaced as `StorageError`                                                                 |
| SQLite failure (I/O error)           | non-retryable for the in-flight op; escalate as `InvariantViolationError` if it leaves ambiguous state             |
| Process crash / machine restart      | not a "failure" per se — handled entirely by §F.8 recovery                                                         |
| Corrupted local file (post-finalize) | non-retryable (FAILED), file quarantined                                                                           |
| Cancellation                         | terminal, not a failure                                                                                            |
| Shutdown mid-transfer                | not terminal — row stays in its current non-terminal state, picked up by recovery/scheduler on next `start()`      |

---

## L. Invariants

1. A row is `LOCAL_READY` **iff** `finalized/<file_id>` exists, is fully written, and matches `content_hash` (F.2).
2. `consume()`'s promise resolves **only after** the F.1-step-11 transaction commits — never before.
3. The FTS never buffers an entire file in memory, during ingestion or during chunked upload (F.1, F.3).
4. Every chunk ACK is individually and durably recorded before the transfer can reach `VERIFYING` (D.4).
5. `remote_session_id`/`uploadChunk`/`completeTransfer` calls are all idempotent by construction (G.2) — the FTS relies on this for safe retries and crash recovery, and must not be built against a `BackendTransferClient` implementation that violates it.
6. No credential, token, or authentication material ever appears in an FTS log line, error payload, or event payload (§K observability / redaction).
7. The FTS holds no opinion about HTTP, WebSockets, auth, or application semantics anywhere below the adapter layer (`adapters/` is the only place transport concepts are allowed to exist at all).
8. `incoming/` and `finalized/` are guaranteed same-volume (checked at `initialize()`), so finalization's rename is genuinely atomic.
9. A transfer's state only ever advances through the table in C.2 — no code path outside `state/TransferStateMachine.mjs` performs a raw state column update.

**Security Authority boundary** (source §15 requires this be addressed explicitly): The actual SPC / Security Authority design docs referenced in prior work on this Control Plane were not part of this conversation, so the specifics below are necessarily general rather than sourced from that material — flagged as `OPEN DECISION` pending those docs:

| Responsibility                                                                                       | Owner                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticating the caller / authorizing the upload in the first place                                | Runtime + Security Authority, **before** `consume()` is ever called                                                                                                                                                                                                                                                                                 |
| Supplying a properly-authenticated `BackendTransferClient` instance                                  | Runtime (constructs it, injects it — FTS never sees the credentials inside it)                                                                                                                                                                                                                                                                      |
| Filesystem permissions on `dataDir`                                                                  | OS, `0700`, single-process-owner assumption (E.4)                                                                                                                                                                                                                                                                                                   |
| Detecting tampering with a `finalized/` file                                                         | FTS, via hash re-verification — but whether a hash-mismatch here should additionally raise a _security_ signal (vs. a plain corruption signal) toward the Security Authority (echoing that subsystem's `SECURITY_STATE_UNCERTAIN` concept) is an **open decision** requiring the actual SPC material to resolve correctly rather than guessed here. |
| Multi-process / multi-instance FTS (would need OS-level file locking beyond WAL's normal guarantees) | **Open decision** — this document assumes a single Node process per machine, consistent with the desktop-automation Control Plane context, but that assumption isn't sourced from a written requirement.                                                                                                                                            |

---

## M. Traceability Matrix

| Requirement (source §)               | Architecture (§)                      | Implementation (Phase)       | Test                                   |
| ------------------------------------ | ------------------------------------- | ---------------------------- | -------------------------------------- |
| Transport-agnostic core (§1, §3)     | B.1, G.1                              | 1, 4, 5                      | unit (adapter isolation), integration  |
| Injected Backend abstraction (§4)    | G.2                                   | 1, 9                         | unit (classification), fault-injection |
| Own SQLite DB (§5)                   | D                                     | 2                            | integration                            |
| Own local storage (§6)               | E                                     | 3                            | integration, crash                     |
| Crash-consistency ordering (§6, §11) | E.3, F.2                              | 3, 4, 10                     | crash                                  |
| State machine (§7)                   | C                                     | 6                            | unit, property                         |
| Chunking (§8)                        | F.3                                   | 7                            | unit                                   |
| Backpressure (§9)                    | F.1, F.5, G.1 (concurrency options)   | 4, 8                         | concurrency                            |
| Retry/failure model (§10)            | F.6, K (classification table)         | 9                            | unit, fault-injection                  |
| Crash recovery (§11)                 | F.8                                   | 10                           | crash, recovery                        |
| Event architecture (§12)             | H                                     | 11                           | integration                            |
| Lifecycle (§13)                      | G.1                                   | 12                           | integration                            |
| Concurrency model (§14)              | D.5, F.9                              | 8, 9                         | concurrency                            |
| SPC/security boundary (§15)          | L (Security Authority boundary table) | — (blocked on external docs) | —                                      |
| Folder structure (§16)               | I                                     | 1                            | —                                      |
| Error architecture (§17)             | I (errors/), K                        | 1                            | unit                                   |
| Observability (§18)                  | I (observability/)                    | 13                           | — (manual review of redaction)         |
| Testing strategy (§19)               | K                                     | 14                           | (is the test plan)                     |
| Phased plan (§20)                    | J                                     | — (is the plan)              | —                                      |
| Boundary rule (§21)                  | B.1                                   | all                          | code review checklist                  |

---

# FTS IMPLEMENTATION READINESS AMENDMENT

## Purpose

This document supplements the existing **File Transfer Service Implementation Plan**.

The existing plan is the authoritative architectural specification. This amendment does **not** redesign the FTS. It resolves implementation-level ambiguities, strengthens the boundaries, and establishes rules the implementation agent MUST follow.

The implementation agent MUST read the existing FTS specification together with this document before modifying code.

The objective is to produce a complete, production-grade File Transfer Service without leaking HTTP/application concerns into the core and without introducing implicit architectural decisions during implementation.

---

# 1. Core Architectural Rule

The File Transfer Service is an **independent infrastructure subsystem**.

It is not an HTTP subsystem.

It is not a Backend API client.

It is not an application/business-logic subsystem.

It is not responsible for authentication, authorization, licensing, WebSocket communication, or application database mutations.

The FTS owns:

- local file ingestion
- local file durability
- transfer metadata
- transfer state
- chunking
- hashing
- upload scheduling
- retry policy
- cancellation
- recovery
- local storage lifecycle
- transfer events

The Runtime owns:

- HTTP routing
- HTTP response generation
- authentication/authorization decisions
- application database
- WebSocket notifications
- interpretation of FTS events
- application/business semantics

The BackendTransferClient owns:

- communication with the remote Backend
- Backend-specific protocol
- remote upload-session semantics
- remote acknowledgements
- remote completion
- remote cancellation

This separation is already established in the specification and MUST remain intact.

---

# 2. HTTP Boundary

The FTS core MUST remain transport-agnostic.

The only HTTP-aware component is the adapter layer.

The intended API is:

```js
await fts.consumeHttpRequest(req);
```

which internally becomes:

```text
HTTP Request
    ↓
HttpRequestAdapter
    ↓
Generic Source + Metadata
    ↓
FileTransferService.consume()
    ↓
IngestionPipeline
```

The HTTP request object MUST NOT propagate below the adapter boundary.

The core MUST NOT:

- inspect HTTP status codes
- construct HTTP responses
- know Express/Fastify/Node HTTP routing
- know HTTP headers except where the adapter translates them into generic metadata
- perform HTTP authentication
- contain Backend HTTP URLs
- call `fetch()` directly
- depend on the Runtime's HTTP framework

The existing specification explicitly establishes `consume()` as the transport-independent core API and `consumeHttpRequest()` as the thin HTTP adapter.

---

# 3. Generic Input Contract

The canonical internal ingestion interface MUST be:

```ts
consume(
    source: Readable | AsyncIterable<Buffer>,
    metadata: TransferInputMetadata
): Promise<LocalTransferResult>
```

with metadata conceptually equivalent to:

```ts
{
    suggestedFilename?: string;
    mimeType?: string;
    declaredSize?: number;
}
```

The implementation MUST NOT require HTTP-specific metadata.

Future sources must therefore be able to enter the same pipeline:

```text
HTTP
  ↓
HttpRequestAdapter
  ↓
consume()

WebSocket
  ↓
WebSocketAdapter
  ↓
consume()

Local file
  ↓
FileAdapter
  ↓
consume()

Test source
  ↓
TestAdapter
  ↓
consume()
```

No ingestion pipeline duplication is permitted.

---

# 4. Local Durability Contract

The most important semantic guarantee of `consume()` is:

> Returning from `consume()` means the file is locally durable and represented consistently in the FTS database.

It does **not** mean that the Backend upload completed.

The existing architecture deliberately separates `LOCAL_READY` from `COMPLETED`.

The implementation MUST preserve this distinction.

The sequence MUST effectively be:

```text
create transfer identity
        ↓
create temporary file
        ↓
stream bytes
        ↓
incremental hash
        ↓
flush/fsync
        ↓
atomic finalize/rename
        ↓
SQLite transaction
        ↓
LOCAL_READY
        ↓
resolve consume()
```

The existing invariant requires that `consume()` resolve only after the local metadata transaction commits.

---

# 5. Database Ownership

The FTS MUST use its **own SQLite database**.

It must not share the application's primary database.

Conceptually:

```text
Control Plane
│
├── Security Authority DB
│
├── Application DB
│
└── File Transfer Service
      ├── fts.sqlite
      └── files/
```

The FTS database owns only FTS concerns:

- transfers
- chunks
- retry state
- remote session information
- local file metadata
- transfer state
- recovery metadata
- FTS event/outbox information if required

The Runtime's application database MUST NOT be accessed directly by FTS.

The FTS should be capable of being initialized, started, stopped, recovered, and tested independently.

---

# 6. Database Must Be Treated as the FTS Control Ledger

SQLite is not the file store.

The database records the authoritative metadata describing files stored on disk.

The actual bytes remain in the filesystem.

Therefore:

```text
SQLite = transfer metadata/control plane
Filesystem = file content/data plane
```

The implementation MUST explicitly account for crashes occurring between filesystem and SQLite operations.

This is especially important during:

- ingestion
- finalization
- cancellation
- deletion
- recovery
- cleanup

---

# 7. Filesystem ↔ Database Reconciliation

Startup recovery MUST explicitly reconcile:

```text
SQLite state
        ↕
filesystem state
        ↕
remote transfer state
```

Examples that MUST be handled:

### Case A

```text
DB says RECEIVING
file exists as .part
```

Recover according to the documented RECEIVING recovery policy.

### Case B

```text
DB says LOCAL_READY
finalized file missing
```

This is an invariant violation and MUST NOT silently become `COMPLETED`.

### Case C

```text
finalized file exists
DB has no corresponding transfer
```

Treat as orphaned data according to the cleanup/quarantine policy.

### Case D

```text
DB says UPLOADING
process crashed
```

Recover through the scheduler/reconciler.

The specification already requires non-terminal transfers to survive shutdown and be recovered on the next `start()`.

---

# 8. State Machine Must Be the Only State Mutation Authority

No component other than the state-machine layer may directly mutate the transfer `state` column.

The implementation MUST enforce:

```text
Component
    ↓
StateMachine.transition(event)
    ↓
validated transition
    ↓
side-effect orchestration
    ↓
persistence
```

and never:

```js
db.run("UPDATE transfers SET state = ...");
```

from arbitrary components.

This is explicitly an existing FTS invariant.

---

# 9. Explicit State-Machine Transition Coverage

The implementation plan MUST produce an explicit transition matrix covering at minimum:

```text
RECEIVING
LOCAL_READY
QUEUED
UPLOADING
RETRY_WAIT
PAUSED
VERIFYING
COMPLETED
FAILED
CANCELLED
```

and every legal transition between them.

It must also explicitly define behavior for:

- ingestion failure
- disk-full failure
- hash failure
- file corruption
- backend unavailable
- timeout
- retryable error
- permanent backend error
- cancellation
- process crash
- shutdown
- restart
- missing file
- duplicate acknowledgement
- duplicate completion
- stale worker
- corrupted metadata

No implicit state transitions should exist.

---

# 10. Worker Ownership and Concurrency

Every transfer worker MUST have a clearly defined ownership model.

A transfer must not accidentally be executed by two workers simultaneously.

The implementation MUST define:

```text
How a transfer becomes owned
How ownership is persisted
How ownership expires
How a crashed worker is detected
How another worker safely resumes it
```

Do not rely exclusively on in-memory locks.

The scheduler must survive process restart.

---

# 11. Chunk Durability

The implementation MUST explicitly persist chunk progress.

A chunk must not be considered acknowledged merely because:

```js
await backend.uploadChunk(...)
```

returned successfully.

The durable state must be committed before the transfer can depend on that acknowledgement after restart.

The existing invariant explicitly requires every chunk acknowledgement to be durably recorded before reaching `VERIFYING`.

---

# 12. Chunk Identity

Every chunk MUST have a deterministic identity.

At minimum:

```text
transferId
chunkIndex
offset
length
chunkHash
```

must be sufficient to reconstruct the chunk.

The implementation must define whether chunk indexing begins at `0` or `1` and use it consistently.

The chunk representation must not depend on runtime memory.

---

# 13. Whole-File Integrity

The FTS must maintain both:

```text
whole-file SHA-256
chunk SHA-256
```

The whole-file hash is established during ingestion.

Chunk hashes are established during upload.

The Backend completion operation must ultimately correspond to the same whole-file identity.

The implementation must never trust a remote completion response without correlating it to the expected transfer/file identity.

---

# 14. BackendTransferClient Contract

The FTS MUST NOT know whether the Backend uses:

- HTTP
- HTTPS
- QUIC
- WebSockets
- another RPC mechanism

The FTS sees only an abstract interface.

Conceptually:

```ts
interface BackendTransferClient {
    createTransfer(...): Promise<...>;
    uploadChunk(...): Promise<...>;
    completeTransfer(...): Promise<...>;
    cancelTransfer(...): Promise<...>;
}
```

The exact contract from the main specification remains authoritative.

The FTS MUST NOT construct authentication credentials.

The FTS MUST NOT retrieve credentials.

The FTS MUST receive an already-authorized client from its parent Runtime.

The existing trust boundary explicitly states that FTS never sees credentials.

---

# 15. Idempotency Must Be Explicit

The implementation MUST define idempotency for:

```text
createTransfer
uploadChunk
completeTransfer
cancelTransfer
```

A retry must never corrupt state merely because the previous request actually reached the Backend but its response was lost.

The existing specification already makes this a core invariant: remote-session creation, chunk upload, and completion must be idempotent.

---

# 16. Retry Classification

Do not implement:

```js
catch {
    retry();
}
```

The implementation MUST distinguish:

### Retryable

Examples:

- timeout
- connection reset
- temporary network failure
- Backend unavailable
- transient 5xx-style failure

### Non-retryable

Examples:

- invalid transfer
- invalid authentication supplied by the client
- unsupported operation
- permanent Backend rejection
- corrupted local file

### Unknown

Unknown errors must have an explicit safe policy rather than being silently treated as retryable forever.

---

# 17. Retry Budget

The retry system MUST have:

- bounded hot retries
- exponential backoff
- jitter
- maximum delay
- persisted retry metadata
- cold retry/recovery mechanism
- terminal failure policy

The implementation must prevent a permanently failing transfer from creating an infinite hot-loop.

---

# 18. Cancellation Semantics

Cancellation is a first-class state transition.

The existing specification correctly defines cancellation as a local decision that the FTS honors even if remote cancellation fails.

Therefore:

```text
cancel()
    ↓
stop scheduling new chunks
    ↓
allow/terminate in-flight operations according to policy
    ↓
best-effort remote cancellation
    ↓
persist CANCELLED
    ↓
emit TransferCancelled
```

A failed Backend cancellation must not cause the local cancellation to be reverted.

---

# 19. Event System

FTS events represent **facts**, not commands.

For example:

```text
TransferAccepted
TransferLocalReady
TransferUploadStarted
TransferProgress
TransferRetryScheduled
TransferPaused
TransferCompleted
TransferFailed
TransferCancelled
```

Events should contain identifiers and relevant metadata, but never:

- credentials
- authentication tokens
- private keys
- Backend secrets
- raw authorization material

The existing specification explicitly requires credentials and authentication material never to appear in logs, errors, or event payloads.

---

# 20. Event Delivery Semantics

The implementation MUST explicitly decide whether events are:

```text
best-effort in-memory events
```

or

```text
durable events
```

For critical application synchronization, prefer a durable/outbox mechanism rather than assuming an in-memory event listener will always be alive.

For example:

```text
FTS state committed
      ↓
outbox event committed
      ↓
event dispatcher
      ↓
Runtime
```

If the existing specification intentionally chooses an in-memory event bus, document the consequence clearly rather than silently upgrading it.

---

# 21. Progress Reporting

Progress must be derived from durable transfer information rather than requiring the FTS to buffer the file.

At minimum:

```text
bytesUploaded
totalBytes
chunksCompleted
totalChunks
state
```

should be reconstructible.

Progress events must not become the authoritative source of transfer state.

---

# 22. Logging

FTS logging must be infrastructure-grade.

Every log should have structured fields such as:

```text
component
transferId
fileId
chunkIndex
state
event
attempt
errorCode
duration
```

Never log:

```text
access tokens
refresh tokens
API keys
private keys
raw authorization headers
Backend credentials
raw request bodies
file contents
```

Errors should use stable machine-readable error codes.

---

# 23. Error Model

The implementation should define a proper FTS error taxonomy rather than throwing arbitrary strings.

For example:

```text
FTS_INVALID_INPUT
FTS_FILE_TOO_LARGE
FTS_DISK_FULL
FTS_SOURCE_ABORTED
FTS_LOCAL_IO
FTS_HASH_MISMATCH
FTS_BACKEND_UNAVAILABLE
FTS_BACKEND_REJECTED
FTS_RETRY_EXHAUSTED
FTS_CORRUPTED_STATE
FTS_RECOVERY_REQUIRED
FTS_CANCELLED
FTS_SHUTDOWN
```

The exact names may differ, but the principle is mandatory.

---

# 24. Resource Limits

Before implementation, explicitly define limits for:

- maximum file size
- maximum concurrent transfers
- maximum concurrent chunk uploads
- maximum chunks per transfer
- maximum retry count
- maximum retry delay
- disk reservation
- temporary disk usage
- event queue size
- metadata sizes
- filename length

The existing plan already exposes several of these as configuration values, including chunk size, maximum file size, concurrent transfers, concurrent chunk uploads, and retry policy.

Do not leave critical resource limits as accidental defaults.

---

# 25. Disk-Full Handling

Disk exhaustion must be treated as a first-class failure.

The FTS must distinguish:

```text
temporary lack of space
```

from:

```text
permanent invalid storage configuration
```

It must also prevent partial files from being mistaken for completed files.

---

# 26. Filename Handling

Never construct filesystem paths directly from user-provided filenames.

The physical file identity must be generated independently.

For example:

```text
fileId = cryptographically random identifier
```

The suggested filename is metadata only.

It must not become the authoritative filesystem path.

---

# 27. Crash Safety

The implementation plan must explicitly test crashes at every critical boundary:

```text
before temp file creation
during ingestion
after final fsync
before rename
after rename
before DB commit
after DB commit
before LOCAL_READY
during chunk upload
after remote ACK
before chunk DB commit
after chunk DB commit
before completion
after completion response
before COMPLETED commit
```

These are more important than merely testing a generic "crash recovery" path.

---

# 28. Recovery Must Be Deterministic

Recovery must never ask:

> "What probably happened?"

It must derive the answer from authoritative evidence:

```text
DB state
filesystem state
persisted chunk state
remote idempotent state
```

If the evidence is contradictory, the system must enter an explicitly defined recovery/error state rather than guessing.

---

# 29. Startup Ordering

The implementation MUST define exact startup order.

Recommended:

```text
FileTransferService.initialize()
    ↓
open SQLite
    ↓
run migrations
    ↓
validate schema
    ↓
validate/create directories
    ↓
same-volume validation
    ↓
reconcile filesystem
    ↓
reconcile DB state
    ↓
recover interrupted transfers
    ↓
start scheduler
    ↓
start retry timer
    ↓
FTS READY
```

The existing API already distinguishes `initialize()` from `start()`, with initialization responsible for DB/migrations/directories/self-checks and `start()` responsible for recovery and scheduler startup.

Preserve that separation.

---

# 30. Shutdown Ordering

Graceful shutdown should be:

```text
stop accepting new transfers
        ↓
stop scheduler admission
        ↓
signal workers
        ↓
allow in-flight operations to finish until deadline
        ↓
persist/checkpoint state
        ↓
checkpoint WAL
        ↓
close DB
        ↓
release filesystem/network resources
```

A forced process termination must remain recoverable.

---

# 31. FTS Lifecycle State

The FTS itself should have an explicit lifecycle:

```text
CREATED
INITIALIZING
READY
STOPPING
STOPPED
SHUTDOWN
FAILED
```

Public methods must enforce lifecycle validity.

For example:

```text
consume() before READY → reject
start() twice → reject/idempotent according to specification
shutdown() → permanently terminal
consume() after shutdown → reject
```

---

# 32. Security Authority Interaction

The FTS should not duplicate Security Authority logic.

The relationship is:

```text
Security Authority
        ↓
Runtime
        ↓
authorized BackendTransferClient
        ↓
FTS
```

The FTS should not become a second authentication system.

The existing architecture explicitly treats Security Authority as a sibling subsystem responsible for authentication, licensing, identity and anti-tamper, not file transfer.

---

# 33. Testing Architecture

Tests must exist at four levels.

## Unit

Test:

- state transitions
- chunk calculations
- hashing
- retry calculations
- metadata validation
- error classification

## Integration

Test:

```text
FTS
+ SQLite
+ filesystem
+ BackendTransferClient mock
```

## Crash/Recovery

Actually interrupt operations at defined boundaries and restart the FTS.

## Property/Stress

Test:

- random transfer sizes
- random chunk sizes
- repeated failures
- duplicate acknowledgements
- out-of-order responses
- cancellation races
- concurrent transfers
- restart loops

---

# 34. Critical Race Tests

The implementation MUST specifically test:

### Cancellation vs upload

```text
uploadChunk()
       ↕
cancel()
```

### Completion vs cancellation

```text
completeTransfer()
       ↕
cancel()
```

### Scheduler vs recovery

```text
startup recovery
       ↕
scheduler admission
```

### Worker duplication

```text
worker A
worker B
   ↓
same transfer
```

### Shutdown vs chunk acknowledgement

```text
ACK
 ↕
shutdown
```

### DB commit vs event emission

```text
DB commit
 ↕
event emission
```

---

# 35. No Hidden Global State

The FTS must not rely on global mutable state for correctness.

Everything required for an FTS instance must be owned by:

```js
new FileTransferService(...)
```

This allows:

- isolated tests
- multiple instances if ever required
- deterministic lifecycle
- controlled dependency injection

---

# 36. Dependency Injection

External infrastructure must be injected where practical.

At minimum:

```text
BackendTransferClient
Clock
Filesystem abstraction where useful
Event sink/bus
Logger
```

This makes failure and recovery testing deterministic.

Do not make the implementation depend on hard-coded global networking or filesystem state.

---

# 37. Do Not Over-Engineer the FTS

The FTS should not acquire responsibilities simply because they are technically convenient.

Do NOT add:

- HTTP server
- authentication system
- authorization engine
- WebSocket server
- application DB access
- Backend URL configuration
- user-session management
- business entities
- application notifications

Those belong outside the FTS.

---

# 38. Implementation Order

The implementation should proceed in dependency order:

```text
1. FTS domain types
        ↓
2. Error model
        ↓
3. SQLite schema + repository
        ↓
4. LocalFileStore
        ↓
5. ingestion pipeline
        ↓
6. hashing/chunking
        ↓
7. state machine
        ↓
8. retry policy
        ↓
9. scheduler
        ↓
10. transfer worker
        ↓
11. BackendTransferClient contract
        ↓
12. recovery reconciler
        ↓
13. event system
        ↓
14. HTTP adapter
        ↓
15. FileTransferService facade
        ↓
16. integration tests
        ↓
17. crash/recovery tests
        ↓
18. stress/property tests
```

Do not implement the entire facade first and fill the internals afterward.

---

# 39. Implementation Agent Rules

The implementation agent MUST:

1. Read the complete FTS specification.
2. Read this amendment.
3. Inspect the existing repository before creating files.
4. Reuse existing infrastructure where it matches the specification.
5. Avoid duplicating existing Security Authority infrastructure.
6. Never silently change an architectural decision.
7. Record unresolved ambiguities instead of inventing behavior.
8. Keep HTTP confined to adapters.
9. Keep Backend protocol confined to `BackendTransferClient`.
10. Keep application DB access outside FTS.
11. Keep FTS state transitions centralized.
12. Make crash recovery a first-class implementation concern.
13. Write tests alongside each subsystem.
14. Do not mark functionality complete merely because unit tests pass.
15. Run integration and recovery tests before declaring the subsystem complete.

---

# 40. Required Implementation Deliverables

Before declaring the FTS complete, the implementation must produce:

```text
A. Source implementation
B. SQLite schema/migrations
C. Filesystem layout implementation
D. State-machine implementation
E. Retry implementation
F. Chunking/hashing implementation
G. Scheduler/worker implementation
H. Recovery implementation
I. BackendTransferClient interface
J. Event contract
K. Error taxonomy
L. Configuration contract
M. HTTP adapter
N. Unit tests
O. Integration tests
P. Crash/recovery tests
Q. Concurrency/stress tests
R. Final implementation traceability matrix
```

---

# 41. Final Acceptance Test

The FTS is not considered complete merely because:

```text
upload works
```

It is complete only when this entire lifecycle works:

```text
HTTP request
    ↓
consumeHttpRequest()
    ↓
generic source
    ↓
stream ingestion
    ↓
backpressure
    ↓
incremental hash
    ↓
fsync
    ↓
atomic rename
    ↓
SQLite LOCAL_READY
    ↓
consume() resolves
    ↓
Runtime can return 202
    ↓
scheduler
    ↓
worker
    ↓
chunking
    ↓
hashing
    ↓
BackendTransferClient
    ↓
retry/recovery when required
    ↓
all chunks durably acknowledged
    ↓
remote completion
    ↓
COMPLETED
    ↓
TransferCompleted event
    ↓
Runtime reacts
```

The architecture must remain valid across:

```text
normal operation
network failure
Backend failure
disk failure
process crash
machine restart
shutdown
cancellation
duplicate acknowledgements
concurrent transfers
partial uploads
recovery
```

---

# 42. Final Architectural Principle

The implementation should preserve this fundamental separation:

```text
             CONTROL PLANE RUNTIME
                     │
       ┌─────────────┴──────────────┐
       │                            │
       ▼                            ▼
 Security Authority          File Transfer Service
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                 SQLite        Local Disk      Scheduler
                    │                             │
                    │                             ▼
                    │                    BackendTransferClient
                    │                             │
                    │                             ▼
                    │                         Backend
                    │
                    ▼
              Transfer State
```

The FTS should effectively become a **self-contained transfer engine** that the rest of the Control Plane can treat as infrastructure.

The Runtime should eventually be able to say:

```js
const transfer = await fts.consumeHttpRequest(req);
```

and know only:

> "The file is now locally durable."

Later:

```js
fts.on("TransferCompleted", handler);
```

and know:

> "The file is now remotely durable."

Everything between those two facts belongs to the FTS.

---

## Summary & Closing

**Final architecture, in one line:** a transport-agnostic ingestion pipeline that achieves local durability synchronously (one atomic rename + one atomic DB commit), then hands off to an independently-scheduled, chunked, retry-and-recovery-aware background uploader that talks to the outside world only through an injected client and communicates outward only through facts (events), never instructions.

**Open decisions/blockers, collected:**

1. `synchronous=FULL` vs `NORMAL` for SQLite (D.1) — performance vs. power-loss durability trade-off, needs profiling data this document doesn't have.
2. Default chunk size (8 MiB), hot/cold retry numbers, `maxFileSize`, cancellation retention window — all reasonable defaults, none sourced from a hard requirement.
3. Whether `incoming/`/`finalized/` same-volume is enforced by deployment config or by FTS's own startup check (E.3) — recommend the latter, not yet decided against the actual deployment topology.
4. Whether a hash-mismatch-on-recovery should raise a distinct security signal toward the Security Authority (`SECURITY_STATE_UNCERTAIN`-style) — genuinely blocked on the actual SPC docs, not guessable from this conversation (L).
5. Whether multi-process/multi-instance FTS needs to be supported at all — assumed single-instance-per-machine, not confirmed.
6. Whether a `transfer_events` audit table earns its keep (D.2) — leaning no by default, flagged as a cheap future add.

This document is intended to be implementable directly, phase by phase (§J), without redesigning any of the above during implementation — anything still undecided is explicitly marked as such rather than silently resolved.

# Control Plane File Transfer Service

## Architecture and Behavioral Specification

**Status:** Design Specification
**System:** Runtime Synchronization Platform — Control Plane
**Component:** File Transfer Service
**Primary responsibility:** Durable, resumable, integrity-verified transfer of user-provided files between the Frontend and Backend.

---

# 1. Purpose

The File Transfer Service provides reliable file upload and download capabilities for the local Control Plane.

Its primary use case is the transfer of files such as:

- MP4 recordings
- JPEG images
- PNG images
- diagnostic artifacts
- exported data
- runtime-generated artifacts
- future supported file types

The service exists because the Frontend should not be responsible for communicating directly with the Backend for large or failure-sensitive file transfers.

Instead:

```text
Frontend
    │
    │ local HTTP
    ▼
Control Plane
    │
    │ durable resumable transfer
    ▼
Backend
```

The Control Plane acts as a **local durable transfer agent**.

The Frontend only needs to successfully deliver the file to the Control Plane.

Once the Control Plane has durably accepted the file, the Control Plane becomes responsible for completing the Backend transfer.

---

# 2. Architectural Position & Subsystem Decomposition

The File Transfer Service is an internal service of the Control Plane.

It is not part of the Frontend.
It is not part of the Backend.
It is not part of the Execution Plane.

The service is explicitly decomposed into specialized subsystems to ensure a durable, resumable, and integrity-preserving architecture.

### FileTransferService (Facade)

- **Responsibility:** Orchestrates high-level API operations by delegating to specific managers.
- **Inputs:** Client requests (create, upload, download, cancel).
- **Outputs:** Operation results, Domain Events.
- **Dependencies:** All subsystems below.

### TransferManager

- **Responsibility:** Coordinates the end-to-end lifecycle of a single transfer.
- **Owned State:** In-memory coordination of active transfers.
- **Dependencies:** `TransferStateManager`, `UploadManager`, `DownloadManager`, `StorageManager`.

### UploadManager & DownloadManager

- **Responsibility:** Executes stream processing for data moving to/from the Backend.
- **Dependencies:** `ChunkManager`, `IntegrityManager`, `BackendTransferClient`.

### TransferStateManager

- **Responsibility:** Sole authority for reading and mutating persistent transfer state (SQLite).
- **MUST NOT KNOW ABOUT:** Filesystem paths, network protocols.

### ChunkManager

- **Responsibility:** Slices streams into deterministic chunks and tracks their individual states and offsets.

### IntegrityManager

- **Responsibility:** Calculates and verifies SHA-256 hashes.

### RetryManager & ReconciliationManager

- **Responsibility:** Determines when to retry versus when to query the Backend for ambiguous states.

### StorageManager & CacheManager

- **Responsibility:** Manages all local filesystem paths, capacity accounting, and artifact retention policies. The Frontend MUST NOT control paths.

### GarbageCollector

- **Responsibility:** Background sweeper for orphaned files and stale SQLite records.

### FailureClassifier

- **Responsibility:** Categorizes errors (e.g., HTTP 5xx vs Disk Full) into actionable classes (RETRY, RECONCILE, FAIL, PAUSE).

### BackendTransferClient

- **Responsibility:** Encapsulates raw HTTP/WebSocket transport to the Backend.

### TransferEventBus

- **Responsibility:** Emits domain events to decouple the service from presentation gateways.

```text
                         Backend
                            ▲
                            │
                  Resumable transfer protocol
                            │
                            ▼
┌─────────────────────────────────────────────────────┐
│                    CONTROL PLANE                    │
│                                                     │
│   API Server                                        │
│       │                                             │
│       ▼                                             │
│   File Transfer Service                             │
│       │                                             │
│       ├── Transfer Manager                          │
│       ├── Upload Manager                            │
│       ├── Chunk Manager                             │
│       ├── Integrity Manager                         │
│       ├── Retry Manager                             │
│       ├── Recovery Manager                          │
│       ├── Cache Manager                             │
│       ├── Persistence Adapter                       │
│       └── Backend Transfer Client                   │
│                                                     │
│             │                         │              │
│             ▼                         ▼              │
│          SQLite                 Local File Cache     │
└─────────────────────────────────────────────────────┘
                            ▲
                            │
                       Local HTTP
                            │
                            ▼
                        Frontend
```

The service must not contain Frontend-specific business logic.

It must not contain Backend business rules.

It must not contain Execution Plane logic.

---

# 3. Core Architectural Principle

The service follows:

> **Persist first, transfer second.**

The Control Plane must not consider an upload successfully accepted merely because the file arrived in memory or because an HTTP request was received.

The file becomes an accepted local transfer only after it has been durably stored and its integrity has been established.

Therefore:

```text
Frontend
    │
    ▼
Receive
    │
    ▼
Validate
    │
    ▼
Persist
    │
    ▼
Verify
    │
    ▼
Durably Accepted
    │
    ▼
Backend Transfer
```

This protects the system from:

- network failures
- Backend downtime
- Control Plane crashes
- Frontend disconnections
- process restarts
- partial transfers
- corrupted files
- interrupted uploads

---

# 4. Responsibilities

The File Transfer Service owns:

### Upload

- Accept files from the Frontend.
- Stream incoming data.
- Validate upload metadata.
- Enforce limits.
- Persist files locally.
- Split files into chunks.
- Calculate file and chunk hashes.
- Persist transfer state.
- Upload chunks to the Backend.
- Retry failed chunks.
- Resume interrupted transfers.
- Reconcile transfer state with the Backend.
- Verify Backend acknowledgements.
- Complete transfers.
- Garbage-collect completed files.

### Download

- Retrieve files from the Backend.
- Stream data to local storage where appropriate.
- Verify downloaded data.
- Cache files when required.
- Stream files to the Frontend.
- Support cancellation.
- Support resumable downloads where required.

### Recovery

- Recover incomplete transfers after restart.
- Detect stale transfers.
- Resume pending transfers.
- Reconcile uncertain Backend state.
- Prevent duplicate completion.
- Clean up abandoned temporary files.

### Integrity

- Calculate file hashes.
- Calculate chunk hashes.
- Verify chunks.
- Verify reconstructed files.
- Detect corruption.

---

# 5. Non-Responsibilities

The service must not own:

- User authentication policy.
- Subscription business rules.
- Account management.
- License authority.
- Frontend presentation.
- Browser automation.
- Execution Plane behavior.
- Backend database state.
- Backend subscription state.

For example, the service may know:

```text
authenticated session = valid
```

but it must not implement:

```text
subscription = Premium
```

That belongs to the appropriate authorization/licensing subsystem.

---

# 5.1 Upload Architecture Pipeline

The upload pipeline ensures the complete file never resides in RAM simultaneously. It relies strictly on streaming and bounded buffers.

**Lifecycle:**

1.  **Frontend** initiates request.
2.  **Control Plane** validates request and creates transfer via `TransferStateManager`.
3.  `StorageManager` reserves local capacity.
4.  Frontend streams file to Control Plane; `UploadManager` streams data strictly to disk.
5.  `ChunkManager` logically divides file (e.g., configurable 1MB chunks).
6.  `IntegrityManager` hashes each chunk on the fly.
7.  `BackendTransferClient` uploads chunks.
8.  **Backend** verifies chunk hashes during receipt.
9.  **Backend** assembles file and verifies final file hash against expected hash.
10. Transfer completion acknowledged to Control Plane.

---

# 5.2 Download Architecture Pipeline

The mirrored download pipeline enforces integrity before availability.

**Lifecycle:**

1.  **Backend** notifies Control Plane of a pending download.
2.  `BackendTransferClient` requests data.
3.  Data is streamed directly to a `StorageManager` Temporary File path.
4.  `IntegrityManager` performs streaming Hash Verification during the download.
5.  **Hash Match:** File is promoted to a Verified Cached Artifact.
6.  **Frontend** is permitted to access the verified artifact.

**Failure Handling:**

- If interrupted, the temporary file is retained for resumability.
- If the hash mismatches, the corrupted file is deleted, and the process restarts or fails.
- If a verified cached artifact already exists, the download is safely skipped.

---

# 6. Transfer State Machine

The `TransferStateManager` is the sole authority for mutating states. Prevent arbitrary components from mutating transfer state.

Every transfer is represented by an explicit state machine.

## Upload state machine

```text
REQUESTED
    │
    ▼
RECEIVING
    │
    ▼
VERIFYING_LOCAL
    │
    ▼
CACHED
    │
    ▼
QUEUED
    │
    ▼
UPLOADING
    │
    ├───────────────┐
    │               │
    ▼               ▼
RETRY_WAIT       FAILED
    │
    ▼
UPLOADING
    │
    ▼
REMOTE_VERIFICATION
    │
    ▼
COMPLETED
    │
    ▼
CLEANUP
```

A transfer may also enter:

```text
CANCELLED
EXPIRED
CORRUPTED
REQUIRES_RECONCILIATION
```

---

# 7. Important State Semantics

## REQUESTED

A transfer request has been accepted by the API layer but file data has not necessarily started arriving.

## RECEIVING

The Control Plane is receiving the file from the Frontend.

The file is written to temporary storage.

## VERIFYING_LOCAL

The Control Plane has received the file and is verifying:

- size
- content policy
- file hash
- metadata
- storage completeness

## CACHED

The complete file exists in durable local storage.

At this point the Frontend does not need to remain connected.

## QUEUED

The file is ready for Backend transfer.

## UPLOADING

One or more chunks are being transferred to the Backend.

## RETRY_WAIT

A transient failure occurred.

The transfer is scheduled for another attempt.

## REMOTE_VERIFICATION

All chunks have been transferred and the Backend is reconstructing and validating the file.

## COMPLETED

The Backend has authoritatively confirmed the file.

Only after this state is reached should the file become eligible for deletion according to the cache policy.

---

# 8. File Storage Model (Storage Manager)

The `StorageManager` provides centralized capacity accounting and path management. The Frontend NEVER controls filesystem paths.

All paths must be generated by the Control Plane. For example:

```text
storage/
└── transfers/
    └── <transfer_id>/
        ├── metadata/
        ├── temporary/
        ├── chunks/
        └── assembled/
```

The exact directory layout may change during implementation.

The important rule is:

> Temporary files must never be treated as completed artifacts.

An upload should initially be written to a temporary path.

Example:

```text
temporary/
    transfer-8f31.partial
```

After the upload is complete and verified:

```text
uploads/
    8f31/
        original.mp4
```

The transition should be atomic where the filesystem permits it.

---

# 9. SQLite Persistence

Transfer state must survive process termination, crashes, and machine restarts. The authoritative state lives in SQLite.

**Persistent State Entities:**

- `transfers`
- `transfer_chunks`
- `transfer_artifacts`
- `transfer_attempts`

**Relationships and Invariants:**

- A transfer cannot be marked complete unless all constituent chunks are acknowledged.
- A chunk cannot exist without a parent transfer.

**Recovery Requirements:**

- At startup, the Control Plane scans the database for non-terminal states and triggers reconciliation/resumption.

_Note: The physical schema and indexes are left to the implementation, provided they support these transactional invariants. SQLite stores metadata and transfer state, not file contents._

This separation prevents SQLite from becoming a large binary object store.

---

# 10. Transfer Record

A transfer record should contain information conceptually equivalent to:

```text
Transfer
────────────────────────────
transfer_id
session_id
direction
state
original_filename
content_type
file_size
chunk_size
total_chunks
file_hash_algorithm
file_hash
storage_path
created_at
updated_at
completed_at
attempt_count
next_attempt_at
backend_transfer_id
backend_status
```

Additional metadata can be added as the protocol evolves.

---

# 11. Chunk Record

Each chunk should have metadata equivalent to:

```text
Chunk
────────────────────────────
transfer_id
chunk_index
offset
size
hash_algorithm
hash
state
attempt_count
uploaded_at
backend_reference
```

The `chunk_index` must be deterministic.

For example:

```text
chunk 0
chunk 1
chunk 2
...
chunk N
```

The final chunk may be smaller than the configured chunk size.

---

# 12. Chunk Size

The initial implementation may use:

```text
1 MiB
```

or another configurable size such as:

```text
512 KiB
```

The chunk size should be part of the transfer metadata.

It must not change in the middle of a transfer.

For example:

```text
transfer A
chunk size = 1 MiB
```

Every participant must use that value.

A future protocol version may support adaptive chunk sizes, but that should not be introduced until required.

---

# 13. Two-Level Integrity Model

The File Transfer Service strictly enforces a two-level integrity model.

### 13.1 Level 1: Chunk Integrity

Every chunk possesses a `chunk_index`, `chunk_size`, and cryptographic `chunk_hash` (e.g., SHA-256).

```text
chunk 0 → H0
chunk 1 → H1
chunk 2 → H2
```

The Control Plane sends both the chunk and its expected hash to the Backend. The Backend independently calculates the hash upon receipt.

If the hashes differ:

```text
REJECT_CHUNK
```

The Control Plane must retransmit that chunk.

### 13.2 Level 2: Complete Artifact Integrity

The original file possesses a `file_size` and a cryptographic `file_hash` (e.g., SHA-256). The file hash represents the expected final artifact.

The Backend should not treat the file as valid merely because every chunk was received and verified at Level 1.

After all chunks have been acknowledged:

```text
chunks → ordered reconstruction → complete file → SHA-256
```

The resulting hash must be compared against the original file hash supplied as part of the authenticated transfer metadata.

```text
backend_hash == original_file_hash
```

Only then does the transfer become `TRANSFER_VERIFIED`.

Otherwise, a fatal `INTEGRITY_FAILURE` occurs. The reconstructed artifact is destroyed, and the transfer fails permanently. The artifact must not be promoted to a valid completed file when the hashes disagree.

---

# 16. Resumability

The transfer protocol must support resuming.

Example:

```text
Transfer: ABC

Chunks:
0 ✓
1 ✓
2 ✓
3 ✓
4 ✓
5 ✗
6 ✗
7 ✗
```

The Control Plane must not resend chunks `0–4`.

It should resume from the missing chunks.

The Backend should expose a mechanism conceptually equivalent to:

```text
GetTransferStatus(transfer_id)
```

which can return:

```text
received_chunks:
    0
    1
    2
    3
    4
```

The Control Plane then continues from the missing set.

---

# 17. Crash Recovery

Crash recovery is a core requirement.

Consider:

```text
Control Plane
    │
    ├── 400 chunks uploaded
    │
    └── process crashes
```

After restart:

```text
Control Plane starts
        │
        ▼
Recovery Manager
        │
        ▼
SQLite
        │
        ▼
find non-terminal transfers
        │
        ▼
Backend reconciliation
        │
        ▼
resume
```

The service must never assume that an in-memory state transition completed successfully.

Persistent state is authoritative for local recovery.

---

# 18. Ambiguous Network Failure

A particularly important case is:

```text
Control Plane
     │
     │ send chunk
     ▼
Backend
     │
     │ accepts chunk
     ▼
Backend → ACK
     X
  connection dies
```

The Control Plane doesn't know whether the Backend accepted the chunk.

It must not blindly assume failure.

Instead:

```text
unknown result
      │
      ▼
reconcile with Backend
      │
      ▼
GetTransferStatus()
```

The `ReconciliationManager` executes this query via the `BackendTransferClient`.

If the Backend already has the chunk:

```text
do not resend (mark COMPLETED)
```

If it doesn't:

```text
delegate to RetryManager to resend
```

This is an important part of making the protocol robust.

---

# 19. Idempotency

Every transfer and chunk operation should have stable identifiers.

For example:

```text
transfer_id = ABC
chunk_index = 17
```

The Backend can therefore recognize:

```text
"chunk 17 of transfer ABC"
```

If the Control Plane sends it twice, the Backend does not create two chunks. It safely acknowledges the duplicate.

This makes retries safe.

However, if the same `transfer_id` + `chunk_index` is submitted with a **different hash**:

```text
chunk 17 of transfer ABC (Hash = XYZ)
chunk 17 of transfer ABC (Hash = DEF)
```

The Backend must NOT silently overwrite valid data. It must reject the request to prevent corruption, and the Control Plane flags a critical integrity failure.

The transfer protocol should be designed around **idempotent operations** wherever possible.

---

# 20. Retry Policy (Retry Manager)

The `RetryManager` handles errors classified as `Retryable`. Blind infinite retries are strictly forbidden.

**Retry Mechanics:**

- **Exponential Backoff + Jitter:** Prevents thundering herds (e.g., `delay = base * 2^attempt + random_jitter`).
- **Maximum Attempts:** Transfers enforce a hard limit (e.g., 5 attempts) before permanently failing.
- **Maximum Retry Duration:** Prevents zombie transfers that retry for days.
- **Cancellation Awareness:** Active retries must be immediately aborted if the user triggers a `CancelTransfer` operation.

The retry policy interacts safely with chunk idempotency, ensuring duplicate transmissions do not corrupt the file.

---

# 21. Bounded Concurrency

The architecture must remain stable on machines with limited CPU, RAM, disk I/O, and network bandwidth. Concurrency limits are treated as **configurable global and per-transfer governance limits**.

- **Global Limits:** Maximum active transfers across the entire Control Plane.
- **Per-Transfer Limits:** Maximum concurrent chunks uploading simultaneously (e.g., configurable default of 4).
- **Resource Limits:** Maximum concurrent cryptographic hashing operations.

This bounded model prevents the system from creating hundreds of simultaneous network connections merely because a file contains hundreds of chunks.

---

# 22. Streaming and Backpressure

Streaming is a mandatory architectural property. The complete file MUST NEVER reside in RAM simultaneously.

**Backpressure Rules:**

- If the Backend is slower than the local disk (Upload), the local read stream pauses to prevent buffer bloat.
- If the local disk is slower than the network (Download), the TCP window shrinks automatically via Node stream backpressure.

**Maximum Buffer Size:**
The maximum buffer memory used by a transfer is strictly bounded by:
`chunk_size × maximum concurrent chunks`

The upload pipeline prevents OOM by enforcing strict flows:

```text
Disk → Read Stream → Chunking → Hashing → Network
```

The implementation must rely heavily on Node.js streams.

---

# 23. Upload API

The Frontend-facing API should be deliberately simple.

Conceptually:

```text
POST /transfers
```

The request establishes a transfer.

Then either:

```text
POST /transfers/:id/content
```

or an equivalent multipart endpoint receives the file.

The exact HTTP API should be defined separately from the internal service contract.

The Frontend should not know anything about:

- chunk hashing
- Backend retries
- Backend transfer IDs
- Backend availability
- reconstruction
- retry scheduling

Those are Control Plane concerns.

---

# 24. Upload Response

The Control Plane should distinguish between:

### Locally accepted

```text
UPLOAD_ACCEPTED
```

and:

### Backend completed

```text
UPLOAD_COMPLETED
```

For example, the Frontend may receive:

```text
{
    "transferId": "...",
    "state": "cached"
}
```

This means:

> The Control Plane has safely accepted the file.

It does **not** mean:

> The Backend has already received the file.

The Frontend can subsequently query:

```text
GET /transfers/:id
```

to determine progress.

---

# 25. Progress Reporting

The service should expose progress information.

For example:

```text
{
    "transferId": "...",
    "state": "uploading",
    "bytesTotal": 734003200,
    "bytesTransferred": 412876800,
    "chunksTotal": 700,
    "chunksCompleted": 394
}
```

The Control Plane can expose this through:

- HTTP polling
- WebSocket events
- Server-sent events

depending on the broader Control Plane API architecture.

---

# 26. Cancellation

Transfers should be cancellable.

```text
CancelTransfer(transferId)
```

Cancellation must be persisted.

The system should distinguish:

```text
CANCEL_REQUESTED
```

from:

```text
CANCELLED
```

because an upload may currently be executing.

After cancellation is confirmed:

- stop active transfers
- prevent retries
- clean temporary state
- mark the transfer terminal

---

# 27. Download Architecture

Downloads use a similar durable pipeline when local caching is required.

```text
Backend
   │
   ▼
Download Manager
   │
   ▼
Local temporary file
   │
   ▼
Integrity verification
   │
   ▼
Cached artifact
   │
   ▼
Frontend
```

For downloads that do not need local persistence, the service may stream directly where safe and appropriate.

Large files must not be unnecessarily loaded into memory.

---

# 28. Download Integrity

Downloads should support integrity verification when the Backend supplies expected metadata.

For example:

```text
expected SHA-256
       │
       ▼
download
       │
       ▼
calculate SHA-256
       │
       ▼
compare
```

Only after successful verification should a downloaded file be promoted from temporary storage to its final location.

---

# 29. Security Boundary

The File Transfer Service handles untrusted input from the Frontend.

The service must strictly validate all input:

- MIME type
- declared file size versus actual streamed bytes
- declared hashes versus calculated hashes
- protocol requests
- transfer IDs

The service must actively prevent:

- **Path Traversal:** The client must NEVER specify filesystem paths. The Control Plane generates all paths.
- **Arbitrary Filesystem Writes:** Temporary paths strictly isolate pending uploads.
- **Oversized Transfers:** Streams are aborted if bytes exceed the declared/allowed size.
- **Chunk Index Manipulation:** Out-of-bounds or unauthorized chunk indices are rejected.

---

# 30. Path Safety

The client must never determine the final filesystem path.

Bad model:

```text
saveTo = "../../some/path/file.mp4"
```

Correct model:

```text
transferId
    ↓
Control Plane determines storage path
```

The filesystem path must be generated by the service.

---

# 31. File Type Validation

The service may maintain an allowlist:

```text
video/mp4
image/jpeg
image/png
```

However, MIME type alone should not necessarily determine validity.

If stronger validation is required, the service may inspect file signatures or delegate content validation to a dedicated component.

---

# 32. Resource Limits

The service must enforce limits such as:

```text
maximum file size
maximum transfer size
maximum concurrent transfers
maximum concurrent chunks
maximum request size
maximum filename length
maximum metadata size
maximum retry count
maximum transfer lifetime
```

These values should be configuration-driven.

---

# 33. Cache Management

Local storage is finite. The Cache Manager enforces artifact lifecycle and retention policies.

Example policy:

```text
ACTIVE
    ↓
COMPLETED
    ↓
RETENTION_PERIOD (e.g. 24h)
    ↓
EXPIRED
    ↓
DELETED
```

- An artifact MUST NOT be deleted while it is actively required by a transfer.
- Failed, cancelled, or expired transfers have aggressive cleanup policies to reclaim space.
- Completed uploads/downloads are retained based on configurable LRU or time-to-live policies.

---

# 34. Crash-Safe Garbage Collection

The background Garbage Collector acts as a defensive sweeper. It must be strictly conservative to prevent deleting files associated with active transfers.

It detects and cleans up:

- orphaned temporary files (files without SQLite records)
- orphaned chunk directories
- abandoned partial downloads
- expired/abandoned transfers (e.g., transfers stuck in `TRANSFERRING` for > 48 hours)
- stale SQLite records without physical files (and vice versa)
- stale locks

The GC must logically prove a transfer is not `ACTIVE` before touching associated files.

---

# 35. Service Interfaces

The internal service should expose operations conceptually similar to:

```text
CreateUpload()
AcceptUpload()
FinalizeUpload()
GetTransfer()
CancelTransfer()
RetryTransfer()
ResumeTransfer()
DeleteTransfer()

CreateDownload()
StartDownload()
GetDownload()
CancelDownload()

RecoverTransfers()
ReconcileTransfer()
```

The exact API should be established after the state machine is finalized.

---

# 36. Domain Events

The File Transfer Service must not depend directly on the Frontend WebSocket implementation. It emits domain events through a `TransferEventBus` to decouple transfer logic from presentation logic.

These events include:

- `TransferCreated`
- `TransferStarted`
- `ChunkUploadStarted`
- `ChunkUploaded`
- `ChunkRetryScheduled`
- `TransferReconciliationStarted`
- `TransferReconciled`
- `TransferVerified`
- `TransferCompleted`
- `TransferFailed`
- `TransferCancelled`
- `DownloadStarted`
- `DownloadVerified`
- `CacheEvicted`

Other Control Plane components (e.g., WebSocket Gateway, Telemetry) subscribe to these events. The service itself remains oblivious to how the Frontend is notified.

---

# 37. Backend Client Encapsulation

The Backend communication is encapsulated behind a dedicated `BackendTransferClient`. The core File Transfer Service logic must not contain raw HTTP or WebSocket protocol details.

**Abstracted Interface:**

- `createTransfer()`
- `getTransferStatus()`
- `uploadChunk()`
- `downloadChunk()`
- `completeTransfer()`
- `cancelTransfer()`

The exact API signature is flexible, provided transport details remain behind this abstraction boundary. Neither side should assume an operation succeeded merely because a network connection existed.

---

# 38. Exactly-Once Consideration

The system should not attempt to implement magical "exactly once" network delivery.

Networks do not provide that guarantee.

Instead, the system should implement:

> **At-least-once delivery + idempotent operations + reconciliation.**

This is substantially more practical.

For example:

```text
send chunk
    ↓
timeout
    ↓
unknown result
    ↓
query Backend
    ↓
already exists?
    ├── yes → continue
    └── no  → retry
```

---

# 39. Data Integrity vs Security

Hashing provides integrity detection.

It does not by itself provide authorization.

For example:

```text
SHA-256(file)
```

answers:

> "Is this file the same as the expected file?"

It does not answer:

> "Who is authorized to upload this file?"

Authorization belongs to the Control Plane/Backend security architecture.

---

# 40. Authentication and Authorization

Every transfer must belong to an authenticated session.

Conceptually:

```text
User Session
     │
     ▼
Transfer
     │
     ▼
Backend Authorization
```

A transfer must not become an alternative route around the platform's authorization system.

The Backend should independently validate that the Control Plane is authorized to perform the transfer.

---

# 41. No Business Authority

The File Transfer Service should not decide:

```text
"User has Premium subscription."
```

It should receive the necessary authorization context from the appropriate Control Plane security/authorization subsystem and communicate with the Backend according to the established protocol.

This keeps licensing separate from file transfer.

---

# 42. Observability

Every transfer utilizes a stable `transferId`. Telemetry and logging are critical for observability but must never leak sensitive file contents or secrets.

**Tracked Metrics:**

- Transfer duration
- Upload and download throughput
- Chunk latency
- Retry counts
- Reconciliation triggers
- Hash verification failures
- Disk failures
- Cache utilization
- Active transfers, failed transfers, and abandoned transfers

Logs should include sufficient context (`transferId`, `sessionId`, `operation`, `state`, `chunkIndex`, `attempt`, `errorCode`) to allow a transfer's lifecycle to be entirely reconstructed from the log stream.

---

# 43. Failure Classification

The service explicitly classifies failures into distinct categories that dictate specific system actions.

### 43.1 Retryable (Action: RETRY)

- connection timeout
- connection reset
- DNS temporary failure
- HTTP 5xx
- temporary Backend unavailability

### 43.2 Reconciliation-required (Action: RECONCILE)

- request timeout after transmission
- connection lost before acknowledgement
- unknown Backend state

### 43.3 Non-retryable (Action: FAIL)

- 401 unauthorized or 403 forbidden
- unsupported file type
- invalid request or chunk
- permanent hash mismatch (chunk or full file)
- malformed protocol message

### 43.4 Local resource failures (Action: PAUSE or FAIL)

- disk full (PAUSE)
- permission denied (FAIL)
- filesystem corruption (FAIL)
- unavailable storage (PAUSE)

Different categories strictly map to their resulting recovery strategies.

---

# 44. Graceful Shutdown

When the Control Plane shuts down:

```text
Stop accepting new transfers
        ↓
Persist current state
        ↓
Allow safe operations to finish where possible
        ↓
Cancel/park active network operations
        ↓
Close database
        ↓
Exit
```

Transfers must remain recoverable after restart.

A shutdown must never cause the system to lose knowledge of a locally cached file.

---

# 45. Startup Recovery

At startup:

```text
Control Plane
    ↓
Initialize SQLite
    ↓
Initialize File Transfer Service
    ↓
Scan transfer state
    ↓
Find non-terminal transfers
    ↓
Validate filesystem state
    ↓
Recover
    ↓
Reconcile Backend state
    ↓
Resume eligible transfers
```

Recovery should happen before the service reports itself fully ready if incomplete transfer state is critical to application correctness.

---

# 46. API vs Service Separation

The HTTP layer is an adapter.

It should look conceptually like:

```text
HTTP Request
    ↓
Controller
    ↓
Request Validation
    ↓
File Transfer Service
    ↓
Result
    ↓
HTTP Response
```

Not:

```text
HTTP Request
    ↓
Express route
    ↓
SQLite
    ↓
Busboy
    ↓
HTTP Backend request
    ↓
retry
    ↓
filesystem
```

All significant behavior belongs inside the service.

---

# 47. Technology Choices

Initial implementation can use:

### Node.js

For:

- orchestration
- streaming
- filesystem operations
- network communication
- service lifecycle

### Express

For:

- Frontend-facing HTTP API

### Busboy

For:

- streaming multipart uploads

Multer is optional and should not be required if the lower-level streaming model is preferred.

### SQLite

For:

- transfer state
- metadata
- retry state
- recovery state

### Filesystem

For:

- large binary artifacts
- temporary uploads
- cached files

### Node `crypto`

For:

- SHA-256
- random identifiers
- other standard cryptographic primitives required by the protocol

---

# 48. Initial Dependency Principle

The service should avoid unnecessary dependencies.

The architecture should rely heavily on Node's standard library for:

```text
streams
fs
crypto
path
events
http
https
AbortController
```

Third-party dependencies should be introduced only when they provide meaningful value.

---

# 49. Performance Requirements

The service must be designed around streaming.

It must not:

```text
read 2 GB file
      ↓
allocate 2 GB Buffer
      ↓
hash
      ↓
upload
```

Instead:

```text
stream
  ↓
chunk
  ↓
hash
  ↓
disk/network
```

Memory usage should remain approximately bounded regardless of total file size.

---

# 50. Future Optimization

The first implementation should prioritize correctness.

Later optimizations may include:

- parallel chunk uploads
- resumable downloads
- adaptive concurrency
- bandwidth throttling
- deduplication
- content-addressable storage
- compression where appropriate
- zero-copy paths where beneficial
- native hashing
- Rust-based transfer components

These should not complicate the initial correctness model.

---

# 51. Security Philosophy

The File Transfer Service follows:

> **Assume input is hostile, assume networks fail, assume processes crash, and assume operations may be repeated.**

Therefore:

```text
Validate
Persist
Hash
Authenticate
Transfer
Verify
Acknowledge
Recover
```

No single successful network request should be treated as proof that a transfer completed.

---

# 52. End-to-End Upload Example

Suppose a user records a 600 MB MP4.

### Step 1 — Frontend

The Frontend sends:

```text
POST /transfers
Content-Type: multipart/form-data
```

### Step 2 — Control Plane

Busboy streams the file.

The Control Plane:

- validates metadata
- enforces limits
- writes the temporary file
- calculates the file hash

### Step 3 — Local completion

The file becomes:

```text
CACHED
```

SQLite records:

```text
transferId
fileSize
fileHash
chunkSize
totalChunks
storagePath
state=CACHED
```

### Step 4 — Chunking

The file is divided into:

```text
1 MiB chunks
```

Each chunk receives a SHA-256 hash.

### Step 5 — Backend transfer

Chunks are uploaded.

```text
0 ✓
1 ✓
2 ✓
3 ✗
4 ✓
5 ✓
```

Only chunk `3` requires retransmission.

### Step 6 — Failure

The network disappears.

The transfer enters:

```text
RETRY_WAIT
```

The file remains safely cached.

### Step 7 — Recovery

Network returns.

The Control Plane asks the Backend for transfer status.

The Backend reports which chunks it already has.

Only missing chunks are transferred.

### Step 8 — Reconstruction

The Backend reconstructs the file.

### Step 9 — Final verification

Backend calculates:

```text
SHA-256(reconstructedFile)
```

and compares it against the original file hash.

### Step 10 — Completion

If equal:

```text
TRANSFER_COMPLETED
```

The Backend returns an authoritative artifact/reference ID.

### Step 11 — Cleanup

The Control Plane retains the local copy according to the configured retention policy and eventually garbage-collects it.

---

# 53. Core Guarantees

The File Transfer Service should ultimately guarantee:

### Durability

Once an upload is reported as locally accepted, a temporary network failure must not cause data loss.

### Resumability

Interrupted transfers can continue without restarting unnecessarily.

### Integrity

Corrupted chunks and corrupted reconstructed files are detected.

### Idempotency

Retries do not create duplicate logical transfers.

### Crash Recovery

Control Plane restarts do not destroy transfer state.

### Bounded Memory

Large files do not require proportional RAM allocation.

### Backend Authority

The Backend remains authoritative for successful remote persistence.

### Explicit State

Every transfer has a persisted lifecycle state.

### Observability

Every transfer can be traced through its complete lifecycle.

---

# 54. Recommended Implementation Order

Do not implement the complete service simultaneously.

Implement in this order:

## Phase 1 — Local upload

```text
Frontend
    ↓
Express
    ↓
Busboy
    ↓
temporary file
```

Implement:

- streaming
- limits
- temporary storage
- cleanup

## Phase 2 — Local persistence

Add SQLite:

```text
transfer metadata
state
file path
size
hash
```

## Phase 3 — Integrity

Add:

```text
file hash
chunk hash
```

## Phase 4 — Chunking

Implement:

```text
file
 ↓
chunk metadata
 ↓
chunk streams
```

## Phase 5 — Backend protocol

Implement:

```text
CreateTransfer
UploadChunk
GetTransferStatus
FinalizeTransfer
```

## Phase 6 — Retry

Add:

```text
retry scheduling
exponential backoff
failure classification
```

## Phase 7 — Recovery

Implement:

```text
startup recovery
reconciliation
resume
```

## Phase 8 — Progress

Expose:

```text
state
bytes
chunks
percentage
errors
```

## Phase 9 — Cleanup

Implement:

```text
retention
garbage collection
orphan detection
```

## Phase 10 — Hardening

Finally address:

- concurrency tuning
- security review
- resource exhaustion
- protocol versioning
- observability
- performance
- failure injection
- crash testing

---

# 55. Final Architectural Principle

The most important idea behind this service is:

```text
Frontend
    │
    │ "Here is a file."
    ▼
Control Plane
    │
    │ "I will durably manage its delivery."
    ▼
Backend
    │
    │ "I have verified and persisted it."
    ▼
Completed Transfer
```

The Frontend should not need to understand the complexity of reliable transfer.

The Backend should not need to trust that the Frontend successfully uploaded something.

The Control Plane bridges the two using a **durable, resumable, integrity-verified transfer protocol**.

The service should therefore be treated as a standalone subsystem inside the Control Plane with explicit contracts, persistent state, deterministic recovery, and well-defined failure semantics—not as a collection of Express upload routes.

Add this section to the File Transfer Service specification:

---

## File Transfer Service I/O Boundary and Transport Independence

The File Transfer Service (FTS) is a **durable asynchronous data-transfer infrastructure subsystem**. It must remain independent of the Control Plane's application routes, authentication logic, frontend response handling, and backend network implementation.

The FTS owns the lifecycle of a file transfer after ingestion has been handed to it. The Runtime owns authentication, authorization, HTTP response semantics, and frontend notification.

### 1. Input Boundary — HTTP Request Ingestion

The Runtime authenticates and authorizes the incoming request before passing the raw HTTP request object to the FTS:

```javascript
const result = await fts.consumeHttpRequest(req);
```

`consumeHttpRequest(req)` is the FTS's HTTP ingestion boundary.

The FTS is responsible for:

1. Consuming the request body as a stream.
2. Applying backpressure.
3. Enforcing transfer and request-size limits.
4. Validating the incoming transfer metadata.
5. Writing the incoming data to FTS-managed temporary/local storage.
6. Computing the required integrity hashes while ingesting the stream.
7. Persisting transfer metadata in the FTS SQLite database.
8. Atomically finalizing the local file once ingestion succeeds.
9. Registering the transfer for asynchronous backend synchronization.

The FTS must **not** perform authentication or authorization of the user. Those responsibilities belong to the Runtime/Security Authority.

### 2. Durable Ingestion Guarantee

Successful completion of:

```javascript
await fts.consumeHttpRequest(req);
```

means that the FTS has durably accepted the transfer into its local transfer system.

The original HTTP request must no longer be required for the transfer to continue.

Once local durability has been established, the Runtime may immediately return:

```http
HTTP/1.1 202 Accepted
```

to the Frontend.

The Frontend therefore does **not** wait for remote Backend synchronization.

The conceptual boundary is:

```text
Frontend
   │
   │ HTTP request
   ▼
Runtime
   │
   │ authentication / authorization
   │
   │ consumeHttpRequest(req)
   ▼
File Transfer Service
   │
   │ durable local acceptance
   ▼
Runtime
   │
   ▼
HTTP 202 Accepted
```

### 3. FTS Must Not Own HTTP Response Semantics

The FTS consumes the HTTP request stream but must not construct or send the HTTP response.

The following responsibility separation is mandatory:

```text
Runtime:
    authentication
    authorization
    routing
    HTTP status codes
    HTTP response body
    frontend notification

FTS:
    stream ingestion
    local persistence
    integrity
    transfer state
    scheduling
    chunking
    backend synchronization
    retry/recovery
    completion events
```

Therefore, the FTS must never contain application-specific logic such as:

```javascript
res.status(202)
res.json(...)
```

The Runtime interprets the result returned by `consumeHttpRequest()` and constructs the appropriate HTTP response.

### 4. Backend Egress Boundary

The FTS must not directly depend on a concrete HTTP implementation for communicating with the remote Backend.

Instead, the Runtime injects a `BackendTransferClient` implementation when constructing the FTS:

```javascript
const fts = new FileTransferService({
  backendTransferClient,
});
```

The FTS interacts exclusively with the interface/contract exposed by this client.

For example:

```javascript
await backendTransferClient.uploadChunk({
  transferId,
  sequence,
  data,
  hash,
});
```

The concrete client may internally use HTTP, `fetch`, `undici`, HTTP/2, or another transport. The FTS must remain unaware of that implementation.

The architectural boundary is therefore:

```text
FTS
 │
 │ BackendTransferClient interface
 ▼
BackendTransferClient
 │
 │ concrete transport
 ▼
Remote Backend
```

### 5. Autonomous Backend Synchronization

After local ingestion succeeds, the FTS independently processes the transfer.

The synchronization pipeline is:

```text
Local File
    │
    ▼
Transfer Scheduler
    │
    ▼
Chunk Reader
    │
    ├── chunk extraction
    ├── sequence assignment
    ├── hash calculation
    └── integrity validation
    │
    ▼
BackendTransferClient.uploadChunk()
    │
    ▼
Remote Backend
```

The FTS is responsible for handling:

- chunking;
- per-chunk hashing;
- transfer ordering;
- transfer state;
- network timeouts;
- connection failures;
- retry policy;
- interrupted transfers;
- resumability;
- final integrity verification;
- successful completion detection.

A failure of the remote Backend must **not invalidate an already-durable local transfer**.

The transfer remains locally persisted and enters the appropriate retry/recovery state.

### 6. Asynchronous Completion Boundary

When the Backend has received all chunks, verified the final transfer hash, and permanently committed the object, the FTS transitions the transfer into its completed state and emits a `TransferCompleted` event.

Conceptually:

```javascript
fts.on("TransferCompleted", (event) => {
  // Runtime handles application consequences.
});
```

The FTS event must contain sufficient transfer identity and Backend metadata for the Runtime to reconcile the transfer with the main Control Plane database.

The FTS itself must **not** directly modify application-owned database records or send frontend WebSocket notifications.

The Runtime owns those actions:

```text
Backend
   │
   │ successful finalization
   ▼
FTS
   │
   │ TransferCompleted
   ▼
Runtime
   ├── update main Control Plane DB
   └── notify Frontend through WebSocket
```

### 7. Complete Transfer Lifecycle

The canonical lifecycle is:

```text
RAW HTTP REQUEST
       │
       ▼
consumeHttpRequest(req)
       │
       ▼
Stream ingestion
       │
       ▼
Backpressure / validation / limits
       │
       ▼
Local temporary storage
       │
       ▼
Hash + integrity verification
       │
       ▼
Atomic local finalization
       │
       ▼
Persist transfer metadata
       │
       ▼
LOCAL TRANSFER ACCEPTED
       │
       ├──────────────────────► Runtime → HTTP 202
       │
       ▼
Background synchronization
       │
       ▼
Chunk + hash
       │
       ▼
BackendTransferClient
       │
       ▼
Remote Backend
       │
       ├── failure → retry/recovery
       │
       └── success
              │
              ▼
       Backend finalization
              │
              ▼
       TransferCompleted
              │
              ▼
           Runtime
          /       \
       Main DB   WebSocket
```

### 8. Core Architectural Invariant

The following invariant is mandatory:

> **The File Transfer Service must own durable transfer state and data movement, but must not own application-level network routing, authentication, authorization, HTTP response handling, or frontend notification.**

The FTS therefore has two explicit external boundaries:

**Ingress**

```javascript
fts.consumeHttpRequest(req);
```

**Egress**

```javascript
backendTransferClient.uploadChunk(...)
```

and one asynchronous application boundary:

```text
TransferCompleted
```

This makes the FTS independently testable and allows the HTTP ingress implementation and Backend transport implementation to change without changing the transfer engine itself.

The FTS is consequently treated as **infrastructure rather than an application service**.

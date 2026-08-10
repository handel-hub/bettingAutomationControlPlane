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

# 2. Architectural Position

The File Transfer Service is an internal service of the Control Plane.

It is not part of the Frontend.

It is not part of the Backend.

It is not part of the Execution Plane.

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

# 6. Transfer Lifecycle

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

# 8. File Storage Model

The Control Plane should maintain separate storage areas.

```text
file-cache/
│
├── temporary/
│
├── uploads/
│
├── downloads/
│
└── completed/
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

SQLite stores **metadata and transfer state**, not necessarily the file contents.

The filesystem stores the actual file.

Conceptually:

```text
SQLite
   │
   ├── transfer metadata
   ├── chunk metadata
   ├── retry state
   ├── Backend references
   └── lifecycle state

Filesystem
   │
   ├── temporary files
   ├── cached files
   └── downloaded artifacts
```

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

# 13. File Hashing

The Control Plane calculates a cryptographic hash of the original file.

For example:

```text
SHA-256(file)
```

Conceptually:

```text
File
 │
 ├── chunk 0 → SHA-256
 ├── chunk 1 → SHA-256
 ├── chunk 2 → SHA-256
 └── ...
 │
 ▼
Full-file SHA-256
```

The file hash represents the expected final artifact.

---

# 14. Chunk Hashing

Each chunk receives its own hash.

For example:

```text
chunk 0 → H0
chunk 1 → H1
chunk 2 → H2
```

The Control Plane sends both the chunk and its expected hash to the Backend.

The Backend independently calculates the hash.

```text
Control Plane

chunk 17
hash = ABC


Backend

received chunk 17
calculate hash
     │
     ▼
ABC

ABC == expected hash
     │
     ▼
ACK
```

If the hashes differ:

```text
REJECT_CHUNK
```

The Control Plane must retransmit that chunk.

---

# 15. Backend Reconstruction

The Backend should not treat the file as valid merely because every chunk was received.

After all chunks have been acknowledged:

```text
chunks
   │
   ▼
ordered reconstruction
   │
   ▼
complete file
   │
   ▼
SHA-256
```

The resulting hash must be compared against the original file hash supplied as part of the authenticated transfer metadata.

```text
backend_hash == original_file_hash
```

Only then:

```text
TRANSFER_VERIFIED
```

Otherwise:

```text
INTEGRITY_FAILURE
```

The reconstructed artifact must not be promoted to a valid completed file when the hashes disagree.

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

If the Backend already has the chunk:

```text
do not resend
```

If it doesn't:

```text
resend
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

If the Control Plane sends it twice, the Backend does not create two chunks.

This makes retries safe.

The transfer protocol should be designed around **idempotent operations** wherever possible.

---

# 20. Retry Policy

Retries should distinguish between transient and permanent failures.

### Retryable

Examples:

- connection timeout
- temporary DNS failure
- connection reset
- Backend unavailable
- temporary server overload
- temporary network failure

### Non-retryable

Examples:

- unauthorized
- forbidden
- invalid transfer
- unsupported file type
- invalid chunk
- corrupted metadata
- transfer expired

Retryable errors enter:

```text
RETRY_WAIT
```

with exponential backoff.

Conceptually:

```text
1st retry → short delay
2nd retry → longer delay
3rd retry → longer delay
...
```

The exact retry policy should be configurable.

---

# 21. Concurrency

The service should support controlled parallel chunk uploads.

For example:

```text
maximum concurrent chunks = 4
```

rather than:

```text
upload all 734 chunks simultaneously
```

Concurrency should be bounded.

This protects:

- CPU
- RAM
- disk I/O
- network bandwidth
- Backend capacity

The concurrency limit should eventually be configurable.

---

# 22. Backpressure

The service must respect streaming backpressure.

The upload pipeline should not allow:

```text
Network
   ↓
RAM
   ↓
RAM
   ↓
RAM
   ↓
OOM
```

Instead:

```text
Network
   ↓
stream
   ↓
disk
```

and:

```text
disk
   ↓
read stream
   ↓
network
```

The implementation should rely heavily on Node.js streams.

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

The File Transfer Service handles untrusted input.

Therefore:

```text
Frontend
    │
    │ UNTRUSTED DATA
    ▼
File Transfer Service
```

The service must never trust:

- filename
- path
- MIME type
- file size supplied by the client
- declared hash
- chunk count
- chunk index
- transfer state
- arbitrary metadata

All relevant values must be validated.

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

Local storage is finite.

The service therefore requires a Cache Manager.

The Cache Manager determines when completed or abandoned artifacts can be deleted.

Example policy:

```text
ACTIVE
    ↓
COMPLETED
    ↓
RETENTION_PERIOD
    ↓
DELETE
```

The service must never delete a file that is still required by an active transfer.

---

# 34. Garbage Collection

Garbage collection must be crash-safe.

The service should periodically identify:

- orphaned temporary files
- expired transfers
- completed transfers beyond retention
- abandoned partial downloads
- metadata without files
- files without metadata

These should be reconciled carefully rather than blindly deleted.

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

# 36. Internal Event Model

The service should emit domain events such as:

```text
TransferCreated
TransferReceiving
TransferCached
TransferQueued
TransferStarted
ChunkUploaded
ChunkRejected
TransferRetryScheduled
TransferReconciled
TransferVerified
TransferCompleted
TransferFailed
TransferCancelled
TransferExpired
```

These events can be consumed by:

- API/WebSocket layer
- telemetry
- logging
- UI notification
- audit systems

The service itself should not directly manipulate the Frontend.

---

# 37. Backend Contract

The Backend must expose a dedicated transfer protocol.

Conceptually:

```text
CreateRemoteTransfer()
GetRemoteTransferStatus()
UploadChunk()
GetChunkStatus()
FinalizeRemoteTransfer()
CancelRemoteTransfer()
```

The Backend remains authoritative for remote persistence.

The Control Plane remains authoritative for its local transfer state.

Neither side should assume the other completed an operation merely because a network connection existed.

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

Every transfer should have a stable `transferId`.

Logs should include:

```text
transferId
sessionId
operation
state
chunkIndex
attempt
duration
errorCode
```

This allows a transfer to be reconstructed from logs.

Example:

```text
transfer=ABC
state=CACHED
```

then:

```text
transfer=ABC
chunk=52
attempt=1
state=UPLOADING
```

then:

```text
transfer=ABC
chunk=52
state=ACKNOWLEDGED
```

---

# 43. Failure Categories

The service should classify failures.

### Local failures

- disk full
- permission failure
- file corruption
- SQLite unavailable
- invalid input

### Network failures

- timeout
- connection reset
- DNS failure
- connection refused

### Backend failures

- 5xx
- service unavailable
- throttling
- invalid transfer
- authorization failure

### Integrity failures

- chunk hash mismatch
- final file hash mismatch

### Lifecycle failures

- Control Plane crash
- interrupted shutdown
- stale transfer

Different categories require different recovery strategies.

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

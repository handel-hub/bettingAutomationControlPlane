# Quarantined Subsystem: File Transfer Service (FTS)

## Status: QUARANTINED (Preserved per User Directive)

This subsystem was moved from `src/file-transfer/` to `quarantine/file-transfer/` during the Pre-Business-Logic Architecture Standardization Gate.

### Rationale:
- **Zero Live Imports**: The file transfer subsystem is not referenced by any live Control Plane route, command handler, or bootstrap module.
- **Preservation of Intellectual Property**: The user explicitly requested to preserve this subsystem rather than deleting it.
- **Clean Runtime Boundary**: Relocating this subsystem out of `src/` ensures that active linters, runtime packagers, and dependency analyzers only scan and execute actively connected architectural components.

### Contents:
- **Adapters**: `HttpRequestAdapter.mjs`
- **Database & Repositories**: `TransfersRepository.mjs`, SQL schema migrations
- **Ingestion**: `IngestionPipeline.mjs`, `Chunker.mjs`, `DiskSpaceGuard.mjs`, `RollingHasher.mjs`
- **Recovery**: `RecoveryReconciler.mjs`, `GarbageCollector.mjs`
- **Service & State Machine**: `FileTransferService.mjs`, `TransferStateMachine.mjs`
- **Tests**: Full test suites for fuzzing, faults, concurrency, and recovery.

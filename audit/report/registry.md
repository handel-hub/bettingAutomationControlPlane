# Section 13.2 — Security Invariant Registry, Prior Findings Register & Discovered Surface

## 1. Frozen Security Invariants (`INV-01` – `INV-12`)

Frozen prior to testing in [`audit/invariants.md`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/invariants.md):

| Invariant ID | Title | Authoritative Plane | Primary Runtime Tests |
|---|---|---|---|
| **INV-01** | Conservation of Value & No Unpaid Entitlement Activation | Backend (`billing.mjs`, `billing/service.mjs`, `outbox/worker.mjs`) | `PF-02`, `PF-06`, `PF-15`, `BASE-01`, `PAY-01`, `PAY-02`, `PAY-03`, `PAY-04` |
| **INV-02** | Webhook & Payment Idempotency Under Concurrency | Backend (`payment_events`, `invoices`, `accounts FOR UPDATE`) | `PF-02`, `PF-06`, `PAY-02`, `PAY-04`, `FAULT-02` |
| **INV-03** | Server-Authoritative Identity & Strict Tenant Isolation | Backend (`operator-auth.mjs`, `envelope-validator.mjs`, domain services) | `PF-01`, `PF-03`, `PF-08`, `AUTH-01`..`03`, `AUTHZ-01`..`03`, `PAY-04`, `ENT-02`, `ENT-03`, `CP-TAMPER-01`..`02`, `FAULT-01` |
| **INV-04** | Entitlement & Tier Enforcement on Protected Operations | Backend (`licensing/service.mjs`, `betting-accounts/service.mjs`, `automation/service.mjs`) & Control Plane (`facade.mjs`) | `PF-04`, `PF-14`, `PF-16`, `AUTHZ-02`, `AUTHZ-03`, `PAY-03`, `ENT-01`, `ENT-02`, `CP-TAMPER-02`, `UPDATE-01` |
| **INV-05** | Immediate Revocation Cascade Across All Planes | Backend (`session/service.mjs`, `settings/service.mjs`, `revocation/service.mjs`), CP (`facade.mjs`), EP (`SecureIpcClient.js`) | `PF-04`, `AUTH-03`, `EP-02`, `FAULT-01` |
| **INV-06** | Protocol Envelope Integrity, Nonce Uniqueness & Monotonic Generation | Backend (`envelope-validator.mjs`, `nonce.mjs`, `reconciliation/service.mjs`) & CP (`backend-client.mjs`) | `PF-01`, `PF-04`, `PF-11`, `AUTH-02`, `PAY-02`, `TRANSPORT-01`, `FAULT-02`, `FAULT-03` |
| **INV-07** | Fail-Closed Execution Plane Boundary & Script Integrity | Control Plane (`runtime-manager.mjs`, `execution-integrity.mjs`, `PipeTransport.mjs`) & EP (`SecureIpcClient.js`) | `PF-12`, `PF-13`, `EP-01`, `EP-02`, `CLIENT-PROT-01`, `DOS-01` |
| **INV-08** | Anti-Rollback & Monotonic Clock Enforcement on Local State | Control Plane (`aead-storage-adapter.mjs`, `persistent-clock.mjs`, Rust `os_secret.rs`) | `PF-11`, `PF-12`, `PF-17`, `TIME-ROLLBACK-01`, `TIME-ROLLBACK-02`, `FAULT-04` |
| **INV-09** | Cryptographic Key Isolation & Zero Secret Leakage | All 4 Repositories (`kms-adapter.mjs`, `VaultCredentialPipeline.mjs`, `error-handler.mjs`) | `PF-09`, `PF-10`, `PF-15`, `CP-TAMPER-01`, `TRANSPORT-01`, `CLIENT-PROT-01`, `WEB-01`, `DATA-01` |
| **INV-10** | Durable Security Telemetry & Lockout Persistence Across Failures | Backend (`authenticate.mjs`, `audit/service.mjs`) | `PF-05`, `PF-19`, `AUTH-01` |
| **INV-11** | Input Validation & Rejection of Unbounded / Malformed Payloads | Backend (`accounts/service.mjs`, `automation/service.mjs`, `billing.mjs`, `operator-auth.mjs`) & CP (`server.mjs`) | `PF-07`, `PF-09`, `PF-14`, `PF-15`, `PF-18`, `LOCAL-SURFACE-01`, `EP-01`, `WEB-01`, `DOS-01`, `DATA-01` |
| **INV-12** | Cryptographically Verified Update & System Control Channel | Backend (`system.mjs`) & Control Plane (`execution-integrity.mjs`) | `PF-16`, `UPDATE-01` |

---

## 2. Prior Findings Register (`PF-01` – `PF-19`)

Every finding from the prior security audits was mapped to a live runtime verification test in [`audit/ledger.jsonl`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/ledger.jsonl):

| Prior ID | Historical Ref | Summary | Runtime Status | Evidence |
|---|---|---|---|---|
| **PF-01** | `RC-01` / `SEC-INV-01` | Sessionless signed envelope rejected on `operatorAuth`; admin routes enforce `verifyAdminSession` RBAC | `EXECUTED-PASS` | [`audit/evidence/PF-01/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-01/result.json) |
| **PF-02** | `RC-02` / `SEC-INV-02` | Billing plan validation, cross-endpoint payment replay lock (`409`), expired subscription resume gate (`402`), and callback HTML escaping | `EXECUTED-PASS` | [`audit/evidence/PF-02/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-02/result.json) |
| **PF-03** | `RC-03` / `SEC-INV-03` | Multi-tenant `global_automation_configs` isolation and fail-closed WebSocket broadcast when `targetAccountId` is null | `EXECUTED-PASS` | [`audit/evidence/PF-03/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-03/result.json) |
| **PF-04** | `RC-04` / `SEC-INV-04` | Mandatory generation in `resolveAuthorization`, `max_accounts` cap in `createBettingAccount`, suspended account block, and logout cascade | `EXECUTED-PASS` | [`audit/evidence/PF-04/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-04/result.json) |
| **PF-05** | `F-01` / `T-REG-01` | Failed login attempt commits `lockout_count` and `LOGIN_FAILURE` audit event outside rolled-back transaction | `EXECUTED-PASS` | [`audit/evidence/PF-05/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-05/result.json) |
| **PF-06** | `F-04` / `T-REG-02` | Concurrent `applyPaymentSuccess` calls serialize via `SELECT ... FOR UPDATE` on `accounts` | `EXECUTED-PASS` | [`audit/evidence/PF-06/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-06/result.json) |
| **PF-07** | `F-02` / `T-REG-03` | Unknown `actionType` on `/api/v1/accounts/:id/action` and `/bulk-action` rejected with HTTP `400 INVALID_ACTION_TYPE` | `EXECUTED-PASS` | [`audit/evidence/PF-07/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-07/result.json) |
| **PF-08** | `F-03` / `T-REG-04` | Control Plane `PATCH /api/v1/accounts/:id` and `DELETE /api/v1/notifications/:id` dispatch through `commandRouter` authorization gate | `EXECUTED-PASS` | [`audit/evidence/PF-08/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-08/result.json) |
| **PF-09** | `F-05` / `T-REG-05` | Malformed non-UUID Bearer token returns HTTP `401` instead of `500` PostgreSQL `22P02` | `EXECUTED-PASS` | [`audit/evidence/PF-09/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-09/result.json) |
| **PF-10** | `F-07` / `SEC-INV-07` | Cryptographically signed license payloads bind `account_id` and `machine_id` with Ed25519 signature | `EXECUTED-PASS` | [`audit/evidence/PF-10/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-10/result.json) |
| **PF-11** | `F-06` | `logout()` preserves monotonic `state_version` (`prevVersion + 1`) across `AEADStorageAdapter` and OS counter | `EXECUTED-PASS` | [`audit/evidence/PF-11/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-11/result.json) |
| **PF-12** | `STAGE-2` | Offline grace token expiry transitions Control Plane to `HALTED` and blocks `START_EXECUTION` | `EXECUTED-PASS` | [`audit/evidence/PF-12/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-12/result.json) |
| **PF-13** | `STAGE-3` | `ExecutionIntegrityVerifier` halts spawn when Execution Plane entry script SHA-256 hash mismatches | `EXECUTED-PASS` | [`audit/evidence/PF-13/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-13/result.json) |
| **PF-14** | `REM-03` | `createBettingAccount` enforces `allowedPlatformIds` and `updateAccountAutomationConfig` enforces source enum whitelist | `EXECUTED-PASS` | [`audit/evidence/PF-14/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-14/result.json) |
| **PF-15** | `REM-04` | `applyPaymentSuccess` blocks self-reactivation of administratively `REVOKED` licenses (`403`) and `checkout` rejects `javascript:` `returnUrl` (`400`) | `EXECUTED-PASS` | [`audit/evidence/PF-15/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-15/result.json) |
| **PF-16** | `REM-05` | `POST /api/v1/system/restart-and-update` requires `SUPER_ADMIN` or `CAP_UPDATE_INSTALL` capability | `EXECUTED-PASS` | [`audit/evidence/PF-16/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-16/result.json) |
| **PF-17** | `STAGE-2-ROLLBACK` | `AEADStorageAdapter` detects and rejects rolled-back SQLite database snapshot via generation counter mismatch | `EXECUTED-PASS` | [`audit/evidence/PF-17/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-17/result.json) |
| **PF-18** | `REM-01` | `envelopeValidator` requires integer `clientGeneration` on authenticated session envelopes and enforces match against `machine_session_states` | `EXECUTED-PASS` | [`audit/evidence/PF-18/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-18/result.json) |
| **PF-19** | `REM-02` | Auth rate limiter keys on normalized `payload.email` + IP and returns HTTP `429` on 6th attempt | `EXECUTED-PASS` | [`audit/evidence/PF-19/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-19/result.json) |

---

## 3. Discovered Attack Surface Summary (`audit/surface.json`)

Full machine-readable discovery output is persisted in [`audit/surface.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/surface.json):

- **Backend HTTP & WebSocket Surface (`71` mounted route handlers across `14` routers + `/health`, `/ready`, `/metrics`, and `/ws/v1/events`)**:
  - Protocol Envelope Routers (`envelopeValidator`): `/sessions/renew`, `/sessions/logout`, `/authorization/resolve`, `/reconciliation/sync` (dual-mounted at `/` and `/api/v1/`).
  - Operator Domain Routers (`operatorAuth`): `/api/v1/accounts`, `/api/v1/automation`, `/api/v1/billing`, `/api/v1/settings`, `/api/v1/notifications`, `/api/v1/support`, `/api/v1/telemetry`, `/api/v1/prelude`, `/api/v1/system/version`.
  - Admin RBAC Routers (`verifyAdminSession`): `/api/v1/admin/*`, `POST/PATCH/DELETE /api/v1/platforms*`, `GET /metrics`, `POST /api/v1/system/restart-and-update`.
  - Payment Webhook & Callback Routers: `POST /api/v1/payments/webhook` (HMAC-SHA512 / `verif-hash`), `GET /api/v1/payments/callback`.
- **Control Plane HTTP & WebSocket Surface (`46` route handlers on `127.0.0.1:4000` + `/ws`)**:
  - Protected by `ipcTokenMiddleware` (`x-acp-ipc-token`), `csrfOriginMiddleware` (strict localhost origin allowlist + `Sec-Fetch-Site`), and `commandRouter.dispatch()` (`securityFacade.isCommandPermitted()`).
- **Control Plane ↔ Execution Plane IPC Surface**:
  - Windows Named Pipe (`\\.\pipe\acp_ secure_ipc_*`) managed by `PipeTransport` (10 MB frame cap, newline-delimited JSON) and `SecureIpcClient` (HMAC-SHA256 `AUTH_CHALLENGE` / `AUTH_RESPONSE` + per-command `verifyCommandHmac`).

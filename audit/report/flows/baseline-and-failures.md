# Section 13.3 — End-to-End Baseline Traces & Failure / Recovery Matrices

## 1. End-to-End Baseline Runtime Trace (`BASE-01`)

Evidence: [`audit/evidence/BASE-01/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/BASE-01/result.json) | Ledger ID: `BASE-01` (`EXECUTED-PASS`)

The complete operator lifecycle was executed end-to-end across Backend, Control Plane, and Execution Plane boundaries using a disposable operator account (`base01-*@example.com`):

1. **Operator Registration & Authentication (`POST /api/v1/auth/init`)**:
   - Control Plane cold-boots an Ed25519 machine identity (`installationId`, `publicKeyHex`, `selfSignature`) via `POST /api/v1/machines/register` (`status: REGISTERED`, `account_id: NULL`).
   - Operator authenticates via `authenticate(email, password, machineId, 2, nonce)`.
   - Backend binds the machine to `account_id` inside a `SERIALIZABLE` transaction, enforces `max_machines`, increments `session_generation` in `machine_session_states`, creates an `AUTHENTICATED` row in `sessions`, and returns a KMS-signed Envelope V2 containing `sessionId`, `sessionGeneration`, `graceToken`, and a cryptographically signed `license` payload.
2. **Checkout Initiation & Payment Verification (`POST /api/v1/billing/checkout` → `POST /api/v1/billing/checkout/verify`)**:
   - Operator initiates a `Pro` monthly checkout (`Idempotency-Key` required) and verifies the reference.
   - Backend validates reference ownership, customer email, currency (`NGN`), and plan amount (`expectedPrice`), locks `accounts` (`FOR UPDATE`) and `invoices` (`FOR UPDATE`), activates `subscriptions` (`ACTIVE`), provisions/updates `licenses` (`VALID`, `plan_id = 'pro'`), signs the license via KMS Ed25519 (`signLicensePayload`), and returns a signed Envelope V2.
3. **Control Plane Session Establishment & Authorization Gate (`SecurityAuthorityFacade`)**:
   - Control Plane verifies the Backend envelope signature (`BackendEnvelopeValidator`) and license signature (`LicenseManager.validateLicenseIntegrity`), persists the AEAD-encrypted security state (`AEADStorageAdapter` with Rust NAPI-RS `encryptAead` and OS registry monotonic counter), and transitions to `ONLINE_VALID`.
   - `securityFacade.isCommandPermitted('START_EXECUTION')` returns `true`.
4. **Domain Account Creation (`POST /api/v1/accounts`) & Execution Plane Handshake (`SecureIpcClient`)**:
   - Operator creates a `SportyBet` betting account; Backend verifies active license (`assertActiveLicense`), platform entitlement (`allowedPlatformIds`), and account cap (`max_accounts`), and encrypts bookmaker credentials with AES-256-GCM bound to `accountId:platform:username` AAD.
   - Control Plane verifies Execution Plane script integrity (`ExecutionIntegrityVerifier.verify`) and completes the `AUTH_CHALLENGE` / `AUTH_RESPONSE` HMAC-SHA256 handshake over Named Pipe IPC before dispatching HMAC-signed commands.
5. **Logout & Revocation Cascade (`POST /api/v1/sessions/logout`)**:
   - Backend revokes the session (`status = 'REVOKED'`), revokes associated authorizations, increments `session_generation`, and logs `SESSION_REVOKED`.
   - Control Plane transitions to `UNAUTHENTICATED`, increments `state_version` (`prevVersion + 1`), and halts Execution Plane activity.

---

## 2. Phase 5 Multi-Step Failure, Partial-Failure & Recovery Matrix (`FAULT-01` – `FAULT-04`)

| Test ID | Scenario | Fault Injected | Observed System Behavior & State Transition | Invariants Verified | Status & Evidence |
|---|---|---|---|---|---|
| **FAULT-01** | Mid-execution revocation while Execution Plane is active | Backend revokes license (`REVOKED`), expires subscription (`EXPIRED`), and revokes session while CP is `ONLINE_VALID` and EP IPC is active; CP attempts `/api/v1/authorization/resolve` | Backend rejects `/authorization/resolve` with HTTP `401 BE_AUTH_SESSION_EXPIRED`; CP `transitionToHalted('BACKEND_REVOKED')` immediately blocks `START_EXECUTION` (`permitted: false`) and EP `SecureIpcClient` executes `STOP` (`stoppedReceived: true`). | `INV-04`, `INV-05`, `INV-07` | `EXECUTED-PASS` ([`audit/evidence/FAULT-01/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/FAULT-01/result.json)) |
| **FAULT-02** | Webhook delivery races with `/checkout/verify` return URL | Concurrent execution of `/checkout/verify` (`applyPaymentSuccess`) and outbox webhook worker (`processOutboxEvent` for `charge.completed`) on the same `tx_ref` (`ref-fault02-*`) | `SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE` serializes both paths; `/checkout/verify` commits `1` invoice and `1` active subscription, while `outbox/worker.mjs:205` catches `PAYMENT_ALREADY_REDEEMED` and marks the outbox event `DELIVERED` without double-crediting. | `INV-01`, `INV-02`, `INV-06` | `EXECUTED-PASS` ([`audit/evidence/FAULT-02/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/FAULT-02/result.json)) |
| **FAULT-03** | Network partition → offline grace operation → reconnect & reconciliation | CP operates offline under `GraceToken`; reconnects via `POST /api/v1/reconciliation/sync` first with matching generation (`MATCH` / `NONE`), then with forged generation (`clientGeneration: 999 > serverSessionGen`) | Valid reconnect returns `{ resolution: 'MATCH', action: 'NONE' }`; forged generation triggers `{ resolution: 'FORGERY_SUSPECTED', action: 'REVOKE_MACHINE' }`, revoking the machine (`REVOKED`) and all its sessions in PostgreSQL and recording `GENERATION_COUNTER_FORGERY`. | `INV-05`, `INV-06`, `INV-08` | `EXECUTED-PASS` ([`audit/evidence/FAULT-03/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/FAULT-03/result.json)) |
| **FAULT-04** | Crash mid-state-transition / corrupted ciphertext recovery | Corrupt `ciphertext` bytes inside SQLite `security_state` (simulating partial write / torn page during crash) and invoke `AEADStorageAdapter.getSecurityStateRow()` | AES-256-GCM authentication tag verification fails closed (`SECURITY_STATE_CORRUPTED: Decryption/MAC verification failed`); CP refuses to boot with corrupted state and never defaults to `ONLINE_VALID`. | `INV-07`, `INV-08`, `INV-09` | `EXECUTED-PASS` ([`audit/evidence/FAULT-04/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/FAULT-04/result.json)) |

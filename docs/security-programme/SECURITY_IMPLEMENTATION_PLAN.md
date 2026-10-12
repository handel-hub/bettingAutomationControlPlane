# 10. Phased Security Implementation Plan (`SECURITY_IMPLEMENTATION_PLAN.md`)

---

## Phase 1: Principal, Session, Envelope, & Multi-Tenant Isolation (`RC-01` & `RC-03`)

### Objectives
Close `USF-01`, `USF-04`, `USF-05`, `USF-06`, `USF-07`, `USF-08`, `USF-09`, and `USF-12` (tenant/machine/metrics subset).

### Exact Code Changes
1. [`bettingAutomationBackend/src/api/middleware/operator-auth.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/middleware/operator-auth.mjs):
   - Wrap `envelopeValidator(req, res, (err) => ...)` so that after `envelopeValidator` completes, `operatorAuth` verifies `if (!req.accountId || !req.sessionId)` and returns `401 Unauthorized: Session required for operator endpoints`.
   - On Bearer / `x-session-id` authentication, join `accounts a` and `LEFT JOIN machines m ON s.machine_id = m.machine_id`, enforce `a.status === 'ACTIVE'`, and enforce `!s.machine_id || m.status === 'REGISTERED'`. Populate `req.machineId = s.machine_id`.
2. [`bettingAutomationBackend/src/api/middleware/envelope-validator.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/middleware/envelope-validator.mjs):
   - In session verification (`L98-115`), join `accounts a ON s.account_id = a.account_id` and enforce `s.status === 'AUTHENTICATED'`, `new Date(s.expires_at) > new Date()`, and `a.status === 'ACTIVE'`.
   - When `envelope.sessionId` is present, require `typeof envelope.clientGeneration === 'number' && Number.isInteger(envelope.clientGeneration)` (reject missing `clientGeneration` with `400 MISSING_CLIENT_GENERATION`).
3. [`bettingAutomationBackend/src/domain/session/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/session/service.mjs):
   - In `renew()`, join `accounts a` and reject if `session.status !== 'AUTHENTICATED'`, `new Date(session.expires_at) <= new Date()`, or `a.status !== 'ACTIVE'`.
   - In `logout()`, also revoke active `authorizations` for `sessionId` and increment `session_generation` in `machine_session_states`.
4. [`bettingAutomationBackend/src/domain/authorization/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/authorization/service.mjs):
   - Verify `s.expires_at > now()` and `a.status = 'ACTIVE'` in `resolve()`.
   - Require `presentedGenerationState` when `stateRes.rows.length > 0`.
   - Enforce `AND (expires_at IS NULL OR expires_at > now())` in the `licenses` query.
5. [`bettingAutomationBackend/src/domain/betting-accounts/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/betting-accounts/service.mjs):
   - Remove hardcoded `'betting_automation_master_vault_key_32'` fallback in `getMasterVaultKey()`.
   - In `createBettingAccount()`, check active license limits (`maxAccounts`) when present.
6. [`bettingAutomationBackend/src/domain/automation/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/automation/service.mjs):
   - Partition `global_automation_configs` by `id = accountId` on write (seeding from `'primary'` defaults) and read `WHERE id IN ($1, 'primary') ORDER BY (id = $1) DESC LIMIT 1`.
7. [`bettingAutomationBackend/src/api/routes/platforms.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/platforms.mjs), [`support.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/support.mjs), [`server.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/server.mjs), [`machine/repository.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/machine/repository.mjs), [`websocket/server.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/websocket/server.mjs):
   - Guard `POST /api/v1/platforms`, `PATCH /api/v1/platforms/:id/status`, and `POST /api/v1/support/channels` with `requireAdmin('SUPER_ADMIN')`.
   - Guard `GET /metrics` with `requireAdmin('SUPPORT')`.
   - Scope `revokeMachine` session revocation in `machine/repository.mjs` to only execute if the machine row matched `account_id`.
   - Make `websocket/server.mjs` `broadcast()` fail closed when `targetAccountId` is missing, verify `accounts.status = 'ACTIVE'` on connect, and export `closeWebSocketsForTarget()`.

---

## Phase 2: Canonical Payment Verification, Replay Prevention, & Webhook Integrity (`RC-02`)

### Objectives
Close `USF-02`, `USF-03`, and `USF-12` (payment subset).

### Exact Code Changes
1. [`bettingAutomationBackend/src/api/routes/billing.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/billing.mjs):
   - Accept both `'successful'` and `'success'` in `isSuccess`.
   - Reject unknown `planId` (`!plan`) with `400`.
   - Normalize Paystack minor units (`/ 100`) vs Flutterwave major units.
   - Pass both `providerRef` and `providerTxId` to `BillingService.applyPaymentSuccess`.
2. [`bettingAutomationBackend/src/domain/billing/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/billing/service.mjs) & [`repository.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/billing/repository.mjs):
   - In `applyPaymentSuccess()`, query `invoices` `FOR UPDATE` matching `reference = ANY($1) OR id = ANY($2)` across all canonical aliases (`reference`, `providerRef`, `providerTxId`, `inv-${reference}`, `inv-${providerRef}`, `inv-${providerTxId}`). If an invoice already exists, throw `409 Conflict` (`err.code = 'PAYMENT_ALREADY_REDEEMED'`).
   - Do not un-revoke an administratively revoked license on payment replay.
   - In `resumeSubscriptionInDb()`, require `AND current_period_end > now()`.
3. [`bettingAutomationBackend/src/adapters/payment/adapter.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/adapters/payment/adapter.mjs), [`payments.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/payments.mjs), [`outbox/worker.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/outbox/worker.mjs):
   - Include `billing_interval` in Paystack checkout metadata.
   - Protect `POST /payments/checkout` with `operatorAuth` and HTML-escape `GET /payments/callback` parameters.
   - Validate paid amount against `subscription_plans` in `outbox/worker.mjs` and require verified `meta.account_id` (or matching `provider_subscription_id`) on `charge.failed`.

---

## Phase 3: Machine Identity, Reconciliation, Revocation, & Operator/Admin Auth (`RC-04` & `RC-05`)

### Objectives
Close `USF-10` and `USF-11`.

### Exact Code Changes
1. [`bettingAutomationBackend/src/domain/machine/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/machine/service.mjs):
   - Verify Ed25519 `selfSignature` **before** returning `existing` in `register()`.
2. [`bettingAutomationBackend/src/api/routes/reconciliation.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/reconciliation.mjs):
   - Pass `req.machineId` instead of `envelope.machineId`.
3. [`bettingAutomationBackend/src/domain/revocation/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/revocation/service.mjs) & [`storage/adapter.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/adapters/storage/adapter.mjs):
   - Resolve `accountId` for all revocation scopes, revoke sessions by `account_id` on `LICENSE` revocation, increment `session_generation` + `license_revision`, and call `closeWebSocketsForTarget()`.
   - Sanitize `uploadId` with `path.basename(String(uploadId))` in `StorageAdapter.uploadLocal`.
4. [`bettingAutomationBackend/src/api/routes/auth.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/auth.mjs), [`settings/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/settings/service.mjs), [`admin/service.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/admin/service.mjs), [`admin/routes.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/admin/routes.mjs):
   - Replace `password_hash` with `credentials_hash`, require step-up verification when disabling MFA, add rate limiters to `/auth` and `/admin/login`, and add constant-time dummy Argon2 verification + TOTP replay defense + failed login audit logging in `AdminService.login`.

---

## Phase 4: Control Plane Local Credential Encryption at Rest (`RC-06`)

### Objectives
Close `USF-13`.

### Exact Code Changes
1. [`bettingAutomationControlPlane/src/state-store/persistence/adapters/AccountsAdapter.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/src/state-store/persistence/adapters/AccountsAdapter.mjs):
   - Encrypt `account_password` before writing to SQLite `accounts_metadata_cache` using AES-256-GCM (`enc:v1:<iv>:<tag>:<ciphertext>`) with a key derived from local machine/DPAPI secret material, and transparently decrypt in `getRawPassword()` while keeping `listByUser()` masked as `'[PROTECTED]'`.

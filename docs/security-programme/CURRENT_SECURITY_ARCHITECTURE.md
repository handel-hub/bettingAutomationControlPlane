# 4. Current Security Architecture Reconstruction (`CURRENT_SECURITY_ARCHITECTURE.md`)

This document reconstructs the **actual pre-remediation security architecture** as implemented in the source code (prior to our Phase 1–4 hardening changes), contrasting intended design assumptions with actual runtime behavior.

---

## 1. End-to-End Flow Reconstruction & Failure Points

### 1.1 Operator Authentication & Session Establishment
- **Actual Code Path**:
  - `POST /auth` ([`src/api/routes/auth.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/auth.mjs)) dispatches `action: 'LOGIN'` to [`AuthService.authenticate`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/auth/service.mjs#L33-L108), verifying Argon2id against `accounts.credentials_hash` and creating an `AUTHENTICATED` row in `sessions` (24h expiry).
  - However, `REGISTER` ([`auth.mjs:82`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/auth.mjs#L82)) and `settings/service.mjs` (`VERIFY_PASSWORD`, `CHANGE_PASSWORD`, `DELETE_ACCOUNT`) queried `password_hash`, a column that does not exist in `001_initial_schema.sql` (`USF-11`).
  - `POST /sessions/renew` ([`session/service.mjs:24-34`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/session/service.mjs#L24-L34)) checked `session.status === 'REVOKED'` instead of `session.status !== 'AUTHENTICATED' || expires_at <= now()`, allowing infinitely renewable expired sessions (`USF-07`).

### 1.2 Request Envelope & Operator Middleware (`operatorAuth` vs `envelopeValidator`)
- **Actual Code Path**:
  - Domain routes (`/api/v1/*`) mount `operatorAuth` ([`src/api/middleware/operator-auth.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/middleware/operator-auth.mjs)).
  - When a request contains `{ envelope: { version: 2, ... }, payload }`, `operatorAuth` (`L33-34`) returned `envelopeValidator(req, res, next)` directly.
  - Inside [`envelope-validator.mjs:95-115`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/middleware/envelope-validator.mjs#L95-L115), `req.accountId` was **only** set inside `if (envelope.sessionId)`. If an attacker sent a valid machine signature with `sessionId: null`, `envelopeValidator` called `next()` with `req.accountId = undefined` (`USF-01`).
  - Furthermore, `envelopeValidator` only checked `if (envelope.clientGeneration !== undefined)` (`L117`), allowing any client to bypass generation fencing simply by omitting `clientGeneration` (`USF-08`).

### 1.3 Subscription & Payment Verification Flow
- **Actual Code Path**:
  - Two independent code paths credited payments via [`BillingService.applyPaymentSuccess`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/billing/service.mjs#L167-L277):
    1. Synchronous `POST /api/v1/billing/payments/verify` ([`billing.mjs:96-203`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/billing.mjs#L96-L203)).
    2. Asynchronous webhook worker `PAYMENT_WEBHOOK_RECEIVED` ([`outbox/worker.mjs:123-188`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/outbox/worker.mjs#L123-L188)).
  - `applyPaymentSuccess` used `INSERT INTO invoices ... ON CONFLICT (id) DO UPDATE` (`L248-252`) and **never checked if the transaction had already been redeemed** before extending `subscriptions.current_period_end` and `licenses.expires_at` (`USF-02`).
  - Worse, `billing.mjs` computed `invoiceId = inv-${tx.data.id}` while `outbox/worker.mjs` computed `invoiceId = inv-${reference}`, creating two distinct invoice rows for the same payment (`USF-02`).

### 1.4 Multi-Tenant Domain State & WebSocket Broadcasts
- **Actual Code Path**:
  - `GlobalConfig` in [`automation/service.mjs:14, 79-116`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/automation/service.mjs#L14) hardcoded `WHERE id = 'primary'` for all reads and writes to `global_automation_configs`, making global risk/pricing/rebet config shared across all tenants (`USF-04`).
  - `POST /api/v1/platforms` and `PATCH /api/v1/platforms/:id/status` ([`platforms.mjs:36-57`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/platforms.mjs#L36-L57)) used `operatorAuth`, allowing any tenant to disable bookmaker platforms globally (`USF-05`).
  - [`websocket/server.mjs:184`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/websocket/server.mjs#L184) checked `if (targetAccountId && client.accountId !== targetAccountId) return;`, which failed open and broadcast events to **all connected tenants** whenever `targetAccountId` was `null` or `undefined` (`USF-06`).

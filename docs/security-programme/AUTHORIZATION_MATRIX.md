# 9. Complete Route, Command, and Action Authorization Matrix (`AUTHORIZATION_MATRIX.md`)

Every Backend HTTP route, WebSocket upgrade, and Admin endpoint is governed by explicit authentication, principal binding, tenant isolation, and state checks.

---

## 1. Core Protocol & Authentication Endpoints

| Endpoint / Action | Middleware | Required Principal & State Checks | Tenant Scoping & Invariants |
|---|---|---|---|
| `POST /auth` (`LOGIN`, `REGISTER`, `FORGOT_PASSWORD`, `RESET_PASSWORD`, `VERIFY_OTP`) | `authRateLimiter` (20 req / 15m per IP) | Public entry point; verifies Argon2id against `accounts.credentials_hash`; checks `accounts.status === 'ACTIVE'` on login. | Creates session bound to authenticated `account_id` and `machine_id`. |
| `POST /machines/register` | `envelopeValidator` | Verifies Ed25519 `selfSignature` over `{ machineId, accountId, publicKey, hardwareHash }` **before** returning existing machine or reclaiming dormant seat (`USF-10`). | Advisory lock `pg_advisory_xact_lock` per `accountId`; enforces `maxMachines` seat limit. |
| `POST /sessions/renew` | `envelopeValidator` | Requires `session.status === 'AUTHENTICATED'`, `session.expires_at > now()`, `session.account_id === req.accountId`, and `accounts.status === 'ACTIVE'` (`USF-07`). | Extends only the caller's own active session. |
| `POST /sessions/logout` | `envelopeValidator` | Requires `session.account_id === req.accountId` and `session.machine_id === req.machineId`. | Marks session `'REVOKED'`, revokes `authorizations`, increments `session_generation`, closes WebSocket. |
| `POST /authorization` | `envelopeValidator` | Requires `req.accountId`, `session.status === 'AUTHENTICATED'`, `session.expires_at > now()`, `accounts.status === 'ACTIVE'`, `machines.status === 'REGISTERED'`, mandatory `presentedGenerationState`, and `licenses.status === 'ACTIVE' AND (expires_at IS NULL OR expires_at > now())` (`USF-08`, `USF-09`). | Signs Ed25519 lease strictly for `(req.accountId, req.machineId, req.sessionId)`. |
| `POST /reconcile` | `envelopeValidator` | Uses verified `req.machineId` (never raw `envelope.machineId`, fixing `USF-10`) and verified `req.accountId`. | Reconciles only `(req.accountId, req.machineId)`. |
| `WS /` (WebSocket Upgrade) | `setupWebSocket` | Requires `sessions.status === 'AUTHENTICATED'`, `expires_at > now()`, `accounts.status === 'ACTIVE'`, and `(!machine_id || machines.status === 'REGISTERED')`. | `broadcast()` fails closed if `targetAccountId` is missing (`USF-06`). |

---

## 2. Operator Domain V1 Endpoints (`/api/v1/*`)

All `/api/v1/*` operator routes require `operatorAuth` (which enforces a non-null `req.accountId`, `req.sessionId`, `sessions.status = 'AUTHENTICATED'`, `sessions.expires_at > now()`, `accounts.status = 'ACTIVE'`, and `machines.status = 'REGISTERED'` across both v2 envelopes and Bearer sessions).

| Endpoint | Additional Guards | Tenant Isolation & Entitlement Enforcement |
|---|---|---|
| `GET /api/v1/prelude` | `operatorAuth` | Scoped strictly to `req.accountId` and `req.sessionId`. |
| `GET/POST/PATCH/DELETE /api/v1/accounts*` | `operatorAuth` | All queries filter by `WHERE account_id = $1` (`req.accountId`). `POST /api/v1/accounts` enforces active license `maxAccounts` limit (`USF-09`). Vault secrets require `KMS_LOCAL_SECRET`. |
| `GET /api/v1/automation` | `operatorAuth` | Reads tenant-specific `global_automation_configs WHERE id IN ($1, 'primary') ORDER BY (id = $1) DESC LIMIT 1` (`USF-04`). |
| `PATCH /api/v1/automation/global/:category` | `operatorAuth` | Upserts `global_automation_configs` at `id = req.accountId` (never mutates shared `'primary'` template, fixing `USF-04`). |
| `POST /api/v1/billing/payments/verify` | `operatorAuth` | Verifies `tx.data.metadata.account_id === req.accountId` (or customer email match), normalizes Paystack/Flutterwave status & minor units, validates `planId` price against `subscription_plans`, and locks canonical `providerRef` + `providerTxId` against replay (`USF-02`). |
| `POST /payments/checkout` | `operatorAuth` | Requires authenticated `req.accountId` (rejects cross-account `body.accountId`, fixing `USF-12`). |
| `POST /payments/webhook` | Raw HMAC Signature | Verifies `x-paystack-signature` / `verif-hash`; `outbox/worker.mjs` validates paid amount against `subscription_plans` and prevents unverified email `charge.failed` targeting (`USF-03`). |
| `GET /api/v1/platforms` | `operatorAuth` | Read-only catalog of bookmaker platforms for authenticated operators. |
| `POST /api/v1/platforms`, `PATCH /api/v1/platforms/:id/status` | `requireAdmin('SUPER_ADMIN')` | Restricted exclusively to `SUPER_ADMIN` (`USF-05`). Operators receive `401/403`. |
| `POST /api/v1/support/channels` | `requireAdmin('SUPER_ADMIN')` | Restricted exclusively to `SUPER_ADMIN` (`USF-05`). Operators receive `401/403`. |
| `POST /api/v1/settings` (`VERIFY_PASSWORD`, `CHANGE_PASSWORD`, `CONFIGURE_MFA`, `DELETE_ACCOUNT`, `REVOKE_SESSIONS`) | `operatorAuth` | Uses `credentials_hash`; requires step-up verification when disabling MFA or deleting account (`USF-11`); revokes machine only when owned by `req.accountId` (`USF-12`). |
| `GET /metrics` | `requireAdmin('SUPPORT')` | Restricted to authenticated admins (`USF-12`). |
| `POST /admin/login` | `adminLoginRateLimiter` | Constant-time Argon2 verification, TOTP replay defense (`lastUsedTotpStep`), failed-login audit logging (`USF-11`). |

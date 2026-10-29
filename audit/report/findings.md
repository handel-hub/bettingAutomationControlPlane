# Section 13.5 — Runtime Security Findings Register (`RT-F01` – `RT-F03`)

Structured machine-readable findings are persisted in [`audit/findings.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/findings.json). Every finding below was discovered and demonstrated via live runtime execution against the pinned baseline before remediation.

---

## Finding `RT-F01` — Cross-Account Payment Reference Claiming & Unverified Customer Email / Plan Amount Bypass on `/api/v1/billing/checkout/verify`

- **Test ID**: `PAY-04`
- **Classification**: `demonstrated_vulnerability` (Hostile Review Verdict: **SURVIVED**)
- **Invariants Violated**: `INV-01` (Conservation of Value & No Unpaid Entitlement Activation), `INV-02` (Webhook & Payment Idempotency), `INV-03` (Server-Authoritative Identity & Strict Tenant Isolation)
- **CVSS v3.1**: **8.1 HIGH** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:H`)
- **Confidence**: `confirmed`
- **Component & Code Locations**:
  - [`bettingAutomationBackend/src/api/routes/billing.mjs:81-103`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/billing.mjs#L81-L103) (`handleCheckout`)
  - [`bettingAutomationBackend/src/api/routes/billing.mjs:155-236`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/routes/billing.mjs#L155-L236) (`handleVerify`)
  - [`bettingAutomationBackend/src/domain/payment/service.mjs:13-36`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/payment/service.mjs#L13-L36) (`initiateCheckout`)
- **Single-Command Reproduction Script**: `node audit/repro/RT-F01-PAY-04.mjs` ([`audit/repro/RT-F01-PAY-04.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/repro/RT-F01-PAY-04.mjs))
- **Evidence**: [`audit/evidence/PAY-04/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PAY-04/result.json)
- **What Happened (Causal Chain)**:
  1. Victim (`Account A`) initiates checkout via `POST /api/v1/billing/checkout` (`planId: 'pro'`). `handleCheckout` calls `initiateCheckout` and returns `reference`, without recording any server-side binding between `reference` and `Account A`.
  2. Attacker (`Account B`) calls `POST /api/v1/billing/checkout/verify` with `{ reference: victimReference, planId: 'pro', billingInterval: 'monthly' }`.
  3. `handleVerify` calls `provider.verifyTransaction(reference)`. When `tx.data.meta.account_id` is absent (or when using provider verification responses that return `tx.data.customer.email` rather than custom `meta.account_id`), `if (txMeta.account_id && txMeta.account_id !== accountId)` is skipped, and `tx.data.customer.email` (`victim@example.com`) is never compared against `Account B`'s email in `accounts`.
  4. Furthermore, line 217 (`if (!txMeta.plan_id && planId !== 'pro' && amount !== expectedPrice)`) exempted `planId === 'pro'` from exact price matching when `txMeta.plan_id` was absent.
  5. `applyPaymentSuccess` credits the `Pro` subscription, `VALID` signed license, and `invoices` record to `Account B` (HTTP `200 OK`). Worse, when `Account A`'s legitimate provider webhook subsequently arrives, `outbox/worker.mjs:205` catches `PAYMENT_ALREADY_REDEEMED` on the stolen `reference` and marks the webhook `DELIVERED`, permanently locking `Account A` out of their paid subscription.

---

## Finding `RT-F02` — Starter Plan Platform Entitlement Restriction Bypass via Substring Inclusion & Unmerged `subscription_plans.entitlements`

- **Test ID**: `ENT-02`
- **Classification**: `demonstrated_vulnerability` (Hostile Review Verdict: **SURVIVED**)
- **Invariants Violated**: `INV-03` (Server-Authoritative Identity & Strict Tenant Isolation), `INV-04` (Entitlement & Tier Enforcement on Protected Operations)
- **CVSS v3.1**: **6.5 MEDIUM** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N`)
- **Confidence**: `confirmed`
- **Component & Code Locations**:
  - [`bettingAutomationBackend/src/domain/betting-accounts/service.mjs:150-155`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/betting-accounts/service.mjs#L150-L155) (`createBettingAccount`)
  - [`bettingAutomationBackend/src/domain/billing/service.mjs:218-242`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/billing/service.mjs#L218-L242) (`applyPaymentSuccess`)
  - [`bettingAutomationControlPlane/src/repositories/in-memory/InMemoryRepos.mjs:165-171`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/src/repositories/in-memory/InMemoryRepos.mjs#L165-L171) (`InMemoryAccountsRepo.update`)
- **Single-Command Reproduction Script**: `node audit/repro/RT-F02-ENT-02.mjs` ([`audit/repro/RT-F02-ENT-02.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/repro/RT-F02-ENT-02.mjs))
- **Evidence**: [`audit/evidence/ENT-02/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/ENT-02/result.json)
- **What Happened (Causal Chain)**:
  1. In `betting-accounts/service.mjs:150-155`, `createBettingAccount` validated `platformDisplayName` against `limits.allowedPlatformIds` using `normAllowed === normalizedPlatform || normalizedPlatform.includes(normAllowed)`. Passing `platformDisplayName: "Bet9ja (sportybet)"` or `"Pinnacle (sportybet)"` evaluated `.includes("sportybet")` to `true`, bypassing single-bookmaker or tier bookmaker restrictions.
  2. Additionally, in `billing/service.mjs:218-242`, `applyPaymentSuccess` queried `SELECT plan_id, entitlements FROM subscription_plans` (`maxAccounts`, `allowedPlatformIds`) on line 219 but only wrote `plan_entitlements.limits` (`max_machines`, `max_concurrent_browsers`) to `licenses.limits`, omitting `subscription_plans.entitlements` from newly provisioned licenses.
  3. On the Control Plane, `InMemoryAccountsRepo.update` allowed `PATCH /api/v1/accounts/:id` to overwrite `platformDisplayName` in local memory after creation.

---

## Finding `RT-F03` — Sessionless Protocol Envelopes (`sessionId: null`) Bypass Session Gate in `envelopeValidator`

- **Test ID**: `AUTH-02`
- **Classification**: `demonstrated_vulnerability` (Hostile Review Verdict: **SURVIVED**)
- **Invariants Violated**: `INV-03` (Server-Authoritative Identity & Strict Tenant Isolation), `INV-06` (Protocol Envelope Integrity, Nonce Uniqueness & Monotonic Generation), `INV-11` (Input Validation)
- **CVSS v3.1**: **5.3 MEDIUM** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:L`)
- **Confidence**: `confirmed`
- **Component & Code Locations**:
  - [`bettingAutomationBackend/src/api/middleware/envelope-validator.mjs:107-189`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/middleware/envelope-validator.mjs#L107-L189) (`envelopeValidator`)
  - [`bettingAutomationBackend/src/domain/session/service.mjs:16-28`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/domain/session/service.mjs#L16-L28) (`renew`)
- **Single-Command Reproduction Script**: `node audit/repro/RT-F03-AUTH-02.mjs` ([`audit/repro/RT-F03-AUTH-02.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/repro/RT-F03-AUTH-02.mjs))
- **Evidence**: [`audit/evidence/AUTH-02/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/AUTH-02/result.json)
- **What Happened (Causal Chain)**:
  1. `envelopeValidator` guarded session lookup and monotonic generation verification behind `if (envelope.sessionId)` (`envelope-validator.mjs:107`) and `if (envelope.sessionId && req.accountId)` (`envelope-validator.mjs:154`).
  2. When a registered machine sent a signed Envelope V2 with `sessionId: null` to `POST /api/v1/sessions/logout`, `envelopeValidator` skipped session verification, consumed the nonce in `server_nonces`, and invoked `logout(null, machineId)`, returning HTTP `200 OK` with a freshly KMS-signed Backend Envelope V2 (`{ success: true, loggedOut: true }`) — acting as an unauthenticated Backend signing oracle.
  3. When sent to `POST /api/v1/sessions/renew`, `renew(null, machineId, ...)` threw an untyped `new Error('Session state not found')` without `err.status`, causing an unhandled HTTP `500 Internal Server Error` (`BE_SYS_INTERNAL_ERROR`) instead of `401 Unauthorized`.

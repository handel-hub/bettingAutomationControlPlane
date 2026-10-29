# Section 13.6 — Independent Hostile Security Review (`Section 11`)

An independent hostile reviewer subagent (`conversationId: d51334b2-4721-4114-85b4-126230331f36`) was spawned with access **only** to `audit/findings.json`, `audit/ledger.jsonl`, `audit/evidence/`, `audit/repro/`, and the four source repositories.

## 1. Hostile Review Verdict Matrix

| Finding ID | Test ID | Baseline Status | Hostile Verdict | Revised / Confirmed CVSS v3.1 | Confidence |
|---|---|---|---|---|---|
| **RT-F01** | `PAY-04` | `EXECUTED-FAIL` | **SURVIVED** | **8.1 HIGH** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:H`) | `confirmed` |
| **RT-F02** | `ENT-02` | `EXECUTED-FAIL` | **SURVIVED** | **6.5 MEDIUM** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N`) | `confirmed` |
| **RT-F03** | `AUTH-02` | `EXECUTED-FAIL` | **SURVIVED** | **5.3 MEDIUM** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:L`) | `confirmed` |

---

## 2. Adversarial Challenges & Bypass Vectors Identified by the Reviewer

### Challenge 1 — `RT-F01` (`PAY-04`): Downstream Webhook Lockout & Reference Alias Evasion
- **Reviewer Finding**: Not only does `Account B` steal `Account A`'s paid subscription when `Account B` calls `POST /api/v1/billing/checkout/verify` with `Account A`'s reference, but downstream idempotency in `applyPaymentSuccess` (`invoices` table) and `outbox/worker.mjs:205` (`if (err.code === 'PAYMENT_ALREADY_REDEEMED') return true;`) causes `Account A`'s subsequent legitimate payment webhook (`charge.completed`) to be marked `DELIVERED` and skipped — permanently denying service to the paying victim (`Availability: High`).
- **Challenge to Naive Fix**:
  1. If checkout binding is only recorded in `billing.mjs`, an attacker could initiate or probe references via `payments.mjs` (`POST /api/v1/payments/checkout`) or pass `tx.data.id` instead of `tx.data.tx_ref`.
  2. **Required Hardening Applied**:
     - Added `recordCheckoutBinding` and `getCheckoutBinding` in `bettingAutomationBackend/src/domain/payment/service.mjs` (invoked in both `initiateCheckout` and `handleCheckout`).
     - Verified ownership against both `reference` and `providerRef` (`tx.data.tx_ref || tx.data.reference`), embedded UUID patterns (`flw_<uuid>_` and `account=<uuid>`), `txMeta.account_id`, and case-insensitive `tx.data?.customer?.email` against `accounts.email`.
     - Enforced bound `planId` match and removed the `planId !== 'pro'` exemption in `billing.mjs`.

### Challenge 2 — `RT-F02` (`ENT-02`): Empty-String Alphanumeric Collision, Unmerged Plan Entitlements & Local CP Mutation
- **Reviewer Finding**:
  1. A naive replacement of `.includes()` with `normalizedPlatform.replace(/[^a-z0-9]/g, '') === normAllowed.replace(/[^a-z0-9]/g, '')` would evaluate `"" === ""` (`true`) if an attacker submits a punctuation-only `platformDisplayName` (e.g. `"---"`) and any entry in `allowedPlatforms` normalizes to `""`.
  2. Furthermore, `applyPaymentSuccess` (`billing/service.mjs:218-242`) queried `subscription_plans.entitlements` (`allowedPlatformIds`, `maxAccounts`) but failed to merge them into `licenses.limits`.
  3. On the Control Plane, `InMemoryAccountsRepo.update` (`InMemoryRepos.mjs:165-171`) allowed `PATCH /api/v1/accounts/:id` to overwrite `platformDisplayName` in local memory.
- **Required Hardening Applied**:
  - Enforced `canonPlatform.length > 0 && canonPlatform === canonAllowed` in `betting-accounts/service.mjs:151-156`.
  - Merged `subscription_plans.entitlements` into `limits` in `billing/service.mjs:239-253`.
  - Preserved `id`, `platformDisplayName`, and `platformId` across `InMemoryAccountsRepo.update` in `InMemoryRepos.mjs:165-178`.

### Challenge 3 — `RT-F03` (`AUTH-02`): Nonce Burn Before Session Check & Direct Service Calls
- **Reviewer Finding**:
  1. All routers using `envelopeValidator` (`/sessions`, `/authorization`, `/reconciliation`, plus `operatorAuth` fallback) strictly require an authenticated session (`/machines/register` and `/auth/*` do not use `envelopeValidator`).
  2. Rejecting missing/non-UUID `envelope.sessionId` **before** `useNonce()` prevents unauthenticated callers from burning nonces or triggering DB queries, and attaching `err.status = 401; err.code = 'SESSION_REVOKED'` in `session/service.mjs:18-31` ensures direct service invocations also fail closed with `401`.
- **Required Hardening Applied**:
  - Enforced mandatory UUID `envelope.sessionId` unconditionally at `envelope-validator.mjs:107-117` prior to `useNonce()`, and hardened `session/service.mjs:18-31`.

### Challenge 4 — `AUTHZ-01` Ledger Subtlety: Missing `404` Status on Not-Found Betting Accounts
- **Reviewer Finding**:
  - While `AUTHZ-01` passed tenant isolation (`victimRecordModified: false`), `getBettingAccount`, `executeAccountAction`, and `updateBettingAccount` in `betting-accounts/service.mjs` threw untyped `new Error('Betting account not found')`, causing Express to return HTTP `500` instead of `404`.
- **Required Hardening Applied**:
  - Attached `err.status = 404; err.code = 'NOT_FOUND'` to all not-found errors in `betting-accounts/service.mjs`.

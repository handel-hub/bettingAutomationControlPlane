# Section 13.7 — Systemic Root Causes, Structural Remediation & Residual Risk

## 1. Grouped Root Causes Across Findings (`RT-F01` – `RT-F03`)

Rather than patching individual symptoms, the runtime findings were grouped into three systemic architectural root causes:

### Root Cause Cluster A (`RT-F01` / `PAY-04`): Unbound Payment Reference Initiation & Incomplete Verification Context Binding
- **Underlying Defect**: Checkout initiation (`initiateCheckout` / `handleCheckout`) delegated state tracking entirely to the payment provider's custom metadata (`tx.data.meta.account_id`), without maintaining a server-side binding of `reference → { accountId, planId, billingInterval, expectedAmount }` or verifying the provider's authenticated customer identity (`tx.data.customer.email`) against `accounts.email`. In addition, `handleVerify` contained a test-legacy exemption (`planId !== 'pro'`) in its exact-amount check.
- **Structural Remediation Applied**:
  1. **Server-Side Checkout Binding (`bettingAutomationBackend/src/domain/payment/service.mjs:4-34, 62-74` & `src/api/routes/billing.mjs:92-97`)**:
     - Added `recordCheckoutBinding(reference, binding)` and `getCheckoutBinding(reference)` in the payment domain service, automatically binding every initiated checkout reference (`tx_ref`, `/pay/<ref>`, and fallback `flw_<accountId>_<ts>`) to `accountId`, `planId`, `billingInterval`, `customerEmail`, and `expectedAmount`.
  2. **Multi-Layer Verification Guard (`bettingAutomationBackend/src/api/routes/billing.mjs:154-262`)**:
     - Layer 1: Verifies `boundCheckout.accountId === accountId` across both `reference` and `providerRef` (`403 CROSS_TENANT_REFERENCE_DENIED`).
     - Layer 2: Verifies `txMeta.account_id === accountId` when present (`403`).
     - Layer 3: Verifies embedded UUIDs in `flw_<uuid>_` or `account=<uuid>` against `accountId` (`403 CROSS_TENANT_REFERENCE_DENIED`).
     - Layer 4: Verifies `tx.data?.customer?.email` case-insensitively against `SELECT email FROM accounts WHERE account_id = $1` (`403 CUSTOMER_EMAIL_MISMATCH`).
     - Layer 5: Prevents plan upgrade spoofing against `boundCheckout.planId` and removes the `planId !== 'pro'` exemption so `if (!hasVerifiedPlanMeta && amount !== expectedPrice)` applies to all plans (`400 PLAN_METADATA_MISMATCH`).

### Root Cause Cluster B (`RT-F02` / `ENT-02`): Permissive Substring Entitlement Matching & Split Plan Entitlement Tables
- **Underlying Defect**:
  1. `createBettingAccount` (`betting-accounts/service.mjs:153`) used `normalizedPlatform.includes(normAllowed)`, allowing an attacker to embed a permitted platform identifier inside an unpermitted bookmaker name (`"Bet9ja (sportybet)"`).
  2. `applyPaymentSuccess` (`billing/service.mjs:218-242`) queried `subscription_plans.entitlements` (`allowedPlatformIds`, `maxAccounts`) and `plan_entitlements.limits` (`max_machines`, `max_concurrent_browsers`), but only wrote `plan_entitlements.limits` to `licenses.limits`.
  3. On the Control Plane, `InMemoryAccountsRepo.update` (`InMemoryRepos.mjs:165-171`) allowed `PATCH /api/v1/accounts/:id` to overwrite `platformDisplayName` in local memory.
- **Structural Remediation Applied**:
  1. **Canonical Alphanumeric Platform Equality (`bettingAutomationBackend/src/domain/betting-accounts/service.mjs:150-163`)**:
     - Replaced `.includes()` with `normAllowed === normalizedPlatform || (canonPlatform.length > 0 && canonPlatform === canonAllowed)` where `canonPlatform = normalizedPlatform.replace(/[^a-z0-9]/g, '')`.
  2. **Unified Plan Entitlements Provisioning (`bettingAutomationBackend/src/domain/billing/service.mjs:236-253`)**:
     - Merged `subscription_plans.entitlements` with `plan_entitlements.limits` when provisioning or updating `licenses.limits` in `applyPaymentSuccess`.
  3. **Immutable Bookmaker Platform on Account Update (`bettingAutomationControlPlane/src/repositories/in-memory/InMemoryRepos.mjs:165-178`)**:
     - Stripped `id`, `platformDisplayName`, and `platformId` from `updates` in `InMemoryAccountsRepo.update()`.
  4. **Explicit `404 Not Found` Error Typing (`bettingAutomationBackend/src/domain/betting-accounts/service.mjs:269-275, 325-332, 355-362, 424-431, 437-444, 452-459`)**:
     - Attached `err.status = 404; err.code = 'NOT_FOUND'` to all missing betting-account errors.

### Root Cause Cluster C (`RT-F03` / `AUTH-02`): Conditional Session Gate in Protocol Envelope Middleware
- **Underlying Defect**: `envelopeValidator` (`envelope-validator.mjs:107`) treated `envelope.sessionId` as optional (`if (envelope.sessionId)`), even though every router mounted behind `envelopeValidator` (`/sessions`, `/authorization`, `/reconciliation`) is strictly session-scoped.
- **Structural Remediation Applied**:
  1. **Unconditional UUID `sessionId` Gate Prior to Nonce Burn (`bettingAutomationBackend/src/api/middleware/envelope-validator.mjs:106-155`)**:
     - Enforced `if (!envelope.sessionId || !UUID_REGEX.test(String(envelope.sessionId)))` unconditionally before any database session lookup and before `useNonce()`, throwing HTTP `401 BE_AUTH_SESSION_EXPIRED`.
  2. **Service-Layer `401` Fail-Closed Guards (`bettingAutomationBackend/src/domain/session/service.mjs:18-32`)**:
     - Attached `err.status = 401; err.code = 'SESSION_REVOKED'` when `machine_session_states` or `sessions` lookup returns no matching row in `renew()`.

---

## 2. Residual Risk Assessment

1. **In-Memory Checkout Binding Across Multi-Node Backend Restarts (`Low`)**:
   - While `initiatedCheckoutBindings` in `payment/service.mjs` is an in-memory `Map`, Layers 2, 3, and 4 in `handleVerify` (`txMeta.account_id`, embedded `flw_<accountId>_` / `account=<accountId>` in `reference`, and `tx.data.customer.email === accounts.email` in PostgreSQL) are stateless and survive Backend process restarts or horizontal scaling.
2. **Local Administrator Reverse Engineering of Execution Plane (`Accepted by Architecture`)**:
   - A local administrator (T4) who controls the OS kernel can inspect local process memory; however, because bookmaker credentials, account limits, and subscription/license validity are enforced server-side (`INV-01`–`INV-06`), local tampering cannot mint server-side entitlements, bypass seat/account limits, or affect other tenants.

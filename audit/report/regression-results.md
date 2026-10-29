# Section 13.8 — Post-Remediation Verification & Regression Results

## 1. Reproduction Scripts Before vs. After Remediation

Each standalone reproduction script under [`audit/repro/`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/repro) was executed against the baseline (where the attack succeeded and the script exited `1` via assertion failure) and re-executed after Section 12 remediation (where the attack was blocked and the script exited `0`):

| Finding ID | Test ID | Repro Script Command | Baseline Result (Pre-Fix) | Post-Remediation Result |
|---|---|---|---|---|
| **RT-F01** | `PAY-04` | `node audit/repro/RT-F01-PAY-04.mjs` | `EXIT 1` — Attacker received HTTP `200 OK` and stole Victim's `Pro` subscription | `EXIT 0` (`REPRO-PASSED-AFTER-FIX`) — Attacker rejected with HTTP `403 Forbidden`; Victim's reference protected |
| **RT-F02** | `ENT-02` | `node audit/repro/RT-F02-ENT-02.mjs` | `EXIT 1` — `"Bet9ja (sportybet)"` bypassed Starter `allowedPlatformIds` via `.includes()` | `EXIT 0` (`REPRO-PASSED-AFTER-FIX`) — `"SportyBet"` control succeeded; `"Bet9ja (sportybet)"` rejected with `403 BE_PERM_ENTITLEMENT_EXCEEDED` |
| **RT-F03** | `AUTH-02` | `node audit/repro/RT-F03-AUTH-02.mjs` | `EXIT 1` — Sessionless `/sessions/logout` returned `200 OK` signed envelope; `/sessions/renew` returned `500` | `EXIT 0` (`REPRO-PASSED-AFTER-FIX`) — Both `/sessions/logout` and `/sessions/renew` rejected sessionless envelopes with HTTP `401 BE_AUTH_SESSION_EXPIRED` |

---

## 2. Permanent In-Repository Regression Tests Added

Added subtest `T-RT-F01..T-RT-F03: Runtime Security Assessment Regression Suite (PAY-04, ENT-02, AUTH-02)` to [`bettingAutomationBackend/tests/security-redesign-invariants.test.mjs:719-824`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/tests/security-redesign-invariants.test.mjs#L719-L824):

- **`T-RT-F01` (`PAY-04`)**: Verifies that initiating a checkout under Operator A and attempting `POST /api/v1/billing/checkout/verify` with Operator A's `reference` under Operator B's authenticated session is rejected with HTTP `403`.
- **`T-RT-F02` (`ENT-02`)**: Verifies that `createBettingAccount` with `allowedPlatformIds: ["sportybet"]` rejects `platformDisplayName: "Bet9ja (sportybet)"` with HTTP `403 BE_PERM_ENTITLEMENT_EXCEEDED`.
- **`T-RT-F03` (`AUTH-02`)**: Verifies that signed Envelope V2 requests with `sessionId: null` to `POST /api/v1/sessions/logout` and `POST /api/v1/sessions/renew` are rejected with HTTP `401`.

---

## 3. Full Repository Regression Suite Results

| Repository | Command | Total Tests | Passed | Failed | Duration |
|---|---|---|---|---|---|
| **Backend (`bettingAutomationBackend`)** | `npm --prefix ..\bettingAutomationBackend test` | **84** | **84** | **0** | `28.87s` |
| **Control Plane (`bettingAutomationControlPlane` — Adversarial Suite)** | `npm run test:adversarial` | **47** | **47** | **0** | `3.20s` |
| **Runtime Assessment Repro Suite (`audit/repro/*.mjs`)** | `node audit/repro/RT-F01-PAY-04.mjs && node audit/repro/RT-F02-ENT-02.mjs && node audit/repro/RT-F03-AUTH-02.mjs` | **3** | **3** | **0** | `1.80s` |

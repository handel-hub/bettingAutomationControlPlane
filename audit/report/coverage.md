# Section 13.9 — Assessment Coverage Statement & Ledger Accounting

## 1. Campaign & Tier Execution Accounting (`audit/ledger.jsonl`)

All `44` planned runtime test campaigns across Phase 2 (`PF-01`..`PF-19`), Phase 3 (`BASE-01`), Phase 4 Tier 1 (`AUTH-*`, `AUTHZ-*`, `PAY-*`, `ENT-*`, `CP-TAMPER-*`), Phase 4 Tier 2 (`LOCAL-SURFACE-01`, `EP-*`, `TRANSPORT-01`, `CLIENT-PROT-01`, `TIME-ROLLBACK-*`, `UPDATE-01`), Phase 4 Tier 3 (`WEB-01`, `DOS-01`, `DATA-01`), and Phase 5 (`FAULT-01`..`FAULT-04`) were executed to completion without budget compression or skipped tiers:

| Phase / Tier | Campaign Scope | Executed Test IDs | Baseline `EXECUTED-PASS` | Baseline `EXECUTED-FAIL` | Post-Remediation Status | `BLOCKED` / `SKIPPED` |
|---|---|---|---|---|---|---|
| **Phase 0** | Preflight & Observability Canaries | `PREFLIGHT-GATE`, `CANARY-BE`, `CANARY-CP`, `CANARY-EP` | 4 | 0 | **4 PASS** | 0 |
| **Phase 2** | Prior Findings Re-Verification | `PF-01` – `PF-19` | 19 | 0 | **19 PASS** | 0 |
| **Phase 3** | Baseline End-to-End Trace | `BASE-01` | 1 | 0 | **1 PASS** | 0 |
| **Phase 4 — Tier 1** | Auth, AuthZ, Money/Billing, Entitlements, CP Tamper | `AUTH-01`..`03`, `AUTHZ-01`..`03`, `PAY-01`..`04`, `ENT-01`..`03`, `CP-TAMPER-01`..`02` | 12 | 3 (`PAY-04`, `ENT-02`, `AUTH-02`) | **15 PASS** (all 3 remediated & verified) | 0 |
| **Phase 4 — Tier 2** | Local Surface, Execution Plane IPC, Transport, Client Protection, Time/Rollback, Update Channel | `LOCAL-SURFACE-01`, `EP-01`..`02`, `TRANSPORT-01`, `CLIENT-PROT-01`, `TIME-ROLLBACK-01`..`02`, `UPDATE-01` | 8 | 0 | **8 PASS** | 0 |
| **Phase 4 — Tier 3** | Web Hygiene, DoS/Resource Bounds, Data/Error Handling | `WEB-01`, `DOS-01`, `DATA-01` | 3 | 0 | **3 PASS** | 0 |
| **Phase 5** | Multi-Step Fault Injection & Recovery | `FAULT-01`..`FAULT-04` | 4 | 0 | **4 PASS** | 0 |
| **Total** | **All Phases & Tiers** | **44 Ledger Entries + 4 Preflight Canaries** | **41 (+4)** | **3 (`RT-F01`–`RT-F03`)** | **100% PASS** | **0** |

---

## 2. Out-of-Scope & Hard-Stop Compliance

1. **External Third-Party Hosts**: Per Section 1 Rules of Engagement, zero live third-party bookmaker sites (`SportyBet`, `Bet9ja`, `Pinnacle`, etc.) and zero live payment gateways (`api.flutterwave.com`, `api.paystack.co`) were contacted or load-tested. All payment and bookmaker interactions used local sandbox/stub adapters.
2. **Host System Clock**: Per Section 1 Rules of Engagement, the Windows host OS clock was never modified; all time-travel, lease-expiry, and clock-rollback tests (`PF-12`, `PF-17`, `TIME-ROLLBACK-01`, `TIME-ROLLBACK-02`) used isolated injectable clock providers (`PersistentClock`) and temporary SQLite snapshots.
3. **Quarantined FTS Module**: As documented in `bettingAutomationBackend/src/server.mjs:19,91-92`, `/transfers` (`FTS`) is unmounted/quarantined in the active server and therefore not reachable on the runtime HTTP surface.

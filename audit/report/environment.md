# Section 13.1 — Runtime Environment, Topology, Observability & Isolation Proof

## 1. Repository Topology & Pinned Baseline Revisions

All runtime security assessment campaigns (Phases 0–5) were executed against the pinned baseline commits recorded in [`audit/preflight.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/preflight.json):

| Component | Repository Path | Baseline Commit | Post-Remediation Status | Runtime Stack |
|---|---|---|---|---|
| **Control Plane (CP)** | `c:\Users\John\Documents\CODE\back\bettingAutomationControlPlane` | `28e5d7137630ca874074d61f8498cfbd7bc6117e` | Remediated (`InMemoryRepos.mjs` platform immutability) | Node.js `v24.13.0` (`win32 x64`), SQLite (`node:sqlite` + Rust NAPI-RS `security-core.win32-x64-msvc.node`) |
| **Backend (BE)** | `c:\Users\John\Documents\CODE\back\bettingAutomationBackend` | `094c38b03116f0c94957e5082db4c23f6741e779` | Remediated (`RT-F01`, `RT-F02`, `RT-F03` + regression tests) | Node.js `v24.13.0`, Express `5.2.1`, PostgreSQL (`127.0.0.1:5432/betting_control_plane`), `ws` `8.21.1` |
| **Execution Plane (EP)** | `c:\Users\John\Documents\CODE\back\bettingAutomation` | `f355c010a291401c79ce1ab33a1e0449312a1da1` | Verified clean (`0` dirty files) | Node.js `v24.13.0`, Playwright, Windows Named Pipe IPC (`SecureIpcClient`) |
| **Frontend (FE)** | `c:\Users\John\Documents\CODE\back\betting-automation-frontend` | `f03989cf5d5da7e0058cecf5d85a9f70f0eb1e4c` | Verified clean (`0` dirty files) | Next.js (`src2/`), BFF API routes proxying to CP (`127.0.0.1:4000`) & BE (`127.0.0.1:8080`) |

---

## 2. Phase 0 Isolation Proof (`audit/preflight.json`)

Execution of [`audit/run-preflight.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/run-preflight.mjs) verified every hard rule in Section 1 before any adversarial traffic was generated:

- **Database Isolation**:
  - Host: `127.0.0.1` (`isLocalDatabase: true`)
  - Database: `betting_control_plane` (disposable local PostgreSQL instance)
  - Control Plane local state: isolated temporary directories (`os.tmpdir()/acp-audit-*`) and disposable SQLite databases per campaign test.
- **Payment Provider Sandbox / Stub Isolation**:
  - `NODE_ENV=test`, `ALLOW_TEST_PAYMENT_STUB=true`
  - Configured provider keys (`FLW_SECRET_KEY`, `PAYSTACK_SECRET_KEY`) verified to carry zero live production prefixes (`FLWSECK_LIVE*` / `sk_live_*` absent: `hasLiveFlwKey: false`, `hasLivePaystackKey: false`).
  - Zero external third-party hosts contacted during any campaign; all payment provider interactions ran against deterministic local mock/stub adapters.
- **Clock Manipulation Isolation**:
  - Host OS clock was never modified. All clock-skew, lease-expiry, and rollback campaigns (`PF-12`, `PF-17`, `TIME-ROLLBACK-01`, `TIME-ROLLBACK-02`, `FAULT-04`) used injectable `clockFn` / `PersistentClock` and isolated SQLite database snapshots.
- **Secret Hygiene**:
  - All tokens, passwords, and cryptographic keys in [`audit/preflight.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/preflight.json), [`audit/surface.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/surface.json), [`audit/ledger.jsonl`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/ledger.jsonl), and `audit/evidence/<test-id>/result.json` are either ephemeral test-only UUIDs or SHA-256 fingerprint digests (`sha256:...`).

---

## 3. Observability Canaries (`audit/preflight.json`)

All three architectural planes passed active observability canary verification prior to Phase 1:

1. **Backend Canary (`PASSED`)**:
   - Action: Inserted and queried a synthetic `OBSERVABILITY_CANARY` event in PostgreSQL `security_events` with correlation ID `canary-be-4fa707ef-bd3e-46f0-9914-922c3737df0b`.
   - Result: Verified row persistence, hash-chain trigger (`event_hash` / `prev_event_hash`), and cleanup.
2. **Control Plane Canary (`PASSED`)**:
   - Action: Bootstrapped `SecurityAuthorityFacade` in an isolated temporary directory (`canary-cp-0900c7ff-7392-4550-a70b-10913d7f6215`) and invoked `isCommandPermitted('START_EXECUTION')` while `UNAUTHENTICATED`.
   - Result: Confirmed fail-closed denial (`permitted === false`, `state === 'UNAUTHENTICATED'`).
3. **Execution Plane Canary (`PASSED`)**:
   - Action: Instantiated `SecureIpcClient` (`bettingAutomation/src/ipc/SecureIpcClient.js`) with correlation ID `canary-ep-73fdacde-3b54-4a34-b085-4996f9f9c739` and injected an unauthenticated `START` frame prior to `AUTH_CHALLENGE`.
   - Result: Confirmed the unauthenticated command frame was dropped (`droppedUnauthCommand === true`).

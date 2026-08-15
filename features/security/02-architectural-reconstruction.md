# 02 — Architectural Reconstruction
## Resolving HR-01 … HR-24 into a Coherent, Corrected Architecture

**Status:** Supersedes the prior `reconstruction.md`. Written against the corrected findings in `01-hostile-security-review.md`.

This document does what the first pass's reconstruction did, at greater depth and grounded in the actual schemas/vocabulary of the 18 source documents rather than an approximation of them. For every major change: original design → problem → required property → redesign → why it fixes the problem → new dependencies/state/transitions → new persistence/failure requirements → new testing requirements.

---

## 1. Change Summary

| Change | Resolves | Type |
|---|---|---|
| Two-layer Identity Architecture (Local Descriptor + Backend-Registered Identity), with `installation_id` given an explicit, load-bearing role | HR-01, HR-18 | New / Clarified |
| Local IPC two-factor authentication (peer verification + spawn token) | HR-02 | New |
| Runtime Manager "lost control channel = treat as revoke" rule | HR-03 | New (narrow) |
| Persisted, checkpointed offline-grace accumulator | HR-04 | Modified |
| `key_storage_tier` as explicit policy input | HR-05 | New |
| Offline authorization policy table, restated in the API contract section (not just the schema section) | HR-06 | Modified (traceability fix) |
| Single-instance OS-level lock, chosen from the menu of options | HR-07 | Modified (decision made) |
| Non-guarantee callout moved next to the tamper state machine itself | HR-08 | Modified (wording/placement) |
| Explicit causal graph between the five generation counters + `SECURITY_STATE_UNCERTAIN` as the fallback for any combination outside it | HR-09, HR-10 | New |
| `DISABLE_SECURITY` / `SKIP_LICENSE_CHECK` explicitly framed as adversarial targets, compiled out of release builds | HR-11 | Modified (wording + build requirement) |
| Canonical `CAP_<DOMAIN>_<ACTION>` capability enum | HR-12 | Modified (naming unification) |
| Session state made a strict input to overall security state, not a same-named parallel state set | HR-13 | Modified |
| Backend-side mass-revocation circuit breaker (noted, backend-side) | HR-14 | New (backend-side) |
| Never-log list enforced at a shared sink | HR-15 | Modified |
| Secure reset attempts best-effort backend invalidation | HR-16 | Modified |
| Protocol deprecation policy | HR-17 | New (operational) |
| Consolidated TOCTOU mitigation pattern | HR-19 | Modified |
| Canonical glossary | HR-21 | New |
| Shared Platform layer for time/logging/config | HR-22 | New |
| Rust-is-not-a-boundary language preserved verbatim in spirit | HR-23 | Retained |
| Subsystem/black-box architectural style preserved | HR-24 | Retained |

Everything not listed above — the fundamental layering (Identity → Trust → Authentication → Session → Entitlement → Authorization → Security State), fail-closed defaults, the capability-oriented Execution Plane boundary, the refusal to invent custom cryptography, the Security Facade / Security Decision Engine internal architecture, and the `SecurityResult<T>` / status-vocabulary pattern from the API Contract document — is retained unchanged, because the full read-through confirmed it is sound.

---

## 2. Identity Architecture (resolves HR-01, HR-18)

**Original design:** `MachineIdentity { machine_id, installation_id, identity_version, status, created_at, last_registered_at, last_verified_at, key_reference, backend_binding_id, generation, created_by_version, updated_at }`, with `machine_id` (backend-recognized) deliberately distinct from `installation_id` (this specific installation), but no document specifying what `key_reference` points to or how it resists copying.

**Problem:** A well-shaped schema with an undefined load-bearing field is indistinguishable, in practice, from no protection at all — an attacker copying the install directory copies `key_reference`'s target too, unless something outside the copied files anchors it.

**Required security property:** A copied installation must be *distinguishable* from the original by the Backend, even though the local files are byte-identical.

**Redesign:**

```
MachineIdentity (retained schema, clarified semantics)

Layer 1 — installation_id
    Generated locally at first run. This is exactly the field the schema
    already reserves for "this specific installation." It is NOT itself
    proof of anything — it's advisory, and it MUST be accompanied by a
    composite of loosely-stable local signals (not a single hardware ID)
    that give the Backend something to compare across registration
    attempts. This is where HR-18's "dead schema" concern is resolved:
    installation_id becomes load-bearing specifically as the value the
    Backend correlates against re-registration attempts to detect
    duplication, not as a value the local client trusts on its own.

Layer 2 — machine_id
    Assigned only by the Backend, only in response to a registration
    request bound to an authenticated account. This is the identifier
    every downstream authorization decision actually uses.

key_reference
    Points at key material that MUST live in the OS-protected tier
    (§7, key_storage_tier), not in the copyable application-file tree.
    This closes the actual gap: the schema's key_reference field was
    always correctly designed to point outside the copyable filesystem —
    the fix is making that requirement explicit rather than implicit.
```

**Why this fixes the problem:** Duplication detection moves to where it can actually work — the Backend observing `installation_id`/`machine_id` correlation across registration attempts over time — instead of depending on a local secret that's provably copyable under the stated threat model.

**New dependencies:** Backend must implement a registration-anomaly policy (§72, open decision — aggressiveness is a business call).

**New state:** `MachineIdentity.status` gains a `RE_VERIFICATION_REQUIRED` value (already implied by the lifecycle in `Local_Security_Storage_Schem_Persistence_Model.md` §9's `REPLACEMENT_REQUIRED`, made explicit and connected to the Backend-driven flow rather than a purely local corruption-recovery path).

**New persistence requirement:** `key_reference` must resolve to OS-protected storage; if it doesn't (fallback tier), `key_storage_tier` (§7) reflects that and downstream policy adjusts.

**New testing requirement:** A test that copies the entire local data directory to a second machine and confirms the Backend, not the local client, is the one that eventually flags/denies the duplicate — the local client alone must not be expected to detect this.

---

## 3. Local IPC Security (resolves HR-02)

**Original design:** Trust-domain table (`API_Interface_Contract.md` §5) distinguishes Frontend/local-process/etc. by name, with no mechanism for the Control Plane to actually tell them apart at connection time.

**Redesign:** Two independent checks:
1. OS-native peer verification (Unix `SO_PEERCRED` / Windows named-pipe client inspection) confirming the connecting process is the specific, signed Frontend binary the Control Plane spawned.
2. A per-session spawn-time token, delivered via a channel not trivially readable by unrelated local processes, required on every request.

**Why this fixes the problem:** It answers the question the trust-domain table assumed was already answered — "who is actually on the other end of this socket" — with a mechanism, not a label.

**New state:** `IPC_UNTRUSTED` (already present in the Tamper-Aware State Machine document's harvested vocabulary — this redesign gives it a defined trigger it didn't previously have).

**New testing requirement:** Connect to the local API from a process that isn't the spawned Frontend and confirm rejection at the peer-verification layer, before any application-level request is even parsed.

---

## 4. Runtime Manager Control-Channel Loss (resolves HR-03)

**Original design:** Correctly places Runtime Manager outside the Security Authority, downstream, holding an opaque `ExecutionAuthorization` artifact — but never states its behavior if the Security Authority stops pushing events while the artifact's own `expires_at` hasn't yet arrived.

**Redesign — one explicit rule, added to `security_authority_execution_plane_authorization_contract.md`'s successor section in Phase 3:**

> The Runtime Manager treats loss of its event channel to the Security Authority (crash, IPC failure, SA restart) as equivalent to a revoke for any capability not already safely completable, regardless of whether the held `ExecutionAuthorization.expires_at` has passed. It does not treat "no revoke received" and "channel unavailable" as the same thing as "still authorized."

**Why this fixes the problem:** It closes the one real gap in an otherwise correctly-drawn boundary — "push, not poll" only works as a security property if silence is treated as suspicious, not as permission.

**New failure behavior:** Runtime Manager health-checks its connection to the Security Authority on an interval; loss of heartbeat triggers the same restrictive path as an explicit revoke.

**New testing requirement:** Kill the Security Authority process mid-execution with a live, not-yet-expired `ExecutionAuthorization` still held by the Runtime Manager, and confirm the Runtime Manager restricts rather than continuing until the artifact's stated expiry.

---

## 5. Offline-Grace Accumulator (resolves HR-04)

Unchanged in substance from the first pass — persisted, periodically checkpointed accumulator, wallclock/accumulated-duration mismatch on startup treated as `CLOCK_ANOMALY` (a state name already present in the harvested vocabulary of at least four of the 18 documents, so this redesign uses an existing state rather than inventing one).

---

## 6. Key Storage Tiering (resolves HR-05)

Unchanged in substance from the first pass — `key_storage_tier ∈ {hardware, os_keychain, software_encrypted}` surfaced to policy. New in this pass: this field is what §2's `key_reference` resolves through, making the two redesigns (Identity, Key Tiering) consistent with each other rather than independent.

---

## 7. Offline Authorization — Traceability Fix (resolves HR-06)

**Original design:** The correct rule ("determine existing authorization state, then apply offline policy") lives in `Local_Security_Storage_Schem_Persistence_Model.md` §44; the document implementers actually code the API surface against (`Security_Authority_API_Interface_Contract.md` §37) states only the negative half of the rule.

**Redesign:** Not a design change — a traceability fix. Phase 3's Authorization section states the per-capability offline policy table (unchanged from the first-pass reconstruction's version) exactly once, and every other section that touches offline behavior (API contract, session, execution authorization) references it instead of restating a partial version.

| Capability class | Continuation of existing grant while offline | New request while offline |
|---|---|---|
| Continue active execution | Permitted within offline-grace budget | N/A |
| Start new execution (`CAP_AUTOMATION_START`) | N/A | Denied |
| Read-only/informational | Permitted indefinitely | Permitted |
| License/entitlement-changing | N/A | Denied |

---

## 8. Single-Instance Enforcement — Decision Made (resolves HR-07)

**Original design:** Menu of options (`local security storage lock`, `OS mutex`, `lock file`, `IPC ownership`, `process identity validation`) presented without a chosen default.

**Redesign:** OS-level exclusive lock/mutex (`flock`/`O_EXCL` on POSIX, named mutex on Windows), acquired before any security-state read at startup, explicitly *not* a bare lock file (per `local_security_storage_architecture.md` §54's own warning against naive lock files that require this exact follow-through). A second launch attempt fails acquisition and hands off to (or notifies) the existing instance rather than proceeding independently.

---

## 9. Tamper Non-Guarantee Placement (resolves HR-08)

**Redesign:** The same non-guarantee language already present correctly in the threat-model document is duplicated (not just referenced) directly adjacent to the tamper state machine's transition table in Phase 3, so an implementer reading the state machine can't miss it by not having a different document open.

---

## 10. Generation Counter Causal Graph + `SECURITY_STATE_UNCERTAIN` Wiring (resolves HR-09, HR-10)

**Original design:** `session_generation, authorization_revision, license_revision, machine_generation, server_trust_version` — five independently-advancing counters with no stated relationship between them; `SECURITY_STATE_UNCERTAIN` defined at the API layer but absent from the state-machine document's own state vocabulary.

**Redesign:**

```
Causal graph (which counter changes must co-occur):

license_revision change
      │
      └──▶ MUST co-occur with authorization_revision change
              (same transaction — a license change that doesn't
               produce a corresponding authorization recomputation
               is itself a detectable anomaly)

session_generation
      │
      └──▶ independent — sessions renew without license/authorization
              changing, and vice versa. No forced co-occurrence.

machine_generation
      │
      └──▶ independent, but a machine_generation change without a
              corresponding MachineIdentity status transition
              (§2, RE_VERIFICATION_REQUIRED or better) is anomalous.

server_trust_version
      │
      └──▶ independent — trust-anchor rotation is orthogonal to
              account-level state.

Any combination of these five counters observed at startup or on
reconciliation that violates the stated causal graph above (e.g.
license_revision advanced but authorization_revision did not) →
SECURITY_STATE_UNCERTAIN, which becomes a first-class, reachable
state in the Phase 3 state machine (not just an API-layer status
with no internal state behind it) → forces reconciliation with the
Backend before any other transition is permitted.
```

**Why this fixes the problem:** It gives the "five counters" design (which is genuinely a good idea, more precise than a single flattened epoch) an actual consistency contract, and gives `SECURITY_STATE_UNCERTAIN` — a status the API contract already promises callers it can return — somewhere to actually come from.

**New testing requirement:** Deliberately construct a persisted state with `license_revision` advanced but `authorization_revision` held back (simulating a crash between the two writes of what should have been one transaction) and confirm the system lands in `SECURITY_STATE_UNCERTAIN`, not in a silently-accepted inconsistent `OPERATIONAL` state.

---

## 11. Adversarial Configuration Framing (resolves HR-11)

**Redesign:** Wherever `DISABLE_SECURITY`, `SKIP_LICENSE_CHECK`, or equivalent identifiers appear in the canonical specification, they are framed explicitly as *things an attacker might try to set*, appearing only in threat-scenario/example blocks — never as a documented configuration option with a "how to enable" section. Any legitimate development/testing equivalent must be compiled out of release builds entirely (build-time, not runtime-gated), consistent with the threat model's assumption that the attacker can read and flip any runtime-accessible flag.

---

## 12. Canonical Capability Enum (resolves HR-12)

**Original design:** Three naming schemes across three documents (`RUN_AUTOMATION`/`START_EXECUTION`/... vs. `CAPABILITY_EXECUTION`/... vs. `CAP_AUTOMATION_START`/...).

**Redesign:** Adopt `CAP_<DOMAIN>_<ACTION>` (the systematic scheme from the protocol-specification-continuation document) as canonical:

```
CAP_AUTOMATION_START      (supersedes RUN_AUTOMATION, CAPABILITY_EXECUTION, START_EXECUTION)
CAP_AUTOMATION_STOP       (supersedes STOP_EXECUTION)
CAP_BROWSER_ALLOCATE      (supersedes CAPABILITY_BROWSER_ALLOCATION)
CAP_FILE_UPLOAD           (supersedes UPLOAD_FILE, CAPABILITY_FILE_UPLOAD)
CAP_FILE_DOWNLOAD         (supersedes DOWNLOAD_FILE, CAPABILITY_FILE_DOWNLOAD)
CAP_CONFIG_MODIFY         (supersedes MODIFY_CONFIGURATION, CAPABILITY_CONFIGURATION)
CAP_UPDATE_INSTALL        (supersedes INSTALL_UPDATE)
```

---

## 13. Session State as Strict Input, Not Parallel State (resolves HR-13)

**Redesign:** Session status (`NO_SESSION, AUTHENTICATING, AUTHENTICATED, RENEWING, DEGRADED, EXPIRED, REVOKED, LOGGING_OUT, LOGGED_OUT, INVALID`) is retained exactly as schema'd, but is explicitly one *input* the Security Decision Engine (Internal Design §13) considers, alongside license/machine/integrity state — it never independently produces a whole-system state with the same name. Whole-system `DEGRADED`/`REVOKED` are outputs of the Decision Engine's evaluation of all inputs together, including but not equal to session state.

---

## 14–20. Carried-Forward Fixes (HR-14 through HR-22, unchanged in substance from the first pass, restated briefly)

- **HR-14:** Backend-side mass-revocation circuit breaker — operational, backend-side, named so the risk isn't silently unaddressed given the architecture's correct "always trust an individual revocation" local behavior.
- **HR-15:** Never-log list enforced at a shared logging sink, not per-call-site — now backed by two independently-written source lists that agree, strengthening confidence in the actual list contents.
- **HR-16:** Secure reset attempts best-effort Backend-side invalidation; local reset never blocks on Backend reachability.
- **HR-17:** Protocol deprecation policy — operational decision, exposed as a tunable.
- **HR-19:** TOCTOU — one consolidated pattern ("authorize and act inside the same atomic scope") stated once in Phase 3, referenced by name everywhere the three source documents raised it separately.
- **HR-21:** Canonical glossary — stronger case after full read (HR-09, HR-12, HR-13 all stem from un-reconciled vocabulary).
- **HR-22:** Shared Platform layer (`time`, `logging`, `config`) — thin, authority-free, imported by every subsystem.

---

## 21. Explicitly Retained, Unweakened (HR-23, HR-24)

Two things the full read-through confirmed were already correct and must not be diluted in Phase 3:

1. **"Rust is not a security boundary by itself"** (`local_security_storage_architecture.md` §74) — carried forward verbatim in spirit: Rust/native components raise reverse-engineering cost and provide memory safety, and are good candidates for the Cryptographic Core and Storage Adapter, but they do not convert a logical authorization bug, bad key management, or a patchable check into something the language choice fixes.
2. **The subsystem/black-box architectural style** — followed with unusual consistency across all 18 documents (every one of them, independently, draws the Security Authority as a black box with a stable public interface and hidden internals). Phase 3 preserves this structure exactly rather than replacing it with a layered MVC-style decomposition.

---

## 22. Unresolved Decisions Carried Into Phase 3 as Explicitly Open

1. Exact composition of the Layer-1 local descriptor (§2) — piracy-resistance/false-positive tradeoff.
2. Backend registration-anomaly policy aggressiveness (§2).
3. Numeric tunables: offline-grace budget, session lifetimes, renewal windows, retry/backoff constants.
4. Whether `software_encrypted` key tier surfaces a user-visible notice.
5. Backend trust-anchor mechanism (OS trust store vs. pinned certificates).
6. Concurrent-session policy count, if any — business decision.
7. Active-operation policy on license expiration (immediate/graceful/restricted) — product decision, exposed as a configurable table (§7's shape, applied to this decision too).
8. Backend anomaly-response threshold for the mass-revocation circuit breaker (HR-14).

---

**Next:** `03-security-authority-canonical-specification.md` — the complete, self-contained authoritative document incorporating everything above, preserving the technical depth of the 18 source documents in corrected form rather than summarizing it away.

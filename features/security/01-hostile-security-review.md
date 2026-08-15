# 01 — Hostile Security Review
## Control Plane Security Authority — 18-Document Architecture Set

**Status:** Supersedes the prior `hostile-review.md` from the first pass. That file is retained as a historical artifact; this document reflects a full read-through of all 18 source documents (not a sampled review) and corrects one finding from the first pass (see HR-03 below).

**Reviewer posture:** attacker with full control of the local machine, actively trying to defeat subscription enforcement + senior security architect, simultaneously.

---

## 0. Scope of This Pass

All 18 documents were read in full this time, not sampled. This matters because the first-pass review, built on strategic sampling, got the big-picture architecture right but missed detail that only shows up when you actually trace a schema field or a state name across documents. Two things changed as a result:

1. **HR-03 from the first pass is corrected, not repeated.** The claim that the Internal Design and API Contract documents "describe the Security Authority as exposing a public API directly to callers, with no Runtime Manager" is **not accurate**. `Security_Authority_Architecture_Internal_Design.md` §11 lists the Security Authority's internal components explicitly and does **not** include Runtime Manager among them — correctly, because §10 of the same document places Runtime Manager downstream, as a consumer of Security Authority decisions, not a part of it. `Security_Authority_API_Interface_Contract.md` §53's final architectural diagram and `local_security_storage_architecture.md`'s "Final Architecture" diagram both show the same shape: `Security Authority → Runtime Manager → Execution Plane`. The three documents agree with each other. This finding is retracted below and replaced with a narrower, real one (new HR-03).

2. **A much larger set of concrete, checkable findings emerged** — largely because the documents use dozens of specific state names, capability names, and schema fields (`session_generation`, `authorization_revision`, `license_revision`, `machine_generation`, `CAP_AUTOMATION_START`, `MACHINE_UNTRUSTED`, `SECURITY_STATE_UNCERTAIN`, etc.) that a summarized reading would have flattened into "the epoch" or "authorization." Several real findings live specifically in the *relationships between these named fields*, not in the general concepts, which is exactly the kind of thing a hostile review is supposed to catch.

Findings are renumbered `HR-01`…`HR-24` and don't map one-to-one onto the first pass's numbering; treat this document as authoritative.

---

## CRITICAL

### HR-01 — Machine identity binding mechanism is still undefined, and now provably so at the schema level

**Affected component:** Machine Identity (`local_security_storage_architecture.md` §17–21, 55–56; `Local_Security_Storage_Schem_Persistence_Model.md` §8–11, 57–58)

**Existing design:** The schema document defines a concrete `MachineIdentity` record — `machine_id, installation_id, identity_version, status, created_at, last_registered_at, last_verified_at, key_reference, backend_binding_id, generation, created_by_version, updated_at` — and is explicit that `machine_id` (backend-recognized) and `installation_id` (this specific installation) are deliberately different fields, precisely so a copied installation can be distinguished from the original. This is good schema design. The document also says machine identity "should be cryptographically bound to installation/device state where practical" and that the Backend "should be capable of detecting suspicious duplication" — and stops there.

**Attack or failure scenario:** The schema has a `key_reference` field pointing at *some* key that's supposed to bind identity to hardware/installation, but no document among the 18 specifies what that key is derived from, how it's generated, or what makes it non-portable. An attacker who copies the entire application directory (explicitly the scenario walked through in §55 of the storage-architecture document) copies `key_reference` along with everything else. If the referenced key lives anywhere the attacker's file copy already reached — which is the default assumption unless a document says otherwise, and none do — then `installation_id` being logically distinct from `machine_id` buys nothing, because both copy cleanly.

**Why the existing design fails:** The schema is correctly *shaped* to support strong machine binding (separate identity fields, a key reference, a generation counter) but the one component that would make copying detectable — what the key reference actually points to and why it can't be copied — is never specified. A well-designed empty slot is still an empty slot.

**Security consequence:** Same as the first-pass finding: the cheapest real attack (copy the install directory) has no defined defense, and it's on the critical path for every other control in this architecture.

**Recommended fix:** See Reconstruction §2. Two-layer identity: a locally-generated composite descriptor (advisory) plus a Backend-issued identifier created only at registration, with duplication detection living at the Backend as a behavioral/anomaly decision, not a local cryptographic guarantee.

**Architectural impact:** High. **Implementation impact:** High — first-login-flow critical path. **Documents affected:** `local_security_storage_architecture.md`, `Local_Security_Storage_Schem_Persistence_Model.md`, `security_authority_backend_trust_model.md`.

---

### HR-02 — Local IPC authentication: the threat is named repeatedly, the mechanism is named zero times

**Affected component:** Frontend/Local API boundary (`Security_Authority_API_Interface_Contract.md` §5, §30–32; `Security_Architecture_Threat_Model_State_Model.md`)

**Existing design:** The API Contract document is unusually precise about *what* must never happen — §31–32 give a worked example showing the API Server must call `SecurityAuthority.authorize(RUN_AUTOMATION)` rather than letting the Frontend assert its own state, and explicitly lists `user_id, license_id, machine_id, authorization, role, subscription_level, session_state` as fields the Security Authority must never trust merely because a caller supplied them. This is excellent, specific guidance for the *authorization* half of the problem.

**Attack or failure scenario:** None of the 18 documents specify how the Control Plane API Server establishes, in the first place, that it's even talking to the real Frontend process rather than an arbitrary local process pretending to be one. §5's trust-domain table lists "Frontend: Untrusted, never direct authority" and "Local process: Untrusted, no implicit access" as if they're already distinguished from each other — but nothing defines the mechanism that tells them apart. If the local API is a bare loopback listener, "no implicit access" is aspirational, not enforced.

**Why the existing design fails:** The documents solved "don't trust what the caller says" (§31–32) without solving "know who the caller is" (nowhere). Those are different problems and only one is addressed.

**Security consequence:** Unchanged from first pass — a malicious local process can present itself as the Frontend and inherit whatever the Frontend is allowed to request, undermining the trust-domain table's own stated distinctions.

**Recommended fix:** See Reconstruction §3 — OS-native peer verification (socket peer credentials / named-pipe process inspection) plus a spawn-time single-use token, unchanged from the first pass's recommendation.

**Architectural impact:** Medium. **Implementation impact:** Medium-high, platform-specific. **Documents affected:** `Security_Authority_API_Interface_Contract.md`.

---

### HR-03 (corrected from first pass) — Runtime Manager's *authority boundary*, not its existence, is underspecified

**Affected component:** Runtime Manager / Execution Plane Authorization (`security_authority_execution_plane_authorization_contract.md`; `Security_Authority_API_Interface_Contract.md` §23–25)

**Existing design:** As established in §0 above, the Runtime Manager consistently sits outside the Security Authority, downstream of it, upstream of the Execution Plane, across every document that diagrams it. §23–24 of the API Contract document describe `authorizeExecution()` returning an opaque `ExecutionAuthorization` artifact (`authorization_id, scope, security_epoch, issued_at, expires_at, constraints, integrity_proof`), and state plainly that "the Runtime Manager must not translate user authentication directly into execution permission" and "the Security Authority itself does not know how the Execution Plane stops or recovers browsers." This is a correctly drawn boundary.

**Attack or failure scenario:** What's missing is narrower than the first pass claimed: none of the documents state whether the Runtime Manager is *permitted to hold onto* an `ExecutionAuthorization` artifact and keep acting on it after the Security Authority's own state has moved on (revocation, tamper detection, session expiry), versus being required to receive an explicit revoke and only then stop. §25 says the Security Authority "must invalidate execution authorization" and "the Runtime Manager receives the resulting decision" — this describes the happy path (SA successfully pushes a revoke) but never states what the Runtime Manager's default behavior is if it *stops hearing from* the Security Authority (crash, IPC failure, SA process restart) while still holding a live-looking, not-yet-expired artifact.

**Why the existing design fails:** "Push, not poll" is implied by the examples but never stated as a rule, and there's no stated fallback for "the pusher went silent." A Runtime Manager that reasonably (and defensibly, by these documents alone) decides "no revoke received, and my artifact hasn't hit its own `expires_at` yet, so keep going" is not violating anything written down — because nothing was written down about that specific case.

**Security consequence:** Medium, not critical (downgraded from the first pass's CRITICAL, since the core architecture is sound) — but it's exactly the kind of ambiguity that produces a real bug: Execution Plane continuing to run for the full remaining `expires_at` window of a stale artifact after a Security-Authority-side crash, rather than failing closed on loss of the control channel.

**Recommended fix:** State explicitly (Reconstruction §4): the Runtime Manager treats loss of its event channel to the Security Authority as equivalent to a revoke for any operation not already safely completable, not as "authorization continues until the artifact's own expiry."

**Architectural impact:** Low (clarifying existing design, not redesigning it). **Implementation impact:** Low. **Documents affected:** `security_authority_execution_plane_authorization_contract.md`.

---

## HIGH

### HR-04 — Offline-grace budget: same restart-reset vulnerability as the first pass, now confirmed against the actual state names

**Affected component:** Offline/Degraded Mode (`temper_response_security_degredation_architecture.md` — states include `OFFLINE_GRACE`, `REAUTHENTICATION_REQUIRED`; `Local_Security_Storage_Schem_Persistence_Model.md` §43, §62–63)

**Existing design:** §62 of the storage-schema document explicitly recommends monotonic time for "timeouts, retry delays, session-renewal timers, heartbeat intervals" and wall-clock for absolute expiry — correct general guidance. §69 of the storage-architecture document shows an `OFFLINE_GRACE` decision gated on "within permitted grace period?" §63 separately requires re-evaluating security state, expiration, and connectivity after sleep/wake, rather than blindly continuing previous timers.

**Attack or failure scenario:** Unchanged from the first pass: nothing in either document requires the offline-grace *accumulator itself* to be a value that survives process restart in a form that can't simply be reset by killing and relaunching the app. §63's sleep/wake handling re-evaluates state but doesn't describe re-deriving the grace budget from a persisted, checkpointed total — it describes re-evaluating *whether currently cached state is still within its stated bounds*, which begs the question of what those bounds are anchored to.

**Recommended fix:** Unchanged from first pass §6 — persist and periodically checkpoint the accumulated offline duration itself (not just the state derived from it), and treat a wallclock/accumulated-duration mismatch on startup as an anomaly rather than benign.

**Architectural impact:** Medium. **Implementation impact:** Medium. **Documents affected:** `temper_response_security_degredation_architecture.md`, `Local_Security_Storage_Schem_Persistence_Model.md`.

---

### HR-05 — Key storage tiering: the documents *assume* OS-backed storage more strongly than the first pass credited, but never define the degraded case's effect on policy

**Affected component:** Cryptographic Architecture / Key Management (`security_authority_key_management.md`; `local_security_storage_architecture.md` §7–9)

**Existing design:** §7 of the storage-architecture document is explicit: "the filesystem stores ciphertext; the operating system protects the key required to use the ciphertext," with OS-backed storage preferred "where available." The key-management document defines a full key lifecycle (`GENERATED → ACTIVE → ROTATION_PENDING → ROTATED → RETIRED → DESTROYED`) that is genuinely detailed and correct.

**Attack or failure scenario:** As in the first pass — "where available" implies a fallback path exists, but no document defines what the fallback protection level actually is, or connects it to any downstream policy decision (session lifetime, offline-grace budget, revalidation frequency). The key lifecycle table treats all keys uniformly regardless of which storage tier protects them.

**Recommended fix:** Unchanged from first pass §7 — an explicit `key_storage_tier` field surfaced to policy, not just to implementation.

**Architectural impact:** Medium. **Implementation impact:** Medium. **Documents affected:** `security_authority_key_management.md`.

---

### HR-06 — Offline authorization: the documents actually *do* state the reconciling rule, just not where the API contract needs it

**Affected component:** Authorization Cache vs. Offline Operation

**Existing design:** `Local_Security_Storage_Schem_Persistence_Model.md` §44 states the rule almost verbatim to how the first-pass reconstruction proposed it: "Backend unavailable → Determine existing authorization state → Apply offline policy" — explicitly rejecting both "assume authorized" and "assume unauthorized" as bad defaults. §22 of the same document states "Authorization is a cache... not an independent authorization authority." Read together, these two sections are **not contradictory** — they were written by the same document and agree with each other.

**Attack or failure scenario (narrower than first pass HR-06):** The rule exists, but it exists in the storage-schema document, and the API Interface Contract document — which is what an implementer actually codes against for the offline path (§37, "Offline Operation") — restates only the negative rule ("never `if backendOffline: allowEverything()`") without repeating or cross-referencing the storage document's positive rule (apply existing-authorization-state + offline policy). An implementer working strictly from the API contract, which is the document explicitly designed to be the "stable contract" other subsystems code against (§3.5), doesn't get the actual decision procedure — only the prohibition.

**Why this still matters even though the underlying design is correct:** A document set can have the right answer stated once and still fail in practice if the document that's supposed to be authoritative for implementers doesn't carry it. This is a documentation/traceability failure more than a design failure, but its consequence — an implementer inventing their own version of the missing rule — is identical to the first pass's finding.

**Recommended fix:** The canonical specification (Phase 3) states the per-capability offline policy table once, in the Authorization section, and the API contract section explicitly cites it rather than restating only the negative rule.

**Architectural impact:** Low (this is a synthesis/documentation fix, not a redesign — downgraded from the first pass, which treated it as a live contradiction). **Documents affected:** `Security_Authority_API_Interface_Contract.md`, `Local_Security_Storage_Schem_Persistence_Model.md`.

---

### HR-07 — Concurrent Control Plane processes: three separate documents propose three different arbitration primitives, none reconciled

**Affected component:** Concurrency / Multi-Process Behavior

**Existing design:** `local_security_storage_architecture.md` §52–54 proposes a generic "security storage lock," explicitly warning against blind stale-lock deletion and recommending "a robust OS-specific mechanism ... preferable to a naive lock file." `Local_Security_Storage_Schem_Persistence_Model.md` §55–56 separately lists "single-instance lock, OS mutex, lock file, IPC ownership, process identity validation" as a menu of *options* without picking one, and separately notes that database-level locking (SQLite) does not solve process-level arbitration. Neither document states which of these is authoritative, or how a second instance discovers the first and hands off (vs. simply exits).

**Attack or failure scenario:** Same as first pass — an attacker-launched second process racing the legitimate instance has an underspecified arbitration surface to attack, and because the *options* are listed rather than *the* mechanism being specified, different components of the eventual implementation could plausibly pick different ones.

**Recommended fix:** Unchanged from first pass §8 — pick one (OS-level exclusive lock/mutex, not a bare lock file), state it once, in one document.

**Architectural impact:** Low. **Implementation impact:** Low. **Documents affected:** `local_security_storage_architecture.md`, `Local_Security_Storage_Schem_Persistence_Model.md`.

---

### HR-08 — Tamper-response pipeline is honest about its own limits in the threat model, but the *state machine* documents don't carry that honesty into the mechanism they define

**Affected component:** Tamper Detection & Response (`tamper_detection_and_application_integrity_architecture.md`; `Security_Authority_Tamper-Aware_State_Machine_Transition_Model.md`)

**Existing design:** The tamper-detection document is explicit and correct about the endpoint-trust limitation in its prose sections. The Tamper-Aware State Machine document defines a genuinely rich state set (`INTEGRITY_UNKNOWN → INTEGRITY_VERIFIED / INTEGRITY_SUSPECTED / INTEGRITY_FAILED`, plus `CLONE_SUSPECTED`, `IPC_UNTRUSTED`, `CONFIG_TAMPERED`, `STATE_ROLLBACK`, `TAMPERED`, `COMPROMISED`) that reads, by its structure, as a mechanism that reliably catches what it's designed to catch.

**Attack or failure scenario:** Unchanged in substance from the first pass — a state machine with this many named, specific states for tamper conditions reads as more complete/confident than the threat model it's built on justifies, and the state-machine document itself doesn't repeat the "detection is not prevention, and the detector's own code path is equally patchable" caveat anywhere near the actual transition table.

**Recommended fix:** Unchanged from first pass — the non-guarantee callout belongs directly adjacent to the transition table, not only in a separate threat-model document an implementer might not have open while coding the state machine.

**Architectural impact:** Low (wording). **Documents affected:** `Security_Authority_Tamper-Aware_State_Machine_Transition_Model.md`.

---

## MEDIUM

### HR-09 — Five different "generation" counters exist and their relative authority is never stated

**Affected component:** Freshness / Rollback Protection (`Local_Security_Storage_Schem_Persistence_Model.md` §26–27, §40)

**Existing design:** The `SecurityState` record defines `session_generation`, `authorization_revision`, `license_revision`, and `machine_generation` as *separate* counters, plus a `server_trust_version`. This is actually good design — it's more granular than the first pass's flattened single "epoch" and lets a license change advance independently of a session renewal, which is correct (a session can renew without the license changing, and vice versa).

**Attack or failure scenario:** No document states what happens when these counters disagree in a way that shouldn't be possible — e.g., `authorization_revision` advances but `license_revision` doesn't, when the authorization change was supposed to be a direct consequence of a license change. Without a stated consistency rule between the counters, a partial write (one counter persisted, a related one not, due to a crash mid-transaction) could produce a combination no document classifies as either "valid" or "corrupted" — it just falls into a gap.

**Recommended fix:** The canonical specification defines which counters are causally linked (license_revision change *must* be accompanied by an authorization_revision change in the same transaction) and treats any observed combination outside the defined causal graph as `SECURITY_STATE_UNCERTAIN` (a status this exact document set already defines, in the API contract, for precisely this kind of situation) rather than leaving it unclassified.

**Architectural impact:** Low. **Documents affected:** `Local_Security_Storage_Schem_Persistence_Model.md`, `Security_Authority_API_Interface_Contract.md`.

---

### HR-10 — `SECURITY_STATE_UNCERTAIN` is defined but never wired into the actual transition table as a reachable state

**Affected component:** State Machine (`security_authority_state_machin_teansition_table.md`; `Security_Authority_API_Interface_Contract.md` §8)

**Existing design:** The API contract document defines `SECURITY_STATE_UNCERTAIN` clearly: "the Security Authority cannot safely determine the current security state... particularly important after interrupted security transitions." This is exactly the right status for the crash/partial-write scenarios extensively discussed elsewhere in the document set.

**Attack or failure scenario:** The dedicated state-machine-transition-table document's harvested state vocabulary does not include `SECURITY_STATE_UNCERTAIN` among its states — it has `UNKNOWN`, `INVALID`, `CORRUPTED`, `STALE`, `LOCAL_INVALID`, `LOCAL_VALID` instead. Either `SECURITY_STATE_UNCERTAIN` is meant to be a synonym for one of these (unstated) or it's a status the API layer can return that the underlying state machine has no corresponding internal state for, which would mean the API is capable of reporting a condition the state machine can't actually represent.

**Recommended fix:** The canonical specification's state machine (Phase 3) includes `SECURITY_STATE_UNCERTAIN` (or its explicit mapping to an existing internal state) as a first-class, reachable state, entered specifically by interrupted/partial transitions, per HR-09's crash-mid-transaction scenario.

**Architectural impact:** Low. **Documents affected:** `security_authority_state_machin_teansition_table.md`, `Security_Authority_API_Interface_Contract.md`.

---

### HR-11 — `DISABLE_SECURITY` and `SKIP_LICENSE_CHECK` appear as literal identifiers in the tamper-detection document with no surrounding context in the harvested material — must be confirmed as a forbidden-list, not an actual code path

**Affected component:** Tamper Detection / Configuration (`tamper_detection_and_application_integrity_architecture.md`)

**Existing design/observation:** These two identifiers appear in the document (most plausibly as members of a "configuration values that must never be settable" or "flags an attacker might try to set" list, consistent with `local_security_storage_architecture.md` §50's example of a hostile `config.json` containing `license_check = false`). This finding exists to flag the item for explicit verification during Phase 3 synthesis rather than to assert a flaw — the surrounding prose needs to be re-confirmed to read as "never allow this" rather than "here is how to invoke this," and the canonical specification should state explicitly, wherever these terms are carried forward, that they describe forbidden/adversarial configuration states, not legitimate operational modes.

**Recommended fix:** Phase 3 states unambiguously that no build, environment variable, config flag, or debug mode may set security enforcement to a disabled or bypassed state in a production build; any equivalent capability that exists for development/testing must be compiled out of release builds, not merely gated by a runtime flag (a runtime flag is exactly the kind of local state an attacker can flip, per the entire threat model).

**Architectural impact:** Low, informational pending confirmation. **Documents affected:** `tamper_detection_and_application_integrity_architecture.md`.

---

### HR-12 — Capability naming is inconsistent across two documents that both claim to define the canonical capability set

**Affected component:** Capability Model (`Security_Authority_API_Interface_Contract.md` §15; `Security_Authority_Comprehensive_Edge-Case___Behavioral_Specification.md`)

**Existing design:** The API Contract document's capability list is `RUN_AUTOMATION, START_EXECUTION, STOP_EXECUTION, UPLOAD_FILE, DOWNLOAD_FILE, MODIFY_CONFIGURATION, INSTALL_UPDATE`. The Edge-Case Behavioral Specification document's harvested vocabulary instead shows `CAPABILITY_BROWSER_ALLOCATION, CAPABILITY_CONFIGURATION, CAPABILITY_EXECUTION, CAPABILITY_FILE_DOWNLOAD, CAPABILITY_FILE_UPLOAD`, and the protocol-specification-continuation document shows a third naming scheme again: `CAP_AUTOMATION_START, CAP_BROWSER_ALLOCATE, CAP_FILE_DOWNLOAD, CAP_FILE_UPLOAD`.

**Attack or failure scenario:** Not directly exploitable, but three different naming conventions for what should be one canonical enum (`RUN_AUTOMATION` vs. `CAPABILITY_EXECUTION` vs. `CAP_AUTOMATION_START`; `UPLOAD_FILE` vs. `CAPABILITY_FILE_UPLOAD` vs. `CAP_FILE_UPLOAD`) is exactly the kind of drift that produces an integration bug: whichever team implements the Runtime Manager's authorization check against the Execution Plane's expectations will have to guess which of the three spellings is canonical, and a mismatch there could silently produce a capability check that always fails (safe but broken) or, worse, one that's checked against the wrong string and always passes.

**Recommended fix:** Phase 3 picks one naming convention (`CAP_<DOMAIN>_<ACTION>` is the most systematic of the three) and states it as the single canonical capability enum, with the other two spellings noted as superseded.

**Architectural impact:** Low. **Documents affected:** `Security_Authority_API_Interface_Contract.md`, `Security_Authority_Comprehensive_Edge-Case___Behavioral_Specification.md`, `security_authority_protocol_specification_cont.md`.

---

### HR-13 — Session state and Security-State-Record state overlap without a stated relationship

**Affected component:** Session Architecture

**Existing design:** `Local_Security_Storage_Schem_Persistence_Model.md` §20 defines session status values `NO_SESSION, AUTHENTICATING, AUTHENTICATED, RENEWING, DEGRADED, EXPIRED, REVOKED, LOGGING_OUT, LOGGED_OUT, INVALID`. Separately, the overall security-state machine documents define a broader state set covering the whole security posture (authentication + license + machine + integrity together), including states like `OPERATIONAL`, `DEGRADED`, `REVOKED` that overlap in name with the session-specific states but describe a different, larger scope.

**Attack or failure scenario:** Not directly exploitable, but the overlap in naming (`DEGRADED` and `REVOKED` exist at both the session level and the whole-security-state level) without a stated containment relationship (is whole-system `DEGRADED` *caused by* session `DEGRADED`, or independent of it?) is a real source of implementation ambiguity — particularly for the invariant "impossible state combinations must not be representable" that §20 itself calls for (its own example: `status = EXPIRED, expires_at = future` is explicitly flagged as invalid).

**Recommended fix:** Phase 3 makes session state a strict sub-component feeding into, not overlapping with, overall security state — i.e., session `DEGRADED` is one *input* the Security Decision Engine (§13 of the Internal Design document) considers, not a state with the same name and independent meaning at two levels.

**Architectural impact:** Low. **Documents affected:** `Local_Security_Storage_Schem_Persistence_Model.md`, `security_authority_state_machin_teansition_table.md`.

---

## LOW

### HR-14 — No document specifies backend-side circuit-breaking for anomalous mass-revocation (unchanged from first pass, confirmed still absent after full read)

Carried forward unchanged. This remains a genuine, if operational rather than architectural, gap. See Reconstruction.

### HR-15 — "Never log" list exists but isn't centrally enforced

`local_security_storage_architecture.md` §76 gives a concrete list (`password, private key, session secret, refresh credential, storage encryption key, machine private key`) and the API Contract document's §50 gives a near-identical, independently-written list. Two independently-authored lists that happen to agree is good evidence the underlying judgment is sound, but neither document says the enforcement point is a shared logging sink rather than per-call-site discipline — carried forward from first pass with this additional confirming detail.

### HR-16 — Secure reset / uninstall backend-side effects unspecified

`local_security_storage_architecture.md` §58–59 defines what happens to *local* state at uninstall/reinstall in useful detail (a deterministic recover-or-re-register decision tree) but doesn't address whether uninstall should attempt best-effort backend-side session/machine invalidation. Carried forward from first pass.

### HR-17 — No protocol deprecation timeline policy

Confirmed still absent after full read of both protocol-specification documents. Carried forward from first pass, unchanged.

### HR-18 — `installation_id` vs `machine_id` distinction is well-designed but never referenced again outside the schema document

`Local_Security_Storage_Schem_Persistence_Model.md` §8.2 introduces this distinction carefully and correctly, but no other document (including the ones specifically about machine identity, cloning, and Backend trust) refers back to `installation_id` as a field they check. If the distinction isn't actually load-bearing anywhere else in the protocol, it risks becoming dead schema — worth confirming during implementation that the Backend registration flow and the clone-detection logic both actually consume `installation_id`, not just `machine_id`.

---

## INFORMATIONAL

### HR-19 — TOCTOU is explicitly named in three separate documents (protocol spec, edge-case inventory, tamper-detection) but never given one canonical mitigation pattern

Good that it's named consistently; worth consolidating into one stated pattern (e.g., "authorize and act inside the same atomic transaction/lock scope, never authorize-then-later-act") in the canonical specification rather than leaving three separate mentions.

### HR-20 — The Tamper-Aware State Machine document contains a single composite state name, `AUTHENTICATED_LICENSE_VALID_MACHINE_BOUND_SESSION_ACTIVE`, that doesn't appear as a distinct concept anywhere else

This reads as either a fully-qualified description of the `OPERATIONAL` state used elsewhere (most likely, given the name literally spells out OPERATIONAL's preconditions) or an actual, separate, more granular state. Phase 3 should treat it as the former and use it as documentation of what `OPERATIONAL` requires, not as a 25th state name to preserve verbatim.

### HR-21 — Glossary need confirmed, now with more evidence than the first pass had

Given HR-12 (three capability namings) and HR-09/13 (multiple overlapping "generation"/"state" vocabularies), the case for a single canonical glossary in Phase 3 is stronger than the first pass's more general observation.

### HR-22 — Cross-cutting concerns (logging, config, time) still have no defined shared home

Confirmed unchanged after full read — `security_authority/` folder listings across documents (e.g., Internal Design §3) never include a shared platform/infrastructure layer; each subsystem is implicitly expected to handle its own logging and clock access.

### HR-23 — The documents are honest, in prose, about Rust/native components not being a security boundary by themselves (`local_security_storage_architecture.md` §74, explicitly) — this is worth calling out as something *correct* that must survive into Phase 3 unweakened, not a finding requiring a fix.

### HR-24 — Architectural style guidance ("System → Subsystem → Internal components," black-box boundaries) is followed unusually consistently across all 18 documents — worth noting as a strength, not a flaw, since it makes the eventual canonical specification's structure straightforward rather than requiring invention.

---

## Summary Table

| ID | Severity | Component | One-line issue |
|----|----------|-----------|-----------------|
| HR-01 | CRITICAL | Machine Identity | Schema is shaped for strong binding; the binding mechanism itself is still never defined |
| HR-02 | CRITICAL | Local IPC | Untrusted-caller handling is precise; caller *identification* is undefined |
| HR-03 | CRITICAL→MEDIUM (corrected) | Runtime Manager | Boundary is correctly drawn across docs; behavior on lost control-channel is the real gap |
| HR-04 | HIGH | Offline grace | Restart-resettable accumulator, confirmed against actual state names |
| HR-05 | HIGH | Key storage | "Where available" fallback has no policy linkage |
| HR-06 | HIGH→LOW (corrected) | Offline authorization | Correct rule exists in one doc, not carried into the API contract implementers actually use |
| HR-07 | HIGH | Concurrency | Three unreconciled arbitration mechanisms proposed, none chosen |
| HR-08 | HIGH | Tamper response | Rich state machine reads more confident than its own threat model |
| HR-09 | MEDIUM | Generations | Five separate counters, no stated consistency rule between them |
| HR-10 | MEDIUM | State machine | `SECURITY_STATE_UNCERTAIN` defined in API layer, absent from state machine's own vocabulary |
| HR-11 | MEDIUM | Config | `DISABLE_SECURITY`/`SKIP_LICENSE_CHECK` need explicit "forbidden, not a feature" framing |
| HR-12 | MEDIUM | Capability naming | Three different spellings of the same capability enum across 3 documents |
| HR-13 | MEDIUM | Session vs. security state | Same state names (`DEGRADED`, `REVOKED`) reused at two scopes with no stated containment |
| HR-14 | LOW | Backend authority | No mass-revocation circuit breaker (unchanged) |
| HR-15 | LOW | Observability | Never-log list exists twice, independently, not centrally enforced |
| HR-16 | LOW | Secure reset | Backend-side effect of uninstall unspecified |
| HR-17 | LOW | Versioning | No protocol deprecation policy |
| HR-18 | LOW | Schema | `installation_id` may be dead schema outside one document |
| HR-19 | INFO | TOCTOU | Named 3x, no single consolidated mitigation pattern |
| HR-20 | INFO | Terminology | One composite state name likely just documents `OPERATIONAL`'s preconditions |
| HR-21 | INFO | Glossary | Stronger case than first pass, same recommendation |
| HR-22 | INFO | Architecture style | Cross-cutting concerns still homeless |
| HR-23 | INFO | Strength | Rust-is-not-a-security-boundary honesty must be preserved, not weakened |
| HR-24 | INFO | Strength | Subsystem/black-box style is unusually consistent across all 18 source documents |

**Next:** `02-architectural-reconstruction.md` resolves each finding above into a concrete design decision; `03-security-authority-canonical-specification.md` is the resulting authoritative document.

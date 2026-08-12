**Tampering detection is not the same thing as tamper prevention.**

You cannot realistically prevent someone with full local control from modifying a client application. What you can do is make unauthorized modification **detectable, difficult to bypass, and unable to produce a valid authorized state without obtaining legitimate authorization from the backend.**

I would therefore update the document substantially rather than merely adding one `TAMPERED` state.

# Security Authority — Tamper-Aware State Machine & Transition Model

## 1. Purpose

The Security Authority is the security-critical subsystem of the Control Plane responsible for establishing and maintaining the application's **trusted operational state**.

It determines whether the Control Plane is currently permitted to:

- authenticate a user;
- establish a security session;
- obtain authorization;
- activate a license;
- communicate with the Execution Plane;
- perform privileged operations;
- continue operating after network interruption;
- recover after process restart;
- renew security state;
- react to revocation;
- enter degraded/offline operation.

The Security Authority does **not** assume that the local machine is trusted.

The local environment must be treated as potentially hostile.

This includes:

- modified binaries;
- modified configuration;
- modified local database;
- modified security metadata;
- modified timestamps;
- modified IPC messages;
- injected local processes;
- patched validation logic;
- replayed security messages;
- copied installations;
- cloned virtual machines;
- restored filesystem snapshots;
- rolled-back application state;
- manipulated runtime state.

The Security Authority therefore operates under the following fundamental assumption:

> **Anything controlled exclusively by the local machine can potentially be modified by the adversary.**

---

# 2. Security Authority Trust Model

The Security Authority should conceptually separate the system into three trust domains.

```text
                 BACKEND
                    │
             Remote Trust Anchor
                    │
                    ▼
        ┌─────────────────────────┐
        │    SECURITY AUTHORITY   │
        │                         │
        │ Authentication          │
        │ Authorization           │
        │ Licensing               │
        │ Session                 │
        │ Machine Identity        │
        │ Integrity State         │
        │ Security State Machine  │
        └────────────┬────────────┘
                     │
              Authorized IPC
                     │
                     ▼
              EXECUTION PLANE
```

The Frontend is **not** a trust authority.

The local filesystem is **not** a trust authority.

The local database is **not** a trust authority.

The Control Plane itself cannot independently establish permanent authorization.

The Backend ultimately remains the authority for:

- account identity;
- license entitlement;
- revocation;
- server-side authorization;
- machine registration;
- security policy.

The local Security Authority maintains the **runtime security state derived from that authority**.

---

# 3. Core Security Invariant

The most important invariant is:

> **No locally stored value is sufficient by itself to establish permanent authorization.**

For example:

```text
license = VALID
```

is not enough.

Neither is:

```text
session = ACTIVE
```

nor:

```text
authenticated = true
```

nor:

```text
machine_registered = true
```

nor:

```text
license_expiry = future timestamp
```

The Security Authority should instead derive operational permission from a combination of:

```text
Authenticated Identity
        +
Machine Identity
        +
Valid Security Session
        +
Valid Authorization
        +
Valid License
        +
Security Integrity State
        +
Freshness / Validity Constraints
        +
Protocol Validity
```

Conceptually:

```text
Operational Authorization
=
Identity
AND Session
AND Machine Binding
AND License
AND Authorization
AND Integrity
AND Freshness
AND Protocol Validity
```

If a required condition becomes invalid, operational authorization must be reconsidered.

---

# 4. Tampering Is a First-Class Security Condition

Tampering should not simply produce:

```text
ERROR
```

Instead, tampering should cause the Security Authority to transition into an explicit security condition.

For example:

```text
INTEGRITY_SUSPECTED
```

or, where confidence is sufficiently high:

```text
COMPROMISED
```

The distinction is important.

A failed integrity check does not always prove malicious modification.

For example:

- corrupted disk;
- interrupted update;
- incomplete installation;
- filesystem failure;
- unexpected rollback.

Therefore the system should distinguish between:

```text
INTEGRITY_UNKNOWN
```

```text
INTEGRITY_SUSPECTED
```

```text
INTEGRITY_VERIFIED
```

and potentially:

```text
COMPROMISED
```

---

# 5. Security Authority State Model

A comprehensive state model can be represented as:

```text
                    ┌──────────────┐
                    │ UNINITIALIZED│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ INITIALIZING │
                    └──────┬───────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
                 ▼                   ▼
          INTEGRITY_FAILED     INTEGRITY_SUSPECTED
                 │                   │
                 └─────────┬─────────┘
                           ▼
                         BLOCKED


                    INITIALIZING
                         │
                         ▼
                 INTEGRITY_VERIFIED
                         │
                         ▼
                    UNAUTHENTICATED
                         │
                         ▼
                    AUTHENTICATING
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
       AUTH_FAILED             AUTHENTICATED
                                     │
                                     ▼
                              AUTHORIZING
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                        ▼                         ▼
                  AUTHZ_FAILED              AUTHORIZED
                                                  │
                                                  ▼
                                           LICENSE_CHECK
                                                  │
                                  ┌───────────────┴──────────────┐
                                  │                              │
                                  ▼                              ▼
                            LICENSE_INVALID                LICENSE_VALID
                                                                  │
                                                                  ▼
                                                            SESSION_ACTIVE
                                                                  │
                                                                  ▼
                                                         OPERATIONAL
```

With additional transitions:

```text
OPERATIONAL
    │
    ├── session expiry ───────────────► SESSION_EXPIRED
    ├── license expiry ───────────────► LICENSE_EXPIRED
    ├── backend revocation ───────────► REVOKED
    ├── integrity failure ────────────► INTEGRITY_SUSPECTED
    ├── confirmed tampering ──────────► COMPROMISED
    ├── protocol failure ─────────────► SECURITY_DEGRADED
    ├── backend unavailable ──────────► OFFLINE_GRACE
    └── logout ───────────────────────► LOGGED_OUT
```

---

# 6. Important Distinction: Operational State vs Security State

I would **not** make the entire Security Authority one enormous state machine.

That becomes difficult to reason about.

Instead, conceptually maintain independent security dimensions.

### Identity

```text
UNKNOWN
AUTHENTICATED
REVOKED
```

### Session

```text
NONE
ESTABLISHING
ACTIVE
RENEWING
EXPIRED
INVALID
```

### Authorization

```text
UNKNOWN
AUTHORIZED
DENIED
STALE
REVOKED
```

### License

```text
UNKNOWN
VALID
EXPIRING
EXPIRED
REVOKED
DOWNGRADED
```

### Machine

```text
UNKNOWN
REGISTERED
BOUND
INVALID
REPLACED
CLONED_SUSPECTED
```

### Integrity

```text
UNKNOWN
CHECKING
VERIFIED
SUSPECTED
FAILED
COMPROMISED
```

### Connectivity

```text
ONLINE
DEGRADED
OFFLINE
```

Then operational permission becomes a derived state.

For example:

```text
Operational =
    Identity == AUTHENTICATED
    AND Session == ACTIVE
    AND Authorization == AUTHORIZED
    AND License == VALID
    AND Machine == BOUND
    AND Integrity == VERIFIED
    AND Protocol == COMPATIBLE
```

This is considerably cleaner than creating hundreds of combined states such as:

```text
AUTHENTICATED_LICENSE_VALID_MACHINE_BOUND_SESSION_ACTIVE...
```

---

# 7. Tampering State Model

The integrity subsystem should have its own state machine.

```text
                    UNKNOWN
                       │
                       ▼
                   CHECKING
                       │
              ┌────────┴────────┐
              │                 │
              ▼                 ▼
           VERIFIED          FAILED
              │                 │
              │                 ▼
              │             SUSPECTED
              │                 │
              │          ┌──────┴──────┐
              │          │             │
              │          ▼             ▼
              │      RECOVERABLE    COMPROMISED
              │          │
              │          ▼
              │       RECHECK
              │          │
              └──────────┘
```

---

# 8. What Should Be Integrity Checked?

The Security Authority should not blindly hash every file on every startup.

Instead, integrity protection should be designed around **security-critical assets**.

Potential categories include:

### Executable code

- Control Plane executable;
- native security modules;
- security-critical libraries;
- Rust modules;
- cryptographic modules.

### Security configuration

- security policy;
- protocol configuration;
- backend endpoint configuration;
- trusted certificate configuration;
- machine-binding metadata.

### Security metadata

- machine identity;
- installation identity;
- security state;
- encrypted credential metadata;
- license metadata.

### Update metadata

- installed version;
- update manifest;
- component versions;
- signed package metadata.

---

# 9. Integrity Manifest

A signed integrity manifest can conceptually contain:

```text
component
version
hash
size
signature
generation
```

For example:

```text
SecurityAuthority
    version: 1.4.2
    SHA256: ...
    signature: ...

RuntimeManager
    version: 1.4.2
    SHA256: ...
    signature: ...

NativeSecurityModule
    version: 1.4.2
    SHA256: ...
    signature: ...
```

The important point is that **the expected hash itself must not be trusted merely because it exists locally**.

Otherwise an attacker can simply change:

```text
expected_hash
```

to match the modified executable.

The trust anchor for integrity verification must ultimately come from something the attacker cannot trivially rewrite alongside the target.

---

# 10. Local Tampering Categories

The Security Authority should explicitly account for different forms of tampering.

## 10.1 Binary Modification

Example:

```text
security_authority.exe
```

is patched so:

```text
if (!licenseValid)
    deny();
```

becomes:

```text
if (!licenseValid)
    allow();
```

Expected response:

```text
Integrity verification
        ↓
Mismatch
        ↓
INTEGRITY_SUSPECTED
        ↓
Block privileged operation
        ↓
Attempt trusted verification/recovery
```

---

# 11. Configuration Tampering

Example:

```text
backend_url = attacker-server
```

or:

```text
offline_grace_period = 999999999
```

or:

```text
license_required = false
```

Configuration must therefore be classified.

Not all configuration is equally sensitive.

For example:

```text
theme = dark
```

doesn't need strong integrity protection.

But:

```text
license_policy
security_policy
backend_identity
```

does.

---

# 12. Local Database Tampering

Suppose SQLite contains:

```text
license_status = VALID
license_expiry = 2099
```

An attacker modifies it.

The Security Authority must **never interpret this as authoritative authorization**.

The database is merely local state/cache.

Therefore:

```text
SQLite says VALID
```

does not imply:

```text
Authorization = VALID
```

The state must be validated against the security protocol and backend authority.

---

# 13. Security-State Tampering

An attacker modifies:

```text
session_state = ACTIVE
```

or:

```text
authorization_state = AUTHORIZED
```

The application must not simply trust the serialized state.

State should be protected using appropriate integrity mechanisms and, more importantly, **the ability to produce a locally valid state should not be sufficient to obtain backend authorization**.

---

# 14. Clock Tampering

The attacker changes:

```text
2026-08-12
```

to:

```text
2036-08-12
```

or rolls the clock backward.

The Security Authority should therefore avoid relying exclusively on wall-clock time.

It should reason using:

```text
server-issued timestamps
monotonic elapsed time
session lifetime
observed time progression
```

A suspicious clock transition should produce:

```text
CLOCK_ANOMALY
```

rather than immediately trusting the new time.

---

# 15. Snapshot Rollback

Consider:

```text
T0
  valid session
  valid license

T1
  session renewed
  security state updated

T2
  attacker restores filesystem snapshot from T0
```

Now the local machine appears to have an older valid state.

This is why security state should contain freshness/version information that cannot simply be rolled back locally without detection.

For example:

```text
security_state_generation
session_generation
machine_registration_generation
```

The Backend can maintain authoritative versions.

---

# 16. Installation Cloning

Attacker:

```text
Machine A
    │
    └── copy entire application directory
             │
             ▼
        Machine B
```

The application must not assume:

```text
copied files = same machine
```

Machine identity must therefore be treated independently from application files.

A copied installation should require appropriate revalidation.

---

# 17. VM / Image Cloning

Similarly:

```text
VM Snapshot A
       │
       ├── VM B
       └── VM C
```

can create multiple environments apparently possessing the same local security state.

The backend should therefore be capable of detecting conflicting machine identities or registrations.

---

# 18. Tampering With IPC

The Frontend is local.

Therefore:

```text
Frontend
    ↓
localhost
    ↓
Control Plane
```

does **not** automatically mean trusted.

Another local process may attempt:

```text
POST /runtime/start
```

or:

```text
POST /license/activate
```

or:

```text
IPC message:
authorization = true
```

The Control Plane must authenticate and authorize privileged IPC clients.

---

# 19. Malicious Frontend

The Frontend should be treated as a client of the Control Plane.

Even though it is shipped with the application, the Control Plane should not assume:

```text
Frontend = trusted
```

The Frontend can request:

```text
start runtime
upload file
change configuration
logout
```

But the Security Authority determines whether the request is permitted.

---

# 20. Patched Security Authority

This is the hardest local threat.

An attacker modifies the Control Plane so that:

```text
SecurityAuthority.authorize()
```

always returns:

```text
true
```

This is precisely where your Rust/native components and binary-hardening strategy become relevant.

But the architecture should recognize the limitation:

> **Client-side security code cannot be made absolutely trustworthy against an attacker who controls the client.**

The goal is therefore:

```text
increase cost
+
detect modification
+
move authority to backend
+
minimize locally trusted secrets
+
make bypass non-trivial
```

rather than:

```text
make impossible to crack
```

---

# 21. Backend Must Remain the Ultimate Authority

This is the most important architectural decision.

The Control Plane should not be capable of generating a legitimate subscription authorization entirely offline.

Instead:

```text
Control Plane
      │
      │ authorization request
      ▼
Backend Security Authority
      │
      │ signed authorization
      ▼
Control Plane
```

The local Security Authority verifies the backend's response.

This means that modifying:

```text
license_check()
```

doesn't automatically give the attacker a legitimate backend authorization artifact.

---

# 22. Signed Authorization

The backend can issue an authorization artifact containing concepts such as:

```text
subject
machine
license
permissions
issued_at
expires_at
generation
nonce / identifier
protocol_version
```

and authenticate its integrity cryptographically.

The exact cryptographic construction should be designed separately.

The key architectural property is:

```text
Backend private authority
          ↓
authorization artifact
          ↓
Control Plane verification
```

not:

```text
local database
          ↓
trust
```

---

# 23. Security Authority Transition Table

| Current             | Event                         | Validation        | Next                |
| ------------------- | ----------------------------- | ----------------- | ------------------- |
| UNINITIALIZED       | startup                       | initialize state  | INITIALIZING        |
| INITIALIZING        | integrity valid               | verified          | UNAUTHENTICATED     |
| INITIALIZING        | integrity mismatch            | failed            | INTEGRITY_SUSPECTED |
| INTEGRITY_SUSPECTED | trusted verification succeeds | valid             | UNAUTHENTICATED     |
| INTEGRITY_SUSPECTED | confirmed modification        | compromised       | COMPROMISED         |
| UNAUTHENTICATED     | login                         | request valid     | AUTHENTICATING      |
| AUTHENTICATING      | authentication succeeds       | identity valid    | AUTHENTICATED       |
| AUTHENTICATING      | authentication fails          | invalid           | UNAUTHENTICATED     |
| AUTHENTICATED       | authorization request         | valid session     | AUTHORIZING         |
| AUTHORIZING         | authorization succeeds        | valid             | AUTHORIZED          |
| AUTHORIZING         | authorization fails           | denied            | AUTHZ_FAILED        |
| AUTHORIZED          | license valid                 | valid entitlement | LICENSE_VALID       |
| AUTHORIZED          | license invalid               | denied            | LICENSE_INVALID     |
| LICENSE_VALID       | session established           | valid             | OPERATIONAL         |
| OPERATIONAL         | session expires               | expired           | SESSION_EXPIRED     |
| OPERATIONAL         | license expires               | expired           | LICENSE_EXPIRED     |
| OPERATIONAL         | backend revokes               | revoked           | REVOKED             |
| OPERATIONAL         | integrity mismatch            | suspicious        | INTEGRITY_SUSPECTED |
| OPERATIONAL         | confirmed tampering           | compromised       | COMPROMISED         |
| OPERATIONAL         | backend unavailable           | policy permits    | OFFLINE_GRACE       |
| OFFLINE_GRACE       | backend restored              | revalidation      | OPERATIONAL         |
| OFFLINE_GRACE       | grace expires                 | invalid           | SECURITY_BLOCKED    |
| OPERATIONAL         | logout                        | terminated        | LOGGED_OUT          |
| ANY                 | catastrophic security failure | unsafe            | BLOCKED             |

---

# 24. Tampering Transition Table

This should be maintained separately because it is much easier to reason about.

| Event                         | Detection              | Response                   | State            |
| ----------------------------- | ---------------------- | -------------------------- | ---------------- |
| binary hash mismatch          | integrity verifier     | stop privileged operations | SUSPECTED        |
| signed manifest mismatch      | signature verification | block affected component   | SUSPECTED        |
| invalid security database MAC | storage integrity      | discard local state        | SUSPECTED        |
| impossible state transition   | state validator        | invalidate state           | SUSPECTED        |
| clock rollback                | time monitor           | mark time unreliable       | CLOCK_ANOMALY    |
| clock jump                    | monotonic comparison   | require revalidation       | CLOCK_ANOMALY    |
| machine identity mismatch     | identity verification  | invalidate binding         | MACHINE_INVALID  |
| duplicated machine identity   | backend detection      | revoke/reauthorize         | CLONE_SUSPECTED  |
| protocol manipulation         | message verification   | reject message             | PROTOCOL_FAILURE |
| IPC authentication failure    | IPC verifier           | reject request             | IPC_UNTRUSTED    |
| replay detected               | nonce/generation check | reject message             | REPLAY_DETECTED  |
| snapshot rollback             | generation mismatch    | invalidate stale state     | STATE_ROLLBACK   |
| modified configuration        | integrity check        | reject configuration       | CONFIG_TAMPERED  |
| confirmed binary patch        | trusted verification   | block runtime              | COMPROMISED      |

---

# 25. What Happens After Tampering?

This is one of the most important questions.

The system should **not automatically assume every integrity failure means permanent account compromise**.

Instead:

```text
Detection
   ↓
Classification
   ↓
Containment
   ↓
Verification
   ↓
Recovery OR Block
```

For example:

```text
Integrity mismatch
       ↓
Stop privileged operations
       ↓
Determine whether update/corruption explains it
       ↓
Verify against trusted source
       ↓
       ├── legitimate update
       │       ↓
       │    recover
       │
       └── unauthorized modification
               ↓
            COMPROMISED
```

---

# 26. Containment

Once serious tampering is detected:

```text
Security Authority
        │
        ├── stop new privileged operations
        ├── prevent Execution Plane startup
        ├── prevent license-dependent actions
        ├── reject suspicious IPC
        ├── invalidate local authorization state
        └── preserve security telemetry
```

The goal is:

> **A compromised local state must not silently transition back into an operational authorized state.**

---

# 27. Execution Plane Relationship

The Security Authority should sit **before runtime authorization**.

Conceptually:

```text
Frontend
    │
    ▼
Control Plane API
    │
    ▼
Security Authority
    │
    ├── DENIED ──────► stop
    │
    ▼
Authorized Runtime Command
    │
    ▼
Runtime Manager
    │
    ▼
Execution Plane
```

The Runtime Manager should not independently decide:

```text
"license is probably valid"
```

It receives an authorization decision/capability from the appropriate Control Plane security boundary.

---

# 28. Critical Rule

The Execution Plane should never become the place where subscription authorization is determined.

Likewise, the Frontend should never determine authorization.

And local SQLite should never determine authorization.

The conceptual authority chain should remain:

```text
Backend
   │
   │ authoritative security decision
   ▼
Security Authority
   │
   │ locally enforced authorization
   ▼
Control Plane
   │
   ▼
Execution Plane
```

---

# 29. The Security Authority Is Therefore More Than "Auth"

This is probably the conceptual model you were missing.

It isn't simply:

```text
AuthService
AuthController
LicenseService
```

It is closer to a:

# Security State Coordinator

It continuously answers:

> **"Under the currently observed security conditions, is this application permitted to perform this operation?"**

That includes:

```text
Who is the user?
        +
What machine is this?
        +
Is the session valid?
        +
Is the authorization valid?
        +
Is the license valid?
        +
Is the security state fresh?
        +
Is the protocol valid?
        +
Has anything suspicious happened?
        +
Is the application integrity trustworthy enough?
        +
Is the backend reachable when required?
        ↓
Can this operation proceed?
```

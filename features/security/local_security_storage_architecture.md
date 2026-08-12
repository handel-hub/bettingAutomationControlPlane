# Local Security Storage Architecture

**Document:** `local_security_storage_architecture.md`
**System:** Runtime Synchronization Platform
**Subsystem:** Control Plane — Security Authority
**Status:** Architecture Specification
**Scope:** Local persistence and protection of Security Authority state

---

# 1. Purpose

The Security Authority requires persistent local state.

This state allows the Control Plane to:

- identify the machine across application restarts,
- maintain security sessions,
- maintain authorization state,
- cache licensing information,
- persist security epochs,
- maintain cryptographic material,
- detect rollback and stale state,
- recover safely after crashes,
- survive temporary Backend unavailability,
- detect corruption and tampering.

This document defines **how that state is stored and protected**.

It does not define the complete authentication protocol, Backend trust model, or Execution Plane authorization contract. Those are separate documents.

The primary concern here is:

> **What security state exists locally, where is it stored, how is it protected, how is its integrity established, and what happens when it becomes unavailable, corrupted, stale, or suspicious?**

---

# 2. Architectural Principle

Local security storage is **not the source of ultimate authority**.

The Backend remains authoritative for server-side facts such as:

- account validity,
- license entitlement,
- subscription state,
- revocation,
- server-side authorization policy.

The local Security Authority maintains the state required to operate securely between Backend interactions.

Therefore:

```text
Backend
   │
   │ authoritative security decisions
   ▼
Security Authority
   │
   │ securely persisted local state
   ▼
Local Security Storage
```

Local storage is a **security state cache and continuity mechanism**, not an independent licensing authority.

---

# 3. Threat Model

The storage subsystem must assume that an attacker may have substantial control over the local machine.

The attacker may attempt to:

- inspect application files,
- copy local databases,
- modify SQLite records,
- delete security files,
- replace security files,
- restore older files,
- copy an installation to another machine,
- clone a VM,
- snapshot and restore the filesystem,
- modify configuration,
- modify timestamps,
- replace binaries,
- inject into local processes,
- invoke local APIs,
- run multiple application instances,
- extract secrets from process memory,
- modify encrypted storage,
- replace encrypted blobs,
- replay old security state.

The architecture therefore does **not** attempt to make local storage impossible to inspect.

Instead:

> Local persistence must be designed so that possession or modification of local files does not automatically produce valid security authority.

---

# 4. Security Objectives

Local security storage must provide:

### Confidentiality

Sensitive material should not be available as plaintext through ordinary filesystem inspection.

### Integrity

Unauthorized modifications must be detectable.

### Authenticity

The Security Authority must be able to distinguish its own state from arbitrary local data.

### Freshness

Old state must not silently become current state.

### Atomicity

Security state transitions must not leave partially-written authoritative state.

### Crash consistency

A process crash must not accidentally convert an authorization state into a more privileged state.

### Availability

Temporary local failures should not unnecessarily destroy the entire application's ability to recover.

### Isolation

Different categories of security data should not all depend on one storage mechanism.

---

# 5. Storage Is Divided Into Security Classes

Not all data deserves the same storage mechanism.

The architecture therefore divides local state into classes.

```text
┌─────────────────────────────────────┐
│ Class A — OS-Protected Secrets      │
│ Private keys / root secrets         │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Class B — Encrypted Security State  │
│ Sessions / authorization / licenses  │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Class C — Security Metadata          │
│ Epochs / versions / timestamps       │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ Class D — Operational Metadata       │
│ Cache indexes / transfer metadata    │
└─────────────────────────────────────┘
```

This prevents the architecture from treating every piece of state as equivalent.

---

# 6. Storage Layers

The Security Authority uses several storage layers.

```text
                 Security Authority
                         │
              ┌──────────┴──────────┐
              │                     │
       Secure Key Store       Security State Store
              │                     │
              ▼                     ▼
       OS-backed protection       SQLite
              │                     │
              └──────────┬──────────┘
                         │
                  Protected Files
```

The exact implementation may use additional native components.

---

# 7. OS-Protected Secret Storage

The highest-value secrets should not simply be stored as:

```text
secret.bin
```

with application-managed encryption alone.

Where available, the application should use operating-system facilities for protecting long-lived secrets.

On Windows, appropriate OS-backed credential/key-protection mechanisms should be preferred over inventing an entirely application-defined secret store.

The principle is:

> The filesystem stores ciphertext; the operating system protects the key required to use the ciphertext.

---

# 8. What Belongs in OS-Protected Storage

Potential candidates include:

- machine private key,
- local key-encryption key,
- device credential,
- long-lived authentication secret,
- locally-held cryptographic identity material.

The exact choice depends on the final authentication protocol.

---

# 9. What Should Not Be Stored There

Do not use the OS secret store for everything.

It is unnecessary for:

- transfer progress,
- UI preferences,
- cache indexes,
- non-sensitive telemetry metadata,
- ordinary configuration,
- temporary files.

The goal is **security classification**, not indiscriminate encryption.

---

# 10. SQLite's Role

SQLite is appropriate for structured local Security Authority state.

It can contain:

- security-state metadata,
- session metadata,
- authorization metadata,
- license cache metadata,
- protocol versions,
- security epochs,
- transfer references where appropriate,
- migration versions,
- state-machine persistence.

SQLite should **not automatically become the location of every secret**.

---

# 11. SQLite Is Not the Root of Trust

An attacker who can modify:

```text
security.db
```

must not automatically gain the ability to declare:

```text
authorized = true
```

Therefore:

```text
SQLite
   ≠
Authority
```

SQLite is a persistence mechanism.

The Security Authority is the authority.

---

# 12. Protected Database State

Security-sensitive SQLite records should be protected against unauthorized modification.

A conceptual record might contain:

```text
state
version
security_epoch
issued_at
expires_at
payload
integrity_tag
```

The integrity mechanism allows the Security Authority to detect modifications.

---

# 13. Encryption and Integrity

Encryption alone is insufficient.

For example:

```text
plaintext
    ↓
encrypt
    ↓
ciphertext
```

does not necessarily mean:

> "This ciphertext has not been maliciously replaced."

Security storage therefore requires authenticated encryption or an equivalent authenticated storage construction.

Conceptually:

```text
plaintext
    +
authenticated metadata
    ↓
authenticated encryption
    ↓
ciphertext + authentication tag
```

---

# 14. Integrity Is More Important Than Secrecy for Some State

Consider:

```text
license_valid = false
```

The attacker may not care about reading it.

They care about changing it to:

```text
license_valid = true
```

Therefore authorization state requires strong integrity protection.

---

# 15. Security State Envelope

Sensitive state should conceptually be represented as an authenticated envelope:

```text
SecurityEnvelope {
    format_version
    record_type
    record_id
    security_epoch
    issued_at
    expires_at
    payload
    authentication_tag
}
```

The exact binary format is defined elsewhere.

The important property is that security-critical fields are authenticated along with the payload.

---

# 16. Preventing Field Substitution

It must not be possible to take:

```text
authorization_id = A
```

from one record and combine it with:

```text
expires_at = future date
```

from another record.

Authenticated metadata should bind the complete logical record together.

---

# 17. Machine Identity

Machine identity is a foundational local security artifact.

The machine identity must be:

- generated securely,
- persisted reliably,
- protected against accidental replacement,
- associated with the appropriate cryptographic identity,
- recoverable across ordinary application restarts.

Conceptually:

```text
Machine Identity
       │
       ├── machine_id
       ├── key identity
       └── registration metadata
```

---

# 18. Machine Identity Is Not Just a Random UUID

A random identifier alone does not prove machine ownership.

For example:

```text
machine_id = ABC123
```

can simply be copied.

A stronger architecture binds the machine identity to cryptographic material.

Conceptually:

```text
Machine ID
     +
Machine Key
     +
Backend registration
```

forms the machine identity relationship.

---

# 19. Machine Identity Persistence

Normal application restart:

```text
Application
   ↓
load machine identity
   ↓
verify integrity
   ↓
continue
```

The application should not generate a new machine identity every startup.

---

# 20. Machine Identity Corruption

If machine identity storage is corrupted:

```text
load
 ↓
integrity verification
 ↓
FAIL
```

the Security Authority must not simply generate a new identity automatically.

Doing so could unintentionally turn:

```text
corrupted identity
```

into:

```text
new legitimate machine
```

The system should enter a recovery state.

---

# 21. Machine Identity Replacement

Replacing the machine identity is a security-sensitive operation.

It must require an explicit recovery or re-registration procedure.

It must not be triggered simply because:

```text
machine_id file missing
```

---

# 22. Session State

Local session storage may contain:

- session identifier,
- session lifecycle metadata,
- expiration information,
- renewal metadata,
- security epoch,
- server-issued references.

The system should minimize what is persisted.

---

# 23. Session Secrets

If a session credential must be persisted, it should receive stronger protection than ordinary session metadata.

Prefer:

```text
OS-protected secret
```

over:

```text
plaintext SQLite column
```

where the protocol permits it.

---

# 24. Session Expiration

Local session state must contain enough information to determine whether a session is stale.

However, local timestamps should not be blindly treated as authoritative.

For example:

```text
local clock says:
session valid
```

does not necessarily mean:

```text
Backend agrees:
session valid
```

---

# 25. Server Time

Where the protocol provides trusted server-time information, the Security Authority may maintain a bounded estimate of server time.

Conceptually:

```text
server_time
clock_offset
measurement_time
uncertainty
```

This assists with:

- expiration,
- replay prevention,
- clock anomaly detection.

---

# 26. Clock Rollback

Suppose the system records:

```text
last_observed_time = 10:00
```

and later observes:

```text
system_time = 08:00
```

The Security Authority must treat this as suspicious.

It must not blindly conclude:

> "The session is now valid for another two hours."

---

# 27. Security Epoch

A security epoch provides monotonic security state.

Example:

```text
epoch = 17
```

After a security transition:

```text
epoch = 18
```

Older state associated with epoch 17 should not silently overwrite epoch 18.

---

# 28. Epoch Persistence

Security epochs must survive process restarts.

They therefore belong to persistent security metadata.

An epoch should be updated atomically with the state transition that depends upon it.

---

# 29. Epoch Rollback Protection

Suppose the current state is:

```text
epoch = 50
```

and a restored database contains:

```text
epoch = 41
```

The Security Authority must detect that the local state moved backward.

This should be treated as:

```text
SECURITY_STATE_ROLLBACK
```

rather than normal initialization.

---

# 30. License Cache

The Control Plane may cache Backend licensing information.

The cache exists for:

- startup continuity,
- reducing unnecessary requests,
- temporary network failures,
- UI state,
- controlled degraded operation.

It does **not** become permanent authority.

---

# 31. License Cache Contents

Potential information:

```text
license_reference
entitlements
issued_at
expires_at
server_version
authorization_epoch
last_verified_at
```

The cache should not contain unnecessary billing information.

---

# 32. License Cache Integrity

An attacker must not be able to modify:

```text
max_browsers = 2
```

into:

```text
max_browsers = 200
```

and have the local Security Authority accept the modification.

The cache must therefore be authenticated.

---

# 33. Server-Signed State

Where appropriate, the Backend can provide cryptographically authenticated authorization/license information.

This gives the local Security Authority something stronger than:

```text
Backend says:
license = premium
```

represented as an unauthenticated local database field.

The local state can instead retain a verifiable server-issued artifact.

---

# 34. Important Limitation

A locally stored server-signed license artifact does not magically prevent piracy.

If the attacker modifies the application to ignore:

```text
signature verification
```

local cryptography cannot stop that attacker by itself.

The purpose is to prevent **easy state modification and protocol forgery**, not to create an impossible-to-bypass binary.

---

# 35. Key Hierarchy

The system should avoid using one master secret for everything.

Conceptually:

```text
OS-Protected Root Secret
          │
          ▼
Key Encryption Key
          │
     ┌────┴────┐
     ▼         ▼
Session Key   Storage Key
               │
               ▼
       Security State
```

The exact hierarchy depends on the selected cryptographic architecture.

---

# 36. Key Separation

Different purposes should use different keys.

For example:

```text
K_storage
K_session
K_machine
K_transport
```

should not simply be the same raw key reused everywhere.

This limits the consequences of compromise.

---

# 37. Key Rotation

Keys may need rotation because of:

- cryptographic policy,
- compromise,
- certificate expiration,
- protocol version changes,
- machine re-registration,
- scheduled rotation.

Rotation must not destroy the ability to decrypt valid state prematurely.

---

# 38. Rotation Strategy

A safe rotation pattern is:

```text
OLD KEY
   │
   ├── decrypt existing state
   │
   ▼
NEW KEY
   │
   └── encrypt new state
```

Existing records can be migrated gradually or during controlled startup.

---

# 39. Key Loss

If the local key required to decrypt security state is permanently lost:

```text
ciphertext exists
        +
key does not exist
```

the state may be unrecoverable.

The system must not silently generate a replacement key and treat old state as valid.

Instead:

```text
SECURITY_STATE_UNRECOVERABLE
```

and enter the defined recovery path.

---

# 40. Certificate Rotation

Backend certificates or trust material may change.

The local Security Authority must support controlled trust-material updates.

It should avoid blindly accepting arbitrary replacement certificates from the network.

---

# 41. Atomic Security Writes

Security state transitions must be atomic.

Bad:

```text
write authorization
write expiration
write epoch
```

If the process crashes between writes, the state may become inconsistent.

Better:

```text
transaction
    update state
    update epoch
    update metadata
commit
```

---

# 42. SQLite Transactions

SQLite transactions are appropriate for atomic groups of local security metadata.

Conceptually:

```text
BEGIN

update authorization
update epoch
update expiration
update state_version

COMMIT
```

A crash before commit should leave the previous valid state intact.

---

# 43. Never Upgrade Security State Through Partial Writes

The dangerous direction is:

```text
UNAUTHORIZED
      ↓
partially written
      ↓
AUTHORIZED
```

The system must never interpret incomplete state as successful authorization.

The safe recovery direction is:

```text
uncertain
   ↓
revalidate
```

---

# 44. Write-Ahead Logging

SQLite's transactional mechanisms should be configured appropriately for crash resilience.

The Security Authority should use SQLite's durability guarantees deliberately rather than assuming:

> "SQLite automatically makes everything safe."

The persistence configuration must be tested against:

- process termination,
- power loss,
- disk-full conditions,
- concurrent access.

---

# 45. Disk Full

Security storage must explicitly handle:

```text
ENOSPC
```

A security transition must not appear successful merely because an in-memory state changed.

The sequence should be:

```text
modify
 ↓
persist
 ↓
verify commit
 ↓
publish state
```

not:

```text
modify memory
 ↓
tell everybody success
 ↓
attempt persistence
```

---

# 46. Storage Corruption

Possible corruption includes:

- malformed SQLite database,
- truncated files,
- damaged encrypted blobs,
- invalid authentication tags,
- invalid schema,
- impossible state combinations,
- missing records.

The system must distinguish:

```text
ordinary absence
```

from:

```text
security corruption
```

---

# 47. Corruption Is Not Automatic Reset

The following is dangerous:

```text
database corrupted
      ↓
delete database
      ↓
create fresh identity
      ↓
continue
```

This can turn tampering into a recovery mechanism.

Instead:

```text
corruption
   ↓
quarantine / recovery state
   ↓
revalidation
```

---

# 48. Tamper Detection

The storage architecture should detect suspicious changes such as:

- invalid authentication tags,
- unexpected epoch rollback,
- invalid state transitions,
- impossible timestamps,
- unknown record versions,
- machine identity mismatch,
- unexpected key identity,
- inconsistent state relationships.

---

# 49. Tamper Response

Detection does not necessarily mean immediate application termination.

The Security Authority should classify the event.

Possible outcomes:

```text
WARN
DEGRADED
REAUTHENTICATE
REPAIR
REVOKE_LOCAL_STATE
REQUIRE_REREGISTRATION
TERMINATE_SECURITY_SESSION
```

The appropriate response depends on severity.

---

# 50. Local Configuration

Security-sensitive configuration should not be treated as authoritative merely because it exists on disk.

For example:

```text
config.json

offline_mode = true
license_check = false
```

must not be allowed to redefine Security Authority policy.

Configuration expresses requests or preferences.

Security policy originates from trusted authority.

---

# 51. Separation of Configuration and Security State

Maintain:

```text
configuration
```

separately from:

```text
security state
```

This prevents an ordinary configuration mutation from becoming a security mutation.

---

# 52. Multiple Control Plane Processes

Only one authoritative Security Authority instance should normally own the security state.

Multiple processes can cause:

```text
race conditions
state rollback
simultaneous renewal
identity duplication
conflicting authorization
```

The architecture therefore requires an instance coordination mechanism.

---

# 53. Security Storage Lock

A local process lock can establish:

```text
Security Authority owner
```

Other Control Plane processes should either:

- communicate with the existing instance,
- wait,
- or terminate.

They should not independently mutate authoritative security state.

---

# 54. Lock Failure

A stale lock must not be deleted blindly.

The system must determine whether:

```text
process actually exists
```

before assuming:

```text
lock is stale
```

A robust OS-specific mechanism is preferable to a naive lock file.

---

# 55. Copied Installation

Suppose the user copies:

```text
C:\Program Files\App
```

to another machine.

The copied local database may contain:

```text
machine_id = A
```

The new machine may not possess the corresponding protected key.

Therefore the Security Authority should detect the identity mismatch.

---

# 56. VM Cloning

VM cloning presents a similar problem.

A snapshot may contain:

```text
machine identity
database
authorization cache
```

A cloned VM must not automatically become an independently authorized machine.

Machine identity should therefore be bound to protected machine-specific material where practical.

---

# 57. Filesystem Snapshot Rollback

A snapshot may restore:

```text
epoch = 12
```

when the current state was:

```text
epoch = 20
```

Rollback detection must identify this condition.

The system should not treat the restored state as a legitimate newer state.

---

# 58. Uninstall

Uninstallation should define what happens to:

- machine identity,
- private keys,
- cached authorization,
- session state,
- encrypted secrets,
- logs,
- transfer metadata.

Security-sensitive secrets should not remain indefinitely merely because the application was removed.

---

# 59. Reinstallation

Reinstallation must not automatically inherit security state unless explicitly intended.

Possible policy:

```text
reinstall
   ↓
detect existing machine identity
   ↓
verify protected key
   ↓
recover OR re-register
```

This should be deterministic.

---

# 60. Backup

Security state should not be casually included in generic application backups.

A backup containing:

```text
database
+
encrypted secrets
```

may still expose valuable material.

Backup behavior should therefore be explicitly defined.

---

# 61. Recovery

Recovery should distinguish:

### Recoverable

Examples:

- temporary SQLite failure,
- interrupted transaction,
- missing cache,
- expired session.

### Revalidatable

Examples:

- suspicious local state,
- machine identity inconsistency,
- stale authorization.

### Irrecoverable

Examples:

- permanently lost cryptographic key.

Each category receives a different recovery path.

---

# 62. Security Storage Lifecycle

```text
CREATE
  │
  ▼
INITIALIZE
  │
  ▼
ACTIVE
  │
  ├──────────────┐
  ▼              ▼
UPDATED        ROTATING
  │              │
  └──────┬───────┘
         ▼
      ACTIVE
         │
         ▼
     REVOKED/
     DESTROYED
```

The storage lifecycle must not be confused with the user's application lifecycle.

---

# 63. Startup Sequence

A secure startup sequence is approximately:

```text
Application starts
       │
       ▼
Acquire Security Authority ownership
       │
       ▼
Load OS-protected key material
       │
       ▼
Open local security storage
       │
       ▼
Verify storage integrity
       │
       ▼
Validate schema/version
       │
       ▼
Validate security epoch
       │
       ▼
Validate machine identity
       │
       ▼
Recover incomplete transactions
       │
       ▼
Load security state
       │
       ▼
Determine current security state
       │
       ▼
Backend validation when required
```

Only after this should the application decide whether execution can begin.

---

# 64. Shutdown Sequence

Shutdown should preserve security consistency.

```text
Stop accepting security mutations
        │
        ▼
Complete/abort active persistence transaction
        │
        ▼
Flush required state
        │
        ▼
Persist final metadata
        │
        ▼
Release storage ownership
        │
        ▼
Shutdown
```

---

# 65. Crash Recovery

After an unexpected crash:

```text
startup
   │
   ▼
storage recovery
   │
   ├── valid previous state
   │
   ├── incomplete transaction
   │
   ├── corruption
   │
   └── rollback
```

The Security Authority must recover into a **known state**, never an inferred privileged state.

---

# 66. State Monotonicity

Security state should generally move monotonically with respect to security epochs and revocation.

For example:

```text
VALID
 ↓
EXPIRED
 ↓
REAUTH_REQUIRED
```

should not become:

```text
VALID
```

simply because an old database snapshot is restored.

---

# 67. Revocation Persistence

Revocation-related state is particularly important.

If the Security Authority learns:

```text
authorization revoked
```

that state must not disappear simply because:

```text
application restarted
```

or:

```text
database cache was restored
```

The Backend remains authoritative, but locally observed revocation must be persisted safely.

---

# 68. Offline Mode

Local storage may allow controlled degraded operation when the Backend is temporarily unavailable.

However:

```text
offline cache
```

must have a bounded validity period.

It must not become:

```text
permanent authorization
```

---

# 69. Offline State Example

```text
Backend unavailable
        │
        ▼
previous authorization still valid
        │
        ▼
within permitted grace period?
        │
     ┌──┴──┐
    YES    NO
     │      │
     ▼      ▼
 DEGRADED  DENIED
```

The exact grace policy belongs to the Security Authority policy.

---

# 70. Security Storage and the Execution Plane

The Execution Plane should not access the local security database.

Avoid:

```text
Execution Plane
      │
      ▼
security.db
```

Instead:

```text
Security Authority
      │
      ▼
Authorization Contract
      │
      ▼
Execution Plane
```

This maintains the black-box boundary.

---

# 71. Security Storage and Frontend

The Frontend must never directly access security storage.

Avoid:

```text
Frontend
   ↓
SQLite
```

or:

```text
Frontend
   ↓
secret files
```

The Frontend receives only sanitized security state through the Control Plane API.

---

# 72. Security Storage and Backend

The Backend does not directly access local storage.

The Control Plane decides:

```text
what to persist
what to cache
what to discard
```

The Backend remains remote authority.

---

# 73. Node.js and Rust Boundary

Sensitive storage functionality may be implemented partially in Rust.

A reasonable architecture is:

```text
Node.js
   │
   │ high-level Security Authority
   ▼
Native Security Storage Interface
   │
   ▼
Rust
   │
   ├── secure key operations
   ├── authenticated storage
   ├── identity handling
   └── sensitive primitives
```

This is an implementation choice, not a requirement that all security logic be moved into Rust.

---

# 74. What Rust Does Not Solve

Moving storage code into Rust does not automatically make it secure.

Rust provides strong memory-safety properties, but it does not prevent:

- logical authorization bugs,
- bad cryptographic design,
- incorrect key management,
- insecure IPC,
- stolen credentials,
- malicious patching,
- compromised runtime,
- server-side account compromise.

Rust is one layer of defense.

---

# 75. Memory Exposure

Even if persistent storage is strongly protected, decrypted secrets eventually exist in process memory.

Therefore:

- minimize secret lifetime,
- avoid unnecessary copies,
- avoid logging secrets,
- avoid serializing secrets unnecessarily,
- use native secure memory mechanisms where appropriate.

Absolute memory secrecy on a locally controlled machine cannot be guaranteed.

---

# 76. Logging Restrictions

The following must never appear in ordinary logs:

```text
password
private key
session secret
refresh credential
storage encryption key
machine private key
```

Even errors should avoid dumping complete security records.

---

# 77. Storage Error Classification

Storage errors should be classified.

Example:

```text
STORAGE_UNAVAILABLE
STORAGE_CORRUPTED
STORAGE_TAMPERED
KEY_UNAVAILABLE
KEY_INVALID
SCHEMA_INCOMPATIBLE
STORAGE_ROLLBACK
STORAGE_LOCKED
STORAGE_FULL
```

These should not all produce the same behavior.

---

# 78. Storage Versioning

Security storage requires explicit schema versions.

Example:

```text
storage_format_version = 4
```

The Security Authority must know whether a stored record is:

```text
supported
migratable
obsolete
unknown
```

Unknown security state should not be interpreted as valid state.

---

# 79. Migration Safety

A migration should follow:

```text
backup/recovery point
        │
        ▼
validate old schema
        │
        ▼
perform transactional migration
        │
        ▼
verify migrated state
        │
        ▼
commit
```

A failed migration must not produce partially migrated authoritative state.

---

# 80. Security Invariants

The storage architecture must preserve the following invariants.

### Invariant 1

Local files cannot independently grant authorization.

### Invariant 2

Modification of persisted security state must be detectable.

### Invariant 3

Old security state cannot silently replace newer state.

### Invariant 4

Private cryptographic material is not stored as ordinary plaintext files.

### Invariant 5

Security transitions are crash-consistent.

### Invariant 6

Corrupted security state is never interpreted as valid authorization.

### Invariant 7

A copied installation cannot automatically become a new trusted machine.

### Invariant 8

The Execution Plane cannot directly access Security Authority storage.

### Invariant 9

The Frontend cannot directly access Security Authority storage.

### Invariant 10

Local cached authorization has bounded validity.

### Invariant 11

Lost cryptographic keys cannot be replaced silently.

### Invariant 12

Security epochs cannot move backward without detection.

---

# 81. Recommended Logical Storage Layout

A conceptual filesystem layout could be:

```text
Application/
│
├── binaries/
│
├── runtime/
│
├── data/
│   ├── security/
│   │   ├── security.db
│   │   ├── state/
│   │   └── metadata/
│   │
│   ├── cache/
│   │
│   ├── transfers/
│   │
│   └── logs/
│
└── temporary/
```

Sensitive keys should preferably live in OS-protected storage rather than simply under:

```text
data/security/
```

---

# 82. Recommended Conceptual Separation

The most important separation is:

```text
                LOCAL STORAGE
                      │
       ┌──────────────┼──────────────┐
       │              │              │
       ▼              ▼              ▼
   Secrets        Security DB     Operational
                                      Data
       │              │              │
       ▼              ▼              ▼
 OS protection   Integrity       Ordinary FS
```

Not everything needs the same security level.

---

# 83. What This Architecture Does Not Guarantee

This architecture does **not** guarantee that a sufficiently capable local attacker cannot bypass the application.

A determined attacker who controls:

- the operating system,
- process execution,
- application binaries,
- memory,
- debugging,
- filesystem,

may eventually patch the application's behavior.

The objective is instead to make unauthorized modification substantially more difficult and to ensure that ordinary manipulation of:

- SQLite,
- configuration,
- cached license state,
- session files,

does not trivially produce authorization.

---

# 84. Relationship to the Security Authority

The Security Authority should treat local storage as:

```text
persistent security state
```

rather than:

```text
security authority
```

The distinction is critical.

```text
             SECURITY AUTHORITY
                     │
              decides security
                     │
                     ▼
              LOCAL STORAGE
              persists state
```

Storage remembers.

The Security Authority decides.

---

# 85. Final Architecture

The complete conceptual architecture is:

```text
                         BACKEND
                            │
                    Authentication /
                    Authorization /
                    Licensing
                            │
                            ▼
                  ┌───────────────────┐
                  │ Security Authority│
                  │                   │
                  │ State Machine      │
                  │ Session Manager    │
                  │ Authorization      │
                  │ Licensing          │
                  │ Machine Identity   │
                  └─────────┬─────────┘
                            │
                     Persistence API
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
      OS-Protected Secrets         Security State Store
              │                           │
              │                           ▼
              │                         SQLite
              │                           │
              └────────────┬──────────────┘
                           │
                    Protected State
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
       Crash Recovery              Integrity/Tamper
                                      Detection
             │                           │
             └─────────────┬─────────────┘
                           │
                           ▼
                  Security Authority
                           │
                  Authorization Contract
                           │
                           ▼
                    Runtime Manager
                           │
                           ▼
                    Execution Plane
```

---

# 86. Final Design Principle

The most important principle of the entire local storage architecture is:

> **Never allow persisted local data to become authority merely because it exists.**

A database can say:

```text
authorized = true
```

A configuration file can say:

```text
offline = true
```

A cached license can say:

```text
premium = true
```

None of those statements are authoritative by themselves.

The Security Authority must determine whether the state is:

- authentic,
- intact,
- current,
- associated with the correct machine,
- within its permitted lifetime,
- consistent with the current security epoch,
- and, when necessary, validated against the Backend.

That gives the Control Plane a clean model:

```text
Backend
   ↓
Authority

Security Authority
   ↓
Decision

Local Security Storage
   ↓
Persistence

Runtime Manager
   ↓
Enforcement boundary

Execution Plane
   ↓
Execution
```

**Storage preserves security state. It does not create security authority.**

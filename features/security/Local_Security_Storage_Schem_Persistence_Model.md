# Local Security Storage Schema & Persistence Model

**Document Status:** Architecture Specification
**Subsystem:** Control Plane — Security Authority
**Scope:** Local Security Storage
**Audience:** Control Plane / Security Authority implementation
**Related Documents:**

- Security Authority State Machine & Transition Table
- Security Authority Architecture & Internal Design
- Security Authority Protocol Specification
- Security Authority ↔ Backend Trust Model
- Security Authority ↔ Execution Plane Authorization Contract
- Local Security Storage Architecture

---

## 1. Purpose

This document defines the **logical schema, persistence model, lifecycle, consistency rules, recovery behavior, and security requirements** for data persisted locally by the Control Plane's Security Authority.

The Local Security Storage exists to persist security state that must survive:

- application restarts,
- temporary network failures,
- machine reboots,
- session renewal,
- controlled application shutdown,
- system sleep/hibernation,
- temporary backend unavailability.

It must **not** become a source of authority that can override the Backend.

The central rule is:

> **Local persistence preserves security state; it does not create security authority.**

The Backend remains authoritative for server-side identity, authorization, licensing, and revocation.

The Security Authority determines whether locally persisted state is sufficiently trustworthy to permit an operation.

---

# 2. Design Goals

The storage subsystem MUST provide:

1. Secure persistence of machine identity.
2. Secure persistence of cryptographic material.
3. Secure persistence of session state.
4. Secure persistence of authorization/licensing state.
5. Crash-safe state transitions.
6. Detection of corrupted security state.
7. Detection of rollback where feasible.
8. Protection against unauthorized modification.
9. Atomic security-state updates.
10. Clear distinction between authoritative and cached state.
11. Recovery after application crashes.
12. Recovery after power loss.
13. Safe handling of partial writes.
14. Key rotation support.
15. Schema versioning.
16. Migration support.
17. Explicit expiration handling.
18. Auditability of security transitions.
19. Protection against stale authorization state.
20. Controlled degraded/offline behavior.

---

# 3. Non-Goals

This subsystem does **not** provide:

- Backend persistence.
- Business-data storage.
- File-transfer storage.
- Browser state.
- Execution Plane state.
- Application logs in general.
- Frontend persistence.
- Arbitrary application configuration.
- Long-term storage of plaintext credentials.

Security storage should remain deliberately narrow.

---

# 4. Core Security Principle

The Security Authority has several different categories of state.

They must not all be treated equally.

Conceptually:

```text
                    Local Security Storage
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
     Machine State      Session State    Authorization State
          │                 │                 │
          ▼                 ▼                 ▼
    Cryptographic       Ephemeral /       Backend-derived
       Identity          renewable          state
```

The most important distinction is:

### Durable identity

Examples:

- machine identity,
- installation identity,
- cryptographic key references.

These may legitimately survive indefinitely.

### Renewable security state

Examples:

- session information,
- authorization grants,
- license state,
- backend-issued leases.

These have expiration and must be periodically revalidated.

### Ephemeral state

Examples:

- active challenge,
- nonce,
- pending authentication transaction,
- temporary handshake state.

These generally should not survive an application restart.

---

# 5. Storage Technology

The Security Authority may use:

```text
SQLite
+
OS-backed secure key storage
+
Authenticated encryption
+
Integrity metadata
```

SQLite is responsible for **structured persistence**.

It should not be treated as the ultimate cryptographic root of trust.

The architecture should preferably be:

```text
                 Security Authority
                        │
             ┌──────────┴──────────┐
             │                     │
             ▼                     ▼
      Security Database      Secret Provider
          SQLite             OS / Native
             │                     │
             ▼                     ▼
       Metadata/state        Sensitive keys
```

Sensitive cryptographic keys should preferably be protected using an operating-system credential/secret facility where available.

Examples include platform secure storage mechanisms.

The exact implementation is platform-dependent.

---

# 6. Storage Classification

Every persisted field MUST belong to one of these classifications.

| Classification       | Example             |             Encryption | Integrity | Lifetime     |
| -------------------- | ------------------- | ---------------------: | --------: | ------------ |
| Public metadata      | schema version      |               Optional |       Yes | Permanent    |
| Security metadata    | key ID              |               Optional |       Yes | Long-lived   |
| Sensitive metadata   | session identifiers |                    Yes |       Yes | Temporary    |
| Secret               | refresh credential  |                    Yes |       Yes | Temporary    |
| Cryptographic key    | private key         |        Prefer OS store |       Yes | Long-lived   |
| Authorization state  | license grant       |                    Yes |       Yes | Renewable    |
| Audit/security event | transition record   |           Optional/Yes |       Yes | Configurable |
| Ephemeral state      | challenge nonce     | Usually no persistence |       Yes | Very short   |

---

# 7. Data Model

The logical model consists of the following principal entities:

```text
MachineIdentity
InstallationIdentity
KeyRecord
ServerTrustRecord
SessionRecord
AuthorizationRecord
LicenseRecord
SecurityStateRecord
PendingTransaction
SecurityEvent
StorageMetadata
RollbackGuard
```

These entities should not necessarily map one-to-one to physical SQLite tables.

The implementation may combine or separate them as required.

---

# 8. Machine Identity

## 8.1 Purpose

The Machine Identity represents the identity of the local installation/machine from the Security Authority's perspective.

It is used for:

- backend registration,
- machine binding,
- session establishment,
- authorization,
- device recognition.

It is **not** itself sufficient to authenticate the user.

---

## 8.2 Logical Schema

```text
MachineIdentity

machine_id
installation_id
identity_version
status
created_at
last_registered_at
last_verified_at
key_reference
backend_binding_id
generation
created_by_version
updated_at
```

### `machine_id`

Backend-recognized machine identifier.

### `installation_id`

Unique identity for this installation.

This distinction is important.

A copied installation may contain the same logical data while representing a different physical installation.

---

# 9. Machine Identity Lifecycle

Possible states:

```text
UNINITIALIZED
     │
     ▼
GENERATING
     │
     ▼
CREATED
     │
     ▼
REGISTERED
     │
     ▼
VERIFIED
```

Failure states:

```text
CORRUPTED
REPLACEMENT_REQUIRED
REVOKED
```

The database must never silently convert:

```text
CORRUPTED
```

into:

```text
VERIFIED
```

without a legitimate recovery process.

---

# 10. Machine Identity Persistence Rules

The machine identity MUST:

- survive normal application restarts,
- survive normal OS restarts,
- be integrity protected,
- have controlled access,
- never be regenerated simply because the Backend is unavailable,
- never be regenerated merely because authentication failed.

Regenerating machine identity casually can cause:

- duplicate machines,
- lost device bindings,
- license failures,
- suspicious-device detection,
- backend inconsistency.

---

# 11. Machine Identity Corruption

If the Security Authority detects corruption:

```text
VALID
  │
  ▼
CORRUPTION_DETECTED
  │
  ├── recoverable → RECOVERY
  │
  └── unrecoverable → INVALID
```

It must not:

```text
delete identity
generate new identity
continue as authenticated
```

automatically.

The correct action depends on the backend protocol.

---

# 12. Cryptographic Key Records

Keys should be represented by metadata rather than exposing raw private material through normal application state.

```text
KeyRecord

key_id
key_type
purpose
provider
algorithm
version
status
created_at
activated_at
expires_at
retired_at
backend_key_id
storage_reference
```

Example purposes:

```text
MACHINE_IDENTITY
SERVER_AUTHENTICATION
SESSION_DERIVATION
DATA_PROTECTION
PROTOCOL_INTEGRITY
```

---

# 13. Key Lifecycle

A key may transition through:

```text
GENERATED
    │
    ▼
ACTIVE
    │
    ▼
ROTATION_PENDING
    │
    ▼
ROTATED
    │
    ▼
RETIRED
    │
    ▼
DESTROYED
```

A retired key may remain temporarily available for decrypting previously persisted data.

Therefore:

> **Retired does not necessarily mean immediately deleted.**

---

# 14. Key Rotation

Key rotation must be versioned.

Example:

```text
key_id = K001
version = 1
status = RETIRED

key_id = K002
version = 2
status = ACTIVE
```

Encrypted records should contain enough metadata to determine which key version protects them.

For example:

```text
encryption_key_id
encryption_version
ciphertext
authentication_tag
```

This allows controlled migration.

---

# 15. Server Trust Record

The Security Authority needs persistent information about the Backend's cryptographic identity.

Logical schema:

```text
ServerTrustRecord

server_id
certificate_fingerprint
public_key_reference
protocol_version
trust_version
status
first_seen_at
last_verified_at
rotation_deadline
```

This record protects against blindly accepting an arbitrary server.

---

# 16. Server Key Rotation

Server credentials may rotate.

Therefore:

```text
CURRENT_SERVER_KEY
        │
        ▼
ROTATION_DETECTED
        │
        ▼
VALIDATE_NEW_KEY
        │
        ▼
TRUST_NEW_KEY
        │
        ▼
RETIRE_OLD_KEY
```

A new server certificate/key MUST NOT automatically become trusted merely because it was received from the network.

The rotation must follow the established trust model.

---

# 17. Session Record

The session represents the current authenticated relationship between:

```text
User
+
Machine
+
Control Plane
+
Backend
```

Logical schema:

```text
SessionRecord

session_id
session_generation
user_id
machine_id
status
issued_at
expires_at
renew_after
last_renewed_at
last_verified_at
authentication_method
authorization_snapshot_id
server_key_version
session_protocol_version
created_at
updated_at
```

---

# 18. Session Secrets

Raw session credentials should not be freely accessible throughout the application.

Prefer:

```text
Security Authority
      │
      ▼
Session Secret Provider
      │
      ▼
Protected storage
```

rather than:

```text
SQLite
   │
   ▼
plaintext token
   │
   ▼
every subsystem
```

The fewer components that can access a session secret, the better.

---

# 19. Session Expiration

The database must distinguish:

```text
issued_at
renew_after
expires_at
```

These represent different concepts.

Example:

```text
issued_at   = 10:00
renew_after = 10:40
expires_at  = 11:00
```

At 10:40 the Security Authority should attempt renewal.

At 11:00 the session is expired unless successfully renewed.

---

# 20. Session State

Example:

```text
NO_SESSION
AUTHENTICATING
AUTHENTICATED
RENEWING
DEGRADED
EXPIRED
REVOKED
LOGGING_OUT
LOGGED_OUT
INVALID
```

The persisted database state must not permit impossible combinations.

For example:

```text
status = EXPIRED
expires_at = future
```

would be an invalid state.

---

# 21. Authorization Record

Authentication answers:

> Who are you?

Authorization answers:

> What are you allowed to do?

Therefore authorization must be persisted separately.

Logical schema:

```text
AuthorizationRecord

authorization_id
session_id
user_id
machine_id
status
issued_at
effective_at
expires_at
revision
backend_revision
license_id
capability_set
policy_version
last_verified_at
```

---

# 22. Authorization Is a Cache

This is extremely important.

The local authorization record is:

> **A cached, cryptographically validated representation of backend authorization.**

It is not an independent authorization authority.

Therefore:

```text
Backend
   │
   ▼
Authorization Grant
   │
   ▼
Security Authority
   │
   ▼
Local Authorization State
```

not:

```text
Local Database
      │
      ▼
"User is authorized"
```

forever.

---

# 23. License Record

License state should be separately represented.

```text
LicenseRecord

license_id
account_id
machine_binding
plan_id
status
issued_at
effective_at
expires_at
revoked_at
revision
capabilities
limits
backend_revision
last_verified_at
```

Possible states:

```text
UNKNOWN
VALID
EXPIRING
EXPIRED
REVOKED
SUSPENDED
INVALID
```

---

# 24. License Upgrade

A license upgrade is a new authorization state.

Example:

```text
PLAN_BASIC
     │
     ▼
PLAN_PRO
```

The Security Authority must not assume the upgrade exists merely because the user completed payment locally.

The Backend must issue the authoritative update.

---

# 25. License Downgrade

Likewise:

```text
PLAN_PRO
     │
     ▼
PLAN_BASIC
```

The new capability set must take effect according to the Backend's authorization revision.

This matters because an old locally cached capability set could otherwise continue granting access.

---

# 26. Security State Record

A central security-state record can provide a compact representation of the current authority state.

```text
SecurityState

state_version
security_state
session_generation
authorization_revision
license_revision
machine_generation
server_trust_version
last_transition
last_transition_at
updated_at
```

Example:

```text
security_state = AUTHORIZED
session_generation = 41
authorization_revision = 17
license_revision = 9
```

---

# 27. Why Generations Matter

Generations prevent stale state from being mistaken for current state.

Suppose:

```text
Session generation = 41
```

Then logout occurs:

```text
Session generation = 42
```

An old response referring to:

```text
generation = 41
```

must no longer be accepted.

This protects against:

- replay,
- delayed responses,
- concurrent requests,
- stale callbacks,
- race conditions.

---

# 28. Pending Security Transactions

Some operations are multi-step.

Examples:

```text
LOGIN
LOGOUT
SESSION_RENEWAL
LICENSE_REFRESH
KEY_ROTATION
SERVER_TRUST_UPDATE
MACHINE_REGISTRATION
```

These may need durable transaction records.

```text
PendingTransaction

transaction_id
type
state
session_generation
created_at
expires_at
attempt_count
request_reference
created_version
updated_at
```

However, sensitive challenge material should not automatically be persisted.

---

# 29. Transaction State

Example:

```text
CREATED
   │
   ▼
SENT
   │
   ▼
RESPONSE_PENDING
   │
   ├── success → COMMITTED
   │
   ├── retry → RETRY_PENDING
   │
   └── failure → FAILED
```

---

# 30. Crash During Transaction

Suppose:

```text
LOGIN
```

is being committed.

The process crashes.

On restart the system may find:

```text
transaction = RESPONSE_PENDING
```

The Security Authority must reconcile it.

It must not blindly assume:

```text
login failed
```

or:

```text
login succeeded
```

Instead:

```text
UNKNOWN
   │
   ▼
RECONCILIATION
   │
   ├── confirmed success
   ├── confirmed failure
   └── expired/invalid
```

---

# 31. Atomic State Transitions

Security state changes must be atomic.

For example, session renewal should not result in:

```text
new session token
+
old expiration
```

or:

```text
new expiration
+
old token
```

being persisted as a valid combination.

A transaction should update the complete security state atomically.

Conceptually:

```text
BEGIN TRANSACTION

write new session
write new expiration
write new generation
write authorization revision
write security state

COMMIT
```

---

# 32. SQLite Transaction Requirements

Security-sensitive state transitions should use database transactions.

Example:

```text
BEGIN IMMEDIATE;

UPDATE sessions ...
UPDATE authorization ...
UPDATE security_state ...

COMMIT;
```

If any required operation fails:

```text
ROLLBACK
```

No partially committed security transition should be exposed.

---

# 33. Write-Ahead Logging

SQLite WAL mode is appropriate for this type of local application because it can improve concurrency and crash recovery.

However:

> WAL is a durability mechanism, not a security mechanism.

It does not prevent:

- database tampering,
- file replacement,
- rollback,
- malicious local processes.

Integrity protection must exist above SQLite.

---

# 34. Database Integrity

The Security Authority should maintain integrity metadata over critical state.

Conceptually:

```text
Canonical Security State
        │
        ▼
Canonical Serialization
        │
        ▼
Cryptographic MAC / Integrity Tag
        │
        ▼
Stored Record
```

On loading:

```text
Stored State
    │
    ▼
Verify Integrity
    │
 ┌──┴──┐
 ▼     ▼
VALID INVALID
```

An integrity failure must be treated as a security event.

---

# 35. Tampering Detection

The storage subsystem must assume that a local attacker may attempt to modify:

```text
SQLite database
configuration
session state
license state
machine identity
timestamps
security flags
key metadata
```

Therefore:

> **Any locally persisted value that influences authorization must be considered tamper-sensitive.**

The attacker having filesystem access is fundamentally different from a remote attacker.

Encryption alone is insufficient.

---

# 36. Encryption vs Integrity

This distinction is critical.

Encryption provides:

```text
Confidentiality
```

Integrity protection provides:

```text
Authenticity
+
Tamper detection
```

A protected record should therefore conceptually provide:

```text
plaintext
   │
   ▼
Authenticated Encryption
   │
   ├── ciphertext
   └── authentication tag
```

Do not design the storage system around:

```text
AES(ciphertext)
```

alone.

Use an authenticated encryption construction.

---

# 37. Storage Envelope

Sensitive records can use a common envelope:

```text
StorageEnvelope

format_version
record_type
record_id
key_id
algorithm
nonce
ciphertext
authentication_tag
created_at
updated_at
```

Example conceptual representation:

```text
{
    version: 2,
    type: "SESSION",
    key_id: "storage-key-07",
    nonce: "...",
    ciphertext: "...",
    tag: "..."
}
```

The exact representation is an implementation detail.

---

# 38. Associated Data

Some metadata can be authenticated without being encrypted.

For example:

```text
record_type
record_id
schema_version
```

can be authenticated as associated data.

This prevents an attacker from taking:

```text
encrypted_session_record
```

and relabeling it as:

```text
encrypted_license_record
```

without detection.

---

# 39. Rollback Protection

Encryption does not inherently prevent rollback.

An attacker may copy:

```text
valid.db
```

from yesterday and replace today's database.

The cryptographic data may still decrypt correctly.

Therefore the system needs a notion of freshness.

Possible mechanisms include:

```text
generation counters
monotonic counters
backend revisions
secure OS-backed state
server-side sequence numbers
installation-bound state
```

---

# 40. Backend Revision

Authorization state should preferably include a Backend-issued revision.

Example:

```text
authorization_revision = 38
```

If the Backend later reports:

```text
authorization_revision = 42
```

the Security Authority knows the local state is stale.

---

# 41. Local Rollback

If the Security Authority observes:

```text
current revision = 42
stored revision = 37
```

it should not necessarily reject immediately because the local database could legitimately have lost recent state.

Instead it should enter reconciliation:

```text
LOCAL STATE REGRESSED
        │
        ▼
BACKEND RECONCILIATION
        │
        ├── restore current state
        └── security failure
```

---

# 42. Snapshot Restoration

Filesystem snapshots create a similar problem.

Example:

```text
Day 1
license valid

Day 2
license revoked

Day 3
filesystem restored to Day 1
```

The local system might incorrectly believe:

```text
license valid
```

Therefore the Backend remains necessary for authoritative revocation.

---

# 43. Offline Authorization

Offline operation must be explicitly defined.

Possible policy:

```text
ONLINE
  │
  ▼
AUTHORIZED
  │
  ▼
BACKEND UNAVAILABLE
  │
  ▼
DEGRADED
```

The Security Authority may permit limited operation only while:

```text
authorization is still valid
AND
offline grace period has not expired
AND
no revocation is known
AND
security state is trustworthy
```

The exact policy belongs to the authorization design.

---

# 44. Never Treat Network Failure as Authorization

This is a critical rule.

Bad:

```text
Backend unavailable
      ↓
Assume user is authorized
```

Also bad:

```text
Backend unavailable
      ↓
Assume user is unauthorized
```

Instead:

```text
Backend unavailable
      ↓
Determine existing authorization state
      ↓
Apply offline policy
```

---

# 45. Security Events

The storage system should maintain a security event stream.

Example:

```text
SecurityEvent

event_id
event_type
severity
timestamp
session_generation
machine_generation
authorization_revision
transaction_id
result
metadata
```

Events may include:

```text
LOGIN_SUCCESS
LOGIN_FAILURE
SESSION_RENEWED
SESSION_EXPIRED
SESSION_REVOKED
LICENSE_CHANGED
LICENSE_REVOKED
MACHINE_IDENTITY_CHANGED
KEY_ROTATED
SERVER_KEY_CHANGED
INTEGRITY_FAILURE
ROLLBACK_DETECTED
CLOCK_ANOMALY
STORAGE_CORRUPTION
UNAUTHORIZED_IPC
```

---

# 46. Security Event Storage

Security events should be append-oriented.

They should not be treated like mutable state.

For example:

```text
Event 101
LOGIN_SUCCESS

Event 102
LICENSE_REVOKED

Event 103
SESSION_INVALIDATED
```

This provides a history of important transitions.

---

# 47. Event Integrity

Where appropriate, events may be chained:

```text
Event N
    │
    ▼
hash(Event N)
    │
    ▼
Event N+1
```

creating:

```text
Event 1 → Event 2 → Event 3 → Event 4
```

This can make undetected modification more difficult.

However, this is an integrity/audit enhancement, not a replacement for secure storage.

---

# 48. Storage Metadata

The database should contain global metadata:

```text
StorageMetadata

schema_version
format_version
installation_id
database_generation
created_at
last_migration
last_integrity_check
storage_key_version
```

---

# 49. Schema Versioning

Schema changes must be explicitly versioned.

Example:

```text
v1
v2
v3
v4
```

Migration should be deterministic.

The Security Authority must never simply open an unknown schema and assume compatibility.

---

# 50. Migration Security

A migration must preserve security invariants.

For example:

```text
v1
 │
 ▼
validate
 │
 ▼
backup
 │
 ▼
transaction
 │
 ▼
migrate
 │
 ▼
verify
 │
 ▼
commit
```

If migration fails:

```text
rollback
```

The application should not continue with partially migrated security state.

---

# 51. Corrupted Database

Possible conditions:

```text
SQLite corruption
invalid schema
invalid ciphertext
invalid authentication tag
missing required record
inconsistent state
invalid generation
```

These should not be silently repaired.

The system should classify corruption:

```text
RECOVERABLE
SUSPICIOUS
SECURITY_CRITICAL
FATAL
```

---

# 52. Recovery Hierarchy

Recovery should follow this order:

```text
1. Validate current state
2. Attempt atomic recovery
3. Reconcile with Backend
4. Restore trusted state
5. Re-establish identity if permitted
6. Require user intervention
```

Avoid:

```text
delete everything
generate everything again
continue
```

because this can destroy evidence and create security inconsistencies.

---

# 53. Missing Records

Suppose:

```text
SessionRecord = missing
AuthorizationRecord = exists
```

The Security Authority must not infer:

```text
session is valid
```

Likewise:

```text
MachineIdentity = missing
LicenseRecord = valid
```

does not imply:

```text
machine is authorized
```

Security relationships must be internally consistent.

---

# 54. Referential Integrity

Relationships should be explicit.

For example:

```text
Session
   │
   ├── User
   ├── Machine
   └── Authorization
             │
             └── License
```

A session referencing a nonexistent machine identity is invalid.

---

# 55. Concurrent Processes

The architecture must assume that multiple Control Plane processes may accidentally start.

Example:

```text
Control Plane A
       │
       ├── Security Authority
       │
       └── SQLite

Control Plane B
       │
       ├── Security Authority
       │
       └── SQLite
```

The system must prevent two independent Security Authorities from believing they are the same active authority.

Possible mechanisms:

- single-instance lock,
- OS mutex,
- lock file,
- IPC ownership,
- process identity validation.

---

# 56. Storage Locking

Database locking protects database consistency.

It does not necessarily solve:

```text
two independent Control Plane instances
```

both attempting security operations.

Therefore process-level singleton enforcement should exist separately.

---

# 57. Copied Installation

An attacker may copy the application directory.

Example:

```text
Machine A
   ↓
copy directory
   ↓
Machine B
```

If all identity state is purely filesystem-based, Machine B may appear identical.

The architecture should therefore avoid relying solely on:

```text
installation files
```

as the machine identity.

Machine identity should be cryptographically bound to installation/device state where practical.

---

# 58. VM Cloning

VM snapshots and cloning present similar problems.

The system may encounter:

```text
same machine identity
+
different physical environment
```

The Backend should be capable of detecting suspicious duplication.

The Control Plane should report identity inconsistencies rather than silently creating a new identity.

---

# 59. Clock State

The database may persist relevant timestamps, but the Security Authority must not blindly trust the system clock.

Relevant fields:

```text
issued_at
expires_at
renew_after
last_verified_at
```

must be evaluated alongside clock-anomaly detection.

---

# 60. Clock Rollback

Example:

```text
12:00
session valid

system clock → 08:00
```

The Security Authority may detect:

```text
CLOCK_ROLLBACK
```

and transition into a restricted state.

---

# 61. Clock Jump Forward

Example:

```text
12:00 → 18:00
```

This could incorrectly make a session appear expired.

The Security Authority should distinguish:

```text
real expiration
```

from:

```text
clock anomaly
```

where possible.

---

# 62. Monotonic Time

For local duration measurement, prefer a monotonic clock.

Use wall-clock time primarily for:

```text
timestamps
Backend time comparison
human-readable events
absolute expiry
```

Use monotonic time for:

```text
timeouts
retry delays
session-renewal timers
heartbeat intervals
```

---

# 63. Sleep/Hibernation

The system may experience:

```text
ACTIVE
  ↓
SLEEP
  ↓
WAKE
```

Timers may become inaccurate.

After wake:

```text
re-evaluate security state
re-evaluate expiration
re-evaluate network
re-evaluate Backend connectivity
```

Do not blindly continue previous timers.

---

# 64. Local Tampering Model

The storage architecture assumes the attacker may have:

```text
filesystem access
process inspection
debugging capability
database access
application binary access
configuration access
```

Therefore local storage is **not a trusted boundary against the machine owner**.

The goal is to:

- make tampering difficult,
- detect tampering,
- prevent trivial modification,
- require backend cooperation,
- minimize useful secrets exposed locally.

---

# 65. What Local Storage Cannot Protect

No local database can guarantee protection against an attacker who completely controls the machine.

An attacker with sufficient privileges may eventually:

- inspect memory,
- patch binaries,
- hook APIs,
- intercept function calls,
- emulate the Backend,
- modify execution flow.

Therefore the architecture must assume:

> **Local security is a resistance and detection layer, not an absolute trust anchor.**

This aligns with the application's threat model.

---

# 66. Backend as Final Authority

The strongest architecture is:

```text
                Backend
                  │
        ┌─────────┴─────────┐
        │                   │
   Identity Authority   Authorization
        │                   │
        └─────────┬─────────┘
                  │
                  ▼
          Security Authority
                  │
          ┌───────┴───────┐
          ▼               ▼
     Local Storage    Execution Plane
```

The Local Security Storage supports the Security Authority.

It does not replace the Backend.

---

# 67. Storage Access API

Other Control Plane components should not access SQLite directly.

Bad:

```text
RuntimeManager → SQLite
LicenseManager → SQLite
API Server → SQLite
Authentication → SQLite
```

Instead:

```text
             Security Authority
                     │
             Security Storage
                     │
                   SQLite
```

The Security Authority owns security-state persistence.

---

# 68. Example Storage Interface

Conceptually:

```ts
interface SecurityStorage {
  initialize(): Promise<void>;

  getMachineIdentity(): Promise<MachineIdentity | null>;

  saveMachineIdentity(identity: MachineIdentity): Promise<void>;

  getSession(): Promise<SessionRecord | null>;

  commitSession(session: SessionRecord): Promise<void>;

  invalidateSession(reason: string): Promise<void>;

  getAuthorization(): Promise<AuthorizationRecord | null>;

  commitAuthorization(authorization: AuthorizationRecord): Promise<void>;

  getLicense(): Promise<LicenseRecord | null>;

  commitLicense(license: LicenseRecord): Promise<void>;

  recordSecurityEvent(event: SecurityEvent): Promise<void>;

  verifyIntegrity(): Promise<IntegrityResult>;

  recover(): Promise<RecoveryResult>;

  close(): Promise<void>;
}
```

This is conceptual, not a final API.

---

# 69. Security Authority Should Own Transactions

The higher-level Security Authority should not perform:

```text
storage.getSession()
storage.saveSession()
storage.saveLicense()
```

independently for one security transition.

Instead:

```text
Security Authority
       │
       ▼
Security Storage Transaction
       │
       ├── session
       ├── authorization
       ├── license
       └── security state
```

This prevents partial transitions.

---

# 70. Example: Successful Login

Conceptual sequence:

```text
Frontend
   │
   ▼
Security Authority
   │
   ▼
Backend authentication
   │
   ▼
Authentication accepted
   │
   ▼
Authorization/license obtained
   │
   ▼
Validate response
   │
   ▼
BEGIN TRANSACTION
   │
   ├── create SessionRecord
   ├── create AuthorizationRecord
   ├── create LicenseRecord
   ├── update SecurityState
   └── record event
   │
   ▼
COMMIT
   │
   ▼
AUTHORIZED
```

Everything becomes visible atomically.

---

# 71. Example: License Revocation

```text
Backend
   │
   ▼
REVOCATION
   │
   ▼
Security Authority
   │
   ▼
BEGIN TRANSACTION
   │
   ├── License → REVOKED
   ├── Authorization → INVALID
   ├── Session → INVALID/RESTRICTED
   ├── SecurityState → REVOKED
   └── Event → LICENSE_REVOKED
   │
   ▼
COMMIT
```

Only after commit should dependent components receive the new state.

---

# 72. Example: Session Renewal

```text
Session ACTIVE
      │
      ▼
RENEWAL_REQUIRED
      │
      ▼
Backend
      │
      ▼
New session state
      │
      ▼
Validate
      │
      ▼
Atomic persistence
      │
      ▼
ACTIVE
```

If the response is ambiguous:

```text
RENEWAL_UNKNOWN
      │
      ▼
RECONCILE
```

Do not blindly create a second session.

---

# 73. Example: Storage Corruption

```text
Startup
   │
   ▼
Integrity verification
   │
   ▼
FAIL
   │
   ▼
SECURITY_STATE_UNTRUSTED
   │
   ▼
Backend reconciliation
   │
   ├── recover
   │
   ├── re-authenticate
   │
   └── require intervention
```

The Execution Plane should remain unavailable until the Security Authority establishes a valid authorization state.

---

# 74. Startup Sequence

Recommended startup sequence:

```text
Application Start
       │
       ▼
Acquire Single-Instance Lock
       │
       ▼
Initialize Secure Storage
       │
       ▼
Verify Database Integrity
       │
       ▼
Validate Schema
       │
       ▼
Load Machine Identity
       │
       ▼
Load Security State
       │
       ▼
Validate State Consistency
       │
       ▼
Evaluate Time / Expiration
       │
       ▼
Determine Backend Requirement
       │
       ▼
Establish Secure Backend Session
       │
       ▼
Reconcile Authorization
       │
       ▼
Security Authority READY
       │
       ▼
Allow dependent systems to start
```

This is important for the entire Control Plane.

The Execution Plane should not be started merely because the application process started.

---

# 75. Shutdown Sequence

Normal shutdown:

```text
Security Authority
       │
       ▼
Stop new security operations
       │
       ▼
Complete/abort pending transactions
       │
       ▼
Persist required state
       │
       ▼
Flush database
       │
       ▼
Close secure storage
       │
       ▼
Release process lock
```

---

# 76. Emergency Shutdown

If the application crashes:

```text
process disappears
      │
      ▼
SQLite recovery
      │
      ▼
transaction rollback
      │
      ▼
Security Authority startup
      │
      ▼
reconciliation
```

The architecture should rely on atomic transactions rather than assuming graceful shutdown.

---

# 77. Persistence Boundaries

The system should explicitly define what survives restart.

### Must survive

```text
Machine identity
Installation identity
Key metadata
Server trust metadata
Required authorization cache
Required license state
Security event history
Schema metadata
```

### Should generally not survive

```text
Active challenge
Temporary nonce
Transient network state
In-flight request body
Temporary authentication transaction
Ephemeral IPC authorization
```

Unless there is a specific reason.

---

# 78. Secret Minimization

The Security Authority should persist the minimum necessary secret material.

Prefer:

```text
OS secure storage
```

over:

```text
SQLite encrypted blob
```

when the OS provides an appropriate primitive.

If encrypted SQLite storage is used, the encryption key itself must not simply be stored beside the database.

Otherwise:

```text
database
+
key
```

becomes:

```text
database = effectively unprotected
```

---

# 79. Database File Layout

A conceptual layout:

```text
security/
│
├── security.db
├── security.db-wal
├── security.db-shm
│
├── metadata/
│
└── recovery/
```

The exact layout is implementation-dependent.

Access permissions should be restricted to the application identity where supported.

---

# 80. Backup Policy

Security storage should not be casually copied.

A backup containing:

```text
machine identity
session state
encrypted secrets
```

can become a security artifact.

If backups are supported, they must be:

- authenticated,
- encrypted,
- versioned,
- installation-bound where appropriate,
- protected against replay/rollback.

---

# 81. Deletion

Deleting local security state is itself a security operation.

For example:

```text
Logout
```

does not necessarily mean:

```text
delete machine identity
```

Likewise:

```text
Uninstall
```

may require destruction of:

- local session state,
- encryption keys,
- machine credentials,
- cached authorization,
- secure-storage references.

The lifecycle must distinguish:

```text
logout
reset
repair
uninstall
identity replacement
```

---

# 82. Secure Reset

A reset should be explicit.

Example:

```text
SECURITY RESET REQUESTED
        │
        ▼
invalidate session
        │
        ▼
destroy local authorization
        │
        ▼
destroy temporary credentials
        │
        ▼
retain/revoke machine identity according to policy
        │
        ▼
READY FOR REAUTHENTICATION
```

---

# 83. Storage State Machine

The storage subsystem itself can be represented as:

```text
UNINITIALIZED
      │
      ▼
INITIALIZING
      │
      ▼
VERIFYING
      │
 ┌────┴────┐
 ▼         ▼
VALID    INVALID
 │         │
 ▼         ▼
READY    RECOVERY
 │         │
 │     ┌───┴────┐
 │     ▼        ▼
 │  RECOVERED  FAILED
 │     │        │
 └─────┘        ▼
              BLOCKED
```

---

# 84. Security Storage Invariants

The following invariants MUST hold.

### Invariant 1

A session cannot be valid without a valid machine identity.

### Invariant 2

An authorization record cannot be active without an associated valid session or explicitly defined offline authorization state.

### Invariant 3

A license cannot grant capabilities greater than the Backend-issued authorization.

### Invariant 4

Expired authorization cannot become valid solely through local database modification.

### Invariant 5

Integrity failures cannot silently produce valid security state.

### Invariant 6

A stale security generation cannot overwrite a newer generation.

### Invariant 7

A retired cryptographic key cannot become active through ordinary state mutation.

### Invariant 8

Security transitions are atomic.

### Invariant 9

Unknown state is not equivalent to authorized state.

### Invariant 10

Local storage never becomes a higher authority than the Backend.

---

# 85. Concurrency Rules

Security persistence must support concurrent asynchronous operations without allowing stale state to win.

Example:

```text
Request A:
authorization revision 10

Request B:
authorization revision 11
```

If B commits first:

```text
revision = 11
```

A must not subsequently overwrite it with:

```text
revision = 10
```

Therefore writes should use revision/generation checks.

Conceptually:

```sql
UPDATE authorization
SET revision = 11
WHERE revision < 11;
```

The actual implementation may use a stronger transaction mechanism.

---

# 86. Compare-and-Swap Semantics

Security state updates should conceptually support:

```text
expected_generation
+
new_generation
```

Example:

```text
Current generation = 41

Update:
expected = 41
new = 42
```

If current state is already:

```text
42
```

the update fails rather than overwriting the newer state.

---

# 87. Stale Response Protection

Every persisted security transaction should carry enough context to detect:

```text
old session
old authorization revision
old machine generation
old protocol version
```

A response associated with an old generation must not mutate current state.

---

# 88. Data Ownership

The Security Authority owns:

```text
MachineIdentity
SessionRecord
AuthorizationRecord
LicenseRecord
SecurityState
KeyMetadata
TrustMetadata
SecurityEvents
```

The Runtime Manager should receive:

```text
authorization decision
capabilities
execution authorization
```

not direct database access.

---

# 89. API Server Isolation

The localhost API must not directly manipulate storage.

Bad:

```text
HTTP Route
   ↓
SQLite
```

Preferred:

```text
HTTP Route
   ↓
Controller/API Adapter
   ↓
Security Authority
   ↓
Security Storage
```

This ensures every security mutation passes through the authority.

---

# 90. Frontend Isolation

The Frontend should never receive:

- private keys,
- storage encryption keys,
- backend refresh secrets,
- raw cryptographic material,
- internal authorization records.

It receives sanitized state such as:

```text
authenticated
authorized
license status
capabilities
session state
security warnings
```

---

# 91. Execution Plane Isolation

The Execution Plane should not receive:

```text
Backend credentials
machine private keys
storage encryption keys
raw session credentials
```

It receives an authorization contract.

For example:

```text
Execution Authorization
{
    authorization_id,
    execution_session_id,
    capabilities,
    expires_at,
    generation,
    integrity_proof
}
```

The exact contract is defined separately.

---

# 92. Storage Does Not Decide Authorization

This is one of the most important architectural boundaries.

The storage layer answers:

> What security state is persisted?

The Security Authority answers:

> What does that state mean?

The Backend answers:

> What is authoritative?

Therefore:

```text
Storage ≠ Security Authority
Security Authority ≠ Backend
```

---

# 93. Recommended Physical Architecture

```text
                    ┌──────────────────────┐
                    │    Security Authority │
                    │                      │
                    │  State Machine       │
                    │  Policy              │
                    │  Protocol            │
                    │  Trust               │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Security Storage API │
                    └──────────┬───────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
                  ▼                         ▼
             SQLite DB              Secure Key Provider
                  │                         │
                  │                         │
                  └────────────┬────────────┘
                               │
                               ▼
                       Local Security State
```

---

# 94. Recommended Repository Structure

Given the project's **system/subsystem-oriented design philosophy**, the Security Authority should remain encapsulated rather than scattering its persistence implementation throughout the Control Plane.

A possible structure:

```text
security-authority/
│
├── index.ts
│
├── authority/
│   ├── SecurityAuthority.ts
│   ├── SecurityStateMachine.ts
│   └── SecurityPolicy.ts
│
├── protocol/
│
├── trust/
│
├── storage/
│   ├── SecurityStorage.ts
│   ├── SQLiteSecurityStorage.ts
│   ├── migrations/
│   ├── schema/
│   ├── encryption/
│   ├── integrity/
│   ├── recovery/
│   └── transactions/
│
├── identity/
├── session/
├── authorization/
├── licensing/
├── keys/
└── events/
```

The important property is:

> **The rest of the Control Plane should interact with the Security Authority through its public interface rather than reaching into these folders.**

---

# 95. Public Boundary

The entire subsystem should expose something conceptually similar to:

```ts
const security = createSecurityAuthority({
  storage,
  backend,
  trustProvider,
  clock,
});
```

Then:

```ts
await security.initialize();
```

Other systems interact with:

```ts
security.authenticate(...)
security.logout(...)
security.getState()
security.getCapabilities()
security.authorizeExecution(...)
security.refresh()
security.shutdown()
```

They do not interact with:

```ts
SQLite;
SessionRecord;
LicenseRecord;
KeyRecord;
```

directly.

---

# 96. Testing Requirements

The persistence layer must be tested against failure rather than only successful flows.

Minimum scenarios:

```text
normal startup
normal shutdown
crash during write
crash during transaction
power loss simulation
database corruption
ciphertext corruption
authentication-tag corruption
missing record
stale record
duplicate record
schema migration failure
rollback
concurrent update
stale update
key rotation
server key rotation
session expiration
license expiration
license revocation
offline startup
offline renewal
clock rollback
clock jump
sleep/wake
copied database
copied installation
multiple processes
```

---

# 97. Security Property Tests

Tests should verify properties such as:

```text
tampered authorization cannot become valid
tampered license cannot increase capabilities
stale session cannot overwrite current session
old generation cannot overwrite new generation
invalid ciphertext cannot be accepted
invalid integrity tag cannot be accepted
corrupted state cannot silently become authorized
expired authorization cannot be extended locally
```

---

# 98. Failure Philosophy

The storage system should follow:

> **Fail closed with respect to authority, but recover intelligently.**

This does **not** mean:

```text
anything goes wrong → destroy everything
```

It means:

```text
uncertain security state
        ↓
do not grant additional authority
        ↓
attempt safe reconciliation
        ↓
recover if trustworthy
```

---

# 99. Final Architecture

The complete relationship is:

```text
                    BACKEND
                       │
             authoritative state
                       │
                       ▼
              ┌────────────────┐
              │ Security        │
              │ Authority       │
              │                │
              │ Authentication │
              │ Authorization  │
              │ Licensing      │
              │ Trust          │
              │ State Machine  │
              └───────┬────────┘
                      │
                 owns │
                      ▼
              ┌────────────────┐
              │ Local Security │
              │ Storage        │
              │                │
              │ Machine State  │
              │ Session State  │
              │ Auth State     │
              │ License State  │
              │ Key Metadata   │
              │ Trust Metadata │
              │ Events         │
              └───────┬────────┘
                      │
                SQLite + Secure
                  Key Storage
```

The critical boundary is:

```text
Backend
   ↓
Authority
   ↓
Storage
```

and **never**:

```text
Storage
   ↓
Authority
   ↓
"therefore user is authorized"
```

Storage is merely the durable memory of the Security Authority.

---

# 100. Final Design Principles

The Local Security Storage must ultimately obey these rules:

1. **Persist state, not authority.**
2. **Never store secrets unnecessarily.**
3. **Prefer OS-backed secret storage for high-value keys.**
4. **Encrypt sensitive data at rest.**
5. **Authenticate encrypted data.**
6. **Treat tampering as a first-class condition.**
7. **Use generations and revisions to defeat stale state.**
8. **Use atomic transactions for security transitions.**
9. **Never allow stale state to overwrite newer state.**
10. **Never treat unknown state as authorized state.**
11. **Never trust the local database as the final authority.**
12. **Design for crash recovery from the beginning.**
13. **Design for rollback detection.**
14. **Design for key rotation.**
15. **Design for schema migration.**
16. **Separate durable identity from renewable authorization.**
17. **Keep ephemeral security material ephemeral.**
18. **Do not allow other Control Plane subsystems to access security storage directly.**
19. **Do not allow the Frontend or Execution Plane to access security storage.**
20. **Make the Security Authority the sole owner of security-state persistence.**
21. **Use the Backend as the ultimate source of authorization truth.**
22. **When state becomes uncertain, stop granting additional authority and reconcile.**
23. **Assume the local machine can ultimately be hostile.**
24. **Use local protections to increase resistance and detect tampering, not to pretend local trust can be made absolute.**
25. **Keep the entire storage subsystem replaceable behind a stable Security Authority interface.**

The resulting architecture gives the Security Authority something it previously lacked: **a durable, explicitly modeled memory of its security state without turning that memory into the authority itself.**

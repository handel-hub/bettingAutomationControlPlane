# Security Authority Key Management Architecture

**Document:** `security_authority_key_management.md`
**System:** Control Plane — Security Authority
**Status:** Architecture Specification
**Scope:** Key lifecycle, key hierarchy, storage, rotation, derivation, usage, compromise handling, and recovery

---

## 1. Purpose

The Security Authority depends on cryptographic keys for:

- establishing trust with the Backend;
- authenticating the Control Plane;
- protecting local security state;
- protecting IPC with trusted local components;
- validating Backend responses;
- protecting session state;
- protecting license/authorization state;
- detecting tampering;
- preventing replay;
- supporting key rotation;
- establishing machine identity.

This document defines **how cryptographic keys are managed**.

It does not define the cryptographic algorithms themselves in isolation. Algorithm selection belongs to the cryptographic implementation layer.

The central principle is:

> **No single key should be responsible for every security function.**

A compromise of one cryptographic purpose must not automatically compromise every other security boundary.

---

# 2. Design Goals

The key-management architecture must provide:

1. Key separation
2. Least privilege
3. Key lifecycle management
4. Secure persistence
5. Rotation
6. Revocation
7. Crash safety
8. Tamper detection
9. Machine binding
10. Session isolation
11. Backend trust establishment
12. Recovery from partial failures
13. Resistance against replay
14. Resistance against rollback
15. Explicit key ownership
16. Versioned cryptographic protocols

---

# 3. Threat Model

The most important attacker is a local user who has legitimate access to the machine and application.

The attacker may:

- inspect application files;
- copy files;
- modify configuration;
- modify local databases;
- terminate processes;
- restart the application;
- manipulate local state;
- attempt to bypass authorization;
- intercept local IPC;
- invoke localhost APIs;
- modify timestamps;
- restore old filesystem snapshots;
- clone installations;
- debug the process;
- reverse engineer binaries;
- patch executable code.

The attacker is **not assumed to have the Backend's private cryptographic keys**.

This distinction is critical.

The architecture is not attempting to make a desktop application mathematically impossible to reverse engineer.

It is attempting to ensure that:

> **Possessing the application does not give the attacker the cryptographic authority required to manufacture valid authorization.**

---

# 4. Security Authority Key Domains

The Security Authority should maintain several logically independent key domains.

Conceptually:

```text
                    Security Authority
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
       Machine Keys   Storage Keys   Session Keys
             │             │             │
             ▼             ▼             ▼
        Identity       Local State    Runtime Sessions
```

And separately:

```text
             Backend Trust Material
                     │
             ┌───────┴────────┐
             ▼                ▼
       Server Identity    Verification Keys
```

These domains must not be casually interchangeable.

---

# 5. Key Hierarchy

A conceptual hierarchy is:

```text
                 Machine Root Identity
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
       Identity Key              Storage Root
                                     │
                          ┌──────────┼──────────┐
                          │          │          │
                          ▼          ▼          ▼
                     DB State   Credentials   Metadata

                         Session Establishment
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             Backend Session             Local IPC Session
```

The hierarchy is logical rather than necessarily representing direct cryptographic derivation.

In particular:

> **Do not derive every application key from one master key unless there is a strong cryptographic reason to do so.**

Key compromise boundaries should remain independent.

---

# 6. Machine Identity Key

The machine identity represents the installation/device from the perspective of the Backend.

It should have:

```text
machine_id
identity_public_key
identity_private_key
key_version
creation_metadata
status
```

The private component must never be sent to the Backend.

The Backend receives the public identity.

---

# 7. Machine Identity Responsibilities

The machine identity may be used for:

- device registration;
- challenge-response authentication;
- machine binding;
- session establishment;
- proving possession of the registered machine identity;
- detecting copied installations.

It should **not** directly encrypt arbitrary application data.

For example:

```text
Machine Identity Key
        │
        ├── authenticate machine
        ├── sign challenge
        └── establish trust

        X

        encrypt every file
```

This separation reduces the consequences of compromise.

---

# 8. Machine Identity Persistence

The machine identity must survive:

- application restart;
- normal shutdown;
- reboot;
- application update.

It should normally disappear only when the installation is deliberately removed or the machine identity is explicitly reset.

The private key should be stored using the operating system's secure storage facilities where available.

The application should avoid storing raw private key material as ordinary plaintext files.

---

# 9. Machine Identity Creation

Initial installation:

```text
Installer
   │
   ▼
Security Authority initialization
   │
   ▼
Generate machine identity
   │
   ▼
Persist securely
   │
   ▼
Register with Backend
   │
   ▼
Backend associates identity
```

Machine identity creation should be **atomic from the Security Authority's perspective**.

A crash during creation must not result in:

```text
machine_id exists
private key missing
```

or:

```text
private key exists
machine registration metadata missing
```

without the system recognizing the state as incomplete.

---

# 10. Machine Identity Replacement

Identity replacement is a sensitive operation.

Possible causes:

- corruption;
- explicit reinstall;
- administrator-authorized reset;
- machine migration;
- Backend-directed replacement.

It must never silently happen because a local file is missing.

Otherwise an attacker could attempt:

```text
delete identity
      ↓
application generates new identity
      ↓
new identity accepted
      ↓
machine binding bypass
```

Instead:

```text
identity missing
      ↓
UNTRUSTED / RECOVERY_REQUIRED
      ↓
Backend verification
      ↓
authorized replacement
```

---

# 11. Storage Root Key

The Storage Root Key protects sensitive local Security Authority state.

Potentially protected material includes:

- session metadata;
- refresh credentials;
- authorization state;
- license state;
- machine registration metadata;
- protocol state;
- security counters;
- anti-replay state;
- encrypted configuration.

The Storage Root Key must not be used for:

- Backend authentication;
- Execution Plane authorization;
- signing authorization decisions.

---

# 12. Data Encryption Keys

A storage hierarchy may use:

```text
OS protected secret
        │
        ▼
Storage Root Key
        │
        ├── Credential DEK
        ├── Session DEK
        ├── Security State DEK
        └── Configuration DEK
```

Where DEK means **Data Encryption Key**.

This provides compartmentalization.

If one encrypted object becomes problematic, the entire local security store does not necessarily need to be rebuilt.

---

# 13. Key Encryption Keys

Where appropriate:

```text
OS secure storage
       │
       ▼
Key Encryption Key
       │
       ▼
Encrypted Data Keys
       │
       ▼
Encrypted Application Data
```

The important concept is that the application does not need to keep every encryption key permanently exposed in ordinary persistent storage.

---

# 14. Session Keys

Session keys are ephemeral.

They should be established after successful authentication.

Conceptually:

```text
Machine Authentication
        │
        ▼
Trust Establishment
        │
        ▼
Session Key Agreement
        │
        ▼
Authenticated Session
```

Session keys should not be reused indefinitely.

---

# 15. Session Key Properties

Each session should have a unique:

```text
session_id
session_key
protocol_version
creation_time
expiration_time
security_epoch
```

Potentially also:

```text
send_counter
receive_counter
key_version
```

These values provide replay and state-management boundaries.

---

# 16. Session Key Isolation

A session key should not be reused across unrelated channels.

For example:

```text
Frontend ↔ Control Plane
```

should not automatically use the same key as:

```text
Control Plane ↔ Backend
```

and:

```text
Control Plane ↔ Execution Plane
```

should have its own trust context.

The Security Authority therefore treats channels independently.

---

# 17. Backend Trust Keys

The Control Plane needs a mechanism for determining:

> "Am I actually communicating with the legitimate Backend?"

This requires trusted Backend verification material.

For example:

```text
Backend identity
Backend certificate/public key
protocol version
key version
trust status
```

The Backend's private signing key must never exist inside the Control Plane.

---

# 18. Backend Key Rotation

Backend cryptographic keys will eventually need rotation.

The Control Plane therefore cannot assume:

```text
ONE SERVER KEY FOREVER
```

Instead:

```text
Trusted Keys
    │
    ├── key_v1
    ├── key_v2
    └── key_v3
```

During migration, multiple verification keys may temporarily be trusted.

---

# 19. Safe Server Key Rotation

A typical transition:

```text
Old Key
   │
   │ trusted
   ▼
Rotation announced
   │
   ▼
New Key introduced
   │
   ▼
Both temporarily trusted
   │
   ▼
New Key becomes primary
   │
   ▼
Old Key retired
```

The Control Plane must not immediately delete the old key merely because the new key appeared.

Otherwise network or update ordering can break existing installations.

---

# 20. Certificate Rotation

If certificates are used, the same principle applies.

The Security Authority must support:

- certificate expiration;
- renewal;
- overlapping certificates;
- chain changes;
- intermediate certificate changes;
- failed renewal;
- expired certificate;
- invalid certificate;
- revoked certificate.

---

# 21. Key Rotation State Machine

A key can conceptually have:

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
REPLACED
    │
    ▼
RETIRED
    │
    ▼
DESTROYED
```

Not every key needs every state.

---

# 22. Key Destruction

When a key is no longer required:

1. remove active references;
2. invalidate dependent sessions/state;
3. remove encrypted persistent representation;
4. attempt secure memory cleanup where practical;
5. mark the key unavailable;
6. ensure it cannot be accidentally reused.

However:

> Secure deletion from modern storage cannot always be guaranteed at the physical medium level.

The architecture should therefore rely primarily on **cryptographic invalidation and key destruction**, rather than assuming filesystem deletion alone is sufficient.

---

# 23. Memory Exposure

Keys inevitably exist in process memory while being used.

The Security Authority should minimize exposure duration.

Principles:

- load keys only when required;
- avoid unnecessary duplication;
- avoid logging key material;
- avoid serializing raw keys;
- clear sensitive buffers where practical;
- isolate cryptographic operations;
- minimize long-lived plaintext secrets.

---

# 24. Key Logging Prohibition

Never log:

```text
private keys
session keys
refresh credentials
storage keys
derived secrets
plaintext passwords
authentication secrets
```

Even debug logs must not contain them.

---

# 25. Password Handling

The Control Plane should not invent its own password cryptography.

The user's password should be transmitted using an authenticated secure channel established for authentication.

The Control Plane should not:

```text
password
  ↓
custom encryption
  ↓
Backend
```

simply because encryption "looks secure."

Instead, use a standardized authenticated transport/protocol and an established authentication design.

Custom cryptographic protocol design is strongly discouraged.

---

# 26. Cryptographic Context Separation

Cryptographic operations should have explicit purposes.

Conceptually:

```text
AUTHENTICATION
SESSION
STORAGE
IPC
LICENSE
MACHINE_IDENTITY
ANTI_REPLAY
```

Keys or derived keys should be bound to their purpose.

For example:

```text
KDF(
    master/context,
    "CONTROL_PLANE_BACKEND_SESSION"
)
```

rather than:

```text
KDF(master)
```

for everything.

The exact KDF and protocol are implementation decisions.

---

# 27. Security Epoch

The Security Authority should maintain a monotonically advancing **security epoch**.

For example:

```text
epoch = 41
```

A major security transition can increment it:

```text
41 → 42
```

Events that may trigger an epoch change include:

- machine identity replacement;
- forced logout;
- credential compromise;
- Backend-directed invalidation;
- major key rotation;
- security-state recovery.

Existing sessions associated with an older epoch can then be invalidated efficiently.

---

# 28. Anti-Replay Counters

Security-sensitive messages should contain sufficient information to detect replay.

Possible mechanisms include:

```text
message_id
session_id
sequence_number
timestamp
security_epoch
```

The exact mechanism depends on the protocol.

The important principle is:

> A valid old message must not automatically become a valid current message.

---

# 29. Nonces

Where authenticated encryption is used, nonce management is critical.

The system must guarantee the required nonce uniqueness properties of the selected cryptographic construction.

Nonce reuse must never occur merely because:

- the application restarted;
- a counter reset;
- SQLite rolled back;
- a filesystem snapshot was restored.

This is one reason persistent security counters require careful design.

---

# 30. Crash During Key Rotation

Example:

```text
Old key = K1
New key = K2
```

The application crashes halfway through rotation.

It must not end up in an ambiguous state where:

```text
K1 deleted
K2 unavailable
```

or:

```text
database says K2
filesystem contains only K1
```

Rotation must therefore be transactional.

---

# 31. Transactional Key Rotation

Conceptually:

```text
Prepare K2
    │
    ▼
Persist K2
    │
    ▼
Verify K2
    │
    ▼
Mark K2 active
    │
    ▼
Mark K1 retiring
    │
    ▼
Commit
```

Only after successful commit should K1 become eligible for destruction.

---

# 32. Corrupted Key Material

If encrypted key material cannot be decrypted:

```text
KEY_UNAVAILABLE
```

must not automatically mean:

```text
GENERATE_NEW_KEY
```

Generating a new identity may create a security bypass.

Instead:

```text
Key corruption
      │
      ▼
Security Authority enters recovery state
      │
      ▼
Determine whether recovery is authorized
      │
      ├── yes → controlled recovery
      │
      └── no  → secure failure
```

---

# 33. Copied Installation

Consider:

```text
Machine A
   │
   └── installation + identity

copy entire installation

Machine B
   │
   └── copied identity
```

The Backend should detect unexpected reuse of the machine identity.

The Control Plane should not assume:

> "The files exist, therefore this is the original machine."

Machine identity is a cryptographic identity, not merely a UUID in SQLite.

---

# 34. VM Cloning

VM snapshots introduce a similar problem.

Two machines can appear identical:

```text
VM snapshot
   ├── VM A
   └── VM B
```

The Security Authority should cooperate with Backend-side machine identity management to detect duplicate identity use.

---

# 35. Filesystem Rollback

An attacker may restore:

```text
security.db
```

to an older version.

This creates:

```text
Current:
session_epoch = 50

Rollback:
session_epoch = 42
```

Security state must therefore contain mechanisms for detecting rollback where required.

Possible signals include:

- monotonic counters;
- OS-protected state;
- Backend state;
- signed state;
- server-issued epochs.

---

# 36. Local Security State Is Not Authoritative

A critical architectural rule:

> **The local machine must not be the ultimate authority for licensing.**

The local state is a cache/projection of Backend authority.

Therefore:

```text
Local:
LICENSE_VALID
```

does not necessarily mean:

```text
Backend:
LICENSE_VALID
```

The Security Authority must define exactly when cached state may be trusted.

---

# 37. License Keys vs Authorization State

A license identifier and authorization decision should not be treated as the same thing.

For example:

```text
License:
PRO_PLAN

Authorization:
EXECUTION_ALLOWED
```

The Backend determines the relationship.

The Control Plane consumes the resulting authoritative authorization state.

---

# 38. License Cryptography

The Control Plane may receive a signed authorization artifact from the Backend.

Conceptually:

```text
Backend
   │
   ▼
Signed Authorization
   │
   ▼
Security Authority
   │
   ├── signature valid?
   ├── issuer trusted?
   ├── audience correct?
   ├── machine binding correct?
   ├── validity period correct?
   ├── epoch correct?
   └── policy valid?
```

Only after those checks should authorization become active.

---

# 39. Why Signing Matters

Encryption answers:

> "Who can read this?"

Authentication/signatures answer:

> "Who produced this and has it been modified?"

For authorization decisions, authenticity and integrity are usually more important than simply encrypting the data.

Therefore:

> **Do not confuse confidentiality with authorization security.**

---

# 40. Security Authority Does Not Trust Frontend Claims

The Frontend may request:

```text
START_RUNTIME
```

But the Frontend cannot establish authorization.

The flow is:

```text
Frontend
   │
   │ intent
   ▼
Control Plane
   │
   ▼
Security Authority
   │
   │ authorization decision
   ▼
Runtime Manager
```

The Frontend does not provide:

```text
license_valid = true
```

as authoritative state.

---

# 41. Execution Plane Authorization Keys

The Execution Plane should not receive the machine's long-term identity private key.

Instead, the Security Authority should establish a limited authorization context.

Conceptually:

```text
Security Authority
        │
        ▼
Execution Authorization
        │
        ▼
Execution Plane
```

The authorization should be:

- scoped;
- time-bound;
- revocable;
- tied to the current security epoch;
- tied to the current runtime/session where appropriate.

---

# 42. No Long-Term Secret Sharing

Avoid:

```text
Security Authority
        │
        ├── private key
        ▼
Execution Plane
```

unless there is an exceptional reason.

Instead:

```text
Security Authority
        │
        ▼
short-lived authorization material
        │
        ▼
Execution Plane
```

This reduces blast radius.

---

# 43. Local IPC Keys

If the Control Plane exposes IPC to trusted processes, the IPC channel should have its own security context.

The Security Authority should not assume:

> "It is localhost, therefore it is trusted."

A malicious local process may attempt to connect.

The IPC boundary should therefore provide:

- authentication;
- authorization;
- message integrity;
- replay protection;
- process/session binding where appropriate.

---

# 44. Frontend Security

The Frontend is a presentation client.

It should not receive:

- machine private keys;
- storage root keys;
- Backend credentials;
- refresh secrets;
- raw authorization signing material.

The Frontend should receive only the state necessary for presentation.

---

# 45. Key Access Control

Within the Control Plane:

```text
Subsystem
    │
    ▼
Key Manager
    │
    ▼
Authorized operation
```

Subsystems should request operations rather than directly accessing key material.

For example:

```text
sign(data)
```

is preferable to:

```text
getPrivateKey()
```

for most consumers.

This provides an important abstraction boundary.

---

# 46. Key Manager API

Conceptually:

```text
initialize()

getPublicIdentity()

sign(context, data)

verify(context, data, signature)

establishSession()

encrypt(context, data)

decrypt(context, data)

rotate(key_id)

revoke(key_id)

destroy(key_id)

getStatus()
```

The actual API should be smaller wherever possible.

---

# 47. Security Authority and Rust

Rust is useful for implementing sensitive cryptographic infrastructure because it can provide:

- memory safety;
- strong type boundaries;
- fewer classes of memory corruption;
- better isolation of sensitive operations;
- native binary separation.

However:

> **Rust does not make cryptographic secrets magically secure.**

A Rust binary can still be reverse engineered.

The goal is defense in depth.

---

# 48. Cryptographic Library

Do not implement:

- AES;
- ChaCha20;
- RSA;
- Ed25519;
- X25519;
- HKDF;
- AEAD;
- certificate validation

from scratch.

Use mature, audited cryptographic libraries.

The architecture specifies **what cryptographic properties are required**.

The implementation chooses appropriate primitives.

---

# 49. Key Versioning

Every persistent cryptographic object should be capable of identifying its cryptographic version.

For example:

```text
crypto_version = 2
key_version = 7
protocol_version = 4
```

This allows future migration without corrupting old state.

---

# 50. Algorithm Agility

The system should not hard-code assumptions so deeply that changing algorithms requires redesigning the entire Security Authority.

However, unlimited algorithm flexibility is also dangerous.

Prefer:

```text
supported secure profiles
```

rather than arbitrary algorithm negotiation.

---

# 51. Key Compromise

If a key is believed compromised:

```text
COMPROMISED
```

must be treated differently from:

```text
RETIRED
```

A retired key may remain available for historical verification.

A compromised key should generally no longer be trusted for new security decisions.

---

# 52. Compromise Response

Possible sequence:

```text
Compromise detected
       │
       ▼
Increment security epoch
       │
       ▼
Invalidate affected sessions
       │
       ▼
Revoke affected keys
       │
       ▼
Establish replacement keys
       │
       ▼
Re-authenticate
       │
       ▼
Resume authorized operation
```

The exact response depends on which key was compromised.

---

# 53. Key Compromise Blast Radius

The architecture should allow:

```text
Session key compromised
```

without necessarily implying:

```text
Machine identity compromised
```

Likewise:

```text
Storage key compromised
```

should not automatically reveal:

```text
Backend authentication identity
```

This is one of the primary reasons for key separation.

---

# 54. Offline Operation

The Control Plane may temporarily lose Backend connectivity.

Key management must distinguish:

```text
network unavailable
```

from:

```text
authorization revoked
```

Those are fundamentally different states.

Cached authorization may remain usable only according to an explicit policy.

The Security Authority must never silently convert network failure into permanent authorization.

---

# 55. Sleep / Resume

After system sleep:

```text
previous session
      │
      ▼
system suspended
      │
      ▼
system resumes
```

The Security Authority must reassess:

- session validity;
- expiration;
- server time;
- security epoch;
- authorization state;
- pending cryptographic operations.

A session that expired while asleep must not become valid merely because the application was suspended.

---

# 56. Clock Independence

Cryptographic security should not depend exclusively on the local system clock.

The local clock can be:

- incorrect;
- rolled backward;
- jumped forward;
- manipulated;
- unavailable temporarily.

Where expiration is security-critical, Backend-issued time/epochs or monotonic mechanisms should be considered.

---

# 57. Key Storage and SQLite

SQLite may store metadata such as:

```text
key_id
key_version
status
creation_time
rotation_time
encrypted_key_blob
security_epoch
```

SQLite should not become the cryptographic authority.

The Security Authority decides whether stored key metadata is valid.

---

# 58. SQLite Rollback

If the database is restored:

```text
key_version = 9
```

back to:

```text
key_version = 7
```

the Security Authority must detect that the local state is stale where necessary.

This is especially important for:

- anti-replay counters;
- epochs;
- identity state;
- session state;
- revocation state.

---

# 59. Recovery Hierarchy

Security recovery should follow:

```text
Recover safely
      │
      ├── restore existing trusted key
      │
      ├── re-establish Backend trust
      │
      ├── re-authenticate
      │
      └── controlled identity replacement
```

Not:

```text
Anything missing
      │
      ▼
Generate everything again
```

The latter can become a security bypass.

---

# 60. Startup Sequence

The Security Authority should conceptually initialize:

```text
1. Load cryptographic configuration
2. Validate local security storage
3. Validate machine identity
4. Validate key metadata
5. Detect rollback/corruption
6. Load trusted Backend material
7. Establish Backend trust
8. Recover security epoch
9. Validate cached authorization
10. Establish session
11. Publish Security Authority state
```

Only after this should dependent systems be considered authorized.

---

# 61. Shutdown

On shutdown:

```text
stop new security operations
        │
        ▼
finish/abort pending transitions
        │
        ▼
persist required state
        │
        ▼
invalidate ephemeral session material
        │
        ▼
zero sensitive memory where practical
        │
        ▼
shutdown
```

Persistent machine identity must remain.

Ephemeral session keys generally should not.

---

# 62. Security Events

The Key Manager should emit events such as:

```text
MachineIdentityCreated
MachineIdentityValidated
MachineIdentityChanged

KeyCreated
KeyRotated
KeyRetired
KeyRevoked
KeyCompromised

SessionKeyEstablished
SessionKeyExpired
SessionKeyRevoked

BackendTrustChanged

SecurityEpochChanged

KeyStorageCorrupted
KeyRecoveryRequired
```

These events should not contain secrets.

---

# 63. Observability

Logs should describe:

```text
key_id
key version
operation
result
reason
security epoch
correlation ID
```

but never:

```text
private key
plaintext secret
session key
raw credential
```

---

# 64. Failure Policy

Cryptographic failures should default toward **fail closed**.

Examples:

```text
invalid Backend signature
        ↓
reject
```

```text
unknown key version
        ↓
reject / negotiate supported version
```

```text
corrupted private key
        ↓
recovery_required
```

```text
expired authorization
        ↓
authorization denied
```

The system should not silently downgrade security because a stronger mechanism failed.

---

# 65. Downgrade Protection

The Security Authority must prevent:

```text
Protocol v4
    ↓
attacker forces
    ↓
Protocol v1
```

if v1 lacks required security guarantees.

Likewise:

```text
strong crypto
    ↓
attacker
    ↓
plaintext fallback
```

must never happen.

---

# 66. Separation of Responsibilities

The final architecture should resemble:

```text
                 Security Authority
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   Identity Manager  Key Manager   Session Manager
        │                │                │
        └────────────────┼────────────────┘
                         │
                 Authorization Engine
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        Backend Trust        Runtime Authorization
```

The Security Authority is the consumer and coordinator of these mechanisms.

---

# 67. What the Key Manager Must NOT Know

The Key Manager should not know:

- betting logic;
- browser logic;
- Playwright;
- frontend UI;
- file transfers;
- business rules;
- execution scheduling;
- browser synchronization.

It manages cryptographic material.

---

# 68. What the Security Authority Must NOT Do

The Security Authority should not become a giant cryptographic god object.

It should coordinate:

```text
Identity
Keys
Sessions
Authorization
Licensing
Trust
Security State
```

while delegating primitive cryptographic operations to dedicated components.

---

# 69. Core Principle

The most important architectural rule is:

> **The application should never treat "encrypted" as synonymous with "secure."**

Security comes from the combination of:

```text
Identity
+
Authentication
+
Authorization
+
Key separation
+
Integrity
+
Freshness
+
Replay protection
+
Secure storage
+
State validation
+
Backend authority
+
Failure handling
```

Encryption is only one component.

---

# 70. Final Architecture

The resulting conceptual model is:

```text
                         BACKEND
                            │
                  Backend Trust Material
                            │
                            ▼
                  ┌───────────────────┐
                  │ SECURITY AUTHORITY│
                  └─────────┬─────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
   Identity Manager    Key Manager       Session Manager
         │                  │                  │
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                            ▼
                  Authorization Engine
                            │
                 ┌──────────┴──────────┐
                 │                     │
                 ▼                     ▼
          Runtime Authorization    Local IPC
                 │
                 ▼
          EXECUTION PLANE
```

And the key hierarchy:

```text
Machine Identity
       │
       └── Machine Authentication

Storage Root
       │
       ├── Session Metadata
       ├── Credentials
       ├── Security State
       └── Configuration

Backend Trust
       │
       └── Server Verification

Session Keys
       │
       ├── Backend Session
       └── Channel-specific contexts

Execution Authorization
       │
       └── Short-lived runtime authority
```

---

## 71. Architectural Rule to Freeze

The following should be treated as a foundational rule for the Security Authority:

> **Long-lived identity keys establish who the machine is.**
>
> **Backend trust material establishes who the server is.**
>
> **Session keys protect individual authenticated sessions.**
>
> **Storage keys protect local persistent security state.**
>
> **Authorization artifacts prove what the machine is currently allowed to do.**
>
> **Execution authorization grants only the minimum authority required by the Execution Plane.**

No single secret should provide all of these authorities.

That separation is what gives the Security Authority a meaningful security architecture rather than simply adding encryption around the Control Plane.

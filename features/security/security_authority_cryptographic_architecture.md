# Security Authority — Cryptographic Architecture & Key Management

**Document:** `security_authority_cryptographic_architecture.md`
**Status:** Design Specification
**Scope:** Cryptography, key hierarchy, key lifecycle, secure storage, rotation, compromise handling
**Authority:** Security Authority
**Depends on:** Security Authority State Machine, Internal Architecture, Secure Communication Protocol

---

# 1. Purpose

This document defines how cryptography is used inside the Security Authority.

The purpose is **not** to encrypt everything indiscriminately.

The purpose is to establish clear cryptographic boundaries for:

- machine identity
- backend authentication
- session establishment
- message integrity
- message confidentiality
- local secret storage
- key rotation
- server trust
- session invalidation
- tamper detection
- recovery after compromise

The cryptographic architecture must remain independent from the rest of the Control Plane.

Other components should interact with the Security Authority through explicit interfaces rather than directly manipulating cryptographic keys.

---

# 2. Fundamental Principle

The Security Authority should follow:

> **Keys exist for specific security purposes, and each key has a defined owner, lifetime, storage mechanism, and compromise consequence.**

Avoid a design such as:

```text
MASTER_SECRET
    │
    ├── encrypt everything
    ├── authenticate everything
    ├── sign everything
    └── derive everything
```

Instead:

```text
Machine Identity
       │
       ├── Identity Keys
       │
       └── Key Derivation / Session Establishment
                         │
                         ▼
                   Session Keys
                         │
              ┌──────────┴──────────┐
              │                     │
        Encryption              Integrity
```

---

# 3. Threat Model

The cryptographic architecture assumes an attacker may have substantial local access.

The attacker may attempt to:

- inspect application files
- copy configuration
- copy the local database
- copy encrypted secrets
- modify local state
- replay messages
- intercept network traffic
- modify network traffic
- inspect process memory
- attach a debugger
- patch application binaries
- replace application modules
- clone the installation
- restore filesystem snapshots
- manipulate system time
- steal session material
- extract locally stored credentials

The design therefore aims to make unauthorized modification and impersonation **difficult and detectable**, rather than assuming the local machine is a perfect trusted environment.

---

# 4. What Cryptography Can and Cannot Protect

Cryptography can provide:

- confidentiality
- integrity
- authenticity
- freshness
- proof of possession of a secret/private key

Cryptography cannot guarantee that:

- a compromised executable will obey the protocol
- secrets cannot ever be extracted from a running process
- a determined reverse engineer cannot patch local authorization logic
- a fully compromised operating system is trustworthy

Therefore cryptography is one layer of the security architecture.

It is not the entire security model.

---

# 5. Trust Hierarchy

The trust hierarchy is:

```text
                    BACKEND
                       │
             Server-side authority
                       │
                       ▼
             Security Authority
                       │
              Local enforcement
                       │
                       ▼
                Control Plane
                       │
                       ▼
                Execution Plane
```

The Security Authority does not become the ultimate authority over the account or license.

The Backend remains authoritative for server-side authorization.

---

# 6. Cryptographic Domains

The system should maintain separate cryptographic domains.

At minimum:

```text
1. Server Trust
2. Machine Identity
3. Session Security
4. Local Secret Storage
5. Integrity Protection
```

These domains should not share keys unnecessarily.

---

# 7. Server Trust

The Security Authority must have a defined trust anchor for communicating with the Backend.

Conceptually:

```text
Security Authority
       │
       │ trusts
       ▼
Backend Identity
```

This can be established through mechanisms such as:

- standard public-key certificate validation
- pinned trust roots
- signed server configuration
- certificate/public-key pinning where operationally appropriate

The exact deployment mechanism should be selected based on the backend infrastructure.

---

# 8. Server Authentication

The Security Authority must authenticate the Backend before accepting security-sensitive responses.

For example:

```text
Backend says:

LICENSE = VALID
SESSION = ACTIVE
```

The Security Authority must know that this response actually came from the legitimate Backend.

It must not trust:

```text
arbitrary network response
```

simply because the response has the correct JSON/Protobuf structure.

---

# 9. Machine Identity

Each installation should possess a cryptographically meaningful machine identity.

Conceptually:

```text
Installation
     │
     ▼
Machine Identity
     │
     └── private cryptographic material
```

The Backend can associate:

```text
Account
   +
Machine
   +
License
```

into an authorization relationship.

---

# 10. Machine Identity Should Not Be a Plain Identifier

A machine ID such as:

```text
machine_id = "ABC123"
```

is not itself a security credential.

Anyone who learns:

```text
ABC123
```

can reproduce the string.

The actual security property comes from possession of cryptographic material associated with the identity.

Therefore:

```text
machine_id
```

and:

```text
machine_private_key
```

are fundamentally different things.

---

# 11. Machine Identity Key Pair

A conceptual model:

```text
Machine Identity
      │
      ├── machine_id
      │
      ├── public_key
      │
      └── private_key
```

The public key can be registered with the Backend.

The private key remains local.

The Backend can then verify proof that the requesting installation possesses the private key.

---

# 12. Private Key Protection

The private key should never be stored as:

```text
private_key = plaintext file
```

where practical.

Instead, it should be protected using the strongest storage mechanism available on the target operating system.

Possible mechanisms include:

- OS credential/key stores
- platform secure storage
- hardware-backed key storage where available
- encrypted application storage

The system should degrade gracefully when hardware-backed storage is unavailable.

---

# 13. Why OS-Backed Storage Matters

Suppose an attacker copies:

```text
security.db
```

to another machine.

If the machine identity secret is protected using an OS-bound mechanism, copying the database alone should not be sufficient to reproduce the identity.

Conceptually:

```text
Machine A

Database
   +
OS protected key
   ↓
usable


Copy database → Machine B

Database
   +
missing OS key
   ↓
not usable
```

This helps against simple installation cloning.

---

# 14. Machine Identity Creation

Initial startup:

```text
Application
    │
    ▼
Check machine identity
    │
    ├── exists → verify
    │
    └── absent → create
```

Creation should involve:

1. generating cryptographic identity material
2. securely storing the private key
3. generating/storing the public identity
4. registering the identity with the Backend
5. receiving backend confirmation
6. binding the identity to the installation

---

# 15. Machine Identity Corruption

If local identity material becomes corrupted:

```text
identity verification
       │
       ▼
INTEGRITY FAILURE
```

The Security Authority must not silently generate a replacement identity and continue as if nothing happened.

Instead:

```text
CORRUPTED
   │
   ▼
IDENTITY_RECOVERY_REQUIRED
```

Automatic replacement could accidentally create a mechanism for bypassing machine binding.

---

# 16. Machine Identity Replacement

Identity replacement should be an explicit protocol operation.

For example:

```text
Old Identity
     │
     ▼
Backend-approved replacement
     │
     ▼
New Identity
```

The Backend should know that the identity changed.

---

# 17. Session Keys

Machine identity keys should not necessarily be used directly for every application message.

Instead:

```text
Machine Identity
       │
       ▼
Session Establishment
       │
       ▼
Ephemeral Session Keys
```

Session keys provide isolation between sessions.

---

# 18. Session Key Properties

A session key should ideally be:

- unique to a session
- unpredictable
- short-lived
- discarded when the session terminates
- independent from previous sessions

Therefore:

```text
Session A
    ↓
Key A

Session B
    ↓
Key B
```

Compromise of one session should not automatically expose all future sessions.

---

# 19. Forward Secrecy

Where practical, session establishment should use an ephemeral key exchange that provides forward secrecy.

The goal is:

```text
Long-term identity key compromised later
        │
        X
        │
        ▼
Previously captured session traffic
```

should not automatically become decryptable.

This is an important distinction between:

```text
identity authentication
```

and:

```text
session encryption
```

---

# 20. Transport Encryption

The Backend communication should use a modern secure transport such as TLS.

Conceptually:

```text
Control Plane
      │
      │ TLS
      ▼
Backend
```

TLS should provide:

- confidentiality
- server authentication
- transport integrity
- protection against network interception

---

# 21. Application-Level Security Envelope

Even with TLS, security-sensitive application messages should retain explicit protocol metadata.

Example:

```text
SecurityMessage
{
    protocol_version
    message_id
    session_id
    sequence_number
    nonce
    timestamp
    message_type
    payload
}
```

The protocol layer determines how this information is authenticated.

---

# 22. Authenticated Encryption

Where application-level encryption is required, use an authenticated encryption construction.

The desired property is:

```text
ciphertext
    +
authentication tag
```

rather than encryption without integrity.

The receiver must verify authenticity before accepting the plaintext.

Conceptually:

```text
Ciphertext
    │
    ▼
Integrity verification
    │
    ├── FAIL → reject
    │
    ▼
Decryption
    │
    ▼
Plaintext
```

Do not process unauthenticated plaintext.

---

# 23. Encryption Does Not Equal Authentication

This is a critical distinction.

Encryption answers:

> Can an attacker read the message?

Authentication/integrity answers:

> Can an attacker modify or forge the message without detection?

A secure system requires both where confidentiality is necessary.

---

# 24. Message Integrity

Security-sensitive messages must be integrity protected.

For example:

```text
LICENSE_VALID
```

must not be transformable by an attacker into:

```text
LICENSE_VALID_UNTIL_2035
```

without detection.

The protected data should include all security-relevant fields.

---

# 25. Authenticate the Entire Security Context

Do not authenticate only:

```text
payload
```

while leaving:

```text
session_id
machine_id
message_type
sequence_number
```

outside the authenticated region.

An attacker must not be able to change the context surrounding a valid payload.

Conceptually:

```text
Authenticated Data =
    protocol_version
    +
message_type
    +
message_id
    +
session_id
    +
machine_id
    +
sequence_number
    +
nonce
    +
payload
```

---

# 26. Associated Data

Where authenticated encryption is used, protocol metadata that does not need confidentiality can still be authenticated as associated data.

This prevents attacks where:

```text
payload remains valid
```

but:

```text
message context is modified
```

---

# 27. Key Hierarchy

A conceptual hierarchy:

```text
             Root Trust
                 │
       ┌─────────┴─────────┐
       │                   │
Server Trust          Machine Identity
                           │
                           ▼
                   Session Establishment
                           │
              ┌────────────┴────────────┐
              │                         │
       Session Encryption        Session Integrity
```

Local storage encryption can have its own independent key hierarchy.

---

# 28. Local Storage Encryption

Sensitive local information may include:

- refresh/session material
- machine identity metadata
- backend credentials/tokens where unavoidable
- cryptographic configuration
- security state
- encrypted transfer metadata

Sensitive material should be encrypted at rest.

However:

> Encryption at rest does not protect secrets from an attacker who can execute arbitrary code inside the application process.

That limitation must be explicitly accepted.

---

# 29. Storage Encryption Key

The local storage encryption key should not simply be:

```text
SHA256("my-secret-key")
```

or another hardcoded application constant.

A hardcoded secret embedded in a binary is recoverable.

Instead, use platform-protected secret material where practical.

---

# 30. Key Derivation

When a cryptographic key must be derived from a password or another low-entropy secret, use a password-based key derivation function designed for that purpose.

Do not use:

```text
SHA256(password)
```

as a general password-derived encryption key.

Password handling belongs to the authentication protocol rather than arbitrary local encryption logic.

---

# 31. Key Rotation

Keys must have a lifecycle.

Conceptually:

```text
ACTIVE
   │
   ▼
ROTATION_PENDING
   │
   ▼
NEW_KEY_ACTIVE
   │
   ▼
OLD_KEY_RETIRED
```

Rotation should not require breaking every existing session unnecessarily.

---

# 32. Server Key Rotation

The Backend may rotate its cryptographic identity.

The Control Plane must support controlled trust transitions.

Example:

```text
Server Key A
     │
     │ rotation
     ▼
Server Key B
```

The transition must be authenticated.

---

# 33. Machine Key Rotation

Machine identity keys may also require rotation.

Possible reasons:

- suspected compromise
- OS migration
- security policy
- key age
- recovery procedure

The Backend should be informed when identity keys change.

---

# 34. Session Key Rotation

Long-running sessions may rotate session keys.

Conceptually:

```text
Session
 │
 ├── Key 1
 │
 ├── Key 2
 │
 └── Key 3
```

This limits the amount of traffic protected under one key.

The exact rotation policy belongs to the protocol implementation.

---

# 35. Key Versioning

Every persisted cryptographic object should be associated with the key version required to process it.

Example:

```text
encrypted_record
{
    key_version: 4,
    algorithm_version: 2,
    ciphertext: ...
}
```

This allows future migrations without destroying old state.

---

# 36. Key Loss

If a key is permanently lost:

```text
encrypted state
      │
      ▼
cannot decrypt
```

The system must not silently regenerate the key and pretend the old state remains valid.

Instead:

```text
KEY_LOST
   │
   ▼
RECOVERY_REQUIRED
```

---

# 37. Key Compromise

If a machine private key is suspected to be compromised:

```text
Security Authority
      │
      ▼
Compromise detected
      │
      ├── invalidate session
      ├── notify Backend
      ├── revoke old identity
      └── establish replacement identity
```

The exact recovery procedure must be defined by the Backend protocol.

---

# 38. Session Compromise

If session credentials are compromised:

```text
Session compromised
      │
      ▼
Backend/session revocation
      │
      ▼
Local session invalidation
      │
      ▼
Reauthentication
```

A compromised session must not remain valid simply because its original expiry has not been reached.

---

# 39. Replay Protection

Cryptographic integrity alone does not necessarily prevent replay.

For example:

```text
Valid message
      │
      ▼
attacker records it
      │
      ▼
sends it again later
```

The message can still be cryptographically valid.

Therefore the protocol requires:

- nonce handling
- sequence numbers
- session IDs
- expiration
- request IDs
- duplicate detection

---

# 40. Nonce Management

Nonce generation must be centralized enough to prevent accidental reuse.

Avoid having unrelated modules independently generate nonces with incompatible assumptions.

The cryptographic layer should provide safe primitives such as:

```text
createNonce()
```

rather than allowing arbitrary callers to invent nonce formats.

---

# 41. Randomness

All security-sensitive randomness must come from a cryptographically secure random source.

This includes:

- keys
- nonces
- session IDs
- challenge values
- machine identity material
- request identifiers where unpredictability is required

Do not use general-purpose pseudo-random APIs for cryptographic material.

---

# 42. Challenge-Response

Machine authentication may use challenge-response.

Conceptually:

```text
Backend
   │
   │ challenge
   ▼
Control Plane
   │
   │ sign/prove possession
   ▼
Backend
   │
   ▼
verification
```

This allows the Backend to verify possession of the machine's private identity key without receiving that private key.

---

# 43. Password Handling

Passwords should be sent only through the authentication protocol.

The Control Plane should not:

- persist plaintext passwords
- log passwords
- expose passwords to unrelated components
- place passwords into telemetry
- store passwords in SQLite

The Security Authority should minimize password lifetime in memory.

---

# 44. Authentication Credentials vs Session Credentials

These should be treated differently.

```text
Password
   │
   ▼
Authentication
   │
   ▼
Session Credential
```

The password establishes identity.

The session credential represents an established authenticated relationship.

A session credential should not simply be the password encrypted with another key.

---

# 45. Session Tokens

If the protocol uses session tokens, they must be:

- unpredictable
- scoped
- short-lived
- revocable
- bound to the appropriate security context

They should not contain trusted authorization decisions merely because the token is locally decodable.

The Backend remains authoritative.

---

# 46. Avoid Self-Contained Authorization Without Verification

A dangerous pattern would be:

```text
TOKEN = {
    user = John,
    license = premium,
    expiry = 2030
}
```

followed by:

```text
decode(token)
→ premium
→ authorize
```

without verifying an authentic backend signature or equivalent authority.

The Control Plane must not trust attacker-controlled local token contents.

---

# 47. Signed Authorization Artifacts

Where appropriate, the Backend can issue signed authorization artifacts.

Conceptually:

```text
Backend
    │
    ▼
Signed Authorization Artifact
    │
    ▼
Security Authority
    │
    ▼
verify signature
    │
    ▼
accept policy
```

This can allow controlled offline verification without giving the client authority to create authorization.

---

# 48. Authorization Lease

A useful concept is an **authorization lease**.

Example:

```text
Authorization Lease
{
    subject
    machine
    capabilities
    issued_at
    expires_at
    policy_version
}
```

The lease represents:

> The Backend has authorized this local security context until the specified validity boundary.

The local machine cannot extend the lease itself.

---

# 49. Why Authorization Leases Help

They solve the problem:

```text
Backend temporarily unavailable
```

without requiring:

```text
application immediately stops
```

while still ensuring:

```text
offline forever
```

is not possible.

---

# 50. Offline Security Boundary

Example:

```text
Backend last confirmed:
14:00

Lease:
valid until 14:30
```

At 14:15:

```text
Backend unavailable
→ operation may continue according to policy
```

At 14:31:

```text
Backend unavailable
→ lease expired
→ authorization unavailable
```

The exact grace period is a business/security decision.

---

# 51. Local Tampering With Lease

An attacker may attempt:

```text
expires_at = 2099
```

Therefore the lease must be cryptographically protected.

However, local cryptographic protection should be viewed as **tamper resistance**, not an absolute boundary against a fully compromised process.

---

# 52. Tamper Detection

Tamper detection should cover:

```text
encrypted state
configuration
identity metadata
authorization artifacts
security database
protocol metadata
```

A detected integrity violation should produce an explicit security event.

Example:

```text
TamperDetected {
    component
    object
    reason
    timestamp
}
```

Sensitive details should not be unnecessarily exposed to the Frontend.

---

# 53. Anti-Rollback Protection

An attacker may restore an older valid state.

Example:

```text
Day 1
License VALID

Day 2
License REVOKED

Restore Day 1 snapshot
        ↓
License VALID
```

Simple integrity protection does not necessarily detect this.

The system therefore needs anti-rollback mechanisms where required.

Possible sources include:

- Backend-issued monotonically increasing versions
- server-side state
- secure monotonic counters where available
- signed state versions
- server reconciliation

---

# 54. Snapshot and VM Cloning

A machine snapshot can contain:

```text
machine identity
session state
encrypted secrets
configuration
```

If restored or cloned, the Security Authority must detect or reconcile the identity.

The Backend should remain capable of determining:

```text
same machine
```

versus:

```text
cloned identity
```

according to the chosen machine identity policy.

---

# 55. Cryptographic Erasure

When sensitive session material is no longer needed, it should be removed from memory where practical.

Examples:

```text
session keys
temporary credentials
decrypted secrets
challenge values
```

However, memory zeroization is a defense-in-depth measure, not a guarantee against a privileged debugger or hostile operating system.

---

# 56. Rust Boundary

Security-sensitive cryptographic operations are strong candidates for Rust.

Potential Rust responsibilities:

```text
cryptographic primitives
key handling
secure serialization
integrity verification
secure storage adapters
protocol cryptographic envelope
```

Node.js can orchestrate:

```text
authentication workflow
state transitions
network communication
application lifecycle
events
```

The exact split should be decided after profiling and threat analysis.

---

# 57. Rust Does Not Automatically Make the System Secure

Moving code from JavaScript to Rust can increase:

- memory safety
- binary complexity
- reverse-engineering effort
- resistance to casual modification

But:

```text
Rust ≠ cryptographic security
```

A flawed protocol implemented in Rust remains flawed.

Protocol correctness comes first.

---

# 58. WebAssembly

WebAssembly may be appropriate for deterministic processing or portability.

However, it should not be treated as a secure secret container.

A WASM module shipped to the attacker is still available to the attacker.

Therefore:

```text
WASM
```

is not a substitute for:

```text
Backend authority
```

or:

```text
secure key storage
```

---

# 59. Key Access Boundary

Other Control Plane modules should not receive raw private keys.

Prefer:

```text
Security Authority
      │
      │ sign(data)
      ▼
Crypto subsystem
      │
      ▼
signature
```

instead of:

```text
Security Authority
      │
      └── private_key → arbitrary module
```

This dramatically reduces accidental exposure.

---

# 60. Cryptographic API

A conceptual API:

```text
machineIdentity.getPublicIdentity()

machineIdentity.sign(data)

session.create()

session.encrypt(data)

session.decrypt(data)

integrity.protect(data)

integrity.verify(data)

keyManager.rotate()

keyManager.status()

secureStorage.put()

secureStorage.get()
```

Raw keys should remain internal.

---

# 61. Security-Critical API Restrictions

Avoid APIs such as:

```text
setPrivateKey()
setLicense()
setSession()
setAuthorized()
disableVerification()
```

These create dangerous mutation paths.

Security state should be derived from authenticated events and validated transitions.

---

# 62. Key Lifecycle

Every key should conceptually follow:

```text
GENERATED
    │
    ▼
PROVISIONED
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
REVOKED
    │
    ▼
DESTROYED
```

Not every key necessarily requires every state.

---

# 63. Cryptographic Failure States

The Security Authority should distinguish:

```text
CRYPTOGRAPHIC_FAILURE
KEY_UNAVAILABLE
KEY_CORRUPTED
KEY_COMPROMISED
CERTIFICATE_INVALID
TRUST_FAILURE
INTEGRITY_FAILURE
```

These should not all collapse into:

```text
UNKNOWN_ERROR
```

because recovery behavior differs.

---

# 64. Secure Storage Failure

Suppose the Security Authority cannot retrieve its machine private key.

It must not:

```text
generate random replacement
→ continue session
```

unless the replacement protocol explicitly authorizes that.

Instead:

```text
KEY_UNAVAILABLE
      │
      ▼
SECURITY_RECOVERY_REQUIRED
```

---

# 65. Cryptographic Protocol Failure

If a Backend response fails cryptographic verification:

```text
Backend Response
       │
       ▼
Verification
       │
       X
       │
       ▼
CRYPTOGRAPHIC_FAILURE
```

The response must never be partially processed.

For example, do not:

```text
read license = premium
then
verify signature
```

The entire security artifact must be verified before its claims are trusted.

---

# 66. Cryptographic Verification Ordering

Preferred order:

```text
Receive
  │
  ▼
Parse safely
  │
  ▼
Validate structural constraints
  │
  ▼
Verify cryptographic authenticity
  │
  ▼
Verify freshness/session/context
  │
  ▼
Apply state transition
```

Never:

```text
Receive
  ↓
Apply authorization
  ↓
Verify cryptography
```

---

# 67. Security Authority and SQLite

SQLite can store metadata such as:

```text
machine_id
key_version
session metadata
authorization lease metadata
protocol version
security events
```

But SQLite itself must not become the source of authority.

For example:

```text
SQLite:
license = VALID
```

does not mean:

```text
license is actually valid
```

It means:

```text
this is the last locally persisted security state
```

which must be validated according to policy.

---

# 68. Persistence Model

Persist only what is necessary.

Avoid storing:

```text
plaintext passwords
unnecessary session secrets
raw private keys
temporary plaintext credentials
```

Persist:

```text
references
encrypted state
metadata
versions
integrity-protected records
```

where possible.

---

# 69. Cryptographic Audit Events

The Security Authority should record events such as:

```text
MachineKeyCreated
MachineKeyRotated
MachineKeyRevoked

SessionKeyCreated
SessionKeyExpired

ServerTrustChanged
CertificateRotated

IntegrityFailure
KeyFailure
TamperDetected
```

Logs must not contain:

- private keys
- passwords
- session tokens
- plaintext credentials
- decrypted sensitive payloads

---

# 70. Logging Security Failures

Security events should contain enough information to diagnose the failure without leaking secrets.

Good:

```text
SESSION_REJECTED
reason = stale_session
session_id = redacted/reference
```

Bad:

```text
session_token = abcdefgh...
```

---

# 71. Compromise Hierarchy

Not all compromises have the same severity.

Conceptually:

```text
Network compromise
       │
       ▼
Session compromise
       │
       ▼
Machine credential compromise
       │
       ▼
Application process compromise
       │
       ▼
Operating-system compromise
```

Each requires a different response.

---

# 72. Network Attacker

A network attacker should not be able to:

- read protected traffic
- modify authenticated messages
- impersonate the Backend
- replay expired sessions

assuming the underlying cryptographic transport is correctly implemented.

---

# 73. Local Application Attacker

A local attacker with the ability to patch the application is a harder problem.

The goal becomes:

```text
make unauthorized modification difficult
+
make security state difficult to forge
+
retain Backend authority
+
detect anomalous state
```

This is where:

- Rust
- binary hardening
- integrity checks
- secure storage
- backend validation
- short-lived authorization
- machine binding

become defense-in-depth mechanisms.

---

# 74. The Backend Must Remain Necessary

The cryptographic architecture must never accidentally create a fully offline authorization mechanism that can be permanently cloned.

For example, avoid:

```text
License artifact
      │
      ▼
valid forever
      │
      ▼
local verification
      │
      ▼
unlimited operation
```

unless that is explicitly intended.

For subscription software:

```text
Backend
   │
   ▼
authorization lease
   │
   ▼
limited local validity
```

is substantially stronger.

---

# 75. Security Objective

The desired attacker experience is not:

> "It is mathematically impossible to crack."

That is unrealistic for software executing on the attacker's machine.

The practical objective is:

> "Bypassing the subscription requires defeating multiple independent security mechanisms rather than changing one local boolean or configuration value."

For example:

```text
Patch authorization check
        ↓
Backend session still required

Patch local license state
        ↓
Integrity verification fails

Copy installation
        ↓
Machine identity unavailable

Replay old authorization
        ↓
Session / lease / nonce invalid

Modify expiry
        ↓
Backend reconciliation detects stale state
```

This is the appropriate security posture for the threat model.

---

# 76. Final Architecture

The complete cryptographic relationship becomes:

```text
                         BACKEND
                            │
                  Server Authentication
                            │
                  Account / License State
                            │
                            ▼
                  ┌─────────────────────┐
                  │  Security Authority │
                  │                     │
                  │  Machine Identity  │
                  │        │            │
                  │        ▼            │
                  │  Session Establish  │
                  │        │            │
                  │        ▼            │
                  │   Session Keys      │
                  │        │            │
                  │   ┌────┴────┐       │
                  │   ▼         ▼       │
                  │ Encrypt   Integrity │
                  │                     │
                  │ Key Management      │
                  │ Secure Storage      │
                  │ Tamper Detection    │
                  │ Replay Protection   │
                  └──────────┬──────────┘
                             │
                    Authorization State
                             │
                             ▼
                       CONTROL PLANE
                             │
                             ▼
                       EXECUTION PLANE
```

---

# 77. Core Rules

The implementation should preserve these rules:

1. **Never hardcode security secrets.**
2. **Never treat machine IDs as secrets.**
3. **Never expose private keys to arbitrary modules.**
4. **Never trust encrypted data without authentication/integrity verification.**
5. **Never accept a cryptographically valid message from the wrong session.**
6. **Never accept stale security messages.**
7. **Never use local persisted state as ultimate authorization authority.**
8. **Never silently regenerate lost machine identity.**
9. **Never extend an authorization lease locally.**
10. **Never log passwords, tokens, private keys, or decrypted secrets.**
11. **Never use encryption without considering integrity/authentication.**
12. **Never assume TLS alone solves application security.**
13. **Never assume Rust makes a protocol secure.**
14. **Never allow the Frontend to directly mutate security state.**
15. **Never allow the Execution Plane to become an authorization authority.**
16. **Never allow an ambiguous security transition to become implicit authorization.**
17. **Always bind security messages to the correct session and machine context.**
18. **Always support key/version rotation as part of the design rather than as an afterthought.**
19. **Always treat local tampering as a realistic possibility.**
20. **Keep the Backend as the ultimate authority for subscription and account authorization.**

---

# 78. Result

With this architecture, the Security Authority becomes more than an encryption module.

It becomes the **cryptographic trust boundary of the Control Plane**:

```text
Identity
   ↓
Authentication
   ↓
Authorization
   ↓
License
   ↓
Session
   ↓
Cryptographic Protection
   ↓
Operational Capability
```

And critically, the architecture does **not** depend on one secret, one binary, one database flag, or one authentication check.

It creates a chain of independently validated security assumptions, which is exactly what we want for a local application whose primary threat is an authorized user attempting to bypass its subscription/authorization mechanism.

# Tamper Detection & Application Integrity Architecture

**Document:** `tamper_detection_and_application_integrity_architecture.md`
**System:** Runtime Synchronization Platform — Control Plane
**Subsystem:** Security Authority
**Status:** Architecture Specification
**Scope:** Control Plane application integrity, tamper detection, and security-state integrity

---

# 1. Purpose

The Security Authority operates under an important assumption:

> **The local machine is not a trusted environment.**

The user legitimately controls the machine on which the Control Plane executes. Therefore, the Control Plane cannot rely solely on filesystem permissions, process boundaries, hidden variables, JavaScript obfuscation, or local configuration files to establish trust.

A sufficiently capable local attacker may:

- inspect application files;
- modify binaries;
- modify JavaScript;
- patch native modules;
- modify configuration;
- modify local databases;
- alter security-state files;
- replace dependencies;
- restore older application versions;
- clone an installation;
- manipulate the system clock;
- attach a debugger;
- terminate processes;
- intercept local IPC;
- modify the application while it is not running;
- modify the application while it is running;
- attempt to bypass authorization decisions.

The purpose of this architecture is **not to make reverse engineering impossible**.

That is not a realistic objective for software executing on a machine controlled by the user.

The objective is:

> **Make unauthorized modification detectable, make security decisions difficult to bypass, and ensure that detected integrity violations cause the Security Authority to fail closed.**

The architecture therefore treats integrity as another input into the Security Authority's authorization state.

---

# 2. Security Objective

The system must be able to distinguish between:

```text
Expected Application State
        │
        ├── expected binaries
        ├── expected native modules
        ├── expected security components
        ├── expected configuration
        ├── expected protocol implementation
        └── expected security storage
```

and:

```text
Unexpected Local State
        │
        ├── modified executable
        ├── modified security code
        ├── replaced dependency
        ├── modified configuration
        ├── modified security database
        ├── rollback
        ├── cloned installation
        └── invalid runtime integrity
```

The Security Authority must never interpret:

```text
"the application is running"
```

as:

```text
"the application is trustworthy."
```

Instead:

```text
Application Running
        │
        ▼
Integrity Assessment
        │
        ├── VALID
        │
        └── INVALID / UNKNOWN
```

Integrity becomes a security condition.

---

# 3. Threat Model

## 3.1 Primary attacker

The primary attacker is a local user attempting to bypass the application's subscription/authorization system.

The attacker has:

- full access to application files;
- normal user access to the machine;
- ability to inspect processes;
- ability to modify files they control;
- ability to copy the application;
- ability to modify local configuration;
- ability to inspect network traffic;
- ability to reverse engineer binaries.

The attacker does **not** necessarily possess:

- backend private keys;
- backend administrative credentials;
- server-side signing keys;
- infrastructure access.

---

# 4. Important Security Boundary

The most important architectural distinction is:

```text
                TRUSTED BY BACKEND
                       │
                       ▼
              Backend Authority
                       │
                       │ cryptographic protocol
                       ▼
              Security Authority
                       │
                       │ authorization contract
                       ▼
              Execution Plane
```

The Security Authority must not establish authorization solely from local information.

For example:

```text
license.json
{
    "licensed": true
}
```

is not an authorization mechanism.

Likewise:

```text
if (licenseValid) {
    startExecution();
}
```

is not sufficient protection when the attacker can modify the application.

The important question is:

> **Can an attacker modify the local application so that the Security Authority accepts an unauthorized state?**

The architecture therefore attempts to make that modification detectable and to ensure that authorization ultimately depends upon cryptographically verifiable backend authority.

---

# 5. Security Principles

## 5.1 Fail closed

If integrity cannot be established:

```text
UNKNOWN
```

must not become:

```text
AUTHORIZED
```

Instead:

```text
UNKNOWN
    │
    ▼
RESTRICTED
```

or:

```text
SECURITY_FAILURE
```

depending on the circumstance.

---

## 5.2 Detection is not prevention

Tamper detection does not prevent modification.

It provides:

```text
Modification
     ↓
Detection
     ↓
Security response
```

rather than:

```text
Modification
     ↓
Impossible
```

The latter is unrealistic on a machine controlled by the attacker.

---

## 5.3 Backend authority remains authoritative

Local integrity does not replace backend authorization.

The following are separate:

```text
Application Integrity
        +
Machine Identity
        +
Authenticated Session
        +
License Authorization
        +
Protocol Integrity
        =
Operational Authorization
```

---

## 5.4 Security-critical code must be minimized

The more code participates directly in security decisions, the larger the attack surface.

Therefore:

```text
Security Authority
```

should be relatively small and isolated.

Business features should not directly implement authorization.

---

# 6. Integrity Domains

The application should not be treated as one enormous file.

Integrity should be divided into domains.

```text
Application
│
├── Security Authority
│   ├── security executable
│   ├── cryptographic module
│   ├── protocol implementation
│   └── security configuration
│
├── Control Plane Core
│
├── Runtime Manager
│
├── File Transfer Service
│
├── API Server
│
├── Frontend
│
├── Native Modules
│
├── WebAssembly Modules
│
├── Dependencies
│
└── Configuration
```

Not every component requires the same integrity policy.

---

# 7. Critical Integrity Domain

The most sensitive domain is the Security Authority itself.

Example:

```text
SECURITY_CRITICAL
```

may include:

- authentication protocol implementation;
- authorization evaluation;
- license validation;
- session handling;
- cryptographic operations;
- backend trust anchors;
- machine identity handling;
- security-state persistence;
- integrity verification;
- tamper response logic.

Modification of these components should be considered **high severity**.

---

# 8. Protected Components

A manifest should define which components participate in integrity verification.

Example conceptual manifest:

```text
Application Integrity Manifest

application_version
protocol_version
manifest_version

security_authority
security_authority_hash
security_authority_signature

native_modules[]
wasm_modules[]
critical_resources[]

dependency_manifest_hash

backend_trust_anchor
certificate_metadata

minimum_supported_version
```

The manifest itself must not be trusted simply because it exists locally.

---

# 9. Integrity Manifest Trust

A dangerous architecture would be:

```text
application
    │
    ▼
read manifest
    │
    ▼
calculate hashes
    │
    ▼
compare against manifest
```

because an attacker could modify:

```text
application
+
manifest
```

together.

Instead, the expected integrity information must ultimately originate from an authority the attacker cannot modify.

Conceptually:

```text
Backend / Release Authority
          │
          ▼
Signed Integrity Manifest
          │
          ▼
Control Plane
          │
          ▼
Local Verification
```

The local application may cache the manifest, but the cryptographic authenticity of the manifest must be independently verifiable.

---

# 10. Digital Signatures

Hashes answer:

> "Is this file equal to this expected value?"

Digital signatures answer:

> "Did an authorized signing authority approve this expected value?"

Therefore the model should be:

```text
Component
    │
    ▼
SHA-256 / cryptographic digest
    │
    ▼
Expected Digest
    │
    ▼
Signed Manifest
```

The Security Authority verifies:

```text
Signature
     +
Manifest
     +
Component Hash
```

rather than trusting a locally supplied hash.

---

# 11. Hashing

Cryptographic hashes should be used for integrity measurement.

A component:

```text
component.bin
```

produces:

```text
H(component.bin)
```

For example:

```text
SHA-256(component.bin)
```

The resulting digest is compared with the expected digest.

The exact hash algorithm should be defined at the protocol level rather than scattered throughout the implementation.

---

# 12. Integrity Verification Levels

Integrity verification should operate at multiple levels.

## Level 1 — Installation Integrity

Performed during installation.

Checks:

- package authenticity;
- signed manifest;
- component hashes;
- expected files;
- unexpected critical files;
- version compatibility.

---

## Level 2 — Startup Integrity

Performed before the application becomes operational.

Conceptually:

```text
Process Start
     │
     ▼
Security Authority Initialization
     │
     ▼
Verify Security Components
     │
     ▼
Verify Critical Dependencies
     │
     ▼
Verify Security Storage
     │
     ▼
Establish Backend Trust
     │
     ▼
Authenticate
     │
     ▼
Authorize
     │
     ▼
Execution Plane may start
```

---

## Level 3 — Runtime Integrity

Critical components may be revalidated while the application is running.

The frequency should not be arbitrary.

Possible triggers include:

- security-sensitive state transition;
- session renewal;
- license renewal;
- execution-plane authorization;
- unexpected process event;
- configuration change;
- integrity subsystem request.

---

## Level 4 — Update Integrity

Every update must be treated as a security-sensitive transition.

```text
Old Version
    │
    ▼
Update Package
    │
    ▼
Signature Verification
    │
    ▼
Manifest Verification
    │
    ▼
Component Verification
    │
    ▼
Atomic Installation
    │
    ▼
Post-update Integrity Check
    │
    ▼
New Version
```

---

# 13. Startup Integrity Sequence

A conceptual startup sequence:

```text
Application starts
        │
        ▼
Minimal bootstrap
        │
        ▼
Security Authority starts
        │
        ▼
Verify security authority
        │
        ├── FAIL ──► SECURITY_FAILURE
        │
        ▼
Verify integrity manifest
        │
        ├── FAIL ──► SECURITY_FAILURE
        │
        ▼
Verify critical modules
        │
        ├── FAIL ──► SECURITY_FAILURE
        │
        ▼
Load security state
        │
        ▼
Verify security state integrity
        │
        ├── FAIL ──► SECURITY_FAILURE
        │
        ▼
Establish backend trust
        │
        ▼
Authenticate
        │
        ▼
Authorize
        │
        ▼
Control Plane operational
```

The Execution Plane must not be started before the required security checks succeed.

---

# 14. Runtime Integrity

Runtime verification should distinguish between:

```text
Integrity Valid
Integrity Invalid
Integrity Unknown
Integrity Verification Failed
```

These are not necessarily equivalent.

For example:

### Valid

Expected component verified successfully.

### Invalid

Component was measured and does not match the expected digest.

### Unknown

Verification could not be completed.

### Verification Failed

The verification mechanism itself encountered an error.

The Security Authority must define explicit behavior for each.

---

# 15. Integrity State Machine

The Security Authority can maintain an integrity state:

```text
UNKNOWN
   │
   ▼
VERIFYING
   │
   ├───────────────┐
   │               │
   ▼               ▼
VALID           INVALID
   │               │
   │               ▼
   │          SECURITY_FAILURE
   │
   ▼
MONITORED
```

A temporary verification failure may instead produce:

```text
VALID
  │
  ▼
DEGRADED
  │
  ├── recover
  │
  └── SECURITY_FAILURE
```

The exact transition depends on why verification failed.

---

# 16. Tamper Classification

Not every anomaly should be treated identically.

## Category A — Critical Tampering

Examples:

- Security Authority executable modified;
- cryptographic module replaced;
- authorization logic modified;
- backend trust anchor modified;
- integrity verifier modified;
- security protocol implementation modified.

Response:

```text
Immediate security failure
Execution authorization revoked
Execution Plane stopped/restricted
Security event recorded
Backend notified when possible
```

---

## Category B — Significant Tampering

Examples:

- critical configuration modified;
- native dependency changed;
- protocol version manipulated;
- security database altered.

Response:

```text
Restricted state
Revalidation
Possible session invalidation
Backend verification
```

---

## Category C — Non-critical Modification

Examples:

- frontend resource changed;
- cache corruption;
- temporary file anomaly.

Response depends on whether that component has security significance.

---

# 17. Configuration Integrity

Configuration must be divided into:

```text
Security-sensitive configuration
```

and:

```text
Non-security configuration
```

Examples of security-sensitive configuration:

- backend endpoint;
- trust anchors;
- protocol versions;
- cryptographic parameters;
- authorization policy;
- security storage location;
- machine identity metadata.

An attacker must not be able to change:

```text
backend = attacker.example
```

and have the Security Authority blindly trust it.

---

# 18. Security Configuration Authentication

Sensitive configuration should have authenticated integrity.

Conceptually:

```text
Configuration
      │
      ▼
Canonical serialization
      │
      ▼
Hash / MAC / signature
      │
      ▼
Protected storage
```

When loaded:

```text
Load configuration
       │
       ▼
Canonicalize
       │
       ▼
Verify integrity
       │
       ├── invalid
       │      ↓
       │  SECURITY_FAILURE
       │
       ▼
Accept
```

---

# 19. Local Security Storage Integrity

The Local Security Storage architecture must be treated as part of the security boundary.

The Security Authority must detect:

- modified records;
- deleted records;
- unexpected records;
- invalid cryptographic metadata;
- rollback;
- inconsistent state;
- impossible state transitions.

For example:

```text
AUTHORIZED
```

must not simply be writable as:

```text
UNAUTHORIZED → AUTHORIZED
```

inside SQLite.

The database is storage, not authority.

---

# 20. Anti-Rollback Protection

A particularly important threat is:

```text
Valid State
   │
   ▼
Attacker copies old valid state
   │
   ▼
Restore old state
   │
   ▼
Application believes state is valid
```

Therefore security state should contain monotonic metadata where appropriate.

Examples:

```text
state_version
security_epoch
session_generation
license_generation
protocol_generation
```

The Security Authority can reject states that move backwards when rollback is not legitimate.

---

# 21. Machine Identity and Integrity

Machine identity must be treated independently from application integrity.

These are different questions:

```text
Is this the expected application?
```

and:

```text
Is this the expected machine identity?
```

A valid application copied to another machine must not automatically inherit authorization.

Likewise:

```text
machine identity
+
application identity
+
backend authorization
```

must form a coherent security context.

---

# 22. Installation Copying

Scenario:

```text
Machine A
   │
   ▼
Valid installation
   │
   ▼
Copy files
   │
   ▼
Machine B
```

The copied application must not automatically become an authorized installation.

Machine-bound credentials and backend authorization should prevent this.

---

# 23. VM and Image Cloning

The architecture must account for:

```text
VM/Image A
    │
    ▼
Clone
    │
    ▼
VM/Image B
```

If machine identity is persisted inside the image, cloning can duplicate it.

Therefore machine identity should have a lifecycle that allows the backend to detect suspicious duplication.

Possible backend observation:

```text
same machine identity
        │
        ├── device A
        └── device B
```

This should trigger security policy rather than automatically granting both instances authorization.

---

# 24. Process-Level Tampering

A local attacker may attempt to interfere with the running process.

Potential scenarios:

- process termination;
- library replacement;
- debugger attachment;
- memory modification;
- IPC interception;
- process injection;
- runtime patching.

The architecture should not assume that JavaScript-level checks alone can withstand a determined local attacker.

Security-sensitive components should therefore have stronger isolation and native implementation where justified.

---

# 25. Rust Security Boundary

Rust can be used strategically for security-sensitive components.

Suitable candidates include:

```text
Security Authority Core
Cryptographic protocol implementation
Machine identity handling
Integrity verification
Secure storage primitives
Native IPC authentication
License-token verification
```

The purpose is not:

> "Rust makes the application unhackable."

It does not.

The objective is to increase the cost of:

- static analysis;
- patching;
- trivial modification;
- runtime manipulation;
- extraction of security-critical logic.

Rust therefore acts as **hardening**, not as the root of trust.

---

# 26. Node.js Boundary

Node.js can continue handling:

- HTTP;
- WebSocket;
- API routing;
- application orchestration;
- filesystem management;
- UI integration;
- non-critical business logic.

However:

```text
Node.js code
```

should not become the only place where the final authorization decision can be trivially patched.

For example, avoiding architecture such as:

```javascript
if (license.valid) {
  startExecution();
}
```

as the ultimate security barrier.

---

# 27. Security Authority and Native Core

A stronger conceptual architecture is:

```text
                 Control Plane
                      │
          ┌───────────┴───────────┐
          │                       │
      Node Layer             Security Authority
          │                       │
          │                 ┌─────┴─────┐
          │                 │           │
          │              Rust Core   Crypto
          │
          ▼
      Application
```

The Node layer requests security decisions.

The Security Authority independently evaluates security state.

---

# 28. Execution Plane Protection

The Execution Plane must not receive:

```text
"start"
```

merely because the Control Plane wants it.

Instead, it should receive an authorization artifact derived from the Security Authority.

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

The Execution Plane validates the authorization according to its contract.

This prevents the Control Plane's general application logic from becoming the only authorization boundary.

---

# 29. Authorization Artifact

An authorization artifact could conceptually contain:

```text
authorization_id
session_id
machine_identity
application_version
execution_capabilities
license_generation
issued_at
expires_at
security_epoch
protocol_version
nonce
signature
```

The exact format belongs in the Security Authority ↔ Execution Plane Authorization Contract.

The important principle is:

> **Authorization should be explicit and time-bounded rather than implied by process state.**

---

# 30. Tamper Detection During Active Execution

Suppose:

```text
Execution Plane running
```

and later:

```text
Security Authority detects critical tampering
```

The correct response is not:

```text
continue execution
```

because authorization has become untrustworthy.

Instead:

```text
Tamper detected
      │
      ▼
Security Authority
      │
      ├── invalidate authorization
      │
      ├── revoke execution capability
      │
      ▼
Execution Plane
      │
      ▼
Restricted / stopped
```

The exact shutdown semantics belong to the Execution Plane contract.

---

# 31. Tamper Detection and Backend Communication

When tampering is detected, the Security Authority should attempt to notify the backend.

For example:

```text
IntegrityViolation
```

could contain:

```text
event_id
machine_id
session_id
application_version
integrity_domain
violation_type
component_identifier
expected_measurement
observed_measurement
timestamp
security_epoch
```

Sensitive implementation details should not necessarily be exposed to the frontend.

---

# 32. Offline Tamper Detection

The backend may be unavailable when tampering is detected.

Therefore:

```text
Tamper detected
      │
      ├── backend available
      │       ↓
      │   report
      │
      └── backend unavailable
              ↓
        persist security event
              ↓
        enter restricted state
              ↓
        report when trust is restored
```

The application must not interpret backend unavailability as permission to ignore a local integrity violation.

---

# 33. Tamper Event Persistence

Security events should be durable.

Example:

```text
SecurityEvent
-------------------------
event_id
event_type
severity
timestamp
security_epoch
application_version
machine_identity
session_generation
integrity_domain
status
created_at
reported_at
```

The record itself should have integrity protection.

Otherwise:

```text
attacker modifies database
       │
       ▼
deletes tamper event
```

would be trivial.

---

# 34. Security Event Integrity

Security events should be protected against unauthorized modification.

Possible model:

```text
event
 │
 ▼
canonical encoding
 │
 ▼
cryptographic authentication
 │
 ▼
persistent storage
```

For sequences of events, a hash-chain can optionally be used:

```text
Event 1
  │
  ▼
Hash 1
  │
  ▼
Event 2 + Hash 1
  │
  ▼
Hash 2
  │
  ▼
Event 3 + Hash 2
```

This can make silent historical modification detectable.

It should not be treated as an absolute defense against an attacker who can completely replace the local application and storage.

---

# 35. Anti-Debugging

Anti-debugging techniques may be used as an additional hardening layer, but they should not become a fundamental security primitive.

The architecture should prefer:

```text
Cryptographic authorization
+
Backend authority
+
Integrity verification
+
Secure state
+
Process isolation
+
Hardening
```

over:

```text
Debugger detected → everything is secure
```

Anti-debugging is inherently bypassable.

---

# 36. Frontend Integrity

The frontend should be considered untrusted with respect to security decisions.

The frontend may request:

```text
login
upload
download
start
stop
configuration change
```

but should not decide:

```text
authorized = true
```

The Security Authority must independently evaluate authorization.

---

# 37. Local API Tampering

A malicious local process may attempt:

```text
POST /runtime/start
```

directly.

Therefore the Control Plane API must not equate:

```text
valid HTTP request
```

with:

```text
authorized operation
```

The request path should be:

```text
Local Client
     │
     ▼
API Authentication
     │
     ▼
Request Validation
     │
     ▼
Security Authority
     │
     ▼
Authorization
     │
     ▼
Operation
```

---

# 38. Security Authority API Boundary

The rest of the Control Plane should interact with the Security Authority through explicit operations.

Conceptually:

```text
initialize()
authenticate()
renewSession()
getAuthorization()
validateOperation()
getCapabilities()
handleBackendEvent()
handleIntegrityEvent()
shutdown()
```

The internals remain private.

---

# 39. Security Authority Does Not Trust Its Caller

A dangerous architecture would be:

```text
Control Plane
    │
    ▼
Security Authority
    │
    "trust me, user is authorized"
```

Instead:

```text
Control Plane
    │
    ▼
Security Authority
    │
    ├── verify session
    ├── verify machine
    ├── verify license
    ├── verify integrity
    ├── verify security state
    └── evaluate policy
```

The Security Authority should be authoritative for security state.

---

# 40. Integrity Verification Scheduling

Integrity verification should not necessarily happen continuously.

A policy may define:

```text
STARTUP
SECURITY_TRANSITION
SESSION_RENEWAL
LICENSE_REFRESH
EXECUTION_AUTHORIZATION
UPDATE
SUSPICIOUS_EVENT
PERIODIC
```

This allows the system to balance:

```text
Security
```

against:

```text
CPU
Disk I/O
Startup latency
User experience
```

---

# 41. TOCTOU Consideration

A fundamental problem exists:

```text
Check file
   │
   ▼
File valid
   │
   ▼
Execute file
```

An attacker could theoretically modify the file between verification and execution.

Therefore critical security components should minimize the gap between:

```text
measurement
```

and:

```text
use
```

and rely where practical on platform mechanisms such as signed binaries, secure loading, protected installation/update mechanisms, and native module boundaries.

The integrity system should not assume that a one-time hash check provides absolute runtime integrity.

---

# 42. Update and Rollback Security

An update should have a monotonic trust relationship.

For example:

```text
Version 10
    │
    ▼
Version 11
```

is valid if authorized.

But:

```text
Version 11
    │
    ▼
Version 8
```

should not automatically be accepted.

A legitimate rollback mechanism may exist, but it must itself be authorized.

---

# 43. Application Version Trust

The backend may enforce:

```text
minimum_supported_version
```

This prevents an attacker from intentionally restoring an old version containing a known authorization vulnerability.

Conceptually:

```text
Application Version
        │
        ▼
Backend Policy
        │
        ├── supported
        │
        └── obsolete
               │
               ▼
          authorization denied
```

---

# 44. Certificate and Trust Anchor Protection

The application must protect its trust anchors.

Tampering with:

```text
backend certificate
backend public key
certificate chain
trust configuration
```

could otherwise redirect the Control Plane to an attacker-controlled backend.

Trust anchors should therefore be included in the protected integrity domain.

---

# 45. Key Rotation

Key rotation must not accidentally look like tampering.

The Security Authority must distinguish:

```text
Authorized key rotation
```

from:

```text
Unauthorized key replacement
```

The protocol should support controlled transitions:

```text
Old Key
   │
   ├── valid during transition
   │
   ▼
New Key
```

rather than suddenly trusting arbitrary local key material.

---

# 46. Integrity Failure Severity

A useful model:

| Severity | Example                             | Response    |
| -------- | ----------------------------------- | ----------- |
| INFO     | non-critical cache anomaly          | repair      |
| LOW      | non-security resource mismatch      | re-download |
| MEDIUM   | configuration anomaly               | revalidate  |
| HIGH     | native module mismatch              | restrict    |
| CRITICAL | Security Authority modification     | fail closed |
| CRITICAL | trust anchor modification           | fail closed |
| CRITICAL | authorization verifier modification | fail closed |

---

# 47. Recovery

Tamper detection should distinguish:

```text
Corruption
```

from:

```text
Malicious modification
```

For recoverable corruption:

```text
Detect
  ↓
Invalidate
  ↓
Download trusted copy
  ↓
Verify signature
  ↓
Verify hash
  ↓
Install atomically
  ↓
Verify again
```

For critical suspicious modification:

```text
Detect
  ↓
Quarantine / restrict
  ↓
Invalidate authorization
  ↓
Backend notification
  ↓
Require trusted repair/update
```

---

# 48. Quarantine

A component that fails integrity verification should not necessarily be immediately deleted.

Instead:

```text
invalid_component
```

may be moved into a controlled quarantine area.

This allows:

- diagnostics;
- forensic metadata;
- recovery;
- replacement.

The quarantined file must never be loaded as an executable component.

---

# 49. Atomic Replacement

Updates and repairs should avoid partially replacing security-critical files.

Unsafe:

```text
delete old
write new
```

because a crash can produce:

```text
nothing
```

or:

```text
partial file
```

Prefer:

```text
download temporary file
        │
        ▼
verify signature
        │
        ▼
verify hash
        │
        ▼
prepare replacement
        │
        ▼
atomic commit
```

---

# 50. Crash During Integrity Transition

Consider:

```text
Security state = VALID
```

The application begins updating a component.

Then:

```text
CRASH
```

The system must not restart believing that the update completed.

The state machine should use explicit transactional states:

```text
UPDATE_PREPARE
UPDATE_VERIFY
UPDATE_COMMIT
UPDATE_COMPLETE
```

Incomplete transitions are recoverable and must fail closed until reconciled.

---

# 51. Integrity and Session State

A session must be bound to an integrity context where appropriate.

Conceptually:

```text
Session
   │
   ├── machine identity
   ├── application version
   ├── security epoch
   └── authorization context
```

If critical application integrity changes:

```text
Integrity Context changes
        │
        ▼
Session invalidated
```

This prevents a previously valid session from being blindly reused after a security boundary has changed.

---

# 52. Integrity and License State

License state should not be treated as independent of application integrity.

The operational condition is closer to:

```text
Integrity Valid
AND
Session Valid
AND
Machine Valid
AND
License Valid
AND
Authorization Valid
```

If:

```text
Integrity Invalid
```

then:

```text
Operational Authorization = DENIED
```

regardless of whether the cached license says:

```text
valid = true
```

---

# 53. Security Epoch

A useful mechanism is a monotonic:

```text
security_epoch
```

Every major security transition can advance it.

Examples:

- credential reset;
- key rotation;
- license revocation;
- critical integrity event;
- machine identity replacement;
- application security update.

Then:

```text
Authorization issued under epoch 41
```

must not necessarily remain valid under:

```text
Security epoch 42
```

This provides a clean invalidation mechanism.

---

# 54. Integrity Context

The Security Authority can maintain an internal context:

```text
IntegrityContext
-------------------------
application_version
manifest_version
security_epoch
integrity_status
critical_components_valid
configuration_valid
storage_valid
trust_anchors_valid
last_verified_at
verification_generation
```

This context is internal to the Security Authority.

The rest of the Control Plane receives only the resulting capability/status.

---

# 55. No Security Bypass Flags

The architecture must avoid permanent local bypass mechanisms such as:

```text
DISABLE_SECURITY=true
```

or:

```text
SKIP_LICENSE_CHECK=true
```

or:

```text
development_mode=true
```

inside production builds.

Development builds should have explicit identities and security policies rather than hidden runtime switches.

---

# 56. Development vs Production

Development builds may have:

```text
development trust root
development backend
development certificates
development license policy
```

Production builds must have:

```text
production trust root
production protocol
production integrity manifest
production authorization
```

The two trust domains must not accidentally overlap.

---

# 57. What Tamper Detection Cannot Protect Against

This architecture cannot guarantee protection against an attacker who completely controls execution.

For example, a sufficiently capable attacker may:

```text
reverse engineer
patch
debug
instrument
emulate
reimplement
```

the application.

Therefore the architecture should never claim:

> "Tamper detection makes cracking impossible."

The realistic goal is:

> **Increase attack cost, detect common and significant modifications, preserve backend authority, and prevent straightforward local bypasses.**

---

# 58. Layered Protection Model

The complete model should therefore be:

```text
                 Backend Authority
                       │
             Cryptographic Trust
                       │
                       ▼
                Security Authority
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   Authentication   Authorization   Integrity
        │              │              │
        └──────────────┼──────────────┘
                       │
                       ▼
                Security State
                       │
                       ▼
              Execution Authorization
                       │
                       ▼
                 Execution Plane
```

Tamper detection is one part of this system.

It is not the entire security architecture.

---

# 59. Recommended Component Structure

The Security Authority could internally be structured as:

```text
security_authority/
│
├── bootstrap/
│   ├── bootstrap
│   └── initialization
│
├── integrity/
│   ├── verifier
│   ├── manifest
│   ├── measurements
│   ├── component_registry
│   └── tamper_detector
│
├── trust/
│   ├── trust_store
│   ├── certificates
│   └── backend_keys
│
├── authentication/
│
├── authorization/
│
├── licensing/
│
├── session/
│
├── machine_identity/
│
├── secure_storage/
│
├── protocol/
│
├── events/
│
├── recovery/
│
└── policy/
```

This is a **vertical subsystem decomposition**.

The Security Authority itself remains a modular black box to the rest of the Control Plane.

---

# 60. Public Security Authority Boundary

The Control Plane should ideally see something conceptually similar to:

```text
SecurityAuthority
```

rather than:

```text
IntegrityVerifier
LicenseManager
SessionManager
MachineIdentityManager
CryptoManager
TamperDetector
...
```

The internal components remain private.

Example:

```text
const security = createSecurityAuthority(config);

await security.initialize();

const result = await security.authenticate(credentials);

const authorization =
    await security.authorize(operation);

await security.shutdown();
```

The exact API belongs to the implementation phase.

---

# 61. Event Model

The Security Authority should emit security-domain events.

Examples:

```text
IntegrityVerificationStarted
IntegrityVerificationCompleted

IntegrityViolationDetected

SecurityStateChanged

SecurityEpochChanged

SessionInvalidated

AuthorizationRevoked

TrustAnchorChanged

SecurityRecoveryStarted
SecurityRecoveryCompleted

SecurityFailure
```

These events should be consumed by the Control Plane through an explicit interface.

---

# 62. Frontend Exposure

The frontend should not receive sensitive internal details such as:

```text
expected hash
observed hash
cryptographic key material
internal component identifiers
tamper detection algorithms
security implementation details
```

Instead it may receive a sanitized state:

```text
SECURE
AUTHENTICATED
AUTHORIZED
RESTRICTED
SECURITY_ERROR
RECOVERY_REQUIRED
```

This is both cleaner architecturally and safer.

---

# 63. Telemetry

Telemetry should distinguish:

```text
Security Event
```

from:

```text
Application Log
```

Security events are authoritative domain events.

Application logs are diagnostic information.

For example:

```text
Application log:
"Integrity check failed for module X"

Security event:
INTEGRITY_VIOLATION
```

The security event should be generated by the Security Authority itself.

---

# 64. Observability Without Trust Leakage

The application should provide enough telemetry to diagnose failures without exposing mechanisms that make bypass easier.

For example, prefer:

```text
INTEGRITY_FAILURE
component_domain=native_security
```

over exposing every implementation detail to the frontend.

---

# 65. Backend Reporting

The backend may receive:

```text
IntegrityViolation
SecurityFailure
AuthorizationRevoked
ApplicationVersionRejected
MachineIdentityConflict
```

This allows the backend to build a security history.

However, backend reporting must never be the mechanism that determines whether the local application notices a local integrity failure.

Local detection happens locally.

---

# 66. Failure Matrix

| Condition                             | Local Result                 | Backend          | Execution Plane         |
| ------------------------------------- | ---------------------------- | ---------------- | ----------------------- |
| Valid integrity                       | continue                     | normal           | allowed if authorized   |
| Non-critical corruption               | repair/restrict              | report           | restricted if necessary |
| Critical tamper                       | security failure             | report           | authorization revoked   |
| Manifest invalid                      | fail closed                  | report           | denied                  |
| Trust anchor modified                 | fail closed                  | report           | denied                  |
| Security DB corruption                | recover/restrict             | report           | denied until resolved   |
| Backend unavailable + valid integrity | degraded according to policy | unavailable      | policy-dependent        |
| Backend unavailable + critical tamper | fail closed                  | retry later      | denied                  |
| Update incomplete                     | recovery state               | report           | denied                  |
| Old unsupported version               | denied                       | backend informed | denied                  |

---

# 67. Core Invariant

The most important invariant of this architecture is:

> **No locally mutable artifact may independently grant operational authorization.**

Therefore none of these should be sufficient:

```text
local license file
local database flag
frontend state
configuration flag
cached session
local boolean
environment variable
```

Authorization must arise from the Security Authority's validated security context.

---

# 68. Second Core Invariant

Another important invariant:

> **A critical integrity failure invalidates the security context.**

Formally:

```text
CriticalIntegrityViolation
        ⇒
SecurityContext = INVALID
```

and:

```text
SecurityContext = INVALID
        ⇒
OperationalAuthorization = DENIED
```

---

# 69. Third Core Invariant

The third invariant:

> **Integrity verification itself must be part of the protected security boundary.**

There is little value in having:

```text
tamper_detector.js
```

if an attacker can trivially modify:

```text
tamper_detector.js
```

to:

```text
return true;
```

Therefore the verifier itself belongs inside the critical integrity domain and should have stronger protection than ordinary application code.

---

# 70. Final Architecture

The resulting security architecture can be visualized as:

```text
                           BACKEND
                              │
                     Cryptographic Trust
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
                 │ Trust Management        │
                 │                         │
                 │ Integrity               │
                 │ ├── Manifest            │
                 │ ├── Measurement         │
                 │ ├── Verification        │
                 │ ├── Tamper Detection    │
                 │ └── Recovery            │
                 │                         │
                 │ Secure Storage          │
                 │ Security State          │
                 └────────────┬────────────┘
                              │
                    Authorization Contract
                              │
                              ▼
                 ┌─────────────────────────┐
                 │    EXECUTION PLANE      │
                 └─────────────────────────┘
```

And around the Control Plane:

```text
                 ┌────────────────────────────┐
                 │        CONTROL PLANE       │
                 │                            │
Frontend ───────►│ API / Application Layer    │
                 │            │               │
                 │            ▼               │
                 │     Security Authority     │
                 │            │               │
                 │            ▼               │
                 │      Runtime Manager       │
                 │            │               │
                 └────────────┼───────────────┘
                              │
                              ▼
                       Execution Plane
```

---

# 71. Final Design Position

The Security Authority should therefore **not** be thought of as merely:

```text
Authentication + License Check
```

It is better understood as:

> **The local security decision authority that establishes whether the Control Plane is operating within a trusted enough security context to perform privileged operations.**

Its decision is based on multiple dimensions:

```text
                ┌───────────────┐
                │ Application   │
                │ Integrity     │
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │ Machine       │
                │ Identity      │
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │ Authentication│
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │ Session        │
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │ License        │
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │ Authorization  │
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │ Operational    │
                │ Authorization  │
                └───────────────┘
```

Tamper detection sits alongside these rather than replacing them:

```text
Integrity
   │
   ├── valid ────────────────┐
   │                         │
   └── invalid ──► DENY     │
                             ▼
                  Security Authority
                             │
                 ┌───────────┴───────────┐
                 │                       │
            Security Context       Authorization
                 │                       │
                 └───────────┬───────────┘
                             ▼
                    Execution Permission
```

The key architectural idea is therefore **not "protect every file."** It is:

> **Protect the authority that makes security decisions, cryptographically establish the application's expected state, detect deviations from that state, invalidate authorization when critical integrity is lost, and keep the backend as the ultimate source of subscription authority.**

That gives you a much more coherent security model than attempting to encrypt every communication channel or hide every piece of code.

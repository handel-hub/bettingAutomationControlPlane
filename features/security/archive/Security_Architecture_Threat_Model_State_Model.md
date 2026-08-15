# Security Authority

## Comprehensive Security Architecture, Threat Model, State Model & Edge-Case Specification

**Document Status:** Architecture Foundation
**System:** Runtime Synchronization Platform — Control Plane
**Subsystem:** Security Authority
**Scope:** Authentication, Identity, Machine Trust, Session Management, Authorization, Licensing, Cryptographic Trust, Security State, and Security Failure Handling

---

# 1. Purpose

The Security Authority is the security foundation of the Control Plane.

It establishes and maintains the security context under which the local automation platform is permitted to operate.

It is responsible for answering questions such as:

- Who is the authenticated user?
- What machine is this installation associated with?
- Is the current session valid?
- Has the session expired?
- Is the machine still recognized?
- Is the user authorized to perform an operation?
- Does the account possess the required entitlement?
- Is the license valid?
- Has the account, machine, session, or license been revoked?
- Can the application continue operating while the backend is unavailable?
- Has security state become stale?
- Has security state become corrupted?
- Has a security-relevant event occurred while an operation is already running?
- What must happen when trust can no longer be established?

The Security Authority does **not** perform the business operations themselves.

It does not:

- execute browser automation;
- synchronize browsers;
- understand DOM state;
- schedule automation tasks;
- manage Playwright;
- implement file-transfer behavior;
- render frontend interfaces;
- implement business workflows.

Instead, it establishes the **security conditions under which those systems may operate**.

---

# 2. Architectural Position

The overall system is:

```text
                         BACKEND
                            │
                            │
                    Authoritative Services
                            │
                            ▼
                    ┌─────────────────┐
                    │  CONTROL PLANE  │
                    │                 │
                    │ Security        │
                    │ Authority       │
                    │                 │
                    │ Runtime         │
                    │ File Transfer   │
                    │ Configuration   │
                    │ Health          │
                    │ Telemetry       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ EXECUTION PLANE │
                    └─────────────────┘
                             │
                             ▼
                      Browser Cluster
```

The Security Authority sits **inside the Control Plane**, but conceptually acts as a security boundary around the rest of the local application.

The Frontend is a client of the Control Plane.

The Execution Plane is a separate system.

The Backend remains authoritative for server-owned state such as:

- account identity;
- subscription;
- entitlement;
- revocation;
- server-side authorization;
- licensing state;
- server-side security policy.

The Control Plane maintains a local security context derived from authoritative backend information and locally verifiable state.

---

# 3. Fundamental Security Principle

The architecture follows:

> **Authenticate identity, establish trust, determine authority, then permit operation.**

These concepts must not be collapsed into a single boolean such as:

```text
authenticated = true
```

Authentication, session validity, authorization, machine trust, and licensing are separate dimensions.

A user may be:

```text
Authenticated = true
Session = valid
Machine = valid
License = expired
```

or:

```text
Authenticated = true
Session = valid
Machine = revoked
License = valid
```

or:

```text
Authenticated = false
License = valid
```

These states must remain distinguishable.

---

# 4. Threat Model

## 4.1 Primary Adversary

The primary adversary is a user who has:

- full access to the local desktop;
- access to the installed application;
- access to application files;
- access to local configuration;
- access to local persistent state;
- ability to inspect network traffic;
- ability to debug processes;
- ability to modify local files;
- ability to attempt binary patching;
- ability to manipulate the local environment.

The attacker is attempting primarily to:

> bypass the backend subscription/licensing authority and make the application operate as though it were legitimately licensed.

This is fundamentally different from protecting a conventional web application from an anonymous remote attacker.

---

# 5. Security Objective

The objective is **not** to make reverse engineering impossible.

That is unrealistic for software executing on a machine controlled by the attacker.

The objective is to make unauthorized modification sufficiently difficult and expensive that:

- casual patching does not bypass licensing;
- trivial modification does not bypass authentication;
- simple local state editing does not create valid authority;
- fake responses do not trivially create valid entitlement;
- bypassing one component does not automatically compromise every other component;
- the authoritative backend remains difficult to impersonate;
- security decisions cannot be trivially replaced with unconditional success;
- security-sensitive components have meaningful integrity protections.

Rust, native components, code signing, binary hardening, obfuscation, integrity checks, secure storage, protocol authentication, and related techniques are therefore **defense mechanisms**, not magical guarantees.

---

# 6. Trust Model

The following trust hierarchy is assumed.

## 6.1 Backend

The Backend is authoritative for server-owned security state.

It is trusted to determine:

- account identity;
- authentication result;
- subscription state;
- entitlement;
- revocation;
- server-side license state;
- server-side authorization;
- server time where required;
- cryptographic trust material.

---

## 6.2 Security Authority

The Security Authority is the local authority for the Control Plane's current security context.

It:

- consumes backend authority;
- validates local security conditions;
- maintains session state;
- makes local authorization decisions;
- exposes security decisions to Control Plane subsystems;
- controls whether protected operations may proceed.

It must not invent server authority.

---

## 6.3 Frontend

The Frontend is **not a trusted security authority**.

Frontend requests represent:

> user intent

not:

> authorization.

For example:

```text
Frontend:
"Start runtime."
```

does not mean:

```text
"User is authorized to start runtime."
```

The Security Authority determines that.

---

## 6.4 Execution Plane

The Execution Plane is a separate system.

It should receive only the authority/context required to perform an already-authorized operation.

It must not become responsible for deciding:

- whether a subscription exists;
- whether the user is authenticated;
- whether the account is authorized;
- whether a license is valid.

The Security Authority controls whether the Execution Plane may be activated or continue operating according to policy.

---

# 7. Security Authority Responsibilities

The Security Authority consists conceptually of:

```text
Security Authority
│
├── Identity
├── Authentication
├── Machine Identity
├── Machine Trust
├── Session Management
├── Authorization
├── Licensing / Entitlements
├── Cryptographic Trust
├── Secure Communication
├── Security State
├── Security Events
├── Security Persistence
├── Security Recovery
└── Security Policy
```

These are conceptual responsibilities.

They do not necessarily imply separate processes.

---

# 8. Identity

Identity answers:

> Who is this security principal?

Potential principals include:

```text
User
Machine
Installation
Session
Process
```

These identities must not be conflated.

A conceptual relationship is:

```text
User
 │
 ├── user_id
 │
 └── Machines
       │
       ├── machine_id
       │
       └── Installation
             │
             └── Sessions
                   │
                   └── Requests
```

---

# 9. Machine Identity

Machine identity represents the identity of an installation/device.

It may eventually be issued or registered by the Backend.

It is not equivalent to:

- username;
- password;
- session;
- license;
- operating-system hostname.

The machine identity must have explicit lifecycle semantics.

---

## 9.1 Machine Identity Creation

Possible states:

```text
MACHINE_IDENTITY_ABSENT
MACHINE_IDENTITY_GENERATING
MACHINE_IDENTITY_PENDING_REGISTRATION
MACHINE_IDENTITY_REGISTERED
MACHINE_IDENTITY_INVALID
MACHINE_IDENTITY_REVOKED
```

Failure cases include:

- generation failure;
- persistence failure;
- registration failure;
- backend timeout;
- registration succeeds but response is lost;
- duplicate registration;
- partially written identity;
- corrupted identity.

---

## 9.2 Machine Identity Persistence

The architecture must define:

- where it is stored;
- whether it is encrypted;
- whether it is hardware-backed;
- how it is recovered;
- whether it can be rotated;
- what happens when it is lost;
- whether it can be transferred.

---

## 9.3 Machine Identity Duplication

Possible scenarios:

- copied application directory;
- cloned filesystem;
- VM snapshot;
- disk image duplication;
- restored backup;
- manual file copying.

The system must distinguish:

```text
same installation restored
```

from:

```text
new machine pretending to be old machine
```

This is a backend policy decision and must not be left to accidental local behavior.

---

# 10. Installation Identity

Machine identity and installation identity may eventually be separate.

A conceptual model:

```text
Machine
    │
    └── Installation
            │
            └── Sessions
```

This allows the system to distinguish:

- the physical/virtual machine;
- a particular installation;
- an application instance.

This is optional infrastructure and does not need to be implemented immediately.

---

# 11. Authentication

Authentication answers:

> Who is the user?

The Control Plane should not invent a custom password-encryption protocol.

The intended conceptual flow is:

```text
Frontend
   │
   │ credentials
   ▼
Control Plane
   │
   │ authenticated secure channel
   ▼
Backend
   │
   │ credential verification
   ▼
Authentication Result
```

The password should not become a long-lived local security artifact.

The Backend remains authoritative for credential verification.

---

# 12. Authentication Outcomes

Authentication must have explicit outcomes.

```text
AUTHENTICATION_PENDING
AUTHENTICATED
AUTHENTICATION_FAILED
AUTHENTICATION_TIMEOUT
AUTHENTICATION_INTERRUPTED
AUTHENTICATION_UNAVAILABLE
AUTHENTICATION_REVOKED
```

Authentication failure must not be indistinguishable from network failure.

For example:

```text
Invalid password
```

is fundamentally different from:

```text
Backend unreachable
```

The user-facing behavior may differ, and the security state must certainly differ.

---

# 13. Partial Authentication

A critical case is:

```text
Authentication succeeds
        │
        ▼
License retrieval fails
```

The system must not automatically interpret this as:

```text
fully operational
```

Instead:

```text
Authenticated
    +
Entitlement unknown
    =
Not fully operational
```

Likewise:

```text
Authentication succeeds
License valid
Machine binding fails
```

does not produce an operational state.

---

# 14. Session

A session represents an active authenticated context.

A session must have:

- identity;
- creation time;
- expiry policy;
- renewal policy;
- machine association;
- security context;
- revocation state;
- protocol version;
- unique identifier.

Potential states:

```text
SESSION_CREATING
SESSION_ACTIVE
SESSION_RENEWING
SESSION_EXPIRED
SESSION_REVOKED
SESSION_INVALID
SESSION_TERMINATING
SESSION_TERMINATED
```

---

# 15. Session Expiration

Session expiration may result from:

- absolute lifetime;
- inactivity;
- backend revocation;
- account changes;
- security events;
- machine revocation;
- credential changes;
- policy changes.

Expiration must be distinguishable from:

```text
backend unreachable
```

because temporary network failure does not necessarily mean the session is invalid.

---

# 16. Session Renewal

Renewal is not simply:

```text
extend expiry
```

It is a security transition.

Possible outcomes:

```text
RENEWED
RENEWAL_FAILED
RENEWAL_REJECTED
RENEWAL_TIMEOUT
RENEWAL_INTERRUPTED
REAUTHENTICATION_REQUIRED
LICENSE_CHANGED
MACHINE_REVOKED
```

If renewal fails because the backend is unavailable, the system must apply an explicit degraded-mode policy rather than automatically treating the session as permanently invalid.

---

# 17. Session Theft

If an attacker obtains session credentials, possible attacks include:

- replay;
- cross-process reuse;
- cross-machine reuse;
- delayed replay;
- post-logout replay;
- post-expiration replay;
- cross-account reuse.

Mitigations should eventually consider:

- secure storage;
- short-lived credentials;
- session binding;
- machine association;
- server-side revocation;
- freshness;
- authenticated transport;
- key rotation;
- replay protection.

---

# 18. Session Fixation

A session established before authentication must not accidentally become the authenticated session.

Authentication should result in a new authenticated security context where required.

Old unauthenticated context must not acquire authenticated authority merely because authentication succeeded.

---

# 19. Concurrent Sessions

The architecture must eventually decide:

- Are multiple machines allowed?
- Are multiple sessions per machine allowed?
- Is there a session limit?
- Can a new login invalidate an old session?
- Can the Backend revoke one session without revoking all sessions?
- Can two Control Plane instances share a session?

These are policy decisions.

---

# 20. Logout

Logout may occur because of:

- explicit user action;
- session expiry;
- backend revocation;
- license failure;
- machine revocation;
- security event;
- application shutdown.

Logout while operations are running is particularly important.

The system must decide whether:

```text
logout
   ↓
immediate execution termination
```

or:

```text
logout
   ↓
deny new operations
   ↓
gracefully terminate active operations
```

or another policy.

---

# 21. Authorization

Authorization answers:

> Is this authenticated security principal allowed to perform this operation?

Conceptually:

```text
authorize(
    subject,
    action,
    resource,
    context
)
```

The decision should be:

```text
ALLOW
DENY
UNKNOWN
```

`UNKNOWN` is important.

A security system should not accidentally convert:

```text
unable to determine
```

into:

```text
allowed
```

---

# 22. Authorization Context

Authorization may depend on:

- identity;
- session;
- machine;
- license;
- capability;
- resource;
- current security state;
- operational state;
- policy;
- backend authority.

Therefore:

```text
authenticated == authorized
```

must never be assumed.

---

# 23. Authorization Staleness

A previously valid decision may become invalid.

Example:

```text
T1:
ALLOW runtime.start

T2:
Backend revokes entitlement

T3:
runtime.start executes
```

This is a TOCTOU problem.

The architecture must define how long an authorization decision remains valid and whether a final authority check is required immediately before sensitive execution.

---

# 24. Licensing

Licensing represents entitlement to use functionality.

Potential states:

```text
LICENSE_UNKNOWN
LICENSE_VALID
LICENSE_EXPIRING
LICENSE_EXPIRED
LICENSE_REVOKED
LICENSE_SUSPENDED
LICENSE_INVALID
LICENSE_UNAVAILABLE
```

Licensing must remain separate from authentication.

---

# 25. License Transitions

Possible transitions include:

```text
VALID → EXPIRING
EXPIRING → VALID
EXPIRING → EXPIRED
VALID → REVOKED
VALID → SUSPENDED
SUSPENDED → VALID
VALID → DOWNGRADED
VALID → UPGRADED
```

Each transition may affect currently running operations.

---

# 26. License Expiration During Operation

This is a mandatory design decision.

Example:

```text
License valid
     │
     ▼
Execution starts
     │
     ▼
License expires
```

Possible policies:

### Immediate termination

```text
License expires
     ↓
Execution stops
```

### Graceful termination

```text
License expires
     ↓
No new operations
     ↓
Existing operation completes
```

### Restricted operation

```text
License expires
     ↓
Restricted mode
```

The final policy must be explicitly chosen.

---

# 27. License Revocation

Revocation is stronger than expiration.

Expiration can be expected.

Revocation can be immediate and deliberate.

Therefore the architecture must treat:

```text
EXPIRED
```

and:

```text
REVOKED
```

as separate conditions.

---

# 28. License Downgrade

Example:

```text
Professional
      ↓
Basic
```

The user remains authenticated.

The license remains valid.

But some capabilities disappear.

Therefore authorization must consume entitlement state rather than assuming:

```text
license_valid = all_capabilities_enabled
```

---

# 29. License Upgrade

The opposite transition must also work:

```text
Basic
  ↓
Professional
```

The system must determine:

- when the new entitlement becomes authoritative;
- whether reauthentication is required;
- whether authorization caches must be invalidated;
- whether the Execution Plane must restart;
- whether the Frontend must refresh capabilities.

---

# 30. Backend Authority

The Backend is authoritative for remote security state.

The Control Plane must not manufacture:

- valid licenses;
- valid account identity;
- revocation state;
- subscription state.

Cached state exists to support resilience, not to replace backend authority permanently.

---

# 31. Backend Unavailability

Backend unavailability has many states:

```text
UNAVAILABLE_AT_STARTUP
UNAVAILABLE_DURING_LOGIN
UNAVAILABLE_DURING_RENEWAL
UNAVAILABLE_DURING_LICENSE_REFRESH
UNAVAILABLE_DURING_AUTHORIZATION
UNAVAILABLE_DURING_OPERATION
UNAVAILABLE_AFTER_SUCCESSFUL_AUTHENTICATION
```

These are not necessarily equivalent.

---

# 32. Degraded Mode

The Security Authority should have an explicit degraded state.

For example:

```text
OPERATIONAL
     │
     │ backend unavailable
     ▼
DEGRADED
```

The system then evaluates policy.

Possible outcomes:

```text
DEGRADED
   ├── cached authority still valid
   │       ↓
   │   limited operation
   │
   ├── grace period exhausted
   │       ↓
   │   LOCKED
   │
   └── security state uncertain
           ↓
       REAUTHENTICATION_REQUIRED
```

The exact policy must be determined separately.

---

# 33. Unknown Security State

One of the most dangerous states is:

```text
UNKNOWN
```

For example:

```text
Backend unavailable
+
local license stale
+
session near expiry
```

The system cannot confidently establish authority.

The architecture must specify whether protected operations are:

- denied;
- restricted;
- allowed temporarily;
- terminated.

Never allow this behavior to emerge accidentally from an exception handler.

---

# 34. Cryptographic Trust

The cryptographic architecture must account for:

- key generation;
- key storage;
- key usage;
- key rotation;
- key expiration;
- key revocation;
- key replacement;
- key compromise;
- key loss;
- server key rotation;
- certificate rotation;
- trust-anchor rotation.

---

# 35. Key Compromise

If a key is compromised:

```text
Key compromised
      ↓
Identify affected security contexts
      ↓
Revoke/rotate key
      ↓
Invalidate affected sessions if required
      ↓
Re-establish trust
```

The architecture must define which keys compromise which authority.

A compromised transport/session key should not necessarily imply that the account itself is compromised.

---

# 36. Server Key Rotation

The client must not assume that one server key exists forever.

The protocol must support:

```text
OLD KEY
   ↓
ROTATION
   ↓
NEW KEY
```

during a transition period where required.

---

# 37. Certificate Rotation

Certificate rotation must not cause an unnecessary global outage.

Potential failures:

- expired certificate;
- unexpected certificate;
- hostname mismatch;
- untrusted issuer;
- client using obsolete trust material;
- server using new trust material before clients update.

---

# 38. Message Security

Every Control Plane ↔ Backend protocol message must have defined semantics.

Conceptually:

```text
Request
├── protocol_version
├── request_id
├── session_context
├── message_type
├── payload
└── freshness/authentication material
```

Response:

```text
Response
├── protocol_version
├── request_id
├── status
├── security_state
├── payload
└── freshness/authentication material
```

The exact cryptographic implementation is intentionally unspecified at this architectural level.

---

# 39. Message Replay

The protocol must consider:

- same request sent twice;
- old request sent later;
- request from another session;
- request from another machine;
- request from another account;
- response from previous session;
- response from previous application instance;
- response from before logout;
- response from before revocation.

Stable identifiers, freshness, authenticated context, and server-side idempotency may be required depending on operation.

---

# 40. Message Ordering

Messages may arrive:

```text
1 → 2 → 3
```

or:

```text
1 → 3 → 2
```

The Security Authority must not blindly apply stale state.

Example:

```text
License VALID
     ↓
License EXPIRED
     ↓
License REVOKED
```

If `EXPIRED` arrives after `REVOKED`, it must not resurrect the license.

Security state transitions therefore need ordering/freshness semantics.

---

# 41. Request / Response Association

A response must belong to the request that generated it.

The system must detect:

- wrong request ID;
- old request ID;
- duplicate response;
- response for another session;
- response from another machine;
- response after timeout;
- response after state transition.

---

# 42. Clock Security

Wall-clock time is inherently problematic when the local machine is attacker-controlled.

Threats include:

- clock rollback;
- clock jump forward;
- clock jump backward;
- manual modification;
- NTP failure;
- NTP manipulation;
- VM clock manipulation;
- sleep/wake jumps;
- hibernation;
- timezone changes;
- server/client disagreement.

The architecture must distinguish:

```text
Wall-clock time
```

from:

```text
Monotonic elapsed time
```

where appropriate.

---

# 43. Time-Based Security Decisions

Time may influence:

- session expiry;
- license expiry;
- certificate validity;
- token validity;
- grace periods;
- retry windows;
- replay windows.

Therefore every time-based decision needs a defined source of time and failure behavior.

---

# 44. Sleep / Hibernate

A machine can disappear from the network for hours while the process remains alive.

Example:

```text
OPERATIONAL
    ↓
SYSTEM SLEEP
    ↓
6 hours
    ↓
SYSTEM RESUMES
```

On resume:

- session may have expired;
- license may have expired;
- backend state may have changed;
- keys may need refresh;
- network state may have changed;
- cached authorization may be stale.

Resume must therefore trigger security reevaluation.

---

# 45. Network Migration

During an active session:

```text
Wi-Fi
  ↓
Ethernet
```

or:

```text
Ethernet
  ↓
VPN
```

The security channel may break.

The system must determine whether the security session can be resumed or must be re-established.

---

# 46. Local Persistence

Security state may need to survive process restart.

However, persistence creates new threats:

- corruption;
- rollback;
- deletion;
- copying;
- tampering;
- snapshot restoration;
- stale state;
- database locking;
- partial transaction.

Persistent security state must therefore be treated as **untrusted local evidence that must be validated**, not as unquestionable authority.

---

# 47. Crash Safety

Every security transition must survive process crashes.

Examples:

```text
Authentication
   ↓
CRASH
```

```text
License refresh
   ↓
CRASH
```

```text
Key rotation
   ↓
CRASH
```

```text
Logout
   ↓
CRASH
```

On restart, the system must be capable of determining whether the previous transition:

- completed;
- failed;
- partially completed;
- cannot be determined.

---

# 48. Multiple Control Plane Processes

Only one authoritative Control Plane instance may eventually be allowed, or multiple instances must coordinate.

Potential conflicts:

- two sessions;
- two license refreshes;
- two machine registrations;
- two Execution Planes;
- two SQLite writers;
- two security-state transitions.

This requires an explicit process-ownership policy.

---

# 49. Local IPC

The local API is a security boundary.

Potential threats:

- unauthorized process;
- malicious local client;
- frontend impersonation;
- request replay;
- message flooding;
- malformed messages;
- privilege escalation;
- stale client;
- protocol mismatch;
- endpoint hijacking.

The frontend must not be trusted merely because it is running on localhost.

---

# 50. Frontend Security Boundary

The Frontend can send:

```text
Intent
```

but must not dictate:

```text
Authority
```

For example, the Frontend must not be able to send:

```text
licenseValid: true
authenticated: true
role: administrator
```

and have the Control Plane accept those fields as authoritative.

The Security Authority determines those values.

---

# 51. Execution Plane Security Boundary

The Execution Plane should receive only the minimum authority necessary.

The Control Plane should not send:

```text
"Here is the entire user's security state."
```

unless required.

Instead:

```text
AUTHORIZED_OPERATION
```

or an appropriately scoped capability/context should be passed.

The Execution Plane should not need to know why the user is licensed.

---

# 52. Security State

The Security Authority should maintain a conceptual aggregate state:

```text
SecurityState
{
    machine,
    identity,
    authentication,
    session,
    authorization,
    licensing,
    cryptographicTrust,
    backendConnectivity,
    protocol,
    time,
    integrity,
    operationalPolicy
}
```

This is a conceptual model, not a prescribed database schema.

---

# 53. Security State Transitions

Every transition should have:

```text
Previous State
    ↓
Trigger
    ↓
Validation
    ↓
New State
    ↓
Side Effects
    ↓
Persistence
    ↓
Events
```

For example:

```text
SESSION_ACTIVE
      │
      │ backend revocation
      ▼
SESSION_REVOKED
      │
      ├── deny new protected operations
      ├── invalidate authorization
      ├── notify dependent systems
      └── apply Execution Plane policy
```

---

# 54. Security State Invariants

The implementation should eventually enforce invariants such as:

### Invariant 1

A user cannot be authorized unless an authenticated identity exists.

### Invariant 2

A license cannot grant authority to an unauthenticated identity.

### Invariant 3

A revoked session cannot authorize new operations.

### Invariant 4

A revoked machine cannot establish normal operational authority.

### Invariant 5

Unknown security state must not silently become authorized state.

### Invariant 6

Frontend claims cannot establish authority.

### Invariant 7

Local cached entitlement cannot permanently override backend revocation.

### Invariant 8

An authorization decision must not outlive its defined validity.

### Invariant 9

Old security messages cannot overwrite newer security state.

### Invariant 10

Security failures must not accidentally produce an operational state.

### Invariant 11

A security transition must be recoverable after process crash.

### Invariant 12

A session from one security context cannot be reused in another.

### Invariant 13

A machine identity cannot silently become another machine identity.

### Invariant 14

License state cannot be upgraded merely by modifying local persistence.

### Invariant 15

Execution cannot obtain authority directly from the Frontend.

---

# 55. Fail-Closed vs Fail-Open

The system must explicitly classify failures.

Examples:

| Failure                            | Possible Policy                             |
| ---------------------------------- | ------------------------------------------- |
| Invalid credentials                | Fail closed                                 |
| Invalid license                    | Fail closed                                 |
| Revocation                         | Fail closed                                 |
| Unknown authorization              | Fail closed                                 |
| Backend timeout                    | Degraded policy                             |
| DNS failure                        | Degraded policy                             |
| Temporary TLS failure              | Degraded policy                             |
| Corrupt security state             | Fail closed                                 |
| Unknown cryptographic key          | Fail closed                                 |
| Protocol mismatch                  | Fail closed                                 |
| Clock anomaly                      | Restricted/fail closed                      |
| Backend unavailable during renewal | Policy-dependent                            |
| Local IPC failure                  | Deny request                                |
| Execution Plane unavailable        | Runtime failure, not authentication failure |

The final policy must be explicitly specified.

---

# 56. Security Events

The Security Authority should expose security events internally.

Examples:

```text
MachineIdentityCreated
MachineRegistered
MachineRevoked

AuthenticationStarted
AuthenticationSucceeded
AuthenticationFailed

SessionCreated
SessionRenewalStarted
SessionRenewed
SessionExpired
SessionRevoked
SessionTerminated

AuthorizationAllowed
AuthorizationDenied

LicenseValidated
LicenseExpired
LicenseRevoked
LicenseChanged

BackendUnavailable
BackendRecovered

KeyRotated
CertificateChanged

ClockAnomalyDetected
ProtocolMismatchDetected

SecurityStateChanged
IntegrityFailureDetected
```

Events must themselves be treated as data requiring:

- ordering;
- persistence policy;
- duplication handling;
- security filtering;
- sensitive-data protection.

---

# 57. Audit

Security events and ordinary application telemetry should not be automatically treated as identical.

Security audit concerns:

- authentication;
- authorization;
- licensing;
- machine registration;
- revocation;
- security-state changes;
- cryptographic changes;
- suspicious local activity.

Sensitive information must not be unnecessarily written into logs.

Credentials, session secrets, private keys, and similar material must never become ordinary diagnostic output.

---

# 58. Resource Exhaustion

The Security Authority must defend itself against:

- authentication flooding;
- session creation flooding;
- renewal flooding;
- authorization flooding;
- IPC flooding;
- malformed message flooding;
- cryptographic workload exhaustion;
- memory exhaustion;
- disk exhaustion;
- connection exhaustion;
- log exhaustion.

Security mechanisms themselves can become denial-of-service mechanisms if left unbounded.

---

# 59. Protocol Versioning

Security protocols must evolve.

Potential conditions:

```text
Client newer than server
Client older than server
Unknown message type
Unknown field
Unsupported algorithm
Unsupported protocol version
Deprecated security mechanism
Security downgrade attempt
```

The system must explicitly distinguish:

```text
compatible
```

from:

```text
unsafe
```

---

# 60. Security Downgrade

An attacker may attempt to force:

```text
new protocol
      ↓
old protocol
```

or:

```text
strong security
      ↓
weak security
```

Therefore protocol negotiation itself must be authenticated and downgrade-resistant.

---

# 61. Application Update

Security state must survive legitimate updates without being blindly trusted across versions.

Potential situations:

- update while authenticated;
- update while offline;
- update while Execution Plane is running;
- update during license refresh;
- update during key rotation;
- update after security-state corruption;
- rollback to older version;
- partial update;
- malicious update.

---

# 62. Rollback

Rollback is especially dangerous.

An attacker may attempt:

```text
Current secure version
       ↓
Older vulnerable version
       ↓
Old security behavior
```

Therefore the architecture must eventually consider:

- minimum supported security version;
- protocol version;
- backend rejection of obsolete clients;
- migration version;
- state-version compatibility.

---

# 63. VM / Snapshot Attacks

Because the application runs locally, consider:

```text
Valid machine
   ↓
VM snapshot
   ↓
Restore snapshot
```

Potential consequences:

- stale session;
- stale license;
- stale nonce;
- stale machine identity;
- duplicate machine identity;
- stale cryptographic state.

The backend must ultimately determine which of these states remain acceptable.

---

# 64. Local State Rollback

An attacker may restore:

```text
license_state.db
```

to a previous version.

Therefore:

```text
local database says VALID
```

cannot automatically prove:

```text
license is currently VALID.
```

The local state must have freshness semantics.

---

# 65. Security Authority Integrity

The Security Authority itself is a high-value target.

Potential attacks:

- binary patching;
- function hooking;
- memory modification;
- dependency replacement;
- configuration modification;
- response manipulation;
- authorization bypass;
- license-check bypass;
- forced fail-open behavior;
- backend communication bypass;
- fake backend injection.

Native components and hardening may raise the attack cost.

However:

> **The architecture must assume the client can eventually be modified.**

Therefore backend authority remains essential.

---

# 66. The Subscription Bypass Threat

The central attack looks like:

```text
Attacker
   │
   ▼
Modify Control Plane
   │
   ├── skip authentication
   ├── skip authorization
   ├── forge license
   ├── force operational state
   └── bypass backend
           │
           ▼
      Execution Plane
```

The architecture should make this attack require significantly more work.

The target is not:

```text impossible

```

The target is:

```text difficult

```

while maintaining a legitimate and maintainable application.

---

# 67. Security Authority Startup

A conceptual startup sequence:

```text
Application Start
      │
      ▼
Load Security Configuration
      │
      ▼
Validate Local Security State
      │
      ▼
Load Machine Identity
      │
      ▼
Establish Backend Trust
      │
      ▼
Establish / Restore Session
      │
      ▼
Validate Entitlement
      │
      ▼
Evaluate Security Policy
      │
      ▼
SECURITY STATE
```

Only after the Security Authority reaches an appropriate state should dependent systems begin protected operations.

---

# 68. Startup Failure Cases

Startup may fail because:

- machine identity unavailable;
- secure storage unavailable;
- backend unavailable;
- authentication expired;
- license expired;
- license revoked;
- protocol incompatible;
- certificate invalid;
- cryptographic key unavailable;
- local state corrupted;
- clock invalid;
- application integrity compromised.

Each must produce an explicit security state.

---

# 69. Runtime Security Loop

The Security Authority is not a one-time login function.

Conceptually:

```text
                 ┌──────────────────────┐
                 │                      │
                 ▼                      │
             Security State             │
                 │                      │
        ┌────────┼────────┐             │
        ▼        ▼        ▼             │
     Session   License   Backend        │
     State     State     State          │
        │        │        │             │
        └────────┼────────┘             │
                 ▼                      │
          Policy Evaluation             │
                 │                      │
                 ▼                      │
          Operational State             │
                 │                      │
                 └──────────────────────┘
```

Security is therefore **continuous state management**, not merely login.

---

# 70. Heartbeat / Revalidation

A periodic backend interaction may eventually be used to:

- detect backend connectivity;
- refresh session;
- refresh entitlement;
- receive revocation;
- obtain authoritative time;
- update security policy;
- detect server-side security changes.

However, the heartbeat must not be the only security mechanism.

It should be one mechanism within the broader security lifecycle.

The interval should be a policy decision based on:

- acceptable offline window;
- license requirements;
- backend load;
- threat model;
- operational requirements.

---

# 71. Security Revalidation Triggers

Revalidation should not necessarily happen only on a timer.

Possible triggers:

- application startup;
- login;
- session renewal;
- timer;
- system resume;
- network reconnection;
- machine identity change;
- security-state anomaly;
- license near expiration;
- backend reconnect;
- application update;
- privileged operation;
- security-sensitive state transition.

---

# 72. Active Operation Security

A particularly important distinction:

```text
Authorization to START
```

is not necessarily:

```text
Authorization to CONTINUE FOREVER
```

Therefore the architecture must define whether long-running operations:

- hold a capability;
- periodically revalidate;
- terminate on revocation;
- complete after revocation;
- enter a restricted state.

This applies directly to the Execution Plane.

---

# 73. Security and Execution Plane Lifecycle

A conceptual relationship:

```text
Security Authority
       │
       ├── NOT_OPERATIONAL
       │       ↓
       │   Execution blocked
       │
       ├── OPERATIONAL
       │       ↓
       │   Execution permitted
       │
       ├── DEGRADED
       │       ↓
       │   Policy-dependent
       │
       └── REVOKED/LOCKED
               ↓
          Execution restricted
```

The Execution Plane should not independently invent its own licensing policy.

---

# 74. Recovery

Every security failure needs a recovery path.

Examples:

```text
SESSION_EXPIRED
      ↓
REAUTHENTICATE
```

```text
BACKEND_UNAVAILABLE
      ↓
RETRY
      ↓
RECOVER
```

```text
CORRUPTED_LOCAL_STATE
      ↓
REBUILD / RE-ENROLL
```

```text
KEY_ROTATION_REQUIRED
      ↓
ESTABLISH_NEW_TRUST
```

```text
MACHINE_REVOKED
      ↓
RE-REGISTRATION / ADMINISTRATIVE_ACTION
```

Some states may have **no automatic recovery**.

That must also be explicit.

---

# 75. Recovery Must Not Become a Bypass

A dangerous design is:

```text
Security state corrupted
       ↓
Reset security state
       ↓
Continue operating
```

An attacker could deliberately corrupt state to trigger the recovery path.

Therefore recovery itself must be security-sensitive.

---

# 76. Security Authority Public Contract

The eventual public interface should remain narrow.

Conceptually:

```text
SecurityAuthority

authenticate()
logout()

getIdentity()
getMachineIdentity()

getSession()
refreshSession()

authorize()

getEntitlements()
validateEntitlement()

getSecurityState()

subscribeToSecurityEvents()

shutdown()
```

Internal implementation should remain hidden.

The rest of the Control Plane should not directly access:

- token stores;
- cryptographic keys;
- license database;
- authentication protocol;
- backend protocol internals;
- session persistence;
- machine identity storage.

---

# 77. Dependency Direction

The preferred dependency direction is:

```text
Application Systems
       │
       ▼
Security Authority Interface
       │
       ▼
Security Authority
       │
       ├── Backend Adapter
       ├── Secure Storage Adapter
       ├── Clock Adapter
       ├── Cryptographic Adapter
       └── Persistence Adapter
```

This permits implementation changes without changing the consumers.

---

# 78. Node / Rust Boundary

The architecture should not begin by deciding:

> "Authentication is Rust."

or:

> "Licensing is Node."

Instead, define the security responsibilities first.

Then identify components that benefit from native implementation.

Potential native candidates may include:

- cryptographic operations;
- secure key handling;
- machine identity;
- integrity verification;
- secure storage integration;
- protocol primitives;
- tamper-resistance mechanisms.

Node.js can remain responsible for:

- orchestration;
- HTTP/WS communication;
- application integration;
- event coordination;
- Control Plane composition.

The boundary should follow **security responsibility and trust boundaries**, not language preference.

---

# 79. Security Authority Design Invariants

The final implementation should preserve these principles.

### Identity

A machine identity is not a user identity.

### Authentication

Authentication does not imply authorization.

### Authorization

Authorization does not imply entitlement.

### Licensing

A valid session does not imply a valid license.

### Backend authority

Local state does not override authoritative backend revocation.

### Frontend

Frontend input represents intent, not authority.

### Execution Plane

Execution does not determine licensing.

### Persistence

Persisted security state is evidence, not unquestionable authority.

### Time

Local wall-clock time must not automatically be trusted for security decisions.

### Unknown state

Unknown security state must never silently become authorized state.

### Failure

Security failures must not accidentally create authority.

### Recovery

Recovery must itself be security-controlled.

### Replay

Old security messages must not overwrite newer state.

### Concurrency

Concurrent security transitions must be deterministic.

### Revocation

Revocation must have explicitly defined effects on active operations.

---

# 80. Comprehensive Security Event Categories

The Security Authority should eventually classify events into:

```text
IDENTITY
AUTHENTICATION
SESSION
AUTHORIZATION
LICENSING
MACHINE
CRYPTOGRAPHIC
NETWORK
BACKEND
PROTOCOL
TIME
PERSISTENCE
IPC
INTEGRITY
RECOVERY
UPDATE
EXECUTION
```

This classification will later help with:

- telemetry;
- auditing;
- debugging;
- monitoring;
- security analysis.

---

# 81. Security Decision Model

A useful conceptual model is:

```text
                 ┌───────────────┐
                 │    Identity   │
                 └───────┬───────┘
                         │
                 ┌───────▼───────┐
                 │    Session    │
                 └───────┬───────┘
                         │
              ┌──────────▼──────────┐
              │ Machine Trust       │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │ Entitlement         │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │ Authorization       │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │ Security Policy     │
              └──────────┬──────────┘
                         │
                    ┌────▼────┐
                    │ DECISION│
                    └────┬────┘
                         │
                 ┌───────┴────────┐
                 ▼                ▼
               ALLOW             DENY
```

This is the conceptual heart of the Security Authority.

---

# 82. What This Architecture Does Not Decide Yet

The following should remain deliberately unresolved until the behavioral specification is complete:

- exact session duration;
- heartbeat interval;
- exact offline grace period;
- exact license policy;
- whether machine IDs are hardware-bound;
- exact cryptographic algorithms;
- exact key hierarchy;
- exact IPC mechanism;
- exact Backend protocol;
- exact database schema;
- exact Node/Rust split;
- exact secure-storage implementation;
- exact authorization model;
- exact role/capability model;
- exact Execution Plane shutdown policy;
- exact frontend security UI.

These are implementation/policy decisions.

They should be derived from the threat model rather than guessed prematurely.

---

# 83. The Core State Model

At the highest level, the Security Authority should eventually converge toward something similar to:

```text
                         START
                           │
                           ▼
                    INITIALIZING
                           │
                 ┌─────────┴─────────┐
                 │                   │
              failure              success
                 │                   │
                 ▼                   ▼
              BLOCKED          MACHINE_READY
                                     │
                                     ▼
                              TRUST_ESTABLISHING
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                       failure                success
                          │                     │
                          ▼                     ▼
                       BLOCKED             AUTHENTICATING
                                                │
                                  ┌─────────────┴─────────────┐
                                  │                           │
                               failure                     success
                                  │                           │
                                  ▼                           ▼
                              AUTH_FAILED              AUTHENTICATED
                                                              │
                                                              ▼
                                                    ENTITLEMENT_VALIDATING
                                                              │
                                               ┌──────────────┴──────────────┐
                                               │                             │
                                            failure                        success
                                               │                             │
                                               ▼                             ▼
                                      NOT_OPERATIONAL                  OPERATIONAL
                                                                             │
                            ┌────────────────────────────────────────────────┤
                            │                    │                 │          │
                            ▼                    ▼                 ▼          ▼
                        DEGRADED            EXPIRED           REVOKED     SECURITY
                                                                            FAILURE
                            │                    │                 │
                            └────────────────────┴─────────────────┘
                                                 │
                                                 ▼
                                           RECOVERY /
                                        REAUTHENTICATION
```

This is intentionally conceptual.

The actual state machine should be derived from the detailed behavioral specification.

---

# 84. The Most Important Design Question

For every security event, the architecture must eventually answer:

> **What authority does the application possess immediately before and immediately after this event?**

For example:

```text
License expires.

Before:
    authenticated = yes
    session = valid
    license = valid
    runtime = active

After:
    authenticated = ?
    session = ?
    license = expired
    runtime = ?
    new operations = ?
```

Or:

```text
Backend becomes unreachable.

Before:
    authenticated = yes
    license = valid

After:
    authenticated = ?
    session = ?
    license = ?
    offline operation = ?
```

Or:

```text
Machine revoked remotely.

Before:
    machine = trusted

After:
    machine = revoked
    session = ?
    license = ?
    runtime = ?
    active operations = ?
```

This is the level of precision required before implementation.

---

# 85. Final Architectural Principle

The Security Authority should not be designed as:

```text
routes/
controllers/
services/
```

first.

It should first be designed as:

```text
IDENTITY
    ↓
TRUST
    ↓
AUTHENTICATION
    ↓
SESSION
    ↓
ENTITLEMENT
    ↓
AUTHORIZATION
    ↓
SECURITY STATE
    ↓
OPERATIONAL AUTHORITY
```

surrounded by:

```text
Failure
Recovery
Revocation
Persistence
Concurrency
Cryptography
Time
Network
IPC
Local Tampering
Versioning
```

Only after these behaviors are defined should the implementation decomposition be chosen.

---

# 86. Implementation-Readiness Criteria

The Security Authority should not be considered ready for implementation until the architecture can answer:

1. What establishes identity?
2. Who is authoritative for identity?
3. What establishes machine trust?
4. How is authentication established?
5. What creates a session?
6. What invalidates a session?
7. What renews a session?
8. What happens when renewal fails?
9. What is authorization?
10. What is entitlement?
11. What happens when entitlement changes?
12. What happens when entitlement expires?
13. What happens when entitlement is revoked?
14. What happens when the backend disappears?
15. What happens when the backend returns?
16. What happens after system sleep?
17. What happens after a clock change?
18. What happens after a crash?
19. What happens after local state corruption?
20. What happens after state rollback?
21. What happens after machine identity duplication?
22. What happens when cryptographic keys rotate?
23. What happens when keys are lost?
24. What happens when messages are replayed?
25. What happens when messages arrive out of order?
26. What happens when authorization changes during execution?
27. What happens when license state changes during execution?
28. What happens when the Security Authority itself crashes?
29. What happens when another local process attempts to impersonate the frontend?
30. What happens when the local application is deliberately modified?
31. What operations are allowed offline?
32. What operations are denied offline?
33. Which security states survive restart?
34. Which security states must be re-established?
35. Which component is authoritative for each security decision?
36. What happens when authority cannot be determined?
37. What happens during application update?
38. What happens during rollback?
39. How are old protocol versions rejected?
40. How does the system recover from every terminal state?

If these questions have explicit answers, implementation becomes a much more mechanical exercise.

---

# 87. Final Mental Model

The Security Authority is best understood not as an authentication module.

It is a **continuous authority-management system**.

Its job is to maintain:

```text
WHO
 │
 ▼
IS THIS
 │
 ▼
MACHINE
 │
 ▼
TRUSTED?
 │
 ▼
SESSION VALID?
 │
 ▼
ENTITLED?
 │
 ▼
AUTHORIZED?
 │
 ▼
ALLOWED TO OPERATE?
```

while continuously dealing with:

```text
       ┌─────────────────────────────────────┐
       │                                     │
       │  Network failure                    │
       │  Backend failure                    │
       │  Session expiry                     │
       │  License changes                    │
       │  Revocation                         │
       │  Clock anomalies                    │
       │  Process crashes                    │
       │  Persistence failures               │
       │  Key rotation                       │
       │  Replay                             │
       │  Concurrency                        │
       │  IPC attacks                        │
       │  Local tampering                    │
       │  Version changes                    │
       │  Recovery                           │
       │                                     │
       └─────────────────────────────────────┘
```

The ultimate output of the Security Authority is therefore not merely:

```text
authenticated = true
```

It is closer to:

```text
Current Security Context
+
Current Security State
+
Current Entitlements
+
Current Authorization
+
Current Trust
+
Current Operational Policy
```

That context becomes the foundation on which the rest of the Control Plane operates.

**This document should be treated as the security-design foundation, not as the final implementation specification.** The next step should be to take this inventory and produce the actual **Security Authority Behavioral Specification**: a formal state machine containing every state, event, transition, invariant, side effect, recovery path, and policy decision. That document will be considerably more concrete than this threat/edge-case inventory and can then serve as the blueprint for the actual module architecture.

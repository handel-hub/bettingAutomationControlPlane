# Security Authority Architecture & Internal Design

**Document:** `security_authority_architecture.md`
**System:** Runtime Synchronization Platform — Control Plane
**Component:** Security Authority
**Status:** Architecture Definition
**Scope:** Internal architecture and implementation boundaries

---

# 1. Purpose

The **Security Authority** is the security-critical subsystem of the Control Plane responsible for establishing, maintaining, evaluating, and terminating the security state under which the local application is permitted to operate.

It is responsible for answering a fundamental question:

> **Given the current identity, machine, session, authorization, licensing, integrity, connectivity, and security conditions, what operations is this Control Plane currently permitted to perform?**

The Security Authority is therefore not merely an authentication service.

It is the **local security authority and security-state coordinator** for the Control Plane.

It establishes the security boundary between:

```text
Untrusted / partially trusted inputs
              │
              ▼
       Security Authority
              │
              ▼
     Authorized Control Plane
              │
              ▼
       Execution Plane
```

The Security Authority does not own the application's business logic.

It does not own browser automation.

It does not own synchronization.

It does not own Playwright.

It does not determine why an operation is being performed.

It determines whether an operation is **security-permitted**.

---

# 2. Architectural Objective

The Security Authority must provide:

- strong security-state isolation;
- explicit security decisions;
- centralized authorization enforcement;
- machine identity management;
- authentication coordination;
- session lifecycle management;
- license-state management;
- integrity monitoring;
- tamper detection;
- replay protection;
- security-state persistence;
- secure backend communication;
- failure containment;
- deterministic state transitions;
- crash recovery;
- protection against stale state;
- protection against rollback;
- protocol-version validation;
- security-event propagation.

The architecture must remain independently replaceable.

Other Control Plane subsystems should not need to know how authentication, licensing, integrity verification, or session management are internally implemented.

---

# 3. Fundamental Architectural Principle

The Security Authority must be treated as a **security subsystem**, not as a collection of unrelated services.

The following architecture is explicitly discouraged:

```text
controllers/
    authController
    licenseController

services/
    authService
    licenseService
    sessionService

utils/
    crypto
    hash
    machineId
```

This arrangement can cause security decisions to become distributed throughout the application.

Instead, the Security Authority should expose a single coherent security boundary:

```text
security_authority/
│
├── public interface
│
├── security state
│
├── authentication
│
├── authorization
│
├── licensing
│
├── session
│
├── machine identity
│
├── integrity
│
├── cryptography
│
├── persistence
│
├── protocol
│
├── recovery
│
└── security events
```

The exact physical folder structure can change.

The architectural boundary should not.

---

# 4. Black-Box Boundary

The rest of the Control Plane should interact with the Security Authority through an explicit interface.

Conceptually:

```text
                  Control Plane
                       │
                       │
              ┌────────▼────────┐
              │ Security        │
              │ Authority       │
              │                 │
              │   BLACK BOX     │
              └────────┬────────┘
                       │
            Security decisions
                       │
                       ▼
              Control Plane
```

The caller should not need to know whether the Security Authority internally uses:

- Node.js;
- Rust;
- WebAssembly;
- SQLite;
- native cryptography;
- operating-system facilities;
- multiple internal services.

Those are implementation details.

---

# 5. Responsibilities

The Security Authority owns the following domains.

## 5.1 Identity

Responsible for:

- authentication state;
- authenticated principal;
- identity lifecycle;
- identity invalidation;
- authentication failures.

---

## 5.2 Machine Identity

Responsible for:

- machine identity creation;
- machine identity persistence;
- machine identity verification;
- machine binding;
- machine identity corruption;
- machine identity replacement;
- clone detection signals.

---

## 5.3 Session

Responsible for:

- session establishment;
- session lifetime;
- session renewal;
- expiration;
- invalidation;
- logout;
- session generations;
- stale-session detection.

---

## 5.4 Authorization

Responsible for:

- determining whether an authenticated principal is authorized;
- evaluating permissions;
- enforcing authorization freshness;
- processing authorization changes;
- processing revocation.

---

## 5.5 Licensing

Responsible for:

- license state;
- entitlement state;
- license expiration;
- license renewal;
- downgrade;
- upgrade;
- revocation.

The Security Authority does **not** become the ultimate license authority.

The Backend remains authoritative.

---

## 5.6 Integrity

Responsible for determining whether security-critical local state and components remain sufficiently trustworthy.

It includes:

- binary integrity;
- security configuration integrity;
- security-state integrity;
- installation integrity;
- update integrity;
- rollback detection;
- suspicious state detection.

---

## 5.7 Cryptographic Trust

Responsible for coordinating:

- cryptographic identities;
- key material;
- signatures;
- verification;
- key rotation;
- certificate validation;
- protocol security.

Cryptographic primitives themselves should preferably come from well-established libraries rather than custom implementations.

---

## 5.8 Security Persistence

Responsible for securely persisting security-related state.

Examples:

- machine identity;
- security state;
- session metadata;
- security generations;
- trusted metadata;
- encrypted credentials;
- cached authorization artifacts.

The persistence layer is **not itself an authority**.

Stored state must always be treated as potentially stale or corrupted.

---

# 6. Non-Responsibilities

The Security Authority must never own:

### Browser management

```text
launch browser
close browser
browser context
page
locator
Playwright
```

### Synchronization

```text
event synchronization
DOM synchronization
scheduler
replay
action simulation
```

### File transfer

```text
chunk upload
download
file assembly
transfer retries
```

### Frontend presentation

```text
React
UI state
layout
notifications
```

### Business persistence

```text
bets
accounts
application data
business records
```

### Backend authority

The Security Authority does not replace the Backend.

---

# 7. Trust Boundaries

The Security Authority sits between several different trust domains.

```text
                  BACKEND
                     │
             Remote Authority
                     │
                     ▼
          ┌─────────────────────┐
          │  SECURITY AUTHORITY │
          └─────────────────────┘
             ▲       ▲       ▲
             │       │       │
         Frontend   Local   Runtime
                   System
```

Each boundary must be treated differently.

---

# 8. Frontend Trust Model

The Frontend is a **client**, not a security authority.

The Frontend may request:

```text
login
logout
runtime start
runtime stop
configuration changes
file transfer
status information
```

But it cannot declare:

```text
authenticated = true
authorized = true
license = valid
```

The Security Authority determines those values.

---

# 9. Backend Trust Model

The Backend is the authoritative remote security authority.

It ultimately determines:

- account identity;
- account status;
- machine registration;
- authorization;
- license entitlement;
- revocation;
- security policy.

The Control Plane maintains a local representation of that state for runtime operation.

---

# 10. Execution Plane Trust Model

The Execution Plane is a separate system.

The Security Authority does not inspect its internals.

It only establishes whether the Control Plane is currently permitted to instruct it to operate.

Conceptually:

```text
Security Authority
       │
       │ authorized
       ▼
Runtime Manager
       │
       ▼
Execution Plane
```

The Execution Plane does not independently determine subscription authorization.

---

# 11. Internal Architecture

The Security Authority is divided into logical subsystems.

```text
Security Authority
│
├── Security Facade
│
├── Security Decision Engine
│
├── Identity Manager
│
├── Machine Identity Manager
│
├── Session Manager
│
├── Authorization Manager
│
├── License Manager
│
├── Integrity Manager
│
├── Trust & Key Manager
│
├── Security State Store
│
├── Security Protocol
│
├── Replay Protection
│
├── Time Security Manager
│
├── Recovery Manager
│
└── Security Event Manager
```

These are **logical components**.

They do not necessarily need to become separate processes.

---

# 12. Security Facade

The Security Facade is the only public entry point into the Security Authority.

Its responsibility is to:

- expose security operations;
- validate operation requests;
- coordinate internal components;
- prevent callers from manipulating internal state;
- provide a stable API.

Conceptually:

```text
Control Plane
      │
      ▼
SecurityAuthority
      │
 ┌────┼────────┬────────┐
 ▼    ▼        ▼        ▼
Auth  Session  License  Integrity
```

External callers should not directly access:

```text
SessionManager
LicenseManager
IntegrityManager
```

They communicate through the authority.

---

# 13. Security Decision Engine

The Security Decision Engine is the core reasoning component.

Its purpose is to determine whether a requested operation is currently permitted.

It evaluates security state rather than merely checking one variable.

Conceptually:

```text
Operation Request
       │
       ▼
Security Decision Engine
       │
       ├── Identity
       ├── Session
       ├── Authorization
       ├── License
       ├── Machine
       ├── Integrity
       ├── Time
       ├── Protocol
       └── Security State
       │
       ▼
 Security Decision
```

Possible results:

```text
ALLOW
DENY
REAUTHENTICATE
REAUTHORIZE
RENEW
BLOCK
DEGRADED
```

The exact decision vocabulary will be defined in a later protocol document.

---

# 14. Identity Manager

The Identity Manager handles authentication.

It does not directly determine licensing.

Its responsibility is establishing:

```text
Who is the authenticated principal?
```

Possible states:

```text
UNKNOWN
AUTHENTICATING
AUTHENTICATED
INVALID
REVOKED
```

Authentication success does not imply authorization.

For example:

```text
Authentication = SUCCESS
Authorization  = DENIED
```

is completely valid.

---

# 15. Machine Identity Manager

The Machine Identity Manager establishes the identity of the local installation/machine binding.

Responsibilities:

- identity creation;
- persistence;
- retrieval;
- validation;
- corruption detection;
- replacement;
- backend registration;
- clone detection signals.

It must distinguish:

```text
application installation identity
```

from:

```text
user identity
```

and from:

```text
license identity
```

These are separate concepts.

---

# 16. Session Manager

The Session Manager controls the lifetime of authenticated security sessions.

It handles:

- creation;
- activation;
- renewal;
- expiry;
- invalidation;
- logout;
- session generation;
- stale responses;
- concurrent sessions.

It must not assume that:

```text
session exists locally
```

means:

```text
session is valid remotely
```

---

# 17. Authorization Manager

The Authorization Manager evaluates what the authenticated principal is allowed to do.

It handles:

- authorization acquisition;
- permission sets;
- authorization freshness;
- authorization changes;
- revocation;
- stale authorization state.

Authorization should be treated as **time-sensitive state**.

---

# 18. License Manager

The License Manager maintains the local representation of the license entitlement.

It handles:

- initial license acquisition;
- validation;
- refresh;
- expiration;
- downgrade;
- upgrade;
- revocation;
- grace periods.

The License Manager does not manufacture licenses.

---

# 19. Integrity Manager

The Integrity Manager is responsible for detecting conditions suggesting that the local security environment may have been modified.

It monitors security-critical assets and state.

Conceptually:

```text
Integrity Manager
│
├── Binary Verification
├── Configuration Verification
├── State Verification
├── Manifest Verification
├── Rollback Detection
├── Installation Verification
└── Tamper Classification
```

It produces security signals such as:

```text
VERIFIED
SUSPECTED
FAILED
COMPROMISED
UNKNOWN
```

---

# 20. Trust & Key Manager

The Trust & Key Manager manages cryptographic trust relationships.

It may contain:

```text
Local identity keys
Backend trust anchors
Session keys
Encryption keys
Signing keys
Verification keys
Certificate metadata
Key generations
```

Private keys must not be unnecessarily exposed to Node.js or JavaScript code.

Security-sensitive key operations are candidates for native/Rust implementation.

---

# 21. Security State Store

The Security State Store provides persistence for local security state.

Potential backend:

```text
SQLite
```

The store may contain:

```text
machine identity metadata
session metadata
security generations
authorization cache
license metadata
integrity metadata
protocol metadata
```

But:

> **The Security State Store is storage, not authority.**

An attacker modifying the database must not automatically obtain authorization.

---

# 22. Security Protocol

The Security Protocol defines communication with the Backend.

It handles:

```text
request creation
message serialization
message authentication
message encryption where required
nonce generation
sequence numbers
request correlation
response verification
protocol versions
key generations
timeouts
```

It should be independent from Express.

The HTTP/WebSocket transport should be replaceable without changing security semantics.

---

# 23. Replay Protection

Replay Protection prevents an attacker from capturing a previously valid security message and submitting it again.

It should reason about:

```text
request identity
session generation
message generation
nonce
sequence
freshness
expiration
```

A replayed message should never be interpreted as a new authorization event.

---

# 24. Time Security Manager

The Time Security Manager exists because time is security-sensitive.

It observes:

```text
wall-clock time
monotonic time
server-provided time
session expiration
license expiration
observed clock progression
```

It detects:

```text
clock rollback
clock jump
clock discontinuity
sleep/resume anomalies
server/local disagreement
```

The system should avoid basing security solely on an attacker-controlled wall clock.

---

# 25. Recovery Manager

The Recovery Manager coordinates recovery from security failures.

Examples:

```text
session expired
backend unavailable
database corrupted
machine identity corrupted
key rotation
protocol mismatch
integrity failure
application restart
```

It should never silently convert:

```text
SECURITY_FAILURE
```

into:

```text
AUTHORIZED
```

Recovery must itself satisfy the security state machine.

---

# 26. Security Event Manager

The Security Authority should emit domain-level security events.

Examples:

```text
AuthenticationStarted
AuthenticationSucceeded
AuthenticationFailed

AuthorizationGranted
AuthorizationRevoked

LicenseActivated
LicenseExpired
LicenseRevoked

SessionCreated
SessionRenewed
SessionExpired
SessionInvalidated

MachineRegistered
MachineIdentityChanged

IntegrityCheckStarted
IntegrityVerified
IntegrityFailureDetected
TamperingSuspected
TamperingConfirmed

ClockAnomalyDetected

SecurityStateChanged
SecurityBlocked
```

These events should not themselves grant authority.

They are observations of security state transitions.

---

# 27. Dependency Direction

Dependencies should flow toward security abstractions.

Conceptually:

```text
                Security Facade
                       │
                       ▼
             Decision Engine
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
   Identity         Session         Authorization
       │               │                │
       └───────────────┼────────────────┘
                       ▼
                    License
                       │
                       ▼
                   Integrity
                       │
                       ▼
               Security State
```

Infrastructure should sit underneath:

```text
Protocol
Persistence
Crypto
OS integration
```

The core security model should not depend directly on Express, WebSocket, SQLite, or filesystem APIs.

---

# 28. Transport Independence

The Security Authority should not care whether communication with the Backend uses:

```text
WebSocket
HTTP
TCP
IPC
another transport
```

The protocol layer should abstract transport.

For example:

```text
Security Protocol
       │
       ▼
Transport Interface
       │
       ├── WebSocket
       ├── HTTPS
       └── Future Transport
```

This preserves architectural flexibility.

---

# 29. Node/Rust Boundary

Rust should not be inserted everywhere simply because security is important.

The boundary should be based on **trust and security sensitivity**.

Potential Rust/native responsibilities:

```text
cryptographic primitives
key handling
secure machine identity
integrity verification
native security checks
protected protocol operations
sensitive serialization/deserialization
tamper-sensitive logic
```

Node.js can coordinate:

```text
API
orchestration
application lifecycle
filesystem
network transport
event routing
UI communication
```

The critical architectural principle is:

> **Moving code to Rust does not automatically make it secure.**

The security comes primarily from the architecture and trust model.

Rust increases the cost of analysis and modification and can reduce exposure of sensitive logic, but it does not turn client-side code into an unbreakable trust boundary.

---

# 30. WebAssembly Boundary

WebAssembly may be used for:

- deterministic validation;
- hashing;
- serialization;
- data transformation;
- performance-sensitive pure computations.

It should not be assumed to be a security boundary against a local attacker.

The attacker controls the client environment.

Therefore:

```text
WASM ≠ trusted authority
Rust ≠ trusted authority
Node ≠ trusted authority
```

The Backend remains the ultimate remote authority.

---

# 31. Security State Ownership

The Security Authority owns:

```text
authentication state
authorization state
license state
session state
machine binding state
integrity state
security protocol state
```

The Frontend owns:

```text
presentation
```

The Runtime Manager owns:

```text
runtime lifecycle
```

The Execution Plane owns:

```text
automation runtime
```

The Backend owns:

```text
authoritative identity
authoritative authorization
authoritative licensing
revocation
persistent account data
```

---

# 32. Security Decision Flow

A typical privileged operation should conceptually flow like:

```text
Frontend
   │
   │ intent
   ▼
Control Plane API
   │
   ▼
Security Authority
   │
   ├── identity valid?
   ├── session valid?
   ├── authorization valid?
   ├── license valid?
   ├── machine valid?
   ├── integrity acceptable?
   ├── request fresh?
   └── protocol valid?
   │
   ▼
Security Decision
   │
   ├── DENY
   │
   └── ALLOW
          │
          ▼
      Runtime Manager
          │
          ▼
      Execution Plane
```

The Security Authority does not execute the operation.

It determines whether execution is permitted.

---

# 33. Security Invariants

The following invariants are mandatory.

### Invariant 1

A locally stored license cannot independently establish authorization.

### Invariant 2

Authentication does not imply authorization.

### Invariant 3

Authorization does not imply license validity.

### Invariant 4

A valid license does not imply machine validity.

### Invariant 5

A valid session does not override a revocation.

### Invariant 6

Frontend input cannot directly mutate security state.

### Invariant 7

Local database state cannot override authoritative backend state.

### Invariant 8

Expired security state cannot become valid merely because the local clock changed.

### Invariant 9

Replayed security messages cannot produce new authorization.

### Invariant 10

Detected compromise cannot silently transition to operational state.

### Invariant 11

Execution Plane availability does not imply authorization.

### Invariant 12

Security failures fail closed for security-critical operations.

---

# 34. Fail-Closed Does Not Mean "Everything Stops"

The architecture should distinguish between:

```text
security-critical operation
```

and:

```text
non-security-critical operation
```

For example, if the backend is temporarily unavailable:

```text
view local logs
```

may remain available.

Whereas:

```text
start licensed execution runtime
```

may require valid authorization.

Therefore the Security Authority should provide **operation-level security decisions**, rather than simply:

```text
application = locked
```

or:

```text
application = unlocked
```

---

# 35. Security Authority and Offline Operation

Offline operation should be explicitly policy-controlled.

Possible model:

```text
ONLINE
   │
   ▼
AUTHORIZATION VALID
   │
   │ backend unavailable
   ▼
OFFLINE_GRACE
   │
   ├── backend returns
   │       ↓
   │   REVALIDATE
   │
   └── grace expires
           ↓
       BLOCKED
```

The offline grace policy must not be modifiable by ordinary local configuration.

---

# 36. Concurrency

The Security Authority must be designed for concurrent events.

For example:

```text
Thread A:
license refresh

Thread B:
session expiration

Thread C:
frontend runtime start

Thread D:
backend revocation
```

The system must not produce an impossible state such as:

```text
license = expired
authorization = valid
runtime = authorized
```

when the policy says the runtime requires a valid license.

Security-state transitions must therefore be serialized or otherwise coordinated through a deterministic state-management mechanism.

---

# 37. Atomic Security State Transitions

A security transition should conceptually be:

```text
Observe
   ↓
Validate
   ↓
Determine transition
   ↓
Persist required state
   ↓
Publish state change
```

The system must avoid:

```text
change memory
   ↓
crash
   ↓
database still contains old state
```

without having a recovery strategy.

---

# 38. Crash Safety

If the process crashes during:

```text
session renewal
license refresh
authorization update
machine registration
key rotation
integrity transition
```

the next startup must reconstruct security state safely.

It should never assume:

```text
last operation succeeded
```

unless success was durably established.

---

# 39. Startup

Startup should roughly follow:

```text
Process Start
     │
     ▼
Load minimal local state
     │
     ▼
Validate state structure
     │
     ▼
Validate integrity
     │
     ▼
Validate machine identity
     │
     ▼
Initialize cryptographic trust
     │
     ▼
Evaluate persisted security state
     │
     ▼
Determine whether reauthentication/revalidation is required
     │
     ▼
Security Authority READY
```

The Execution Plane should not be started before the required security conditions are satisfied.

---

# 40. Shutdown

Shutdown must be security-aware.

It should:

- stop accepting new privileged operations;
- invalidate volatile security operations;
- safely persist necessary state;
- terminate active security transactions;
- close protocol channels;
- securely dispose of sensitive material where appropriate.

Shutdown should not accidentally leave the system in a state that appears permanently authorized on restart.

---

# 41. What This Architecture Deliberately Avoids

The Security Authority does **not** become:

```text
God object
```

containing:

```text
authentication
file transfer
browser management
HTTP
database
frontend
execution
logging
configuration
```

Instead:

```text
Security Authority
        │
        ├── security decisions
        ├── security state
        └── security lifecycle
```

Everything else remains outside it.

---

# 42. Architectural Mental Model

The most useful mental model for this subsystem is:

```text
                 ┌───────────────────────┐
                 │       BACKEND         │
                 │                       │
                 │ Ultimate Authority    │
                 └───────────┬───────────┘
                             │
                      Security Protocol
                             │
                             ▼
┌────────────────────────────────────────────────┐
│               SECURITY AUTHORITY               │
│                                                │
│ Identity       Session       Authorization     │
│ Machine        License       Integrity         │
│ Trust          Keys          Replay Protection │
│ Time           Persistence   Recovery          │
│                                                │
│              Security Decision Engine          │
└───────────────────────┬────────────────────────┘
                        │
                 Security Decision
                        │
                        ▼
                ┌───────────────┐
                │ Control Plane │
                └───────┬───────┘
                        │
                        ▼
                ┌───────────────┐
                │ Runtime       │
                │ Manager       │
                └───────┬───────┘
                        │
                        ▼
                ┌───────────────┐
                │ Execution     │
                │ Plane         │
                └───────────────┘
```

The Security Authority is therefore **not another ordinary backend service**.

It is a **security boundary embedded inside the Control Plane**.

---

# 43. Final Architectural Principle

The entire design can ultimately be reduced to one principle:

> **The Control Plane may coordinate the application, but the Security Authority determines whether that coordination is currently allowed.**

And the Security Authority itself does not become the ultimate source of truth.

The hierarchy is:

```text
Backend
   │
   │ authoritative security facts
   ▼
Security Authority
   │
   │ locally enforced security decisions
   ▼
Control Plane
   │
   │ authorized commands
   ▼
Execution Plane
```

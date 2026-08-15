# Security Authority Protocol Specification

**Document:** `security_authority_protocol_specification.md`
**Status:** Design Specification
**Scope:** Control Plane Security Authority
**Primary Concern:** Authentication, authorization, licensing, session security, machine identity, protocol integrity, tamper resistance, and security-state synchronization.

---

## 1. Purpose

The **Security Authority Protocol (SAP)** defines the protocol through which the Control Plane establishes, maintains, validates, and terminates its security relationship with the Backend.

The protocol is responsible for answering:

1. **Who is this user?**
2. **What machine is this?**
3. **Is this application installation legitimate?**
4. **Is this session currently valid?**
5. **What is this machine authorized to do?**
6. **Is the license currently valid?**
7. **Has authorization changed?**
8. **Has the security state been revoked?**
9. **Can the Control Plane safely continue operating?**
10. **Can messages received from the Backend be trusted?**

The protocol does **not** implement application business logic.

It establishes the security authority under which the rest of the Control Plane is permitted to operate.

---

# 2. Architectural Position

```text
                    ┌─────────────────────┐
                    │       Backend       │
                    │                     │
                    │ Identity Authority  │
                    │ License Authority   │
                    │ Authorization       │
                    │ Session Authority   │
                    └──────────┬──────────┘
                               │
                         Secure Protocol
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Security Authority│
                    │                     │
                    │ Authentication      │
                    │ Authorization       │
                    │ Licensing           │
                    │ Session             │
                    │ Machine Identity    │
                    │ Integrity           │
                    │ Security State      │
                    └──────────┬──────────┘
                               │
                        Security Decision
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
       Runtime Manager    File Service       API Server
             │
             ▼
       Execution Plane
```

The Security Authority is the **security boundary between the locally running application and the Backend authority**.

---

# 3. Fundamental Trust Model

The protocol operates under the assumption that the local machine is **potentially hostile**.

This is critical.

The user may have:

- administrator privileges,
- debugger access,
- filesystem access,
- process inspection capabilities,
- ability to modify binaries,
- ability to modify local databases,
- ability to manipulate configuration,
- ability to modify system time,
- ability to terminate processes,
- ability to intercept local IPC,
- ability to snapshot or clone the machine.

Therefore:

> Local security state is never inherently authoritative.

The Backend remains the ultimate authority for:

- account identity,
- account status,
- license status,
- machine authorization,
- revocation,
- server-side policy.

The Control Plane maintains a **locally enforceable representation** of that authority.

---

# 4. Protocol Principles

The protocol MUST follow these principles.

### 4.1 Authentication is not authorization

A successful authentication means:

```text
"I know who you are."
```

It does not mean:

```text
"You may perform every operation."
```

Authorization and licensing are separate decisions.

---

### 4.2 Encryption does not establish trust

Encryption provides confidentiality.

Authentication/integrity mechanisms provide authenticity.

The protocol must therefore distinguish:

```text
Confidentiality
Integrity
Authenticity
Authorization
Freshness
Replay protection
```

These are separate properties.

---

### 4.3 The client is not authoritative

The Control Plane cannot declare:

```text
license = valid
```

merely because its local database says so.

It may maintain cached authorization state, but authoritative license decisions originate from the Backend.

---

### 4.4 Every security-sensitive message must have provenance

A security message must be attributable to:

```text
specific server
specific protocol
specific session
specific request
specific security epoch
```

---

### 4.5 Messages must have freshness

A valid message from yesterday must not automatically become a valid message today.

The protocol therefore uses:

- session identifiers,
- request identifiers,
- sequence numbers,
- timestamps where appropriate,
- expiration,
- cryptographic authentication,
- security epochs.

---

# 5. Protocol Participants

The protocol contains two primary participants.

## 5.1 Control Plane

The local application.

It contains:

```text
Security Authority
Machine Identity
Session Manager
Credential Manager
Authorization State
License State
Protocol Handler
Secure Storage
```

---

## 5.2 Backend Security Authority

The remote authority.

It contains:

```text
Identity Authority
Authentication Authority
Machine Registry
License Authority
Authorization Authority
Revocation Authority
Session Authority
Key Management
Protocol Version Authority
```

The Backend does not need to know how the Control Plane internally implements these components.

---

# 6. Security Identity Model

The protocol distinguishes several identities.

```text
User Identity
Machine Identity
Installation Identity
Application Identity
Session Identity
Transfer/Request Identity
```

These MUST NOT be conflated.

---

## 6.1 User Identity

Represents the authenticated account.

Example:

```text
user_id = U123456
```

---

## 6.2 Machine Identity

Represents the authorized machine.

Example:

```text
machine_id = M8A91...
```

The machine identity must persist across normal application restarts.

---

## 6.3 Installation Identity

Represents a specific installation instance.

This is useful for detecting:

- copied installations,
- cloned installations,
- duplicated installations.

Example:

```text
installation_id = I7B91...
```

---

## 6.4 Session Identity

Represents one authenticated security session.

```text
session_id = S...
```

A session MUST NOT be reused indefinitely.

---

# 7. Machine Identity

Machine identity creation occurs during initial installation/registration.

Conceptually:

```text
Install
   │
   ▼
Generate local machine key material
   │
   ▼
Generate installation identity
   │
   ▼
Register with Backend
   │
   ▼
Backend validates registration
   │
   ▼
Machine authorized
```

The private cryptographic material must not be transmitted as plaintext.

---

# 8. Machine Identity Properties

The machine identity system should support:

- persistence,
- integrity verification,
- replacement detection,
- duplication detection,
- cloning detection,
- recovery,
- revocation.

The protocol must distinguish:

```text
machine identity missing
machine identity corrupted
machine identity changed
machine identity duplicated
machine identity revoked
```

These are different conditions.

---

# 9. Secure Storage

Security-sensitive local state may include:

```text
machine private key
installation identity
session metadata
server identity
certificate information
security epochs
authorization cache
license metadata
```

Sensitive material should be protected using OS-provided secure storage where available.

The local database should **not** be treated as a trust root.

---

# 10. Protocol Message Envelope

All security protocol messages should use a common envelope.

Conceptually:

```text
SecurityMessage {
    protocol_version
    message_type
    message_id
    session_id
    machine_id
    installation_id
    security_epoch
    sequence_number
    issued_at
    expires_at
    payload
    authentication
}
```

The exact binary representation is implementation-defined.

---

# 11. Message ID

Every request receives a unique identifier.

```text
message_id
```

This allows the receiver to detect duplicate messages.

Example:

```text
REQ-7A92...
```

---

# 12. Sequence Number

Messages within a session may contain monotonically increasing sequence numbers.

Example:

```text
100
101
102
103
```

Receiving:

```text
101
```

after:

```text
103
```

may indicate:

- delayed delivery,
- replay,
- reordering,
- protocol violation.

The protocol must define which messages permit reordering.

---

# 13. Security Epoch

The Security Authority maintains a security epoch.

Example:

```text
epoch = 42
```

A security epoch changes when major security state changes occur.

Examples:

- session replacement,
- revocation,
- credential rotation,
- machine authorization change,
- server security reset.

Messages associated with an obsolete epoch must not be accepted as current authority.

---

# 14. Authentication Protocol

The authentication process is conceptually:

```text
Frontend
   │
   │ credentials
   ▼
Control Plane
   │
   │ authentication request
   ▼
Backend
   │
   ├── authenticate user
   ├── validate machine
   ├── establish session
   └── determine authorization
   │
   ▼
Control Plane
```

The frontend must never communicate directly with the Backend security authority.

---

# 15. Credential Handling

The Control Plane must not invent its own cryptographic protection around passwords as a replacement for a proper authentication protocol.

In particular:

> "Encrypt password + random value and send it to the server" is not, by itself, a secure authentication protocol.

The protocol should instead use an established authenticated channel and a properly designed authentication mechanism.

Passwords should not become long-lived protocol credentials.

---

# 16. Authentication Result

Authentication should produce an explicit result.

Example:

```text
AuthenticationResult {
    status
    user_id
    session_id
    session_expiry
    security_epoch
    authorization_state
    license_state
    capabilities
}
```

Possible authentication states:

```text
AUTHENTICATED
AUTHENTICATION_FAILED
MACHINE_REJECTED
ACCOUNT_REVOKED
ACCOUNT_LOCKED
PROTOCOL_REJECTED
SECURITY_FAILURE
```

---

# 17. Authorization

Authorization is evaluated independently.

Conceptually:

```text
Authentication
       │
       ▼
Identity established
       │
       ▼
Authorization evaluation
       │
       ▼
Capabilities
```

For example:

```text
{
    automation: true,
    browser_limit: 20,
    file_upload: true,
    file_download: true
}
```

The Control Plane should consume capabilities rather than embedding assumptions about account types.

---

# 18. Licensing

Licensing is another independent authority.

Conceptually:

```text
Authenticated User
       │
       ▼
License Authority
       │
       ├── valid
       ├── expired
       ├── revoked
       ├── suspended
       └── downgraded
```

A valid account does not necessarily imply a valid license.

---

# 19. Authorization + License Decision

The final local security decision can conceptually be represented as:

```text
SecurityDecision {

    identity_valid
    machine_valid
    session_valid
    authorization_valid
    license_valid
    capabilities
    expires_at
}
```

The application may proceed only when the required conditions are satisfied.

---

# 20. Session Establishment

A session should be established only after:

```text
Server authentication
+
Machine validation
+
Authorization evaluation
+
License evaluation
```

The resulting session must have:

- unique identity,
- expiration,
- security epoch,
- server authentication,
- cryptographic binding.

---

# 21. Session Renewal

Sessions should not live indefinitely.

Before expiration:

```text
Control Plane
      │
      │ renewal request
      ▼
Backend
      │
      ├── session still valid
      ├── license still valid
      ├── machine still valid
      └── authorization still valid
      │
      ▼
New session state
```

Renewal should produce fresh security material rather than simply extending an old credential forever.

---

# 22. Renewal Failure

Possible outcomes:

### Temporary failure

Examples:

- network unavailable,
- timeout,
- DNS failure,
- temporary server failure.

The Security Authority may enter:

```text
RENEWAL_DEGRADED
```

subject to the application's offline policy.

### Permanent failure

Examples:

- session revoked,
- machine revoked,
- account disabled,
- license expired.

The Security Authority must transition to the corresponding restricted state.

---

# 23. Backend Revocation

Revocation must override cached local authorization.

Example:

```text
ACTIVE
  │
  │ backend revocation
  ▼
REVOKED
```

The Control Plane must stop authorizing operations that depend on the revoked authority.

---

# 24. License Expiration During Operation

This is an important distinction.

Suppose:

```text
Operation started
License valid
```

Then:

```text
License expires
```

The system must define whether the operation:

1. finishes,
2. pauses,
3. terminates,
4. becomes invalid.

The Security Authority must expose this policy explicitly rather than allowing individual subsystems to invent their own behavior.

---

# 25. Security Decision Boundary

The Security Authority should expose a narrow interface.

For example:

```text
authenticate()
logout()
getSessionState()
renewSession()
getAuthorization()
getLicenseState()
validateCapability()
getSecurityState()
subscribeSecurityEvents()
```

Other Control Plane subsystems should not access internal authentication structures.

---

# 26. Capability-Based Authorization

Instead of allowing subsystems to ask:

```text
"Is the user premium?"
```

prefer:

```text
"Does the current security context contain capability X?"
```

Example:

```text
CAP_AUTOMATION_START
CAP_BROWSER_ALLOCATE
CAP_FILE_UPLOAD
CAP_FILE_DOWNLOAD
```

This reduces coupling between business features and licensing implementation.

---

# 27. Local API Security

The frontend communicates with the Control Plane through the local API.

The frontend must therefore be treated as **untrusted input**, even though it is part of the same application.

A malicious local process may attempt to call:

```text
POST /runtime/start
POST /license/upgrade
POST /security/state
```

The Control Plane must authenticate/authorize sensitive local requests.

---

# 28. Local IPC Threat

The protocol must assume:

```text
Frontend
   │
   ├── legitimate
   └── malicious
```

and:

```text
Local Process
   │
   └── attempts to impersonate frontend
```

Therefore, localhost alone must not be considered a security boundary.

---

# 29. Tampering Model

The protocol assumes an attacker may attempt to modify:

```text
configuration
SQLite database
cached license
session state
machine identity
application files
security metadata
system clock
IPC messages
protocol messages
```

The Security Authority must detect security-state inconsistencies.

---

# 30. Local Security-State Integrity

Security state should contain integrity protection.

Conceptually:

```text
state
   +
metadata
   +
integrity protection
```

The goal is not to make local tampering impossible.

The goal is to prevent:

```text
modify local state
      ↓
application blindly trusts modification
      ↓
unauthorized operation
```

---

# 31. Tamper Detection

Possible indicators include:

```text
invalid state MAC/signature
unexpected machine identity
invalid security epoch
invalid session metadata
impossible state transition
rollback detected
unexpected installation identity
protocol state inconsistency
```

Detection should result in a security-state transition rather than simply a log message.

---

# 32. Rollback Detection

An attacker may restore:

```text
old database
old configuration
old encrypted state
old application snapshot
```

Therefore security state should contain monotonic information where appropriate.

Example:

```text
security_epoch = 42
```

If a restored state contains:

```text
security_epoch = 17
```

the Security Authority must not automatically accept it.

---

# 33. Replay Protection

The protocol must prevent old valid messages from becoming valid again.

Protection mechanisms may include:

```text
session identifiers
message IDs
sequence numbers
security epochs
expiration
cryptographic authentication
```

---

# 34. Duplicate Requests

A request such as:

```text
RenewSession
```

may arrive twice.

The protocol must define idempotency.

For security-sensitive operations:

```text
request_id
```

should be used to correlate repeated requests.

---

# 35. Out-of-Order Messages

Example:

```text
AuthorizationUpdate #8
AuthorizationUpdate #9
```

arrive as:

```text
#9
#8
```

The Security Authority must reject or ignore stale state updates according to the protocol's ordering rules.

A newer authorization state must never be replaced by an older state simply because the older message arrived later.

---

# 36. Old Responses

Consider:

```text
Session A
   │
   ├── request
   │
   └── session replaced

Session B
```

Then the response for Session A arrives.

It must not mutate Session B.

Therefore every security response must be bound to the security context under which it was generated.

---

# 37. Concurrent Authentication

Multiple login attempts may occur simultaneously.

The Security Authority must define whether:

```text
login A
login B
```

results in:

- one winning,
- multiple sessions,
- replacement,
- rejection,
- cancellation.

The state machine must not enter an inconsistent state.

---

# 38. Concurrent Control Plane Instances

Two local Control Plane processes may accidentally run simultaneously.

The application should detect this where necessary.

Possible mechanisms:

```text
process lock
installation lock
machine/session coordination
OS synchronization primitive
```

The important point is:

> Two processes must not simultaneously believe they exclusively own the same security state.

---

# 39. Sleep / Resume

System sleep may cause:

```text
network disappearance
clock changes
session expiration
TLS connection invalidation
DNS changes
```

On resume, the Security Authority must re-evaluate session validity.

It must not blindly assume the pre-sleep connection remains trustworthy.

---

# 40. Clock Anomalies

The protocol must tolerate:

```text
clock rollback
clock jump
NTP correction
manual clock change
VM clock manipulation
```

Local clock values should therefore not be treated as the sole authority for security decisions.

Server-issued expiration and monotonic local timers should be preferred where possible.

---

# 41. Server Time

Where expiration matters, the protocol may establish an authenticated server-time reference during session establishment.

Conceptually:

```text
server_time
local_monotonic_time
```

can be combined to calculate a local estimate of server time without trusting wall-clock changes blindly.

---

# 42. Key Rotation

The protocol must support:

```text
client key rotation
server key rotation
certificate rotation
session key rotation
```

Rotation must not require simultaneous upgrades of every component.

---

# 43. Protocol Version Negotiation

The initial handshake should establish:

```text
protocol_version
supported_versions
supported_features
cryptographic capabilities
```

An incompatible version must result in explicit failure.

It must never silently downgrade to an insecure protocol.

---

# 44. Capability Negotiation

The Backend may advertise:

```text
feature A
feature B
feature C
```

The Control Plane selects only mutually supported capabilities.

This allows future protocol evolution.

---

# 45. Secure Channel

The Control Plane ↔ Backend channel should provide:

```text
confidentiality
integrity
server authentication
freshness
replay resistance
```

A modern authenticated transport such as TLS should normally provide the foundational channel security.

The application protocol should add its own message-level protections only where there is a concrete architectural reason.

---

# 46. Do Not Invent Cryptography

The protocol should not define:

```text
custom encryption algorithm
custom key exchange
custom password encryption
custom MAC scheme
```

unless there is an exceptional and well-justified requirement.

Use established cryptographic primitives and protocols.

The architecture should be custom.

The cryptography should generally not be.

---

# 47. Security Context

Every authorized subsystem receives a restricted security context.

Conceptually:

```text
SecurityContext {
    session_id
    user_id
    machine_id
    authorization
    license
    capabilities
    security_epoch
    expires_at
}
```

The context should be immutable from the perspective of consumers.

Only the Security Authority can replace it.

---

# 48. Execution Plane Integration

The Security Authority should not expose credentials to the Execution Plane unnecessarily.

The Execution Plane should receive only the authorization necessary for execution.

For example:

```text
RuntimeStartAuthorized
```

rather than:

```text
user password
session refresh credential
license secret
```

This follows least privilege.

---

# 49. Security Events

The Security Authority should emit domain events.

Examples:

```text
AuthenticationStarted
AuthenticationSucceeded
AuthenticationFailed

SessionEstablished
SessionRenewed
SessionExpired
SessionRevoked

LicenseValidated
LicenseExpired
LicenseRevoked
LicenseChanged

MachineRegistered
MachineRejected
MachineIdentityChanged

SecurityStateTampered
SecurityStateRecovered

ProtocolViolation
SecurityEpochChanged
```

---

# 50. Event Consumers

Possible consumers:

```text
Runtime Manager
API Server
Telemetry
UI Gateway
Persistence
Application Manager
```

Consumers should react to security events.

They should not directly modify Security Authority state.

---

# 51. Failure Classification

Security failures should be classified.

### Authentication failures

```text
INVALID_CREDENTIALS
ACCOUNT_DISABLED
ACCOUNT_REVOKED
```

### Machine failures

```text
MACHINE_UNKNOWN
MACHINE_REVOKED
MACHINE_IDENTITY_INVALID
```

### Session failures

```text
SESSION_EXPIRED
SESSION_REVOKED
SESSION_INVALID
```

### License failures

```text
LICENSE_EXPIRED
LICENSE_REVOKED
LICENSE_INVALID
LICENSE_UNAVAILABLE
```

### Protocol failures

```text
PROTOCOL_MISMATCH
INVALID_MESSAGE
REPLAY_DETECTED
SEQUENCE_VIOLATION
```

### Local security failures

```text
SECURITY_STATE_CORRUPTED
SECURITY_STATE_TAMPERED
KEY_UNAVAILABLE
```

---

# 52. Degraded Operation

The Control Plane may temporarily lose Backend connectivity.

The protocol must explicitly define offline behavior.

Possible policies:

```text
FAIL_CLOSED
LIMITED_OFFLINE_OPERATION
GRACE_PERIOD
```

The choice is a product/security policy.

It must not emerge accidentally from retry logic.

For a subscription enforcement system, the offline policy should be deliberately conservative.

---

# 53. Startup Without Backend

Possible startup:

```text
Application starts
      │
      ▼
Security state loaded
      │
      ▼
Backend unavailable
```

The Control Plane must decide:

```text
Can UI start?
Can runtime start?
Can existing sessions continue?
Can new authentication occur?
Can file transfers occur?
Can execution begin?
```

These should be explicit capability decisions.

---

# 54. Security State vs Application State

These must remain separate.

Application state:

```text
runtime_running
browser_count
transfer_progress
configuration
```

Security state:

```text
session_valid
machine_valid
license_valid
authorization_valid
security_epoch
```

Application state must never override security state.

---

# 55. Security Authority as a Gate

The overall architecture becomes:

```text
                    Backend
                       │
                       │
                 Security Protocol
                       │
                       ▼
              ┌─────────────────┐
              │ Security        │
              │ Authority       │
              └────────┬────────┘
                       │
              Security Context
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       Runtime       Files       Local API
       Manager      Service       Server
          │
          ▼
    Execution Plane
```

The Security Authority therefore becomes a **policy gate**, not a generic middleware layer.

---

# 56. Protocol Lifecycle

The complete lifecycle is:

```text
INSTALL
   │
   ▼
MACHINE_REGISTRATION
   │
   ▼
AUTHENTICATION
   │
   ▼
AUTHORIZATION
   │
   ▼
LICENSE_VALIDATION
   │
   ▼
SESSION_ESTABLISHED
   │
   ▼
OPERATIONAL
   │
   ├──── renewal ────────┐
   │                     │
   │                     ▼
   │                 OPERATIONAL
   │
   ├──── revocation ───► REVOKED
   │
   ├──── expiration ───► EXPIRED
   │
   ├──── tampering ────► SECURITY_FAILURE
   │
   ├──── logout ───────► LOGGED_OUT
   │
   └──── crash ────────► RECOVERY
```

---

# 57. Logout

Logout must invalidate the local security context.

Conceptually:

```text
Operational
     │
     │ logout
     ▼
TerminatingSession
     │
     ▼
LoggedOut
```

The Control Plane should invalidate local authorization immediately rather than waiting for Backend confirmation.

Backend logout/revocation synchronization can occur independently.

---

# 58. Crash Recovery

After a crash:

```text
Process starts
    │
    ▼
Load security state
    │
    ▼
Verify integrity
    │
    ├── invalid ──► SECURITY_FAILURE
    │
    ▼
Re-establish Backend relationship
    │
    ▼
Revalidate session
    │
    ▼
Restore operational state
```

The application must not simply trust the previous process state.

---

# 59. Security Authority Invariants

The following invariants must always hold.

### Invariant 1

```text
Unauthenticated
⇒ no authorized operation
```

### Invariant 2

```text
Invalid machine
⇒ no authorized operation
```

### Invariant 3

```text
Expired session
⇒ no operation requiring active authorization
```

### Invariant 4

```text
Revoked license
⇒ licensed capabilities unavailable
```

### Invariant 5

```text
Invalid security state
⇒ state cannot silently become trusted
```

### Invariant 6

```text
Old security messages
⇒ cannot overwrite newer state
```

### Invariant 7

```text
Security Authority
⇒ only component allowed to mutate security state
```

### Invariant 8

```text
Execution Plane
⇒ never receives unnecessary authentication secrets
```

---

# 60. What This Protocol Does Not Define

This document intentionally does not define:

- Playwright,
- browser synchronization,
- browser recovery,
- locator resolution,
- scheduler internals,
- DOM interaction,
- execution algorithms,
- file transfer internals,
- frontend presentation,
- database schema implementation,
- Backend business logic.

Those belong to their respective systems.

---

# 61. Recommended Initial Protocol Surface

The first implementation should remain small.

```text
registerMachine()

authenticate()

establishSession()

renewSession()

getAuthorization()

getLicense()

heartbeat()

logout()

getSecurityState()
```

Everything else should be added only when a concrete requirement exists.

---

# 62. Most Important Architectural Rule

The Security Authority should **not become a giant security utility library** that every subsystem calls arbitrarily.

Instead:

```text
Backend
    │
    ▼
Security Authority
    │
    ▼
Security Context
    │
    ▼
Control Plane subsystems
```

The Security Authority owns **security decisions**.

Other systems consume those decisions.

---

# 63. Final Mental Model

The cleanest way to think about the protocol is:

```text
                 WHO?
                  │
             Authentication
                  │
                  ▼
                 WHAT?
                  │
             Authorization
                  │
                  ▼
                 HOW MUCH?
                  │
               Licensing
                  │
                  ▼
                 HOW LONG?
                  │
                Session
                  │
                  ▼
                 STILL?
                  │
              Revalidation
                  │
                  ▼
                 TRUST?
                  │
          Integrity / Tamper
                  │
                  ▼
             SECURITY CONTEXT
                  │
       ┌──────────┼──────────┐
       ▼          ▼          ▼
    Runtime      Files      API
```

The central idea is that **authentication, authorization, licensing, session management, machine identity, and tamper detection are not six independent systems making unrelated decisions**.

They form one **Security Authority** whose job is to maintain a continuously valid answer to:

> **“Under the current security conditions, what is this Control Plane permitted to do?”**

That answer becomes the authoritative security context consumed by the rest of the Control Plane.

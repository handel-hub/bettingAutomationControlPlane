# Security Authority — Secure Communication Protocol & Message Semantics

**Document:** `security_authority_secure_communication_protocol.md`
**Status:** Design Specification
**Scope:** Control Plane ↔ Backend security communication
**Authority:** Security Authority
**Version:** 1.0

---

# 1. Purpose

This document defines the secure communication protocol between the **Control Plane Security Authority** and the **Backend Security/Authorization Service**.

The Security Authority is responsible for establishing, maintaining, validating, renewing, and terminating the security relationship between the local application and the backend.

The protocol must account for:

- authentication
- authorization
- licensing
- machine identity
- session establishment
- session renewal
- revocation
- cryptographic key management
- replay resistance
- message integrity
- message freshness
- protocol versioning
- backend failure
- local tampering
- clock anomalies
- application restarts
- network transitions
- stale responses
- concurrent requests
- compromised local state

The protocol must **not** assume that the local machine is trustworthy.

---

# 2. Security Model

The Control Plane runs on a machine controlled by the user.

Therefore:

> The Control Plane is a trusted execution environment only to the extent that its integrity has not been compromised.

The protocol must assume an attacker can potentially:

- inspect files
- inspect memory
- attach debuggers
- modify configuration
- modify local databases
- terminate processes
- restart processes
- replay captured messages
- modify system time
- clone installations
- copy application state
- invoke local APIs
- impersonate the frontend
- attempt to modify security decisions

The protocol therefore provides **cryptographic authorization**, rather than relying exclusively on local state.

---

# 3. Security Authority Position

The architecture is:

```text
                    BACKEND
                       │
             Secure Security Protocol
                       │
                       ▼
             ┌─────────────────────┐
             │  Security Authority │
             │                     │
             │ Authentication      │
             │ Authorization       │
             │ Licensing           │
             │ Session             │
             │ Machine Identity    │
             │ Key Management      │
             │ Integrity           │
             └──────────┬──────────┘
                        │
                 Authorization
                    Decisions
                        │
                        ▼
               Control Plane
                        │
                        ▼
                Execution Plane
```

The Execution Plane does not communicate directly with the Backend for security authorization.

The Frontend does not communicate directly with the Backend for authorization decisions.

---

# 4. Fundamental Principle

The most important protocol principle is:

> **Authentication, authorization, and licensing are separate facts.**

A successful login does not automatically mean the application is authorized to operate.

For example:

```text
Authentication = SUCCESS
Authorization  = SUCCESS
License        = EXPIRED
```

results in:

```text
Operational Authorization = DENIED
```

Similarly:

```text
Authentication = SUCCESS
Machine Binding = FAILED
```

must not result in an operational session.

---

# 5. Security Authority State

The Security Authority maintains authoritative local state representing its relationship with the Backend.

A conceptual state model is:

```text
UNINITIALIZED
      │
      ▼
INITIALIZING
      │
      ▼
IDENTITY_READY
      │
      ▼
AUTHENTICATING
      │
      ├──────────────► AUTHENTICATION_FAILED
      │
      ▼
AUTHENTICATED
      │
      ▼
AUTHORIZING
      │
      ├──────────────► AUTHORIZATION_FAILED
      │
      ▼
AUTHORIZED
      │
      ▼
OPERATIONAL
```

Operational state can subsequently transition into:

```text
RENEWING
DEGRADED
REVOKED
EXPIRED
SECURITY_FAILURE
TERMINATING
```

The complete state machine is defined in the separate Security Authority State Machine document.

---

# 6. Protocol Layers

The communication protocol should conceptually contain several layers.

```text
Application Message
        │
        ▼
Security Envelope
        │
        ▼
Integrity / Authentication
        │
        ▼
Replay / Freshness Protection
        │
        ▼
Transport Security
        │
        ▼
Network
```

Transport encryption and application-level message protection are separate concepts.

---

# 7. Transport Security

The primary transport should use a modern authenticated encrypted transport such as TLS.

The Control Plane must validate:

- server certificate
- certificate chain
- certificate validity
- hostname identity
- supported TLS version
- cryptographic parameters

TLS protects the communication channel.

It does **not** replace application-level authorization.

---

# 8. Why TLS Alone Is Not the Complete Model

TLS provides protection against network-level attacks.

However, the application has additional concerns.

For example:

```text
Control Plane
      │
      │ TLS
      ▼
Backend
```

does not protect against:

- compromised local application state
- replay of application messages
- stale local authorization decisions
- cloned application state
- local API abuse
- tampered configuration
- manipulated security state

Therefore the Security Authority must maintain its own protocol semantics.

---

# 9. Security Envelope

Every security-sensitive message should contain an authenticated envelope.

Conceptually:

```text
SecurityEnvelope {

    protocol_version

    message_type

    message_id

    session_id

    machine_id

    account_id

    sequence_number

    timestamp

    nonce

    payload

    integrity_proof
}
```

The exact binary representation is an implementation detail.

The semantics are not.

---

# 10. Message ID

Every message receives a unique identifier.

Example:

```text
message_id = UUID
```

The identifier allows the system to correlate:

```text
request
    ↓
response
```

and detect duplicate messages.

---

# 11. Session ID

Every authenticated session receives a unique session identifier.

Example:

```text
session_id = cryptographically_random_identifier
```

Messages belonging to one session must contain the corresponding session identifier.

A response belonging to an old session must never be accepted by a newer session.

Example:

```text
Session A
   │
   └── request A

Session expires

Session B
   │
   └── request B

Late response from A
   │
   X
   rejected
```

---

# 12. Sequence Numbers

Messages should contain monotonically increasing sequence numbers where the protocol direction requires ordered messages.

Example:

```text
Control Plane → Backend

1
2
3
4
5
```

A message with:

```text
sequence = 3
```

received after:

```text
sequence = 5
```

must not automatically be accepted.

This prevents certain replay and reordering attacks.

---

# 13. Nonces

Cryptographically secure nonces provide message freshness.

A nonce must:

- be unpredictable
- not be reused within the cryptographic context
- be validated before accepting the message

Nonces must never be generated using predictable values such as:

```text
Date.now()
Math.random()
incrementing integers
```

for cryptographic purposes.

---

# 14. Timestamps

Timestamps may be used for freshness and expiry.

However:

> The protocol must not depend exclusively on the local system clock.

The local clock can be:

- wrong
- modified
- rolled backward
- moved forward
- suspended during sleep
- restored from a snapshot

Therefore timestamps should be combined with:

- nonces
- sequence numbers
- session identifiers
- server-issued expiry information
- monotonic local timing where available

---

# 15. Machine Identity

The machine identity is distinct from the user account.

Conceptually:

```text
User
 │
 └── Account Identity

Machine
 │
 └── Machine Identity

Session
 │
 ├── Account Identity
 └── Machine Identity
```

The Backend can therefore enforce:

```text
Account X
+
Machine Y
+
License Z
```

as one authorization context.

---

# 16. Machine Identity Binding

During authentication, the Backend may validate:

```text
machine_id
account_id
installation identity
device credentials
```

against its records.

A valid account on an unauthorized machine must not automatically become operational.

---

# 17. Authentication Flow

A conceptual login sequence:

```text
Frontend
   │
   │ credentials
   ▼
Control Plane
   │
   ▼
Security Authority
   │
   │ Authentication Request
   ▼
Backend
   │
   ├── verify credentials
   ├── verify machine
   ├── verify account
   └── establish session
   │
   ▼
Security Authority
   │
   ├── authentication result
   ├── session information
   └── authorization information
   │
   ▼
Control Plane
```

The Frontend must never receive sensitive backend credentials or cryptographic session secrets unnecessarily.

---

# 18. Authentication Is Not Authorization

The Backend may return:

```text
authenticated = true
authorized = false
```

The Security Authority must preserve that distinction.

Example:

```text
Credentials valid
        ↓
Authentication SUCCESS
        ↓
License lookup
        ↓
License expired
        ↓
Authorization DENIED
```

The Execution Plane must not be started as an operationally authorized runtime.

---

# 19. Authorization Decision

An authorization decision should contain sufficient information to establish its validity.

Conceptually:

```text
AuthorizationDecision {

    decision
    subject
    machine
    license
    issued_at
    expires_at
    policy_version
    session_id
    decision_id
}
```

The Control Plane must not manufacture this information.

It is authoritative backend state.

---

# 20. License State

The Security Authority should represent licensing explicitly.

Possible states include:

```text
UNKNOWN
VALID
EXPIRING
EXPIRED
REVOKED
SUSPENDED
UPGRADED
DOWNGRADED
INVALID
```

License state changes must propagate through the Security Authority.

---

# 21. License Expiration

Suppose:

```text
License expires at 14:00
```

and the Execution Plane is currently running.

At expiration:

```text
Security Authority
        │
        ▼
License = EXPIRED
        │
        ▼
Operational authorization changes
        │
        ▼
Control Plane
        │
        ▼
Execution Plane
```

The Security Authority must define exactly what happens to active operations.

Possible policy:

```text
Existing operation
        │
        ├── graceful completion allowed
        │
        └── new operation denied
```

or:

```text
Existing operation
        │
        ▼
Termination requested
```

The policy must be explicit rather than emergent.

---

# 22. Revocation

Revocation is stronger than expiration.

Example:

```text
LICENSE = VALID
```

Backend later determines:

```text
LICENSE = REVOKED
```

The Security Authority must transition immediately once the revocation becomes known.

A previously valid local cache must not override revocation.

---

# 23. Session Renewal

Sessions should not necessarily remain valid indefinitely.

A conceptual lifecycle:

```text
AUTHENTICATED
      │
      ▼
ACTIVE
      │
      ▼
RENEWING
      │
      ├── SUCCESS → ACTIVE
      │
      ├── TEMPORARY FAILURE → DEGRADED
      │
      └── REJECTED → EXPIRED/REVOKED
```

---

# 24. Renewal Timing

Renewal should occur before expiration.

For example:

```text
Session lifetime = 30 minutes

Renewal begins
        ↓
approximately before expiry
```

The exact interval should be configurable by protocol policy.

Renewal must not wait until:

```text
expiry_time == now
```

because network latency and backend failures exist.

---

# 25. Renewal Failure

A failed renewal does not necessarily mean immediate security failure.

The Security Authority classifies the failure.

Example:

```text
Backend timeout
      ↓
Retryable
      ↓
DEGRADED
```

Whereas:

```text
Backend says session revoked
      ↓
Authoritative
      ↓
REVOKED
```

This distinction is critical.

---

# 26. Offline Operation

Offline operation must be an explicit authorization policy.

The Security Authority must never accidentally become offline-authorized because:

```text
backend request failed
```

Possible policy:

```text
Previously authorized
+
Backend temporarily unavailable
+
Authorization lease still valid
=
DEGRADED_OPERATIONAL
```

Once the authorization lease expires:

```text
Backend unavailable
+
authorization lease expired
=
NOT_AUTHORIZED
```

---

# 27. Backend Unavailability

Backend unavailability should not automatically erase all local state.

Instead:

```text
ACTIVE
  │
  │ backend unavailable
  ▼
DEGRADED
```

The Security Authority continues monitoring the authorization lease.

If the lease expires:

```text
DEGRADED
    │
    ▼
AUTHORIZATION_EXPIRED
```

---

# 28. Replay Protection

The Security Authority must reject messages that are:

- duplicated
- stale
- associated with expired sessions
- associated with previous sessions
- outside accepted freshness windows
- cryptographically invalid

Example:

```text
Message M1
   │
   ▼
accepted

Message M1 again
   │
   ▼
REJECTED
```

---

# 29. Duplicate Requests

Every security-sensitive request must have a stable request identity.

Example:

```text
request_id = R123
```

If the same request arrives twice:

```text
R123
R123
```

the Backend must be able to determine whether the second request is a duplicate.

This is especially important when:

```text
request succeeded
     ↓
response lost
     ↓
Control Plane retries
```

---

# 30. Ambiguous Network Failures

Consider:

```text
Control Plane
     │
     │ authorize()
     ▼
Backend
     │
     │ authorization succeeded
     │
     X response lost
```

The Control Plane does not know whether the request succeeded.

It must not blindly create a new security state.

Instead:

```text
AMBIGUOUS
   │
   ▼
RECONCILE
   │
   ▼
Backend authoritative state
```

---

# 31. Out-of-Order Responses

Suppose:

```text
Request A
Request B
```

are sent.

Responses arrive:

```text
Response B
Response A
```

The Security Authority must correlate responses using:

- request ID
- session ID
- message ID
- sequence information

It must never assume arrival order equals logical order.

---

# 32. Old Session Responses

Example:

```text
Session A
   │
   └── Request A

Session expires

Session B
   │
   └── Request B

Response A arrives
```

The response must be rejected because:

```text
response.session_id != active_session_id
```

---

# 33. Backend Key Rotation

The protocol must support backend key rotation.

Example:

```text
Backend Key A
      │
      ▼
Backend Key B
```

The Control Plane must be able to recognize the new trusted key without creating an insecure trust gap.

---

# 34. Certificate Rotation

Certificate rotation must not require the application to blindly trust any newly presented certificate.

The trust transition must be authenticated.

Potential mechanisms include:

```text
pre-pinned trust roots
certificate chain
key continuity
signed configuration
overlapping certificates
```

The exact mechanism belongs to the deployment security design.

---

# 35. Protocol Versioning

Every message must identify the protocol version.

Example:

```text
protocol_version = 3
```

The Security Authority must reject incompatible protocols rather than attempting to interpret unknown semantics.

Example:

```text
Control Plane: v3
Backend:       v1

→ incompatible
```

---

# 36. Capability Negotiation

Protocol version compatibility is not sufficient.

Different versions may support different capabilities.

Example:

```text
Backend capabilities:

SESSION_RENEWAL
MACHINE_BINDING
LICENSE_REVOCATION
KEY_ROTATION
```

The Security Authority can negotiate supported capabilities.

---

# 37. Cryptographic Separation

Different cryptographic purposes should use different keys or cryptographic contexts.

Do not use one universal secret for:

```text
authentication
encryption
signing
session establishment
machine identity
```

Conceptually:

```text
Identity Key
Session Key
Message Authentication Key
Key Encryption Key
```

The exact cryptographic construction should be selected during the cryptographic design phase.

---

# 38. Local IPC Security

The Security Authority exposes security-sensitive functionality to other local components.

Therefore:

```text
Frontend
Control Plane
Execution Plane
Other Processes
```

must not automatically be considered trusted.

Local IPC requests must be authenticated and authorized according to the component's role.

---

# 39. Frontend Requests

The Frontend may request:

```text
login
logout
status
renew
```

but it must not directly manipulate:

```text
session_id
license_state
authorization_state
machine_identity
cryptographic_keys
```

The Security Authority owns those.

---

# 40. Execution Plane Requests

The Execution Plane may receive an operational authorization decision.

It should not receive unnecessary security secrets.

For example:

```text
AUTHORIZED
session_reference
capabilities
expiry
```

is preferable to exposing the entire backend authentication context.

---

# 41. Tampering Model

The Security Authority must assume its local persistent state can be modified.

For example:

```text
SQLite
   │
   ├── session = ACTIVE
   ├── license = VALID
   └── expiry = 2030
```

An attacker may attempt:

```text
expiry = 2030
```

to bypass authorization.

Therefore:

> Local persistent authorization state must never be treated as sufficient proof of authorization.

---

# 42. Tamper Detection

Security-sensitive state should have integrity protection.

Possible mechanisms include:

```text
authenticated encryption
MAC
digital signature
keyed integrity records
secure OS-backed key storage
```

A modified record should produce:

```text
INTEGRITY_FAILURE
```

rather than:

```text
VALID
```

---

# 43. Tampering With Configuration

Configuration such as:

```text
license mode
offline duration
backend endpoint
security policy
```

must not be trusted merely because it exists in a local configuration file.

Security-sensitive configuration must be:

- validated
- integrity protected
- constrained
- versioned

---

# 44. Clock Tampering

The Security Authority must detect suspicious clock behavior.

Examples:

```text
12:00
   ↓
11:00
```

or:

```text
12:00
   ↓
2032
```

Clock anomalies must not automatically result in authorization.

Instead they should trigger:

```text
CLOCK_ANOMALY
```

and appropriate security policy.

---

# 45. Sleep and Hibernation

The machine may enter:

```text
sleep
hibernation
```

while a session is active.

After resume:

```text
monotonic elapsed time
system clock
session expiry
authorization lease
```

must be reevaluated.

The application must not assume that no time passed simply because the process was suspended.

---

# 46. Application Restart

After restart:

```text
Application
   │
   ▼
Load local state
   │
   ▼
Verify integrity
   │
   ▼
Reconstruct security state
   │
   ▼
Revalidate session
```

A previous process's in-memory state must never simply be assumed to remain valid.

---

# 47. Crash During Security Transition

Example:

```text
AUTHENTICATING
      │
      │ process crashes
      X
```

After restart, the Security Authority should recover to a safe state.

It should prefer:

```text
UNKNOWN
```

over incorrectly assuming:

```text
AUTHORIZED
```

when the transition cannot be proven complete.

---

# 48. Safe Failure Principle

Whenever security state becomes ambiguous:

> Fail closed with respect to authorization, while preserving enough state to recover safely.

This does not necessarily mean:

```text
kill everything immediately
```

It means the system must not manufacture authorization from uncertainty.

---

# 49. Security Events

The Security Authority should emit explicit events.

Examples:

```text
AuthenticationStarted
AuthenticationSucceeded
AuthenticationFailed

AuthorizationGranted
AuthorizationDenied

LicenseLoaded
LicenseExpired
LicenseRevoked

SessionEstablished
SessionRenewalStarted
SessionRenewed
SessionExpired
SessionRevoked

MachineIdentityCreated
MachineIdentityChanged

KeyRotated
CertificateChanged

TamperDetected
ClockAnomalyDetected

BackendUnavailable
ProtocolMismatch

SecurityStateChanged
```

These events should be immutable observations rather than commands.

---

# 50. Security Event Consumers

Consumers may include:

```text
Control Plane
Telemetry
Audit subsystem
Frontend notification layer
Execution Plane adapter
```

The consumers do not own the security state.

The Security Authority remains authoritative.

---

# 51. Execution Plane Authorization Boundary

The Execution Plane should receive only the authorization information necessary to operate.

For example:

```text
Security Authority
        │
        │
        ▼
Execution Authorization Adapter
        │
        ▼
Execution Plane
```

The adapter translates security state into an operational capability.

The Execution Plane should not need to understand:

```text
passwords
licenses
backend accounts
authentication protocols
machine registration
```

---

# 52. Backend Is the Ultimate Authority

The local Security Authority is authoritative for **local security state**.

The Backend is authoritative for:

```text
account
license
revocation
server authorization
machine registration
```

Therefore:

```text
Backend
    ↓
Security Authority
    ↓
Control Plane
    ↓
Execution Plane
```

The authority flows downward.

---

# 53. No Security Decision From the Frontend

The Frontend may display:

```text
Authenticated
License Active
Disconnected
Expired
```

but it must not determine those values.

The Frontend receives them from the Control Plane.

---

# 54. No Security Decision From the Execution Plane

Likewise, the Execution Plane must not decide:

```text
license valid
account valid
session valid
machine authorized
```

It receives an operational authorization result.

---

# 55. Secure Shutdown

When the application shuts down:

```text
Execution Plane
       │
       ▼
Stop operational authorization
       │
       ▼
Security Authority
       │
       ▼
Session cleanup
       │
       ▼
Secure state persistence
```

Sensitive transient information should be cleared where practical.

---

# 56. Logout

Logout should invalidate the local operational session.

Conceptually:

```text
ACTIVE
  │
  │ logout
  ▼
TERMINATING
  │
  ▼
UNAUTHENTICATED
```

If backend logout cannot be completed because the network is unavailable, local authorization must still be removed.

---

# 57. Logout While Operations Are Running

Logout creates a coordination event:

```text
Logout
  │
  ▼
Authorization revoked locally
  │
  ▼
Execution Plane notified
  │
  ▼
Operations handled according to shutdown policy
```

The system must define whether existing operations:

- complete
- pause
- terminate immediately
- enter a controlled shutdown

This is an explicit product/security policy.

---

# 58. Security Authority API

The internal API should expose intent rather than implementation.

Example:

```text
authenticate()
logout()

getSecurityState()

getAuthorization()
getCapabilities()

requestRenewal()

validateSession()

handleBackendEvent()
```

It should not expose:

```text
setLicenseValid(true)
setSessionExpiry(...)
setAuthorization(...)
```

because those would allow arbitrary local mutation of security state.

---

# 59. Principle of Unforgeable State

A particularly important design principle is:

> Components should be able to request security operations, but should not be able to directly construct security authority.

For example:

```text
Frontend:
    requestLogin(credentials)

Security Authority:
    performs authentication

Backend:
    authorizes

Security Authority:
    creates operational state
```

Not:

```text
Frontend:
    setAuthenticated(true)
```

---

# 60. Recommended Internal Architecture

The Security Authority itself can be decomposed vertically:

```text
security_authority/
│
├── api/
│
├── protocol/
│
├── authentication/
│
├── authorization/
│
├── licensing/
│
├── sessions/
│
├── machine_identity/
│
├── cryptography/
│
├── key_management/
│
├── integrity/
│
├── replay_protection/
│
├── clock/
│
├── persistence/
│
├── state_machine/
│
├── policy/
│
├── events/
│
└── index
```

However, these are implementation boundaries.

They should not become independent authorities.

There should still be one central security state machine.

---

# 61. Security Authority Core

Conceptually:

```text
             ┌─────────────────────────┐
             │   Security Authority    │
             │                         │
             │   State Machine         │
             │          │              │
             │    ┌─────┴─────┐        │
             │    │   Policy  │        │
             │    └─────┬─────┘        │
             │          │              │
             │ ┌────────┼────────┐     │
             │ │        │        │     │
             │Auth    License  Session │
             │ │        │        │     │
             │ └────────┼────────┘     │
             │          │              │
             │   Integrity / Crypto    │
             └─────────────────────────┘
```

The central state machine prevents individual modules from independently deciding security state.

---

# 62. What This Protocol Does Not Define

This document deliberately does not finalize:

- exact cryptographic algorithms
- exact key derivation functions
- exact protobuf schema
- exact TLS configuration
- exact database schema
- exact license policy
- exact offline grace period
- exact machine fingerprint algorithm
- exact Rust/Node boundary

Those should be defined in their respective design documents.

---

# 63. Critical Design Rule

The protocol should never become:

```text
Encrypt everything
+
hope it is secure
```

Security comes from the combination of:

```text
Identity
+
Authentication
+
Authorization
+
Freshness
+
Integrity
+
Confidentiality
+
Replay resistance
+
State validation
+
Key management
+
Tamper detection
+
Explicit failure semantics
+
Backend authority
```

---

# 64. Final Protocol Model

The resulting security relationship is:

```text
                    BACKEND
                       │
             Account / License
             Authorization Authority
                       │
                Secure Protocol
                       │
                       ▼
             ┌─────────────────────┐
             │  SECURITY AUTHORITY │
             │                     │
             │ Identity            │
             │ Authentication      │
             │ Authorization       │
             │ Licensing           │
             │ Session             │
             │ Integrity           │
             │ Crypto              │
             │ Replay Protection   │
             │ Key Management      │
             │ State Machine        │
             └──────────┬──────────┘
                        │
                Operational
                 Authorization
                        │
                        ▼
                CONTROL PLANE
                        │
                        ▼
                EXECUTION PLANE
```

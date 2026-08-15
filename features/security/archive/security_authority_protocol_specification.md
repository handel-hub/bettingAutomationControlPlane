# Security Authority Protocol Specification

**Document:** `security_authority_protocol_specification.md`
**System:** Runtime Synchronization Platform — Control Plane
**Component:** Security Authority
**Status:** Architecture / Protocol Specification
**Scope:** Security communication between the Control Plane Security Authority and the Backend

---

# 1. Purpose

This document defines the communication protocol between the **Control Plane Security Authority** and the **Backend Security Authority**.

It specifies:

- protocol boundaries;
- message envelopes;
- authentication;
- machine registration;
- session establishment;
- session renewal;
- authorization;
- licensing;
- revocation;
- key establishment;
- replay protection;
- freshness;
- request correlation;
- protocol versioning;
- failure handling;
- timeout behavior;
- clock handling;
- security-state reconciliation;
- recovery after interruption;
- cryptographic requirements.

This document does **not** define:

- frontend behavior;
- Execution Plane internals;
- browser automation;
- Playwright;
- file transfer;
- business APIs unrelated to security.

---

# 2. Fundamental Principle

The protocol must distinguish between:

```text
Identity
Authorization
License
Session
Machine Identity
Transport Security
Message Integrity
```

These are related but **not interchangeable**.

For example:

```text
Authenticated
        ≠
Authorized
        ≠
Licensed
        ≠
Operational
```

A user can be authenticated while lacking an active license.

A machine can be registered while the account is revoked.

A session can exist while authorization has expired.

The protocol must represent these states independently.

---

# 3. Security Authority Hierarchy

The security relationship is:

```text
                    BACKEND
              Authoritative Security
                       │
                       │ protocol
                       ▼
              SECURITY AUTHORITY
             Local Security Enforcement
                       │
                       ▼
                CONTROL PLANE
                       │
                       ▼
               EXECUTION PLANE
```

The Backend is the ultimate authority for:

- account identity;
- account status;
- machine registration;
- authorization;
- licensing;
- revocation.

The local Security Authority is responsible for:

- obtaining those facts;
- validating them;
- maintaining their local state;
- enforcing them;
- detecting stale state;
- preventing unauthorized local operations.

---

# 4. Transport vs Security Protocol

The protocol consists of two distinct layers.

```text
Application Security Protocol
          │
          ▼
Transport
```

The transport may be:

- HTTPS;
- WebSocket over TLS;
- another authenticated transport in the future.

The security protocol defines:

- message semantics;
- authentication;
- authorization;
- licensing;
- session state;
- cryptographic metadata;
- replay protection.

Therefore:

> Changing WebSocket to another transport must not require redesigning the Security Authority protocol.

---

# 5. TLS Is Not the Application Protocol

TLS provides transport-level properties such as:

- encryption;
- server authentication;
- transport integrity;
- protection against ordinary network interception.

The application protocol provides additional properties such as:

- request identity;
- session generations;
- replay protection;
- message freshness;
- authorization semantics;
- security-state transitions.

Therefore:

```text
TLS
+
Application Security Protocol
```

should be considered together.

The application must not assume:

> "Because TLS exists, every application-level security problem is solved."

---

# 6. Message Envelope

Every Security Authority protocol message should have a standard envelope.

Conceptually:

```text
MessageEnvelope {
    protocol_version
    message_type
    message_id
    correlation_id
    session_id
    session_generation
    key_generation
    timestamp
    nonce
    sequence
    payload
    authentication
}
```

The exact binary representation will be defined separately.

---

# 7. Protocol Version

Every message contains:

```text
protocol_version
```

Example:

```text
major = 1
minor = 0
```

Major versions indicate incompatible protocol changes.

Minor versions indicate compatible extensions.

The Backend and Control Plane must negotiate a mutually supported version before entering an operational security session.

---

# 8. Message Type

The message type identifies the protocol operation.

Examples:

```text
AUTH_INIT
AUTH_CHALLENGE
AUTH_RESPONSE
AUTH_RESULT

MACHINE_REGISTER
MACHINE_REGISTER_RESULT

SESSION_ESTABLISH
SESSION_ESTABLISH_RESULT

SESSION_RENEW
SESSION_RENEW_RESULT

AUTHORIZATION_REQUEST
AUTHORIZATION_RESULT

LICENSE_REQUEST
LICENSE_RESULT

SECURITY_STATE_REQUEST
SECURITY_STATE_RESULT

REVOCATION_NOTICE

KEY_ROTATION
PROTOCOL_ERROR
```

Additional messages may be added later.

---

# 9. Message ID

Every request receives a unique:

```text
message_id
```

The identifier exists independently of the transport connection.

Its purpose is to identify the logical request.

Example:

```text
message_id = 9f1...
```

If a request must be retried, the retry semantics must be explicitly defined.

---

# 10. Correlation ID

Responses contain:

```text
correlation_id
```

corresponding to the request's:

```text
message_id
```

Example:

```text
Request:
    message_id = A

Response:
    correlation_id = A
```

This prevents responses from being incorrectly associated with another operation.

---

# 11. Session ID

Once a security session exists, messages may contain:

```text
session_id
```

The session ID identifies the current security session.

It must not by itself be sufficient to authenticate a request.

A session identifier is an identifier, not proof of authorization.

---

# 12. Session Generation

Every session also has a:

```text
session_generation
```

This protects against stale messages.

Example:

```text
Session A
generation = 5
```

After reauthentication:

```text
Session B
generation = 6
```

A response belonging to generation 5 must not be accepted as a response for generation 6.

---

# 13. Key Generation

Cryptographic keys should also have explicit generations.

Example:

```text
key_generation = 12
```

After rotation:

```text
key_generation = 13
```

This allows the Security Authority to distinguish:

```text
current cryptographic state
```

from:

```text
old cryptographic state
```

---

# 14. Nonce

Security-sensitive messages must include cryptographically secure nonces where required by the protocol.

A nonce must never be predictable.

The nonce prevents an attacker from simply reproducing an earlier cryptographic exchange.

The protocol must specify:

- nonce size;
- generation;
- uniqueness requirements;
- validation;
- expiration.

---

# 15. Sequence Numbers

Messages belonging to an established session should use sequence numbers where appropriate.

Example:

```text
1
2
3
4
5
```

The receiver can detect:

```text
duplicate
replay
unexpected ordering
missing messages
```

However, the protocol must not assume that every transport guarantees ordered delivery.

The application protocol defines its own semantics.

---

# 16. Freshness

A security message must be considered fresh only when it satisfies the applicable freshness rules.

Freshness may involve:

```text
nonce
sequence number
session generation
key generation
server-issued expiry
timestamp
```

No single mechanism should be assumed to solve every replay scenario.

---

# 17. Authentication Flow

Initial authentication conceptually follows:

```text
Control Plane
      │
      │ AUTH_INIT
      ▼
Backend
      │
      │ AUTH_CHALLENGE
      ▼
Control Plane
      │
      │ AUTH_RESPONSE
      ▼
Backend
      │
      │ AUTH_RESULT
      ▼
Control Plane
```

Authentication should establish:

```text
authenticated principal
```

but should not automatically establish:

```text
authorized operational state
```

---

# 18. AUTH_INIT

The Control Plane begins authentication.

The request may contain:

```text
protocol_version
client_version
machine_identity
supported_algorithms
client_nonce
authentication_method
```

Sensitive credentials must not be transmitted in a reversible plaintext representation merely because the application intends to encrypt the surrounding JSON/binary object.

The exact credential mechanism should be defined independently.

---

# 19. Challenge-Response

The Backend may issue a challenge.

Conceptually:

```text
Backend
    │
    │ random challenge
    ▼
Control Plane
```

The Control Plane must produce a response demonstrating possession of the required authentication material.

The purpose is to prevent simple replay of captured authentication material.

---

# 20. Password Handling

The architecture must not implement:

```text
encrypt(username + password)
```

as the fundamental authentication model.

Encryption protects confidentiality in transit.

Authentication requires proof of knowledge/possession.

Transport security should normally provide confidentiality for the credential exchange, while the Backend stores password verifiers using an appropriate password-hashing scheme.

---

# 21. Authentication Result

The Backend may return:

```text
AUTHENTICATED
```

or:

```text
AUTHENTICATION_FAILED
```

But successful authentication is only one part of security initialization.

The next stage is:

```text
authorization
license
machine binding
session establishment
```

---

# 22. Machine Registration

A machine may require registration.

Conceptually:

```text
Control Plane
      │
      │ MACHINE_REGISTER
      ▼
Backend
      │
      │ MACHINE_REGISTER_RESULT
      ▼
Control Plane
```

The Backend may associate:

```text
account
+
machine identity
```

---

# 23. Machine Identity

Machine identity should not depend solely on easily editable properties such as:

```text
hostname
username
MAC address
```

A stronger model is an application-generated cryptographic identity.

Conceptually:

```text
Machine Identity
       │
       └── private key
       └── public key
```

The private component remains locally protected.

The Backend associates the public identity with the registered machine.

---

# 24. Machine Binding

The Backend may establish:

```text
account → machine identity
```

The Control Plane must verify that the current installation is operating under the expected machine identity.

If binding fails:

```text
OPERATIONAL AUTHORIZATION = DENIED
```

until the Backend explicitly resolves the situation.

---

# 25. Session Establishment

After authentication and authorization prerequisites have been satisfied:

```text
AUTHENTICATED
      │
      ▼
AUTHORIZED
      │
      ▼
LICENSE VALID
      │
      ▼
SESSION ESTABLISH
      │
      ▼
OPERATIONAL
```

Session establishment produces the security context required for normal communication.

---

# 26. Session Contents

A session may contain:

```text
session_id
session_generation
issued_at
expires_at
authorization_generation
license_generation
key_generation
server_time_reference
capabilities
```

The client must not arbitrarily modify these values.

---

# 27. Session Expiration

A session expires when its validity period ends.

Possible states:

```text
ACTIVE
EXPIRING
EXPIRED
RENEWING
INVALID
```

An expired session must not be used for privileged operations.

---

# 28. Session Renewal

Renewal should occur before expiration.

Conceptually:

```text
ACTIVE
   │
   │ nearing expiration
   ▼
RENEWING
   │
   ├── success ──► ACTIVE
   │
   └── failure ──► degraded/expired
```

The renewal mechanism must not create an infinite offline session.

---

# 29. Refresh Credentials

If refresh credentials are used, they must be treated as highly sensitive.

They should be:

- short-lived where appropriate;
- protected at rest;
- rotated where appropriate;
- invalidatable;
- bound to the expected security context.

A stolen refresh credential must not automatically provide unlimited access.

---

# 30. Authorization

Authorization is evaluated separately from authentication.

The Backend may return:

```text
authorized = true
```

with:

```text
authorization_generation = 42
```

Later:

```text
authorization_generation = 43
```

A local decision based on generation 42 may become stale.

---

# 31. Authorization Freshness

The Security Authority must know when authorization needs revalidation.

Triggers may include:

```text
authorization TTL
explicit backend revocation
license change
account change
machine change
session renewal
security policy change
```

---

# 32. License Protocol

Licensing follows a similar pattern.

```text
LICENSE_REQUEST
        │
        ▼
Backend
        │
        ▼
LICENSE_RESULT
```

The response may contain:

```text
license_id
license_state
entitlements
issued_at
expires_at
license_generation
policy_version
```

---

# 33. License States

Possible local representations include:

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

The exact state machine will be defined separately.

---

# 34. License Expiration

Expiration must be deterministic.

If:

```text
expires_at < current trusted time
```

then the license is expired.

Local clock anomalies must be handled separately.

---

# 35. License Revocation

Revocation has stronger semantics than expiration.

Expiration means:

```text
entitlement naturally ended
```

Revocation means:

```text
authority explicitly withdrew entitlement
```

The Control Plane must not treat revocation as a normal expiration that can simply be extended offline.

---

# 36. Authorization + License

Operational authorization may require:

```text
Authentication = valid
Session = valid
Machine = valid
Authorization = valid
License = valid
Integrity = acceptable
```

Conceptually:

```text
ALLOW =
    identity_valid
    AND session_valid
    AND machine_valid
    AND authorization_valid
    AND license_valid
    AND integrity_acceptable
```

The actual policy engine may become more sophisticated.

---

# 37. Security State Snapshot

The Backend may provide a security-state snapshot.

Example:

```text
SecuritySnapshot {
    account_state
    machine_state
    authorization_state
    license_state
    session_state
    policy_version
    server_time
    security_generation
}
```

The Control Plane uses this to reconcile local state.

---

# 38. Reconciliation

Reconciliation is essential after:

- network interruption;
- process restart;
- sleep/resume;
- missed events;
- failed renewal;
- suspected stale state.

Conceptually:

```text
LOCAL STATE
     │
     ▼
SECURITY_STATE_REQUEST
     │
     ▼
BACKEND
     │
     ▼
AUTHORITATIVE SNAPSHOT
     │
     ▼
LOCAL RECONCILIATION
```

---

# 39. Backend-Initiated Revocation

The Backend may send:

```text
REVOCATION_NOTICE
```

The notice may invalidate:

```text
session
authorization
license
machine
account
```

The Control Plane must process the event according to its security state machine.

---

# 40. Revocation While Execution Is Active

This is a critical scenario.

Suppose:

```text
Execution Plane = RUNNING
```

and:

```text
License = REVOKED
```

The Security Authority must transition its local security state immediately.

It then informs the Control Plane runtime orchestration layer:

```text
SECURITY_OPERATION_REVOKED
```

The Runtime Manager determines how to safely stop or restrict the Execution Plane.

The Security Authority itself does not implement the shutdown mechanism.

---

# 41. Security Events vs Commands

The protocol must distinguish:

```text
event
```

from:

```text
command
```

For example:

```text
LICENSE_REVOKED
```

is a security event.

Whereas:

```text
STOP_RUNTIME
```

is a Control Plane command.

The Security Authority should communicate the security decision, not directly manipulate unrelated subsystems.

---

# 42. Duplicate Requests

Requests may be duplicated due to:

- retry;
- network uncertainty;
- reconnect;
- transport behavior.

The Backend must be able to determine whether a request is:

```text
new
duplicate
replayed
stale
invalid
```

using:

```text
message_id
session generation
nonce
sequence
request semantics
```

---

# 43. Ambiguous Responses

A critical case:

```text
Control Plane
      │
      │ request
      ▼
Backend
      │
      │ processes request
      X
   connection dies
```

The Control Plane does not know whether the Backend processed it.

The protocol must not blindly assume:

```text
failure = request never happened
```

Instead:

```text
ambiguous operation
        │
        ▼
reconcile/query state
        │
        ▼
determine actual result
```

This is particularly important for security-state mutations.

---

# 44. Out-of-Order Responses

Every response must be validated against:

```text
message_id
correlation_id
session_id
session_generation
key_generation
```

A response belonging to an old session must be rejected.

---

# 45. Stale Responses

Example:

```text
Session 10
   │
   └── request A

Session expires

Session 11
   │
   └── request B

Response A arrives
```

Response A must not mutate Session 11 state.

---

# 46. Session Fixation Protection

A newly authenticated session must receive a fresh session identity/generation.

The client must not simply continue using an attacker-selected or pre-authentication session identifier.

---

# 47. Replay Protection

A message captured from:

```text
Session 7
```

must not become valid in:

```text
Session 8
```

Similarly:

```text
old nonce
old sequence
old key generation
```

must not be accepted as fresh security state.

---

# 48. Key Rotation

Keys must support explicit generations.

Example:

```text
Key 10
   │
   ▼
rotation
   │
   ▼
Key 11
```

During controlled rotation, both sides may temporarily need to recognize an overlap period.

After retirement:

```text
Key 10 = rejected
```

---

# 49. Server Certificate Rotation

TLS certificate rotation must not unnecessarily invalidate the application security protocol.

The trust model should support planned certificate replacement.

Unexpected certificate changes should be treated according to the configured trust policy.

---

# 50. Protocol Version Mismatch

If:

```text
client = protocol 2
server = protocol 1
```

and compatibility is impossible:

```text
OPERATIONAL = BLOCKED
```

The application should not attempt to interpret unknown security messages.

---

# 51. Security Protocol Errors

Protocol errors should be classified.

Examples:

```text
INVALID_MESSAGE
INVALID_SIGNATURE
INVALID_NONCE
REPLAY_DETECTED
STALE_SESSION
UNKNOWN_KEY_GENERATION
PROTOCOL_VERSION_UNSUPPORTED
INVALID_STATE
AUTHENTICATION_FAILED
AUTHORIZATION_DENIED
LICENSE_REVOKED
```

Security errors should not reveal unnecessary sensitive information.

---

# 52. Clock Handling

The protocol should distinguish:

```text
local wall clock
local monotonic clock
backend/server time
```

The Backend may provide a trusted server timestamp.

The Control Plane can estimate:

```text
server_time_offset
```

rather than blindly trusting its own wall clock.

---

# 53. Clock Rollback

Example:

```text
10:00
   ↓
11:00
   ↓
09:00
```

This is suspicious.

The Security Authority should generate:

```text
CLOCK_ANOMALY
```

and reevaluate:

- session;
- license;
- authorization;
- cached expiration.

---

# 54. Sleep / Hibernate

A machine may sleep for several hours.

After resume:

```text
old security state
```

may no longer be valid.

The Security Authority must trigger revalidation when required.

---

# 55. Network Change

Network transitions such as:

```text
Wi-Fi → Ethernet
Ethernet → Wi-Fi
Wi-Fi → offline
VPN → direct
```

must not automatically invalidate the security model.

However, communication channels may need to be re-established.

---

# 56. Backend Unavailable During Startup

The Control Plane must determine whether it possesses a valid offline authorization state.

Possible result:

```text
STARTUP
   │
   ├── valid offline policy
   │       ↓
   │    DEGRADED
   │
   └── no valid authorization
           ↓
        BLOCKED
```

The exact policy belongs to the licensing/authorization rules.

---

# 57. Backend Unavailable During Operation

Existing valid state may continue according to an explicit grace policy.

The Security Authority must not silently extend:

```text
license expiry
```

or:

```text
authorization lifetime
```

just because the Backend is unreachable.

---

# 58. Secure Local IPC

The Security Authority must also protect its local interface.

The following should not automatically be trusted:

```text
localhost
127.0.0.1
Unix socket
named pipe
local process
```

A malicious local process may attempt:

```text
connect
impersonate frontend
send commands
```

Therefore the local API requires its own authentication/authorization mechanism.

---

# 59. Frontend Authentication to Control Plane

The Frontend should authenticate to the Control Plane's local API.

The exact mechanism can be:

- short-lived local capability;
- OS-backed identity;
- secure local IPC;
- authenticated session;
- another local trust mechanism.

The Frontend must never receive Backend master credentials or private cryptographic keys.

---

# 60. Local API Security

Every privileged local request should pass through:

```text
Frontend
   │
   ▼
Local API
   │
   ▼
Security Authority
   │
   ▼
Decision
```

A request such as:

```text
/start-runtime
```

must not directly bypass the Security Authority.

---

# 61. Security-Sensitive Data

The following data requires special handling:

```text
password
refresh credential
private key
session credential
machine private identity
encryption key
license verification material
```

Such material should:

- exist for the shortest practical lifetime;
- not be logged;
- not be serialized unnecessarily;
- not be exposed to frontend code;
- not be placed in ordinary configuration files.

---

# 62. Logging

Security logs should record security events without recording secrets.

Good:

```text
Authentication failed
reason = INVALID_CREDENTIALS
machine = <redacted identifier>
request_id = ...
```

Bad:

```text
password = ...
session_token = ...
private_key = ...
```

---

# 63. Security Audit Events

Important events should produce tamper-evident audit records where appropriate.

Examples:

```text
LOGIN_SUCCESS
LOGIN_FAILURE
SESSION_CREATED
SESSION_RENEWED
SESSION_REVOKED
LICENSE_CHANGED
LICENSE_REVOKED
MACHINE_REGISTERED
MACHINE_CHANGED
INTEGRITY_FAILURE
CLOCK_ANOMALY
REPLAY_DETECTED
PROTOCOL_FAILURE
```

---

# 64. Tampering

The protocol must assume that a sufficiently capable local attacker can inspect or modify client-side code.

Therefore the Control Plane must never be the ultimate authority for subscription entitlement.

Its role is:

```text
receive authoritative state
+
verify state
+
enforce state
+
make modification harder
```

not:

```text
prove that the local machine can never be modified
```

---

# 65. Tampering With Security State

If the local Security Authority detects:

```text
unexpected state
invalid MAC/signature
rollback
database inconsistency
unknown key generation
unexpected identity change
```

it must not simply repair the state by choosing the most permissive interpretation.

Instead:

```text
TAMPER_SUSPECTED
       │
       ▼
SECURITY_REASSESSMENT
       │
       ├── verified → recover
       │
       └── unresolved → restricted
```

---

# 66. Rollback Protection

An attacker may restore an older application snapshot containing:

```text
old valid session
old license
old authorization
```

The protocol must use server-side generations/versioning where appropriate so that an old local state cannot automatically become current again.

---

# 67. Security Generations

A useful general mechanism is a monotonically increasing security generation.

Example:

```text
generation 100
```

After revocation:

```text
generation 101
```

A client possessing:

```text
generation 100
```

cannot claim that it represents generation 101.

The Backend remains authoritative for generation progression.

---

# 68. Reconnection

After disconnection:

```text
CONNECTED
   │
   ▼
DISCONNECTED
   │
   ▼
RECONNECTING
   │
   ▼
REAUTHENTICATING / RECONCILING
   │
   ▼
CONNECTED
```

The client should not blindly resume all old protocol state.

Reconnection may require:

```text
session validation
security snapshot
key validation
authorization reconciliation
license reconciliation
```

---

# 69. Reconciliation After Restart

On restart:

```text
local persisted state
        │
        ▼
validate structure
        │
        ▼
validate integrity
        │
        ▼
establish backend connection
        │
        ▼
reconcile authoritative state
        │
        ▼
activate operational state
```

Persisted state is a recovery aid, not unquestionable authority.

---

# 70. Security State vs Transport State

These must remain separate.

Transport:

```text
CONNECTED
DISCONNECTED
RECONNECTING
```

Security:

```text
AUTHENTICATED
AUTHORIZED
LICENSE_VALID
SESSION_VALID
```

Therefore:

```text
CONNECTED ≠ AUTHORIZED
```

and:

```text
DISCONNECTED ≠ REVOKED
```

---

# 71. Security State vs Application State

Similarly:

```text
Execution Plane = RUNNING
```

does not imply:

```text
License = VALID
```

The Runtime Manager must respond to Security Authority changes.

---

# 72. Example Operational Sequence

A complete startup could look like:

```text
1. Application starts
2. Security Authority initializes
3. Machine identity loaded
4. Integrity checked
5. Backend TLS connection established
6. Protocol negotiated
7. Authentication performed
8. Machine binding verified
9. Authorization retrieved
10. License retrieved
11. Security session established
12. Security state becomes OPERATIONAL
13. Runtime Manager allowed to start
14. Execution Plane starts
```

---

# 73. Example Renewal Sequence

```text
ACTIVE SESSION
      │
      │ renewal threshold reached
      ▼
SESSION_RENEW
      │
      ▼
Backend
      │
      ▼
renewal response
      │
      ├── valid
      │     ↓
      │   new session generation
      │
      └── rejected
            ↓
       restricted state
```

---

# 74. Example Revocation Sequence

```text
Execution Plane
      │
      │ running
      ▼
Security Authority
      │
      │ REVOCATION_NOTICE
      ▼
License = REVOKED
      │
      ▼
Security Decision = DENY
      │
      ▼
Runtime Manager notified
      │
      ▼
Execution Plane shutdown/restricted
```

---

# 75. Example Network Failure

```text
OPERATIONAL
     │
     │ network failure
     ▼
DEGRADED
     │
     ├── reconnect
     │
     ├── renew
     │
     └── reconcile
     │
     ▼
OPERATIONAL
```

or:

```text
DEGRADED
     │
     │ security validity expires
     ▼
RESTRICTED
```

---

# 76. Error Handling Principle

Errors should be classified into:

### Transport errors

```text
timeout
DNS
connection reset
TLS connection failure
```

### Authentication errors

```text
invalid credential
challenge failure
account disabled
```

### Authorization errors

```text
permission denied
account revoked
machine unauthorized
```

### Licensing errors

```text
expired
revoked
unsupported entitlement
```

### Cryptographic errors

```text
signature invalid
key mismatch
nonce invalid
```

### Protocol errors

```text
unsupported version
malformed message
invalid state transition
```

### Integrity errors

```text
tampering suspected
rollback detected
state corruption
```

Each class has a different recovery policy.

---

# 77. Retry Policy

Security protocol retries must be bounded.

Retryable:

```text
temporary network failure
timeout
temporary 5xx
connection reset
```

Not normally retryable:

```text
invalid credentials
invalid signature
authorization denied
license revoked
protocol incompatibility
integrity failure
```

Repeated cryptographic/security failures should not become infinite retry loops.

---

# 78. Backoff

Retryable communication failures should use exponential backoff with jitter.

Conceptually:

```text
attempt 1 → short delay
attempt 2 → longer delay
attempt 3 → longer delay
...
```

with an upper bound.

---

# 79. Security Protocol Does Not Trust Client Time

The Backend should remain authoritative for:

```text
license expiration
server-side authorization expiration
security generations
revocation timestamps
```

The Control Plane may use local time as an operational approximation, but must account for clock anomalies.

---

# 80. Capability Negotiation

During connection establishment the parties may negotiate:

```text
protocol version
cryptographic algorithms
compression
serialization format
supported security features
key generations
```

Unknown capabilities must not be silently assumed.

---

# 81. Protobuf

The protocol may use **Protocol Buffers** as its serialization format.

A possible stack is:

```text
WebSocket / TLS
       │
       ▼
Protocol Buffers
       │
       ▼
Security Protocol
```

Advantages include:

- compact messages;
- explicit schemas;
- efficient serialization;
- versioned fields;
- language interoperability.

However:

> Protobuf provides serialization, not security.

It does not replace:

- authentication;
- encryption;
- integrity;
- replay protection;
- authorization.

---

# 82. Schema Evolution

Protocol Buffers fields should be evolved conservatively.

Rules include:

- never reuse field numbers;
- preserve backward compatibility where possible;
- make breaking changes through protocol-version changes;
- reject unsupported security-critical fields/semantics.

---

# 83. Message Integrity

Security-sensitive messages require authentication/integrity protection.

Depending on the final protocol design this may be provided through:

```text
TLS
+
application-level authentication
```

or additional message-level mechanisms.

The protocol should not introduce unnecessary cryptographic duplication without a clear threat-model justification.

---

# 84. Why Message-Level Security May Still Exist

Even with TLS, application-level security can provide additional properties such as:

```text
message identity
request binding
security generation
replay protection
authorization context
protocol semantics
```

But encryption should not be added simply because:

> "Everything must be encrypted twice."

Each cryptographic layer should have a defined security purpose.

---

# 85. Backend Authority

The Backend should ultimately be capable of answering:

```text
Who is this?
Is this machine registered?
Is this account active?
Is this account authorized?
Is this license valid?
Has this entitlement been revoked?
What security generation is current?
```

The Control Plane should not invent authoritative answers.

---

# 86. Local Enforcement Authority

The Security Authority answers:

```text
Can the Control Plane currently perform this operation?
```

This distinction is fundamental.

```text
Backend:
"What is true?"

Security Authority:
"What does the local system currently permit based on what has been established as true?"
```

---

# 87. Security Authority API

A conceptual public interface:

```text
SecurityAuthority.initialize()

SecurityAuthority.authenticate()

SecurityAuthority.logout()

SecurityAuthority.getState()

SecurityAuthority.check(operation)

SecurityAuthority.renewSession()

SecurityAuthority.refreshAuthorization()

SecurityAuthority.refreshLicense()

SecurityAuthority.reconcile()

SecurityAuthority.handleSecurityEvent()

SecurityAuthority.shutdown()
```

The exact API will be defined after the protocol is finalized.

---

# 88. Security Decision API

A caller might conceptually ask:

```text
check({
    operation: "START_RUNTIME"
})
```

The Security Authority returns something equivalent to:

```text
{
    decision: "ALLOW",
    security_generation: 42,
    session_generation: 8,
    authorization_generation: 15,
    license_generation: 7
}
```

The caller does not receive secrets.

---

# 89. Decision Freshness

A security decision should have a defined lifetime/context.

A caller should not assume:

```text
ALLOW
```

means:

```text
ALLOW FOREVER
```

Security state can change immediately after a decision.

The system must therefore define where authorization is checked and how long the resulting decision remains valid.

---

# 90. TOCTOU Consideration

A critical issue is:

```text
Check authorization
       ↓
Wait
       ↓
Perform operation
```

Authorization could change during the gap.

Therefore security-sensitive operations should use appropriate:

- short decision lifetimes;
- security generations;
- transaction binding;
- operation authorization;
- revocation handling.

---

# 91. Security Context Binding

An operation may be associated with:

```text
session_generation
authorization_generation
license_generation
security_generation
```

If those values change before execution, the operation can be rejected.

---

# 92. Backend Revocation Race

Example:

```text
T1: Control Plane checks license
T2: Backend revokes license
T3: Control Plane starts operation
```

The architecture cannot guarantee that the network will deliver revocation before every possible operation.

Instead, the system must define:

- revocation latency;
- acceptable operational window;
- operation-bound authorization;
- backend confirmation where required.

This is a policy decision, not a cryptographic problem.

---

# 93. No Absolute Client-Side Security

Because the attacker owns the machine:

```text
executable
memory
filesystem
network stack
local IPC
runtime
```

can potentially be manipulated.

Therefore the protocol's security objective is:

> Make unauthorized modification and bypass significantly more difficult while keeping the authoritative security decision on the Backend.

---

# 94. Security Model

The final model is:

```text
                  INTERNET
                     │
                     ▼
              ┌─────────────┐
              │   BACKEND   │
              │   Authority │
              └──────┬──────┘
                     │
                  TLS +
              Security Protocol
                     │
                     ▼
        ┌─────────────────────────┐
        │    SECURITY AUTHORITY   │
        │                         │
        │ Identity                │
        │ Machine                 │
        │ Session                 │
        │ Authorization           │
        │ License                 │
        │ Integrity               │
        │ Keys                    │
        │ Replay Protection       │
        │ Security State          │
        └────────────┬────────────┘
                     │
              Security Decision
                     │
                     ▼
             CONTROL PLANE
                     │
                     ▼
             RUNTIME MANAGER
                     │
                     ▼
             EXECUTION PLANE
```

---

# 95. Mandatory Protocol Invariants

The implementation must preserve the following:

1. **Authentication never implies authorization.**
2. **Authorization never implies license validity.**
3. **A license never proves identity.**
4. **A session ID is never sufficient authentication.**
5. **Old sessions cannot modify new sessions.**
6. **Old security generations cannot override newer generations.**
7. **Replayed messages cannot create new security state.**
8. **Local persisted state cannot override Backend authority.**
9. **Frontend requests cannot bypass Security Authority decisions.**
10. **Execution Plane requests cannot bypass Security Authority decisions.**
11. **Security failures cannot silently become authorization successes.**
12. **Cryptographic failures must fail closed.**
13. **Protocol incompatibility must fail closed for privileged operations.**
14. **Revocation must invalidate the applicable local security state.**
15. **Security state must survive crashes without becoming more permissive.**
16. **Offline operation must follow an explicit policy.**
17. **Client-side cryptography does not replace Backend authority.**
18. **Sensitive credentials must never be exposed to the Frontend.**
19. **Security decisions must be bound to the appropriate security generation.**
20. **Every security-state transition must be deterministic and auditable.**

---

# 96. Implementation Boundary

At implementation time, the project should ultimately separate:

```text
security_authority/
│
├── authority/
│
├── protocol/
│
├── identity/
│
├── machine/
│
├── session/
│
├── authorization/
│
├── licensing/
│
├── integrity/
│
├── cryptography/
│
├── replay/
│
├── time/
│
├── persistence/
│
├── recovery/
│
└── events/
```

The physical organization may later change.

The important property is that these concepts remain explicit and independently reasoned about.

---

# 97. What This Document Establishes

At this point we have defined three major layers:

```text
1. Security Edge-Case Inventory
2. Security Authority State Machine
3. Security Authority Internal Architecture
4. Security Authority Protocol
```

Together they establish:

```text
WHAT can go wrong
        ↓
HOW security state changes
        ↓
WHO owns each security responsibility
        ↓
HOW security information crosses the Backend boundary
```

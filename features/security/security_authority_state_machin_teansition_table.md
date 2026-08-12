# Security Authority — State Machine + Transition Table

## 1. Purpose

The **Security Authority** is the security-state authority of the Control Plane.

It is responsible for determining whether the local application is currently:

- authenticated,
- authorized,
- licensed,
- operating under a valid security session,
- permitted to communicate with protected subsystems,
- permitted to continue an already-running operation,
- operating in a degraded/offline condition,
- or required to stop protected operations.

The Security Authority does **not** perform business operations itself.

It does not:

- launch browsers,
- execute automation,
- manage Playwright,
- manage files,
- render frontend UI,
- implement licensing business rules,
- decide backend authorization policy.

Instead, it maintains the **local security state derived from authoritative backend decisions and locally verifiable security facts**.

The central design principle is:

> **Security state is explicit, monotonic where required, transition-controlled, and never inferred from the absence of an error.**

---

# 2. Security Authority Mental Model

The Security Authority should be treated as a state machine rather than a collection of authentication functions.

Conceptually:

```text
                    ┌──────────────────────┐
                    │      UNINITIALIZED   │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │    INITIALIZING      │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴───────────┐
                    │                      │
                    ▼                      ▼
             LOCAL_INVALID           LOCAL_VALID
                    │                      │
                    ▼                      ▼
          ┌────────────────┐      ┌────────────────┐
          │   LOCKED       │      │ UNAUTHENTICATED │
          └────────────────┘      └───────┬────────┘
                                          │ login
                                          ▼
                                  ┌─────────────────┐
                                  │ AUTHENTICATING  │
                                  └────────┬────────┘
                                           │
                                  ┌────────┴─────────┐
                                  │                  │
                                  ▼                  ▼
                             AUTH_FAILURE       AUTHENTICATED
                                                     │
                                                     ▼
                                           ┌──────────────────┐
                                           │ AUTHORIZING      │
                                           └────────┬─────────┘
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                         ▼                     ▼
                                  AUTHZ_FAILURE          AUTHORIZED
                                                               │
                                                               ▼
                                                         ┌──────────┐
                                                         │ LICENSED │
                                                         └────┬─────┘
                                                              │
                                                              ▼
                                                        OPERATIONAL
```

However, the actual implementation should **not** collapse all security concepts into one Boolean such as:

```ts
authenticated = true;
```

or:

```ts
authorized = true;
```

The authority must maintain separate security dimensions.

---

# 3. Security State Dimensions

The Security Authority should conceptually maintain at least these dimensions:

```text
Machine Identity
        │
        ▼
Authentication
        │
        ▼
Session
        │
        ▼
Authorization
        │
        ▼
License
        │
        ▼
Operational Permission
```

These dimensions interact, but they are not identical.

For example:

```text
Authentication = VALID
Authorization  = INVALID
License        = VALID
```

is a legitimate state.

Likewise:

```text
Authentication = VALID
Authorization  = VALID
License        = EXPIRED
```

is also legitimate.

Therefore the state machine must distinguish them.

---

# 4. Security Authority State Hierarchy

## 4.1 Primary lifecycle states

The Security Authority has the following primary states:

```text
UNINITIALIZED
INITIALIZING
LOCAL_INVALID
LOCKED
UNAUTHENTICATED
AUTHENTICATING
AUTHENTICATED
AUTHORIZING
AUTHORIZED
LICENSE_VALID
OPERATIONAL
DEGRADED
REAUTHENTICATING
REVOKED
EXPIRED
SHUTTING_DOWN
TERMINATED
```

Not every state is necessarily exposed to the frontend.

Some are internal transitional states.

---

# 5. State Definitions

## 5.1 UNINITIALIZED

The Security Authority has not yet loaded its security state.

No security decision may be made from this state.

### Allowed actions

- initialize
- load machine identity
- load secure storage
- load local security metadata
- load protocol configuration

### Forbidden actions

- authenticate user
- authorize operations
- launch protected runtime
- establish protected backend session
- authorize Execution Plane operations

---

# 6. INITIALIZING

The Security Authority is loading and validating local security material.

Possible operations include:

```text
Load machine identity
Load cryptographic material
Load certificate state
Load cached security metadata
Validate local state
Validate protocol version
Validate application version
Validate secure storage
```

Initialization must be deterministic.

A partially initialized Security Authority must never appear operational.

---

# 7. LOCAL_INVALID

The local security environment cannot be trusted.

Examples:

- machine identity corrupted,
- encrypted security database corrupted,
- required key unavailable,
- security metadata structurally invalid,
- impossible security state detected,
- integrity validation failed.

The system should fail closed.

```text
LOCAL_INVALID
      │
      ├── repair/reinitialize
      │
      └── shutdown
```

It must not silently convert this state into `UNAUTHENTICATED`.

---

# 8. LOCKED

The Security Authority has deliberately prevented protected operation.

Examples:

- local tampering detected,
- machine identity invalidated,
- unrecoverable cryptographic failure,
- backend explicitly revoked the machine,
- security protocol incompatibility,
- administrative lock.

No protected execution is allowed.

---

# 9. UNAUTHENTICATED

The local security subsystem is healthy, but no valid user authentication session exists.

Allowed:

```text
Login
Machine registration
Security handshake
Backend communication required for authentication
```

Forbidden:

```text
Protected Execution Plane startup
Protected operations
Privileged configuration mutations
License-protected functionality
```

---

# 10. AUTHENTICATING

The Control Plane has initiated authentication but has not yet received a valid authoritative result.

This is a transitional state.

The Security Authority must prevent concurrent authentication races.

For example:

```text
Login A
Login B
```

must not create:

```text
Session A + Session B
```

without an explicit policy allowing concurrent sessions.

The normal policy should be:

```text
AUTHENTICATING
    │
    └── duplicate login → reject/coalesce
```

---

# 11. AUTHENTICATED

Authentication has succeeded.

This means:

> The backend has established that the presented credentials correspond to an identity.

It does **not** mean:

```text
authorized
licensed
allowed to execute
```

Authentication and authorization remain separate.

---

# 12. AUTHORIZING

The Security Authority is obtaining or validating authorization information.

This can include:

- account status,
- subscription state,
- machine binding,
- entitlement,
- product permissions,
- feature permissions,
- organizational permissions,
- execution restrictions.

---

# 13. AUTHORIZED

The backend has determined that the authenticated identity is allowed to use the relevant application capabilities.

Authorization can still exist without a valid license.

Therefore:

```text
Authenticated = YES
Authorized    = YES
Licensed      = NO
```

must remain representable.

---

# 14. LICENSE_VALID

The relevant entitlement/license is currently valid.

The Security Authority must maintain:

```text
license_id
license_version
issued_at
expires_at
entitlements
machine_binding
account_binding
server_generation
revocation_generation
```

where applicable.

The exact fields belong to the protocol contract, not to the state-machine abstraction.

---

# 15. OPERATIONAL

This is the primary protected operating state.

The Security Authority has sufficient security guarantees to permit protected operations.

Conceptually:

```text
Machine = VALID
Authentication = VALID
Session = VALID
Authorization = VALID
License = VALID
Protocol = COMPATIBLE
Security State = TRUSTED
```

Only this state, or explicitly permitted sub-states, should allow the Runtime Manager to start or continue protected Execution Plane operations.

---

# 16. DEGRADED

The application remains alive but cannot currently establish normal security communication.

Examples:

- backend unavailable,
- DNS failure,
- temporary network failure,
- temporary TLS failure,
- backend timeout.

Importantly:

> `DEGRADED` does not automatically mean `AUTHORIZED`.

The system must apply an explicit offline policy.

For example:

```text
Previously valid session
        +
Backend unavailable
        ↓
DEGRADED
        ↓
Offline grace policy?
```

If no grace policy exists:

```text
DEGRADED → BLOCKED
```

If a grace policy exists:

```text
DEGRADED → LIMITED_OPERATION
```

The grace policy must be explicitly defined rather than inferred.

---

# 17. REAUTHENTICATING

The current session is being replaced or renewed.

This occurs when:

- session expiration approaches,
- refresh is required,
- credentials must be renewed,
- backend requests reauthentication,
- cryptographic session material must be replaced.

The previous session must not automatically remain valid forever while renewal occurs.

The authority must define whether existing operations:

```text
continue
pause
finish
terminate
```

during reauthentication.

---

# 18. REVOKED

The backend has explicitly invalidated the security authority's permission.

Examples:

```text
Account revoked
Machine revoked
License revoked
Session revoked
Credential revoked
Security protocol revoked
```

This state is different from ordinary expiration.

Expiration can be expected.

Revocation is an explicit security decision.

---

# 19. EXPIRED

A security artifact has reached its validity boundary.

Examples:

```text
Session expired
License expired
Certificate expired
Authorization validity expired
```

Expiration must be evaluated using authoritative timestamps and carefully handled clock assumptions.

---

# 20. SHUTTING_DOWN

The application is terminating.

The Security Authority must:

1. prevent new privileged operations,
2. invalidate local operational permission,
3. notify dependent subsystems,
4. terminate protected sessions where appropriate,
5. securely persist necessary state,
6. release resources.

---

# 21. TERMINATED

No further security operations are permitted.

A new application process begins again at:

```text
UNINITIALIZED
```

---

# 22. Core Security Invariant

The most important invariant is:

```text
NO VALID SECURITY STATE
        =
NO PROTECTED OPERATION
```

The system must never reason:

```text
"I don't know whether authorization is invalid,
therefore it is probably still valid."
```

Instead:

```text
UNKNOWN
  ↓
UNTRUSTED
  ↓
BLOCK
```

This is the fundamental fail-closed rule.

---

# 23. Security Authority State Object

Conceptually, the state could resemble:

```ts
interface SecurityState {
  lifecycle: SecurityLifecycleState;

  machine: {
    status: MachineIdentityStatus;
    identityId: string | null;
    bindingStatus: MachineBindingStatus;
  };

  authentication: {
    status: AuthenticationStatus;
    principalId: string | null;
  };

  session: {
    status: SessionStatus;
    sessionId: string | null;
    issuedAt: number | null;
    expiresAt: number | null;
  };

  authorization: {
    status: AuthorizationStatus;
    generation: number;
  };

  license: {
    status: LicenseStatus;
    licenseId: string | null;
    expiresAt: number | null;
    generation: number;
  };

  protocol: {
    status: ProtocolStatus;
    version: string;
  };

  connectivity: {
    backend: ConnectivityStatus;
  };
}
```

This is conceptual.

The actual implementation should not blindly copy this structure.

---

# 24. State Transition Principles

Every transition must have:

```text
Current State
Event
Preconditions
Validation
State Mutation
Side Effects
Result
Failure Transition
```

For example:

```text
UNAUTHENTICATED
    │
    │ LOGIN_REQUEST
    ▼
AUTHENTICATING
    │
    │ AUTH_SUCCESS
    ▼
AUTHENTICATED
```

But:

```text
AUTHENTICATING
    │
    │ AUTH_FAILURE
    ▼
UNAUTHENTICATED
```

---

# 25. Transition Table

| Current State    | Event                  | Preconditions                 | Next State                  | Protected Operations   |
| ---------------- | ---------------------- | ----------------------------- | --------------------------- | ---------------------- |
| UNINITIALIZED    | Initialize             | Process starting              | INITIALIZING                | No                     |
| INITIALIZING     | Local state valid      | Identity/storage valid        | UNAUTHENTICATED             | No                     |
| INITIALIZING     | Local state invalid    | Integrity failure             | LOCAL_INVALID               | No                     |
| LOCAL_INVALID    | Repair success         | Security material restored    | UNAUTHENTICATED             | No                     |
| LOCAL_INVALID    | Fatal failure          | Cannot recover                | LOCKED                      | No                     |
| UNAUTHENTICATED  | Login                  | Valid login request           | AUTHENTICATING              | No                     |
| AUTHENTICATING   | Authentication success | Backend verified identity     | AUTHENTICATED               | No                     |
| AUTHENTICATING   | Authentication failure | Backend rejected              | UNAUTHENTICATED             | No                     |
| AUTHENTICATING   | Timeout                | No authoritative result       | UNAUTHENTICATED / DEGRADED  | No                     |
| AUTHENTICATED    | Authorization request  | Session valid                 | AUTHORIZING                 | No                     |
| AUTHORIZING      | Authorization success  | Backend grants permission     | AUTHORIZED                  | Limited                |
| AUTHORIZING      | Authorization failure  | Permission denied             | AUTHENTICATED               | No protected execution |
| AUTHORIZED       | License valid          | Entitlement valid             | LICENSE_VALID               | Limited                |
| AUTHORIZED       | License invalid        | Entitlement invalid           | AUTHORIZED / EXPIRED        | No licensed execution  |
| LICENSE_VALID    | Operational start      | All security conditions valid | OPERATIONAL                 | Yes                    |
| OPERATIONAL      | Backend unavailable    | Offline policy permits        | DEGRADED                    | Policy-dependent       |
| OPERATIONAL      | Backend unavailable    | Offline policy denies         | DEGRADED                    | No                     |
| OPERATIONAL      | Session expires        | Session timeout reached       | EXPIRED / REAUTHENTICATING  | No new protected work  |
| OPERATIONAL      | License expires        | License timeout reached       | EXPIRED                     | No licensed work       |
| OPERATIONAL      | Revocation             | Backend explicitly revokes    | REVOKED                     | No                     |
| OPERATIONAL      | Security violation     | Integrity/security failure    | LOCKED                      | No                     |
| DEGRADED         | Backend restored       | Session still valid           | OPERATIONAL                 | Policy-dependent       |
| DEGRADED         | Session expires        | No renewal                    | EXPIRED                     | No                     |
| DEGRADED         | License expires        | No renewal                    | EXPIRED                     | No                     |
| EXPIRED          | Renewal succeeds       | Backend validates             | OPERATIONAL / LICENSE_VALID | Policy-dependent       |
| EXPIRED          | Renewal fails          | Backend rejects               | UNAUTHENTICATED / LOCKED    | No                     |
| REAUTHENTICATING | Renewal success        | New session valid             | OPERATIONAL                 | Yes                    |
| REAUTHENTICATING | Renewal failure        | Existing session invalid      | EXPIRED                     | No                     |
| REVOKED          | Re-login               | Backend permits new session   | AUTHENTICATING              | No                     |
| REVOKED          | No recovery            | Explicit revocation           | LOCKED                      | No                     |
| Any              | Logout                 | Session exists                | UNAUTHENTICATED             | No                     |
| Any              | Shutdown               | Process terminating           | SHUTTING_DOWN               | No                     |
| SHUTTING_DOWN    | Complete               | Cleanup complete              | TERMINATED                  | No                     |

---

# 26. Authentication Transition Model

Authentication should be modeled separately from authorization.

```text
UNAUTHENTICATED
       │
       │ LoginRequested
       ▼
AUTHENTICATING
       │
       ├──── AuthenticationRejected ────► UNAUTHENTICATED
       │
       ├──── AuthenticationTimeout ─────► UNAUTHENTICATED
       │
       ├──── ProtocolFailure ───────────► DEGRADED
       │
       └──── AuthenticationAccepted
                         │
                         ▼
                  AUTHENTICATED
```

The Security Authority should never directly transition:

```text
UNAUTHENTICATED → OPERATIONAL
```

There must be intermediate authorization and entitlement validation.

---

# 27. Authorization Transition Model

```text
AUTHENTICATED
      │
      │ AuthorizationRequested
      ▼
AUTHORIZING
      │
      ├── Denied ─────────► AUTHENTICATED
      │
      ├── BackendFailure ─► DEGRADED
      │
      └── Granted
             │
             ▼
        AUTHORIZED
```

---

# 28. License Transition Model

```text
AUTHORIZED
     │
     │ LicenseValidated
     ▼
LICENSE_VALID
     │
     ├── Expiration ───────► EXPIRED
     │
     ├── Revocation ───────► REVOKED
     │
     └── OperationalStart
                 │
                 ▼
             OPERATIONAL
```

---

# 29. Session Lifecycle

The session should have its own lifecycle.

```text
NONE
 │
 │ authentication success
 ▼
ACTIVE
 │
 ├── renewal
 │      │
 │      └── ACTIVE
 │
 ├── expiration
 │      ▼
 │   EXPIRED
 │
 ├── revocation
 │      ▼
 │   REVOKED
 │
 └── logout
        ▼
       NONE
```

The important property is that session renewal must not silently mutate an old session into a new session without generation tracking.

---

# 30. Session Generations

Every security session should conceptually have a generation or epoch.

Example:

```text
Session Generation 41
```

After renewal:

```text
Session Generation 42
```

A response belonging to generation 41 arriving after generation 42 exists must be rejected.

Therefore:

```text
Current session = 42

Incoming response = 41

Result:
REJECT
```

This protects against:

- delayed responses,
- replay,
- out-of-order messages,
- race conditions,
- stale backend responses.

---

# 31. Security Message Ordering

Security messages should carry sufficient metadata to establish their validity.

Conceptually:

```text
message_id
session_id
session_generation
request_id
timestamp
expiration
message_type
sequence
payload
authentication_tag
```

The exact protocol should be defined separately.

The principle is:

> A message must be valid cryptographically and valid within the current security state.

Valid cryptography alone is insufficient.

---

# 32. Duplicate Requests

Duplicate requests must not automatically create duplicate security state.

Example:

```text
LoginRequest #100
LoginRequest #100
```

The Security Authority should recognize the duplicate request identity.

Similarly:

```text
LicenseRefresh #72
LicenseRefresh #72
```

must not produce conflicting transitions.

---

# 33. Out-of-Order Responses

Example:

```text
Request A → backend
Request B → backend

Response B arrives
Response A arrives later
```

If B already advanced the security state, A may now be stale.

The Security Authority must validate:

```text
request_id
session_generation
state generation
sequence
```

before applying the response.

---

# 34. Backend Revocation

Revocation is authoritative.

Example:

```text
OPERATIONAL
      │
      │ Backend: REVOKED
      ▼
REVOKED
```

The Control Plane must not continue operating merely because:

```text
the local license cache says valid
```

unless an explicitly defined offline policy permits temporary operation.

---

# 35. License Expiration During Active Execution

This is one of the most important transitions.

Example:

```text
OPERATIONAL
     │
     │ LicenseExpired
     ▼
EXPIRED
```

The Security Authority must then communicate the security decision to the Runtime Manager.

The Runtime Manager decides how to safely terminate or suspend the Execution Plane according to its own contract.

The Security Authority does **not** implement browser termination logic.

It only communicates:

```text
protected execution permission = revoked
```

---

# 36. Authorization Change During Execution

Authorization can change while the application is already running.

Example:

```text
OPERATIONAL
    │
    │ Backend authorization update
    ▼
AUTHORIZED_WITH_CHANGED_POLICY
```

The implementation may represent this through a policy generation rather than a dedicated state.

Example:

```text
Authorization Generation = 18

Backend changes policy

Authorization Generation = 19
```

Existing operations must be evaluated against the defined policy.

---

# 37. Offline Operation

Offline behavior must never be accidental.

There are three fundamentally different possibilities:

### Strict-online

```text
Backend unavailable
        ↓
No protected operation
```

### Grace period

```text
Backend unavailable
        ↓
Existing valid session
        ↓
Grace period
        ↓
Limited operation
```

### Cached authorization

```text
Backend unavailable
        ↓
Cryptographically protected cached authorization
        ↓
Operate until defined expiry
```

The architecture should support the policy without hardcoding one prematurely.

---

# 38. Clock Anomalies

The Security Authority must treat local time as potentially unreliable.

Relevant events include:

```text
Clock rollback
Clock jump forward
Clock synchronization
Sleep
Hibernate
VM snapshot restore
System resume
```

For example:

```text
License expires:
12:00

System clock:
11:30 → 09:00
```

The system must not blindly conclude:

```text
license valid again
```

Similarly:

```text
11:30 → 18:00
```

must not necessarily produce an immediate security disaster without considering the defined time-validation policy.

A monotonic clock should be used for elapsed-time measurements whenever possible.

Wall-clock time should be used only where absolute timestamps are required.

---

# 39. Sleep / Hibernate

The application may enter:

```text
OPERATIONAL
```

and then the machine sleeps for several hours.

Upon resume:

```text
ResumeDetected
       ↓
Security revalidation
       ↓
Is session still valid?
Is license still valid?
Has clock changed?
Has network identity changed?
Has machine identity changed?
```

The Security Authority should not simply continue as if no interruption occurred.

---

# 40. Machine Identity State

Machine identity has its own lifecycle:

```text
ABSENT
   │
   │ generate
   ▼
CREATED
   │
   ├── validate ──► VALID
   │
   ├── corruption ──► CORRUPTED
   │
   └── replacement ──► REPLACED
```

Machine identity should be treated as security state, not ordinary configuration.

---

# 41. Machine Identity Corruption

If the machine identity cannot be reliably validated:

```text
OPERATIONAL
      ↓
LOCAL_INVALID
```

The application must not automatically generate a new identity.

Blind regeneration could effectively bypass machine binding.

Instead:

```text
Detect corruption
      ↓
Invalidate current security state
      ↓
Controlled recovery
      ↓
Backend re-registration if permitted
```

---

# 42. Installation Copy / VM Clone

A copied installation may produce:

```text
Installation A
Machine Identity X
```

and then:

```text
Installation B
Machine Identity X
```

The backend must be able to detect duplicate machine identity usage where machine binding requires uniqueness.

The Control Plane must treat the resulting backend decision as authoritative.

---

# 43. Snapshot Rollback

A VM or filesystem snapshot may restore:

```text
Session Generation = 40
```

after the server has already issued:

```text
Session Generation = 41
```

The restored client must not automatically resurrect session 40.

The protocol should therefore contain server-verifiable freshness or generation information.

---

# 44. Local Security Database Rollback

The same principle applies to SQLite or encrypted local state.

Example:

```text
Database state:
Generation 100

Filesystem restored

Database state:
Generation 72
```

The Security Authority must recognize that the local security state may have moved backwards.

Rollback must not grant security authority.

---

# 45. Security State Corruption

If the state machine encounters an impossible state such as:

```text
authenticated = false
session = ACTIVE
authorization = VALID
license = VALID
```

the state must be rejected.

The system should never attempt to "guess" which value is correct.

Instead:

```text
Invalid state
    ↓
Security fault
    ↓
LOCAL_INVALID / LOCKED
```

---

# 46. Unauthorized Local IPC

The local Control Plane API is itself a security boundary.

A malicious process may attempt:

```text
POST /runtime/start
```

without being the legitimate frontend.

Therefore:

```text
Frontend
    │
    ▼
Local API
    │
    ▼
Security Authority
```

must authenticate and authorize local clients.

Localhost is not equivalent to trusted.

---

# 47. Malicious Frontend

The frontend must be considered replaceable and potentially compromised.

Therefore the frontend cannot be trusted to say:

```json
{
  "authorized": true
}
```

or:

```json
{
  "licenseValid": true
}
```

The Security Authority owns those decisions.

The frontend may request:

```text
START_RUNTIME
```

but the Security Authority determines whether that request is permitted.

---

# 48. Privilege Separation

The architecture should distinguish:

```text
Frontend
    ↓
Control API
    ↓
Security Authority
    ↓
Runtime Manager
    ↓
Execution Plane
```

The frontend should never obtain the credentials or cryptographic material used to establish trusted backend security sessions.

---

# 49. Security Authority and Runtime Manager

The Runtime Manager should receive a capability-like result.

Conceptually:

```ts
securityAuthority.assertCapability("EXECUTION_START");
```

or:

```ts
const authorization = securityAuthority.getExecutionAuthorization();
```

The Runtime Manager should not inspect:

```text
password
session encryption keys
license cryptographic material
backend credentials
machine private keys
```

It only needs the result:

```text
PERMITTED
```

or:

```text
DENIED
```

plus whatever narrowly scoped execution metadata is explicitly required.

---

# 50. Security Authority and Backend

The backend is the authoritative source for decisions such as:

```text
Identity validity
Account validity
Machine binding
License validity
Revocation
Authorization
Session issuance
Protocol compatibility
```

The Security Authority locally enforces those decisions.

This produces:

```text
Backend
  = authority for server-side truth

Security Authority
  = authority for local security enforcement
```

These are different responsibilities.

---

# 51. Security Authority and Execution Plane

The Execution Plane must not determine:

```text
whether user is licensed
whether account is authorized
whether machine is registered
whether credentials are valid
```

Instead:

```text
Security Authority
       │
       │ execution permission
       ▼
Runtime Manager
       │
       ▼
Execution Plane
```

The Execution Plane receives only the permissions and operational instructions it requires.

---

# 52. Security Event Model

The Security Authority should emit explicit security events.

Examples:

```text
SecurityInitialized
MachineIdentityValidated
MachineIdentityInvalid
AuthenticationStarted
AuthenticationSucceeded
AuthenticationFailed
SessionCreated
SessionRenewalStarted
SessionRenewed
SessionExpired
AuthorizationStarted
AuthorizationGranted
AuthorizationDenied
LicenseValidated
LicenseExpired
LicenseRevoked
BackendUnavailable
BackendRestored
SecurityDegraded
SecurityRecovered
SecurityStateInvalid
SecurityTamperDetected
SecurityLocked
LogoutCompleted
SecurityShutdown
```

Events should describe facts that occurred.

They should not become an alternative mutable source of truth.

---

# 53. Transition Transactionality

Security transitions must be atomic from the perspective of dependent subsystems.

For example:

```text
Session renewal
```

should not produce:

```text
Session = NEW
License = OLD
Authorization = UNKNOWN
```

for an observable intermediate period unless explicitly supported.

The transition should be committed as a coherent security-state update.

---

# 54. Crash During Transition

Suppose:

```text
AUTHENTICATED
      ↓
AUTHORIZING
```

and the process crashes halfway through.

After restart:

```text
Do not assume AUTHORIZED.
```

The system should reconstruct security state conservatively.

The normal rule should be:

```text
Incomplete security transition
        ↓
Revalidate
```

not:

```text
Incomplete security transition
        ↓
Assume success
```

---

# 55. Security State Persistence

Only state that is safe and meaningful to persist should be persisted.

Persisting:

```text
current state = OPERATIONAL
```

is not sufficient to make the application operational after restart.

Instead, persistence should contain information that allows the authority to reconstruct and revalidate state.

For example:

```text
machine identity
security metadata
session metadata where permitted
license metadata
server generations
protocol metadata
```

But persisted state should never be treated as inherently authoritative.

---

# 56. Restart While Offline

Example:

```text
Application running
      ↓
OPERATIONAL
      ↓
Crash
      ↓
Restart
      ↓
Backend unavailable
```

The application must not simply restore:

```text
OPERATIONAL
```

from disk.

Instead:

```text
Persisted state
      ↓
Validate freshness
      ↓
Apply offline policy
      ↓
DEGRADED / OPERATIONAL / BLOCKED
```

---

# 57. Multiple Control Plane Processes

Only one authoritative Security Authority should normally exist for a machine/application installation.

If:

```text
Control Plane A
Control Plane B
```

attempt to operate simultaneously, they may race over:

```text
machine identity
session
license
runtime
local database
security state
```

The application should therefore establish an application-instance lock or equivalent singleton mechanism.

---

# 58. Logout During Active Operations

Logout must be an explicit security transition.

Example:

```text
OPERATIONAL
      │
      │ Logout
      ▼
UNAUTHENTICATED
```

The Security Authority must notify the Runtime Manager that protected execution is no longer authorized.

The Runtime Manager owns the actual Execution Plane shutdown behavior.

---

# 59. Logout Race

Consider:

```text
Frontend → START_RUNTIME
Frontend → LOGOUT
```

If the requests arrive almost simultaneously, the system must not allow:

```text
START_RUNTIME
```

to execute after the security authority has committed:

```text
LOGOUT
```

The security generation must therefore participate in authorization decisions.

---

# 60. Security Generation

A useful conceptual mechanism is a global security generation:

```text
Generation 100
```

Every security-invalidating transition increments it:

```text
Logout
Revocation
Session replacement
License revocation
Security lock
```

Example:

```text
Generation 100
      ↓ logout
Generation 101
```

An operation authorized under generation 100 becomes stale.

This is particularly useful for coordinating the Control Plane with the Execution Plane.

---

# 61. Operation Authorization

Every protected operation can conceptually carry:

```text
security_generation = 100
```

The Security Authority later observes:

```text
current_security_generation = 101
```

Therefore:

```text
operation authorization = INVALID
```

This protects against stale authorization.

---

# 62. Replayed Operations

A malicious local process may capture:

```text
START_RUNTIME
```

and send it later.

The request should contain sufficient freshness information to prevent indefinite replay.

Possible mechanisms include:

```text
request ID
nonce
generation
expiration
authenticated local channel
```

The exact mechanism belongs to the protocol design.

---

# 63. Cryptographic Failure

If a protected security message fails cryptographic validation:

```text
Invalid signature
Invalid authentication tag
Invalid certificate
Invalid key agreement
Invalid message authentication
```

the message must be rejected.

Repeated failures may trigger:

```text
security anomaly
```

but a single malformed message should not automatically destroy the entire application unless the threat model requires it.

---

# 64. Backend Key Rotation

Backend cryptographic keys may change.

The Security Authority must support:

```text
old key
    ↓
rotation
    ↓
new key
```

without requiring an application update whenever the protocol permits transparent key rotation.

However, trust anchors themselves must be protected from local tampering.

---

# 65. Protocol Version Mismatch

Example:

```text
Control Plane = protocol 7
Backend = protocol 8
```

The Security Authority must not guess compatibility.

Instead:

```text
NEGOTIATION
    ↓
compatible → continue
incompatible → controlled failure
```

Security-sensitive incompatibility should fail closed.

---

# 66. Backend Failure Classification

Not all backend failures are security failures.

### Temporary infrastructure failure

```text
timeout
DNS
connection refused
temporary 5xx
```

Potential transition:

```text
OPERATIONAL → DEGRADED
```

### Authoritative security failure

```text
401
403
revoked
expired
invalid session
invalid machine
```

Potential transition:

```text
OPERATIONAL → EXPIRED / REVOKED / UNAUTHENTICATED
```

The distinction is critical.

---

# 67. Failure Classification Table

| Failure               | Security Meaning                  | Default Direction                  |
| --------------------- | --------------------------------- | ---------------------------------- |
| DNS failure           | Unknown backend state             | DEGRADED                           |
| Timeout               | Unknown backend state             | DEGRADED                           |
| TLS handshake failure | Communication/security failure    | DEGRADED                           |
| 500                   | Backend unavailable               | DEGRADED                           |
| 401                   | Session invalid                   | REAUTHENTICATING / UNAUTHENTICATED |
| 403                   | Authorization denied              | AUTHENTICATED / BLOCKED            |
| License expired       | Entitlement invalid               | EXPIRED                            |
| License revoked       | Explicit security decision        | REVOKED                            |
| Invalid signature     | Security protocol failure         | SECURITY FAULT                     |
| Invalid certificate   | Trust failure                     | SECURITY FAULT                     |
| Corrupt local state   | Local integrity failure           | LOCAL_INVALID                      |
| Machine revoked       | Explicit security decision        | REVOKED                            |
| Protocol incompatible | Cannot establish trusted protocol | LOCKED / BLOCKED                   |

---

# 68. State Machine Invariants

The implementation should enforce these invariants.

### Invariant 1

```text
UNAUTHENTICATED
⇒ no protected operation
```

### Invariant 2

```text
EXPIRED
⇒ no operation requiring the expired entitlement
```

### Invariant 3

```text
REVOKED
⇒ no protected operation
```

### Invariant 4

```text
LOCKED
⇒ no protected operation
```

### Invariant 5

```text
UNKNOWN SECURITY STATE
⇒ DENY
```

### Invariant 6

```text
STALE SECURITY GENERATION
⇒ DENY
```

### Invariant 7

```text
STALE SESSION
⇒ DENY
```

### Invariant 8

```text
AUTHENTICATED ≠ AUTHORIZED
```

### Invariant 9

```text
AUTHORIZED ≠ LICENSE_VALID
```

### Invariant 10

```text
LICENSE_VALID ≠ OPERATIONAL
```

Additional operational preconditions may still be required.

---

# 69. Transition Authorization

Not every component should be able to trigger every transition.

For example:

| Transition                    | Authorized Initiator                  |
| ----------------------------- | ------------------------------------- |
| Initialize                    | Application Manager                   |
| Login                         | Frontend/API                          |
| Authentication result         | Security Authority ↔ Backend protocol |
| Logout                        | User/API/Application                  |
| License update                | Backend security protocol             |
| Revocation                    | Backend security protocol             |
| Runtime authorization         | Security Authority                    |
| Shutdown                      | Application Manager                   |
| Security lock                 | Security Authority                    |
| Machine identity regeneration | Controlled recovery mechanism         |

The frontend must not be able to directly issue:

```text
SET_SECURITY_STATE(OPERATIONAL)
```

---

# 70. State Mutation Rule

External components should never directly mutate security state.

Bad:

```ts
securityState.authorized = true;
```

Good:

```ts
securityAuthority.processAuthorizationResult(result);
```

The Security Authority validates the event and performs the transition.

---

# 71. Recommended Internal Architecture

The Security Authority can itself be divided into:

```text
Security Authority
│
├── Machine Identity
│
├── Credential Manager
│
├── Authentication Engine
│
├── Session Manager
│
├── Authorization Engine
│
├── License Authority Client
│
├── Security Protocol
│
├── Cryptographic Provider
│
├── Key Manager
│
├── State Machine
│
├── Security State Store
│
├── Replay Protection
│
├── Clock / Time Validation
│
├── Backend Trust Manager
│
├── Security Event Dispatcher
│
└── Policy Engine
```

These are internal modules.

The rest of the Control Plane should see the Security Authority as one coherent subsystem.

---

# 72. External Interface

The Control Plane should interact with it through intent.

Conceptually:

```ts
securityAuthority.initialize();

securityAuthority.login(credentials);

securityAuthority.logout();

securityAuthority.getState();

securityAuthority.authorize(operation);

securityAuthority.getCapabilities();

securityAuthority.onSecurityEvent(listener);

securityAuthority.shutdown();
```

The exact API should be designed after the state machine and protocol semantics are finalized.

---

# 73. Capability-Based Result

Instead of exposing sensitive security internals, the Security Authority should expose narrow capabilities.

For example:

```ts
{
    execution: {
        start: true,
        stop: true,
        restart: true
    },

    fileTransfer: {
        upload: true,
        download: true
    }
}
```

These values are derived from authoritative security state.

The frontend cannot manufacture them.

---

# 74. Security Authority Is Not the Backend

This distinction is essential.

```text
Backend
    =
authoritative remote security/business policy

Security Authority
    =
local enforcement and security-state coordinator
```

The Security Authority cannot make a revoked backend license valid again.

It can only enforce what it knows.

---

# 75. Security Authority Is Not Authentication Alone

Authentication is only one subsystem.

The complete security lifecycle is closer to:

```text
Machine Identity
       ↓
Secure Initialization
       ↓
Authentication
       ↓
Session Establishment
       ↓
Authorization
       ↓
License / Entitlement
       ↓
Operational Permission
       ↓
Continuous Validation
       ↓
Renewal / Revocation / Expiration
       ↓
Shutdown
```

---

# 76. Continuous Validation

The system should not necessarily "ping the backend every X seconds" simply because that seems secure.

Instead, backend communication should be driven by security requirements.

Examples:

```text
session renewal
license refresh
heartbeat
revocation check
authorization refresh
key rotation
```

These may happen on different schedules.

The Security Authority should therefore have explicit concepts such as:

```text
session_expiry
renewal_deadline
license_expiry
authorization_refresh_deadline
heartbeat_deadline
offline_grace_deadline
```

rather than one generic:

```text
ping_every_30_seconds
```

---

# 77. Security Heartbeat

A heartbeat may serve multiple purposes:

```text
liveness
session validity
revocation detection
machine presence
license validation
```

But these purposes should not be conflated.

A successful TCP connection does **not** prove authorization.

A successful heartbeat does **not** automatically prove that a license is still valid.

The protocol should explicitly state what each message establishes.

---

# 78. Startup State Reconstruction

Startup should follow:

```text
Process Start
      ↓
Security Authority Initialize
      ↓
Load local security metadata
      ↓
Validate machine identity
      ↓
Validate cryptographic storage
      ↓
Validate protocol compatibility
      ↓
Determine cached state
      ↓
Determine backend availability
      ↓
Perform required security handshake
      ↓
Establish current authoritative state
      ↓
Expose capabilities
      ↓
Allow dependent subsystems to start
```

The Execution Plane should not be started before the Security Authority reaches the required state.

---

# 79. Runtime Startup Gate

Conceptually:

```text
Application Manager
       │
       ▼
Security Authority
       │
       │ "Is execution permitted?"
       ▼
       ├── DENIED ──► Runtime does not start
       │
       └── GRANTED
              │
              ▼
        Runtime Manager
              │
              ▼
        Execution Plane
```

This creates a clean security boundary.

---

# 80. Runtime Shutdown Gate

When security permission is revoked:

```text
Security Authority
       │
       │ EXECUTION_PERMISSION_REVOKED
       ▼
Runtime Manager
       │
       ▼
Execution Plane
```

The Runtime Manager owns the actual shutdown mechanics.

The Security Authority owns the security decision.

---

# 81. The Most Important Architectural Rule

The Security Authority should never be designed as:

```text
if (loggedIn && licenseValid) {
    allow();
}
```

That is too simplistic for the system.

Instead:

```text
Request
   ↓
Current Security State
   ↓
Current Security Generation
   ↓
Current Session
   ↓
Current Authorization
   ↓
Current Entitlement
   ↓
Current Policy
   ↓
Operation Capability
   ↓
ALLOW / DENY
```

---

# 82. Final State Model

The complete conceptual lifecycle becomes:

```text
                         ┌─────────────────┐
                         │ UNINITIALIZED   │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ INITIALIZING    │
                         └────────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
             LOCAL_INVALID                 UNAUTHENTICATED
                    │                           │
                    ▼                           │ LOGIN
                 LOCKED                         ▼
                                      ┌─────────────────┐
                                      │ AUTHENTICATING  │
                                      └────────┬────────┘
                                               │
                                      ┌────────┴────────┐
                                      │                 │
                                      ▼                 ▼
                              AUTHENTICATION      AUTHENTICATED
                                FAILURE                 │
                                      │                 ▼
                                      │          ┌──────────────┐
                                      │          │ AUTHORIZING  │
                                      │          └──────┬───────┘
                                      │                 │
                                      │          ┌──────┴──────┐
                                      │          │             │
                                      │          ▼             ▼
                                      │      DENIED        AUTHORIZED
                                      │                        │
                                      │                        ▼
                                      │                 LICENSE VALID
                                      │                        │
                                      │                        ▼
                                      │                   OPERATIONAL
                                      │                        │
                                      │              ┌─────────┼─────────┐
                                      │              │         │         │
                                      │              ▼         ▼         ▼
                                      │          DEGRADED   EXPIRED   REVOKED
                                      │              │
                                      │              ▼
                                      │       SECURITY RECOVERY
                                      │              │
                                      │              ▼
                                      │          OPERATIONAL
                                      │
                                      └─────────────────────────────┐
                                                                    │
                                                                    ▼
                                                               UNAUTHENTICATED
```

---

# 83. Design Conclusion

The Security Authority should therefore be treated as a **first-class subsystem of the Control Plane**, not as a collection of middleware, authentication routes, and license checks.

Its core responsibility is:

> **Maintain a trustworthy local representation of security authority and continuously determine whether protected operations remain permitted.**

The critical separation is:

```text
Backend
  └── authoritative security/business decisions

Security Authority
  └── local security state + enforcement

Control Plane
  └── application orchestration

Runtime Manager
  └── Execution Plane lifecycle

Execution Plane
  └── automation execution
```

This gives the Control Plane a very clean security boundary:

```text
                 BACKEND
                    │
          authoritative decisions
                    │
                    ▼
          ┌────────────────────┐
          │ SECURITY AUTHORITY │
          │                    │
          │ State Machine      │
          │ Session            │
          │ Authorization      │
          │ License            │
          │ Machine Identity   │
          │ Crypto             │
          │ Policy             │
          │ Replay Protection  │
          └─────────┬──────────┘
                    │
             capabilities
                    │
                    ▼
          ┌────────────────────┐
          │   CONTROL PLANE   │
          └─────────┬──────────┘
                    │
             runtime intent
                    │
                    ▼
          ┌────────────────────┐
          │  RUNTIME MANAGER   │
          └─────────┬──────────┘
                    │
                    ▼
          ┌────────────────────┐
          │  EXECUTION PLANE   │
          └────────────────────┘
```

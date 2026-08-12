# Security Authority ↔ Execution Plane Authorization Contract

**Document:** `security_authority_execution_plane_authorization_contract.md`
**Status:** Design Specification
**Scope:** Control Plane Security Authority ↔ Execution Plane
**Purpose:** Define exactly how the Security Authority authorizes, constrains, monitors, and revokes Execution Plane access without exposing Backend credentials, licensing internals, or Security Authority implementation details.

---

# 1. Purpose

The Execution Plane is a separate subsystem.

It owns:

- browser execution,
- automation,
- synchronization,
- scheduling,
- recovery,
- browser lifecycle,
- execution state.

The Security Authority owns:

- authentication,
- authorization,
- licensing,
- machine identity,
- session state,
- security state,
- revocation.

The Execution Plane must therefore **never become responsible for deciding whether the user is authorized to use the application**.

Instead:

```text
Backend
   │
   ▼
Security Authority
   │
   │ authorization decision
   ▼
Execution Plane
```

The contract defined here establishes the exact boundary.

---

# 2. Fundamental Principle

The Execution Plane should not ask:

> "Is John's subscription valid?"

It should ask:

> **"Am I currently authorized to perform this execution capability?"**

This distinction is critical.

The Execution Plane should know about **authorization**, not the business meaning behind that authorization.

---

# 3. Black-Box Boundary

The Execution Plane remains a black box to the Security Authority.

The Security Authority does not know:

- how browsers are synchronized,
- how commands are scheduled,
- how locators work,
- how Playwright is used,
- how recovery works,
- how browser contexts are managed,
- how DOM events are processed.

Likewise, the Execution Plane does not know:

- how authentication works,
- how passwords are processed,
- how licensing works,
- how Backend sessions work,
- how machine identity is generated,
- how cryptographic keys are stored.

---

# 4. Architectural Relationship

```text
                         BACKEND
                            │
                            │
                     Security Authority
                            │
                    Authorization Context
                            │
                            ▼
                  ┌───────────────────┐
                  │   Runtime Manager │
                  └─────────┬─────────┘
                            │
                  Authorization Contract
                            │
                            ▼
                  ┌───────────────────┐
                  │   Execution Plane │
                  │                   │
                  │ Synchronization   │
                  │ Scheduling        │
                  │ Automation        │
                  │ Recovery          │
                  │ Browser Runtime   │
                  └───────────────────┘
```

The Runtime Manager should be the primary integration boundary.

---

# 5. Trust Relationship

The Security Authority does **not** treat the Execution Plane as an authority.

The Execution Plane is a **capability consumer**.

```text
Security Authority
        │
        │ grants
        ▼
Authorization
        │
        ▼
Execution Plane
```

The Execution Plane may report facts such as:

```text
runtime started
runtime stopped
runtime crashed
runtime unhealthy
```

It must not report:

```text
license valid
user authorized
session valid
```

as authoritative security decisions.

---

# 6. Authorization Contract

The contract answers four questions:

1. **May the Execution Plane start?**
2. **What may it do?**
3. **For how long may it do it?**
4. **What happens when authorization disappears?**

---

# 7. Authorization Context

The Security Authority provides a restricted execution authorization context.

Conceptually:

```text
ExecutionAuthorization {
    authorization_id
    session_reference
    security_epoch
    capabilities
    constraints
    issued_at
    expires_at
}
```

The exact serialization is implementation-defined.

---

# 8. What the Execution Plane Receives

The Execution Plane may receive:

```text
authorization_id
security_epoch
capabilities
execution constraints
expiration
```

It should **not** receive:

```text
user password
refresh credential
private machine key
license secret
Backend credentials
authentication tokens unnecessary for execution
```

---

# 9. Capability Model

Authorization should be capability-oriented.

Example capabilities:

```text
EXECUTION_START
EXECUTION_STOP
EXECUTION_PAUSE
EXECUTION_RESUME
BROWSER_ALLOCATE
BROWSER_DESTROY
EXECUTION_RECOVER
```

Additional capabilities can be introduced later.

---

# 10. Capability Semantics

Each capability should represent an explicit permission.

For example:

```text
EXECUTION_START
```

means:

> The Execution Plane may establish an execution runtime.

It does not mean:

> The Execution Plane may modify authentication.

---

# 11. Capability Constraints

Capabilities may contain limits.

Example:

```text
EXECUTION_START
    max_runtime_instances = 3
```

or:

```text
BROWSER_ALLOCATE
    max_browsers = 20
```

The Execution Plane should enforce these operational constraints where appropriate.

However, authoritative entitlement originates from the Security Authority.

---

# 12. Why Capabilities Are Better Than License Information

Avoid:

```text
license_type = PREMIUM
```

being sent to the Execution Plane.

Instead send:

```text
EXECUTION_START
BROWSER_ALLOCATE
max_browsers = 20
```

This prevents the Execution Plane from becoming coupled to licensing concepts.

The Backend can change:

```text
Premium
Pro
Enterprise
Basic
```

without changing Execution Plane semantics.

---

# 13. Authorization Identifier

Each authorization grant receives an identifier.

Example:

```text
authorization_id = AUTH-83A...
```

This allows the Control Plane to identify which authorization context produced an execution session.

---

# 14. Security Epoch

The authorization is bound to a security epoch.

Example:

```text
authorization_epoch = 42
```

If the Security Authority moves to:

```text
epoch = 43
```

the Execution Plane must not continue treating epoch 42 as current indefinitely.

---

# 15. Authorization Expiration

Every authorization grant should have an expiration.

Conceptually:

```text
issued_at
expires_at
```

The Execution Plane may continue operating only while the authorization remains valid according to the contract.

---

# 16. Why Expiration Exists

Expiration limits the lifetime of stale authorization.

Without expiration:

```text
license valid
      ↓
authorization granted
      ↓
license revoked
      ↓
Execution Plane continues forever
```

With expiration:

```text
authorization
      ↓
expires
      ↓
must be renewed
```

---

# 17. Authorization Acquisition

The normal sequence is:

```text
Control Plane starts
        │
        ▼
Security Authority
        │
        ├── authenticated?
        ├── machine valid?
        ├── session valid?
        ├── license valid?
        └── capability available?
        │
        ▼
Execution Authorization
        │
        ▼
Runtime Manager
        │
        ▼
Execution Plane
```

---

# 18. Execution Start

A simplified contract:

```text
RuntimeManager.start()
```

internally results in:

```text
SecurityAuthority.authorize(EXECUTION_START)
```

If successful:

```text
ExecutionPlane.initialize(ExecutionAuthorization)
```

If unsuccessful:

```text
ExecutionPlane.initialize()
```

must not occur.

---

# 19. Authorization Failure

Possible outcomes include:

```text
AUTHENTICATION_REQUIRED
SESSION_EXPIRED
LICENSE_EXPIRED
LICENSE_REVOKED
MACHINE_REVOKED
CAPABILITY_DENIED
SECURITY_STATE_INVALID
AUTHORITY_UNAVAILABLE
PROTOCOL_INCOMPATIBLE
```

The Execution Plane does not need to understand the entire security domain.

The Runtime Manager can translate these into operational states.

---

# 20. Example

Security Authority:

```text
authorize(EXECUTION_START)
```

returns:

```text
{
    granted: true,
    authorization_id: "...",
    epoch: 42,
    expires_at: "...",
    capabilities: [
        EXECUTION_START,
        EXECUTION_STOP,
        EXECUTION_PAUSE,
        EXECUTION_RESUME
    ]
}
```

Runtime Manager passes the restricted authorization to the Execution Plane.

---

# 21. Execution Plane Startup

The Execution Plane verifies the contract.

It should validate:

```text
authorization exists
authorization is structurally valid
authorization has not expired
authorization epoch is acceptable
required capability exists
```

It does **not** need to contact the Backend.

---

# 22. Important Boundary

The Execution Plane should not directly communicate with the Backend for authorization.

Avoid:

```text
Execution Plane
      │
      └──────────► Backend
```

Prefer:

```text
Execution Plane
      ▲
      │
Runtime Manager
      ▲
      │
Security Authority
      ▲
      │
Backend
```

This preserves the architectural boundary.

---

# 23. Why This Matters

If the Execution Plane directly understands Backend authentication:

```text
Execution Plane
   ├── Backend protocol
   ├── authentication
   ├── licensing
   ├── session renewal
   └── execution
```

it becomes coupled to the Control Plane security architecture.

Replacing the Backend protocol would then require changing the Execution Plane.

That violates the intended modularity.

---

# 24. Authorization Renewal

Authorization should be renewable.

Conceptually:

```text
Execution authorization
        │
        ▼
approaching expiration
        │
        ▼
Security Authority
        │
        ▼
Backend revalidation
        │
        ▼
new authorization
        │
        ▼
Execution Plane
```

The Execution Plane should not independently negotiate renewal with the Backend.

---

# 25. Authorization Renewal Contract

Example:

```text
renewExecutionAuthorization(
    authorization_id
)
```

Possible result:

```text
AUTHORIZATION_RENEWED
```

or:

```text
AUTHORIZATION_DENIED
```

or:

```text
AUTHORITY_UNAVAILABLE
```

---

# 26. Authorization Revocation

Revocation is more important than expiration.

Suppose:

```text
Execution Plane
       │
       │ currently running
       ▼
Security Authority
       │
       │ Backend reports revocation
       ▼
Authorization revoked
```

The Execution Plane must receive a revocation event.

---

# 27. Revocation Event

Conceptually:

```text
AuthorizationRevoked {
    authorization_id
    security_epoch
    reason
    effective_at
}
```

Possible reasons:

```text
LICENSE_REVOKED
SESSION_REVOKED
MACHINE_REVOKED
ACCOUNT_REVOKED
SECURITY_VIOLATION
ADMINISTRATIVE_REVOCATION
```

---

# 28. Revocation Semantics

The contract must explicitly define what happens after revocation.

Possible policy:

```text
REVOCATION_RECEIVED
        │
        ▼
STOP_ACCEPTING_NEW_OPERATIONS
        │
        ▼
PAUSE OR TERMINATE ACTIVE EXECUTION
        │
        ▼
EXECUTION_UNAUTHORIZED
```

The exact behavior depends on the product's safety requirements.

---

# 29. Active Operations

This is an important edge case.

Suppose:

```text
Authorization valid
       │
       ▼
Execution starts
       │
       ▼
Long-running operation
       │
       ▼
License revoked
```

The system must decide whether the operation:

```text
finish
pause
terminate
```

This decision must be centralized.

The Execution Plane should not invent its own licensing policy.

---

# 30. Recommended Model

A clean model is:

```text
New operations
    → immediately denied

Existing operations
    → follow explicit revocation policy
```

For example:

```text
revocation
   │
   ├── reject new commands
   │
   └── gracefully terminate existing runtime
```

This avoids abruptly killing state without a defined lifecycle.

---

# 31. Pause vs Terminate

The Security Authority can issue an operational security decision such as:

```text
ALLOW
RESTRICT
PAUSE
TERMINATE
```

However, the Security Authority should not become responsible for implementing the actual pause/termination mechanism.

It tells the Runtime Manager what security requires.

The Execution Plane performs the operational action.

---

# 32. Security Decision vs Operational Action

This distinction is fundamental.

Security Authority:

```text
TERMINATE_REQUIRED
```

Runtime Manager:

```text
terminateRuntime()
```

Execution Plane:

```text
actually stops execution
```

Each layer retains its responsibility.

---

# 33. Execution Plane Events

The Execution Plane may report:

```text
RuntimeStarted
RuntimeStopped
RuntimePaused
RuntimeResumed
RuntimeCrashed
RuntimeUnhealthy
RuntimeRecovered
```

These are operational events.

They do not alter authorization.

---

# 34. Security Events

The Security Authority emits:

```text
AuthorizationGranted
AuthorizationRenewed
AuthorizationRestricted
AuthorizationRevoked
SecurityEpochChanged
SessionExpired
LicenseExpired
LicenseRevoked
```

These are security events.

---

# 35. Event Direction

```text
Security Authority
        │
        │ Security events
        ▼
Runtime Manager
        │
        │ operational commands
        ▼
Execution Plane
```

Reverse direction:

```text
Execution Plane
        │
        │ operational events
        ▼
Runtime Manager
        │
        ▼
Control Plane
```

The Execution Plane does not declare itself authorized.

---

# 36. Runtime Manager's Role

The Runtime Manager becomes the adapter between:

```text
Security domain
```

and:

```text
Execution domain
```

It translates:

```text
AuthorizationGranted
```

into:

```text
start runtime
```

and:

```text
AuthorizationRevoked
```

into:

```text
stop/pause runtime
```

according to policy.

---

# 37. Contract Interface

A conceptual interface could be:

```text
ExecutionAuthorizationProvider {
    authorize(capability)
    renew(authorization_id)
    revoke(authorization_id)
    getState()
}
```

And the Execution Plane interface:

```text
ExecutionRuntime {
    initialize(authorization)
    shutdown()
    pause()
    resume()
    health()
}
```

These are conceptual contracts, not final APIs.

---

# 38. One-Way Authority Flow

The normal authority flow is:

```text
Backend
   ↓
Security Authority
   ↓
Runtime Manager
   ↓
Execution Plane
```

The Execution Plane cannot promote itself upward:

```text
Execution Plane
   X
   ↓
Security Authority
```

---

# 39. No Shared Security State

The Security Authority and Execution Plane must not share:

```text
global security object
global license state
shared mutable session object
shared SQLite tables
shared cryptographic keys
```

Communication must occur through explicit interfaces.

---

# 40. Why No Shared State?

Shared state creates hidden coupling.

For example:

```text
SecurityAuthority.session.valid = false
```

being observed directly by:

```text
ExecutionPlane.session.valid
```

makes it impossible to know:

- who changed it,
- when it changed,
- whether it is authentic,
- whether it is current,
- whether it belongs to the correct session.

Explicit messages are easier to reason about.

---

# 41. Authorization Token vs Authorization Object

The contract should preferably use a **restricted authorization artifact**, not the Security Authority's internal object.

Bad:

```text
ExecutionPlane.initialize(SecurityContextInternal)
```

Better:

```text
ExecutionPlane.initialize(ExecutionAuthorization)
```

The latter defines exactly what the Execution Plane is allowed to see.

---

# 42. Information Minimization

The Execution Plane should receive the minimum information necessary.

For example:

```text
authorization_id
capabilities
constraints
expiration
epoch
```

It does not need:

```text
user_email
password
license_purchase_history
payment_information
Backend session internals
machine private key
```

---

# 43. Authorization Integrity

The Execution Plane must be able to determine that an authorization artifact came from the trusted Control Plane boundary.

Depending on the IPC architecture, this can be achieved through:

- authenticated local IPC,
- OS process identity,
- protected IPC channel,
- cryptographic message authentication,
- process isolation.

The exact mechanism should be defined by the IPC design.

---

# 44. Local Attacker Consideration

Because the attacker controls the machine, they may attempt:

```text
fake authorization
fake Runtime Manager
fake Security Authority
fake IPC message
```

Therefore the architecture should make unauthorized local messages difficult to inject.

However:

> No purely local mechanism can provide absolute protection against an attacker with complete control of the machine.

The goal is defense in depth.

---

# 45. Execution Plane Compromise

Suppose the Execution Plane itself is modified.

The attacker changes:

```text
if (!authorized) stop()
```

to:

```text
if (!authorized) continue()
```

The Security Authority still considers the authorization invalid.

The Execution Plane may locally continue, but it has not gained legitimate Backend authority.

This is why server-side authorization remains important.

---

# 46. Security Authority Compromise

If the attacker modifies the Security Authority itself:

```text
authorize() → always true
```

the attacker may bypass local enforcement.

Therefore sensitive server-side operations must still depend on authoritative Backend validation where applicable.

This produces defense in depth:

```text
Local Security Authority
        +
Backend authority
```

rather than relying exclusively on one local Boolean.

---

# 47. Execution Plane Should Not Store Authorization Indefinitely

Authorization artifacts should have bounded lifetimes.

When an authorization expires:

```text
Execution Plane
       │
       ▼
authorization expired
       │
       ▼
request renewal
       │
       ▼
Security Authority
```

The Execution Plane should not simply preserve an old authorization indefinitely.

---

# 48. Authorization Loss

Authorization can disappear because of:

```text
session expiration
license expiration
license revocation
account revocation
machine revocation
security-state corruption
tamper detection
Backend policy change
protocol failure
```

The Runtime Manager must normalize these into an operational response.

---

# 49. Recommended Operational States

The Runtime Manager can map security into:

```text
SECURITY_UNAUTHORIZED
SECURITY_AUTHORIZING
SECURITY_AUTHORIZED
SECURITY_DEGRADED
SECURITY_REVOKED
SECURITY_EXPIRED
SECURITY_FAILURE
```

The Execution Plane itself does not need to understand all of these.

---

# 50. Startup Failure

If authorization cannot be established:

```text
Application
   │
   ▼
Security Authority
   │
   X authorization
   │
   ▼
Runtime Manager
   │
   ▼
Execution Plane NOT STARTED
```

This prevents unauthorized runtime initialization.

---

# 51. Runtime Already Running

If authorization disappears after startup:

```text
Execution Plane
       │
       │ running
       ▼
Security Authority
       │
       │ authorization revoked
       ▼
Runtime Manager
       │
       ▼
Execution Plane restricted
```

The exact shutdown behavior follows the active-operation policy.

---

# 52. Security Authority Unavailable

If the Security Authority itself crashes:

```text
Security Authority
       X
```

the Runtime Manager must not interpret absence of the authority as:

```text
authorization = true
```

The safe default is:

```text
unknown
```

and then apply the defined failure policy.

---

# 53. Fail-Closed vs Fail-Open

For authorization-sensitive operations:

```text
unknown authorization
```

should generally not become:

```text
authorized
```

This is the core fail-closed principle.

However, existing long-running operations may have a defined grace policy.

That is a product decision, not an accidental consequence.

---

# 54. Communication Failure

If:

```text
Runtime Manager
      │
      X
      │
Execution Plane
```

communication fails, the Runtime Manager must distinguish:

```text
Execution Plane crashed
```

from:

```text
Security authorization lost
```

These are operationally different failures.

---

# 55. Protocol Version Compatibility

The authorization contract must have a version.

Example:

```text
authorization_contract_version = 1
```

The Runtime Manager and Execution Plane negotiate supported versions.

If incompatible:

```text
EXECUTION_PROTOCOL_INCOMPATIBLE
```

The runtime must not start under an unknown authorization contract.

---

# 56. Capability Versioning

Capabilities should also be versionable.

For example:

```text
EXECUTION_START:v1
```

allows future semantic changes without silently changing the meaning of an existing capability.

---

# 57. No Licensing Logic in Execution Plane

Avoid code such as:

```text
if (license.type === "premium") {
   ...
}
```

inside the Execution Plane.

Instead:

```text
if (authorization.capabilities.has(EXECUTION_START)) {
   ...
}
```

The Execution Plane should not care **why** the capability exists.

---

# 58. No Authentication Logic in Execution Plane

The Execution Plane should never implement:

```text
login()
password verification
session renewal
credential storage
machine registration
```

Those belong to the Security Authority.

---

# 59. No Backend Protocol in Execution Plane

The Execution Plane should not import:

```text
BackendClient
AuthClient
LicenseClient
```

Its only external security dependency should be the authorization contract.

---

# 60. Security Boundary Summary

```text
                   SECURITY DOMAIN
────────────────────────────────────────────

Backend
   │
   ▼
Security Authority
   │
   ▼
Authorization Contract

────────────────────────────────────────────
                   OPERATION DOMAIN

Runtime Manager
   │
   ▼
Execution Plane
```

The boundary is intentional.

---

# 61. Contract Invariants

### Invariant 1

The Execution Plane cannot authenticate users.

### Invariant 2

The Execution Plane cannot grant itself capabilities.

### Invariant 3

The Execution Plane cannot modify Security Authority state.

### Invariant 4

The Execution Plane cannot extend its own authorization lifetime.

### Invariant 5

Expired authorization cannot silently become valid.

### Invariant 6

Revoked authorization cannot silently become valid.

### Invariant 7

Old authorization cannot overwrite newer authorization.

### Invariant 8

The Execution Plane receives no unnecessary credentials.

### Invariant 9

Backend communication remains outside the Execution Plane.

### Invariant 10

Execution operational state cannot override security state.

---

# 62. Minimal Contract

At the architectural level, the contract can ultimately be reduced to:

```text
Security Authority
        │
        │
        ├── authorize(capability)
        │
        ├── renew(authorization)
        │
        ├── revoke(authorization)
        │
        └── security events
                │
                ▼
          Runtime Manager
                │
                │
                ├── initialize(authorization)
                ├── shutdown()
                ├── pause()
                └── resume()
                │
                ▼
          Execution Plane
```

Everything else is implementation detail.

---

# 63. Final Mental Model

The cleanest mental model is:

```text
                 BACKEND
                    │
              "Who may act?"
                    │
                    ▼
           SECURITY AUTHORITY
                    │
              "May execution
               act now?"
                    │
                    ▼
            RUNTIME MANAGER
                    │
              "Perform this
               operational action."
                    │
                    ▼
            EXECUTION PLANE
                    │
              "How do I
               execute it?"
```

The separation is therefore:

**Backend**

> **Authority**

**Security Authority**

> **Local security decision**

**Runtime Manager**

> **Security-to-runtime adapter**

**Execution Plane**

> **Operational execution**

And most importantly:

> **The Execution Plane never needs to know why it is authorized. It only needs to know what it is authorized to do, under what constraints, and until when.**

That keeps the Execution Plane genuinely independent while making the Security Authority the single local source of security decisions.

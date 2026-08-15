# Security Authority ↔ Backend Trust Model

**Document:** `security_authority_backend_trust_model.md`
**Status:** Design Specification
**Scope:** Control Plane Security Authority ↔ Backend
**Purpose:** Define exactly what the Security Authority trusts, what it does not trust, how trust is established, maintained, invalidated, and recovered.

---

# 1. Purpose

The Security Authority sits between the local application and the remote Backend.

This creates an unusual trust relationship.

The local machine is controlled by the user, while the Backend is controlled by the service operator.

Therefore the architecture cannot simply assume:

```text
Local application = trusted
Backend = trusted
```

Instead, trust must be **explicit, limited, and continuously validated**.

The purpose of this document is to define:

- trust boundaries,
- trust anchors,
- identity relationships,
- cryptographic trust,
- session trust,
- machine trust,
- authorization trust,
- licensing trust,
- message trust,
- local-state trust,
- revocation,
- tamper detection,
- recovery,
- failure behavior.

---

# 2. Core Principle

The most important principle is:

> **The Backend is the authority for remote security state; the Security Authority is the authority for local enforcement of that state.**

The Backend decides:

```text
Who is the user?
Is the account valid?
Is the machine registered?
Is the machine revoked?
Is the license valid?
What capabilities are authorized?
Is the session still valid?
```

The Security Authority decides:

```text
Can the local application currently operate?
Which local capabilities are enabled?
Which requests are permitted?
What happens when authority becomes invalid?
```

The Security Authority does **not** replace the Backend.

The Backend does **not** directly control local application internals.

---

# 3. Trust Architecture

```text
                         ┌──────────────────────┐
                         │       BACKEND        │
                         │                      │
                         │ Identity Authority   │
                         │ Machine Authority    │
                         │ License Authority    │
                         │ Authorization        │
                         │ Revocation           │
                         └──────────┬───────────┘
                                    │
                         Authenticated Channel
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ SECURITY AUTHORITY   │
                         │                      │
                         │ Trust Evaluation     │
                         │ Session Authority    │
                         │ Local Enforcement    │
                         │ Integrity            │
                         └──────────┬───────────┘
                                    │
                              Security Context
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
               Runtime         File Service      API Server
                    │
                    ▼
             Execution Plane
```

The Backend and Security Authority form a **trust relationship**.

Everything below the Security Authority consumes the resulting local security decisions.

---

# 4. Trust Is Not Binary

The system should not model trust simply as:

```text
trusted
untrusted
```

Instead, trust has dimensions.

```text
Identity Trust
Channel Trust
Message Trust
Session Trust
Machine Trust
Authorization Trust
License Trust
Local State Trust
Protocol Trust
```

A system may be trusted in one dimension and untrusted in another.

For example:

```text
User authenticated
+
Machine valid
+
License expired
```

produces:

```text
Identity Trust       = valid
Machine Trust        = valid
Session Trust        = valid
License Trust        = invalid
```

Therefore the application cannot simply use:

```text
is_authenticated === true
```

as its security decision.

---

# 5. Trust Domains

There are three important trust domains.

## Domain A — Backend

```text
Remote authority
```

Controls authoritative account and licensing state.

---

## Domain B — Control Plane

```text
Local enforcement authority
```

Responsible for applying Backend decisions locally.

---

## Domain C — Local Environment

Includes:

```text
Frontend
Filesystem
SQLite
Configuration
Other local processes
Execution Plane
Operating system
```

This domain must be treated as potentially compromised.

---

# 6. Trust Boundary

The most important trust boundary is:

```text
              TRUST BOUNDARY
                    │
                    ▼
Backend ◄────────────────────► Security Authority
                                      │
                                      │
                                      ▼
                              Local Application
```

The Backend should never assume that anything inside the local application is inherently trustworthy.

Likewise, the Security Authority must not blindly trust arbitrary Backend responses without authenticating and validating them.

---

# 7. Backend Trust

The Security Authority must establish that it is communicating with the legitimate Backend.

This requires server authentication.

The underlying transport should normally use a mature protocol such as TLS rather than a custom encryption mechanism.

Conceptually:

```text
Control Plane
      │
      │ "Prove you are the legitimate Backend."
      ▼
Backend
      │
      │ authenticated server identity
      ▼
Secure Channel
```

---

# 8. Server Identity

The Security Authority must have a mechanism for establishing Backend identity.

Potential trust anchors include:

- operating-system trust store,
- pinned public keys,
- pinned certificates,
- application-distributed trust roots,
- another formally designed trust mechanism.

The choice depends on deployment requirements.

The important invariant is:

> An attacker controlling the network must not be able to impersonate the Backend.

---

# 9. Why Encryption Alone Is Insufficient

Suppose an attacker intercepts:

```text
Control Plane
      │
      ▼
Attacker
      │
      ▼
Fake Backend
```

If the protocol merely encrypts data without authenticating the remote endpoint, encryption does not solve the problem.

The Control Plane needs:

```text
Confidentiality
+
Integrity
+
Server Authentication
```

not encryption alone.

---

# 10. Backend as Authority

The Backend is authoritative for:

### Identity

```text
user_id
account_status
credential_validity
```

### Machine

```text
machine_id
machine_status
registration
revocation
```

### Licensing

```text
license_id
license_status
expiration
entitlements
```

### Authorization

```text
capabilities
limits
permissions
```

### Revocation

```text
session_revocation
machine_revocation
license_revocation
account_revocation
```

---

# 11. What the Backend Does Not Control

The Backend should not directly control:

```text
Playwright
browser lifecycle internals
DOM state
locator resolution
local process internals
local UI rendering
local filesystem implementation
Execution Plane synchronization
```

The Backend communicates authority.

The Control Plane applies that authority.

---

# 12. Control Plane Trust

The Backend must also treat the Control Plane as potentially compromised.

This is an important consequence of the threat model.

An attacker has access to the application binary.

Therefore:

```text
Backend
   │
   │
   ▼
Potentially compromised client
```

The Backend cannot assume that:

```text
client says license = valid
```

means:

```text
license = valid
```

The Backend must maintain authoritative licensing state independently.

---

# 13. Why Client-Side License Enforcement Is Not a Trust Anchor

A local attacker may attempt to modify:

```text
license_valid = true
```

or:

```text
authorization = premium
```

Therefore local authorization state is an **enforcement mechanism**, not the ultimate authority.

This distinction is fundamental.

---

# 14. Machine Trust

The Backend maintains a relationship with a machine.

Conceptually:

```text
User
  │
  ▼
Machine Registration
  │
  ▼
Machine Identity
  │
  ▼
Machine Authorization
```

The Security Authority must prove possession of the machine identity's appropriate cryptographic material where the design requires it.

---

# 15. Machine Identity Binding

A machine registration can conceptually contain:

```text
machine_id
user_id
installation_id
public_key
registration_state
created_at
last_seen
revocation_state
```

The private key remains local.

The Backend knows the corresponding public identity.

---

# 16. Why Machine Identity Matters

Without machine identity, an attacker could potentially:

```text
copy installation
        ↓
copy local security state
        ↓
run application elsewhere
```

Machine-bound credentials make this substantially harder.

They do not make copying impossible.

---

# 17. Installation Identity

Machine identity and installation identity should remain distinct.

For example:

```text
Machine
  └── Installation A
```

After reinstall:

```text
Machine
  └── Installation B
```

The Backend can decide whether:

```text
Installation B
```

may inherit the machine's authorization.

That decision should not be invented locally.

---

# 18. Session Trust

After authentication, the Backend establishes a session.

Conceptually:

```text
Backend
   │
   │ authenticated identity
   ▼
Session
   │
   ├── session_id
   ├── expiration
   ├── security epoch
   └── authorization context
```

The Security Authority trusts the session only while the session remains valid.

---

# 19. Session Trust Is Temporary

A successful login does not establish permanent trust.

Instead:

```text
Trust established
      │
      ▼
Time passes
      │
      ▼
Trust must be renewed/revalidated
```

This limits the consequences of:

- stolen credentials,
- stolen session material,
- stale authorization,
- revoked licenses.

---

# 20. Session Binding

The session should be bound to the appropriate security context.

Conceptually:

```text
session
 ├── user
 ├── machine
 ├── installation
 ├── protocol
 └── security epoch
```

A response belonging to:

```text
session A
```

must never modify:

```text
session B
```

---

# 21. Authorization Trust

The Security Authority trusts authorization information only when it originates from an authenticated Backend security context.

Example:

```text
Backend
    │
    │ authorization = CAP_X
    ▼
Security Authority
    │
    ▼
Local capability
```

Not:

```text
Frontend
    │
    │ "give me CAP_X"
    ▼
Security Authority
```

---

# 22. Capability Authority

The Backend may provide capabilities such as:

```text
CAP_RUNTIME_START
CAP_RUNTIME_STOP
CAP_FILE_UPLOAD
CAP_FILE_DOWNLOAD
CAP_BROWSER_ALLOCATION
```

The Security Authority converts these into local authorization decisions.

This allows the Backend's policy to evolve without requiring every local subsystem to understand licensing rules.

---

# 23. License Trust

The Security Authority should treat license information as **server-authoritative state**.

A locally cached license can be used only according to the defined offline policy.

Example:

```text
Backend says:
license expires = 2026-09-01
```

The local machine must not simply change:

```text
2026-09-01
```

to:

```text
2030-01-01
```

and treat the modified value as authoritative.

---

# 24. License Entitlements

License state should be represented as explicit entitlements.

Example:

```text
License {
    status
    expires_at
    entitlements
}
```

Rather than allowing feature code to interpret arbitrary license strings.

---

# 25. Revocation Trust

Revocation is authoritative.

If the Backend states:

```text
machine revoked
```

the local Security Authority must transition into the appropriate restricted state.

Local cached state must not override revocation.

---

# 26. Backend Unavailability

Backend unavailability does **not automatically mean**:

```text
license invalid
```

Nor does it automatically mean:

```text
license valid
```

It means:

```text
authority currently unreachable
```

The Security Authority therefore needs a separate condition:

```text
AUTHORITY_UNAVAILABLE
```

---

# 27. Offline Trust

Offline operation must be explicitly defined.

For example:

```text
ACTIVE
  │
  │ Backend unavailable
  ▼
DEGRADED
```

The system may continue only with capabilities permitted by the offline policy.

For a highly subscription-dependent product, the policy may be:

```text
No fresh authorization
+
short grace period
+
eventual fail-closed
```

The exact policy belongs to the product requirements.

---

# 28. Cached Authority

The Security Authority may cache:

```text
last known authorization
last known license
session metadata
server information
```

But cached state must carry metadata such as:

```text
issued_at
expires_at
security_epoch
source
```

The cache is therefore:

> **a temporary representation of authority, not authority itself.**

---

# 29. Local State Trust

The Security Authority must distinguish between:

```text
Backend-derived state
```

and:

```text
locally generated state
```

Example:

```text
Backend-derived:
license entitlement

Local:
transfer progress
```

A local process may modify transfer progress.

It must not be able to modify authoritative license state and have the Security Authority blindly accept it.

---

# 30. Tamper Resistance

The trust model assumes the attacker can potentially modify the local application.

Therefore tamper resistance is not intended to establish absolute security.

Its purpose is to increase the cost of modifying the enforcement path.

Examples include:

- native components,
- Rust components,
- integrity verification,
- obfuscation where appropriate,
- separated security-critical components,
- minimized sensitive logic in easily modified layers,
- protected cryptographic keys,
- anti-rollback mechanisms.

---

# 31. Important Limitation

Because the attacker controls the machine:

> **The local application cannot create an absolute trust boundary against its owner.**

A sufficiently capable attacker can eventually:

- debug the process,
- patch code,
- instrument functions,
- alter execution,
- replace binaries,
- emulate the protocol.

Therefore the architecture aims for:

```text
increase attack cost
+
reduce trivial bypasses
+
move authority server-side
+
detect suspicious state
+
limit credential exposure
```

rather than:

```text
make bypass mathematically impossible
```

---

# 32. Security Authority as Enforcement Boundary

The Security Authority is the local point where:

```text
Backend authority
        ↓
local security decision
        ↓
application capability
```

comes together.

It should therefore be difficult to bypass architecturally.

For example:

```text
Frontend
   │
   ▼
Control API
   │
   ▼
Security Authority
   │
   ▼
Capability Check
   │
   ▼
Runtime Manager
```

not:

```text
Frontend
   │
   ├──────────────► Runtime Manager
   │
   └──────────────► Security Authority
```

The second architecture creates an obvious bypass path.

---

# 33. Execution Plane Trust

The Execution Plane should not become a second independent licensing authority.

Instead:

```text
Security Authority
       │
       │ authorized runtime command
       ▼
Execution Plane
```

The Execution Plane receives only what it needs.

It should not receive:

- user passwords,
- refresh credentials,
- unnecessary license secrets,
- private machine keys.

---

# 34. Security Context Propagation

The Control Plane may propagate a restricted context:

```text
ExecutionAuthorization {
    authorization_id
    capability
    session_epoch
    expiration
}
```

The exact mechanism is implementation-specific.

The important principle is:

> **Propagate authorization, not identity secrets.**

---

# 35. Backend ↔ Security Authority Protocol Trust

Every protocol message should be evaluated according to:

```text
Who sent it?
Is the channel authenticated?
Is the message authentic?
Is it fresh?
Does it belong to the current session?
Does it belong to the current machine?
Does it belong to the current security epoch?
Is it structurally valid?
Is it semantically valid?
```

Only after all relevant checks pass should the message affect security state.

---

# 36. Trust Evaluation Pipeline

Conceptually:

```text
Incoming Message
       │
       ▼
Transport Validation
       │
       ▼
Server Authentication
       │
       ▼
Message Integrity
       │
       ▼
Protocol Version
       │
       ▼
Session Binding
       │
       ▼
Machine Binding
       │
       ▼
Security Epoch
       │
       ▼
Freshness / Replay
       │
       ▼
Semantic Validation
       │
       ▼
Security State Mutation
```

This ordering is important.

---

# 37. Trust Failure

A failed trust check must not simply return:

```text
false
```

without context.

The Security Authority should classify the failure.

For example:

```text
SERVER_AUTHENTICATION_FAILED
MESSAGE_INTEGRITY_FAILED
SESSION_MISMATCH
MACHINE_MISMATCH
STALE_EPOCH
REPLAY_DETECTED
PROTOCOL_VIOLATION
AUTHORITY_UNAVAILABLE
```

This allows the system to respond appropriately.

---

# 38. Security State Mutation

Only validated authority may mutate Security Authority state.

For example:

```text
Backend:
license revoked
```

passes:

```text
transport
→ authentication
→ integrity
→ session
→ epoch
→ semantics
```

Then:

```text
LicenseState = REVOKED
```

is committed.

---

# 39. Atomic Security Transitions

Security-state transitions should be atomic from the perspective of consumers.

Avoid:

```text
license = valid
session = expired
authorization = old
```

being observable as an inconsistent combination.

Instead, update the security context as one logical transaction.

---

# 40. Security Epoch as Trust Boundary

Suppose:

```text
Session A
epoch = 10
```

Then the Backend revokes the session.

New state:

```text
epoch = 11
```

Any delayed message from epoch 10 becomes stale.

This provides a clean mechanism for invalidating old protocol state.

---

# 41. Trust During Reauthentication

During reauthentication:

```text
OLD SESSION
    │
    ▼
REAUTHENTICATING
    │
    ├── success → NEW SESSION
    │
    └── failure → RESTRICTED
```

The old session must not remain indefinitely valid while authentication is being replaced.

The exact overlap policy must be explicit.

---

# 42. Trust During Logout

Logout immediately invalidates local authorization.

```text
ACTIVE
  │
  │ logout
  ▼
LOCAL_AUTHORIZATION_INVALID
```

Backend confirmation is useful but should not be required before the local application stops treating the session as active.

---

# 43. Trust During Process Crash

A process crash does not prove that the previous security state is still valid.

On restart:

```text
load state
   ↓
verify integrity
   ↓
verify freshness
   ↓
revalidate authority
```

Only then should normal operation resume.

---

# 44. Trust During Filesystem Restoration

If an attacker restores an older snapshot:

```text
Current State
     ↓
Filesystem Snapshot
     ↓
Old Security State
```

the Security Authority must detect rollback where possible.

Possible indicators:

```text
security epoch
installation identity
server-issued state
monotonic metadata
```

---

# 45. Trust During Machine Cloning

A cloned machine may contain:

```text
machine identity
installation identity
cached license
session state
```

The Backend should be able to detect unexpected duplication.

The local Security Authority must not assume:

```text
copied private key = legitimate new machine
```

---

# 46. Trust During Network Change

Network changes can invalidate assumptions about the transport.

Examples:

```text
Wi-Fi → Ethernet
Ethernet → VPN
VPN → mobile hotspot
DNS change
IP change
```

The Security Authority should allow the secure transport layer to re-establish itself without automatically trusting an old connection indefinitely.

---

# 47. Trust During Certificate Rotation

Server certificates change normally.

The trust model must support legitimate rotation without creating an opportunity for impersonation.

Therefore certificate rotation must be governed by the configured trust anchor rather than by blindly accepting:

```text
"new certificate"
```

from the network.

---

# 48. Trust During Protocol Upgrade

Suppose:

```text
Client = v4
Server = v5
```

The protocol negotiates a mutually supported version.

If no secure compatible version exists:

```text
PROTOCOL_INCOMPATIBLE
```

The application must fail safely.

It must not silently downgrade to an insecure protocol.

---

# 49. Trust Hierarchy

The overall hierarchy is:

```text
                  BACKEND AUTHORITY
                         │
              ┌──────────┴──────────┐
              │                     │
       Identity Authority     License Authority
              │                     │
              └──────────┬──────────┘
                         │
                  Security Protocol
                         │
                         ▼
                 SECURITY AUTHORITY
                         │
                 Security Context
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
     Runtime          Files            API
        │
        ▼
 Execution Plane
```

The higher layer establishes authority.

The lower layer enforces it.

---

# 50. Trust Invariants

The following invariants should be treated as architectural requirements.

### Trust Invariant 1

The Backend is authoritative for account, machine, authorization, and license state.

### Trust Invariant 2

The local filesystem is not authoritative for security state.

### Trust Invariant 3

The frontend is not authoritative for security state.

### Trust Invariant 4

The Execution Plane is not authoritative for licensing.

### Trust Invariant 5

An authenticated user is not automatically authorized.

### Trust Invariant 6

An authorized user is not automatically licensed for every operation.

### Trust Invariant 7

A valid license does not imply a valid session.

### Trust Invariant 8

A valid session does not survive explicit revocation.

### Trust Invariant 9

An old protocol message cannot overwrite newer security state.

### Trust Invariant 10

Backend unavailability is not equivalent to either authorization or revocation.

### Trust Invariant 11

Local tampering cannot be allowed to silently become authoritative security state.

### Trust Invariant 12

No component receives more security authority than it requires.

---

# 51. What Happens If the Security Authority Itself Is Compromised?

This is the hardest case.

An attacker controlling the local machine may attempt to bypass:

```text
Security Authority
```

entirely.

The architecture therefore relies on **defense in depth**.

### Layer 1 — Server Authority

The Backend maintains authoritative state.

### Layer 2 — Protocol Authentication

The attacker cannot trivially impersonate the Backend.

### Layer 3 — Local Enforcement

The Security Authority enforces Backend decisions.

### Layer 4 — Tamper Resistance

Security-critical implementation can be placed in harder-to-modify components.

### Layer 5 — Server-Side Verification

Sensitive server operations can require valid server-side state rather than trusting client claims.

---

# 52. What This Architecture Is Actually Protecting

The goal is not:

> "Make the Control Plane impossible to reverse engineer."

The goal is:

> **Make modification of the local security enforcement path insufficiently easy to turn the application into an unauthorized client of the Backend.**

That distinction is extremely important.

---

# 53. Example Attack

An attacker modifies:

```text
if (!licenseValid) {
    deny();
}
```

into:

```text
if (!licenseValid) {
    allow();
}
```

If the only enforcement exists locally, the attacker wins.

A stronger architecture has:

```text
Local Security Authority
       │
       ▼
Authorized session
       │
       ▼
Backend
       │
       ▼
Server-side authorization
```

The attacker may patch local behavior, but they cannot manufacture legitimate Backend authority merely by changing a Boolean.

---

# 54. Stronger Example

Suppose the attacker attempts:

```text
licenseValid = true
```

The application may proceed locally.

But when it attempts a server-authorized operation:

```text
Control Plane
      │
      ▼
Backend
      │
      ├── valid session?
      ├── valid machine?
      ├── valid license?
      └── authorized capability?
```

If the Backend says:

```text
NO
```

the operation fails.

This moves the true authority to the server.

---

# 55. Architectural Consequence

This means the subscription system should not be designed as:

```text
Backend
   ↓
download license
   ↓
save license locally
   ↓
check local license forever
```

It should instead resemble:

```text
Backend Authority
       ↓
Authenticated Session
       ↓
Short-lived / renewable authority
       ↓
Local enforcement
       ↓
Periodic revalidation
       ↓
Backend remains authoritative
```

---

# 56. Trust Model Summary

The trust model can ultimately be reduced to:

```text
                  WHO ARE YOU?
                       │
                 Authentication
                       │
                       ▼
                 CAN YOU ACT?
                       │
                 Authorization
                       │
                       ▼
                 WHAT CAN YOU DO?
                       │
                  Capabilities
                       │
                       ▼
                 ARE YOU LICENSED?
                       │
                   Licensing
                       │
                       ▼
                 IS TRUST CURRENT?
                       │
              Session / Renewal
                       │
                       ▼
                 IS STATE INTACT?
                       │
             Integrity / Tampering
                       │
                       ▼
                 LOCAL DECISION
                       │
                       ▼
                  APPLICATION
```

---

# 57. Final Architectural Rule

The most important rule for the entire Security Authority is:

> **Never allow a locally mutable value to become the ultimate source of authorization truth.**

The local application exists to **enforce** authority.

The Backend exists to **establish and maintain** authority.

The protocol exists to make the relationship between them:

```text
authenticated
+
confidential
+
integrity-protected
+
fresh
+
session-bound
+
machine-aware
+
revocable
+
versioned
+
tamper-resistant
```

while remaining explicit about the fundamental limitation:

> **The local machine belongs to the attacker as far as the threat model is concerned, so the architecture must assume that local enforcement can eventually be modified. The security design therefore makes the Backend the ultimate authority and makes bypassing the local enforcement path insufficient for obtaining legitimate server-side authority.**

This is the trust model on which the rest of the Security Authority architecture should be built.

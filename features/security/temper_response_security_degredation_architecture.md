# Security Authority — Tamper Response & Security Degradation Architecture

**Document Status:** Design Specification
**System:** Control Plane
**Subsystem:** Security Authority
**Previous Document:** `tamper_detection_application_integrity_architecture.md`
**Scope:** Detection response, containment, degradation, recovery, and enforcement after suspected or confirmed tampering

---

## 1. Purpose

The previous document defines **how the Control Plane detects tampering and application-integrity violations**.

This document defines what happens **after detection**.

Detection alone is insufficient.

The Security Authority must answer:

- What happens when integrity verification fails?
- What happens when only one component is suspicious?
- What happens when local security state is modified?
- What happens when the application binary is replaced?
- What happens when the machine identity changes?
- What happens when the attacker attempts to suppress or disable security components?
- When should the application terminate?
- When can the application continue in degraded mode?
- When can security state be recovered?
- When must the Backend be consulted?
- What happens to an already-running Execution Plane?
- What happens to active operations?
- How are repeated tampering events handled?
- How do we prevent recovery mechanisms themselves from becoming bypass points?

The central principle is:

> **Tamper detection produces evidence; the Security Authority converts that evidence into an authoritative security state and enforcement decision.**

---

# 2. Core Principle

The Security Authority must not treat every anomaly as equivalent.

There is a fundamental distinction between:

```text
Unexpected condition
        ↓
Suspicious condition
        ↓
Integrity violation
        ↓
Confirmed tampering
        ↓
Security compromise
```

These states require different responses.

For example:

A missing optional cache file should not terminate the application.

A modified configuration file may require revalidation.

A modified Security Authority binary may require immediate termination.

Therefore:

> **Tamper response is risk-based, stateful, and policy-driven.**

---

# 3. Security Authority Position

The Security Authority sits above the operational subsystems.

```text
                 Backend
                    │
                    │
             Secure Protocol
                    │
                    ▼
        ┌────────────────────────┐
        │    Security Authority  │
        │                        │
        │ Authentication         │
        │ Authorization          │
        │ Licensing              │
        │ Integrity              │
        │ Tamper Response        │
        │ Security State         │
        └───────────┬────────────┘
                    │
              Authorization
                 Contract
                    │
                    ▼
          ┌──────────────────┐
          │ Execution Plane  │
          └──────────────────┘
```

Other Control Plane components consume security decisions.

They do not independently determine whether the application is authorized to operate.

---

# 4. Security Authority as the Enforcement Authority

The Security Authority is authoritative for:

- authentication state
- authorization state
- license state
- machine identity state
- security-session state
- application-integrity state
- tamper state
- security degradation state
- operational authorization

Other subsystems may report events.

They may not override Security Authority decisions.

For example:

```text
Runtime Manager
      │
      │ "Execution Plane is healthy"
      ▼
Security Authority
      │
      │ DENY
      ▼
Execution Plane must not continue
```

Runtime health does not imply authorization.

---

# 5. Tamper Classification

Tampering should be classified into levels.

## Level 0 — No Security Concern

Examples:

- ordinary application error
- missing cache
- network failure
- temporary backend outage
- corrupted non-security temporary file

Response:

```text
Continue normally
```

---

# 6. Level 1 — Security Anomaly

Examples:

- unexpected security-state value
- invalid metadata
- unusual timestamp
- malformed local security record
- unexpected configuration change

Response:

```text
Record event
↓
Revalidate
↓
Attempt recovery
```

The application may continue if the security state can be established as trustworthy.

---

# 7. Level 2 — Suspicious Integrity Violation

Examples:

- unexpected modification to protected configuration
- security database mismatch
- unexpected machine identity change
- invalid integrity metadata
- executable modification where verification is possible

Response:

```text
Suspend sensitive operations
↓
Invalidate local authorization
↓
Perform integrity verification
↓
Contact Backend where possible
↓
Determine trust state
```

The application should not simply continue using the previous authorization decision.

---

# 8. Level 3 — Confirmed Tampering

Examples:

- protected executable modified
- Security Authority code modified
- security enforcement mechanism disabled
- protected security state intentionally altered
- cryptographic verification failure
- integrity metadata deliberately invalidated

Response:

```text
Invalidate authorization
↓
Stop authorization-dependent operations
↓
Terminate or isolate Execution Plane
↓
Persist security incident
↓
Require trusted recovery
```

---

# 9. Level 4 — Security Authority Compromise

This is the most severe condition.

Examples:

- Security Authority itself cannot establish its integrity
- cryptographic verification mechanism has been compromised
- trusted security metadata has been replaced
- protected keys are compromised
- attacker can modify authorization decisions
- security enforcement can be bypassed locally

At this point:

> **The Control Plane cannot safely trust its own security decisions.**

The correct response is not to attempt increasingly complicated local recovery.

The application should enter:

```text
COMPROMISED
```

and refuse authorization-dependent operation.

---

# 10. Security State Hierarchy

Tamper response interacts with the broader Security Authority state machine.

A simplified model is:

```text
INITIALIZING
     │
     ▼
VERIFYING
     │
     ▼
AUTHENTICATING
     │
     ▼
AUTHORIZED
     │
     ├───────────────┐
     │               │
     ▼               ▼
DEGRADED        TAMPER_SUSPECTED
                     │
                     ▼
              INTEGRITY_CHECK
                │         │
             PASS        FAIL
                │         │
                ▼         ▼
             RECOVER   COMPROMISED
                           │
                           ▼
                       TERMINATED
```

---

# 11. Security Degradation

The Security Authority should support controlled degradation.

However:

> **Degraded mode must never become an authorization bypass.**

This is extremely important.

For example:

```text
Backend unavailable
```

does not automatically mean:

```text
User remains authorized forever
```

Instead:

```text
Previously trusted state
        ↓
Offline grace policy
        ↓
Restricted operation
```

The exact allowed behavior is determined by policy.

---

# 12. Degraded Modes

Recommended modes:

### NORMAL

All security dependencies available.

```text
Authentication: valid
Authorization: valid
License: valid
Integrity: valid
Backend: available
```

Full operation is permitted.

---

### OFFLINE_GRACE

Backend temporarily unavailable but previous authorization remains within an explicitly defined validity window.

```text
Backend unavailable
+
Previously valid authorization
+
Integrity trusted
+
Offline policy permits operation
```

Only operations explicitly permitted by policy may continue.

---

### REAUTHENTICATION_REQUIRED

The current security session is no longer sufficient.

Examples:

- session expired
- session renewal failed
- security state became stale
- machine identity changed

No authorization-dependent operation should begin until reauthentication succeeds.

---

### INTEGRITY_DEGRADED

A security anomaly exists but compromise has not been established.

Sensitive operations should be suspended.

---

### TAMPER_SUSPECTED

A meaningful integrity violation has been detected.

Execution should normally be frozen while verification occurs.

---

### COMPROMISED

The Security Authority can no longer establish trustworthy enforcement.

Authorization-dependent execution is prohibited.

---

# 13. Execution Plane Response

The Execution Plane must never determine whether tampering occurred.

The Security Authority communicates an authorization decision.

For example:

```text
Security Authority
        │
        │ REVOKE_EXECUTION_AUTHORIZATION
        ▼
Execution Plane
```

The Execution Plane then performs its own shutdown behavior.

The Control Plane does not need to know how the Execution Plane internally shuts down.

This preserves the architectural boundary.

---

# 14. Active Operations During Tampering

A critical case:

```text
User is authorized
Execution Plane is running
Operation is active
Tampering detected
```

The system must not assume that the existing authorization remains valid.

The Security Authority should transition:

```text
AUTHORIZED
     ↓
TAMPER_SUSPECTED
```

and revoke authorization for continued execution according to severity.

For confirmed compromise:

```text
TAMPER_SUSPECTED
        ↓
COMPROMISED
        ↓
EXECUTION AUTHORIZATION REVOKED
```

---

# 15. Pending Operations

Operations that have been accepted before the tamper event but have not yet completed must be classified.

Possible policies:

### Safe-to-complete

Only applicable to explicitly defined operations that do not depend on continued authorization.

### Suspend

The operation is paused pending security resolution.

### Cancel

The operation is discarded.

### Deny

The operation must never execute.

The Security Authority must not allow an operation merely because it entered the system before the tamper event.

---

# 16. Tamper Event Ordering

Security events must have an ordering mechanism.

Example:

```text
Authorization granted
Security generation = 41

Operation A
Security generation = 41

Tamper detected
Security generation = 42

Operation B
Security generation = 42
```

Any operation carrying generation `41` after the transition may be rejected.

This prevents stale authorization decisions from surviving security transitions.

---

# 17. Security Epoch

A useful mechanism is a monotonically increasing **Security Epoch**.

Example:

```text
Epoch 100
    ↓
Tamper detected
    ↓
Epoch 101
```

Every authorization-dependent capability references an epoch.

For example:

```text
authorization_epoch = 100
```

After security state changes:

```text
current_epoch = 101
```

The old authorization is therefore invalid.

This provides a clean mechanism for invalidating:

- cached authorization
- pending commands
- stale sessions
- stale Execution Plane authorization
- stale API requests

---

# 18. Why Epochs Matter

Without epochs, a race could occur:

```text
Request A:
"execute operation"

Security Authority:
authorized = true

Tamper detected

Security Authority:
authorized = false

Request A:
still executes
```

With epochs:

```text
Request A:
epoch = 100

Tamper event:
epoch = 101

Request A:
epoch 100 != current epoch 101

DENY
```

This is a powerful enforcement primitive.

---

# 19. Tamper Response Pipeline

The complete pipeline should be:

```text
Integrity Monitor
        │
        ▼
Tamper Event
        │
        ▼
Evidence Normalization
        │
        ▼
Severity Classification
        │
        ▼
Security Authority
        │
        ├── Update security state
        │
        ├── Increment security epoch
        │
        ├── Invalidate affected credentials
        │
        ├── Revoke authorization
        │
        ├── Notify Runtime Manager
        │
        ├── Notify telemetry
        │
        └── Persist security event
        │
        ▼
Enforcement
```

---

# 20. Evidence vs Decision

The integrity subsystem should report **evidence**, not conclusions.

For example:

```text
{
    type: "INTEGRITY_MISMATCH",
    component: "security_authority",
    expected: "...",
    observed: "...",
    timestamp: "...",
    evidence_id: "..."
}
```

It should not directly execute:

```text
shutdown()
```

Instead:

```text
Integrity Monitor
        ↓
Evidence
        ↓
Security Authority
        ↓
Policy Evaluation
        ↓
Decision
```

This keeps security policy centralized.

---

# 21. Multiple Tamper Signals

Multiple signals may occur simultaneously.

Example:

```text
Executable modified
+
Security database modified
+
System clock changed
+
Machine identity mismatch
```

The Security Authority must aggregate these signals.

It should not treat each event as an independent incident.

Instead:

```text
Evidence Set
     ↓
Risk Evaluation
     ↓
Security Decision
```

This prevents contradictory state transitions.

---

# 22. Evidence Confidence

Tamper evidence can have confidence levels.

Example:

```text
LOW
MEDIUM
HIGH
CONFIRMED
```

A low-confidence event may trigger verification.

A confirmed integrity violation may trigger immediate containment.

---

# 23. Tamper Response Must Be Monotonic

Security transitions should generally be monotonic during an unresolved incident.

For example:

```text
AUTHORIZED
   ↓
TAMPER_SUSPECTED
   ↓
COMPROMISED
```

The system should not accidentally perform:

```text
AUTHORIZED
   ↓
TAMPER_SUSPECTED
   ↓
AUTHORIZED
```

merely because some subsystem reported healthy.

Recovery must be explicit.

---

# 24. Recovery

Recovery from tamper state requires establishing trust again.

A possible sequence:

```text
COMPROMISED
     │
     ▼
APPLICATION TERMINATED
     │
     ▼
RESTART / REPAIR
     │
     ▼
INTEGRITY VERIFICATION
     │
     ▼
LOCAL SECURITY STATE VERIFICATION
     │
     ▼
MACHINE IDENTITY VERIFICATION
     │
     ▼
BACKEND AUTHENTICATION
     │
     ▼
AUTHORIZATION
     │
     ▼
NEW SECURITY EPOCH
     │
     ▼
AUTHORIZED
```

The application should not simply clear a local `tampered = true` flag.

---

# 25. Recovery Must Not Depend on Untrusted State

A dangerous design would be:

```text
tampered = true

delete tampered.flag

tampered = false
```

That creates an obvious bypass.

Recovery state must be derived from trusted verification rather than merely trusting mutable local state.

---

# 26. Security State Persistence

Important security transitions should be persisted.

For example:

```text
security_event
security_epoch
security_state
tamper_state
last_verified_integrity
machine_identity_reference
```

The persisted representation must itself be protected against unauthorized modification.

---

# 27. Crash During Tamper Response

Consider:

```text
Tamper detected
       ↓
Security epoch incremented
       ↓
Process crashes
```

On restart, the application must not revert to the previous authorization state.

Therefore security transitions require crash-consistent persistence.

The intended rule is:

> **A security transition must survive process termination.**

---

# 28. Crash During Recovery

Likewise:

```text
COMPROMISED
 ↓
Recovery started
 ↓
Process crashes
```

Restart should return to a conservative state.

For example:

```text
RECOVERY_REQUIRED
```

rather than:

```text
AUTHORIZED
```

---

# 29. Configuration Tampering

Configuration is not necessarily equally sensitive.

Classify configuration into:

### Non-security configuration

Examples:

- UI preferences
- theme
- window size

Tampering may be harmless.

### Operational configuration

Examples:

- transfer limits
- cache configuration

May require validation.

### Security configuration

Examples:

- backend endpoints
- trust anchors
- cryptographic parameters
- authorization policies

Modification should trigger security verification.

---

# 30. Backend Endpoint Tampering

The backend endpoint itself must be protected.

Otherwise an attacker could modify:

```text
https://legitimate-backend
```

to:

```text
https://attacker-server
```

and create a fake authorization service.

The application must therefore establish trust in the Backend independently of ordinary configuration.

---

# 31. Certificate and Trust Material

Trust material requires special handling.

Examples:

- server certificates
- public keys
- trust anchors
- key identifiers

Unexpected replacement should trigger verification or fail closed depending on the type of material.

---

# 32. Machine Identity Tampering

If the machine identity changes unexpectedly:

```text
Current machine identity
        ≠
Trusted machine identity
```

the Security Authority must not automatically treat the new identity as legitimate.

Possible response:

```text
Invalidate local authorization
        ↓
Reauthenticate
        ↓
Backend determines whether identity replacement is valid
```

---

# 33. Clock Tampering

Clock manipulation can affect:

- session expiry
- license expiry
- certificate validity
- replay protection
- offline grace periods

Therefore:

```text
Clock anomaly
```

should become security evidence.

The system should avoid blindly trusting local wall-clock time for critical security decisions.

---

# 34. Rollback Attacks

An attacker may restore an old application state:

```text
Current state
    ↓
Filesystem snapshot
    ↓
Older security database
```

This could resurrect:

- expired sessions
- old licenses
- revoked identities
- old authorization state

The Security Authority must therefore detect security-state rollback where possible.

---

# 35. Snapshot and VM Cloning

A machine installation may be copied.

Example:

```text
Machine A
   ↓
VM snapshot
   ↓
Machine B
```

Both installations may initially contain the same machine identity.

The Backend must be capable of detecting duplicate identity usage where machine binding is part of the security model.

The Control Plane should treat identity duplication as a security event rather than silently accepting it.

---

# 36. Local API Tampering

The local API is a major security boundary.

A malicious local process may attempt:

```text
POST /runtime/start
POST /license/validate
POST /security/authorize
```

The Control Plane must authenticate and authorize local API clients.

Localhost must never be treated as automatically trusted.

---

# 37. Frontend Tampering

The Frontend is not a security authority.

A modified Frontend could send:

```text
start runtime
```

or:

```text
execute operation
```

The Security Authority must independently validate whether the action is permitted.

The rule is:

> **Frontend validation improves usability; Security Authority validation provides security.**

---

# 38. IPC Tampering

The same principle applies to internal IPC.

The Control Plane must not assume:

```text
"this message came from our process, therefore it is trusted."
```

Where the threat model requires it, IPC must provide:

- peer authentication
- message integrity
- authorization
- freshness
- request correlation

---

# 39. Replay Protection

Tamper response must account for replayed security messages.

Example:

```text
OLD AUTHORIZATION_GRANTED
```

must not be accepted after:

```text
AUTHORIZATION_REVOKED
```

Security epochs, sequence numbers, nonces, or equivalent protocol mechanisms can enforce freshness.

---

# 40. Duplicate Security Events

Duplicate events must not cause inconsistent transitions.

For example:

```text
TAMPER_DETECTED
TAMPER_DETECTED
TAMPER_DETECTED
```

should produce one logical security transition.

Events should have stable identifiers where appropriate.

---

# 41. Out-of-Order Events

Consider:

```text
AUTHORIZATION_REVOKED
AUTHORIZATION_GRANTED
```

where the second message is stale.

The Security Authority must not blindly process messages according to arrival order.

Security messages require:

- session association
- epoch/version
- sequence/freshness information

---

# 42. Tamper Event Logging

Security events should be recorded with enough information to reconstruct what happened.

Example:

```text
event_id
event_type
severity
component
security_epoch
timestamp
monotonic_time
session_id
machine_identity
evidence_reference
previous_state
new_state
recovery_state
```

Sensitive secrets must never be logged.

---

# 43. Logging Must Not Become an Attack Surface

An attacker should not be able to:

```text
inject arbitrary log paths
```

or:

```text
fill the disk with unlimited security events
```

Therefore security logging requires:

- bounded storage
- rotation
- size limits
- safe serialization
- path isolation
- structured records

---

# 44. Fail-Closed vs Fail-Open

The Security Authority should explicitly define failure behavior.

For security-critical decisions:

```text
Unknown authorization
        ↓
DENY
```

rather than:

```text
Unknown authorization
        ↓
ALLOW
```

However, controlled offline grace may be deliberately defined for specific situations.

Therefore the rule is:

> **Fail closed by default; allow degraded operation only where an explicit policy permits it.**

---

# 45. Security Authority Self-Protection

The Security Authority itself is part of the trusted computing base.

Therefore it must protect:

- its state
- its protocol
- its authorization decisions
- its cryptographic operations
- its integrity verification
- its persistence
- its communication endpoints

If an attacker can freely modify the Security Authority, the rest of the architecture cannot compensate.

---

# 46. No Security Bypass Through Convenience Paths

There must not be alternative paths such as:

```text
Frontend → Runtime Manager
```

that bypass:

```text
Frontend → Security Authority → Runtime Manager
```

Likewise:

```text
Control Plane API → Execution Plane
```

must not bypass authorization.

Every authorization-sensitive operation must pass through the appropriate security decision boundary.

---

# 47. Tamper Response and Licensing

Licensing is part of authorization.

Therefore:

```text
license revoked
```

and:

```text
confirmed application tampering
```

may both result in:

```text
Execution authorization revoked
```

However, they remain different security events.

The system should preserve the distinction between:

```text
NOT_LICENSED
```

and:

```text
COMPROMISED
```

---

# 48. Tamper Response and Authentication

Tampering may invalidate authentication state.

For example:

```text
Security storage modified
```

may require:

```text
session invalidation
```

even if the Backend would otherwise consider the session valid.

The local Security Authority must not continue trusting credentials whose local security context has been compromised.

---

# 49. Tamper Response and Machine Identity

Similarly:

```text
machine identity corruption
```

should not simply be repaired by generating a new identity locally.

The correct flow is:

```text
Identity anomaly
      ↓
Invalidate trust
      ↓
Backend verification
      ↓
Identity recovery / re-registration
```

depending on the Backend's identity policy.

---

# 50. Tamper Response and Execution Authorization

The Execution Plane receives a security decision, not raw tamper evidence.

For example:

```text
Security Authority
      │
      │ Authorization:
      │ DENIED
      │
      ▼
Execution Plane
```

The Execution Plane does not need to understand:

- licensing
- authentication
- machine identity
- tamper detection
- backend sessions

This maintains subsystem isolation.

---

# 51. Security Decision Contract

The Security Authority should expose a small conceptual decision surface:

```text
AuthorizeOperation()
RevokeAuthorization()
GetSecurityState()
GetSecurityEpoch()
GetCapabilities()
```

The exact implementation is intentionally hidden.

---

# 52. Tamper Response Invariants

The following invariants should always hold.

### Invariant 1

A detected security compromise cannot increase privileges.

### Invariant 2

A stale authorization decision cannot override a newer security state.

### Invariant 3

Frontend state cannot establish authorization.

### Invariant 4

Execution Plane health cannot establish authorization.

### Invariant 5

Local cached state cannot permanently override Backend revocation.

### Invariant 6

Recovery cannot occur solely by modifying local state.

### Invariant 7

Security state must survive process restart.

### Invariant 8

Unknown security state must never silently become authorized.

### Invariant 9

Tamper response must not expose secrets.

### Invariant 10

Security Authority decisions must be independent of ordinary UI behavior.

---

# 53. Recommended Internal Components

The Security Authority can internally be decomposed into:

```text
SecurityAuthority
│
├── SecurityStateManager
│
├── TamperDetector
│
├── TamperClassifier
│
├── TamperResponseEngine
│
├── IntegrityVerifier
│
├── SecurityEpochManager
│
├── AuthorizationManager
│
├── SessionManager
│
├── LicenseManager
│
├── MachineIdentityManager
│
├── SecurityPersistence
│
├── TrustManager
│
├── RecoveryManager
│
└── SecurityEventJournal
```

These are internal implementation boundaries.

The rest of the Control Plane should not depend on all of them individually.

---

# 54. Public Boundary

Externally, the Security Authority should behave more like a single subsystem:

```text
┌──────────────────────────────┐
│      Security Authority      │
│                              │
│ authenticate                 │
│ authorize                   │
│ validate operation          │
│ get security state          │
│ receive security evidence   │
│ revoke authorization        │
│                              │
└──────────────────────────────┘
```

The internal decomposition remains replaceable.

---

# 55. Example: Executable Tampering

```text
Application starts
      ↓
Integrity verification
      ↓
Security Authority verified
      ↓
Authentication
      ↓
Authorization
      ↓
Execution Plane starts
      ↓
Runtime operating
      ↓
Integrity monitor detects modification
      ↓
Tamper event
      ↓
Security Authority
      ↓
Security epoch++
      ↓
Authorization revoked
      ↓
Execution authorization revoked
      ↓
Execution Plane stops
      ↓
Security event persisted
      ↓
Application enters COMPROMISED
```

---

# 56. Example: False Positive

```text
Unexpected configuration modification
        ↓
Suspicious
        ↓
Verification
        ↓
Configuration determined legitimate
        ↓
Security state unchanged
```

The system should not unnecessarily terminate itself.

---

# 57. Example: Backend Unavailable

```text
Backend unavailable
        ↓
Current session valid?
        ↓
Yes
        ↓
Offline policy permits operation?
        ↓
Yes
        ↓
OFFLINE_GRACE
```

Eventually:

```text
Grace expires
        ↓
REAUTHENTICATION_REQUIRED
        ↓
Execution authorization revoked
```

---

# 58. Example: Backend Revocation During Execution

```text
Execution running
        ↓
Backend reports license revoked
        ↓
Security Authority
        ↓
Security epoch++
        ↓
Authorization revoked
        ↓
Execution authorization revoked
        ↓
Execution Plane shutdown
```

No frontend action is required to enforce this.

---

# 59. Example: Crash During Revocation

```text
Backend revokes license
        ↓
Security state transition begins
        ↓
Process crashes
```

On restart:

```text
Load persisted security state
        ↓
Detect unresolved security transition
        ↓
Conservative state
        ↓
Backend reconciliation
        ↓
Authorization restored only if explicitly re-established
```

---

# 60. What This Architecture Prevents

This design specifically prevents common bypass patterns such as:

```text
Modify frontend
        ↓
Still unauthorized
```

```text
Modify cached license
        ↓
Still unauthorized
```

```text
Replay old authorization response
        ↓
Rejected by freshness/epoch validation
```

```text
Restart application after revocation
        ↓
Revocation state survives
```

```text
Modify local security state
        ↓
Integrity verification detects anomaly
```

```text
Call local API directly
        ↓
Security Authority still enforces authorization
```

```text
Bypass frontend
        ↓
No security benefit
```

---

# 61. Important Architectural Limitation

There is one fundamental fact that must remain explicit:

> **A local application cannot make itself absolutely tamper-proof against an attacker who has full control of the machine.**

The objective is therefore not:

```text
Impossible to bypass
```

The objective is:

```text
Make unauthorized modification significantly harder
+
Make security decisions dependent on trusted external state
+
Detect common integrity violations
+
Fail safely when trust cannot be established
+
Prevent simple local bypasses
```

This is the correct threat-model objective for the application.

---

# 62. Final Model

The complete mental model is:

```text
                    BACKEND
                       │
              Authentication /
               Authorization /
                 Licensing
                       │
                       ▼
             ┌──────────────────┐
             │ Security         │
             │ Authority        │
             │                  │
             │ Trust            │
             │ State            │
             │ Integrity        │
             │ Tamper Response  │
             │ Authorization    │
             └────────┬─────────┘
                      │
               Security Epoch
               + Authorization
                      │
                      ▼
             ┌──────────────────┐
             │ Control Plane    │
             │                  │
             │ Runtime Manager  │
             │ File Transfer    │
             │ API              │
             │ Telemetry        │
             │ etc.             │
             └────────┬─────────┘
                      │
               Authorized Runtime
                      │
                      ▼
             ┌──────────────────┐
             │ Execution Plane  │
             └──────────────────┘
```

The most important conceptual separation is:

```text
Tamper Detection
       ≠
Tamper Decision
       ≠
Tamper Enforcement
       ≠
Recovery
```

They are four different responsibilities.

The **Integrity subsystem discovers evidence**.

The **Security Authority determines trust**.

The **Security Authority changes authorization state**.

The **Control Plane enforces the resulting authorization decision through its subsystem boundaries**.

And the **Execution Plane remains a black box** that only understands whether it is authorized to operate.

---

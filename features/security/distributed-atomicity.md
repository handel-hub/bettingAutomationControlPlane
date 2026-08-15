# Distributed Atomicity Architecture

## 1. Threat Model
A Class-A local attacker aims to roll back the `secure_state` SQLite database to an older, previously valid authenticated state to bypass invariants (e.g., re-granting revoked capabilities or bypassing OCC limits). The attacker may actively manipulate the execution environment by simulating power loss, sending `SIGKILL` to the Node.js process, and deleting or corrupting auxiliary files, including the intent log and database files.

## 2. Failure Model
SQLite and the Windows Native DPAPI operate independently. No distributed atomic transaction exists between them. If a transition modifies both, a crash during the delta window inherently desynchronizes the two persistent stores. This creates a Time-Of-Check to Time-Of-Use (TOCTOU) vulnerability where a desynchronized system state could be mistaken for a valid operation, permitting an undetected physical rollback.

## 3. State Transition Protocol
To bind SQLite and DPAPI atomically, we implement a **Write-Ahead Intent** log (Two-Phase Commit variant).

**Sequence:**
1. **Initialize Intent**: Write `next_version` to `intent.bin` via DPAPI. (Durably marks the transition boundary).
2. **Commit SQLite**: Execute `UPDATE secure_state SET state_version = next_version ...` via standard SQLite OCC. (Durable transition of the AEAD payload).
3. **Commit Counter**: Execute `increment_monotonic_counter()` via DPAPI. (Advances the hardware anchor to match SQLite).
4. **Finalize Intent**: Delete `intent.bin`. (Concludes the transition).

## 4. Durable Operation Ordering
Strict execution constraint:
- SQLite must NEVER commit until `intent.bin` is durably written.
- The Monotonic Counter must NEVER increment until SQLite has durably committed.
- `intent.bin` must NEVER be deleted until the Monotonic Counter has durably incremented.

## 5. Crash Matrix
Let $N$ be the current committed state. We transition to $N+1$.

| Case | Scenario | DB | Counter | Intent | Recovery Action | Target State | Rollback Detected |
|---|---|---|---|---|---|---|---|
| **A** | Crash after Intent, before SQLite | $N$ | $N$ | $N+1$ | Clear stale intent | $N$ (Operational) | No |
| **B** | Crash after SQLite, before Counter | $N+1$ | $N$ | $N+1$ | Roll forward Counter | $N+1$ (Operational) | No |
| **C** | Crash after Counter, before Finalize | $N+1$ | $N+1$ | $N+1$ | Clear stale intent | $N+1$ (Operational) | No |
| **D** | SQLite OCC conflict (Runtime) | $N$ | $N$ | $N+1$ | Clear stale intent | $N$ (Operational) | No |
| **E** | Crash during Intent write | $N$ | $N$ | None/Corrupt | Halt if corrupt, else N | $N$ (Operational) | No |
| **F** | Counter increment fails (I/O error) | $N+1$ | $N$ | $N+1$ | Throws Fatal Error. Recovered on next boot as Case B. | $N+1$ (Operational) | No |
| **G** | Intent corruption (Tampering/Bitrot) | ? | ? | Corrupt | Halt unconditionally | `UNCERTAIN` | Yes |
| **H** | Attacker replaces DB with older snapshot | $N-K$ | $N$ | None | Halt (`DB != Counter`) | `UNCERTAIN` | Yes (Rollback) |
| **I** | Attacker replaces DB with newer snapshot (Forged) | $N+1$ | $N$ | None | Halt (`DB != Counter`) | `UNCERTAIN` | Yes (Forward Desync) |
| **J** | Attacker deletes Intent after Case B crash | $N+1$ | $N$ | None | Halt (`DB != Counter`) | `UNCERTAIN` | Yes |
| **K** | Attacker modifies Intent | $N+1$ | $N$ | Invalid | Halt (Authentication fail) | `UNCERTAIN` | Yes |
| **L** | Attacker restores older DB AND older Intent | $N-K$ | $N$ | $N-K$ | Halt (`DB != Counter`) | `UNCERTAIN` | Yes (Rollback) |

## 6. Recovery Algorithm
Run synchronously at the start of the Node.js process:
```javascript
let counter = getMonotonicCounter();
let intent = getTransitionIntent(); // Throws on corruption

if (intent !== -1) {
    if (db === intent && intent === counter + 1) {
        // Recover Case B
        incrementMonotonicCounter();
        counter = getMonotonicCounter();
    }
    // Case A and Case C will fail the above check, leaving the intent to be cleared
    clearTransitionIntent();
}

if (db !== counter) {
    throw new Error("SECURITY_STATE_UNCERTAIN: Hardware Counter / Persistence Desync");
}
// System is now OPERATIONAL
```

## 7. Security Invariants
- **Invariant 14 (Persistence Integrity)**: Enforced via AEAD blobs inside SQLite.
- **Invariant 17 (Rollback Resistance)**: Enforced via DPAPI Monotonic Counter strictly equaling the DB version.
- **Invariant 19 (Memory/Persistence Coherence)**: Crash atomicity prevents desyncing memory offsets.

## 8. Snapshot Rollback Analysis
If an attacker rolls back `secure_state.db` to $N-1$, the counter remains at $N$.
`db !== counter` evaluates to true ($N-1 \neq N$). The system enters `SECURITY_STATE_UNCERTAIN`. 
If the attacker rolls back the DB to $N-1$ AND provides a stolen `intent.bin` for $N-1$, the recovery protocol reads `intent = N-1`. The check `intent === counter + 1` evaluates to $N-1 === N+1$ (False). The intent is cleared. `db !== counter` evaluates to true ($N-1 \neq N$). The system halts.
The rollback is conclusively defeated.

## 9. Native Boundary
The Rust layer handles all cryptographic primitives to prevent Node.js memory tampering:
- `os_secret::set_transition_intent(version)`
- `os_secret::get_transition_intent()`
- `os_secret::clear_transition_intent()`
These methods natively wrap the `intent.bin` file with `CryptProtectData` tied to the local machine context.

## 10. JavaScript Boundary
Node.js merely orchestrates the sequential calls to the Native Boundary and SQLite. The `.mjs` layer cannot artificially construct a valid `intent.bin` without the native layer's key. It is restricted strictly to invoking the `commitTransitionWithOCC` algorithm.

## 11. Test Strategy
Adversarial tests will actively intercept and inject `process.exit(1)` at explicit boundaries:
- Before SQLite `UPDATE`
- After SQLite `UPDATE`
- After `incrementMonotonicCounter`
We will then restart the test harness and verify that `getSecurityStateRow` successfully recovers or halts appropriately for every permutation.

## 12. Residual Limitations
- This mitigates process crashes and local manipulation, but cannot recover the system if the underlying OS completely corrupts the NTFS volume containing the DPAPI root keys. In such cases, the system correctly fails-closed (`SECURITY_STATE_UNCERTAIN`), requiring backend disaster recovery.

# ACP ↔ EXECUTION PLANE BOUNDARY CONTRACT
## Automation Engine Forensic Audit and Protocol Specification
**Document Version**: 1.0.0  
**Status**: NORMATIVE SPECIFICATION & FORENSIC AUDIT  
**Scope**: Automation Control Plane (`bettingAutomationControlPlane`) ↔ Execution Plane (`bettingAutomation`)

---

## 1. EXECUTIVE ARCHITECTURE VERDICT

### 1.1 Architectural Purpose & Separation of Authority
The system is divided into four distinct operational planes:
1. **Frontend**: Presentation and desktop UI interaction layer.
2. **ACP (Automation Control Plane)**: Local orchestration, process lifecycle supervisor, local state synchronizer, configuration authority, and security mediator.
3. **Execution Plane**: Independent browser automation runtime. Owns Playwright driver instances, CDP sessions, DOM synchronization, locator intelligence, physical input simulation, and betting transaction cycles.
4. **Backend**: Cloud business authority, authentication, and licensing authority.

### 1.2 Forensic Audit: Implemented Reality vs. Target Architecture
A forensic analysis of the Execution Plane (`c:\Users\John\Documents\CODE\back\bettingAutomation`) and ACP (`c:\Users\John\Documents\CODE\back\bettingAutomationControlPlane`) codebases reveals significant architectural divergence between currently implemented reality and the required architecture:

| Subsystem | Implemented Reality (Execution Plane Source) | Architectural Target (Contract Requirement) |
| :--- | :--- | :--- |
| **Process Entrypoint** | `launcher/index.mjs` acts as a monolithic Node.js CLI launcher that reads local disk files (`accounts.txt`, `settings.ini`, `betting_strategy.ini`, `proxies.txt`) and forks `src/worker/index.mjs`. | ACP's `RuntimeManager` is the sole supervisor. It spawns the Execution Plane as a secured worker child process using `NativeCore` OS security. |
| **IPC Transport** | Node.js `child_process.fork()` IPC channel using `process.send()` / `process.on('message')`. Only handles 2 raw commands (`TRIGGER_WORKFLOW`, `RUN_MACRO`). | Windows Named Pipe (`\\.\pipe\control_plane_secure_ipc`) secured via ephemeral 32-byte mutual HMAC-SHA256 handshake. Typed RFC 8785 JSON envelopes. |
| **Configuration Authority** | Dual authority: Execution Plane reads INI files from disk into `MemoryPolicyProvider`. ACP maintains independent configuration tables in SQLite. | **ACP is the sole configuration authority**. Configuration is injected at initialization and dynamically mutated via `CONFIG:UPDATE_POLICY` envelopes. INI disk files are deprecated. |
| **Credential Management** | Plaintext accounts and passwords read from `accounts.txt` and passed unencrypted across process boundaries. Stored plaintext in memory. | **ACP zero-secret boundary**: Execution Plane receives account credentials scoped only to needed browser sessions. Plaintext credentials never cross to Frontend or unauthenticated streams. |
| **Transaction Boundary** | `RunOrchestrator`, `BetCycle`, and `CashoutCycle` enforce strict atomic boundaries with append-only WAL (`data/wal/run_ledger.jsonl`) and out-of-band `ReconciliationDaemon`. | **Preserved and formalized**. ACP drives tactical triggers (`TACTICAL:PLACE_BET`, `TACTICAL:CASH_OUT`) while Execution Plane retains exclusive execution and WAL ownership. |
| **Execution Results** | Binary success/failure with unhandled crashes falling into unhandled promises or string error messages. | Explicit 8-state execution result taxonomy: `ACCEPTED`, `STARTED`, `PROGRESS`, `COMPLETED`, `REJECTED`, `FAILED`, `PARTIALLY_COMPLETED`, `UNKNOWN`. |

---

## 2. EXECUTION PLANE FORENSIC DOMAIN MODEL

From the deep forensic audit of `src/browser/` and `src/worker/`, the Execution Plane runtime consists of the following authentic entities:

```
                               ┌──────────────────────────────────────────────┐
                               │           ExecutionPlaneWorker               │
                               │  (Process Entrypoint: src/worker/index.mjs)  │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                           manages & initializes
                                                      │
                                                      ▼
                               ┌──────────────────────────────────────────────┐
                               │             AutomationController             │
                               └───────┬──────────────┬──────────────┬────────┘
                                       │              │              │
                   ┌───────────────────┘              │              └────────────────────┐
                   ▼                                  ▼                                   ▼
      ┌─────────────────────────┐       ┌───────────────────────────┐       ┌───────────────────────────┐
      │   ClusterOrchestrator   │       │      WorkflowEngine       │       │    PassiveShadowDaemon    │
      │   - BrowserLifecycle    │       │   - AutomationRun         │       │   - Injected Observer     │
      │   - SessionManager      │       │   - BetCycle              │       │   - Policy Math Engine    │
      │   - HealthMonitor       │       │   - CashoutTransaction    │       │   - Hardware Manual Yield │
      │   - RecoveryManager     │       │   - CashoutCycle          │       └───────────────────────────┘
      └────────────┬────────────┘       └─────────────┬─────────────┘
                   │                                  │
                   ▼                                  ▼
      ┌─────────────────────────┐       ┌───────────────────────────┐
      │  BrowserStateRegistry   │       │      RunOrchestrator      │
      │  - BrowserStateModel    │◄──────┤   - Single-Flight Lease   │
      │  - Master / Slaves      │       │   - RunLedger (WAL)       │
      │  - GES Sequence Gate    │       │   - ReconciliationDaemon  │
      └─────────────────────────┘       └───────────────────────────┘
```

### 2.1 Runtime Entities Defined
1. **Execution Plane Instance**: The OS child process executing the Node.js automation runtime.
2. **Browser Instance (`BrowserStateModel`)**: An isolated Chromium/Chrome browser process managed via Playwright. Identified by `browserId` (`'master'`, `'slave_0'`, `'slave_1'`).
3. **Account Binding**: The association between an operator account (`username`), a proxy, and a `browserId`.
4. **Master Browser**: The primary browser page displaying bookmaker UI where user interaction or primary observation originates.
5. **Slave Browser**: Headless or headful replica browser executing mirror actions or individual account operations.
6. **Global Event Sequence (GES)**: Monotonically increasing integer counter tagging physical master events to enforce strict total ordering across all slaves.
7. **Single-Flight Lease**: Exclusive operational lock held by `RunOrchestrator` on an account during an automation transaction. Prevents concurrent operations on the same balance.
8. **Automation Run (`AutomationRun`)**: The multi-cycle intent representing a complete betting sequence (initial bet + optional chained rebets).
9. **Bet Cycle (`BetCycle`)**: A single physical submission attempt to the platform. Owns pre-flight TOCTOU validation, typing, atomic submission, and DOM settlement observation.
10. **Cashout Transaction (`CashoutTransaction`)**: Coordinates cashout intent on open bets across targets.
11. **Cashout Cycle (`CashoutCycle`)**: A single physical attempt to trigger and confirm cashout for an open bet.
12. **Run Ledger (WAL)**: Append-only disk log (`data/wal/run_ledger.jsonl`) recording transition to `PROCESSING` and `SETTLEMENT` to survive abrupt process crashes.
13. **Reconciliation Daemon**: Out-of-band resolution loop that polls bookmaker API order history to resolve `UNCERTAIN` execution states.
14. **Passive Shadow Daemon**: Injected page observer that continuously solves pricing math against live odds and updates candidate DOM stakes while yielding to manual hardware input.

---

## 3. STATE MACHINES & LIFECYCLES

The Execution Plane exhibits three distinct, interacting state layers that must never be conflated:
1. **Process Lifecycle** (OS / Supervisor level)
2. **Engine Lifecycle** (Automation coordination level)
3. **Transactional Lifecycle** (Financial run level)
4. **Browser/Worker Lifecycle** (Individual browser level)

### 3.1 Engine Lifecycle State Machine

```
              ┌───────────────┐
              │  OFFLINE /    │
              │  SPAWNED      │
              └───────┬───────┘
                      │ IPC Connected & Authenticated
                      ▼
              ┌───────────────┐
              │ INITIALIZING  │
              └───────┬───────┘
                      │ INITIALIZE acked & browsers launched
                      ▼
              ┌───────────────┐
              │     READY     │◄───────────────────┐
              └───────┬───────┘                    │
                      │                            │
         START_CLUSTER│ STOP_CLUSTER               │ Resume / Recover
                      ▼                            │
              ┌───────────────┐                    │
              │    RUNNING    │                    │
              └───────┬───────┘                    │
                      │                            │
             Degraded │ Health Alert               │
                      ▼                            │
              ┌───────────────┐                    │
              │   DEGRADED    │────────────────────┘
              └───────┬───────┘
                      │ Fatal fault / SHUTDOWN
                      ▼
              ┌───────────────┐
              │   STOPPING    │
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │    STOPPED    │
              └───────────────┘
```

#### State Definitions & Transition Rules:
- **`OFFLINE`**: Process has not been spawned or socket is disconnected.
- **`INITIALIZING`**: Process spawned; HMAC handshake completed; awaiting or processing `LIFECYCLE:INITIALIZE`.
- **`READY`**: Browsers spawned, sessions authenticated, synchronization initialized. Standby for operational commands.
- **`RUNNING`**: Active automation enabled. Causal triggers and tactical operations permitted.
- **`DEGRADED`**: One or more slaves diverged/failed, proxy failed in loose mode, or master in recovery. Betting permitted only on healthy nodes or blocked per policy.
- **`STOPPING`**: Graceful shutdown in progress (closing CDP sessions, terminating Playwright, flushing WAL).
- **`STOPPED`**: All child browsers closed, WAL flushed, process ready to terminate.

### 3.2 Transactional Lifecycle State Machine (Bet & Cashout)

```
        ┌─────────────────────────────────────────────────────────────┐
        │                           PASSIVE                           │
        └──────────────────────────────┬──────────────────────────────┘
                                       │ Acquire Lease (RunOrchestrator)
                                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │                          EXECUTING                          │
        └───────┬─────────────────────────────────────────────┬───────┘
                │                                             │
      Pre-flight│ Failure / Policy Reject             Pre-flight OK
                ▼                                             ▼
        ┌───────────────┐                             ┌───────────────┐
        │    ABORTED    │                             │  PROCESSING   │
        └───────┬───────┘                             │  (WAL Append) │
                │                                     └───────┬───────┘
                │ Release Lease                               │ Atomic Click Committed
                ▼                                             ▼
        ┌───────────────┐                             ┌───────────────┐
        │    PASSIVE    │                             │  SETTLEMENT   │
        └───────────────┘                             └───────┬───────┘
                                                              │
                                       ┌──────────────────────┴──────────────────────┐
                                       │                                             │
                           Settled (Success / Fail)                          Timeout / Crash
                                       ▼                                             ▼
                               ┌───────────────┐                             ┌───────────────┐
                               │   COMPLETED   │                             │   UNCERTAIN   │
                               │  (WAL Append) │                             │ (Lease Frozen)│
                               └───────┬───────┘                             └───────┬───────┘
                                       │ Release Lease                               │ Handoff to Daemon
                                       ▼                                             ▼
                               ┌───────────────┐                             ┌───────────────┐
                               │    PASSIVE    │                             │ RECONCILIATION│
                               └───────────────┘                             └───────────────┘
```

> [!CRITICAL]
> **The `UNCERTAIN` Freeze Invariant**:
> If a crash, network disconnect, or DOM timeout occurs after the atomic click is committed (`PROCESSING` or `SETTLEMENT`), the transaction status is **strictly `UNCERTAIN`**.
> The `RunOrchestrator` lease is **NOT released**. The account remains **frozen** to prevent double-betting. It can only be unfrozen when the `ReconciliationDaemon` verifies the platform order history or ACP issues a forced manual resolution.

---

## 4. BOUNDARY ISOLATION: FORBIDDEN IMPLEMENTATION DETAILS

To preserve decoupling and guarantee independent evolvability, the ACP ↔ Execution Plane boundary strictly forbids implementation leaks:

### Forbidden Protocol Concepts:
1. **Playwright Data Structures**: No `Page`, `BrowserContext`, `ElementHandle`, `Locator`, `CDPSession`, or `Route` objects may cross the wire.
2. **DOM Selectors & CSS Paths**: No CSS selectors (`.m-btn-place`), XPath expressions, or raw DOM snippets may cross the boundary.
3. **JavaScript Injection Scripts**: No raw code strings, evaluation payloads, or script ASTs.
4. **Internal Class Names**: No references to `ActionSimulator`, `ClusterOrchestrator`, `ConvergenceEngine`, `SportyBetAdapter`, etc.
5. **Internal Queue & Ring Buffer Mechanics**: No exposure of micro-queues, retry counters, or internal mutex locks.
6. **Filesystem Paths**: No server paths (e.g. `c:\Users\...\sessions\`, `wal\run_ledger.jsonl`).

---

## 5. INITIALIZATION PROTOCOL

### 5.1 Protocol Handshake & Transport
1. **Transport**: Windows Named Pipe `\\.\pipe\control_plane_secure_ipc`.
2. **Authentication**: ACP passes a 32-byte cryptographically secure random session key to Execution Plane via `process.stdin`. Execution Plane calculates `HMAC-SHA256(sessionKey, "IPC_AUTH" + process.pid)` and transmits the 32-byte digest upon socket connection.
3. **Wire Framing**: 4-byte big-endian payload length prefix followed by UTF-8 encoded JSON.

### 5.2 Canonical Envelope Schema (RFC 8785 Compatible)
Every message across the boundary adheres to this deterministic schema:

```json
{
  "msgId": "01M24K9ABCD1234567890EFGHI",
  "traceId": "trace-01M24K9ABCD1234567890",
  "type": "LIFECYCLE:INITIALIZE",
  "timestamp": 1789006000000,
  "source": "CONTROL_PLANE",
  "payload": {}
}
```

### 5.3 Initialization Payload (`LIFECYCLE:INITIALIZE`)
ACP transmits the full operational context in a single, authoritative payload:

```json
{
  "msgId": "01M24K9A000000000000000001",
  "traceId": "trace-init-node-01",
  "type": "LIFECYCLE:INITIALIZE",
  "timestamp": 1789006000000,
  "source": "CONTROL_PLANE",
  "payload": {
    "protocolVersion": "3.0",
    "environment": "production",
    "fleet": {
      "masterUseProxy": false,
      "slaveMode": "headful",
      "maxAccountsToSpawn": 2,
      "debugSlowMo": 0,
      "accounts": [
        {
          "accountId": "acc_sporty_01",
          "role": "master",
          "platformId": "sportybet",
          "username": "08107992381",
          "password": "[PROTECTED]",
          "proxy": null
        },
        {
          "accountId": "acc_sporty_02",
          "role": "slave",
          "platformId": "sportybet",
          "username": "08012345678",
          "password": "[PROTECTED]",
          "proxy": {
            "server": "http://192.168.1.50:8080",
            "username": "proxyuser",
            "password": "proxypassword"
          }
        }
      ]
    },
    "configuration": {
      "pricing": {
        "mode": "PROFIT_TARGET",
        "baseStake": 100,
        "targetProfit": 30,
        "minimumAcceptableProfit": 5,
        "resolutionStrategy": "CLAMP_THEN_REDUCE_PROFIT",
        "platformIncrement": 1,
        "selectionPreference": "ROUND_NUMBERS",
        "restorePolicyOnRebet": true
      },
      "risk": {
        "autoAcceptOddsChanges": false,
        "maxStake": 10000,
        "minimumStake": 10,
        "abortOnMarketSuspend": true
      },
      "rebet": {
        "maxRebetAttempts": 1,
        "rebetStakeIncrement": 10
      },
      "timeouts": {
        "resultTimeoutMs": 30000,
        "navigationTimeoutMs": 10000,
        "loginTimeoutMs": 15000,
        "decisionFreshnessTtlMs": 3000,
        "reconciliationTimeoutMs": 120000,
        "keyboardTypingDelayMs": 250
      },
      "retries": {
        "maxExecutionRetries": 3,
        "maxRecoveryAttempts": 3,
        "recoveryBaseDelayMs": 2000
      },
      "antiDetection": {
        "useStealthPlugin": false,
        "browserBinary": "chrome",
        "randomizeUserAgent": false,
        "blockWebrtc": false,
        "matchProxyTimezone": true,
        "canvasSpoofing": false
      }
    }
  }
}
```

### 5.4 Initialization Acknowledgement (`LIFECYCLE:STATE_CHANGED`)
```json
{
  "msgId": "01M24K9A000000000000000002",
  "traceId": "trace-init-node-01",
  "type": "LIFECYCLE:STATE_CHANGED",
  "timestamp": 1789006001500,
  "source": "EXECUTION_PLANE",
  "payload": {
    "state": "READY",
    "message": "Cluster initialized successfully with 1 master and 1 slave",
    "provisionedBrowsers": [
      { "browserId": "master", "role": "master", "accountId": "acc_sporty_01", "status": "Ready" },
      { "browserId": "slave_0", "role": "slave", "accountId": "acc_sporty_02", "status": "Ready" }
    ]
  }
}
```

---

## 6. COMMAND MODEL & SPECIFICATION

All commands issued by ACP follow standard operational classifications:

### 6.1 Command Taxonomy Matrix

| Category | Type | Purpose | Synchronous ACK | Terminal Result | Idempotent |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **Lifecycle** | `LIFECYCLE:INITIALIZE` | Cold-boot cluster initialization | Yes (`STATE_CHANGED`) | `READY` / `FAILED` | Yes |
| **Lifecycle** | `LIFECYCLE:START_CLUSTER` | Transitions engine to `RUNNING` | Yes | `STATE_CHANGED` | Yes |
| **Lifecycle** | `LIFECYCLE:STOP_CLUSTER` | Graceful shutdown of child browsers | Yes | `STATE_CHANGED` (`STOPPED`) | Yes |
| **Tactical** | `TACTICAL:PLACE_BET` | Execute coordinated bet cycle | Yes (`OPERATION_ACK`) | `OPERATION_RESULT` | **NO** |
| **Tactical** | `TACTICAL:CASH_OUT` | Execute cashout on open bet | Yes (`OPERATION_ACK`) | `OPERATION_RESULT` | **NO** |
| **Tactical** | `TACTICAL:VALIDATE` | Verify odds, balance, and betslip DOM | Yes (`OPERATION_ACK`) | `OPERATION_RESULT` | Yes |
| **Fleet** | `FLEET:ACTIVATE_ACCOUNT` | Spawns/un-quarantines an account browser | Yes | `FLEET:BROWSER_STATUS` | Yes |
| **Fleet** | `FLEET:DEACTIVATE_ACCOUNT` | Shuts down browser for account | Yes | `FLEET:BROWSER_STATUS` | Yes |
| **Fleet** | `FLEET:SET_BET_CYCLE` | Toggles account participation policy | Yes | `FLEET:BROWSER_STATUS` | Yes |
| **Config** | `CONFIG:UPDATE_POLICY` | Hot-reloads pricing, risk, or rebet rules | Yes | `CONFIG:POLICY_UPDATED` | Yes |
| **Diagnostic** | `DIAGNOSTIC:CAPTURE_SNAPSHOT` | Requests comprehensive diagnostic dump | No (streaming) | `DATA:SNAPSHOT_DUMP` | Yes |

### 6.2 Tactical Betting Command (`TACTICAL:PLACE_BET`)
```json
{
  "msgId": "01M24K9B000000000000000001",
  "traceId": "trace-bet-9921",
  "type": "TACTICAL:PLACE_BET",
  "timestamp": 1789006005000,
  "source": "CONTROL_PLANE",
  "payload": {
    "operationId": "op_bet_20260910_001",
    "idempotencyKey": "idem_acc_sporty_01_rnd4812",
    "targetAccounts": ["acc_sporty_01", "acc_sporty_02"],
    "executionMode": "UNIQUE_ACCOUNTS_ONLY",
    "expectedMarket": {
      "sport": "football",
      "marketName": "1X2",
      "selectionName": "Home"
    },
    "pricingOverride": {
      "stake": 250,
      "minOdds": 1.45,
      "maxOdds": 1.60
    }
  }
}
```

---

## 7. EXECUTION RESULTS TAXONOMY

The Execution Plane distinguishes between 8 formal execution states. The contract strictly forbids collapsing these into a binary `boolean` success flag:

```
                      ┌───────────────┐
                      │   ACCEPTED    │
                      └───────┬───────┘
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
       ┌───────────────┐             ┌───────────────┐
       │    STARTED    │             │   REJECTED    │
       └───────┬───────┘             └───────────────┘
               │
               ▼
       ┌───────────────┐
       │   PROGRESS    │
       └───────┬───────┘
               │
      ┌────────┼──────────────────────────────┬──────────────────────────────┐
      ▼        ▼                              ▼                              ▼
┌───────────┐┌────────────────────────┐┌───────────┐                  ┌───────────┐
│ COMPLETED ││  PARTIALLY_COMPLETED   ││  FAILED   │                  │  UNKNOWN  │
└───────────┘└────────────────────────┘└───────────┘                  └───────────┘
```

1. **`ACCEPTED`**: Command envelope validated, schema passed, queued for execution.
2. **`STARTED`**: Lease acquired; pre-flight checks in progress.
3. **`PROGRESS`**: Stake preparation / typing completed; entering submission gate.
4. **`COMPLETED`**: Physical transaction succeeded, confirmed by authoritative platform DOM confirmation.
5. **`REJECTED`**: Command refused before physical execution (e.g. account locked, policy constraint violation, invalid odds). Safe to retry with different parameters.
6. **`FAILED`**: Operation attempted physically but platform rejected before commitment (e.g. "Odds Changed", "Insufficient Balance"). Zero financial commitment.
7. **`PARTIALLY_COMPLETED`**: In a multi-account batch or multi-rebet run, some accounts/rebets succeeded while others failed.
8. **`UNKNOWN`**: Physical commitment (`click`) was dispatched, but browser crashed, timed out, or connection broke before confirmation. **Requires active reconciliation**.

### 7.1 Terminal Operation Result Payload (`TACTICAL:OPERATION_RESULT`)
```json
{
  "msgId": "01M24K9B000000000000000002",
  "traceId": "trace-bet-9921",
  "type": "TACTICAL:OPERATION_RESULT",
  "timestamp": 1789006008200,
  "source": "EXECUTION_PLANE",
  "payload": {
    "operationId": "op_bet_20260910_001",
    "status": "COMPLETED",
    "durationMs": 3200,
    "accounts": [
      {
        "accountId": "acc_sporty_01",
        "browserId": "master",
        "status": "SUCCESS",
        "stakePlaced": 250,
        "oddsObserved": 1.52,
        "orderReceiptId": "SP-ORD-9912048",
        "cyclesExecuted": 1
      },
      {
        "accountId": "acc_sporty_02",
        "browserId": "slave_0",
        "status": "SUCCESS",
        "stakePlaced": 250,
        "oddsObserved": 1.52,
        "orderReceiptId": "SP-ORD-9912049",
        "cyclesExecuted": 1
      }
    ],
    "metrics": {
      "preFlightLatencyMs": 140,
      "typingLatencyMs": 310,
      "submissionLatencyMs": 850,
      "settlementLatencyMs": 1900
    }
  }
}
```

---

## 8. FINANCIAL IDEMPOTENCY & RECONCILIATION PROTOCOL

Financial commands (`PLACE_BET`, `CASH_OUT`) carry severe risk of double-spending under network drops or process crashes. The protocol enforces three safety layers:

### 8.1 Idempotency Key De-duplication
1. ACP must attach a unique, client-generated `idempotencyKey` to every financial command.
2. Execution Plane maintains an in-memory and WAL-persisted LRU filter of processed `idempotencyKey`s with a 24-hour TTL.
3. If Execution Plane receives a duplicate `idempotencyKey`:
   - If previous run is still in-flight: Re-emits `OPERATION_ACK` and ignores duplicated actuation.
   - If previous run succeeded: Immediately re-emits cached `OPERATION_RESULT` without actuating DOM.
   - If previous run failed pre-boundary: Allows re-execution only if explicit `forceRetry: true` is attached.

### 8.2 The Atomic Boundary Rule
- Any command executed with `idempotent: false` (e.g. `translateAtomicPlaceBet`) requires an active, validated cycle lease from `RunOrchestrator`.
- If the lease is missing or stale, `ActionSimulator` synchronously throws `ContractViolationError` and refuses to actuate the mouse/keyboard.

### 8.3 Reconciliation Protocol (`TACTICAL:RECONCILE_STATUS`)
When an operation terminates in `UNKNOWN`, ACP or Execution Plane executes this sequence:

```
        ACP (Supervisor)                                  Execution Plane
              │                                                  │
              │─── TACTICAL:RECONCILE_ORDER ────────────────────>│
              │    (idempotencyKey, accountId, approxStake)      │
              │                                                  │── Query Platform API /
              │                                                  │   Recent Order History
              │<── TACTICAL:RECONCILIATION_REPORT ───────────────│
              │    (status: RESOLVED_COMMITTED / RESOLVED_LOST)  │
              │                                                  │── Unfreeze Lease
              │─── ACK Reconciliation ──────────────────────────>│
```

---

## 9. MASTER / SLAVE SYNCHRONIZATION BOUNDARY

### 9.1 Responsibilities
- **Execution Plane Owns**:
  - Global Event Sequence (GES) generation and strict ordering.
  - Injected mutation listeners (`ActionDispatcher`) on Master.
  - Causal suppression (dropping Master place bet / rebet DOM clicks from broadcasting to Slaves).
  - Trailing-edge scroll reconciliation (`ScrollConvergenceHandler`).
  - Native overlay dismissal (`AOIS` MutationObserver script).
- **ACP Owns**:
  - Observing sync state (`SYNCHRONIZED`, `DESYNCHRONIZED`, `CONVERGING`, `FAILED`).
  - Quarantining persistently desynchronized slaves.
  - Enforcing degraded mode when synchronization invariants are violated.

### 9.2 Synchronization Telemetry Frame (`TELEMETRY:SYNC_METRICS`)
```json
{
  "msgId": "01M24K9C000000000000000001",
  "traceId": "trace-sync-poll",
  "type": "TELEMETRY:SYNC_METRICS",
  "timestamp": 1789006010000,
  "source": "EXECUTION_PLANE",
  "payload": {
    "masterGes": 142,
    "slaves": [
      {
        "browserId": "slave_0",
        "currentGes": 142,
        "drift": 0,
        "consecutiveGaps": 0,
        "syncState": "SYNCHRONIZED",
        "scrollDriftPx": 0
      }
    ],
    "clusterSyncState": "OPTIMAL"
  }
}
```

---

## 10. CONFIGURATION OWNERSHIP MATRIX

To prevent conflicting configuration states, authority is explicitly delineated:

| Configuration Category | Canonical Authority | Transfer Mechanism | Dynamic Mutation? | Persistence Layer |
| :--- | :---: | :---: | :---: | :---: |
| **Account Credentials** | **ACP** | `LIFECYCLE:INITIALIZE` | No (Requires restart) | ACP SQLite (`data_protection`) |
| **Proxy Pool & Allocations** | **ACP** | `LIFECYCLE:INITIALIZE` | No (Requires restart) | ACP SQLite |
| **Pricing Strategy & Math** | **ACP** | `INITIALIZE` + `CONFIG:UPDATE_POLICY` | **Yes (Hot-reload)** | ACP SQLite (`automation_config`) |
| **Risk & Hard Stake Limits** | **ACP** | `INITIALIZE` + `CONFIG:UPDATE_POLICY` | **Yes (Hot-reload)** | ACP SQLite (`automation_config`) |
| **Rebet Strategy** | **ACP** | `INITIALIZE` + `CONFIG:UPDATE_POLICY` | **Yes (Hot-reload)** | ACP SQLite (`automation_config`) |
| **Execution Timeouts & Pacing** | **ACP** | `INITIALIZE` + `CONFIG:UPDATE_POLICY` | **Yes (Hot-reload)** | ACP SQLite (`automation_config`) |
| **DOM Selectors & Locators** | **Execution Plane** | Internal `selectors.json` / registry | Internal Only | Execution Plane filesystem |
| **AOIS Overlay Dismissal Rules** | **Execution Plane** | Internal `overlays.json` | Internal Only | Execution Plane filesystem |
| **Active WAL State** | **Execution Plane** | Internal `run_ledger.jsonl` | Real-time write | Execution Plane filesystem |

---

## 11. ERROR TAXONOMY & CLASSIFICATION

Execution Plane errors are categorized with standardized machine-readable error codes:

| Code | Name | Domain | Retryable? | Severity | Description |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `EP_CMD_001` | `MALFORMED_COMMAND` | PROTOCOL | No | WARN | JSON malformed or missing mandatory envelope fields. |
| `EP_CMD_002` | `CONTRACT_VIOLATION` | PROTOCOL | No | ERROR | Command violated schema constraints (LF-701). |
| `EP_STATE_001` | `INVALID_ENGINE_STATE` | LIFECYCLE | Yes | ERROR | Tactical command received while engine is `INITIALIZING` or `STOPPED`. |
| `EP_STATE_002` | `ACCOUNT_BUSY` | FLEET | Yes | WARN | Account lease held by another active run. Single-flight rejection. |
| `EP_AUTH_001` | `SESSION_EXPIRED` | BROWSER | Yes | ERROR | Target platform session invalidated; requires re-authentication. |
| `EP_AUTH_002` | `LOGIN_FAILED` | BROWSER | No | CRITICAL | Credentials rejected by platform login form. |
| `EP_DOM_001` | `LOCATOR_NOT_FOUND` | AUTOMATION | Yes | ERROR | Fast-path and probabilistic fallback both failed to resolve element. |
| `EP_DOM_002` | `OVERLAY_BLOCKED` | AUTOMATION | Yes | WARN | Target element covered by persistent modal or banner. |
| `EP_DOM_003` | `MARKET_SUSPENDED` | AUTOMATION | No | WARN | Odds disabled or market suspended by bookmaker. |
| `EP_DOM_004` | `ODDS_DRIFT_INTERRUPT` | AUTOMATION | Yes | WARN | Odds shifted beyond acceptable policy tolerance before physical click. |
| `EP_SYNC_001` | `MAX_GES_GAPS_EXCEEDED` | SYNC | Yes | ERROR | Slave missed more than 10 consecutive events; requires resync. |
| `EP_SYNC_002` | `CONVERGENCE_TIMEOUT` | SYNC | Yes | ERROR | Slave navigation or scroll convergence timed out. |
| `EP_RECOVERY_001`| `HEAL_ATTEMPTS_EXHAUSTED`| BROWSER | No | CRITICAL | Browser process crashed 3 consecutive times; marked permanently dead. |
| `EP_TX_001` | `UNCERTAIN_OUTCOME` | TRANSACTION | **NO** | CRITICAL | Atomic commitment sent but unconfirmed; requires out-of-band reconciliation. |

---

## 12. HEARTBEAT, HEALTH & LIVELINESS PROTOCOL

### 12.1 Bidirectional Liveness Invariants
1. **Heartbeat Cadence**: Execution Plane transmits `TELEMETRY:HEARTBEAT` every `1000ms`.
2. **Missing Heartbeats**:
   - If ACP receives no heartbeat for `3000ms`: ACP flags Execution Plane as `UNRESPONSIVE`.
   - If ACP receives no heartbeat for `5000ms`: ACP trips circuit breaker, marks operational state `DEGRADED`, and halts inbound Frontend tactical bets.
   - If ACP receives no heartbeat for `10000ms`: ACP executes forceful process quarantine (`SIGKILL` to worker PID).

### 12.2 Telemetry Heartbeat Frame (`TELEMETRY:HEARTBEAT`)
```json
{
  "msgId": "01M24K9D000000000000000001",
  "traceId": "hb-1789006012",
  "type": "TELEMETRY:HEARTBEAT",
  "timestamp": 1789006012000,
  "source": "EXECUTION_PLANE",
  "payload": {
    "pid": 23412,
    "uptimeSeconds": 342,
    "engineStatus": "RUNNING",
    "activeBrowsers": 2,
    "totalConfigured": 2,
    "clusterSync": "OPTIMAL",
    "memoryUsageMb": 312.4,
    "activeLeases": 0
  }
}
```

---

## 13. SECURITY & ATTESTATION BOUNDARY

1. **OS Process Attestation**:
   - Execution Plane can only be spawned via `NativeCore.createProcess()`.
   - Named pipe connections from unknown or un-spawned PIDs are synchronously rejected at the OS kernel level.
2. **Zero Plaintext Credentials**:
   - Plaintext passwords received in `INITIALIZE` are strictly scoped to the `SessionManager` memory map and are deleted/garbage-collected immediately upon browser session establishment.
   - In all diagnostic logs, telemetry, and error messages, passwords and tokens must be masked with `'[PROTECTED]'`.
3. **Privilege Separation**:
   - Execution Plane has zero access to the ACP SQLite database file.
   - Execution Plane cannot communicate with the Cloud Backend.
   - Execution Plane cannot communicate directly with the Frontend.

---

## 14. VERSIONING & CAPABILITY NEGOTIATION

1. **Protocol Versioning**: SemVer specification (`MAJOR.MINOR.PATCH`).
   - Current Protocol Version: `3.0.0`.
2. **Version Negotiation**:
   - Sent by ACP in `LIFECYCLE:INITIALIZE` (`protocolVersion: "3.0"`).
   - If Execution Plane cannot satisfy `MAJOR` version: Rejects with `EP_CMD_002` and terminates cleanly.
3. **Unknown Fields**:
   - Both parties must ignore unknown JSON fields to allow additive `MINOR` version enhancements without breaking backward compatibility.

---

## 15. CONTRACT TEST STRATEGY

To verify adherence to this contract without running full browser clusters, the following automated test suites are required:

1. **Harness Verification**:
   - Mock Execution Plane (`MockExecutionWorker`): Connects to named pipe, completes HMAC handshake, validates `INITIALIZE` envelope, and simulates tactical responses.
   - Mock ACP (`MockControlPlane`): Spawns real Execution Plane worker, verifies named pipe binding, asserts heartbeat reception, and delivers hot-reload config updates.
2. **Adversarial Invariant Tests**:
   - Test unexpected disconnect during `PROCESSING` (asserts `UNCERTAIN` state is flagged).
   - Test duplicate `idempotencyKey` delivery (asserts second request does not actuate DOM).
   - Test invalid schema injection (asserts rejection with `LF-701`).
   - Test recovery loop escalation after 3 consecutive browser crashes.

---

## 16. HOSTILE FINAL REVIEW: FAILURE SCENARIOS & AMBIGUITY RESOLUTION

To ensure no ambiguous behavior exists, we systematically attack the contract against the 14 critical failure scenarios:

### Scenario 1: Execution Plane crashes immediately after placing a bet
- **Mechanism**: The Playwright click committed on bookmaker DOM, but the Node.js process crashed before observing the confirmation icon.
- **Contract Resolution**:
  1. `BetCycle` already marked state `PROCESSING` and appended to `RunLedger` WAL synchronously before the physical click.
  2. Upon crash, ACP detects named pipe closure and flags the active `operationId` as `UNKNOWN`.
  3. When ACP respawns the Execution Plane, the `RunLedger.getUnresolvedRuns()` reads the WAL, detects a run that reached `PROCESSING` without `SETTLEMENT`, and holds the account locked in `UNCERTAIN`.
  4. The `ReconciliationDaemon` immediately triggers an out-of-band order history query against the bookmaker API.
  5. If the order is verified on the platform, status transitions to `COMPLETED`. If not verified after 120s, it marks `FAILED`. No double-bet is possible.

### Scenario 2: ACP sends a command but loses the acknowledgement
- **Mechanism**: ACP sends `TACTICAL:PLACE_BET` with `opId: 101`, Execution Plane processes and completes it, but the IPC pipe breaks before `OPERATION_RESULT` reaches ACP.
- **Contract Resolution**:
  1. ACP reconnects to the pipe.
  2. ACP re-sends a query envelope `TACTICAL:GET_OPERATION_STATUS` with `opId: 101` and `idempotencyKey`.
  3. Execution Plane resolves the result from its 24-hour LRU completion ledger and returns the cached `COMPLETED` result.
  4. The operation is never re-executed.

### Scenario 3: The same command is retried by ACP
- **Mechanism**: Network hiccup causes ACP retry logic to deliver identical `TACTICAL:PLACE_BET` twice.
- **Contract Resolution**:
  1. Execution Plane checks `idempotencyKey`.
  2. If the first command is currently `IN_FLIGHT`, the second command receives an immediate `OPERATION_ACK` with status `IN_FLIGHT` and no additional DOM interaction occurs.
  3. If the first command completed, the cached `OPERATION_RESULT` is returned.

### Scenario 4: The master browser dies
- **Mechanism**: The master Chromium browser crashes or is killed by OS OOM killer.
- **Contract Resolution**:
  1. `BrowserStateRegistry` catches process exit and emits `WORKER_BROKEN`.
  2. `HealthMonitor` immediately halts cluster automation and transitions engine to `DEGRADED`.
  3. `RecoveryManager.heal('master')` respawns the master browser, restores session cookies/DOM storage via `SessionManager`, navigates to last known URL, and re-injects `ActionDispatcher` listeners.
  4. If heal succeeds: Engine transitions back to `RUNNING`.
  5. If heal fails 3 times: Cluster stops with `LIFECYCLE:STATE_CHANGED` (`FAILED`).

### Scenario 5: One slave diverges
- **Mechanism**: `slave_1` gets stuck on a cloudflare challenge or navigates to an unexpected page while master is betting.
- **Contract Resolution**:
  1. `ConvergenceEngine` detects `ConvergenceDiverged` when `slave_1` DOM hash or URL fails to match master within timeout.
  2. `RecoveryManager` issues an isolated `CORRECTIVE_NAV` to `slave_1`.
  3. Master and other healthy slaves continue operating.
  4. `slave_1` is excluded from the next tactical bet until its GES counter catches up and convergence is achieved.

### Scenario 6: An account browser is logged out by the platform
- **Mechanism**: Bookmaker server invalidates session token mid-session.
- **Contract Resolution**:
  1. `BetCycle` checks `adapter.getSessionState()` during pre-flight.
  2. Detects `SESSION_EXPIRED`.
  3. Rejects operation with `status: FAILED`, `code: EP_AUTH_001`.
  4. `SessionManager` executes automated background re-login.
  5. If re-login fails, browser is quarantined and marked `Error`.

### Scenario 7: Proxy allocation fails
- **Mechanism**: Configured residential proxy is unreachable or authentication fails.
- **Contract Resolution**:
  1. If `Proxy.proxy_failure_mode == 'strict'`: Execution Plane refuses to launch the browser unprotected, failing initialization with `EP_AUTH_002`.
  2. If `Proxy.proxy_failure_mode == 'loose'`: Execution Plane logs critical warning and launches direct, reporting proxy status `UNPROTECTED` in `FLEET:BROWSER_STATUS`.

### Scenario 8: Initialization partially succeeds
- **Mechanism**: Master spawns, but 1 out of 3 slaves fails to spawn due to RAM exhaustion.
- **Contract Resolution**:
  1. `ClusterOrchestrator` catches slave spawn error.
  2. Evaluates whether minimum viable fleet exists (at least 1 master).
  3. Emits `LIFECYCLE:STATE_CHANGED` with `state: DEGRADED`, identifying the failed slave.
  4. ACP decides whether to proceed with reduced capacity or trigger `LIFECYCLE:STOP_CLUSTER`.

### Scenario 9: ACP reconnects with an older revision
- **Mechanism**: ACP crashed and hydrated an older cached state revision.
- **Contract Resolution**:
  1. Execution Plane includes `currentEngineRevision` in every heartbeat and response.
  2. If ACP detects Execution Plane revision > ACP hydrated revision, ACP requests authoritative snapshot `DIAGNOSTIC:CAPTURE_SNAPSHOT` and reconciles its state forward.

### Scenario 10: Events are missed across IPC
- **Mechanism**: Telemetry buffer overflows during rapid odds ticks.
- **Contract Resolution**:
  1. High-volume events (`ODDS_TICK`) are lossy and tagged with monotonic sequence numbers.
  2. Critical events (`OPERATION_RESULT`, `STATE_CHANGED`) use confirmed request/reply envelopes with retransmission queues.
  3. Missed sequence numbers in state deltas cause ACP to request an authoritative snapshot.

### Scenario 11: Execution Plane receives an unknown command
- **Mechanism**: Future ACP version sends a command unsupported by older Execution Plane.
- **Contract Resolution**:
  1. `CommandRouter` rejects unhandled command, logs warning with code `EP_CMD_001`.
  2. Execution Plane emits `PROTOCOL:UNKNOWN_COMMAND` with the rejected `msgId` and `type`.
  3. ACP catches rejection and disables that capability for the session.

### Scenario 12: Frontend requests an operation while Execution Plane is DEGRADED
- **Mechanism**: User clicks "Place Bet" on UI, but cluster is in recovery.
- **Contract Resolution**:
  1. ACP `CommandRouter` checks `runtimeManager.getEngineStatus()`.
  2. ACP immediately rejects request with HTTP 503 / `code: EXEC_001` (`Control Plane is in DEGRADED mode`).
  3. No envelope is sent to the Execution Plane, preventing further disruption during recovery.

### Scenario 13: Backend authorization changes while Execution Plane is running
- **Mechanism**: Cloud Backend revokes operator license mid-session.
- **Contract Resolution**:
  1. ACP `SecurityAuthority` detects revocation and synchronously sets `securityFacade.isDegraded() = true`.
  2. ACP immediately sends `LIFECYCLE:STOP_CLUSTER` to Execution Plane.
  3. ACP closes the named pipe and forces execution quarantine.

### Scenario 14: ACP restarts while automation is active
- **Mechanism**: ACP process crashes and restarts while Master browser was waiting for a bet confirmation.
- **Contract Resolution**:
  1. Execution Plane child process detects socket closure on its named pipe client.
  2. Execution Plane immediately enters safe-hold: halts all new physical actuations, freezes active runs, and maintains existing browser windows open.
  3. New ACP process boots, starts named pipe server.
  4. Execution Plane reconnects, performs HMAC handshake, and delivers complete snapshot of active leases and unresolved WAL runs.
  5. ACP and Execution Plane cleanly resynchronize without dropping or duplicating bets.

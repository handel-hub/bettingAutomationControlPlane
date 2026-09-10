# FRONTEND ↔ ACP BOUNDARY CONTRACT SPECIFICATION
## Forensic Boundary Audit, Architectural Interface & Protocol Standard

**Document Version:** 1.0.0  
**Specification Target:** Betting Automation System (`betting-automation-frontend` ↔ `bettingAutomationControlPlane`)  
**Date:** September 10, 2026  
**Status:** Authoritative Architectural Standard  
**Document Classification:** Internal Technical Contract  

---

# 1. Executive Summary & Architectural Verdict

This document establishes the binding, implementation-ready protocol and boundary contract between the **Frontend Console** (`betting-automation-frontend`) and the local **Automation Control Plane (ACP)** (`bettingAutomationControlPlane`).

### 1.1 The Fundamental Authority Triad
The product architecture comprises four discrete operating tiers with strictly non-overlapping authority:

1. **Cloud Backend (Business Authority)**: The ultimate, immutable server-side authority for user identity, authentication, subscriptions, billing plans, pricing catalogs, payment gateway verification (Flutterwave/Paystack), global bookmaker platform definitions, statutory licensing, customer support ticket persistence, and tenant entitlements. The ACP does not duplicate or invent business truth.
2. **ACP — Automation Control Plane (Runtime & Local Orchestration Authority)**: The local daemon process running on the operator's host/VPS (default HTTP/WS loopback on `127.0.0.1:8000`). The ACP is the authoritative linchpin between the Frontend, Cloud Backend, and local Execution Plane. It owns local runtime lifecycle state, live process spawner orchestration, proxy routing, credentials injection, offline persistent caching (via `better-sqlite3`), and the real-time calculation of operational capabilities exposed to the Frontend.
3. **Execution Plane (Automation Engine)**: The isolated browser automation runtime executing Playwright tasks. It operates in a separate process space communicating exclusively with the ACP over a private, attested native pipe / CDP proxy. It is completely isolated from, and invisible to, the Frontend.
4. **Frontend Console (Presentation & Interaction Plane)**: The Next.js 16 (React 19 / TypeScript / Zustand / Tailwind CSS) user interface. The Frontend is strictly a presentation and user-intent dispatching client. It owns local draft state, navigation, rendering, focus, animations, visual styling, and user interactions.

### 1.2 Non-Negotiable Boundary Prime Directives
* **Prime Directive 1 (Zero Client Business Logic)**: The Frontend shall never compute financial arithmetic, calculate VAT, evaluate discount percentages, parse subscription strings to determine access limits, or derive operational permissions.
* **Prime Directive 2 (Capabilities Override Heuristics)**: The Frontend shall never disable buttons or gate actions based on inspecting internal object states (e.g., checking `accounts.length >= 3` or `plan === 'Starter'`). The ACP computes and emits explicit boolean capabilities (e.g., `canStartAutomation: false`) accompanied by human-readable explanation strings (`startDisabledReason: "Starter plan account limit reached"`).
* **Prime Directive 3 (Zero Secret Exposure)**: Plaintext credentials (passwords, JWT signing secrets, proxy credentials, payment gateway keys) shall never cross from the ACP to the Frontend. Plaintext account passwords enter the ACP solely via initial registration commands, after which they are immediately vaulted and replaced by masked tokens (`[PROTECTED]`) across all snapshots and deltas.
* **Prime Directive 4 (Strict Loopback Isolation)**: The Frontend Console never communicates directly with the Cloud Backend or the Execution Plane. All operational commands, catalog queries, billing checkouts, and customer care interactions must route through the local ACP.
* **Prime Directive 5 (Pessimistic State Reconciliation)**: The Frontend must follow a pessimistic mutation UX for operational actions. Commands dispatch an intent, display an in-flight loading lock, and only reflect mutated state upon receipt of an authoritative ACK and state delta or snapshot from the ACP.

---

# 2. Phase 1 — Forensic Boundary Audit

A forensic inspection of the codebase was conducted across 119 frontend source files (`..\betting-automation-frontend`) and the complete ACP codebase (`c:\Users\John\Documents\CODE\back\bettingAutomationControlPlane`), analyzing existing contracts, stores, transport adapters, and routes.

### 2.1 Inventory of Existing Inter-Process Communication
The current system implements interactions through two primary mechanisms:
1. **REST Endpoints (`controlPlaneClient.ts` → `ApiServer`)**: 22 HTTP endpoints mounted across 7 domains (`/api/v1/automation`, `/api/v1/accounts`, `/api/v1/billing`, `/api/v1/settings`, `/api/v1/notifications`, `/api/v1/support`, `/api/v1/system`).
2. **WebSocket Stream (`wsServer.mjs` → `EventAdapter.ts`)**: A persistent duplex connection at `/ws/v1/events` streaming snapshots and deltas across 14 ad-hoc topics.
3. **Mock Transport (`MockControlPlane.ts`)**: An in-memory mock client embedded in the frontend used when `NEXT_PUBLIC_USE_REAL_CONTROL_PLANE !== 'true'`.

### 2.2 Forensic Discrepancy & Contradiction Matrix
The audit revealed critical architectural divergences between existing specifications and actual running implementations:

| Domain / Area | Documented Specification | Actual Implementation (Frontend/ACP) | Architectural Risk / Violation |
| :--- | :--- | :--- | :--- |
| **Initial Handshake** | Specification (`frontend-backend-acp-contract.md` §5.3) dictates a unified, atomic `app:prelude` snapshot containing all catalogs and states. | `wsServer.mjs` emits 6 separate, staggered topics (`app:state`, `automation:snapshot`, `billing:snapshot`, `settings:snapshot`, `accounts:view`, `customerCare:snapshot`). | **Race condition on startup**: UI renders partial state; catalogs (`billing:plans`, `platforms:registry`, `automation:strategy`) are omitted from initial WS handshake and require manual REST fetches. |
| **Credentials Exposure** | Zero credentials across boundary. | `useAccountsStore.ts` defines `accountPassword: string` on `AccountSnapshot`. ACP's `accountsRoutes.mjs` echos back the created account object. | **Critical Security Leak**: Passwords persisted in frontend Zustand memory; potential DOM/XSS exposure. |
| **Ingress Authentication** | ACP middleware `auth.mjs` enforces `ingressAuthMiddleware` (Bearer token or `X-ACP-Token`). | `controlPlaneClient.ts` in the frontend sends **no auth headers**, only `X-Request-Id`. | **Fragile Auth Boundary**: Only works because ACP has hardcoded test-mode bypasses (`NODE_ENV === 'test'`). In strict production mode, all frontend REST calls are rejected with 401. |
| **Tactical Bet Execution** | Async execution commands return 202 Accepted with tracking ID (`operationId`). | `controlPlaneClient.ts` issues `POST /operations/place-bet`, but does not listen for operation completion events. | **Orphaned In-Flight State**: Frontend cannot determine when Playwright finishes executing the tactical bet. |
| **Dropdown Catalogs** | Catalogs must be dynamic and backend-driven. | `GlobalConfigAccordion.tsx` hardcodes dropdown values (`PROFIT_TARGET`, `FIXED`, `loose`, `strict`, `chrome`, `firefox`). | **Rigid Business Coupling**: Backend changes to pricing strategies or supported browsers require rebuilding the frontend. |
| **Billing Gateway** | Backend is authoritative for billing. | `billingRoutes.mjs` in ACP contains Paystack webhook handlers (`x-paystack-signature`, `/webhook/paystack`). Frontend contains Flutterwave helpers (`src/utils/flutterwave.ts`). | **Domain Contamination**: ACP is acting as a payment gateway webhook receiver, which belongs entirely to the Cloud Backend. |
| **Error Taxonomy** | Structured machine-readable error codes. | Errors are returned as `{ error: string }` or plain strings, parsed in `controlPlaneClient.ts` via regex/fallback string checks. | **Brittle Error Handling**: UI presentation depends on human-readable string matching. |
| **Envelope Metadata** | RFC 8785 canonical envelopes with correlation IDs and monotonic revisions. | `wsServer.mjs` broadcasts `{ topic, timestamp, payload }`. Revisions and correlation IDs are omitted from live WS broadcasts. | **No Out-of-Order Detection**: Frontend cannot detect dropped or out-of-order delta events. |

---

# 3. Phase 2 — Boundary Responsibility & Authority Triad

The system enforces a strict demarcation of ownership across the boundary.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           CLOUD BACKEND                                   │
│  [Authority]: Identity, Multi-Tenant Billing, Plans, Invoices, Webhooks,  │
│               Platform Definitions, Support Persist, Entitlements         │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ mTLS / Signed Envelopes
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     AUTOMATION CONTROL PLANE (ACP)                        │
│  [Authority]: Runtime State, Host Process Lifecycle, Capabilities Eval,  │
│               Tactical Orchestration, Local Cache, Anti-Detect Stealth    │
└───────────────────┬───────────────────────────────────▲───────────────────┘
   Internal Pipe    │                                   │ HTTP REST & WS
   (Attested HMAC)  ▼                                   │ (Loopback 127.0.0.1)
┌───────────────────────────┐       ┌───────────────────┴───────────────────┐
│      EXECUTION PLANE      │       │           FRONTEND CONSOLE            │
│  [Authority]: Playwright, │       │  [Authority]: Presentation, Layout,   │
│  DOM Automation, CDP,     │       │  Draft State, Local Filters, Sorting, │
│  Browser Window Management│       │  User Intent Dispatching              │
└───────────────────────────┘       └───────────────────────────────────────┘
```

### 3.1 Frontend Responsibilities (Strictly Owned)
* **Presentation & Styling**: Design tokens, Tailwind CSS classes, responsive viewports, animations, and typography.
* **Navigation & View Routing**: URL routing (`/workspace/automation`, `/workspace/accounts`, etc.), breadcrumbs, and sidebar active states.
* **UI Component State**: Form draft state, open/close state of modals, active accordion tabs, local text input debouncing, focus management.
* **Presentation-Level Preferences**: UI theme (`light`, `dark`, `system`), table density (`comfortable`, `compact`), collapsed sidebar state.
* **Client-Side View Filtering & Sorting**: Instant UI search/filtering across loaded accounts, client-side column re-ordering.
* **Intent Construction**: Packaging operator input into structured command envelopes with unique client-generated `requestId`s.

### 3.2 ACP Responsibilities (Strictly Owned)
* **Runtime Lifecycle State**: Orchestration of automation states (`STOPPED`, `STARTING`, `RUNNING`, `STOPPING`, `ERROR_DEGRADED`).
* **Authoritative Capability Calculation**: Evaluating subscription tiers, account statuses, engine states, and network connectivity to emit atomic boolean flags (`canStartAutomation`, `canPlaceBet`, etc.).
* **Process Spawning & Execution Coordination**: Spawning, attesting, and monitoring headless/headful browser instances in the Execution Plane.
* **Pessimistic Intent Ingress**: Validating, routing, and executing command intents; rejecting invalid commands with standardized error codes.
* **Local State Cache & Hydration**: Storing and serving persisted state via SQLite, ensuring cold-boot recovery within 500ms without Cloud Backend round-trips.
* **Sanitization & Secret Masking**: Ensuring no plaintext passwords, payment secrets, or private keys cross the boundary to the Frontend.
* **Backend Communication**: Securely synchronizing local state with the Cloud Backend.

### 3.3 Cloud Backend Authority (Preserved Invariants)
* User authentication credentials, password hashing, and session issuance.
* Canonical billing tiers, catalog prices, statutory taxes, and subscription invoices.
* Payment gateway webhook settlement.
* Long-term license validity and multi-device seat allowances.

---

# 4. Phase 3 & 4 — Standard Message Envelope & Protocol Surface

To eliminate ad-hoc messaging and support deterministic end-to-end tracing, all communications across the Frontend ↔ ACP boundary use a standardized protocol envelope.

### 4.1 Message Envelopes

#### 4.1.1 Inbound Client Request Envelope (REST & WebSocket Command)
```typescript
interface ClientRequestEnvelope<T = unknown> {
  protocolVersion: "2.0";
  messageId: string;       // ULID generated by Frontend
  correlationId: string; // Tracing ID (propagated across all subsequent ACKs/events)
  timestamp: string;     // ISO 8601 UTC
  sessionToken?: string; // ACP Ingress Session Token
  category: "Execution" | "Persistence" | "Security" | "Billing" | "System";
  type: string;          // Action identifier (e.g., "START_AUTOMATION")
  payload: T;
}
```

#### 4.1.2 Outbound ACP Response / Acknowledgement Envelope (HTTP & WebSocket ACK)
```typescript
interface ServerResponseEnvelope<T = unknown> {
  protocolVersion: "2.0";
  messageId: string;       // ULID generated by ACP
  correlationId: string; // Echoes the request messageId/correlationId
  causationId: string;   // The request messageId that triggered this response
  timestamp: string;     // ISO 8601 UTC
  status: "ACCEPTED" | "COMPLETED" | "REJECTED" | "REQUIRES_STEP_UP" | "ERROR";
  revision: number;      // Monotonic state revision after applying this mutation
  data?: T;
  error?: ProtocolError;
}
```

#### 4.1.3 Outbound ACP Event / Delta Envelope (WebSocket Broadcast)
```typescript
interface ServerEventEnvelope<T = unknown> {
  protocolVersion: "2.0";
  messageId: string;       // ULID generated by ACP
  correlationId?: string;// Linked command correlationId if triggered by an intent
  timestamp: string;     // ISO 8601 UTC
  topic: string;         // Domain topic (e.g., "automation:delta", "accounts:delta")
  revision: number;      // Monotonic domain revision counter
  payload: T;
}
```

### 4.2 Complete Protocol Surface: Operations Directory

The boundary protocol defines exactly 24 operations spanning 7 functional domains.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PROTOCOL SURFACE DIRECTORY                                           │
├───────────────────┬────────────────────────────────────────────┬───────────┬──────────────┬────────────┤
│ Domain            │ Operation Name                             │ Transport │ Type         │ Authority  │
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 1. System/Prelude │ system:getPreludeSnapshot                  │ HTTP / WS │ Query        │ ACP        │
│                   │ system:streamEvents                        │ WS        │ Subscription │ ACP        │
│                   │ system:restartAndUpdate                    │ HTTP      │ Command      │ ACP        │
│                   │ system:heartbeat (PING/PONG)               │ WS        │ Query        │ ACP        │
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 2. Automation     │ automation:getSnapshot                     │ HTTP      │ Query        │ ACP        │
│                   │ automation:getStrategyCatalog              │ HTTP      │ Query        │ Cloud (ACP)│
│                   │ automation:start                           │ HTTP / WS │ Command      │ ACP        │
│                   │ automation:stop                            │ HTTP / WS │ Command      │ ACP        │
│                   │ automation:placeBet                        │ HTTP / WS │ Command      │ Execution  │
│                   │ automation:cashOut                         │ HTTP / WS │ Command      │ Execution  │
│                   │ automation:validate                        │ HTTP / WS │ Command      │ Execution  │
│                   │ automation:toggleBetCycle                  │ HTTP / WS │ Command      │ ACP        │
│                   │ automation:updateGlobalConfig              │ HTTP      │ Command      │ ACP        │
│                   │ automation:updateAccountConfig             │ HTTP      │ Command      │ ACP        │
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 3. Accounts       │ accounts:getView                           │ HTTP      │ Query        │ ACP        │
│                   │ accounts:register                          │ HTTP      │ Command      │ ACP        │
│                   │ accounts:action (Activate/Deactivate/Del)  │ HTTP      │ Command      │ ACP        │
│                   │ accounts:bulkAction                        │ HTTP      │ Command      │ ACP        │
│                   │ accounts:getPlatformRegistry               │ HTTP      │ Query        │ Cloud (ACP)│
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 4. Billing        │ billing:getSnapshot                        │ HTTP      │ Query        │ Cloud (ACP)│
│                   │ billing:getPlansCatalog                    │ HTTP      │ Query        │ Cloud (ACP)│
│                   │ billing:initializeCheckout                 │ HTTP      │ Command      │ Cloud      │
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 5. Settings       │ settings:getSnapshot                       │ HTTP      │ Query        │ ACP/Cloud  │
│                   │ settings:dispatchIntent (Step-Up Guarded)  │ HTTP      │ Command      │ ACP/Cloud  │
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 6. Notifications  │ notifications:getSnapshot                  │ HTTP      │ Query        │ ACP        │
│                   │ notifications:markRead / markAllRead       │ HTTP      │ Command      │ ACP        │
│                   │ notifications:clear                        │ HTTP      │ Command      │ ACP        │
├───────────────────┼────────────────────────────────────────────┼───────────┼──────────────┼────────────┤
│ 7. Customer Care  │ support:getSnapshot                        │ HTTP      │ Query        │ Cloud (ACP)│
│                   │ support:createTicket                       │ HTTP      │ Command      │ Cloud      │
└───────────────────┴────────────────────────────────────────────┴───────────┴──────────────┴────────────┘
```

---

# 5. Phase 5 — State Synchronization & Reconciliation Model

The Frontend must never infer, reconstruct, or calculate whether state is authoritative. State synchronization follows an atomic bootstrap, delta stream, and monotonic revision model.

### 5.1 Cold-Boot Hydration: The Atomic Prelude
Upon establishing connection to the ACP (HTTP or WebSocket), the Frontend requests or receives the atomic **Prelude Snapshot** (`app:prelude`). This single payload contains all domain states and catalogs required to render the full UI immediately without cascading HTTP requests:

```typescript
interface PreludeSnapshot {
  protocolVersion: "2.0";
  snapshotTimestamp: string;
  appState: ApplicationState; // "Authorized" | "Degraded" | "Payment_Required" etc.
  userSession: {
    userId: string;
    operatorName: string;
    email: string;
    licenseStatus: "VALID" | "GRACE_PERIOD" | "EXPIRED";
  };
  revisions: {
    automation: number;
    accounts: number;
    billing: number;
    settings: number;
    notifications: number;
    catalogs: number;
  };
  automationWorkspace: AutomationWorkspaceSnapshot;
  accountsView: AccountsViewPayload;
  billingSnapshot: BillingSnapshot;
  subscriptionPlansCatalog: SubscriptionPlansCatalog;
  platformRegistry: PlatformRegistrySnapshot;
  strategyCatalog: AutomationStrategyCatalog;
  settingsSnapshot: SettingsSnapshot;
  customerCareSnapshot: CustomerCareSnapshot;
  notifications: {
    unreadCount: number;
    items: AppNotification[];
  };
  systemUpdate: {
    appName: string;
    currentVersion: string;
    hasUpdateDownloaded: boolean;
    availableVersion?: string;
  };
}
```

### 5.2 Monotonic Domain Revisions
Every domain in ACP maintains an integer revision counter that increments on every mutation.
* When ACP emits an update delta (e.g., `automation:delta`), it attaches `revision: R_new`.
* The Frontend verifies `R_new === R_current + 1`.
* If `R_new > R_current + 1`, the Frontend detects a **dropped packet/gap** and immediately requests an authoritative domain snapshot to reconcile.
* If `R_new <= R_current`, the Frontend discards the message as a stale/duplicate transmission.

### 5.3 Pessimistic Mutation UX Protocol
Every user action that modifies operational state must follow this sequence:

```
 Operator Click        Frontend Store           Control Plane Client             ACP Daemon
       │                     │                            │                          │
       │─── Click Action ───>│                            │                          │
       │                     │── Set inFlight = true ────>│                          │
       │                     │   (Button Disabled/Spin)   │                          │
       │                     │                            │─── POST Intent Envelope ─>│
       │                     │                            │    (with correlationId)  │
       │                     │                            │                          │── Execute / Validate
       │                     │                            │                          │── Persist / Mutate
       │                     │                            │<── 200/202 Response ─────│
       │                     │                            │    (ACK with revision)   │
       │                     │<── Resolve Promise ────────│                          │
       │                     │    (Update In-Flight)      │                          │── Broadcast WS Delta
       │                     │                            │                          │   (topic, revision)
       │                     │<══════════ WS Server Broadcast Delta ═════════════════│
       │                     │── Apply Authoritative Delta│                          │
       │<── Render Success ──│   (inFlight = false)       │                          │
```

---

# 6. Phase 6 — Capability-Driven Interaction Contract

The Frontend never inspects data attributes to decide whether an interaction is permitted. The ACP evaluates all business rules, plan limits, engine readiness, and database consistency to provide explicit, localized capability flags.

### 6.1 Automation Capabilities Schema
```typescript
interface AutomationCapabilities {
  // Global Lifecycle Actions
  canStartAutomation: boolean;
  startDisabledReason?: string;
  canStopAutomation: boolean;
  stopDisabledReason?: string;

  // Tactical Operations
  canPlaceBet: boolean;
  placeBetDisabledReason?: string;
  canCashOut: boolean;
  cashOutDisabledReason?: string;
  canValidate: boolean;
  validateDisabledReason?: string;

  // Account Management in Automation
  canActivateAccount: boolean;
  activateAccountDisabledReason?: string;
  canDeactivateAccount: boolean;
  deactivateAccountDisabledReason?: string;
  canToggleBetCycle: boolean;
  toggleBetCycleDisabledReason?: string;

  // Runtime Tuning Limits
  canIncreaseBrowserCount: boolean;
  canDecreaseBrowserCount: boolean;
  canEditPricing: boolean;
  canEditRisk: boolean;
  canEditRebet: boolean;
  canEditProxy: boolean;
  canEditExecution: boolean;
}
```

### 6.2 Per-Account Action Capabilities Contract
Every account object in both the Accounts Table and Automation Workspace includes explicit action contracts:
```typescript
interface AccountActionContract {
  id: "ACTIVATE" | "DEACTIVATE" | "DELETE" | "TOGGLE_BET_CYCLE";
  label: string;
  disabled: boolean;
  disabledReason?: string;
  variant: "default" | "danger";
}
```

### 6.3 Capability Invalidation & Refresh Rules
Capabilities are dynamically re-evaluated and emitted by the ACP whenever:
1. Engine lifecycle changes (`STOPPED` ↔ `STARTING` ↔ `RUNNING`).
2. Degraded mode is entered (e.g., Cloud Backend unreachable or licensing check fails). In degraded mode, all execution capabilities (`canStartAutomation`, `canPlaceBet`, `canCashOut`) become `false` with `disabledReason: "System in DEGRADED quarantine mode"`.
3. Account quota is saturated (e.g., active accounts reach subscription tier limit).

---

# 7. Phase 7 — Business Data Classification & Residency Matrix

Every data category crossing the boundary has an assigned authority, mutability, and residency lifecycle:

| Data Domain | Canonical Authority | ACP Residency | Frontend Residency | Secret Masking Rule | Stale Tolerance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **User Credentials** | Cloud Backend | None (Transient token) | Transient Form | Never persisted; never logged | Zero |
| **Account Passwords** | Cloud / Local Vault | Encrypted in Security DB | Transient Form on Register | **REPLACED WITH `[PROTECTED]`**. Never returned to UI | Zero |
| **Betting Balances** | Bookmaker DOM (ACP) | Cached in SQLite | Read-only in Zustand | Plaintext number | 30 seconds TTL |
| **Subscription Plans**| Cloud Backend | Cached in SQLite | Catalog Cache | Public data | 24 hours TTL |
| **Billing Invoices** | Cloud Backend | Cached in SQLite | Ledger Cache | Redacted card details (`last4`) | 1 hour TTL |
| **Execution State** | ACP Runtime | Authoritative Memory | Reactive Zustand | N/A | Zero (Realtime WS) |
| **Global Config** | ACP StateStore | SQLite Persistence | Reactive Store | Plaintext settings | Indefinite (Synced) |
| **Support Tickets** | Cloud Backend | Memory / Passthrough | Ticket Store | Sanitized text | 5 minutes TTL |
| **System Alerts** | ACP Engine / Cloud | SQLite Cap 100 FIFO | Reactive Notification Store| Masked system paths | Indefinite |

---

# 8. Phase 8 & 9 — Automation Workspace & Tactical Execution Contract

The Automation Workspace represents the core operational loop. The Frontend must coordinate execution without knowing any Playwright, browser process, or CDP internals.

### 8.1 Tactical Operations State Machine
Tactical operations (`PLACE_BET`, `CASH_OUT`, `VALIDATE`) are asynchronous multi-stage operations.

```
Frontend                    ACP CommandRouter              OperationTracker            Execution Plane
   │                               │                              │                           │
   │── POST /operations/place-bet ─>│                              │                           │
   │   { marketId, odds, stake }   │── startOperation() ─────────>│                           │
   │                               │   (status: QUEUED)           │                           │
   │<── 202 Accepted ──────────────│                              │                           │
   │    { operationId, status }    │                              │                           │
   │                               │── ExecutionEnvelope (ULID) ─────────────────────────────>│
   │<══ WS: GLOBAL_ACTION_PENDING ═│                                                          │
   │    (globalActionPending: 'PLACING_BET')                                                  │
   │                               │                              │<── NativePipe Progress ───│
   │<══ WS: OPERATION_PROGRESS ════│<── updateOperation() ────────│   (Navigating, Staking)   │
   │    (stage: 'Submitting')      │                              │                           │
   │                               │                              │<── NativePipe Complete ───│
   │<══ WS: OPERATION_COMPLETED ═══│<── completeOperation() ──────│   (Bet Slip Confirmed)    │
   │    { status: 'SUCCESS', ... } │                              │                           │
   │<══ WS: GLOBAL_ACTION_PENDING ═│                              │                           │
   │    (globalActionPending: null)│                              │                           │
```

### 8.2 Invariant: Bet Cycle Toggle vs Browser Lifetime
* Toggling `betCycleEnabled: false` on an account instructs the automation logic to skip market execution for that account.
* **It does NOT kill, stop, or close the Playwright browser process.** The browser remains alive, authenticated, and maintaining active session cookies with the bookmaker.
* Terminating browser processes is strictly controlled by `DEACTIVATE_ACCOUNT` or global `STOP_AUTOMATION`.

---

# 9. Phase 10 — Standardized Error Taxonomy

Human-readable strings must never be parsed by code to determine error behavior. All errors across HTTP and WebSocket envelopes adhere to the `ProtocolError` schema.

### 9.1 Protocol Error Schema
```typescript
interface ProtocolError {
  code: string;         // Standard Machine Code (e.g. "CAP_001", "VAL_102")
  domain: "AUTH" | "CAPABILITY" | "STATE" | "VALIDATION" | "EXECUTION" | "BACKEND";
  message: string;      // Human-readable localized explanation for UI display
  field?: string;       // Specific payload field if validation error
  retryable: boolean;   // True if the client can safely retry the exact request
  details?: Record<string, unknown>;
}
```

### 9.2 Error Code Registry
| Code | Domain | HTTP Status | Description | Required Frontend Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `AUTH_001` | `AUTH` | 401 | Missing or invalid ACP ingress token | Prompt operator for ACP authentication / reconnect |
| `AUTH_002` | `AUTH` | 403 | Session revoked or expired | Force navigation to login splash screen |
| `AUTH_003` | `AUTH` | 403 | Step-Up authentication challenge required | Render `StepUpModal` requesting password/MFA |
| `CAP_001` | `CAPABILITY` | 403 | Action denied by capability guard | Display `disabledReason` in toast notification |
| `CAP_002` | `CAPABILITY` | 403 | Plan quota exceeded | Display upgrade prompt modal to operator |
| `STATE_001`| `STATE` | 409 | OCC Revision conflict (stale state) | Refresh domain snapshot and re-apply draft |
| `STATE_002`| `STATE` | 409 | Invalid lifecycle transition | Sync UI with current `lifecycle` state |
| `VAL_001` | `VALIDATION` | 400 | Missing required schema field | Highlight invalid form input field |
| `VAL_002` | `VALIDATION` | 400 | Zero-secret violation (plaintext key detected)| Reject intent immediately; clear sensitive form field |
| `EXEC_001` | `EXECUTION` | 503 | Execution Plane unavailable / crashed | Display degraded alert banner; lock tactical buttons |
| `EXEC_002` | `EXECUTION` | 504 | Tactical execution timed out | Clear in-flight spinner; offer retry button |
| `BACK_001` | `BACKEND` | 502 | Cloud Backend unreachable (Offline Grace) | Switch UI status indicator to "Offline Grace" |

---

# 10. Phase 11 & 12 — Connection Lifecycle, Session Management & Security

### 10.1 Connection & Handshake Lifecycle
1. **HTTP Discovery**: Frontend probes `GET /api/v1/system/version`. ACP returns system metadata and version negotiation status.
2. **WebSocket Upgrade**: Frontend connects to `ws://127.0.0.1:8000/ws/v1/events` providing the session token in the connection handshake (`Authorization` or `Sec-WebSocket-Protocol`).
3. **Atomic Prelude Dispatch**: Upon connection validation, ACP immediately transmits `app:prelude` containing the complete initial state and catalogs.
4. **Heartbeat Liveness**: Every 30 seconds, Frontend emits `system:ping`. ACP replies with `system:pong` including its current memory RSS and engine status.
5. **Connection Interruption & Backoff**: On disconnect, Frontend marks status `Disconnected` and executes exponential backoff reconnects (1s, 2s, 4s, up to 10s).
6. **Re-synchronization on Reconnect**: Upon reconnection, the Frontend issues `system:getPreludeSnapshot` to refresh all state atomically, eliminating stale delta accumulation.

### 10.2 Localhost Security Boundaries
* **Loopback Binding**: The ACP HTTP/WS server binds strictly to `127.0.0.1` (never `0.0.0.0`), preventing external local network access.
* **Origin Verification**: Inbound CORS headers validate the `Origin` header against an allowlist (`http://localhost:3000`, `http://127.0.0.1:3000`).
* **Session Association**: Ingress requests must supply an `X-ACP-Token` or session cookie created during initial setup.
* **DNS Rebinding Defense**: Host headers are strictly validated to prevent browser-based DNS rebinding exploits.

---

# 11. Phase 13 & 14 — Versioning, Compatibility & Protocol Observability

### 11.1 Versioning Strategy
* **Contract Version**: `v2.0.0` (SemVer).
* **Additive Evolution Rule**: Any new attributes added to payloads or envelopes must be optional.
* **Unknown Field Resilience**: Both Frontend decoders and ACP validators must ignore or pass through unrecognized JSON keys without throwing syntax or deserialization exceptions.
* **Protocol Negotiation**: The initial version check (`GET /api/v1/system/version`) confirms protocol compatibility. If major versions mismatch (`protocolVersion !== 2`), the Frontend displays a hard blocking version update screen.

### 11.2 Distributed Tracing & Observability
* Every frontend-initiated action generates a unique `correlationId` (e.g., `req_01M24D1BEEGGZ64P0Z1VRYDDHH`).
* This ID is logged by `pino` in the ACP and carried through to the Execution Plane via `ExecutionEnvelope`.
* Any resulting WebSocket deltas or error envelopes echo this `correlationId`, allowing the Frontend to correlate background events directly with user actions.

---

# 12. Phase 15 — Master Contract Invariants & Forbidden Behaviors

### 12.1 Non-Negotiable Contract Invariants
1. **Frontend is Never the Business Authority**: The Frontend displays state, dispatches intents, and enforces no monetary, pricing, or subscription calculations.
2. **Frontend Never Communicates Directly with Execution Plane**: Zero direct sockets, pipes, or Playwright calls from the Frontend.
3. **Frontend Never Determines Licensing Authority**: Licensing and account limits are enforced exclusively by the Cloud Backend and verified by the ACP.
4. **Frontend Never Infers Truth from Stale Presentation**: Capabilities emitted by ACP supersede all UI calculations.
5. **ACP Never Invents Backend Truth**: ACP caches, mirrors, and enforces Cloud Backend rules; it never synthesizes fake subscription approvals or invoices.
6. **Commands Have Explicit ACK Semantics**: Every mutating command returns an immediate ACK with a monotonic revision and tracking ID.
7. **Monotonic Revisions**: Revisions within a domain must increase strictly monotonically (`R_new = R_old + 1`).
8. **Credentials Never Cross to Frontend**: Plaintext account passwords, private keys, and session secrets are permanently redacted in all responses and events.
9. **Machine Errors are Distinct from Human Messages**: All error responses carry a machine-readable `code` and `domain`.
10. **Independent Testability**: Both Frontend and ACP can be 100% verified using isolated mock fixtures implementing only this specification.

### 12.2 Explicitly Forbidden Behaviors
* **FORBIDDEN**: Frontend calculating `vat = total * 0.075` or `discount = price * 0.20`.
* **FORBIDDEN**: Frontend parsing `account.statusDescription` with regex to determine if the account can be activated.
* **FORBIDDEN**: ACP returning unmasked `accountPassword` in `AccountSnapshot` or `accounts:delta`.
* **FORBIDDEN**: Frontend executing optimistic mutations on tactical actions (`PLACE_BET`, `CASH_OUT`) before ACP acknowledges.
* **FORBIDDEN**: ACP treating `betCycleEnabled: false` as an instruction to kill the underlying browser process.
* **FORBIDDEN**: Frontend communicating directly with third-party payment gateways or bookmaker websites.
* **FORBIDDEN**: Discarding correlation IDs across asynchronous event chains.

---

# 13. Hostile Architectural Review

A hostile self-critique was conducted to identify edge-case vulnerabilities, ambiguities, and potential implementation pitfalls:

### 13.1 Potential Vulnerability: The "Double In-Flight" Race
* *Vulnerability*: The operator rapidly double-clicks "Start Automation". If the network latency is high, two `START_AUTOMATION` intents could be in flight.
* *Resolution in Contract*: Frontend enforces local immediate UI lock (`inFlight = true`) on click. Additionally, ACP `commandRouter` enforces idempotent deduplication using `correlationId` and rejects concurrent state transitions with `STATE_002: Invalid lifecycle transition (Already starting)`.

### 13.2 Potential Ambiguity: Tactical Bet Outcome Notification
* *Ambiguity*: In REST `POST /operations/place-bet`, the server returns `202 Accepted` with an `operationId`. If the WebSocket drops before the bet completes, how does the Frontend learn the outcome?
* *Resolution in Contract*: On reconnect, the atomic `app:prelude` or `automation:getSnapshot` contains `recentOperations: OperationState[]`. The Frontend reconciles pending operation IDs against this list to discover whether the bet succeeded or failed while disconnected.

### 13.3 Potential Leak: Password in Error Details
* *Vulnerability*: A validation error during account creation could accidentally stringify the request payload into an error log or response message.
* *Resolution in Contract*: ACP's `SanitizerGate` and `PayloadValidators` must sanitize payloads *before* logging or generating error descriptors, guaranteeing passwords never appear in error objects.

### 13.4 Architectural Completeness Verdict
This specification completely resolves all ambiguities between the presentation layer, control daemon, and execution runtime. Two independent engineering teams can implement the Next.js Frontend and the Node.js ACP against this document and achieve flawless interoperability without consulting one another.

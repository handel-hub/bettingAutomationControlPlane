Absolutely. With the clarification that **keyboard triggers are not part of the Workspace UI**, the requirements become much cleaner.

# Automation Workspace — Complete V1 Requirements

## 1. Purpose

The **Automation Workspace** is the operational control surface for the existing predefined automation engine.

Its purpose is to allow the user to:

1. Configure automation behavior.
2. See the current automation state.
3. See which accounts/browsers are being used.
4. Activate/deactivate accounts during operation.
5. Control per-account participation in betting cycles.
6. Start and stop the entire automation run.
7. Trigger predefined global automation operations such as **Place Bet**, **Cash Out**, and **Validate**.
8. Configure pricing, rebet/rebate, risk, proxy, execution, and relevant runtime parameters.

It is **not an automation builder**.

---

# 2. Global Automation Lifecycle

The Workspace must provide global lifecycle controls.

### Start Automation

A prominent **Start Automation** button.

Its meaning is:

> Start the automation system using the currently configured and eligible accounts/resources.

The frontend does not determine whether Start is currently valid. ACP provides the authoritative capability.

### Stop Automation

A prominent **Stop Automation** button.

Its meaning is:

> Stop the entire automation run.

Stopping the automation is a **global lifecycle operation**.

It is not equivalent to deactivating an individual account.

---

# 3. Global Automation State

The Workspace must visibly communicate the authoritative automation state.

The exact state machine is to be established during architecture/design, but it needs to distinguish at least the conceptual states:

```text
NOT_RUNNING
STARTING
RUNNING
STOPPING
STOPPED
```

The UI must not infer these states merely from button clicks.

---

# 4. Global Predefined Automation Actions

The Workspace must expose the predefined operations as **UI buttons**, not keyboard-trigger configuration.

Known actions include:

```text
[ Place Bet ]
[ Cash Out ]
[ Validate ]
```

Additional predefined actions may be exposed if they are confirmed as part of V1.

### Global semantics

These actions are **not account-specific buttons**.

For example:

```text
[ Cash Out ]
```

means:

> Initiate the predefined cashout operation for the applicable automation population.

It does **not** mean:

```text
Cash Out Account A
Cash Out Account B
Cash Out Account C
```

The execution system determines which active/eligible browsers/accounts participate.

### Place Bet

The Workspace provides a global **Place Bet** button.

The action initiates the predefined betting workflow.

Per-account participation is subsequently governed by each account's `betCycleEnabled` state.

### Cash Out

The Workspace provides a global **Cash Out** button.

Clicking it initiates the predefined cashout workflow across the applicable running automation population.

### Validate

The Workspace provides a global **Validate** button if validation is confirmed as an exposed V1 operation.

---

# 5. Keyboard Shortcuts Are Not Workspace Requirements

The existing configuration contains keyboard shortcuts such as:

```text
V
C
B
1
2
```

These should **not** be represented as Workspace controls or per-account configuration.

They are an existing execution/trigger mechanism.

The Workspace's user-facing mechanism is:

```text
UI Button
    ↓
ACP Intent
    ↓
Execution Plane
    ↓
Predefined Workflow
```

rather than:

```text
Keyboard Shortcut
    ↓
Execution
```

The exact underlying keyboard-trigger implementation may remain in the execution system if required for compatibility, but it is not part of the Workspace experience.

---

# 6. Account Usage

The Workspace must show which existing accounts are currently participating in the automation environment.

For each account, the user should be able to understand:

- Account identity.
- Whether the account is active.
- Whether its browser is running.
- Whether it is currently being used by automation.
- Its betting-cycle participation state.
- Relevant operational state.

The Workspace does **not** create or validate accounts.

Only accounts already made eligible by the broader system can be used.

---

# 7. Account Activation

The Workspace must allow eligible existing accounts to be activated for automation.

Activation means:

> Make this account available as an active automation participant and provision/use its associated browser execution resource.

Activation must respect all execution/resource constraints.

---

# 8. Account Deactivation

The Workspace must allow an active account to be deactivated.

Deactivation means:

> Remove this account from active automation and terminate its associated browser execution resource.

For example:

```text
Account B
    ↓
Deactivate
    ↓
Browser B shuts down
    ↓
Account B leaves active automation
```

This does **not** stop the entire automation run.

Other accounts continue operating.

---

# 9. Distinction Between Deactivation and Bet-Cycle Disable

This distinction is a fundamental V1 requirement.

### Deactivate Account

```text
Account
    ↓
No longer participating in automation
    ↓
Browser can be shut down
```

### Bet Cycle OFF

```text
Account
    ↓
Remains active
    ↓
Browser remains available
    ↓
Excluded from betting cycles
```

These must not be represented as the same operation.

---

# 10. Per-Account Bet Cycle Control

Every active account must have an independent:

```text
betCycleEnabled: boolean
```

with two states:

```text
ON
OFF
```

The Workspace visually exposes this as a toggle/control.

Example:

```text
Account A       Bet Cycle [ ON  ]
Account B       Bet Cycle [ OFF ]
Account C       Bet Cycle [ ON  ]
```

### ON

The account is eligible to participate when a betting cycle occurs.

### OFF

The account remains active but must not participate in betting cycles.

### Default

The default state for an account entering active automation is:

```text
betCycleEnabled = true
```

unless authoritative system state dictates otherwise.

---

# 11. Bet-Cycle Semantics

When a global Place Bet operation occurs, the execution system evaluates the authoritative account participation state.

For example:

```text
Account A → ON
Account B → OFF
Account C → ON
```

The resulting betting population is:

```text
A ✓
B ✗
C ✓
```

The frontend does not implement the betting decision itself.

It merely represents and modifies the authoritative participation state.

---

# 12. Browser/Execution Capacity

The Workspace must represent active browser capacity.

Accounts correspond to active Playwright/browser execution resources.

The system must respect execution-plane resource invariants.

For example, if five browser instances are currently provisioned:

```text
5 active
```

the user may be allowed to reduce this:

```text
5 → 4
4 → 3
```

during a run.

But increasing capacity while automation is running should not be permitted if doing so violates system invariants.

Therefore the Workspace must expose **authoritative capabilities** rather than blindly allowing arbitrary increases/decreases.

---

# 13. Browser Deactivation / Reduction

The Workspace must support reducing active browser/account participation during automation.

Deactivating the corresponding account should cause its browser execution resource to be terminated according to the execution system's lifecycle rules.

The remaining automation continues.

---

# 14. Pricing Configuration

The Workspace must expose the pricing parameters supported by the existing automation engine.

Current known model:

```text
Pricing Strategy
├── Mode
├── Base Stake
├── Target Profit
├── Minimum Acceptable Profit
└── Resolution Strategy
```

Supported conceptual modes:

```text
FIXED
PROFIT_TARGET
```

For fixed pricing:

```text
BaseStake
```

For profit-target pricing:

```text
TargetProfit
MinimumAcceptableProfit
ResolutionStrategy
```

Known resolution strategy:

```text
CLAMP_THEN_REDUCE_PROFIT
```

with the possibility of:

```text
ABORT
```

where supported by the existing engine.

The Workspace must not invent a new pricing model.

---

# 15. Pricing Behaviour

Existing pricing behavior includes:

```text
PlatformIncrement
SelectionPreference
RestorePolicyOnRebet
```

Current configuration:

```text
PlatformIncrement = 1
SelectionPreference = ROUND_NUMBERS
RestorePolicyOnRebet = true
```

Whether every parameter is user-editable or some remain advanced/internal must be determined during design.

---

# 16. Rebet/Rebate Configuration

The Workspace must represent the existing rebet/rebate behavior.

Known configuration:

```text
MaxRebetAttempts = 3
```

and:

```text
RestorePolicyOnRebet = true
```

The final terminology—**Rebet**, **Rebate**, or another product-facing term—should be deliberately standardized against the actual engine semantics.

---

# 17. Risk Management

The Workspace must account for the existing risk-management parameters:

```text
AutoAcceptOddsChanges
MaxStake
MinimumStake
AbortOnMarketSuspend
```

Current values:

```text
AutoAcceptOddsChanges = false
MaxStake = 10000
MinimumStake = 10
AbortOnMarketSuspend = true
```

These are execution/business constraints rather than generic automation features.

---

# 18. Execution Configuration

The existing execution configuration includes:

### Timeouts

```text
ResultTimeoutMs = 30000
NavigationTimeoutMs = 10000
LoginTimeoutMs = 15000
DecisionFreshnessTTLMs = 3000
ReconciliationTimeoutMs = 120000
```

### Pacing

```text
KeyboardTypingDelayMs = 250
```

The current pacing value exists for reasons related to the existing application/runtime behavior and should not be casually altered merely for UI purposes.

---

# 19. Execution Retry and Recovery

Existing configuration:

```text
MaxExecutionRetries = 3
MaxRecoveryAttempts = 3
RecoveryBaseDelayMs = 2000
```

The Workspace architecture must account for these execution behaviors.

Whether they are directly user-configurable, advanced settings, or internal execution configuration must be established during the architecture phase.

---

# 20. Action Recording / Replay

The existing automation supports action recording/replay.

Current configuration:

```text
record_action_sequence = true
replay_action_sequence = true
```

The Workspace architecture must account for this capability.

The workshop should determine whether these are:

- user-configurable,
- advanced settings,
- status-only,
- or entirely internal.

---

# 21. Recorded Action Limit

The execution system currently has:

```text
MaxRecordedActions = 1000
```

This should be represented in the configuration model where appropriate.

---

# 22. Spawning Configuration

Existing spawning configuration:

```text
max_accounts_to_spawn = 2
slave_mode = headful
master_use_proxy = false
debug_slow_mo = 0
```

The Workspace architecture must account for these runtime constraints.

In particular:

```text
max_accounts_to_spawn = 2
```

must interact correctly with account/browser capacity.

---

# 23. Proxy Configuration

The Workspace must account for the existing proxy model.

Current configuration:

```text
proxy_failure_mode = loose
proxy_allocation_mode = round_robin
max_accounts_per_proxy = 5
```

The proxy system must remain consistent with:

- account activation,
- account deactivation,
- browser spawning,
- maximum account capacity.

---

# 24. Browser Runtime / Anti-Detection Configuration

Existing runtime configuration includes:

```text
use_stealth_plugin = false
browser_binary = chrome
randomize_user_agent = false
block_webrtc = false
match_proxy_timezone = true
canvas_spoofing = false
```

These must be accounted for architecturally.

However, **the existence of these engine parameters does not automatically make them Workspace UI controls**.

The architecture workshop must determine which are:

- normal user settings,
- advanced settings,
- system-managed settings,
- or execution-internal settings.

---

# 25. Capability-Driven Controls

The Workspace must be capability-driven.

ACP should expose authoritative capabilities such as, conceptually:

```text
canStartAutomation
canStopAutomation

canActivateAccount
canDeactivateAccount

canIncreaseBrowserCount
canDecreaseBrowserCount

canToggleBetCycle

canPlaceBet
canCashOut
canValidate

canEditPricing
canEditRebet
canEditRisk
canEditProxy
```

This list is **conceptual and should be audited before freezing**.

The frontend must not independently derive authoritative permissions.

For example, it should not decide:

```text
if (running && accounts.length < max)
    show Activate
```

Instead:

```text
ACP
 ↓
capabilities
 ↓
Frontend
 ↓
render available operation
```

---

# 26. Pessimistic Operational UX

Operational mutations follow the established pessimistic model.

Example:

```text
User clicks Cash Out
        ↓
Button → Processing
        ↓
Intent sent to ACP
        ↓
ACP processes operation
        ↓
Authoritative acknowledgement/state
        ↓
UI reconciles
```

Controls must not remain freely clickable while an operation is awaiting authoritative resolution if that could create duplicate/conflicting operations.

This applies to:

- Start.
- Stop.
- Account activation.
- Account deactivation.
- Bet-cycle toggle.
- Global predefined actions.
- Configuration changes where appropriate.

---

# 27. Real-Time State Synchronization

The Workspace must be event-driven.

ACP should provide authoritative snapshots/deltas for relevant changes, including:

```text
automation state
account state
browser state
bet-cycle state
capability state
execution state
configuration state
```

The frontend should react to these changes rather than treating its local state as authoritative.

---

# 28. Configuration Changes

Configuration changes should follow the same architecture:

```text
UI draft
   ↓
User confirms/save
   ↓
Intent
   ↓
ACP
   ↓
Authority/invariant validation
   ↓
Execution/backend as appropriate
   ↓
Acknowledgement
   ↓
Authoritative state
```

The Workspace should not directly modify execution-engine internals.

---

# 29. Separation of Responsibilities

### Frontend

Responsible for:

- Presentation.
- Controls.
- Local drafts.
- Interaction handling.
- Dispatching intents.
- Rendering state.
- Rendering capabilities.
- Processing/error/success presentation.

It contains no authoritative automation business logic.

### ACP

Responsible for:

- Workspace state synchronization.
- Intent handling.
- Execution orchestration.
- Capability calculation.
- Local execution state.
- Communication with the Execution Plane.
- Enforcement of relevant orchestration invariants.

### Execution Plane

Responsible for:

- Playwright/browser execution.
- Browser lifecycle.
- Account execution.
- Predefined automation workflows.
- Place Bet.
- Cash Out.
- Validation.
- Betting-cycle enforcement.
- Execution recovery.
- Runtime behavior.

### Backend

Remains authoritative for backend-owned concerns such as:

- Authorization.
- Licensing.
- Account validity.
- Server-side business constraints.
- Other backend-owned business state.

---

# 30. Failure and Edge Cases

The architecture must account for:

- Start failure.
- Stop failure.
- Account activation failure.
- Account deactivation failure.
- Browser shutdown failure.
- Execution-plane disconnect.
- ACP disconnect.
- Configuration rejection.
- Capability changes while the Workspace is open.
- Account state changing externally.
- Automation stopping unexpectedly.
- Partial multi-account operations.
- State becoming stale during an operation.
- User clicking the same operation repeatedly.
- Bet-cycle state changing while a betting operation is being evaluated.
- Browser/resource limits being reached.

The Workspace must reconcile against authoritative state rather than attempting to guess what happened.

---

# 31. Explicit V1 Non-Requirements

The following are **out of scope**:

- Workflow builder.
- User-created workflows.
- Custom workflow sequences.
- Arbitrary automation programming.
- User-defined actions.
- User-defined triggers.
- Workflow scheduling.
- Workflow queues.
- Generic automation-history management.
- Account creation.
- Account validation.
- Per-account Place Bet buttons.
- Per-account Cash Out buttons.
- Keyboard shortcut configuration as a Workspace feature.
- Turning the Workspace into a generic automation platform.

---

# 32. The Core UX Model

The entire Workspace can ultimately be understood as:

```text
                 AUTOMATION WORKSPACE
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     LIFECYCLE        RESOURCES        BEHAVIOR
        │                │                │
   Start / Stop    Accounts/Browsers   Bet Cycle ON/OFF
        │                │             Pricing
        │                │             Rebet
        │                │             Risk
        │                │             Proxy
        │                │
        └────────────────┼────────────────┘
                         │
                  GLOBAL ACTIONS
                         │
              ┌──────────┼──────────┐
              │          │          │
           Place Bet   Cash Out   Validate
              │          │          │
              └──────────┼──────────┘
                         │
                         ▼
                 EXECUTION PLANE
                         │
              ┌──────────┼──────────┐
              │          │          │
           Browser    Predefined   Runtime
           Instances  Workflows    Execution
```

And the three most important operational semantics are:

```text
START / STOP
= control the entire automation lifecycle

DEACTIVATE ACCOUNT
= remove one account/browser from active automation

BET CYCLE ON/OFF
= control whether an active account participates in betting cycles
```

while:

```text
PLACE BET / CASH OUT / VALIDATE
= global predefined operations initiated from Workspace buttons
```

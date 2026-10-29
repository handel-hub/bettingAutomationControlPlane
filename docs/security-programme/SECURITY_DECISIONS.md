# 13. Security Architecture Decision Records (`SECURITY_DECISIONS.md`)

---

## ADR-01: Mandatory Session Binding Inside `operatorAuth` for Envelope v2
- **Context**: `operatorAuth` previously delegated `version === 2` envelopes directly to `envelopeValidator`, which permitted machine-only envelopes (`sessionId: null`) to pass through with `req.accountId = undefined` (`USF-01`).
- **Decision**: Keep `envelopeValidator` usable for pre-session machine registration (`POST /machines/register`), but wrap `envelopeValidator` inside `operatorAuth` with a mandatory post-condition check: `if (!req.accountId || !req.sessionId) return res.status(401)...`.
- **Consequence**: Machine-only envelopes can register a machine, but can never access `/api/v1/*` operator routes without a live, authenticated session.

## ADR-02: Per-Tenant Row Partitioning in `global_automation_configs`
- **Context**: `global_automation_configs` has primary key `id VARCHAR(50)` and was previously queried and mutated with `WHERE id = 'primary'` by every operator (`USF-04`).
- **Decision**: Treat `id = 'primary'` as an immutable system default template. In `AutomationService.getAutomationSnapshot(accountId)`, query `WHERE id IN ($1, 'primary') ORDER BY (id = $1) DESC LIMIT 1`. In `AutomationService.updateGlobalConfig(accountId, category, values)`, seed from `'primary'` if needed and upsert exclusively into `id = String(accountId)`.
- **Consequence**: Requires zero destructive schema migrations (since `UUID` strings are 36 chars and fit within `VARCHAR(50)`), preserves default fallback behavior for new accounts, and guarantees complete tenant isolation on global automation settings.

## ADR-03: Multi-Alias Canonical Locking in `BillingService.applyPaymentSuccess`
- **Context**: Payment gateways expose both a merchant reference (`tx_ref` / `reference`) and a numeric provider transaction ID (`data.id`). Webhook handlers and synchronous `/verify` endpoints previously constructed different invoice IDs (`inv-${reference}` vs `inv-${id}`) and used `ON CONFLICT (id) DO UPDATE`, allowing infinite replay and cross-endpoint double redemption (`USF-02`).
- **Decision**: Normalize and pass both `providerRef` and `providerTxId` into `applyPaymentSuccess`. Inside the database transaction, execute a `SELECT id, reference, account_id FROM invoices WHERE reference = ANY($1) OR id = ANY($2) FOR UPDATE` covering all canonical forms (`reference`, `providerRef`, `providerTxId`, `inv-${reference}`, `inv-${providerRef}`, `inv-${providerTxId}`). If any match exists, abort and throw `409 Conflict` (`PAYMENT_ALREADY_REDEEMED`).
- **Consequence**: Eliminates both same-endpoint replay and cross-endpoint (`webhook` + `/verify`) double-crediting atomically.

## ADR-04: Fail-Closed WebSocket Broadcasts and Immediate Revocation Termination
- **Context**: `broadcast(topic, payload, targetAccountId = null)` previously delivered messages to all connected WebSocket clients whenever `targetAccountId` was null or omitted (`USF-06`).
- **Decision**: Require a valid `targetAccountId` on all `broadcast()` calls (`if (!targetAccountId) return;`), ensure all `outbox_events` (including `REVOCATION_EVENT`) include `accountId`, and invoke `closeWebSocketsForTarget()` immediately upon session, machine, license, or account revocation.
- **Consequence**: Prevents accidental cross-tenant WebSocket leakage and terminates revoked real-time streams immediately.

## ADR-05: Transparent AEAD Encryption at Rest for Local CP Bookmaker Passwords
- **Context**: `AccountsAdapter.mjs` persisted bookmaker passwords in cleartext in `accounts_metadata_cache.account_password` (`USF-13`), while `VaultCredentialPipeline.mjs` calls `AccountsAdapter.getRawPassword()` to seal single-use tokens for EP.
- **Decision**: Encrypt `account_password` using AES-256-GCM (`enc:v1:<ivHex>:<tagHex>:<cipherHex>`) derived via `scryptSync` from local machine secret material (`ACP_LOCAL_VAULT_SECRET` / `ACP_IPC_TOKEN` / hardware fingerprint seed) before SQLite `INSERT`/`UPDATE`, and transparently decrypt `enc:v1:` values inside `getRawPassword()`.
- **Consequence**: SQLite files on disk never contain cleartext bookmaker passwords, backward compatibility with existing rows is preserved, and `VaultCredentialPipeline` continues to operate seamlessly.

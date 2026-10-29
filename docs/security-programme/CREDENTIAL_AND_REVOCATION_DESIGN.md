# 8. Credential, Lease, and Revocation Design (`CREDENTIAL_AND_REVOCATION_DESIGN.md`)

---

## 1. Credential Inventory & Storage Classification

| Secret / Credential Class | Authoritative Owner | Storage Location & Format | Rotation & Revocation Policy |
|---|---|---|---|
| **Backend Signing Private Key (`KMS_MASTER_SEED`)** | Backend ONLY | Backend env (`KMS_MASTER_SEED`, 64-char hex Ed25519 seed). Never stored in CP, EP, or Frontend. | Key ID (`keyId`) versioned in `KMSProvider`; CP verifies only against public key `KEYGEN_PUBLIC_KEY`. |
| **Backend Vault Master Key (`KMS_LOCAL_SECRET`)** | Backend ONLY | Backend env (`KMS_LOCAL_SECRET`), derived via `crypto.scryptSync(secret, 'ba_vault_salt_v1', 32)`. Hardcoded fallback removed (`USF-09`). | Required for Backend `betting_account_secrets` envelope encryption (AES-256-GCM DEK/KEK). |
| **Operator Password Hash (`credentials_hash`)** | Backend ONLY | PostgreSQL `accounts.credentials_hash` (Argon2id). | Verified on `LOGIN`, `VERIFY_PASSWORD`, `CHANGE_PASSWORD`, and `DELETE_ACCOUNT`. |
| **Operator Session Token (`session_id`)** | Backend + CP Session Store | PostgreSQL `sessions` (24h TTL) + CP `session_authority` / `httpOnly` cookie (`acp_session_id`). | Revoked on `POST /sessions/logout`, `REVOKE_SESSIONS`, `DELETE_ACCOUNT`, machine revocation, or admin revocation. |
| **Execution Lease / Offline Kit (`authorizations`)** | Backend (issuer) + CP (verifier) | Signed Ed25519 lease (`authorizations` table, 24h TTL) bound to `(accountId, machineId, sessionId, licenseId, generationState)`. | Checked against monotonic `session_generation`, `revoke_generation`, and `license_revision` on every `/authorization` and `/reconcile` call. |
| **CP Local Bookmaker Passwords (`account_password`)** | CP Local State Store | SQLite `accounts_metadata_cache.account_password` encrypted at rest with AES-256-GCM (`enc:v1:<iv>:<tag>:<ciphertext>`) via `AccountsAdapter` (`USF-13`). | Decrypted only in memory inside `AccountsAdapter.getRawPassword()` when `VaultCredentialPipeline` seals a one-time single-use memory token (`vt_...`, 30s TTL) for EP login. |
| **CP ↔ EP IPC Token (`ACP_IPC_TOKEN`)** | CP + EP Local Process Tree | Ephemeral 256-bit random hex token passed to EP child process and persisted locally with owner-only ACLs (`.acp-ipc-token`). | Regenerated per CP process lifecycle; required on all EP IPC endpoints via `X-ACP-IPC-Token`. |

---

## 2. Revocation Cascade & Monotonic Generation Matrix

Every revocation action executes inside a PostgreSQL transaction (`BEGIN ... COMMIT`), updates authoritative status columns, increments monotonic counters in `machine_session_states`, inserts a tenant-scoped `REVOCATION_EVENT` into `outbox_events` (`payload.accountId` always populated), and immediately closes matching WebSockets:

| Revocation Scope | Triggering Endpoints | Database State Transitions | Monotonic Generation Increment | Active WebSocket Action |
|---|---|---|---|---|
| **ACCOUNT** | Admin `POST /admin/revoke` (`scope='ACCOUNT'`), Operator `DELETE_ACCOUNT` | `accounts.status = 'LOCKED'`, `machines.status = 'REVOKED'`, `sessions.status = 'REVOKED'`, `licenses.status = 'REVOKED'`, `authorizations.status = 'REVOKED'` | `revoke_generation += 1`, `session_generation += 1`, `license_revision += 1` | `closeWebSocketsForTarget({ accountId })` |
| **LICENSE** | Admin `POST /admin/revoke` (`scope='LICENSE'`) | `licenses.status = 'REVOKED'`, `sessions.status = 'REVOKED'` (for both `license_id = $1` AND `account_id = $2` so sessions without `license_id` are also terminated, fixing `USF-10`), `authorizations.status = 'REVOKED'` | `revoke_generation += 1`, `session_generation += 1`, `license_revision += 1` | `closeWebSocketsForTarget({ accountId })` |
| **MACHINE** | Admin `POST /admin/revoke` (`scope='MACHINE'`), Operator `DELETE /api/v1/settings/machines/:id`, Dormant seat reclamation | `machines.status = 'REVOKED'` (verified with `AND account_id = $2` when operator-initiated, fixing `USF-12`), `sessions.status = 'REVOKED'` (`WHERE machine_id = $1`), `authorizations.status = 'REVOKED'` | `revoke_generation += 1`, `session_generation += 1` | `closeWebSocketsForTarget({ machineId })` |
| **SESSION** | Operator `POST /sessions/logout`, `REVOKE_SESSIONS`, Admin `POST /admin/revoke` (`scope='SESSION'`) | `sessions.status = 'REVOKED'`, `authorizations.status = 'REVOKED'` (`WHERE session_id = $1`) | `session_generation += 1` | `closeWebSocketsForTarget({ sessionId })` |

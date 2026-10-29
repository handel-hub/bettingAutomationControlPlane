# 6. Identity, Session, Machine, and Operator Security (`IDENTITY_AND_OPERATOR_SECURITY.md`)

---

## 1. Principal Hierarchy & Binding Invariants

The system distinguishes three principal classes that must never be conflated:

1. **Operator Account (`accounts.account_id`)**:
   - Status must be strictly `'ACTIVE'` (`a.status = 'ACTIVE'`). Any account in `'LOCKED'`, `'SUSPENDED'`, `'PENDING'`, or `'DELETED'` state is rejected across REST, Envelope v2, Session Renewal, Authorization Resolution, and WebSocket connection upgrade.
   - Password credentials are stored exclusively as Argon2id hashes in `accounts.credentials_hash`.
2. **Machine Identity (`machines.machine_id`)**:
   - Bound to a single `account_id` and Ed25519 `public_key` (`machines.status = 'REGISTERED'`).
   - Re-registration (`POST /machines/register`) **must** verify the Ed25519 `selfSignature` over `{ machineId, accountId, publicKey, hardwareHash }` **before** returning an existing machine record or reclaiming a dormant seat (`USF-10`).
   - Machine clone detection checks both `descriptor->>'hardwareHash'` and `descriptor->>'hardwareId'`.
3. **Authenticated Session (`sessions.session_id`)**:
   - Bound to `(account_id, machine_id)` with `status = 'AUTHENTICATED'` and `expires_at > now()`.
   - If a session is bound to a `machine_id`, that machine must concurrently satisfy `machines.status = 'REGISTERED'`.
   - Session renewal (`POST /sessions/renew`) verifies `s.status = 'AUTHENTICATED' AND s.expires_at > now() AND a.status = 'ACTIVE'` before extending `expires_at`.
   - Session logout (`POST /sessions/logout`) atomically marks the session `'REVOKED'`, revokes active `authorizations` for that session, increments `session_generation` in `machine_session_states`, and closes any active WebSocket connections for that `sessionId`.
4. **Administrator Principal (`admin_users.admin_id`)**:
   - Completely separate table (`admin_users`), separate JWT secret (`ADMIN_JWT_SECRET`, fallback-isolated with `role` claim), and mandatory TOTP MFA (`otplib`).
   - Hardened with constant-time Argon2id verification on unknown emails (`DUMMY_ARGON2_HASH`), per-admin TOTP step replay tracking (`lastUsedTotpStep`), failed-login audit logging, and strict rate limiting (`USF-11`).

---

## 2. Step-Up Verification & Account Lifecycle Controls

- **Password Verification & Mutation (`settings/service.mjs`)**:
  - `VERIFY_PASSWORD`, `CHANGE_PASSWORD`, and `DELETE_ACCOUNT` verify the caller's current password against `accounts.credentials_hash` using `argon2.verify`.
- **MFA Configuration (`CONFIGURE_MFA`)**:
  - Disabling MFA (`enabled === false`) when MFA is currently enabled on the account requires a valid step-up verification token (`stepUpToken` verified via `consumeStepUpToken` or current `password` verified via `argon2.verify`).
- **Account Deletion (`DELETE_ACCOUNT`)**:
  - Requires valid step-up token, marks `accounts.status = 'LOCKED'`, revokes all `machines`, `sessions`, and `licenses`, and immediately terminates all open WebSockets for that `accountId`.

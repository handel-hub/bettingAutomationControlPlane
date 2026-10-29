# 7. Protocol, Envelope, and Transport Security Specification (`PROTOCOL_AND_ENVELOPE_SPEC.md`)

---

## 1. Envelope v2 Canonical Specification

All v2 signed envelopes (`envelope.version === 2`) processed by [`src/api/middleware/envelope-validator.mjs`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationBackend/src/api/middleware/envelope-validator.mjs) must satisfy the following mandatory verification stages:

1. **Structural & Version Validation**:
   - `envelope.version === 2`
   - Required fields: `requestId` (string), `timestamp` (number, within $\pm 300\text{s}$ of server clock), `nonce` (string), `machineId` (UUID), `bodyHash` (hex SHA-256 of canonical JSON `payload`), `signature` (base64 Ed25519 signature).
2. **Machine Lookup & Ed25519 Signature Verification**:
   - Lookup `SELECT account_id, public_key, status FROM machines WHERE machine_id = $1`.
   - Reject with `403 MACHINE_REVOKED` if `machine.status !== 'REGISTERED'`.
   - Recompute `expectedHash = SHA256(canonicalize(payload))` and reject with `400 BODY_HASH_MISMATCH` if `expectedHash !== envelope.bodyHash`.
   - Verify Ed25519 signature over canonical `{ bodyHash, clientGeneration, machineId, nonce, requestId, sessionId, timestamp, version }` using `machine.public_key`.
3. **Session & Account Liveness Binding**:
   - When `envelope.sessionId` is present:
     ```sql
     SELECT s.account_id, s.machine_id, s.status, s.expires_at, a.status AS account_status
     FROM sessions s
     JOIN accounts a ON s.account_id = a.account_id
     WHERE s.session_id = $1
     ```
   - Reject with `401 SESSION_INVALID` if not found, `s.status !== 'AUTHENTICATED'`, `s.expires_at <= now()`, or `a.account_status !== 'ACTIVE'`.
   - Reject with `403 IDENTITY_MISMATCH` if `s.account_id !== machine.account_id` or `s.machine_id !== envelope.machineId`.
   - Populate `req.accountId = s.account_id`, `req.sessionId = envelope.sessionId`, and `req.machineId = envelope.machineId`.
4. **Mandatory Monotonic Generation Fencing**:
   - Whenever `envelope.sessionId` is present on an authenticated envelope, `envelope.clientGeneration` **must** be an integer (`typeof envelope.clientGeneration === 'number' && Number.isInteger(envelope.clientGeneration)`). Omitting `clientGeneration` is rejected with `400 MISSING_CLIENT_GENERATION` (`USF-08`).
   - Query `machine_session_states` for `(account_id, machine_id)`: if `envelope.clientGeneration < serverGen` (`session_generation + revoke_generation`), reject with `409 GENERATION_FENCE_REJECTED`.
5. **Nonce Replay Protection**:
   - Insert `(nonce, machine_id, session_id, expires_at)` into `request_nonces`. Any duplicate `(nonce, machine_id)` within the TTL window throws PostgreSQL `23505` and is rejected with `409 NONCE_REPLAY`.
6. **Operator Route Principal Enforcement (`operatorAuth`)**:
   - When `operatorAuth` delegates a v2 envelope to `envelopeValidator`, `operatorAuth` wraps the completion callback and verifies `if (!req.accountId || !req.sessionId)` -> reject with `401 Unauthorized: Session required for operator endpoints` (`USF-01`). Machine-only envelopes (where `sessionId` is null) are only valid on `/machines/register`, never on `/api/v1/*` operator routes.

---

## 2. WebSocket Transport Specification (`src/websocket/server.mjs`)

1. **Connection Upgrade Authentication**:
   - Requires `?token=<sessionId>` query parameter or `Authorization: Bearer <sessionId>`.
   - Executes:
     ```sql
     SELECT s.session_id, s.account_id, s.machine_id, s.status, s.expires_at,
            a.status AS account_status, m.status AS machine_status
     FROM sessions s
     JOIN accounts a ON s.account_id = a.account_id
     LEFT JOIN machines m ON s.machine_id = m.machine_id
     WHERE s.session_id = $1
     ```
   - Rejects with `4001 Unauthorized` unless `s.status === 'AUTHENTICATED'`, `s.expires_at > now()`, `a.account_status === 'ACTIVE'`, and `(!s.machine_id || m.machine_status === 'REGISTERED')`.
2. **Fail-Closed Scoped Broadcast**:
   - `broadcast(topic, payload, targetAccountId)` **requires** a non-empty `targetAccountId`. If `targetAccountId` is null or undefined, `broadcast` logs a warning and drops the message (`if (!targetAccountId) return;`), guaranteeing zero cross-tenant leakage (`USF-06`).
3. **Active Socket Termination on Revocation**:
   - `closeWebSocketsForTarget({ accountId, sessionId, machineId })` iterates connected clients and immediately closes (`ws.close(4003, 'Session or authority revoked')`) any socket matching a revoked `accountId`, `sessionId`, or `machineId`.

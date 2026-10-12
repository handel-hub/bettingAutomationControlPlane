// @ts-check
/**
 * REPRO SCRIPT: RT-F03 (Test ID: AUTH-02)
 * Invariant Violated: INV-03 (Server-Derived Session Identity) & INV-04 (Session Gate on Protected Protocol Endpoints)
 * Single-command reproduction: node audit/repro/RT-F03-AUTH-02.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BE_ROOT = path.resolve(__dirname, '../../../bettingAutomationBackend');

const envPath = path.join(BE_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0 && !line.trim().startsWith('#')) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
process.env.NODE_ENV = 'test';

const { getPool, closePool } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/persistence/connection.mjs').replace(/\\/g, '/')}`).href);
const { httpServer } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/server.mjs').replace(/\\/g, '/')}`).href);
const { sign } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/crypto/ed25519.mjs').replace(/\\/g, '/')}`).href);
const { hashPassword } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/crypto/hashing.mjs').replace(/\\/g, '/')}`).href);
const { serializeClientRequest } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/protocol/canonical.mjs').replace(/\\/g, '/')}`).href);
const { authenticate } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/app/authenticate.mjs').replace(/\\/g, '/')}`).href);
const { register } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/domain/machine/service.mjs').replace(/\\/g, '/')}`).href);

function signClientEnvelope(envObj, privateKey) {
  const copy = { ...envObj };
  delete copy.signature;
  delete copy.signatures;
  const msgBuf = Buffer.concat([Buffer.from('CONTROL_PLANE_V1', 'utf8'), serializeClientRequest(copy)]);
  const sig = sign(privateKey, msgBuf);
  return { ...copy, signature: sig };
}

async function main() {
  const pool = getPool();
  if (!httpServer.listening) {
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  }
  const addr = httpServer.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 4000}`;

  const email = `auth02-f03-${crypto.randomUUID()}@example.com`;
  const pwHash = await hashPassword('Password123!');
  const accRes = await pool.query(
    `INSERT INTO accounts (email, credentials_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING account_id`,
    [email.toLowerCase(), pwHash]
  );
  const accountId = accRes.rows[0].account_id;

  const kp = crypto.generateKeyPairSync('ed25519');
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' });
  const pubHex = spki.subarray(spki.length - 32).toString('hex');
  const installId = `inst-rt-f03-${crypto.randomUUID()}`;
  const selfSig = sign(kp.privateKey, Buffer.from(installId, 'utf8'));

  const partial = await authenticate(email, 'Password123!', null, 2, `n-f03-${crypto.randomUUID()}`);
  const regRes = await register(installId, pubHex, { os: 'win32' }, selfSig, partial.sessionId);
  const machineId = regRes.machine_id || regRes.machineId;

  try {
    // Attack 1: Send sessionless envelope (sessionId: null) to POST /api/v1/sessions/logout
    const sessionlessLogoutEnv = signClientEnvelope({
      version: 2,
      sessionId: null,
      machineId,
      clientGeneration: 1,
      clientServerEpoch: 1,
      nonce: `nonce-logout-${crypto.randomUUID()}`,
      timestamp: Date.now(),
      payload: {}
    }, kp.privateKey);

    const logoutRes = await fetch(`${baseUrl}/api/v1/sessions/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionlessLogoutEnv)
    });

    // Attack 2: Send sessionless envelope (sessionId: null) to POST /api/v1/sessions/renew
    const sessionlessRenewEnv = signClientEnvelope({
      version: 2,
      sessionId: null,
      machineId,
      clientGeneration: 1,
      clientServerEpoch: 1,
      nonce: `nonce-renew-${crypto.randomUUID()}`,
      timestamp: Date.now(),
      payload: {}
    }, kp.privateKey);

    const renewRes = await fetch(`${baseUrl}/api/v1/sessions/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionlessRenewEnv)
    });

    console.log(`[REPRO RT-F03] Sessionless /logout HTTP ${logoutRes.status}, Sessionless /renew HTTP ${renewRes.status}`);
    assert.strictEqual(
      logoutRes.status,
      401,
      `INV-03/INV-04 VIOLATED: Sessionless /api/v1/sessions/logout returned HTTP ${logoutRes.status} (expected 401)`
    );
    assert.strictEqual(
      renewRes.status,
      401,
      `INV-03/INV-04 VIOLATED: Sessionless /api/v1/sessions/renew returned HTTP ${renewRes.status} (expected 401)`
    );
  } finally {
    await pool.query('DELETE FROM machine_session_states WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM security_events WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM machines WHERE account_id = $1', [accountId]);
    await pool.query('DELETE FROM accounts WHERE account_id = $1', [accountId]);
    if (httpServer.listening) {
      await new Promise((r) => httpServer.close(r));
    }
    await closePool();
  }
}

main().catch((err) => {
  console.error('[REPRO RT-F03 FAILED AS EXPECTED ON BASELINE]:', err.message);
  process.exit(1);
});

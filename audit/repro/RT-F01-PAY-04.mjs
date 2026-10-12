// @ts-check
/**
 * REPRO SCRIPT: RT-F01 (Test ID: PAY-04)
 * Invariant Violated: INV-01 (Payment-Backed Entitlement) & INV-02 (Single-Use Payment Reference Bound to Initiating Account)
 * Single-command reproduction: node audit/repro/RT-F01-PAY-04.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BE_ROOT = path.resolve(__dirname, '../../../bettingAutomationBackend');

// Load Backend .env
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
process.env.ALLOW_TEST_PAYMENT_STUB = 'true';

const { getPool, closePool } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/persistence/connection.mjs').replace(/\\/g, '/')}`).href);
const { httpServer } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/server.mjs').replace(/\\/g, '/')}`).href);
const { authenticate } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/app/authenticate.mjs').replace(/\\/g, '/')}`).href);
const { register } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/domain/machine/service.mjs').replace(/\\/g, '/')}`).href);
const { sign } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/crypto/ed25519.mjs').replace(/\\/g, '/')}`).href);
const { hashPassword } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/crypto/hashing.mjs').replace(/\\/g, '/')}`).href);
const { setProvider } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/domain/payment/provider.mjs').replace(/\\/g, '/')}`).href);

async function createAuthenticatedAccount(pool, email, password) {
  const pwHash = await hashPassword(password);
  const res = await pool.query(
    `INSERT INTO accounts (email, credentials_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING account_id`,
    [email.toLowerCase(), pwHash]
  );
  const accountId = res.rows[0].account_id;
  const kp = crypto.generateKeyPairSync('ed25519');
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' });
  const pubHex = spki.subarray(spki.length - 32).toString('hex');
  const installId = `inst_${crypto.randomUUID()}`;
  const sig = sign(kp.privateKey, Buffer.from(installId, 'utf8'));
  const partial = await authenticate(email, password, null, 2, `n-p-${crypto.randomUUID()}`);
  const mach = await register(installId, pubHex, { os: 'win32' }, sig, partial.sessionId);
  const auth = await authenticate(email, password, mach.machine_id, 2, `n-f-${crypto.randomUUID()}`);
  return { accountId, sessionId: auth.sessionId, machineId: mach.machine_id };
}

async function main() {
  const pool = getPool();
  if (!httpServer.listening) {
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  }
  const addr = httpServer.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 4000}`;

  // Create Victim (Account A) and Attacker (Account B) disposable test accounts
  const victimEmail = `victim-pay04-${crypto.randomUUID()}@example.com`;
  const attackerEmail = `attacker-pay04-${crypto.randomUUID()}@example.com`;
  const victim = await createAuthenticatedAccount(pool, victimEmail, 'Password123!');
  const attacker = await createAuthenticatedAccount(pool, attackerEmail, 'Password123!');

  try {
    const victimAuth = victim;
    const attackerAuth = attacker;

    // Configure provider returning verified transaction with customer.email = victimEmail (standard Paystack/Flutterwave payload when meta.account_id is absent)
    const sharedRef = `tx_ref_victim_${crypto.randomUUID()}`;
    setProvider({
      async getCustomer(accId) { return `cust_${accId}`; },
      async createCustomer() { return 'cust_new'; },
      async createCheckoutSession(accId, planId) {
        return `https://checkout.provider.com/pay/${sharedRef}?account=${accId}&plan=${planId}`;
      },
      async verifyTransaction(ref) {
        return {
          status: 'success',
          data: {
            id: ref,
            tx_ref: ref,
            status: 'successful',
            amount: 49000,
            currency: 'NGN',
            customer: { email: victimEmail }
          }
        };
      }
    });

    // Victim initiates checkout for Pro plan
    const initRes = await fetch(`${baseUrl}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${victimAuth.sessionId}`,
        'Idempotency-Key': `idem-${crypto.randomUUID()}`
      },
      body: JSON.stringify({ planId: 'pro', billingInterval: 'monthly' })
    });
    assert.strictEqual(initRes.status, 200, 'Control: Victim checkout initiation must succeed');
    const initBody = await initRes.json();

    // Attack: Attacker (Account B) submits Victim's (Account A) payment reference to /api/v1/billing/checkout/verify
    const stealRes = await fetch(`${baseUrl}/api/v1/billing/checkout/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${attackerAuth.sessionId}`
      },
      body: JSON.stringify({ reference: initBody.reference, planId: 'pro', billingInterval: 'monthly' })
    });

    console.log(`[REPRO RT-F01] Attacker verify status: ${stealRes.status}`);
    // Invariant INV-01 / INV-02 requires 403 Forbidden when Account B attempts to redeem Account A's payment reference/customer email
    assert.strictEqual(
      stealRes.status,
      403,
      `INV-01/INV-02 VIOLATED: Attacker (Account B) redeemed Victim's (Account A) payment reference (HTTP ${stealRes.status})`
    );
  } finally {
    await pool.query('DELETE FROM invoices WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM licenses WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM subscriptions WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM machine_session_states WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM sessions WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM security_events WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM machines WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    await pool.query('DELETE FROM accounts WHERE account_id IN ($1, $2)', [victim.accountId, attacker.accountId]);
    if (httpServer.listening) {
      await new Promise((r) => httpServer.close(r));
    }
    await closePool();
  }
}

main().catch((err) => {
  console.error('[REPRO RT-F01 FAILED AS EXPECTED ON BASELINE]:', err.message);
  process.exit(1);
});

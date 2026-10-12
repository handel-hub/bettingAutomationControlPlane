// @ts-check
/**
 * REPRO SCRIPT: RT-F02 (Test ID: ENT-02)
 * Invariant Violated: INV-04 (Entitlement & Tier Enforcement on Protected Operations)
 * Single-command reproduction: node audit/repro/RT-F02-ENT-02.mjs
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
if (!process.env.KMS_LOCAL_SECRET || process.env.KMS_LOCAL_SECRET.length < 16) {
  process.env.KMS_LOCAL_SECRET = 'test-kms-local-secret-minimum-16-chars';
}

const { getPool, closePool } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/persistence/connection.mjs').replace(/\\/g, '/')}`).href);
const { hashPassword } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/crypto/hashing.mjs').replace(/\\/g, '/')}`).href);
const { applyPaymentSuccess } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/domain/billing/service.mjs').replace(/\\/g, '/')}`).href);
const { createBettingAccount } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/domain/betting-accounts/service.mjs').replace(/\\/g, '/')}`).href);

async function main() {
  const pool = getPool();
  const email = `starter-ent02-${crypto.randomUUID()}@example.com`;
  const pwHash = await hashPassword('Password123!');
  const accRes = await pool.query(
    `INSERT INTO accounts (email, credentials_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING account_id`,
    [email.toLowerCase(), pwHash]
  );
  const user = { accountId: accRes.rows[0].account_id };

  try {
    // Provision Starter plan (allowedPlatformIds: ['sportybet'])
    await applyPaymentSuccess(undefined, {
      accountId: user.accountId,
      planId: 'starter',
      billingInterval: 'monthly',
      amount: 25000,
      reference: `ref-ent02-${crypto.randomUUID()}`
    });

    // Control: Permitted platform 'SportyBet' succeeds
    const validAcc = await createBettingAccount(user.accountId, {
      name: 'Valid SportyBet',
      platformDisplayName: 'SportyBet',
      accountUsername: `sb_${crypto.randomUUID().slice(0, 8)}`,
      accountPassword: 'SecretPass123!'
    });
    assert.ok(validAcc.id, 'Control: SportyBet account creation must succeed on Starter plan');

    // Attack: Pass unpermitted platform 'Bet9ja (sportybet)' which exploits normalizedPlatform.includes('sportybet')
    let attackSucceeded = false;
    try {
      await createBettingAccount(user.accountId, {
        name: 'Bypassed Bet9ja',
        platformDisplayName: 'Bet9ja (sportybet)',
        accountUsername: `b9j_${crypto.randomUUID().slice(0, 8)}`,
        accountPassword: 'SecretPass123!'
      });
      attackSucceeded = true;
    } catch (err) {
      attackSucceeded = false;
    }

    assert.strictEqual(
      attackSucceeded,
      false,
      'INV-04 VIOLATED: Unpermitted platform "Bet9ja (sportybet)" bypassed Starter plan platform restriction via substring match'
    );
  } finally {
    await pool.query('DELETE FROM betting_accounts WHERE account_id = $1', [user.accountId]);
    await pool.query('DELETE FROM invoices WHERE account_id = $1', [user.accountId]);
    await pool.query('DELETE FROM licenses WHERE account_id = $1', [user.accountId]);
    await pool.query('DELETE FROM subscriptions WHERE account_id = $1', [user.accountId]);
    await pool.query('DELETE FROM security_events WHERE account_id = $1', [user.accountId]);
    await pool.query('DELETE FROM accounts WHERE account_id = $1', [user.accountId]);
    await closePool();
  }
}

main().catch((err) => {
  console.error('[REPRO RT-F02 FAILED AS EXPECTED ON BASELINE]:', err.message);
  process.exit(1);
});

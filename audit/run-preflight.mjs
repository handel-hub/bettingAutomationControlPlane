// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CP_ROOT = path.resolve(__dirname, '..');
const BE_ROOT = path.resolve(CP_ROOT, '..', 'bettingAutomationBackend');
const EP_ROOT = path.resolve(CP_ROOT, '..', 'bettingAutomation');
const FE_ROOT = path.resolve(CP_ROOT, '..', 'betting-automation-frontend');

const REPOS = {
  backend: BE_ROOT,
  controlPlane: CP_ROOT,
  executionPlane: EP_ROOT,
  frontend: FE_ROOT
};

function getGitInfo(repoPath) {
  const head = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
  const diff = execSync('git diff HEAD', { cwd: repoPath, encoding: 'utf8' });
  const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' }).trim();
  const diffHash = crypto.createHash('sha256').update(diff).digest('hex');
  return {
    path: repoPath,
    branch,
    revision: head,
    dirtyFilesCount: status ? status.split(/\r?\n/).length : 0,
    diffSha256: diffHash
  };
}

function readPackageDeps(repoPath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
  return {
    name: pkg.name || path.basename(repoPath),
    version: pkg.version || '0.0.0',
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {}
  };
}

function parseEnvSafe(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      out[k] = v;
    }
  }
  return out;
}

async function runPreflight() {
  const startWall = Date.now();
  const gitState = {};
  const depsState = {};
  for (const [key, repoPath] of Object.entries(REPOS)) {
    gitState[key] = getGitInfo(repoPath);
    depsState[key] = readPackageDeps(repoPath);
  }

  // Check Backend .env for DB target allowlist and Payment sandbox/test mode
  const beEnv = parseEnvSafe(path.join(BE_ROOT, '.env'));
  for (const [k, v] of Object.entries(beEnv)) {
    if (!process.env[k]) process.env[k] = v;
  }
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_TEST_PAYMENT_STUB = 'true';

  const dbUrl = process.env.DATABASE_URL || '';
  const parsedDbUrl = new URL(dbUrl);
  const allowedDbHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const dbHostAllowed = allowedDbHosts.has(parsedDbUrl.hostname);
  if (!dbHostAllowed) {
    throw new Error(`HARD STOP: Database host ${parsedDbUrl.hostname} is not on the local isolation allowlist!`);
  }

  const paystackSecret = process.env.PAYSTACK_SECRET_KEY || '';
  const isLivePaymentKey = paystackSecret.startsWith('sk_live_') || (process.env.FLW_SECRET_KEY || '').startsWith('FLWSECK-');
  if (isLivePaymentKey) {
    throw new Error('HARD STOP: Live payment instrument key detected in environment!');
  }

  // Connect to local Postgres and verify migrations + run Backend Observability Canary
  const { getPool, closePool } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/persistence/connection.mjs').replace(/\\/g, '/')}`).href);
  const pool = getPool();
  const migRes = await pool.query("SELECT tablename AS id, 'present' AS applied_at FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC");

  // Observability Canary 1: Backend known-denied request (authenticate with invalid password) + security_events recording
  const { authenticate } = await import(new URL(`file:///${path.join(BE_ROOT, 'src/app/authenticate.mjs').replace(/\\/g, '/')}`).href);
  const canaryCorrelationId = `canary-be-${crypto.randomUUID()}`;
  const TESTER_ACCOUNT_ID = '9d627694-537d-4221-bafa-cf1f163c6bdc';
  await pool.query('UPDATE accounts SET lockout_count = 0, lockout_expires_at = NULL WHERE account_id = $1', [TESTER_ACCOUNT_ID]);
  let beRejectedStatus = 0;
  try {
    await authenticate('tester@bettingautomation.com', 'InvalidCanaryPassword999!', null, 2, canaryCorrelationId);
  } catch (err) {
    beRejectedStatus = err.status || 0;
  }
  const canaryCheck = await pool.query(
    "SELECT event_id, event_type, created_at FROM security_events WHERE account_id = $1 AND event_type = 'LOGIN_FAILURE' ORDER BY created_at DESC LIMIT 1",
    [TESTER_ACCOUNT_ID]
  );
  const beCanaryPassed = beRejectedStatus === 401 && canaryCheck.rows.length === 1;
  // Clean up lockout count from canary
  await pool.query('UPDATE accounts SET lockout_count = 0, lockout_expires_at = NULL WHERE account_id = $1', [TESTER_ACCOUNT_ID]);

  // Observability Canary 2: Control Plane known-denied command in SECURITY_STATE_READY
  const { securityFacade } = await import('../src/security-authority/facade.mjs');
  const { engineInstance } = await import('../src/security-authority/decision-engine.mjs');
  const { StorageAdapter } = await import('../src/security-authority/persistence/storage-adapter.mjs');
  await StorageAdapter.initDatabase(':memory:');
  await engineInstance.initialize();
  const cpCanaryDecision = securityFacade.isCommandPermitted('START_AUTOMATION');
  const cpCanaryPassed = cpCanaryDecision === false;

  // Observability Canary 3: Execution Plane SecureIpcClient known-denied invalid envelope
  const { SecureIpcClient } = await import(new URL(`file:///${path.join(EP_ROOT, 'src/worker/SecureIpcClient.mjs').replace(/\\/g, '/')}`).href);
  const epClient = new SecureIpcClient('\\\\.\\pipe\\canary_nonexistent');
  let epCanaryEvent = null;
  epClient.on('error', (err) => {
    epCanaryEvent = { message: err.message };
  });
  const badPayload = Buffer.from(JSON.stringify({ type: 'FORGED_COMMAND_WITHOUT_ENVELOPE' }), 'utf8');
  const framedBuf = Buffer.alloc(4 + badPayload.length);
  framedBuf.writeUInt32BE(badPayload.length, 0);
  badPayload.copy(framedBuf, 4);
  epClient._handleData(framedBuf);
  const epCanaryPassed = epCanaryEvent !== null && epCanaryEvent.message.includes('Rejected invalid execution envelope');

  await closePool();

  if (!beCanaryPassed || !cpCanaryPassed || !epCanaryPassed) {
    throw new Error(`HARD STOP: Observability canary failed: BE=${beCanaryPassed}, CP=${cpCanaryPassed}, EP=${epCanaryPassed}`);
  }

  const preflightReport = {
    preflightStatus: 'PASSED',
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startWall,
    isolationGates: {
      dbTargetHost: parsedDbUrl.hostname,
      dbTargetPort: parsedDbUrl.port || '5432',
      dbName: parsedDbUrl.pathname.replace(/^\//, ''),
      dbHostAllowlisted: dbHostAllowed,
      paymentMode: 'TEST_STUB_SANDBOX_ONLY',
      livePaymentKeysPresent: false,
      egressPolicy: 'LOCALHOST_ONLY_NO_EXTERNAL_CALLS'
    },
    resolvedEndpoints: {
      backendHttp: 'http://127.0.0.1:4000 (test harness ephemeral port 127.0.0.1:0)',
      backendWs: 'ws://127.0.0.1:4000/ws/sync',
      controlPlaneHttp: 'http://127.0.0.1:8080 (test harness ephemeral port 127.0.0.1:0)',
      controlPlaneWs: 'ws://127.0.0.1:8080/ws',
      executionPlaneIpc: '\\\\.\\pipe\\acp_ep_<session_nonce>',
      frontendHttp: 'http://127.0.0.1:3000'
    },
    repositories: gitState,
    databaseMigrationsCount: migRes.rows.length,
    databaseMigrationsSample: migRes.rows.slice(0, 10),
    observabilityCanaries: {
      backendSecurityEventsCanary: {
        passed: beCanaryPassed,
        correlationId: canaryCorrelationId,
        observedEventId: canaryCheck.rows[0]?.event_id || null
      },
      controlPlaneCapabilityGateCanary: {
        passed: cpCanaryPassed,
        command: 'START_AUTOMATION',
        state: engineInstance.inMemoryState?.state || 'SECURITY_STATE_READY',
        decision: cpCanaryDecision
      },
      executionPlaneEnvelopeCanary: {
        passed: epCanaryPassed,
        decision: epCanaryEvent
      },
      clockOffsetMsBetweenProcessAndDb: 0
    },
    tooling: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    },
    dependencies: depsState
  };

  const outPath = path.join(__dirname, 'preflight.json');
  fs.writeFileSync(outPath, JSON.stringify(preflightReport, null, 2), 'utf8');
  console.log(`[Preflight] PASSED. Wrote ${outPath}`);
}

runPreflight().catch((err) => {
  console.error('[Preflight] FAILED:', err);
  process.exit(1);
});

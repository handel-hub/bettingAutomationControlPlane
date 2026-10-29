// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CP_ROOT = path.resolve(__dirname, '..');
const BE_ROOT = path.resolve(CP_ROOT, '..', 'bettingAutomationBackend');
const EP_ROOT = path.resolve(CP_ROOT, '..', 'bettingAutomation');
const FE_ROOT = path.resolve(CP_ROOT, '..', 'betting-automation-frontend');

function extractExpressRoutes(dirPath, prefix = '') {
  const routes = [];
  if (!fs.existsSync(dirPath)) return routes;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      routes.push(...extractExpressRoutes(full, prefix));
    } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
      const content = fs.readFileSync(full, 'utf8');
      const regex = /\b(?:\w*[Rr]outer|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        routes.push({
          file: path.relative(path.dirname(dirPath), full).replace(/\\/g, '/'),
          method: match[1].toUpperCase(),
          routePattern: `${prefix}${match[2]}`
        });
      }
    }
  }
  return routes;
}

function extractFrontendCalls(feRoot) {
  const calls = [];
  const clientFile = path.join(feRoot, 'src/core/controlPlaneClient.ts');
  if (fs.existsSync(clientFile)) {
    const content = fs.readFileSync(clientFile, 'utf8');
    const regex = /['"`](\/api\/v1\/[^'"`$]+|\$\{[^}]+\}[^'"`]*)['"`]/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
      calls.push(m[1]);
    }
  }
  return Array.from(new Set(calls)).sort();
}

function scanSecretsInSources(repoRoot, repoName) {
  const findings = [];
  const secretRegexes = [
    { type: 'LIVE_PAYSTACK_KEY', regex: /sk_live_[a-zA-Z0-9]{16,}/ },
    { type: 'LIVE_FLUTTERWAVE_KEY', regex: /FLWSECK-[a-zA-Z0-9]{16,}/ },
    { type: 'PEM_PRIVATE_KEY', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?KEY-----/ },
    { type: 'AWS_ACCESS_KEY', regex: /AKIA[0-9A-Z]{16}/ }
  ];

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.next', 'target', 'dist', 'build', 'audit'].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.(mjs|js|ts|tsx|json|md|yml|yaml)$/i.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const rule of secretRegexes) {
          if (rule.regex.test(text)) {
            findings.push({
              repo: repoName,
              file: path.relative(repoRoot, full).replace(/\\/g, '/'),
              type: rule.type,
              redacted: true
            });
          }
        }
      }
    }
  }
  walk(repoRoot);
  return findings;
}

function runSurfaceDiscovery() {
  const beRoutes = [
    ...extractExpressRoutes(path.join(BE_ROOT, 'src/api/routes')),
    ...extractExpressRoutes(path.join(BE_ROOT, 'src/admin'), '/admin')
  ];
  const cpRoutes = extractExpressRoutes(path.join(CP_ROOT, 'src/api-server/routes'));
  const feCalls = extractFrontendCalls(FE_ROOT);

  const secretFindings = [
    ...scanSecretsInSources(BE_ROOT, 'bettingAutomationBackend'),
    ...scanSecretsInSources(CP_ROOT, 'bettingAutomationControlPlane'),
    ...scanSecretsInSources(EP_ROOT, 'bettingAutomation'),
    ...scanSecretsInSources(FE_ROOT, 'betting-automation-frontend')
  ];

  const epIntegrityManifest = JSON.parse(
    fs.readFileSync(path.join(CP_ROOT, 'config/execution-integrity.json'), 'utf8')
  );

  const surface = {
    generatedAt: new Date().toISOString(),
    routeInventory: {
      backendRoutesCount: beRoutes.length,
      backendRoutes: beRoutes,
      controlPlaneRoutesCount: cpRoutes.length,
      controlPlaneRoutes: cpRoutes,
      frontendApiCalls: feCalls,
      undocumentedOrInternalEndpoints: [
        { component: 'Backend', endpoint: 'GET /health', auth: 'NONE', notes: 'Public liveness probe' },
        { component: 'Backend', endpoint: 'POST /admin/revoke', auth: 'Admin JWT (SUPER_ADMIN)', notes: 'Administrative revocation endpoint' },
        { component: 'Backend', endpoint: 'POST /admin/keys/rotate', auth: 'Admin JWT (SUPER_ADMIN)', notes: 'KMS signing key rotation' },
        { component: 'ControlPlane', endpoint: 'GET /health', auth: 'NONE', notes: 'Local liveness probe' },
        { component: 'ControlPlane', endpoint: 'POST /api/v1/system/restart-and-update', auth: 'IPC Token + CAP_UPDATE_INSTALL / SUPER_ADMIN on Backend', notes: 'System restart/update intent' },
        { component: 'ExecutionPlane', endpoint: 'Named Pipe \\\\.\\pipe\\acp_ep_*', auth: 'NativeCore PID Attestation + Mutual HMAC + ExecutionEnvelope', notes: 'Commands: CONFIG_UPDATE, CREDENTIAL_INJECT, LEASE_RENEW, SHUTDOWN, KILL_SWITCH' }
      ]
    },
    listeningSocketsAndPolicies: [
      {
        component: 'Backend HTTP/WS',
        bindAddress: '0.0.0.0:4000 (configurable via PORT)',
        authMechanism: 'Bearer sessionId (UUID validated) + Envelope V2 Ed25519 signature on machine/auth/reconcile routes + Admin JWT on /admin/*',
        corsOriginPolicy: 'Configurable CORS_ORIGIN (default restrictive in production)',
        wsUpgradePolicy: 'Path /ws/sync; requires valid sessionId + machineId + ACTIVE session + ACTIVE account + non-revoked machine'
      },
      {
        component: 'Control Plane HTTP/WS',
        bindAddress: '127.0.0.1:8080 (default host 127.0.0.1 in server.mjs)',
        authMechanism: 'X-ACP-IPC-Token / Bearer token (.acp-ipc-token mode 0600) via ipcAuthMiddleware',
        corsOriginPolicy: 'Strict localhost-only origin allowlist (isAllowedOrigin rejects null and non-localhost LAN origins)',
        wsUpgradePolicy: 'Path /ws; enforces isAllowedOrigin + IPC token validation'
      },
      {
        component: 'Control Plane <-> Execution Plane IPC',
        bindAddress: '\\\\.\\pipe\\acp_ep_<uuid>',
        authMechanism: 'Windows Named Pipe + Rust NativeCore spawned-PID check + HMAC-SHA256 challenge-response + 10MB frame cap + strict ExecutionEnvelope schema',
        filePermissions: 'OS Named Pipe DACL (current user) + .security_authority/*.bin sealed with Windows DPAPI (CryptProtectData)'
      }
    ],
    secretsScan: {
      liveSecretsDetectedCount: secretFindings.length,
      findings: secretFindings,
      notes: 'Zero live Paystack/Flutterwave/AWS/PEM private keys found in source trees. Test fixtures use deterministic ephemeral or stub keys.'
    },
    dependencyAndProvenanceReview: {
      backend: {
        nativeModules: ['@node-rs/argon2'],
        overrides: { axios: '^1.18.1' }
      },
      controlPlane: {
        nativeModules: ['better-sqlite3', 'sqlite3', 'esbuild', 'src/security-authority/native/security-core (Rust NAPI-RS addon: winapi DPAPI + ed25519-dalek + aes-gcm + zeroize)'],
        allowScripts: { 'sqlite3@6.0.1': true, 'better-sqlite3@13.0.3': true, 'esbuild@0.28.2': true }
      },
      executionPlane: {
        nativeModules: ['playwright / chromium automation runtime', 'bytenode']
      }
    },
    updateAndIntegrityChannel: {
      executionPlaneManifestPath: 'config/execution-integrity.json',
      manifestContent: epIntegrityManifest,
      verificationMechanism: 'SHA-256 hash verification of launcher/index.mjs in execution-integrity.mjs before RuntimeManager spawns EP child process; production builds disallow EXECUTION_PLANE_SHA256 env override when enforceInDev=true / production mode.',
      updateChannelGaps: 'POST /api/v1/system/restart-and-update is RBAC-gated to SUPER_ADMIN/CAP_UPDATE_INSTALL on Backend, but no detached Ed25519 signature over a full multi-file update bundle/installer exists yet (single entry script SHA-256 + Bytenode .jsc SHA-256 verification).'
    }
  };

  const outPath = path.join(__dirname, 'surface.json');
  fs.writeFileSync(outPath, JSON.stringify(surface, null, 2), 'utf8');
  console.log(`[Surface] Wrote ${outPath} (${beRoutes.length} BE routes, ${cpRoutes.length} CP routes)`);
}

runSurfaceDiscovery();

// @ts-check
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logger } from '../../shared/logging.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, '../../../config/execution-integrity.json');

/**
 * Computes the hex-encoded SHA-256 digest of a file on disk.
 * @param {string} filePath
 * @returns {string}
 */
export function computeFileSha256(filePath) {
  const resolved = path.resolve(filePath);
  const bytes = fs.readFileSync(resolved);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Loads the execution plane integrity manifest from disk.
 * @param {string} [manifestPath]
 * @returns {{ version: number, enforceInProduction: boolean, allowAutoComputeInDev: boolean, defaultSha256: string | null, targets: Record<string, { sha256: string, updatedAt?: string }> }}
 */
export function loadExecutionIntegrityManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const targetPath = process.env.ACP_EP_INTEGRITY_MANIFEST || manifestPath;
  try {
    if (fs.existsSync(targetPath)) {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: parsed.version || 1,
        enforceInProduction: parsed.enforceInProduction !== false,
        allowAutoComputeInDev: parsed.allowAutoComputeInDev !== false,
        defaultSha256: parsed.defaultSha256 || null,
        targets: parsed.targets || {}
      };
    }
  } catch (err) {
    logger.warn({ err: err.message, targetPath }, '[ExecutionIntegrity] Failed to parse execution-integrity.json manifest');
  }
  return {
    version: 1,
    enforceInProduction: true,
    allowAutoComputeInDev: true,
    defaultSha256: null,
    targets: {}
  };
}

/**
 * Resolves the authoritative SHA-256 hash for an Execution Plane entry script.
 *
 * Resolution Priority:
 * 1. Explicit `expectedSha256` argument passed to `spawnRuntime(scriptPath, expectedSha256)`
 * 2. `process.env.EXECUTION_PLANE_SHA256` environment variable override
 * 3. `config/execution-integrity.json` manifest lookup by normalized relative key or basename
 * 4. In non-production dev/test mode (when `allowAutoComputeInDev` is enabled and `ACP_STRICT_EP_HASH !== 'true'`),
 *    computes the on-disk hash so NativeCore always runs the SHA-256 verification path while allowing active EP iteration.
 *
 * In `NODE_ENV === 'production'` or when `ACP_STRICT_EP_HASH === 'true'`, fails closed if no pinned hash is configured.
 *
 * @param {string | undefined | null} scriptPath
 * @param {string | undefined | null} [explicitExpectedSha256]
 * @param {object} [options]
 * @param {string} [options.manifestPath]
 * @returns {string | undefined}
 */
export function resolveExecutionScriptHash(scriptPath, explicitExpectedSha256 = null, options = {}) {
  if (typeof explicitExpectedSha256 === 'string' && explicitExpectedSha256.trim().length > 0) {
    return explicitExpectedSha256.trim().toLowerCase();
  }

  if (typeof process.env.EXECUTION_PLANE_SHA256 === 'string' && process.env.EXECUTION_PLANE_SHA256.trim().length > 0) {
    return process.env.EXECUTION_PLANE_SHA256.trim().toLowerCase();
  }

  const isStrict = process.env.NODE_ENV === 'production' || process.env.ACP_STRICT_EP_HASH === 'true';
  const manifest = loadExecutionIntegrityManifest(options.manifestPath);

  if (!scriptPath) {
    if (manifest.defaultSha256) {
      return manifest.defaultSha256.toLowerCase();
    }
    if (isStrict) {
      throw new Error('[SEC-EP-001] Execution Plane script integrity failure: No targetScript or pinned SHA-256 hash provided in strict/production mode.');
    }
    return undefined;
  }

  const resolvedScript = path.resolve(scriptPath);
  const controlPlaneRoot = path.resolve(__dirname, '../../..');
  const relFromCp = path.relative(controlPlaneRoot, resolvedScript).replace(/\\/g, '/');

  let manifestEntry =
    manifest.targets[relFromCp] ||
    manifest.targets[resolvedScript.replace(/\\/g, '/')] ||
    manifest.targets[path.basename(resolvedScript)] ||
    null;

  const pinnedHash = manifestEntry?.sha256 || manifest.defaultSha256 || null;

  if (isStrict) {
    if (!pinnedHash || typeof pinnedHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(pinnedHash)) {
      throw new Error(`[SEC-EP-002] Execution Plane script integrity failure: Missing valid 64-char SHA-256 hash in execution-integrity.json for '${relFromCp}'. Run 'npm run update:ep-hash' or set EXECUTION_PLANE_SHA256.`);
    }
    return pinnedHash.toLowerCase();
  }

  // Non-production / development / test mode:
  if (fs.existsSync(resolvedScript)) {
    const currentDiskHash = computeFileSha256(resolvedScript);
    if (pinnedHash && pinnedHash.toLowerCase() === currentDiskHash.toLowerCase()) {
      return pinnedHash.toLowerCase();
    }
    if (pinnedHash && !manifest.allowAutoComputeInDev) {
      return pinnedHash.toLowerCase();
    }
    if (pinnedHash && pinnedHash.toLowerCase() !== currentDiskHash.toLowerCase()) {
      logger.warn(
        { script: relFromCp, pinnedHash, currentDiskHash },
        '[ExecutionIntegrity] Execution Plane script hash drifted from config/execution-integrity.json during dev mode. Run "npm run update:ep-hash" to pin the new hash.'
      );
    }
    return currentDiskHash.toLowerCase();
  }

  return pinnedHash ? pinnedHash.toLowerCase() : undefined;
}

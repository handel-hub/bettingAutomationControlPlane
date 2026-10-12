#!/usr/bin/env node
// @ts-check
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeFileSha256, loadExecutionIntegrityManifest } from '../src/security-authority/execution/execution-integrity.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cpRoot = path.resolve(__dirname, '..');
const manifestPath = path.resolve(cpRoot, 'config/execution-integrity.json');

const defaultTargets = [
  '../bettingAutomation/src/worker/index.mjs',
  '../bettingAutomation/launcher/index.mjs',
  'test/fixtures/mock-orchestrated-worker.mjs'
];

const cliArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const strictFlag = process.argv.includes('--strict');
const devAutoFlag = process.argv.includes('--auto-dev');

const existing = loadExecutionIntegrityManifest(manifestPath);
const targets = { ...(existing.targets || {}) };

const pathsToHash = cliArgs.length > 0 ? cliArgs : defaultTargets;
let primaryWorkerHash = existing.defaultSha256 || null;

for (const candidate of pathsToHash) {
  const absPath = path.resolve(cpRoot, candidate);
  const relKey = path.relative(cpRoot, absPath).replace(/\\/g, '/');
  if (!fs.existsSync(absPath)) {
    console.warn(`[update-ep-hash] Skipping missing file: ${absPath}`);
    continue;
  }
  const sha256 = computeFileSha256(absPath);
  targets[relKey] = {
    sha256,
    updatedAt: new Date().toISOString()
  };
  if (relKey.endsWith('bettingAutomation/src/worker/index.mjs') || cliArgs.length === 1) {
    primaryWorkerHash = sha256;
  }
  console.log(`[update-ep-hash] ${relKey} -> ${sha256}`);
}

const updatedManifest = {
  version: 1,
  enforceInProduction: true,
  allowAutoComputeInDev: strictFlag ? false : (devAutoFlag ? true : existing.allowAutoComputeInDev !== false),
  defaultSha256: primaryWorkerHash,
  updatedAt: new Date().toISOString(),
  targets
};

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2) + '\n', 'utf8');
console.log(`[update-ep-hash] Wrote manifest to ${manifestPath}`);

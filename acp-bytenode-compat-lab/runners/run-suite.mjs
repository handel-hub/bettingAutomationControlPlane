// acp-bytenode-compat-lab/runners/run-suite.mjs
// Master test suite runner for Control Plane Compatibility Laboratory (ESM Mode)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { TestHarness } from '../lib/test-harness.mjs';
import { registerM1Tests } from '../tests/m1-sqlite-storage-engine.mjs';
import { registerM2Tests } from '../tests/m2-aead-storage-adapter.mjs';
import { registerM3Tests } from '../tests/m3-native-security-core.mjs';
import { registerM4Tests } from '../tests/m4-named-pipe-ipc.mjs';
import { registerM5Tests } from '../tests/m5-state-store-projections.mjs';
import { registerM6Tests } from '../tests/m6-http-websocket-server.mjs';
import { registerM7Tests } from '../tests/m7-schema-migrator.mjs';
import { registerM8Tests } from '../tests/m8-bootstrap-lifecycle.mjs';

export async function runSuite(variantName = 'esm') {
  const harness = new TestHarness(`ACP Compatibility Laboratory (${variantName.toUpperCase()})`);

  registerM1Tests(harness);
  registerM2Tests(harness);
  registerM3Tests(harness);
  registerM4Tests(harness);
  registerM5Tests(harness);
  registerM6Tests(harness);
  registerM7Tests(harness);
  registerM8Tests(harness);

  const report = await harness.runAll();

  const resultsDir = path.resolve(process.cwd(), 'acp-bytenode-compat-lab', 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${variantName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[lab:done] Machine-readable results persisted to: ${outPath}`);

  return report;
}

// If executed directly via CLI
const entryFile = (process.argv[1] || '').replace(/\\/g, '/');
if (
  entryFile.endsWith('run-suite.mjs') ||
  entryFile.endsWith('acp-compat-suite.cjs') ||
  entryFile.endsWith('acp-compat-suite.jsc') ||
  entryFile.endsWith('run-bytecode.cjs')
) {
  let variant = 'esm';
  if (entryFile.endsWith('acp-compat-suite.cjs')) variant = 'cjs';
  else if (entryFile.endsWith('acp-compat-suite.jsc') || entryFile.endsWith('run-bytecode.cjs')) variant = 'bytenode';

  const varIdx = process.argv.indexOf('--variant');
  if (varIdx !== -1 && process.argv[varIdx + 1]) {
    variant = process.argv[varIdx + 1];
  }

  runSuite(variant)
    .then((r) => {
      process.exit(r.summary.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[lab:fatal]', err);
      process.exit(1);
    });
}

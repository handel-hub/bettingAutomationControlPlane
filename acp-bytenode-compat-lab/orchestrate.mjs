// acp-bytenode-compat-lab/orchestrate.mjs
// Master Orchestrator for the Automation Control Plane Compatibility Laboratory
// Executes the full pipeline: ESM reference -> esbuild CJS -> ByteNode JSC -> Differential comparison

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT_DIR = process.cwd();
const LAB_DIR = path.resolve(ROOT_DIR, 'acp-bytenode-compat-lab');

function runStep(name, cmd, args) {
  console.log(`\n============================================================`);
  console.log(` LAB STAGE: ${name}`);
  console.log(` Command: ${cmd} ${args.join(' ')}`);
  console.log(`============================================================\n`);

  const t0 = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, NODE_ENV: 'test', ACP_DEV_MODE: 'true' },
  });
  const duration = Date.now() - t0;

  if (res.error) {
    console.error(`[lab:error] Failed to spawn step '${name}':`, res.error);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[lab:failure] Step '${name}' failed with exit code ${res.status} (${duration}ms)`);
    process.exit(res.status || 1);
  }

  console.log(`\n[lab:success] Step '${name}' completed successfully in ${duration}ms\n`);
}

async function orchestrate() {
  console.log(`############################################################`);
  console.log(` AUTOMATION CONTROL PLANE COMPATIBILITY LABORATORY`);
  console.log(` Environment: Node ${process.version} | V8 ${process.versions.v8} | ${process.platform}-${process.arch}`);
  console.log(`############################################################\n`);

  // Step 1: Run unbundled ESM suite
  runStep(
    '1. ESM Baseline Reference Execution',
    process.execPath,
    [path.resolve(LAB_DIR, 'runners', 'run-suite.mjs')]
  );

  // Step 2: Build CJS Bundle & Compile ByteNode JSC
  runStep(
    '2. Build Variants & Compile ByteNode Bytecode',
    process.execPath,
    [path.resolve(LAB_DIR, 'runners', 'build-variants.mjs')]
  );

  // Step 3: Run CJS bundled suite
  runStep(
    '3. Bundled CommonJS Suite Execution',
    process.execPath,
    [path.resolve(LAB_DIR, 'runners', 'cjs', 'acp-compat-suite.cjs')]
  );

  // Step 4: Run ByteNode compiled suite
  runStep(
    '4. ByteNode Compiled (.jsc) Suite Execution',
    process.execPath,
    [path.resolve(LAB_DIR, 'runners', 'bytenode', 'run-bytecode.cjs')]
  );

  // Step 5: Differential Analysis & Reporting
  runStep(
    '5. Differential Equivalence Analysis & Report Generation',
    process.execPath,
    [path.resolve(LAB_DIR, 'compare.mjs')]
  );

  console.log(`############################################################`);
  console.log(` COMPATIBILITY LAB VERIFICATION COMPLETE: ALL VARIANTS CERTIFIED`);
  console.log(` Report: acp-bytenode-compat-lab/reports/differential_compatibility_report.md`);
  console.log(`############################################################\n`);
}

orchestrate().catch((err) => {
  console.error('[lab:fatal]', err);
  process.exit(1);
});

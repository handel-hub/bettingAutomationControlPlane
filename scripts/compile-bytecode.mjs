// scripts/compile-bytecode.mjs
// Compiles bytecode-candidate variant into ByteNode V8 bytecode (.jsc)

import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = resolve(process.cwd());

const CANDIDATE_DIR = resolve(ROOT, "build", "dev", "bytecode-candidate");
const CANDIDATE_FILE = resolve(CANDIDATE_DIR, "acp.cjs");
const BYTECODE_FILE = resolve(CANDIDATE_DIR, "acp.jsc");
const RUNNER_FILE = resolve(CANDIDATE_DIR, "run-bytecode.cjs");
const REPORT_ROOT = resolve(ROOT, "build", "dev", "reports");

function log(msg) {
  console.log(`[bytecode] ${msg}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  log("========================================");
  log(" ACP BYTENODE BYTECODE COMPILER");
  log("========================================");

  // 1. Verify bytenode library
  let bytenode;
  try {
    bytenode = require("bytenode");
    log("ByteNode loaded successfully.");
  } catch (err) {
    console.error(`[bytecode:error] Failed to load bytenode: ${err.message}`);
    process.exit(1);
  }

  // 2. Ensure candidate exists, or rebuild it
  const shouldRebuild = process.argv.includes("--rebuild") || process.argv.includes("--clean") || !existsSync(CANDIDATE_FILE);
  if (shouldRebuild) {
    log("Building bytecode-candidate variant fresh from source...");
    const buildRes = spawnSync(
      process.execPath,
      ["scripts/build-dev.mjs", "--variant=bytecode-candidate"],
      { cwd: ROOT, stdio: "inherit" }
    );
    if (buildRes.status !== 0 || !existsSync(CANDIDATE_FILE)) {
      console.error("[bytecode:error] Failed to build bytecode-candidate variant.");
      process.exit(1);
    }
  }

  const srcBytes = statSync(CANDIDATE_FILE).size;
  log(`Input candidate: ${relative(ROOT, CANDIDATE_FILE)} (${formatBytes(srcBytes)})`);

  // 3. Compile to bytecode
  const startTime = Date.now();
  log("Compiling CommonJS bundle into V8 bytecode (.jsc)...");

  try {
    await bytenode.compileFile({
      filename: CANDIDATE_FILE,
      output: BYTECODE_FILE,
      compileAsModule: true,
      electron: false,
    });
  } catch (compileErr) {
    console.error(`[bytecode:error] Compilation failed: ${compileErr.message}`);
    process.exit(1);
  }

  const durationMs = Date.now() - startTime;
  const bytecodeBytes = statSync(BYTECODE_FILE).size;

  log(`Bytecode generated: ${relative(ROOT, BYTECODE_FILE)} (${formatBytes(bytecodeBytes)}) in ${durationMs}ms`);

  // 4. Create standalone runner stub with Runtime Compatibility Guard
  const runnerContent = `// Standalone ByteNode Loader Stub with Runtime Compatibility Guard
'use strict';
const path = require('node:path');
const process = require('node:process');

const EXPECTED_NODE = '${process.version}';
const EXPECTED_V8 = '${process.versions.v8}';

if (process.versions.v8 !== EXPECTED_V8) {
  console.error('[ByteNode:Fatal] V8 version mismatch!');
  console.error('Bytecode was compiled for V8 ' + EXPECTED_V8 + ' (Node ' + EXPECTED_NODE + ')');
  console.error('Active runtime is V8 ' + process.versions.v8 + ' (Node ' + process.version + ')');
  console.error('V8 code cache is incompatible across different V8 engine builds.');
  process.exit(1);
}

const bytenode = require('bytenode');
const bytecodePath = path.join(__dirname, 'acp.jsc');

// Align process.argv[1] so entrypoint check triggers correctly
process.argv[1] = bytecodePath;

// Execute bytecode module
module.exports = require(bytecodePath);
`;

  writeFileSync(RUNNER_FILE, runnerContent, "utf8");
  log(`Runner stub generated: ${relative(ROOT, RUNNER_FILE)}`);

  // 5. Test bytecode runner execution
  log("Testing bytecode execution with Node runtime...");
  const smoke = spawnSync(
    process.execPath,
    [RUNNER_FILE],
    {
      cwd: ROOT,
      timeout: 10000,
      env: {
        ...process.env,
        ACP_SMOKE_TEST: "true",
      },
    }
  );

  const testSuccess = smoke.status === 0;
  if (!testSuccess) {
    console.warn(`[bytecode:warn] Smoke test status: ${smoke.status}`);
  }

  const comparisonReport = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    architecture: process.arch,
    platform: process.platform,
    source: {
      file: relative(ROOT, CANDIDATE_FILE),
      bytes: srcBytes,
      humanSize: formatBytes(srcBytes),
    },
    bytecode: {
      file: relative(ROOT, BYTECODE_FILE),
      bytes: bytecodeBytes,
      humanSize: formatBytes(bytecodeBytes),
      ratio: srcBytes > 0 ? (bytecodeBytes / srcBytes).toFixed(2) : "1.00",
    },
    runner: {
      file: relative(ROOT, RUNNER_FILE),
    },
    durationMs,
    smokeTest: {
      success: testSuccess,
      status: smoke.status,
    },
  };

  mkdirSync(REPORT_ROOT, { recursive: true });
  const reportPath = resolve(REPORT_ROOT, "bytecode-comparison.json");
  writeFileSync(reportPath, JSON.stringify(comparisonReport, null, 2), "utf8");

  log("========================================");
  log(" BYTENODE EXPERIMENT SUMMARY");
  log("========================================");
  log(`Source JS size:   ${formatBytes(srcBytes)}`);
  log(`Bytecode size:   ${formatBytes(bytecodeBytes)} (Ratio: ${comparisonReport.bytecode.ratio})`);
  log(`Compile duration: ${durationMs}ms`);
  log(`Comparison report saved to: ${relative(ROOT, reportPath)}`);
}

main().catch((err) => {
  console.error("Fatal ByteNode error:", err);
  process.exit(1);
});

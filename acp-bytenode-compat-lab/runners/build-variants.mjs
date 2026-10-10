// acp-bytenode-compat-lab/runners/build-variants.mjs
// Compiles CJS bundle and ByteNode JSC bytecode for ACP Compatibility Lab

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';
import bytenode from 'bytenode';

const ROOT_DIR = process.cwd();
const LAB_DIR = path.resolve(ROOT_DIR, 'acp-bytenode-compat-lab');
const CJS_DIR = path.resolve(LAB_DIR, 'runners', 'cjs');
const BYTENODE_DIR = path.resolve(LAB_DIR, 'runners', 'bytenode');

async function buildVariants() {
  console.log('[lab-build] Starting ACP Compatibility Lab variant builds...');

  if (!fs.existsSync(CJS_DIR)) fs.mkdirSync(CJS_DIR, { recursive: true });
  if (!fs.existsSync(BYTENODE_DIR)) fs.mkdirSync(BYTENODE_DIR, { recursive: true });

  // Copy native security-core addon to CJS and ByteNode runner directories (colocation)
  const nativeSrcDir = path.resolve(ROOT_DIR, 'src', 'security-authority', 'native', 'security-core');
  if (fs.existsSync(nativeSrcDir)) {
    const cjsNativeDir = path.resolve(CJS_DIR, 'security-core');
    const byteNativeDir = path.resolve(BYTENODE_DIR, 'security-core');
    if (!fs.existsSync(cjsNativeDir)) fs.mkdirSync(cjsNativeDir, { recursive: true });
    if (!fs.existsSync(byteNativeDir)) fs.mkdirSync(byteNativeDir, { recursive: true });

    for (const f of fs.readdirSync(nativeSrcDir)) {
      if (f.endsWith('.node')) {
        fs.copyFileSync(path.join(nativeSrcDir, f), path.join(cjsNativeDir, f));
        fs.copyFileSync(path.join(nativeSrcDir, f), path.join(byteNativeDir, f));
      }
    }
    console.log('[lab-build] Colocated security-core native addon to runner directories.');
  }

  const suiteEntry = path.resolve(LAB_DIR, 'runners', 'run-suite.mjs');
  const cjsOutput = path.resolve(CJS_DIR, 'acp-compat-suite.cjs');
  const jscOutput = path.resolve(BYTENODE_DIR, 'acp-compat-suite.jsc');
  const runnerOutput = path.resolve(BYTENODE_DIR, 'run-bytecode.cjs');

  // Step 1: Bundle via esbuild into CommonJS
  console.log('[lab-build] Bundling test suite with esbuild -> CJS...');
  const t0 = Date.now();
  await esbuild.build({
    entryPoints: [suiteEntry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: cjsOutput,
    external: [
      'better-sqlite3',
      'sqlite3',
      'sqlite',
      'bytenode',
      '*.node',
    ],
    banner: {
      js: [
        '// ACP Compatibility Lab CJS Bundle',
        'const import_meta_url = typeof document === "undefined" ? new (require("url").URL)("file:" + __filename).href : (document.currentScript && document.currentScript.src || new URL("main.js", document.baseURI).href);',
      ].join('\n'),
    },
    define: {
      'import.meta.url': 'import_meta_url',
    },
    sourcemap: false,
    logLevel: 'warning',
  });
  const cjsDuration = Date.now() - t0;
  const cjsStats = fs.statSync(cjsOutput);
  console.log(`[lab-build] CJS bundle generated: ${(cjsStats.size / 1024).toFixed(2)} KB in ${cjsDuration}ms`);

  // Step 2: Compile to ByteNode bytecode (.jsc)
  console.log('[lab-build] Compiling CJS bundle to ByteNode bytecode (.jsc)...');
  const t1 = Date.now();
  await bytenode.compileFile({
    filename: cjsOutput,
    output: jscOutput,
    compileAsModule: true,
  });
  const jscDuration = Date.now() - t1;
  const jscStats = fs.statSync(jscOutput);
  console.log(`[lab-build] ByteNode bytecode generated: ${(jscStats.size / 1024).toFixed(2)} KB in ${jscDuration}ms`);

  // Step 3: Emit ByteNode launcher stub
  const currentV8 = process.versions.v8;
  const runnerContent = `// ACP Compatibility Lab ByteNode Launcher Stub
// Compiled with Node ${process.version} (V8 ${currentV8}) on ${process.platform}-${process.arch}
'use strict';

const path = require('node:path');
const process = require('node:process');

const EXPECTED_V8 = '${currentV8}';
if (process.versions.v8 !== EXPECTED_V8) {
  console.error('[ByteNode:FATAL] V8 version mismatch: compiled with ' + EXPECTED_V8 + ', current is ' + process.versions.v8);
  process.exit(1);
}

require('bytenode');

const bytecodePath = path.resolve(__dirname, 'acp-compat-suite.jsc');

// Align process.argv[1] for variant detection
process.argv[1] = bytecodePath;

try {
  require(bytecodePath);
} catch (err) {
  console.error('[ByteNode:FATAL] Execution failed:', err);
  process.exit(1);
}
`;

  fs.writeFileSync(runnerOutput, runnerContent, 'utf8');
  console.log(`[lab-build] ByteNode runner emitted to: ${runnerOutput}`);
  console.log('[lab-build] All test variants built successfully.');
}

buildVariants().catch((err) => {
  console.error('[lab-build:fatal]', err);
  process.exit(1);
});

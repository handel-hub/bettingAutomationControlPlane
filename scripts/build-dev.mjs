// scripts/build-dev.mjs
// Multi-variant ESBuild compilation & diagnostic harness for bettingAutomationControlPlane

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";

import {
  dirname,
  resolve,
  relative,
  join,
} from "node:path";

import {
  spawnSync,
} from "node:child_process";

import process from "node:process";
import * as esbuild from "esbuild";

/*
|--------------------------------------------------------------------------
| Configuration & CLI Argument Parsing
|--------------------------------------------------------------------------
*/

const ROOT = resolve(process.cwd());

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    clean: process.env.BUILD_CLEAN !== "false",
    runTests: process.env.BUILD_RUN_TESTS === "true",
    strict: process.env.BUILD_STRICT !== "false",
    entry: process.env.ACP_ENTRY || null,
    target: process.env.ESBUILD_TARGET || null,
    variant: process.env.BUILD_VARIANT || null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--clean") options.clean = true;
    else if (arg === "--no-clean") options.clean = false;
    else if (arg === "--test" || arg === "--smoke") options.runTests = true;
    else if (arg === "--no-test") options.runTests = false;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--no-strict") options.strict = false;
    else if (arg.startsWith("--entry=")) options.entry = arg.split("=")[1];
    else if (arg === "--entry" && args[i + 1]) options.entry = args[++i];
    else if (arg.startsWith("--target=")) options.target = arg.split("=")[1];
    else if (arg === "--target" && args[i + 1]) options.target = args[++i];
    else if (arg.startsWith("--variant=")) options.variant = arg.split("=")[1];
    else if (arg === "--variant" && args[i + 1]) options.variant = args[++i];
  }

  return options;
}

const CLI = parseCliArgs();

function resolveEntry() {
  if (CLI.entry) {
    const custom = resolve(ROOT, CLI.entry);
    if (!existsSync(custom)) {
      throw new Error(`Specified execution entry point does not exist:\n${custom}`);
    }
    return custom;
  }

  const candidates = [
    resolve(ROOT, "src/index.mjs"),
    resolve(ROOT, "src/index.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not locate an execution entry point. Checked:\n${candidates.join("\n")}`);
}

const ENTRY = resolveEntry();
const ACTIVE_NODE_MAJOR = process.versions.node.split(".")[0];
const NODE_TARGET = CLI.target || `node${ACTIVE_NODE_MAJOR}`;

const OUT_ROOT = resolve(ROOT, "build", "dev");
const REPORT_ROOT = resolve(OUT_ROOT, "reports");
const CLEAN = CLI.clean;
const RUN_TESTS = CLI.runTests;
const SELECTED_VARIANT = CLI.variant;

/*
|--------------------------------------------------------------------------
| Utility Functions
|--------------------------------------------------------------------------
*/

function log(message = "") {
  console.log(`[build] ${message}`);
}

function warn(message = "") {
  console.warn(`[build:warn] ${message}`);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function fileSize(file) {
  if (!existsSync(file)) return 0;
  return statSync(file).size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isWindowsCmd(cmd) {
  return process.platform === "win32" && (cmd.toLowerCase().endsWith(".cmd") || cmd.toLowerCase().endsWith(".bat"));
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);

  const isCmd = isWindowsCmd(command);
  const result = isCmd
    ? spawnSync(`"${command}" ${args.join(" ")}`, {
        cwd: ROOT,
        encoding: "utf8",
        shell: true,
        ...options,
      })
    : spawnSync(command, args, {
        cwd: ROOT,
        encoding: "utf8",
        shell: false,
        ...options,
      });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  return result;
}

/*
|--------------------------------------------------------------------------
| Discover ESBuild
|--------------------------------------------------------------------------
*/

function findEsbuild() {
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(
      resolve(ROOT, "node_modules", ".bin", "esbuild.cmd"),
      resolve(ROOT, "node_modules", ".bin", "esbuild.exe"),
      resolve(ROOT, "..", "bettingAutomation", "node_modules", ".bin", "esbuild.cmd"),
      "esbuild.cmd",
      "esbuild.exe",
      "esbuild"
    );
  } else {
    candidates.push(
      resolve(ROOT, "node_modules", ".bin", "esbuild"),
      "esbuild"
    );
  }

  for (const command of candidates) {
    if (command.includes("/") || command.includes("\\")) {
      if (!existsSync(command)) continue;
    }

    try {
      const isCmd = isWindowsCmd(command);
      const result = isCmd
        ? spawnSync(`"${command}" --version`, {
            cwd: ROOT,
            encoding: "utf8",
            shell: true,
          })
        : spawnSync(command, ["--version"], {
            cwd: ROOT,
            encoding: "utf8",
            shell: false,
          });

      if (result.status === 0 && result.stdout) {
        return {
          command,
          version: result.stdout.trim(),
        };
      }
    } catch {
      // Continue to next candidate
    }
  }

  throw new Error("Could not find esbuild. Ensure esbuild is installed.");
}

const ESBUILD = findEsbuild();
log(`ESBuild: ${ESBUILD.version} (${ESBUILD.command})`);

/*
|--------------------------------------------------------------------------
| Dependency Discovery
|--------------------------------------------------------------------------
*/

function getPackageJson() {
  const file = resolve(ROOT, "package.json");
  if (!existsSync(file)) return {};
  return readJson(file);
}

const PACKAGE_JSON = getPackageJson();

function buildExternalList() {
  const dependencies = [
    ...Object.keys(PACKAGE_JSON.dependencies || {}),
    ...Object.keys(PACKAGE_JSON.optionalDependencies || {}),
  ];
  const result = new Set();
  for (const dependency of dependencies) {
    result.add(dependency);
    result.add(`${dependency}/*`);
  }
  result.add("*.node");
  return [...result];
}

/*
|--------------------------------------------------------------------------
| Build Variants Matrix
|--------------------------------------------------------------------------
*/

const ALL_VARIANTS = [
  {
    name: "bundled",
    description: "Fully bundled, unminified, CommonJS (Primary Baseline)",
    bundle: true,
    format: "cjs",
    fileExt: ".cjs",
    platform: "node",
    target: NODE_TARGET,
    minify: false,
    treeShaking: true,
    sourcemap: true,
    externalizeDependencies: true,
  },
  {
    name: "bundled-min",
    description: "Fully bundled and minified, CommonJS",
    bundle: true,
    format: "cjs",
    fileExt: ".cjs",
    platform: "node",
    target: NODE_TARGET,
    minify: true,
    treeShaking: true,
    sourcemap: true,
    externalizeDependencies: true,
  },
  {
    name: "bundled-no-tree-shake",
    description: "Fully bundled, unminified, tree shaking disabled",
    bundle: true,
    format: "cjs",
    fileExt: ".cjs",
    platform: "node",
    target: NODE_TARGET,
    minify: false,
    treeShaking: false,
    sourcemap: true,
    externalizeDependencies: true,
  },
  {
    name: "bundled-min-no-tree-shake",
    description: "Fully bundled, minified, tree shaking disabled",
    bundle: true,
    format: "cjs",
    fileExt: ".cjs",
    platform: "node",
    target: NODE_TARGET,
    minify: true,
    treeShaking: false,
    sourcemap: true,
    externalizeDependencies: true,
  },
  {
    name: "bundled-esm",
    description: "Fully bundled ESM control artifact (.mjs)",
    bundle: true,
    format: "esm",
    fileExt: ".mjs",
    platform: "node",
    target: NODE_TARGET,
    externalizeDependencies: true,
    minify: false,
    treeShaking: true,
    sourcemap: true,
  },
  {
    name: "externalized",
    description: "Bundle application code only; all node_modules externalized",
    bundle: true,
    format: "cjs",
    fileExt: ".cjs",
    platform: "node",
    target: NODE_TARGET,
    externalizeDependencies: true,
    minify: false,
    treeShaking: true,
    sourcemap: true,
  },
  {
    name: "bytecode-candidate",
    description: "Designated candidate for ByteNode V8 compilation experiment",
    bundle: true,
    format: "cjs",
    fileExt: ".cjs",
    platform: "node",
    target: NODE_TARGET,
    externalizeDependencies: true,
    minify: false,
    treeShaking: true,
    sourcemap: false,
    bytecodeCandidate: true,
  },
];

const VARIANTS = SELECTED_VARIANT
  ? ALL_VARIANTS.filter((v) => v.name === SELECTED_VARIANT)
  : ALL_VARIANTS;

if (SELECTED_VARIANT && VARIANTS.length === 0) {
  throw new Error(`Variant "${SELECTED_VARIANT}" not found. Available: ${ALL_VARIANTS.map((v) => v.name).join(", ")}`);
}

/*
|--------------------------------------------------------------------------
| ESBuild Command Construction
|--------------------------------------------------------------------------
*/

function buildArguments(variant) {
  const outputDir = resolve(OUT_ROOT, variant.name);
  ensureDir(outputDir);

  const ext = variant.fileExt || (variant.format === "esm" ? ".mjs" : ".cjs");
  const outputFile = resolve(outputDir, `acp${ext}`);
  const metafile = resolve(outputDir, "metafile.json");
  const sourcemap = resolve(outputDir, `acp${ext}.map`);

  const args = [
    ENTRY,
    "--bundle",
    `--platform=${variant.platform}`,
    `--target=${variant.target}`,
    `--format=${variant.format}`,
    `--outfile=${outputFile}`,
    `--metafile=${metafile}`,
    "--log-level=warning",
  ];

  args.push(variant.treeShaking ? "--tree-shaking=true" : "--tree-shaking=false");
  args.push(variant.minify ? "--minify" : "--minify=false");
  if (variant.sourcemap) {
    args.push("--sourcemap");
  }

  // CommonJS shim for import.meta.url
  if (variant.format === "cjs") {
    args.push("--banner:js=const import_meta_url = require('url').pathToFileURL(__filename).href;");
    args.push("--define:import.meta.url=import_meta_url");
  }

  if (variant.externalizeDependencies) {
    for (const dep of buildExternalList()) {
      args.push(`--external:${dep}`);
    }
  }

  return {
    args,
    outputDir,
    outputFile,
    metafile,
    sourcemap,
    ext,
  };
}

/*
|--------------------------------------------------------------------------
| Build One Variant
|--------------------------------------------------------------------------
*/

async function buildVariant(variant) {
  log("");
  log("========================================");
  log(`VARIANT: ${variant.name}`);
  log(`DESCRIPTION: ${variant.description}`);
  log("========================================");

  const paths = buildArguments(variant);
  const started = Date.now();

  const buildOptions = {
    entryPoints: [ENTRY],
    bundle: true,
    platform: variant.platform,
    target: variant.target,
    format: variant.format,
    outfile: paths.outputFile,
    metafile: true,
    sourcemap: !!variant.sourcemap,
    treeShaking: !!variant.treeShaking,
    minify: !!variant.minify,
    external: variant.externalizeDependencies ? buildExternalList() : [],
  };

  if (variant.format === "cjs") {
    buildOptions.banner = {
      js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
    };
    buildOptions.define = {
      "import.meta.url": "import_meta_url",
    };
  }

  const buildResult = await esbuild.build(buildOptions);
  const duration = Date.now() - started;
  writeFileSync(paths.metafile, JSON.stringify(buildResult.metafile, null, 2), "utf8");
  const outputBytes = fileSize(paths.outputFile);

  const report = {
    name: variant.name,
    description: variant.description,
    success: true,
    durationMs: duration,
    esbuild: {
      version: esbuild.version,
    },
    configuration: variant,
    files: {
      output: relative(ROOT, paths.outputFile),
      metafile: relative(ROOT, paths.metafile),
      sourcemap: existsSync(paths.sourcemap) ? relative(ROOT, paths.sourcemap) : null,
    },
    output: {
      bytes: outputBytes,
      humanSize: formatBytes(outputBytes),
    },
  };

  writeJson(resolve(REPORT_ROOT, `${variant.name}.build.json`), report);
  log(`  -> Output: ${relative(ROOT, paths.outputFile)} (${formatBytes(outputBytes)}) in ${duration}ms`);

  return {
    ...report,
    paths,
  };
}

/*
|--------------------------------------------------------------------------
| Main Build Runner
|--------------------------------------------------------------------------
*/

async function main() {
  log("Starting Control Plane multi-variant build harness...");
  log(`Root: ${ROOT}`);
  log(`Entry: ${relative(ROOT, ENTRY)}`);
  log(`Target: ${NODE_TARGET}`);

  if (CLEAN && !SELECTED_VARIANT) {
    log("Cleaning output directory: build/dev");
    removeDir(OUT_ROOT);
  }

  ensureDir(OUT_ROOT);
  ensureDir(REPORT_ROOT);

  const results = [];
  for (const variant of VARIANTS) {
    try {
      const res = await buildVariant(variant);
      results.push(res);
    } catch (err) {
      console.error(`Build failed for ${variant.name}:`, err.message);
      process.exit(1);
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    entry: relative(ROOT, ENTRY),
    target: NODE_TARGET,
    variants: results.map(r => ({
      name: r.name,
      output: r.files.output,
      bytes: r.output.bytes,
      humanSize: r.output.humanSize,
      durationMs: r.durationMs,
    })),
  };

  writeJson(resolve(OUT_ROOT, "summary.json"), summary);
  log("");
  log("========================================");
  log(" ALL VARIANTS BUILT SUCCESSFULLY");
  log(` Summary: ${relative(ROOT, resolve(OUT_ROOT, "summary.json"))}`);
  log("========================================");
}

main().catch(err => {
  console.error("[build:fatal]", err);
  process.exit(1);
});

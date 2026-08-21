#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptsRoot = __dirname;
const repositoryRoot = path.resolve(scriptsRoot, "..", "..", "..", "..");
const testPaths = [
  path.join(repositoryRoot, "tests", "build_runtime_portability.test.js"),
  path.join(repositoryRoot, "tests", "build_core_release_policy.test.js"),
];
// This is the small trust kernel every provider/renderer receipt and every
// candidate/final preflight actually crosses.  Broader compiler and rendering
// coverage is reported by their own suites; it is intentionally not blended
// into this release-kernel gate.
const coreReleaseScope = Object.freeze([
  "runtime/hash_bound_receipt.js",
  "runtime/release_gate.js",
]);
const c8 = path.join(scriptsRoot, "node_modules", "c8", "bin", "c8.js");
const args = [
  c8,
  "--all",
  "--check-coverage",
  "--lines=90",
  "--branches=85",
  "--reporter=text",
  ...coreReleaseScope.map((file) => `--include=${file}`),
  process.execPath,
  "--test",
  ...testPaths,
];
process.stdout.write([
  "Deckformance core-release coverage scope:",
  ...coreReleaseScope.map((file) => `  - ${file}`),
  "Required aggregate coverage: lines >= 90%, branches >= 85%",
  "",
].join("\n"));
const result = spawnSync(process.execPath, args, { cwd: scriptsRoot, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);

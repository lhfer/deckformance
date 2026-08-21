#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHashBoundReceipt, sha256File } = require("./runtime/hash_bound_receipt");
const { findExecutable, portableRendererRegistry } = require("./runtime/renderer_registry");
const { STATUS_EXIT_CODE, SUPPORTED_RELEASES, statusForChecks } = require("./runtime/release_gate");
const { discoverFontFiles, normalizeFamily } = require("./typography");

function makeCheck(id, status, required, summary, detail = {}) {
  return { id, status, required: Boolean(required), summary, detail };
}

function detectHost(options = {}) {
  const explicit = String((options.env || process.env).DECKFORMANCE_HOST || "").trim().toLowerCase();
  if (explicit) return { id: explicit, detectedBy: "DECKFORMANCE_HOST" };
  const normalized = path.resolve(options.skillRoot || path.join(__dirname, "..")).split(path.sep).join("/");
  const match = normalized.match(/\.(grok|qwen|codex|claude)\/skills(?:\/|$)/);
  return match ? { id: match[1], detectedBy: "skill-path" } : { id: "unknown", detectedBy: "none" };
}

function parseMajor(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : null;
}

function exactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || ""));
}

function checkNodeRuntime(options) {
  const version = options.nodeVersion || process.version;
  const major = parseMajor(version);
  const ok = major === 20 || major === 22;
  return makeCheck(
    "node-runtime",
    ok ? "pass" : "fail",
    true,
    ok ? `Node ${version} is supported` : `Node ${version} is outside the supported Node 20/22 range`,
    { version, major, engines: ">=20 <21 || >=22 <23" },
  );
}

function packageVersion(packageRoot, name) {
  const entry = path.join(packageRoot, "node_modules", ...name.split("/"), "package.json");
  if (!fs.existsSync(entry)) throw new Error(`${name} is not installed`);
  return JSON.parse(fs.readFileSync(entry, "utf8")).version;
}

function checkNodeDependencies(options) {
  const scriptsRoot = options.scriptsRoot;
  const packagePath = path.join(scriptsRoot, "package.json");
  const lockPath = path.join(scriptsRoot, "package-lock.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const declared = manifest.dependencies || {};
    const rootLock = (lock.packages && lock.packages[""]) || {};
    const problems = [];
    const installed = {};
    for (const [name, version] of Object.entries(declared)) {
      if (!exactVersion(version)) problems.push(`${name} is not exactly pinned (${version})`);
      if (!rootLock.dependencies || rootLock.dependencies[name] !== version) problems.push(`${name} differs between package.json and package-lock.json`);
      try {
        installed[name] = packageVersion(scriptsRoot, name);
        if (installed[name] !== version) problems.push(`${name} installed ${installed[name]}, expected ${version}`);
      } catch {
        problems.push(`${name} is not installed; run npm ci in ${scriptsRoot}`);
      }
    }
    return makeCheck(
      "node-dependencies",
      problems.length ? "fail" : "pass",
      true,
      problems.length ? "Node dependencies are not reproducibly installed" : "Node dependencies match the lockfile",
      { manifestSha256: sha256File(packagePath), lockSha256: sha256File(lockPath), installed, problems },
    );
  } catch (error) {
    return makeCheck("node-dependencies", "fail", true, "Node dependency manifests are unreadable", { error: error.message });
  }
}

function probeCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 5000,
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error ? result.error.message : String(result.stderr || result.stdout || "").trim() };
  }
  return { ok: true, output: String(result.stdout || result.stderr || "").trim() };
}

function checkPython(options) {
  const env = options.env || process.env;
  const executable = env.DECKFORMANCE_PYTHON || findExecutable("python3", { env, platform: options.platform });
  if (!executable) return makeCheck("python-runtime", "fail", true, "Python 3 was not found", {});
  const result = probeCommand(executable, ["-c", "import json,platform,PIL; print(json.dumps({'python':platform.python_version(),'pillow':PIL.__version__}))"], { env });
  if (!result.ok) {
    return makeCheck("python-runtime", "fail", true, "Python is present but the locked Pillow runtime is unavailable", { path: executable, error: result.error });
  }
  let versions;
  try {
    versions = JSON.parse(result.output);
  } catch {
    return makeCheck("python-runtime", "fail", true, "Python dependency probe returned invalid JSON", { path: executable, output: result.output });
  }
  const lockPath = path.join(options.scriptsRoot, "requirements.lock.txt");
  const lock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : "";
  const match = lock.match(/^Pillow==([^\s#]+)$/m);
  const [pythonMajor, pythonMinor] = String(versions.python || "").split(".").map(Number);
  const pythonSupported = pythonMajor === 3 && pythonMinor >= 10;
  const ok = Boolean(pythonSupported && match && match[1] === versions.pillow);
  return makeCheck(
    "python-runtime",
    ok ? "pass" : "fail",
    true,
    ok ? `Python ${versions.python} and Pillow ${versions.pillow} match the lock` : "Python must be >=3.10 and Pillow must match requirements.lock.txt",
    { path: executable, ...versions, pythonSupported, expectedPillow: match ? match[1] : null, lockSha256: fs.existsSync(lockPath) ? sha256File(lockPath) : null },
  );
}

function checkMediaTools(options) {
  const env = options.env || process.env;
  const detail = {};
  const missing = [];
  for (const name of ["ffmpeg", "ffprobe"]) {
    const executable = findExecutable(env[`DECKFORMANCE_${name.toUpperCase()}`] || name, { env, platform: options.platform });
    const probe = executable ? probeCommand(executable, ["-version"], { env }) : { ok: false, error: `${name} not found` };
    if (!probe.ok) missing.push(name);
    detail[name] = {
      path: executable,
      version: probe.ok ? probe.output.split(/\r?\n/, 1)[0] : null,
      error: probe.ok ? null : probe.error,
    };
  }
  if (detail.ffmpeg.path) {
    const encoders = probeCommand(detail.ffmpeg.path, ["-hide_banner", "-encoders"], { env, timeout: 15000 });
    detail.ffmpeg.libx264 = encoders.ok && /\blibx264\b/.test(encoders.output);
    if (!detail.ffmpeg.libx264) missing.push("ffmpeg/libx264");
  }
  return makeCheck(
    "media-tools",
    missing.length ? "fail" : "pass",
    true,
    missing.length ? `Missing media tools: ${missing.join(", ")}` : "FFmpeg and FFprobe are available",
    detail,
  );
}

function fontFamilies(options) {
  const env = options.env || process.env;
  if (env.DECKFORMANCE_REQUIRED_FONTS) return env.DECKFORMANCE_REQUIRED_FONTS.split(",").map((item) => item.trim()).filter(Boolean);
  try {
    const layouts = JSON.parse(fs.readFileSync(path.join(options.skillRoot, "references", "layouts.json"), "utf8"));
    return [layouts.fonts && layouts.fonts.face].filter(Boolean);
  } catch {
    return [];
  }
}

function checkFonts(options) {
  const env = options.env || process.env;
  const required = fontFamilies(options);
  if (!required.length) return makeCheck("fonts", "fail", true, "No required font families were declared", {});
  if (env.DECKFORMANCE_FONT_MANIFEST) {
    try {
      const manifestPath = path.resolve(env.DECKFORMANCE_FONT_MANIFEST);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const missing = required.filter((family) => !manifest[family] || !fs.existsSync(manifest[family]));
      const files = Object.fromEntries(required.filter((family) => !missing.includes(family)).map((family) => [family, { path: path.resolve(manifest[family]), sha256: sha256File(manifest[family]) }]));
      return makeCheck("fonts", missing.length ? "fail" : "pass", true, missing.length ? `Required fonts are missing: ${missing.join(", ")}` : "Required fonts are available and hash-bound", { required, files, manifestPath, manifestSha256: sha256File(manifestPath) });
    } catch (error) {
      return makeCheck("fonts", "fail", true, "Font manifest is unreadable", { error: error.message });
    }
  }
  const fcList = findExecutable("fc-list", { env, platform: options.platform });
  const fcMatch = findExecutable("fc-match", { env, platform: options.platform });
  const files = {};
  let missing = [...required];
  if (fcList && fcMatch) {
    const listed = probeCommand(fcList, [":", "family"], { env, timeout: 15000 });
    if (listed.ok) {
      const available = new Set(listed.output.split(/\r?\n/).flatMap((line) => line.split(",")).map((item) => item.trim().toLowerCase()).filter(Boolean));
      missing = required.filter((family) => !available.has(family.toLowerCase()));
      for (const family of required.filter((item) => !missing.includes(item))) {
        const match = probeCommand(fcMatch, ["-f", "%{file}\n", family], { env });
        const filePath = match.ok ? match.output.split(/\r?\n/, 1)[0] : null;
        if (filePath && fs.existsSync(filePath)) files[family] = { path: filePath, sha256: sha256File(filePath) };
        else missing.push(family);
      }
    }
  }
  // macOS does not ship fontconfig. Reuse the typography engine's deterministic
  // system-font discovery instead of forcing a user-authored manifest.
  if (missing.length) {
    const discovered = discoverFontFiles();
    for (const family of [...new Set(missing)]) {
      const requested = normalizeFamily(family);
      const match = discovered.find((filePath) => {
        const candidate = normalizeFamily(path.basename(filePath, path.extname(filePath)));
        return candidate === requested || (candidate.length >= 4 && requested.startsWith(candidate)) || (requested.length >= 4 && candidate.startsWith(requested));
      });
      if (match) files[family] = { path: match, sha256: sha256File(match) };
    }
    missing = required.filter((family) => !files[family]);
  }
  return makeCheck("fonts", missing.length ? "fail" : "pass", true, missing.length ? `Required fonts are missing: ${[...new Set(missing)].join(", ")}` : "Required fonts are available and hash-bound", { required, files });
}

async function checkRenderer(options) {
  const registry = options.rendererRegistry || portableRendererRegistry(options);
  const resolution = await registry.resolve({ platform: options.platform, requiredCapabilities: { pptxToPng: true, overflowCheck: true } });
  if (resolution.selected) {
    return makeCheck("renderer", "pass", true, `Renderer ${resolution.selected.id} satisfies render and overflow gates`, { selected: resolution.selected, probes: resolution.probes });
  }
  const fallback = resolution.probes.find((probe) => probe.available && probe.capabilities.pptxToPng);
  return makeCheck(
    "renderer",
    "fail",
    true,
    fallback ? `${fallback.id} can render PPTX but cannot satisfy the overflow evidence gate` : "No PPTX renderer is available",
    { selected: null, probes: resolution.probes },
  );
}

async function checkPowerPoint(options) {
  const registry = options.rendererRegistry || portableRendererRegistry(options);
  const resolution = await registry.resolve({ platform: options.platform, requiredCapabilities: { powerPointPlayback: true } });
  const required = options.release === "final";
  if (!required) return makeCheck("powerpoint", "pass", false, "PowerPoint playback is not required for candidate preflight", { skipped: true });
  return makeCheck(
    "powerpoint",
    resolution.selected ? "pass" : "fail",
    true,
    resolution.selected ? "Native PowerPoint is available for final playback verification" : "Final release requires native Microsoft PowerPoint playback capability",
    { selected: resolution.selected, probes: resolution.probes },
  );
}

function checkProvider(options) {
  const env = options.env || process.env;
  const provider = String(env.DECKFORMANCE_PROVIDER || "").trim();
  let capabilities = [];
  const rawCapabilities = String(env.DECKFORMANCE_PROVIDER_CAPABILITIES || "").trim();
  if (rawCapabilities) {
    try {
      const parsed = JSON.parse(rawCapabilities);
      capabilities = Array.isArray(parsed) ? parsed.map(String) : Object.entries(parsed).filter(([, enabled]) => enabled === true).map(([name]) => name);
    } catch {
      capabilities = rawCapabilities.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  capabilities = [...new Set(capabilities)].sort();
  const generationReady = capabilities.includes("generate-video");
  return makeCheck(
    "provider",
    provider && generationReady ? "pass" : "warn",
    false,
    provider && generationReady
      ? `Provider adapter ${provider} declares generate-video capability; a live model invocation is still required before media-ready`
      : provider
        ? `Provider adapter ${provider} is configured without an explicit generate-video capability declaration`
        : "No external video provider is configured; work may continue only through design/preview until a real model is invoked",
    { provider: provider || null, capabilities, generationReady },
  );
}

function checkAssetStore(options) {
  const files = ["runtime/asset_store.js", "runtime/hash_bound_receipt.js"];
  const missing = files.filter((relative) => !fs.existsSync(path.join(options.scriptsRoot, relative)));
  return makeCheck("asset-store", missing.length ? "fail" : "pass", true, missing.length ? "Hash-bound AssetStore implementation is missing" : "Hash-bound AssetStore interface is available", { implementationFiles: files, missing });
}

async function runDoctor(options = {}) {
  const scriptsRoot = path.resolve(options.scriptsRoot || __dirname);
  const skillRoot = path.resolve(options.skillRoot || path.join(scriptsRoot, ".."));
  const release = options.release || "candidate";
  if (!SUPPORTED_RELEASES.includes(release)) throw new Error("release must be candidate or final");
  const context = {
    ...options,
    scriptsRoot,
    skillRoot,
    release,
    env: options.env || process.env,
    platform: options.platform || process.platform,
  };
  const host = detectHost(context);
  const system = { platform: context.platform, arch: process.arch };
  const checks = options.checks || [
    checkNodeRuntime(context),
    checkNodeDependencies(context),
    checkPython(context),
    checkMediaTools(context),
    checkFonts(context),
    await checkRenderer(context),
    checkProvider(context),
    checkAssetStore(context),
    await checkPowerPoint(context),
  ];
  const status = statusForChecks(checks);
  const receipt = createHashBoundReceipt({
    root: scriptsRoot,
    kind: "runtime",
    producer: { name: "deckformance/doctor", version: "2" },
    implementationFiles: [
      "doctor.js",
      "runtime/hash_bound_receipt.js",
      "runtime/provider_adapter.js",
      "runtime/renderer_adapter.js",
      "runtime/renderer_registry.js",
      "runtime/render_trust.js",
      "runtime/asset_store.js",
      "runtime/release_gate.js",
      "typography.js",
    ],
    inputs: ["package.json", "package-lock.json", "requirements.lock.txt"],
    outputs: [],
    metadata: {
      release,
      status,
      host,
      system,
      checks,
    },
  });
  return {
    schemaVersion: "2.0.0",
    command: "doctor",
    host,
    system,
    release,
    status,
    exitCode: STATUS_EXIT_CODE[status],
    checkedAt: new Date().toISOString(),
    checks,
    runtimeReceipt: receipt,
  };
}

function parseArgs(argv) {
  const options = { release: "candidate", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--release" || arg.startsWith("--release=")) {
      options.release = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!SUPPORTED_RELEASES.includes(options.release)) throw new Error("--release must be candidate or final");
  return options;
}

function printHuman(result) {
  console.log(`${result.status.toUpperCase()} doctor (${result.release})`);
  for (const check of result.checks) console.log(`- ${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(64);
  }
  const result = await runDoctor(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exit(result.exitCode);
}

module.exports = {
  STATUS_EXIT_CODE,
  SUPPORTED_RELEASES,
  checkAssetStore,
  checkFonts,
  checkMediaTools,
  checkNodeDependencies,
  checkNodeRuntime,
  checkPowerPoint,
  checkProvider,
  checkPython,
  checkRenderer,
  detectHost,
  exactVersion,
  makeCheck,
  parseArgs,
  runDoctor,
  statusForChecks,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

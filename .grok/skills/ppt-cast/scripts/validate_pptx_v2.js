#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const AjvModule = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { collectMedia } = require("./build_deck_v2");
const { compileDeck } = require("./compile_deck_v2");
const { sha256, validatePackageBuffer } = require("./pptx_package");

const Ajv2020 = AjvModule.default || AjvModule;
const SCHEMA_VERSION = "2.0.0";
const PRODUCER_ID = "deckformance/validate-pptx-v2";
const PRODUCER_VERSION = "2.0.0";
const CONTRACT_FILES = Object.freeze({
  contentPlan: "content-plan.json",
  visualPlan: "visual-plan.json",
  designPlan: "design-plan.json",
  assetManifest: "asset-manifest.json",
  deck: "deck.json",
});

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function validHash(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return !parts.some((part) => !part || part === "." || part === "..") && path.posix.normalize(value) === value;
}

function resolveJobFile(jobDir, value, options = {}) {
  const root = fs.realpathSync(path.resolve(jobDir));
  let target;
  if (path.isAbsolute(value)) {
    target = path.resolve(value);
  } else {
    if (!isSafeRelativePath(value)) fail(`unsafe job-relative path: ${String(value)}`);
    target = path.resolve(root, ...value.split("/"));
  }
  let cursor = target;
  const missingSegments = [];
  while (!fs.existsSync(cursor) && path.dirname(cursor) !== cursor) {
    missingSegments.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }
  const canonicalTarget = fs.existsSync(cursor) ? path.join(fs.realpathSync(cursor), ...missingSegments) : target;
  const relative = path.relative(root, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`path leaves job directory: ${value}`);
  if (options.mustExist !== false) {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) fail(`missing regular file: ${relative.split(path.sep).join("/")}`);
    const real = fs.realpathSync(target);
    const realRelative = path.relative(root, real);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) fail(`symlink leaves job directory: ${value}`);
    target = real;
  } else {
    target = canonicalTarget;
  }
  return target;
}

function relativeToJob(jobDir, filePath) {
  const root = fs.realpathSync(path.resolve(jobDir));
  const relative = path.relative(root, path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("PPTX must be inside the job directory");
  return relative.split(path.sep).join("/");
}

function readJson(filePath, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must contain a JSON object`);
    return value;
  } catch (error) {
    if (error.isUserError) throw error;
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

let validators = null;
function schemaValidators() {
  if (validators) return validators;
  const schemaDir = path.resolve(__dirname, "..", "schemas", "v2");
  const names = ["typography", "content-plan", "visual-plan", "design-plan", "asset-manifest", "deck"];
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const schemas = Object.fromEntries(names.map((name) => [name, readJson(path.join(schemaDir, `${name}.schema.json`), `${name} schema`)]));
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  validators = Object.fromEntries(names.map((name) => [name, ajv.getSchema(schemas[name].$id)]));
  return validators;
}

function assertSchema(value, name) {
  const validator = schemaValidators()[name];
  if (validator(value)) return;
  const details = (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  fail(`${name}.json failed v2 schema validation: ${details}`);
}

function loadContracts(jobDir) {
  const contracts = {};
  const hashes = {};
  for (const [key, fileName] of Object.entries(CONTRACT_FILES)) {
    const filePath = resolveJobFile(jobDir, fileName);
    contracts[key] = readJson(filePath, fileName);
    hashes[key] = hashFile(filePath);
  }
  assertSchema(contracts.contentPlan, "content-plan");
  assertSchema(contracts.visualPlan, "visual-plan");
  assertSchema(contracts.designPlan, "design-plan");
  assertSchema(contracts.assetManifest, "asset-manifest");
  assertSchema(contracts.deck, "deck");
  return { contracts, hashes };
}

function assertBindings(jobDir, contracts, hashes) {
  const { contentPlan, visualPlan, designPlan, assetManifest, deck } = contracts;
  const jobIds = [contentPlan.jobId, visualPlan.jobId, designPlan.jobId, assetManifest.jobId, deck.jobId];
  if (new Set(jobIds).size !== 1) fail(`v2 contract jobId values do not match: ${jobIds.join(", ")}`);
  if (contentPlan.planningStatus !== "approved" || visualPlan.planningStatus !== "approved") fail("v2 package validation requires approved content and visual plans");
  if (designPlan.releaseEligibility !== "candidate-ready") fail("design-plan.json is not candidate-ready");
  if (visualPlan.upstreamHashes.contentPlan !== hashes.contentPlan) fail("visual-plan.json does not bind content-plan.json");
  if (designPlan.compiledFrom.contentPlan !== hashes.contentPlan || designPlan.compiledFrom.visualPlan !== hashes.visualPlan) {
    fail("design-plan.json does not bind the current content and visual plans");
  }
  for (const key of ["contentPlan", "visualPlan", "designPlan"]) {
    if (assetManifest.upstreamHashes[key] !== hashes[key]) fail(`asset-manifest.json does not bind ${CONTRACT_FILES[key]}`);
  }
  for (const key of ["contentPlan", "visualPlan", "designPlan", "assetManifest"]) {
    if (!deck.compiledFrom || deck.compiledFrom[key] !== hashes[key]) fail(`deck.json does not bind ${CONTRACT_FILES[key]}`);
  }
  if (deck.releaseLevel !== "candidate" || Object.hasOwn(deck, "powerpointVerification")) {
    fail("deck.json must remain a candidate contract and must not embed PowerPoint evidence");
  }
  const expectedDeck = compileDeck({ jobDir, designPlan, manifest: assetManifest, hashes });
  if (!util.isDeepStrictEqual(deck, expectedDeck)) fail("deck.json differs from a fresh deterministic compile of the bound design plan and asset manifest");
  return contentPlan.jobId;
}

function videoSlidesForPackage(designPlan, mediaByLayer) {
  const slides = [];
  designPlan.slides.forEach((slide, index) => {
    if (slide.mediaMode !== "hybrid-video") return;
    const layers = slide.layers.filter((layer) => layer.type === "video");
    if (layers.length !== 1) fail(`slide ${slide.id} must resolve exactly one video layer`);
    const media = mediaByLayer.get(layers[0].id);
    if (!media) fail(`slide ${slide.id} has no collected media for layer ${layers[0].id}`);
    slides.push({
      slideNumber: index + 1,
      layerId: layers[0].id,
      posterSha256: media.posterSha256,
      videoSha256: media.videoSha256,
      durationMs: media.durationMs,
      volume: 0,
    });
  });
  return slides;
}

function emptyPackageResult(release) {
  return {
    valid: false,
    passed: false,
    errors: [],
    slideCount: 0,
    expectedContentPages: 0,
    embeddedVideoCount: 0,
    posterCount: 0,
    timingCount: 0,
    relationshipsValid: false,
    mimeTypesValid: false,
    aspectRatiosValid: false,
    release,
  };
}

async function validatePptxV2(jobDirValue, pptxValue, options = {}) {
  const release = options.release || "candidate";
  if (release !== "candidate") fail("v2 PPTX package validation accepts candidate bytes only; final is an exact-byte promotion with external PowerPoint evidence");
  const jobDir = fs.realpathSync(path.resolve(jobDirValue));
  if (!fs.statSync(jobDir).isDirectory()) fail(`job directory not found: ${jobDir}`);
  const pptxPath = resolveJobFile(jobDir, pptxValue);
  if (path.extname(pptxPath).toLowerCase() !== ".pptx") fail("package path must end in .pptx");
  const artifactPath = relativeToJob(jobDir, pptxPath);
  const artifactBytes = fs.readFileSync(pptxPath);
  const artifactSha256 = sha256(artifactBytes);
  const { contracts, hashes } = loadContracts(jobDir);
  const jobId = assertBindings(jobDir, contracts, hashes);
  const errors = [];
  let collected = null;
  let packageQa = emptyPackageResult(release);
  try {
    collected = (options.collectMediaImpl || collectMedia)(jobDir, contracts.designPlan, contracts.assetManifest, {
      release: options.requireHumanApproval === true ? "final" : "candidate",
    });
  } catch (error) {
    errors.push(`collectMedia: ${error.message}`);
  }
  if (collected) {
    try {
      const videoSlides = videoSlidesForPackage(contracts.designPlan, collected.mediaByLayer);
      packageQa = await (options.validatePackageBufferImpl || validatePackageBuffer)(artifactBytes, {
        release,
        videoSlides,
        expectedMediaCount: collected.dynamicSlides.length,
        expectedContentPages: collected.dynamicSlides.length,
        aspectRatiosValid: true,
      });
      errors.push(...(packageQa.errors || []));
    } catch (error) {
      errors.push(`validatePackageBuffer: ${error.message}`);
    }
  }
  const passed = errors.length === 0 && Boolean(collected) && packageQa.passed === true;
  const report = {
    schemaVersion: SCHEMA_VERSION,
    receiptType: "deckformance-package-qa",
    producer: {
      id: PRODUCER_ID,
      version: PRODUCER_VERSION,
      implementationSha256: hashFile(__filename),
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: {
        version: process.version,
        executable: path.basename(process.execPath),
        sha256: hashFile(process.execPath),
      },
    },
    jobId,
    release,
    artifactPath,
    artifactSha256,
    contentPlanSha256: hashes.contentPlan,
    visualPlanSha256: hashes.visualPlan,
    designPlanSha256: hashes.designPlan,
    assetManifestSha256: hashes.assetManifest,
    deckSha256: hashes.deck,
    slideCount: packageQa.slideCount,
    expectedContentPages: packageQa.expectedContentPages,
    embeddedVideoCount: packageQa.embeddedVideoCount,
    posterCount: packageQa.posterCount,
    timingCount: packageQa.timingCount,
    embeddedMediaBytes: packageQa.embeddedMediaBytes,
    maxEmbeddedMediaBytes: packageQa.maxEmbeddedMediaBytes,
    relationshipsValid: packageQa.relationshipsValid === true,
    mimeTypesValid: packageQa.mimeTypesValid === true,
    aspectRatiosValid: packageQa.aspectRatiosValid === true,
    collectMediaPassed: Boolean(collected),
    checkedAt: (options.now || (() => new Date()))().toISOString(),
    errors,
    passed,
  };
  if (options.reportPath) {
    const target = resolveJobFile(jobDir, options.reportPath, { mustExist: false });
    atomicWrite(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, filePath);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = { release: "candidate", reportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal >= 0 ? arg.slice(0, equal) : arg;
    let value = equal >= 0 ? arg.slice(equal + 1) : null;
    if (!["--release", "--report"].includes(name)) fail(`unknown option: ${arg}`);
    if (value === null) {
      value = argv[++index];
      if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    }
    if (name === "--release") options.release = value;
    else options.reportPath = value;
  }
  if (positional.length !== 2) fail("usage: node validate_pptx_v2.js <job-dir> <file.pptx> [--release candidate] [--report qa/package-qa.json]");
  return { jobDir: positional[0], pptxPath: positional[1], ...options };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = await validatePptxV2(args.jobDir, args.pptxPath, args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(2);
  });
}

module.exports = {
  CONTRACT_FILES,
  PRODUCER_ID,
  PRODUCER_VERSION,
  assertBindings,
  hashFile,
  loadContracts,
  parseArgs,
  validatePptxV2,
  videoSlidesForPackage,
};

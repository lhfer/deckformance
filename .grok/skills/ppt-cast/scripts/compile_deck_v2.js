#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const SCHEMA_DIR = path.resolve(__dirname, "..", "schemas", "v2");
const MAX_DECK_MEDIA_BYTES = 100 * 1024 * 1024;

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function readJson(filePath, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must contain a JSON object`);
    return value;
  } catch (error) {
    if (error.isUserError) throw error;
    fail(`${label} cannot be read as JSON: ${error.message}`);
  }
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function isSafeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return !parts.some((part) => !part || part === "." || part === "..") && path.posix.normalize(value) === value;
}

function resolveJobFile(jobDir, relativePath, label) {
  if (!isSafeRelative(relativePath)) fail(`${label} must be a normalized job-relative path`);
  const candidate = path.resolve(jobDir, ...relativePath.split("/"));
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) fail(`${label} not found: ${relativePath}`);
  const relative = path.relative(fs.realpathSync(jobDir), fs.realpathSync(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${label} resolves outside the job directory`);
  return candidate;
}

function assertSafeOutputParent(jobDir, output) {
  let existing = path.dirname(output);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail("output parent cannot be resolved inside the job directory");
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const relative = path.relative(jobDir, realExisting);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("output parent resolves outside the job directory");
  let cursor = jobDir;
  const lexical = path.relative(jobDir, path.dirname(output));
  for (const segment of lexical.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail("output parent must not contain symbolic links");
  }
}

function assertDescriptor(jobDir, descriptor, label) {
  if (!descriptor || !Number.isInteger(descriptor.bytes) || descriptor.bytes < 1) fail(`${label} must declare positive bytes`);
  const filePath = resolveJobFile(jobDir, descriptor.path, `${label}.path`);
  const actualHash = hashFile(filePath);
  const actualBytes = fs.statSync(filePath).size;
  if (descriptor.sha256 !== actualHash) fail(`${label}.sha256 is stale: declared ${descriptor.sha256}, actual ${actualHash}`);
  if (descriptor.bytes !== actualBytes) fail(`${label}.bytes is stale: declared ${descriptor.bytes}, actual ${actualBytes}`);
}

function createValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const names = ["design-plan", "asset-manifest", "deck"];
  const schemas = Object.fromEntries(names.map((name) => [name, readJson(path.join(SCHEMA_DIR, `${name}.schema.json`), `${name} schema`)]));
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  return Object.fromEntries(names.map((name) => [name, ajv.getSchema(schemas[name].$id)]));
}

function validateSchema(validator, value, label) {
  if (validator(value)) return;
  const details = (validator.errors || []).map((error) => `${label}${error.instancePath || ""}: ${error.message}`).join("\n- ");
  fail(`${label} schema validation failed:\n- ${details}`);
}

function parseArgs(argv) {
  const positional = [];
  let output = "deck.json";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (arg === "--output") {
      output = argv[++index];
      if (!output || output.startsWith("--")) fail("--output requires a value");
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  if (positional.length !== 1) fail("usage: compile_deck_v2.js <job-dir> [--output deck.json]");
  if (!isSafeRelative(output)) fail("--output must be a normalized job-relative path");
  return { jobDir: path.resolve(positional[0]), output };
}

function compileDeck({ jobDir, designPlan, manifest, hashes }) {
  if (designPlan.releaseEligibility !== "candidate-ready") fail("design-plan.json is draft-only and cannot compile a candidate deck");
  if (designPlan.jobId !== manifest.jobId) fail("design-plan.json and asset-manifest.json job IDs do not match");
  if (designPlan.compiledFrom.contentPlan !== hashes.contentPlan) fail("design-plan.json does not bind the current content-plan.json");
  if (designPlan.compiledFrom.visualPlan !== hashes.visualPlan) fail("design-plan.json does not bind the current visual-plan.json");
  if (manifest.upstreamHashes.contentPlan !== hashes.contentPlan) fail("asset-manifest.json does not bind the current content-plan.json");
  if (manifest.upstreamHashes.visualPlan !== hashes.visualPlan) fail("asset-manifest.json does not bind the current visual-plan.json");
  if (manifest.upstreamHashes.designPlan !== hashes.designPlan) fail("asset-manifest.json does not bind the current design-plan.json");

  const records = new Map();
  for (const record of manifest.slides) {
    if (records.has(record.mediaKey)) fail(`asset-manifest.json duplicates mediaKey ${record.mediaKey}`);
    assertDescriptor(jobDir, record.poster, `asset-manifest slide ${record.id} poster`);
    assertDescriptor(jobDir, record.video, `asset-manifest slide ${record.id} video`);
    records.set(record.mediaKey, record);
  }

  let dynamicCount = 0;
  let totalBytes = 0;
  const consumed = new Set();
  const slides = designPlan.slides.map((slide) => {
    const copy = JSON.parse(JSON.stringify(slide));
    const videoLayers = copy.layers.filter((layer) => layer.type === "video");
    if (copy.mediaMode === "static-native") {
      if (videoLayers.length) fail(`slide ${copy.id} static-native mode cannot contain a video layer`);
      return copy;
    }
    if (videoLayers.length !== 1) fail(`slide ${copy.id} hybrid-video mode requires exactly one video layer`);
    const layer = videoLayers[0];
    const record = records.get(layer.mediaKey);
    if (!record || record.id !== copy.id || record.layerId !== layer.id) fail(`slide ${copy.id} has no manifest media bound to ${layer.id}`);
    if (consumed.has(record.mediaKey)) fail(`manifest mediaKey ${record.mediaKey} is consumed more than once`);
    consumed.add(record.mediaKey);
    layer.poster = record.poster.path;
    layer.video = record.video.path;
    dynamicCount += 1;
    totalBytes += record.video.bytes + record.poster.bytes;
    return copy;
  });
  if (dynamicCount < 1) fail("compiled candidate requires at least one hybrid-video slide");
  if (consumed.size !== records.size) fail("asset-manifest.json must exactly cover the hybrid-video slides");
  const usedAssets = new Set(slides.flatMap((slide) => slide.layers.filter((layer) => layer.assetId).map((layer) => layer.assetId)));
  const countedAssets = new Set();
  for (const asset of designPlan.registeredAssets || []) {
    if (!usedAssets.has(asset.id)) continue;
    if (!asset.path || !asset.sha256) fail(`registered asset ${asset.id} is used but unresolved`);
    const filePath = resolveJobFile(jobDir, asset.path, `registered asset ${asset.id}`);
    const actualHash = hashFile(filePath);
    if (actualHash !== asset.sha256) fail(`registered asset ${asset.id}.sha256 is stale`);
    const identity = `${asset.path}:${asset.sha256}`;
    if (!countedAssets.has(identity)) {
      totalBytes += fs.statSync(filePath).size;
      countedAssets.add(identity);
    }
  }
  if (totalBytes > MAX_DECK_MEDIA_BYTES) fail(`embedded media total ${totalBytes} exceeds ${MAX_DECK_MEDIA_BYTES} bytes`);

  return {
    schemaVersion: "2.0.0",
    artifactKind: "compiled-deck",
    jobId: designPlan.jobId,
    title: designPlan.title,
    releaseLevel: "candidate",
    compiledFrom: {
      contentPlan: hashes.contentPlan,
      visualPlan: hashes.visualPlan,
      designPlan: hashes.designPlan,
      assetManifest: hashes.assetManifest,
    },
    media: { videoVolume: 0, totalBytes, maxTotalBytes: MAX_DECK_MEDIA_BYTES },
    slides,
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!fs.existsSync(args.jobDir) || !fs.statSync(args.jobDir).isDirectory()) fail(`job directory not found: ${args.jobDir}`);
  const jobDir = fs.realpathSync(args.jobDir);
  const paths = Object.fromEntries(["content-plan", "visual-plan", "design-plan", "asset-manifest"].map((name) => [name, path.join(jobDir, `${name}.json`)]));
  for (const [name, filePath] of Object.entries(paths)) if (!fs.existsSync(filePath)) fail(`missing ${name}.json`);
  const designPlan = readJson(paths["design-plan"], "design-plan.json");
  const manifest = readJson(paths["asset-manifest"], "asset-manifest.json");
  const validators = createValidators();
  validateSchema(validators["design-plan"], designPlan, "design-plan.json");
  validateSchema(validators["asset-manifest"], manifest, "asset-manifest.json");
  const hashes = {
    contentPlan: hashFile(paths["content-plan"]),
    visualPlan: hashFile(paths["visual-plan"]),
    designPlan: hashFile(paths["design-plan"]),
    assetManifest: hashFile(paths["asset-manifest"]),
  };
  const deck = compileDeck({ jobDir, designPlan, manifest, hashes });
  validateSchema(validators.deck, deck, "compiled deck.json");
  const output = path.resolve(jobDir, ...args.output.split("/"));
  const relative = path.relative(jobDir, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("--output leaves the job directory");
  assertSafeOutputParent(jobDir, output);
  atomicWriteJson(output, deck);
  process.stdout.write(`${args.output}\n`);
  return deck;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`compile_deck_v2: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertSafeOutputParent, compileDeck, createValidators, main, parseArgs };

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const AjvModule = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { compileDeck } = require("./compile_deck_v2");
const { validateEvaluationReceipt } = require("./evaluation_receipt");
const { parseFrameRate, probe } = require("./media_contract");
const { verifyHashBoundReceipt } = require("./runtime/hash_bound_receipt");
const { verifyTrustedRendererPair } = require("./runtime/render_trust");
const { validatePowerPointLiveAttestation } = require("./runtime/powerpoint_attestation");
const {
  isSafeRelativePath,
  loadJson,
  resolveJobPath,
  sha256File,
} = require("./validate_job");
const { discoverFontFiles } = require("./typography");

const Ajv2020 = AjvModule.default || AjvModule;
const SCHEMA_VERSION = "2.0.0";
const STAGES = Object.freeze([
  "initialized",
  "briefed",
  "researched",
  "content-planned",
  "character-ready",
  "visual-planned",
  "design-planned",
  "media-ready",
  "packaged",
  "qa-passed",
  "candidate-released",
  "final-released",
]);
const CONTRACT_FILES = Object.freeze({
  brief: "brief.json",
  characterModel: "character-model.json",
  contentPlan: "content-plan.json",
  visualPlan: "visual-plan.json",
  designPlan: "design-plan.json",
  assetManifest: "asset-manifest.json",
  deck: "deck.json",
});
const CONTRACT_STAGE = Object.freeze({
  brief: "briefed",
  contentPlan: "content-planned",
  characterModel: "character-ready",
  visualPlan: "visual-planned",
  designPlan: "design-planned",
  assetManifest: "media-ready",
  deck: "packaged",
});
const REQUIRED_RELEASE_TRACKS = Object.freeze(Object.keys(CONTRACT_FILES));
const V2_SCHEMA_NAMES = Object.freeze(["typography", "content-plan", "visual-plan", "design-plan", "asset-manifest", "deck", "job"]);
const EXPECTED_PACKAGE_REPORT = "qa/package-qa.json";
const EXPECTED_RENDER_INDEX = "qa/rendered-candidate/render-index.json";
const EXPECTED_RENDER_QA = "qa/render-qa.json";
const EXPECTED_POWERPOINT_RECEIPT = "qa/powerpoint-verification.json";
const EXPECTED_STAGING = "build/candidate.staging.pptx";
const POWERPOINT_PRODUCER_ID = "deckformance/powerpoint-verify-macos";
const POWERPOINT_PRODUCER_VERSION = "2.0.0";
const FRAME_RATIOS = Object.freeze([0, 0.2, 0.5, 0.8, 1]);
const POWERPOINT_EVENT_SEQUENCE = Object.freeze([
  "enter",
  "autoplay-start",
  "autoplay-end",
  "forward",
  "back",
  "reenter",
  "reentry-autoplay-start",
]);
const HUMANOID_FULL_BODY_PARTS = Object.freeze([
  "head", "torso", "left-arm", "right-arm", "left-hand", "right-hand",
  "left-leg", "right-leg", "left-foot", "right-foot",
]);
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) throw new Error("invalid PNG signature");
  let offset = 8;
  let ihdr = null;
  let ended = false;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("truncated PNG chunk");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    if (declaredCrc !== actualCrc) throw new Error(`${type} CRC mismatch`);
    if (type === "IHDR") ihdr = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") { ended = true; break; }
    offset = end;
  }
  if (!ihdr || ihdr.length !== 13 || idat.length === 0 || !ended) throw new Error("PNG is missing IHDR, IDAT, or IEND");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || width < 1 || height < 1) throw new Error("unsupported or empty PNG image");
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (interlace !== 0) throw new Error("interlaced PNG evidence is not accepted because deterministic full-row decoding is required");
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  if (inflated.length !== (rowBytes + 1) * height) throw new Error("PNG scanline payload length mismatch");
  return { width, height };
}

function issue(errors, code, pointer, message) {
  errors.push({ code, path: pointer, message });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validHash(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

let compiledValidators = null;
function schemaValidators() {
  if (compiledValidators) return compiledValidators;
  const schemasRoot = path.resolve(__dirname, "..", "schemas");
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const result = {};
  for (const name of V2_SCHEMA_NAMES) {
    const schema = loadJson(path.join(schemasRoot, "v2", `${name}.schema.json`));
    ajv.addSchema(schema);
    result[name] = schema.$id;
  }
  for (const name of ["brief", "character-model"]) {
    const schema = loadJson(path.join(schemasRoot, `${name}.schema.json`));
    ajv.addSchema(schema);
    result[name] = schema.$id;
  }
  compiledValidators = Object.fromEntries(Object.entries(result).map(([key, id]) => [key, ajv.getSchema(id)]));
  return compiledValidators;
}

function validateSchema(value, key, pointer, errors) {
  let validator;
  try {
    validator = schemaValidators()[key];
  } catch (error) {
    issue(errors, "SCHEMA_RUNTIME", pointer, error.message);
    return;
  }
  if (validator && validator(value)) return;
  for (const error of validator && validator.errors || []) {
    issue(errors, "SCHEMA_VALIDATION", `${pointer}${error.instancePath || ""}`, `${error.keyword}: ${error.message}`);
  }
}

function loadContract(jobDir, relativePath, pointer, errors, required) {
  let filePath;
  try {
    filePath = resolveJobPath(jobDir, relativePath);
  } catch (error) {
    issue(errors, "UNSAFE_PATH", pointer, error.message);
    return null;
  }
  if (!fs.existsSync(filePath)) {
    if (required) issue(errors, "MISSING_CONTRACT", pointer, `missing ${relativePath}`);
    return null;
  }
  try {
    const value = loadJson(filePath);
    if (!isObject(value)) issue(errors, "INVALID_CONTRACT", pointer, "contract must be a JSON object");
    return isObject(value) ? value : null;
  } catch (error) {
    issue(errors, "INVALID_JSON", pointer, `${relativePath}: ${error.message}`);
    return null;
  }
}

function validatePath(value, pointer, errors) {
  if (!isSafeRelativePath(value)) issue(errors, "UNSAFE_PATH", pointer, "must be a normalized job-relative POSIX path");
}

function validateDeclaredPaths(value, pointer, errors, parentKey = "") {
  if (Array.isArray(value)) {
    if (["assetPaths", "evidence"].includes(parentKey)) value.forEach((item, index) => validatePath(item, `${pointer}[${index}]`, errors));
    else value.forEach((item, index) => validateDeclaredPaths(item, `${pointer}[${index}]`, errors, parentKey));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}.${key}`;
    if ((key === "path" || key === "artifact" || key === "evidencePath" || key.endsWith("Path")) && child !== null) {
      validatePath(child, childPointer, errors);
    } else if (key === "artifacts" && isObject(child)) {
      Object.entries(child).forEach(([artifactKey, artifactPath]) => validatePath(artifactPath, `${childPointer}.${artifactKey}`, errors));
    } else {
      validateDeclaredPaths(child, childPointer, errors, key);
    }
  }
}

function validateFileDescriptor(jobDir, descriptor, pointer, errors, kind = "file") {
  if (!isObject(descriptor) || !isSafeRelativePath(descriptor.path) || !validHash(descriptor.sha256)) {
    issue(errors, "INVALID_DESCRIPTOR", pointer, "must contain a safe path and sha256:<64 lowercase hex>");
    return null;
  }
  let filePath;
  try {
    filePath = resolveJobPath(jobDir, descriptor.path, { mustExist: true });
  } catch (error) {
    issue(errors, "MISSING_EVIDENCE", `${pointer}.path`, error.message);
    return null;
  }
  if (!fs.statSync(filePath).isFile()) {
    issue(errors, "INVALID_EVIDENCE", `${pointer}.path`, "must be a regular file");
    return null;
  }
  const actualHash = sha256File(filePath);
  if (actualHash !== descriptor.sha256) issue(errors, "STALE_EVIDENCE", `${pointer}.sha256`, `declared ${descriptor.sha256}, actual ${actualHash}`);
  const bytes = fs.statSync(filePath).size;
  if (Number.isInteger(descriptor.bytes) && descriptor.bytes !== bytes) issue(errors, "STALE_EVIDENCE", `${pointer}.bytes`, `declared ${descriptor.bytes}, actual ${bytes}`);
  let decoded = null;
  if (kind === "pptx") {
    const head = fs.readFileSync(filePath).subarray(0, 4);
    if (head.length !== 4 || !head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) issue(errors, "INVALID_PPTX", `${pointer}.path`, "does not have an OOXML ZIP signature");
  } else if (kind === "png") {
    try {
      decoded = decodePng(fs.readFileSync(filePath));
      if (Number.isInteger(descriptor.width) && Number.isInteger(descriptor.height) && (decoded.width !== descriptor.width || decoded.height !== descriptor.height)) {
        issue(errors, "STALE_EVIDENCE", pointer, `PNG dimensions are ${decoded.width}x${decoded.height}`);
      }
    } catch (error) {
      issue(errors, "INVALID_PNG", `${pointer}.path`, error.message);
    }
  }
  return { filePath, actualHash, bytes, decoded };
}

function currentContractHashes(jobDir, contracts) {
  const hashes = {};
  for (const [key, relativePath] of Object.entries(CONTRACT_FILES)) {
    if (contracts[key]) hashes[key] = sha256File(resolveJobPath(jobDir, relativePath, { mustExist: true }));
  }
  return hashes;
}

function validateJobIdentity(job, contracts, errors) {
  for (const [key, contract] of Object.entries(contracts)) {
    if (!contract) continue;
    if (contract.jobId !== job.jobId) issue(errors, "JOB_ID_MISMATCH", `${key}.jobId`, `expected ${job.jobId}`);
    const expectedVersion = ["brief", "characterModel"].includes(key) ? "1.0.0" : SCHEMA_VERSION;
    if (contract.schemaVersion !== expectedVersion) issue(errors, "SCHEMA_VERSION", `${key}.schemaVersion`, `expected ${expectedVersion}`);
  }
}

function validateCharacterModelSemantics(jobDir, model, errors) {
  if (!isObject(model)) return;
  validateFileDescriptor(jobDir, model.sourceReference, "characterModel.sourceReference", errors);
  validateFileDescriptor(jobDir, model.identityBible, "characterModel.identityBible", errors);
  const diagnostic = model.referenceDiagnostic;
  if (!isObject(diagnostic) || !(diagnostic.selectionConfidence >= 0.75) || !nonEmpty(diagnostic.selectedSubject)) {
    issue(errors, "AMBIGUOUS_SUBJECT", "characterModel.referenceDiagnostic", "subject selection must be explicit with confidence >= 0.75");
  }
  if (diagnostic && ["human", "humanoid-mascot"].includes(model.subjectKind)) {
    if (["low", "not-applicable"].includes(diagnostic.faceClarity) || ["rear", "not-applicable"].includes(diagnostic.viewAngle)) {
      issue(errors, "IDENTITY_EVIDENCE", "characterModel.referenceDiagnostic", "human or humanoid identity needs a usable non-rear face reference");
    }
  }
  if (!Array.isArray(model.identityLock) || !model.identityLock.length) issue(errors, "IDENTITY_LOCK", "characterModel.identityLock", "at least one identity characteristic is required");
  if (!model.identityBible || model.identityBible.qaPassed !== true) issue(errors, "IDENTITY_QA", "characterModel.identityBible.qaPassed", "must be true");
  const performance = model.performanceBible;
  if (!isObject(performance)) {
    issue(errors, "PERFORMANCE_BIBLE", "characterModel.performanceBible", "is required");
    return;
  }
  const ids = new Set();
  const paths = new Set();
  const hashes = new Set();
  const passed = [];
  let selected = null;
  for (const [index, candidate] of (performance.candidates || []).entries()) {
    const pointer = `characterModel.performanceBible.candidates[${index}]`;
    validateFileDescriptor(jobDir, candidate, pointer, errors);
    if (!nonEmpty(candidate.id) || ids.has(candidate.id)) issue(errors, "DUPLICATE_CANDIDATE", `${pointer}.id`, "candidate IDs must be unique");
    if (!isSafeRelativePath(candidate.path) || paths.has(candidate.path)) issue(errors, "DUPLICATE_CANDIDATE", `${pointer}.path`, "candidate paths must be unique");
    if (!validHash(candidate.sha256) || hashes.has(candidate.sha256)) issue(errors, "DUPLICATE_CANDIDATE", `${pointer}.sha256`, "candidate hashes must be unique");
    ids.add(candidate.id); paths.add(candidate.path); hashes.add(candidate.sha256);
    if (candidate.qa && candidate.qa.passed === true) {
      const fields = ["identityConsistency", "bodyCompleteness", "proportionStability", "animatability"];
      if (fields.some((field) => !(candidate.qa[field] >= 0.85))) issue(errors, "CANDIDATE_SCORE", `${pointer}.qa`, "every passed candidate score must be >=0.85");
      passed.push({
        id: candidate.id,
        score: candidate.qa.identityConsistency * 0.35 + candidate.qa.bodyCompleteness * 0.30 + candidate.qa.proportionStability * 0.20 + candidate.qa.animatability * 0.15,
      });
    }
    if (candidate.id === performance.selectedCandidateId) selected = candidate;
  }
  if (!selected) issue(errors, "SELECTED_CANDIDATE", "characterModel.performanceBible.selectedCandidateId", "must select one declared candidate");
  else {
    if (selected.sha256 !== performance.selectedSha256) issue(errors, "SELECTED_HASH", "characterModel.performanceBible.selectedSha256", "must match the selected candidate hash");
    if (!selected.qa || selected.qa.passed !== true) issue(errors, "SELECTED_QA", "characterModel.performanceBible.selectedCandidateId", "selected candidate QA must pass");
    const selectedScore = passed.find((item) => item.id === selected.id);
    const bestScore = passed.length ? Math.max(...passed.map((item) => item.score)) : NaN;
    if (!selectedScore || selectedScore.score < bestScore - 1e-12) issue(errors, "SELECTED_CANDIDATE_SCORE", "characterModel.performanceBible.selectedCandidateId", "must select a highest-scoring passing candidate");
  }
  validateFileDescriptor(jobDir, performance.sideActionReference, "characterModel.performanceBible.sideActionReference", errors);
  const profile = performance.fullBodyProfile;
  if (!isObject(profile) || profile.coverage !== "full-body") issue(errors, "HALF_BODY_PERFORMANCE_MODEL", "characterModel.performanceBible.fullBodyProfile", "must be a full-body performance model");
  else {
    const required = new Set(profile.requiredParts || []);
    const visible = new Set(profile.visibleParts || []);
    if (["human", "humanoid-mascot"].includes(model.subjectKind)) for (const part of HUMANOID_FULL_BODY_PARTS) if (!required.has(part)) issue(errors, "FULL_BODY_PART", "characterModel.performanceBible.fullBodyProfile.requiredParts", `missing ${part}`);
    for (const part of required) if (!visible.has(part)) issue(errors, "MISSING_BODY_PART", "characterModel.performanceBible.fullBodyProfile.visibleParts", `${part} is not visible`);
  }
  const doNotCopy = new Set(model.promptPolicy && model.promptPolicy.doNotCopyFromSource || []);
  for (const concept of ["crop", "pose", "background", "subject-scale", "camera-distance"]) if (!doNotCopy.has(concept)) issue(errors, "PROMPT_POLICY", "characterModel.promptPolicy.doNotCopyFromSource", `must contain ${concept}`);
  const forbidden = new Set(model.cropPolicy && model.cropPolicy.forbiddenJoints || []);
  for (const joint of ["neck", "shoulder", "elbow", "wrist", "waist", "knee", "ankle"]) if (!forbidden.has(joint)) issue(errors, "CROP_POLICY", "characterModel.cropPolicy.forbiddenJoints", `must forbid ${joint}`);
}

function validatePerformanceBibleBinding(characterModel, assetManifest, errors) {
  if (!characterModel || !assetManifest) return;
  const selected = characterModel.performanceBible && characterModel.performanceBible.selectedSha256;
  for (const [index, slide] of (assetManifest.slides || []).entries()) {
    const bound = slide.qa && slide.qa.binding && slide.qa.binding.performanceBibleSha256;
    if (!validHash(selected) || bound !== selected) issue(errors, "PERFORMANCE_BIBLE_DRIFT", `assetManifest.slides[${index}].qa.binding.performanceBibleSha256`, "must bind the one selected performance-bible candidate used across every dynamic page");
  }
}

function validateBindings(jobDir, contracts, hashes, errors) {
  const { contentPlan, characterModel, visualPlan, designPlan, assetManifest, deck } = contracts;
  if (contentPlan && contentPlan.planningStatus !== "approved") issue(errors, "DRAFT_ONLY", "contentPlan.planningStatus", "content planning must be explicitly approved before stage completion");
  if (visualPlan && visualPlan.planningStatus !== "approved") issue(errors, "DRAFT_ONLY", "visualPlan.planningStatus", "visual planning must be explicitly approved before stage completion");
  if (contentPlan && hashes.brief && contentPlan.upstreamHashes.brief !== hashes.brief) issue(errors, "UPSTREAM_HASH", "contentPlan.upstreamHashes.brief", "does not bind brief.json");
  if (characterModel && hashes.brief && characterModel.upstreamHashes.brief !== hashes.brief) issue(errors, "UPSTREAM_HASH", "characterModel.upstreamHashes.brief", "does not bind brief.json");
  if (visualPlan) {
    for (const key of ["brief", "characterModel", "contentPlan"]) {
      if (hashes[key] && visualPlan.upstreamHashes[key] !== hashes[key]) issue(errors, "UPSTREAM_HASH", `visualPlan.upstreamHashes.${key}`, `does not bind ${CONTRACT_FILES[key]}`);
    }
  }
  if (designPlan) {
    if (hashes.brief && designPlan.compiledFrom.brief !== hashes.brief) issue(errors, "UPSTREAM_HASH", "designPlan.compiledFrom.brief", "does not bind brief.json");
    if (hashes.characterModel && designPlan.compiledFrom.characterModel !== hashes.characterModel) issue(errors, "UPSTREAM_HASH", "designPlan.compiledFrom.characterModel", "does not bind character-model.json");
    if (hashes.contentPlan && designPlan.compiledFrom.contentPlan !== hashes.contentPlan) issue(errors, "UPSTREAM_HASH", "designPlan.compiledFrom.contentPlan", "does not bind content-plan.json");
    if (hashes.visualPlan && designPlan.compiledFrom.visualPlan !== hashes.visualPlan) issue(errors, "UPSTREAM_HASH", "designPlan.compiledFrom.visualPlan", "does not bind visual-plan.json");
    if (designPlan.releaseEligibility !== "candidate-ready") issue(errors, "DRAFT_ONLY", "designPlan.releaseEligibility", "must be candidate-ready");
  }
  if (assetManifest) {
    for (const key of ["characterModel", "contentPlan", "visualPlan", "designPlan"]) {
      if (hashes[key] && assetManifest.upstreamHashes[key] !== hashes[key]) issue(errors, "UPSTREAM_HASH", `assetManifest.upstreamHashes.${key}`, `does not bind ${CONTRACT_FILES[key]}`);
    }
  }
  if (deck) {
    for (const key of ["contentPlan", "visualPlan", "designPlan", "assetManifest"]) {
      if (hashes[key] && (!deck.compiledFrom || deck.compiledFrom[key] !== hashes[key])) issue(errors, "UPSTREAM_HASH", `deck.compiledFrom.${key}`, `does not bind ${CONTRACT_FILES[key]}`);
    }
    if (deck.releaseLevel !== "candidate" || Object.hasOwn(deck, "powerpointVerification")) issue(errors, "DECK_RELEASE_BOUNDARY", "deck", "must remain candidate and must not embed PowerPoint verification");
    if (designPlan && assetManifest && ["contentPlan", "visualPlan", "designPlan", "assetManifest"].every((key) => hashes[key])) {
      try {
        const expectedDeck = compileDeck({ jobDir, designPlan, manifest: assetManifest, hashes });
        if (!util.isDeepStrictEqual(deck, expectedDeck)) issue(errors, "DECK_DRIFT", "deck", "differs from a fresh deterministic compile of the bound design and media contracts");
      } catch (error) {
        issue(errors, "DECK_DRIFT", "deck", error.message);
      }
    }
  }
}

function validateStylePack(designPlan, errors) {
  if (!designPlan || !isObject(designPlan.stylePack)) return;
  try {
    const presets = path.resolve(__dirname, "..", "references", "presets");
    const registry = loadJson(path.join(presets, "style-packs.json"));
    const entry = (registry.stylePacks || []).find((item) => item.id === designPlan.stylePack.id);
    if (!entry || !isSafeRelativePath(entry.reference)) throw new Error(`style pack ${designPlan.stylePack.id} is not registered`);
    const current = sha256File(path.join(presets, entry.reference));
    if (designPlan.stylePack.implementationSha256 !== current) issue(errors, "STYLE_PACK_DRIFT", "designPlan.stylePack.implementationSha256", `current implementation is ${current}`);
  } catch (error) {
    issue(errors, "STYLE_PACK_DRIFT", "designPlan.stylePack", error.message);
  }
}

function validateFontBindings(designPlan, errors) {
  if (!designPlan) return;
  const receipts = new Map();
  for (const slide of designPlan.slides || []) {
    for (const receipt of Object.values(slide.fontResolution && slide.fontResolution.tokens || {})) {
      if (receipt && nonEmpty(receipt.fileName) && validHash(receipt.sha256)) receipts.set(`${receipt.fileName}:${receipt.sha256}`, receipt);
    }
  }
  if (!receipts.size) return;
  let files;
  try {
    files = discoverFontFiles();
  } catch (error) {
    issue(errors, "FONT_DRIFT", "designPlan.slides.fontResolution", error.message);
    return;
  }
  const byName = new Map();
  for (const filePath of files) {
    const name = path.basename(filePath);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(filePath);
  }
  for (const receipt of receipts.values()) {
    const candidates = byName.get(receipt.fileName) || [];
    const matched = candidates.some((filePath) => {
      try { return sha256File(filePath) === receipt.sha256; } catch { return false; }
    });
    if (!matched) issue(errors, "FONT_DRIFT", "designPlan.slides.fontResolution", `${receipt.fileName} no longer resolves to ${receipt.sha256}`);
  }
}

function validateTrackedArtifacts(jobDir, job, hashes, errors, strict) {
  const tracked = isObject(job.trackedArtifacts) ? job.trackedArtifacts : {};
  if (strict) {
    for (const key of REQUIRED_RELEASE_TRACKS) if (!tracked[key]) issue(errors, "UNTRACKED_ARTIFACT", `job.trackedArtifacts.${key}`, "release requires a recorded artifact hash");
  }
  for (const [key, record] of Object.entries(tracked)) {
    if (!Object.hasOwn(CONTRACT_FILES, key) || !isObject(record) || record.path !== CONTRACT_FILES[key] || !validHash(record.sha256) || record.stage !== CONTRACT_STAGE[key]) {
      issue(errors, "TRACKED_ARTIFACT", `job.trackedArtifacts.${key}`, "record path, hash, or stage is invalid");
      continue;
    }
    let actual;
    try { actual = sha256File(resolveJobPath(jobDir, record.path, { mustExist: true })); }
    catch (error) { issue(errors, "STALE_ARTIFACT", `job.trackedArtifacts.${key}`, error.message); continue; }
    if (actual !== record.sha256 || hashes[key] !== record.sha256) issue(errors, "STALE_ARTIFACT", `job.trackedArtifacts.${key}.sha256`, `declared ${record.sha256}, actual ${actual}`);
  }
}

function validateStageState(job, errors) {
  if (!isObject(job.state) || !STAGES.includes(job.state.stage) || !Array.isArray(job.state.completedStages)) return;
  const current = STAGES.indexOf(job.state.stage);
  const completed = new Set(job.state.completedStages);
  if (completed.size !== job.state.completedStages.length) issue(errors, "STAGE_HISTORY", "job.state.completedStages", "must not contain duplicates");
  for (let index = 1; index <= current; index += 1) if (!completed.has(STAGES[index])) issue(errors, "STAGE_HISTORY", "job.state.completedStages", `missing completed stage ${STAGES[index]}`);
  for (const stage of completed) if (!STAGES.includes(stage) || STAGES.indexOf(stage) > current) issue(errors, "STAGE_HISTORY", "job.state.completedStages", `${stage} cannot be complete at ${job.state.stage}`);
  if (current >= STAGES.indexOf("candidate-released") && job.release.candidate.status !== "released") issue(errors, "RELEASE_STATE", "job.release.candidate.status", "candidate-released stage requires a released candidate");
  if (current >= STAGES.indexOf("final-released") && job.release.final.status !== "released") issue(errors, "RELEASE_STATE", "job.release.final.status", "final-released stage requires a released final");
  if (job.state.stage === "final-released" && job.state.status !== "complete") issue(errors, "JOB_STATUS", "job.state.status", "final-released job must be complete");
}

function readBoundJson(jobDir, descriptor, pointer, errors) {
  const asset = validateFileDescriptor(jobDir, descriptor, pointer, errors);
  if (!asset) return null;
  try { return { asset, value: loadJson(asset.filePath) }; }
  catch (error) { issue(errors, "INVALID_JSON", pointer, error.message); return null; }
}

function validatePackageEvidence(jobDir, record, candidateAsset, hashes, jobId, dynamicCount, slideCount, errors) {
  if (!isObject(record) || record.passed !== true) {
    issue(errors, "PACKAGE_QA", "job.release.candidate.packageQa", "passing v2 package QA is required");
    return;
  }
  const evidence = readBoundJson(jobDir, { path: record.evidencePath, sha256: record.evidenceSha256 }, "job.release.candidate.packageQa.evidence", errors);
  if (!evidence) return;
  const report = evidence.value;
  const expected = {
    artifactSha256: candidateAsset && candidateAsset.actualHash,
    contentPlanSha256: hashes.contentPlan,
    visualPlanSha256: hashes.visualPlan,
    designPlanSha256: hashes.designPlan,
    assetManifestSha256: hashes.assetManifest,
    deckSha256: hashes.deck,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value || report[key] !== value) issue(errors, "STALE_PACKAGE_QA", `job.release.candidate.packageQa.${key}`, `must bind current ${key}`);
  }
  if (
    report.schemaVersion !== SCHEMA_VERSION || report.receiptType !== "deckformance-package-qa" ||
    report.jobId !== jobId || report.release !== "candidate" || report.artifactPath !== EXPECTED_STAGING ||
    !isObject(report.producer) || report.producer.id !== "deckformance/validate-pptx-v2" || report.producer.version !== "2.0.0" || !validHash(report.producer.implementationSha256)
  ) issue(errors, "PACKAGE_QA_RECEIPT", "job.release.candidate.packageQa.evidence", "is not a supported hash-bound v2 package report");
  try {
    const currentValidatorHash = sha256File(path.join(__dirname, "validate_pptx_v2.js"));
    if (report.producer.implementationSha256 !== currentValidatorHash) issue(errors, "PACKAGE_VALIDATOR_DRIFT", "job.release.candidate.packageQa.evidence.producer", `current validator is ${currentValidatorHash}`);
  } catch (error) { issue(errors, "PACKAGE_VALIDATOR_DRIFT", "job.release.candidate.packageQa.evidence.producer", error.message); }
  if (
    !isObject(report.runtime) || !nonEmpty(report.runtime.platform) || !nonEmpty(report.runtime.arch) ||
    !isObject(report.runtime.node) || !nonEmpty(report.runtime.node.version) || !nonEmpty(report.runtime.node.executable) || !validHash(report.runtime.node.sha256)
  ) issue(errors, "PACKAGE_RUNTIME_RECEIPT", "packageReport.runtime", "must bind the Node executable, version, platform, and architecture");
  for (const key of ["relationshipsValid", "mimeTypesValid", "aspectRatiosValid", "collectMediaPassed", "passed"]) if (report[key] !== true) issue(errors, "PACKAGE_QA", `packageReport.${key}`, "must be true");
  for (const key of ["expectedContentPages", "embeddedVideoCount", "posterCount", "timingCount"]) if (report[key] !== dynamicCount) issue(errors, "PACKAGE_MEDIA_COUNT", `packageReport.${key}`, `expected ${dynamicCount}`);
  if (!Number.isInteger(report.embeddedMediaBytes) || report.embeddedMediaBytes < 1 || report.maxEmbeddedMediaBytes !== 104857600 || report.embeddedMediaBytes > report.maxEmbeddedMediaBytes) {
    issue(errors, "PACKAGE_MEDIA_BUDGET", "packageReport.embeddedMediaBytes", "must bind the actual complete ppt/media total within 100 MiB");
  }
  if (report.slideCount !== slideCount) issue(errors, "PACKAGE_SLIDE_COUNT", "packageReport.slideCount", `expected ${slideCount}`);
  if (!Array.isArray(report.errors) || report.errors.length !== 0 || !isDateTime(report.checkedAt)) issue(errors, "PACKAGE_QA_RECEIPT", "packageReport", "must contain an empty errors array and checkedAt timestamp");
}

function trustedRenderTools(options = {}) {
  const injected = isObject(options.trustedRenderTools) ? options.trustedRenderTools : {};
  const normalize = (name, pathEnv, versionEnv) => {
    const entry = isObject(injected[name]) ? injected[name] : {};
    return {
      path: entry.path || process.env[pathEnv] || null,
      version: entry.version || process.env[versionEnv] || null,
    };
  };
  return {
    renderer: normalize("renderer", "DECKFORMANCE_RENDERER", "DECKFORMANCE_RENDERER_VERSION"),
    slidesTest: normalize("slidesTest", "DECKFORMANCE_SLIDES_TEST", "DECKFORMANCE_SLIDES_TEST_VERSION"),
    python: normalize("python", "DECKFORMANCE_PYTHON", "DECKFORMANCE_PYTHON_VERSION"),
    node: normalize("node", "DECKFORMANCE_NODE", "DECKFORMANCE_NODE_VERSION"),
  };
}

function currentExecutable(filePath, pointer, errors) {
  if (!nonEmpty(filePath)) {
    issue(errors, "RENDER_TRUST_CONFIG", pointer, "a trusted absolute executable/script path is required");
    return null;
  }
  try {
    const resolved = fs.realpathSync(path.resolve(filePath));
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error("must resolve to a regular file");
    return { path: resolved, sha256: sha256File(resolved), name: path.basename(resolved) };
  } catch (error) {
    issue(errors, "RENDER_TRUST_CONFIG", pointer, `${path.resolve(filePath)}: ${error.message}`);
    return null;
  }
}

function validateTrustedRenderImplementation(index, options, errors) {
  const trusted = trustedRenderTools(options);
  for (const [key, expectedName] of [["renderer", "render_slides.py"], ["slidesTest", "slides_test.py"]]) {
    const pointer = `renderIndex.${key}`;
    const declared = index[key];
    const current = currentExecutable(trusted[key].path, `${pointer}.trustedPath`, errors);
    if (!isObject(declared) || path.basename(String(declared.name || "")) !== expectedName || !nonEmpty(declared.version) || !validHash(declared.sha256)) {
      issue(errors, "RENDER_IMPLEMENTATION_RECEIPT", pointer, `must bind ${expectedName} version and implementation hash`);
      continue;
    }
    if (!nonEmpty(trusted[key].version)) {
      issue(errors, "RENDER_TRUST_CONFIG", `${pointer}.version`, `trusted ${expectedName} version is required`);
    } else if (declared.version !== trusted[key].version) {
      issue(errors, "RENDER_IMPLEMENTATION_DRIFT", `${pointer}.version`, `trusted version is ${trusted[key].version}`);
    }
    if (current && (current.name !== expectedName || declared.sha256 !== current.sha256)) {
      issue(errors, "RENDER_IMPLEMENTATION_DRIFT", `${pointer}.sha256`, `trusted ${expectedName} is ${current.sha256}`);
    }
  }

  try {
    const trustOptions = options.rendererTrustPolicy ? { policy: options.rendererTrustPolicy } : {};
    verifyTrustedRendererPair({
      renderer: { path: trusted.renderer.path, name: "render_slides.py", version: trusted.renderer.version },
      slidesTest: { path: trusted.slidesTest.path, name: "slides_test.py", version: trusted.slidesTest.version },
    }, trustOptions);
  } catch (error) {
    issue(errors, "RENDER_TRUST_POLICY", "renderIndex.renderer", `${error.code || "RENDERER_NOT_APPROVED"}: ${error.message}`);
  }

  const python = index.runtime && index.runtime.python;
  const currentPython = currentExecutable(trusted.python.path, "renderIndex.runtime.python.trustedPath", errors);
  if (
    !isObject(python) || !nonEmpty(python.implementation) || !nonEmpty(python.version) ||
    !validHash(python.sha256) || !nonEmpty(python.pillowVersion)
  ) {
    issue(errors, "RENDER_RUNTIME_RECEIPT", "renderIndex.runtime.python", "must bind the Python executable, implementation, version, hash, and Pillow version");
  } else if (currentPython) {
    const probeResult = spawnSync(currentPython.path, [
      "-c",
      "import json,sys,PIL; print(json.dumps({'implementation':sys.implementation.name,'version':'.'.join(map(str,sys.version_info[:3])),'pillowVersion':PIL.__version__}))",
    ], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    if (probeResult.status !== 0) {
      issue(errors, "RENDER_RUNTIME_DRIFT", "renderIndex.runtime.python", `trusted Python/Pillow probe failed: ${(probeResult.stderr || probeResult.stdout || "unknown error").trim()}`);
    } else {
      try {
        const live = JSON.parse(probeResult.stdout);
        if (
          python.sha256 !== currentPython.sha256 || python.implementation !== live.implementation ||
          python.version !== live.version || python.pillowVersion !== live.pillowVersion
        ) issue(errors, "RENDER_RUNTIME_DRIFT", "renderIndex.runtime.python", "does not match the trusted Python executable and current Pillow runtime");
      } catch (error) {
        issue(errors, "RENDER_RUNTIME_DRIFT", "renderIndex.runtime.python", `trusted Python probe returned invalid JSON: ${error.message}`);
      }
    }
  }

  const node = index.runtime && index.runtime.node;
  if (node !== undefined) {
    const nodePath = trusted.node.path || process.env.RUNTIME_NODE || process.execPath;
    const currentNode = currentExecutable(nodePath, "renderIndex.runtime.node.trustedPath", errors);
    if (!isObject(node) || !nonEmpty(node.version) || !validHash(node.sha256)) {
      issue(errors, "RENDER_RUNTIME_RECEIPT", "renderIndex.runtime.node", "must bind Node version and executable hash when present");
    } else if (currentNode) {
      const versionResult = spawnSync(currentNode.path, ["--version"], { encoding: "utf8", timeout: 10000 });
      const liveVersion = (versionResult.stdout || versionResult.stderr || "").trim();
      if (versionResult.status !== 0 || node.sha256 !== currentNode.sha256 || node.version !== liveVersion) {
        issue(errors, "RENDER_RUNTIME_DRIFT", "renderIndex.runtime.node", "does not match the trusted Node executable and version");
      }
    }
  }
}

function validateRenderedSlides(jobDir, slides, slideCount, pointer, errors) {
  if (!Array.isArray(slides) || slides.length !== slideCount) {
    issue(errors, "RENDER_PIXEL_EVIDENCE", pointer, `expected ${slideCount} rendered slide descriptors`);
    return;
  }
  const numbers = new Set();
  slides.forEach((slide, index) => {
    const itemPointer = `${pointer}[${index}]`;
    const asset = validateFileDescriptor(jobDir, slide, itemPointer, errors, "png");
    if (
      !Number.isInteger(slide.width) || !Number.isInteger(slide.height) ||
      !asset || !asset.decoded || asset.decoded.width !== slide.width || asset.decoded.height !== slide.height ||
      asset.decoded.width < 1920 || asset.decoded.height < 1080
    ) issue(errors, "RENDER_RESOLUTION", itemPointer, "must bind a fully decoded rendered page at 1920x1080 or higher");
    if (!Number.isInteger(slide.slideNumber) || slide.slideNumber < 1 || slide.slideNumber > slideCount || numbers.has(slide.slideNumber)) issue(errors, "RENDER_PIXEL_EVIDENCE", `${itemPointer}.slideNumber`, "must cover 1..N exactly once");
    numbers.add(slide.slideNumber);
    if (slide.mime !== "image/png") issue(errors, "RENDER_PIXEL_EVIDENCE", `${itemPointer}.mime`, "must be image/png");
  });
  for (let number = 1; number <= slideCount; number += 1) if (!numbers.has(number)) issue(errors, "RENDER_PIXEL_EVIDENCE", pointer, `missing slide ${number}`);
}

function validateRenderEvidence(jobDir, record, candidateAsset, jobId, slideCount, errors, options = {}) {
  if (!isObject(record) || record.passed !== true) {
    issue(errors, "RENDER_QA", "job.release.candidate.renderQa", "passing render index and visual QA are required");
    return;
  }
  const artifactHash = candidateAsset && candidateAsset.actualHash;
  if (record.artifactSha256 !== artifactHash || record.slideCount !== slideCount) issue(errors, "STALE_RENDER_QA", "job.release.candidate.renderQa", "must bind the current candidate hash and slide count");
  if (record.renderIndexPath !== EXPECTED_RENDER_INDEX) issue(errors, "RENDER_QA_PATH", "job.release.candidate.renderQa.renderIndexPath", "must use the canonical candidate render-index path");
  const indexEvidence = readBoundJson(jobDir, { path: record.renderIndexPath, sha256: record.renderIndexSha256 }, "job.release.candidate.renderQa.renderIndex", errors);
  const visualEvidence = readBoundJson(jobDir, { path: record.visualQaPath, sha256: record.visualQaSha256 }, "job.release.candidate.renderQa.visualQa", errors);
  if (!indexEvidence || !visualEvidence) return;
  const index = indexEvidence.value;
  const visual = visualEvidence.value;
  if (
    index.version !== 2 || index.producer !== "ppt-cast/render-pptx-qa@2" || !validHash(index.producerSha256) ||
    index.artifactPath !== EXPECTED_STAGING || index.artifactSha256 !== artifactHash || index.slideCount !== slideCount || index.overflowPassed !== true
  ) issue(errors, "RENDER_INDEX", "renderIndex", "must be a v2 hash-bound render of the exact candidate staging bytes");
  try {
    const currentProducer = sha256File(path.join(__dirname, "render_pptx_qa.py"));
    if (index.producerSha256 !== currentProducer) issue(errors, "RENDER_PRODUCER_DRIFT", "renderIndex.producerSha256", `current producer is ${currentProducer}`);
  } catch (error) { issue(errors, "RENDER_PRODUCER_DRIFT", "renderIndex.producerSha256", error.message); }
  if (!isObject(index.runtime)) issue(errors, "RENDER_RUNTIME_RECEIPT", "renderIndex.runtime", "must bind the render runtime");
  validateTrustedRenderImplementation(index, options, errors);
  validateRenderedSlides(jobDir, index.renderedSlides, slideCount, "renderIndex.renderedSlides", errors);
  if (
    visual.schemaVersion !== SCHEMA_VERSION || visual.receiptType !== "deckformance-evaluation" || visual.jobId !== jobId ||
    !isObject(visual.subject) || visual.subject.kind !== "deck" || visual.subject.artifactSha256 !== artifactHash ||
    visual.renderIndexPath !== record.renderIndexPath || visual.renderIndexSha256 !== record.renderIndexSha256 ||
    visual.slideCount !== slideCount
  ) issue(errors, "RENDER_QA_RECEIPT", "renderQa", "must bind the exact render index and candidate deck bytes");
  const evaluation = validateEvaluationReceipt(visual, {
    evidenceRoot: jobDir,
    expectedArtifactSha256: artifactHash,
    requireHumanApproval: options.requireHumanApproval === true,
  });
  if (!evaluation.valid || !evaluation.accepted) {
    for (const error of evaluation.errors) issue(errors, `RENDER_${error.code}`, `renderQa.${error.pointer}`, error.message);
    if (evaluation.valid && !evaluation.accepted) issue(errors, "RENDER_DERIVED_OUTCOME", "renderQa", "numeric scores, issues, and human review did not derive an accepted result");
  }
  const frames = Array.isArray(visual.evidenceFrames) ? visual.evidenceFrames : [];
  if (frames.length !== slideCount) issue(errors, "RENDER_FRAME_BINDING", "renderQa.evidenceFrames", `expected one frame for each of ${slideCount} rendered slides`);
  const frameByPath = new Map(frames.map((frame) => [frame && frame.path, frame]));
  for (const rendered of index.renderedSlides || []) {
    const frame = frameByPath.get(rendered.path);
    if (!frame || frame.sha256 !== rendered.sha256 || frame.sourceArtifactSha256 !== artifactHash) {
      issue(errors, "RENDER_FRAME_BINDING", "renderQa.evidenceFrames", `must bind render-index slide ${rendered.slideNumber} path/hash to the candidate bytes`);
    }
  }
}

function dynamicSlideIds(designPlan) {
  return (designPlan && designPlan.slides || []).filter((slide) => slide.mediaMode === "hybrid-video").map((slide) => slide.id).sort();
}

function decodeFrameRgb(ffmpegPath, args, pointer, errors) {
  const result = spawnSync(ffmpegPath, ["-v", "error", ...args, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    encoding: null,
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr || "").trim();
    issue(errors, "MEDIA_FRAME_DECODE", pointer, `ffmpeg could not decode one RGB frame${detail ? `: ${detail}` : ""}`);
    return null;
  }
  return result.stdout;
}

function validateProviderReceipt(jobDir, reference, output, acceptedInputs, pointer, errors) {
  const evidence = readBoundJson(jobDir, reference, pointer, errors);
  if (!evidence) return;
  const verified = verifyHashBoundReceipt(jobDir, evidence.value);
  if (!verified.ok || evidence.value.kind !== "provider") {
    issue(errors, "PROVIDER_RECEIPT", pointer, `must be a current hash-bound provider receipt: ${verified.errors.join("; ")}`);
    return;
  }
  const producer = evidence.value.producer;
  const metadata = evidence.value.metadata;
  const allowedOperations = new Set(["generate-image", "generate-video", "inspect-image", "inspect-video", "import-poster", "import-video"]);
  if (
    !isObject(producer) || !nonEmpty(producer.name) || !nonEmpty(producer.version) ||
    !Array.isArray(producer.implementationFiles) || producer.implementationFiles.length === 0
  ) issue(errors, "PROVIDER_IMPLEMENTATION", pointer, "must bind at least one current provider implementation file and a named/versioned producer");
  if (
    !isObject(metadata) || metadata.provider !== (producer && producer.name) ||
    metadata.providerVersion !== (producer && producer.version) || !nonEmpty(metadata.model) ||
    !allowedOperations.has(metadata.operation) || !validHash(metadata.promptSha256) ||
    !nonEmpty(metadata.requestId) || !Number.isFinite(metadata.durationMs) || metadata.durationMs < 0 ||
    !(metadata.cost === null || isObject(metadata.cost))
  ) issue(errors, "PROVIDER_PROVENANCE", pointer, "must record provider, providerVersion, model, operation, prompt hash, request ID, non-negative duration, and cost/null matching the bound implementation");
  const outputMatch = (evidence.value.outputs || []).some((item) => item.path === output.path && item.sha256 === output.sha256 && item.bytes === output.bytes);
  if (!outputMatch) issue(errors, "PROVIDER_OUTPUT_BINDING", pointer, `does not bind ${output.path}`);
  if (acceptedInputs && acceptedInputs.length) {
    const inputMatch = (evidence.value.inputs || []).some((item) => acceptedInputs.some((accepted) => (
      accepted && item.path === accepted.path && item.sha256 === accepted.sha256
    )));
    if (!inputMatch) issue(errors, "PROVIDER_INPUT_BINDING", pointer, "video generation must bind the canonical poster or selected performance-bible bytes as an input");
  }
}

function validateMediaEvidence(jobDir, designPlan, assetManifest, characterModel, errors, options = {}) {
  if (!assetManifest || !designPlan) return;
  const selected = characterModel && characterModel.performanceBible && (characterModel.performanceBible.candidates || []).find((item) => (
    item.id === characterModel.performanceBible.selectedCandidateId && item.sha256 === characterModel.performanceBible.selectedSha256
  ));
  const ffmpegPath = options.ffmpegPath || process.env.DECKFORMANCE_FFMPEG || "ffmpeg";
  const dynamic = new Map((designPlan.slides || []).filter((slide) => slide.mediaMode === "hybrid-video").map((slide) => [slide.id, slide]));
  for (const [index, record] of (assetManifest.slides || []).entries()) {
    const pointer = `assetManifest.slides[${index}]`;
    const slide = dynamic.get(record.id);
    if (!slide) {
      issue(errors, "MEDIA_SLIDE_BINDING", pointer, "does not match a hybrid-video design slide");
      continue;
    }
    const poster = validateFileDescriptor(jobDir, record.poster, `${pointer}.poster`, errors, "png");
    const video = validateFileDescriptor(jobDir, record.video, `${pointer}.video`, errors);
    if (!poster || !video) continue;
    const binding = record.qa && record.qa.binding;
    if (
      !isObject(binding) || binding.posterSha256 !== record.poster.sha256 || binding.videoSha256 !== record.video.sha256 ||
      binding.posterProviderReceiptSha256 !== (record.providerReceipts && record.providerReceipts.poster && record.providerReceipts.poster.sha256) ||
      binding.videoProviderReceiptSha256 !== (record.providerReceipts && record.providerReceipts.video && record.providerReceipts.video.sha256) ||
      binding.evaluationReceiptSha256 !== (record.evaluationReceipt && record.evaluationReceipt.sha256)
    ) issue(errors, "MEDIA_QA_BINDING", `${pointer}.qa.binding`, "must bind canonical media and every provider/evaluation receipt byte-for-byte");
    validateProviderReceipt(jobDir, record.providerReceipts && record.providerReceipts.poster, record.poster, null, `${pointer}.providerReceipts.poster`, errors);
    validateProviderReceipt(
      jobDir,
      record.providerReceipts && record.providerReceipts.video,
      record.video,
      [record.poster, selected].filter(Boolean),
      `${pointer}.providerReceipts.video`,
      errors,
    );

    const frames = record.qa && Array.isArray(record.qa.frames) ? record.qa.frames : [];
    const uniqueHashes = new Set();
    const frameAssets = [];
    if (frames.length !== FRAME_RATIOS.length) issue(errors, "MEDIA_FRAME_COUNT", `${pointer}.qa.frames`, "exactly five video QA frames are required");
    frames.forEach((frame, frameIndex) => {
      const framePointer = `${pointer}.qa.frames[${frameIndex}]`;
      const asset = validateFileDescriptor(jobDir, frame, framePointer, errors, "png");
      frameAssets.push(asset);
      if (frame && validHash(frame.sha256)) uniqueHashes.add(frame.sha256);
      if (!frame || Math.abs(Number(frame.timeRatio) - FRAME_RATIOS[frameIndex]) > 0.001) issue(errors, "MEDIA_FRAME_TIMING", `${framePointer}.timeRatio`, `expected ${FRAME_RATIOS[frameIndex]}`);
      if (
        asset && asset.decoded &&
        (asset.decoded.width !== Number(record.video.width) || asset.decoded.height !== Number(record.video.height))
      ) issue(errors, "MEDIA_FRAME_DIMENSIONS", framePointer, `must decode to the video dimensions ${record.video.width}x${record.video.height}`);
    });
    if (frames.length === FRAME_RATIOS.length && uniqueHashes.size !== FRAME_RATIOS.length) {
      issue(errors, "MEDIA_FRAME_DUPLICATE", `${pointer}.qa.frames`, "five distinct frame files are required; repeated frame hashes are not evidence of motion continuity");
    }

    const composite = validateFileDescriptor(jobDir, record.qa && record.qa.slotComposite, `${pointer}.qa.slotComposite`, errors, "png");
    if (!composite || !composite.decoded || composite.decoded.width !== 1920 || composite.decoded.height !== 1080) {
      issue(errors, "SLOT_COMPOSITE_DIMENSIONS", `${pointer}.qa.slotComposite`, "must bind a fully decoded 1920x1080 final-slot composite PNG");
    }

    const evaluationEvidence = readBoundJson(jobDir, record.evaluationReceipt, `${pointer}.evaluationReceipt`, errors);
    if (evaluationEvidence) {
      const evaluation = validateEvaluationReceipt(evaluationEvidence.value, {
        evidenceRoot: jobDir,
        expectedArtifactSha256: record.video.sha256,
        expectedMediaBudgetReceiptSha256: assetManifest.mediaBudgetReceipt && assetManifest.mediaBudgetReceipt.sha256,
        requireHumanApproval: options.requireHumanApproval === true,
      });
      if (!evaluation.valid || !evaluation.accepted) {
        for (const error of evaluation.errors) issue(errors, `MEDIA_${error.code}`, `${pointer}.evaluationReceipt.${error.pointer}`, error.message);
        if (evaluation.valid && !evaluation.accepted) issue(errors, "MEDIA_DERIVED_OUTCOME", `${pointer}.evaluationReceipt`, "evaluation did not derive an accepted result");
      }
      const receiptFrames = Array.isArray(evaluationEvidence.value.evidenceFrames) ? evaluationEvidence.value.evidenceFrames : [];
      if (receiptFrames.length !== frames.length) issue(errors, "MEDIA_EVALUATION_FRAME_BINDING", `${pointer}.evaluationReceipt.evidenceFrames`, "must cover manifest.qa.frames one-to-one");
      frames.forEach((frame, frameIndex) => {
        const receiptFrame = receiptFrames[frameIndex];
        if (
          !receiptFrame || receiptFrame.path !== frame.path || receiptFrame.sha256 !== frame.sha256 ||
          receiptFrame.sourceArtifactSha256 !== record.video.sha256 ||
          Math.abs(Number(receiptFrame.timeRatio) - Number(frame.timeRatio)) > 0.001
        ) issue(errors, "MEDIA_EVALUATION_FRAME_BINDING", `${pointer}.evaluationReceipt.evidenceFrames[${frameIndex}]`, "must bind the same path/hash/timeRatio and canonical video SHA-256 as manifest.qa.frames");
      });
    }

    if (frames.length === FRAME_RATIOS.length && frameAssets.every(Boolean)) {
      let duration = Number(record.video.durationSeconds);
      try {
        const info = probe(video.filePath);
        duration = Number(info.format && info.format.duration);
      } catch (error) {
        issue(errors, "MEDIA_VIDEO_PROBE", `${pointer}.video`, error.message);
      }
      if (Number.isFinite(duration) && duration > 0) {
        frames.forEach((frame, frameIndex) => {
          const target = FRAME_RATIOS[frameIndex] === 0 ? 0 : Math.max(0, Math.min(Math.max(0, duration - 0.05), duration * FRAME_RATIOS[frameIndex]));
          const videoRgb = decodeFrameRgb(ffmpegPath, ["-ss", target.toFixed(3), "-i", video.filePath], `${pointer}.qa.frames[${frameIndex}]`, errors);
          const pngRgb = decodeFrameRgb(ffmpegPath, ["-i", frameAssets[frameIndex].filePath], `${pointer}.qa.frames[${frameIndex}]`, errors);
          if (videoRgb && pngRgb && !videoRgb.equals(pngRgb)) issue(errors, "MEDIA_FRAME_SOURCE_MISMATCH", `${pointer}.qa.frames[${frameIndex}]`, "decoded pixels do not match the canonical video at the declared timeRatio");
        });
      }
    }
  }
  if ((assetManifest.slides || []).length !== dynamic.size) issue(errors, "MEDIA_SLIDE_COVERAGE", "assetManifest.slides", "must exactly cover every hybrid-video slide");
}

function validatePowerPointEventLog(log, expectedSlideIds, pointer, errors) {
  const events = Array.isArray(log && log.events) ? log.events : [];
  if (!events.length) {
    issue(errors, "POWERPOINT_EVENT_LOG", `${pointer}.events`, "must contain timestamped playback events");
    return null;
  }
  const allowedSlides = new Set(expectedSlideIds);
  let latestEventMs = -Infinity;
  const normalizedEvents = [];
  events.forEach((event, index) => {
    const at = event && typeof event.at === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(event.at) ? Date.parse(event.at) : NaN;
    if (!isObject(event) || !Number.isFinite(at) || !nonEmpty(event.event) || !allowedSlides.has(event.slideId)) {
      issue(errors, "POWERPOINT_EVENT_LOG", `${pointer}.events[${index}]`, "must bind an ISO timestamp, event type, and tested slideId");
      return;
    }
    normalizedEvents.push({ ...event, index, ms: at });
    latestEventMs = Math.max(latestEventMs, at);
  });
  let maxAutoplayDelayMs = 0;
  for (const slideId of expectedSlideIds) {
    const slideEvents = normalizedEvents.filter((event) => event.slideId === slideId);
    const sequence = [];
    for (const eventType of POWERPOINT_EVENT_SEQUENCE) {
      const matches = slideEvents.filter((event) => event.event === eventType);
      if (matches.length !== 1) {
        issue(errors, "POWERPOINT_EVENT_COVERAGE", `${pointer}.events`, `slide ${slideId} requires exactly one ${eventType} event`);
        sequence.push(null);
      } else sequence.push(matches[0]);
    }
    if (sequence.some((event) => !event)) continue;
    for (let index = 1; index < sequence.length; index += 1) {
      if (sequence[index].index <= sequence[index - 1].index || sequence[index].ms <= sequence[index - 1].ms) {
        issue(errors, "POWERPOINT_EVENT_ORDER", `${pointer}.events`, `slide ${slideId} event order must be ${POWERPOINT_EVENT_SEQUENCE.join(" -> ")}`);
        break;
      }
    }
    const initialDelay = sequence[1].ms - sequence[0].ms;
    const reentryDelay = sequence[6].ms - sequence[5].ms;
    maxAutoplayDelayMs = Math.max(maxAutoplayDelayMs, initialDelay, reentryDelay);
    if (initialDelay < 0 || initialDelay > 1000 || reentryDelay < 0 || reentryDelay > 1000) {
      issue(errors, "POWERPOINT_AUTOPLAY_TIMING", `${pointer}.events`, `slide ${slideId} autoplay and reentry autoplay must each begin within one second`);
    }
  }
  const completedAt = log && typeof log.completedAt === "string" && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(log.completedAt) ? Date.parse(log.completedAt) : NaN;
  if (!Number.isFinite(completedAt) || completedAt < latestEventMs) issue(errors, "POWERPOINT_EVENT_ORDER", `${pointer}.completedAt`, "must be an ISO timestamp at or after every event");
  return { maxAutoplayDelaySeconds: maxAutoplayDelayMs / 1000 };
}

function validatePowerPointEvidence(jobDir, record, candidateAsset, jobId, expectedSlideIds, errors, options = {}) {
  if (!isObject(record) || record.passed !== true) {
    issue(errors, "POWERPOINT_VERIFICATION", "job.release.final.powerPointVerification", "final requires a real PowerPoint receipt");
    return;
  }
  const evidence = readBoundJson(jobDir, { path: record.evidencePath, sha256: record.evidenceSha256 }, "job.release.final.powerPointVerification.evidence", errors);
  if (!evidence) return;
  const receipt = evidence.value;
  const artifactHash = candidateAsset && candidateAsset.actualHash;
  if (record.artifactSha256 !== artifactHash || receipt.artifactSha256 !== artifactHash) issue(errors, "STALE_POWERPOINT_VERIFICATION", "job.release.final.powerPointVerification.artifactSha256", "must bind the exact released candidate bytes");
  const injectedProducer = isObject(options.powerPointProducer) ? options.powerPointProducer : null;
  if (injectedProducer && options.allowFixturePowerPointProducer !== true) {
    issue(errors, "POWERPOINT_FIXTURE_FORBIDDEN", "powerPointReceipt.producer", "an injected producer is test-only and cannot be used for a release gate");
  }
  const trustedProducer = injectedProducer || {
    id: POWERPOINT_PRODUCER_ID,
    version: POWERPOINT_PRODUCER_VERSION,
    path: path.join(__dirname, "powerpoint_verify_macos.py"),
  };
  let trustedProducerHash = null;
  try {
    trustedProducerHash = sha256File(path.resolve(trustedProducer.path));
  } catch (error) {
    issue(errors, "POWERPOINT_PRODUCER_TRUST", "powerPointReceipt.producer", error.message);
  }
  if (
    !isObject(receipt.producer) || receipt.producer.id !== trustedProducer.id ||
    receipt.producer.version !== trustedProducer.version || receipt.producer.implementationSha256 !== trustedProducerHash
  ) issue(errors, "POWERPOINT_PRODUCER_DRIFT", "powerPointReceipt.producer", "must match the trusted receipt producer ID, version, and current implementation bytes");
  const fixtureProducerAllowed = Boolean(injectedProducer && options.allowFixturePowerPointProducer === true);
  if (!fixtureProducerAllowed) {
    const liveResult = (options.powerPointLiveAttestationImpl || validatePowerPointLiveAttestation)(receipt, options.powerPointLiveAttestationOptions || {});
    if (!liveResult || liveResult.passed !== true) {
      for (const liveError of (liveResult && liveResult.errors) || [{ code: "POWERPOINT_LIVE_INSPECTION", path: "powerPointReceipt.powerPoint", message: "live PowerPoint attestation did not run" }]) {
        issue(errors, liveError.code, liveError.path, liveError.message);
      }
    }
  }
  if (
    receipt.schemaVersion !== SCHEMA_VERSION || receipt.receiptType !== "deckformance-powerpoint-playback" || receipt.jobId !== jobId ||
    receipt.artifactPath !== "candidate.pptx" || !nonEmpty(receipt.powerPointVersion) ||
    !isDateTime(receipt.testedAt) || receipt.passed !== true
  ) issue(errors, "POWERPOINT_VERIFICATION", "powerPointReceipt", "must identify a real macOS PowerPoint run of candidate.pptx");
  const system = receipt.system;
  if (!isObject(system) || system.platform !== "macos" || !nonEmpty(system.osVersion) || !nonEmpty(system.arch)) {
    issue(errors, "POWERPOINT_SYSTEM", "powerPointReceipt.system", "must bind macOS version and architecture");
  }
  if (receipt.platform !== undefined && receipt.platform !== "macos") issue(errors, "POWERPOINT_SYSTEM", "powerPointReceipt.platform", "must be macos when present");
  const powerPoint = receipt.powerPoint;
  const signature = powerPoint && powerPoint.codeSignature;
  if (
    !isObject(powerPoint) || powerPoint.bundleIdentifier !== "com.microsoft.Powerpoint" ||
    !nonEmpty(powerPoint.shortVersion) || !nonEmpty(powerPoint.bundleVersion) || !validHash(powerPoint.executableSha256) ||
    !isObject(signature) || signature.valid !== true || signature.identifier !== powerPoint.bundleIdentifier ||
    !nonEmpty(signature.teamIdentifier) || !/^[A-Fa-f0-9]{20,64}$/.test(String(signature.cdHash || "")) ||
    !Array.isArray(signature.authorities) || signature.authorities.length === 0 || signature.authorities.some((item) => !nonEmpty(item))
  ) issue(errors, "POWERPOINT_APP_IDENTITY", "powerPointReceipt.powerPoint", "must bind the Microsoft PowerPoint bundle, executable hash, and a verified code signature");
  if (isObject(powerPoint) && receipt.powerPointVersion !== `${powerPoint.shortVersion} (${powerPoint.bundleVersion})`) {
    issue(errors, "POWERPOINT_APP_IDENTITY", "powerPointReceipt.powerPointVersion", "must be derived from the bound bundle short version and build version");
  }
  for (const key of ["autoPlayOnce", "noLoop", "manualAdvance", "forwardNavigationPassed", "backNavigationPassed", "reentryAutoplayOnce"]) {
    if (!isObject(receipt.playback) || receipt.playback[key] !== true) issue(errors, "POWERPOINT_PLAYBACK", `powerPointReceipt.playback.${key}`, "must be true");
  }
  if (receipt.playback && (!Number.isFinite(receipt.playback.autoPlayWithinSeconds) || receipt.playback.autoPlayWithinSeconds < 0 || receipt.playback.autoPlayWithinSeconds > 1)) issue(errors, "POWERPOINT_PLAYBACK", "powerPointReceipt.playback.autoPlayWithinSeconds", "must be between 0 and 1 second");
  const tested = Array.isArray(receipt.testedSlideIds) ? [...receipt.testedSlideIds].sort() : [];
  if (!sameJson(tested, expectedSlideIds)) issue(errors, "POWERPOINT_SLIDE_COVERAGE", "powerPointReceipt.testedSlideIds", "must cover every hybrid-video slide exactly once");
  if (record.capturePath !== receipt.capturePath || record.captureSha256 !== receipt.captureSha256) issue(errors, "POWERPOINT_CAPTURE", "job.release.final.powerPointVerification", "must copy the receipt capture descriptor");
  if (
    record.powerPointVersion !== receipt.powerPointVersion || !sameJson(record.system, receipt.system) ||
    record.testLogPath !== receipt.testLogPath || record.testLogSha256 !== receipt.testLogSha256
  ) issue(errors, "POWERPOINT_TEST_LOG", "job.release.final.powerPointVerification", "must copy the receipt system, PowerPoint version, and test-log binding");
  const testLog = validateFileDescriptor(jobDir, { path: receipt.testLogPath, sha256: receipt.testLogSha256 }, "powerPointReceipt.testLog", errors);
  if (testLog) {
    try {
      const log = loadJson(testLog.filePath);
      const assertions = log.assertions;
      const logSlides = Array.isArray(log.testedSlideIds) ? [...log.testedSlideIds].sort() : [];
      const requiredPlayback = ["autoPlayOnce", "noLoop", "manualAdvance", "forwardNavigationPassed", "backNavigationPassed", "reentryAutoplayOnce"];
      if (
        log.schemaVersion !== SCHEMA_VERSION || log.logType !== "deckformance-powerpoint-playback-log" ||
        log.jobId !== jobId || log.artifactSha256 !== artifactHash || log.powerPointVersion !== receipt.powerPointVersion ||
        log.completedAt !== receipt.testedAt || !sameJson(logSlides, expectedSlideIds) ||
        !isObject(assertions) || requiredPlayback.some((key) => assertions[key] !== true || assertions[key] !== receipt.playback[key]) ||
        assertions.autoPlayWithinSeconds !== receipt.playback.autoPlayWithinSeconds
      ) issue(errors, "POWERPOINT_TEST_LOG", "powerPointReceipt.testLog", "must be a structured, event-bearing log bound to the exact job, candidate, PowerPoint version, slide coverage, and playback assertions");
      const timing = validatePowerPointEventLog(log, expectedSlideIds, "powerPointReceipt.testLog", errors);
      if (timing && receipt.playback.autoPlayWithinSeconds + 1e-9 < timing.maxAutoplayDelaySeconds) {
        issue(errors, "POWERPOINT_AUTOPLAY_TIMING", "powerPointReceipt.playback.autoPlayWithinSeconds", "cannot be lower than the delay derived from the event log");
      }
    } catch (error) {
      issue(errors, "POWERPOINT_TEST_LOG", "powerPointReceipt.testLog", `must be valid structured JSON: ${error.message}`);
    }
  }
  const capture = validateFileDescriptor(jobDir, { path: receipt.capturePath, sha256: receipt.captureSha256 }, "powerPointReceipt.capture", errors);
  if (!capture || !String(receipt.capturePath).endsWith(".mp4")) {
    if (capture) issue(errors, "POWERPOINT_CAPTURE", "powerPointReceipt.capturePath", "must end in .mp4");
    return;
  }
  try {
    const info = probe(capture.filePath);
    const stream = (info.streams || []).find((item) => item.codec_type === "video");
    const fps = stream ? Math.max(parseFrameRate(stream.avg_frame_rate), parseFrameRate(stream.r_frame_rate)) : NaN;
    const duration = Number(info.format && info.format.duration);
    const minimumDuration = Math.max(5, expectedSlideIds.length * 4);
    if (!stream || Number(stream.width) < 1920 || Number(stream.height) < 1080 || !Number.isFinite(fps) || fps < 29 || !Number.isFinite(duration) || duration < minimumDuration) {
      issue(errors, "POWERPOINT_CAPTURE", "powerPointReceipt.capture", `must be decodable 1920x1080 or higher at >=29 fps and at least ${minimumDuration}s long`);
    }
  } catch (error) {
    issue(errors, "POWERPOINT_CAPTURE", "powerPointReceipt.capture", `probe failed: ${error.message}`);
  }
}

function validateRelease(jobDir, job, contracts, hashes, level, errors, options = {}) {
  const candidate = job.release && job.release.candidate;
  if (!isObject(candidate)) return;
  const expectedCandidatePath = candidate.status === "released" ? "candidate.pptx" : EXPECTED_STAGING;
  if (candidate.artifact !== expectedCandidatePath || candidate.playbackVerified !== false) issue(errors, "CANDIDATE_SEMANTICS", "job.release.candidate", `artifact must be ${expectedCandidatePath} and playbackVerified must be false`);
  if (candidate.status === "released" && !isDateTime(candidate.validatedAt)) issue(errors, "CANDIDATE_SEMANTICS", "job.release.candidate.validatedAt", "released candidate needs a timestamp");
  const candidateAsset = validateFileDescriptor(jobDir, { path: candidate.artifact, sha256: candidate.sha256 }, "job.release.candidate", errors, "pptx");
  const slideCount = (contracts.designPlan && contracts.designPlan.slides || []).length;
  const dynamicCount = dynamicSlideIds(contracts.designPlan).length;
  validatePackageEvidence(jobDir, candidate.packageQa, candidateAsset, hashes, job.jobId, dynamicCount, slideCount, errors);
  validateRenderEvidence(jobDir, candidate.renderQa, candidateAsset, job.jobId, slideCount, errors, {
    requireHumanApproval: level === "final",
    trustedRenderTools: options.trustedRenderTools,
  });
  if (level !== "final") return;
  if (candidate.status !== "released") issue(errors, "FINAL_REQUIRES_CANDIDATE", "job.release.candidate.status", "final promotion requires a released candidate");
  const finalRecord = job.release.final;
  if (!isObject(finalRecord)) return;
  const expectedFinalPath = finalRecord.status === "released" ? "final.pptx" : "candidate.pptx";
  if (finalRecord.artifact !== expectedFinalPath) issue(errors, "FINAL_SEMANTICS", "job.release.final.artifact", `expected ${expectedFinalPath}`);
  if (finalRecord.sha256 !== candidate.sha256 || finalRecord.sourceCandidateSha256 !== candidate.sha256) issue(errors, "FINAL_BYTE_IDENTITY", "job.release.final", "final must preserve the candidate SHA-256 exactly");
  if (finalRecord.status === "released" && !isDateTime(finalRecord.validatedAt)) issue(errors, "FINAL_SEMANTICS", "job.release.final.validatedAt", "released final needs a timestamp");
  const finalAsset = validateFileDescriptor(jobDir, { path: finalRecord.artifact, sha256: finalRecord.sha256 }, "job.release.final", errors, "pptx");
  if (candidateAsset && finalAsset && candidateAsset.actualHash !== finalAsset.actualHash) issue(errors, "FINAL_BYTE_IDENTITY", "job.release.final.sha256", "final.pptx differs from candidate.pptx");
  validatePowerPointEvidence(jobDir, finalRecord.powerPointVerification, candidateAsset, job.jobId, dynamicSlideIds(contracts.designPlan), errors, options);
}

function validateJobV2(jobDirValue, options = {}) {
  const errors = [];
  const warnings = [];
  const root = path.resolve(jobDirValue);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    issue(errors, "JOB_DIR", "job", `job directory not found: ${root}`);
    return { ok: false, errors, warnings, stage: null, checkedThrough: null, releaseLevel: options.releaseLevel || null, currentHashes: {} };
  }
  let job = options.jobOverride || null;
  if (!job) {
    const jobPath = path.join(root, "job.json");
    if (!fs.existsSync(jobPath)) issue(errors, "MISSING_JOB", "job", "missing job.json");
    else try { job = loadJson(jobPath); } catch (error) { issue(errors, "INVALID_JSON", "job", error.message); }
  }
  if (!isObject(job)) return { ok: false, errors, warnings, stage: null, checkedThrough: null, releaseLevel: options.releaseLevel || null, currentHashes: {} };
  validateSchema(job, "job", "job", errors);
  validateDeclaredPaths(job, "job", errors);
  validateStageState(job, errors);
  for (const [key, expected] of Object.entries(CONTRACT_FILES)) if (!job.artifacts || job.artifacts[key] !== expected) issue(errors, "JOB_ARTIFACTS", `job.artifacts.${key}`, `must be ${expected}`);
  const actualStage = STAGES.includes(job.state && job.state.stage) ? job.state.stage : "initialized";
  const through = options.throughStage && STAGES.includes(options.throughStage) ? options.throughStage : actualStage;
  const stageIndex = Math.max(STAGES.indexOf(actualStage), STAGES.indexOf(through));
  const strict = options.releaseLevel === "candidate" || options.releaseLevel === "final";
  const contracts = {};
  for (const [key, relativePath] of Object.entries(CONTRACT_FILES)) {
    const required = strict || stageIndex >= STAGES.indexOf(CONTRACT_STAGE[key]);
    contracts[key] = loadContract(root, relativePath, key, errors, required);
    if (!contracts[key]) continue;
    const schemaKey = key === "characterModel" ? "character-model" : key === "contentPlan" ? "content-plan" : key === "visualPlan" ? "visual-plan" : key === "designPlan" ? "design-plan" : key === "assetManifest" ? "asset-manifest" : key;
    validateSchema(contracts[key], schemaKey, key, errors);
    validateDeclaredPaths(contracts[key], key, errors);
  }
  const currentHashes = currentContractHashes(root, contracts);
  validateJobIdentity(job, contracts, errors);
  validateCharacterModelSemantics(root, contracts.characterModel, errors);
  validateBindings(root, contracts, currentHashes, errors);
  validatePerformanceBibleBinding(contracts.characterModel, contracts.assetManifest, errors);
  validateStylePack(contracts.designPlan, errors);
  if (options.skipEnvironmentBindings !== true) validateFontBindings(contracts.designPlan, errors);
  if (contracts.designPlan) validateBoundDescriptors(root, contracts.designPlan.registeredAssets, "designPlan.registeredAssets", errors);
  if (contracts.assetManifest) validateBoundDescriptors(root, contracts.assetManifest, "assetManifest", errors);
  if (strict) validateMediaEvidence(root, contracts.designPlan, contracts.assetManifest, contracts.characterModel, errors, {
    ffmpegPath: options.ffmpegPath,
    requireHumanApproval: options.releaseLevel === "final",
  });
  validateTrackedArtifacts(root, job, currentHashes, errors, strict);
  if (strict) validateRelease(root, job, contracts, currentHashes, options.releaseLevel, errors, options);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stage: actualStage,
    checkedThrough: through,
    releaseLevel: options.releaseLevel || null,
    currentHashes,
    job,
    contracts,
  };
}

function validateBoundDescriptors(jobDir, value, pointer, errors, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (isObject(value) && isSafeRelativePath(value.path) && validHash(value.sha256)) validateFileDescriptor(jobDir, value, pointer, errors);
  if (Array.isArray(value)) value.forEach((item, index) => validateBoundDescriptors(jobDir, item, `${pointer}[${index}]`, errors, seen));
  else for (const [key, child] of Object.entries(value)) validateBoundDescriptors(jobDir, child, `${pointer}.${key}`, errors, seen);
}

function printableResult(result) {
  return {
    ok: result.ok,
    stage: result.stage,
    checkedThrough: result.checkedThrough,
    releaseLevel: result.releaseLevel,
    currentHashes: result.currentHashes,
    errors: result.errors,
    warnings: result.warnings,
  };
}

function parseCli(argv) {
  const args = [...argv];
  const jobDir = args.shift();
  let releaseLevel = null;
  let json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--json") json = true;
    else if (arg === "--release") releaseLevel = args.shift();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!jobDir) throw new Error("usage: node validate_job_v2.js <job-dir> [--release candidate|final] [--json]");
  if (releaseLevel && !["candidate", "final"].includes(releaseLevel)) throw new Error("--release must be candidate or final");
  return { jobDir, releaseLevel, json };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseCli(argv); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; return null; }
  const result = validateJobV2(options.jobDir, { releaseLevel: options.releaseLevel });
  if (options.json) process.stdout.write(`${JSON.stringify(printableResult(result), null, 2)}\n`);
  else if (result.ok) process.stdout.write(`PASS ${path.resolve(options.jobDir)} (${options.releaseLevel || `through ${result.checkedThrough}`})\n`);
  else {
    process.stderr.write(`FAIL ${path.resolve(options.jobDir)} (${result.errors.length} errors)\n`);
    result.errors.forEach((error) => process.stderr.write(`- [${error.code}] ${error.path}: ${error.message}\n`));
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

module.exports = {
  CONTRACT_FILES,
  CONTRACT_STAGE,
  EXPECTED_PACKAGE_REPORT,
  EXPECTED_POWERPOINT_RECEIPT,
  EXPECTED_RENDER_INDEX,
  EXPECTED_RENDER_QA,
  EXPECTED_STAGING,
  POWERPOINT_PRODUCER_ID,
  POWERPOINT_PRODUCER_VERSION,
  SCHEMA_VERSION,
  STAGES,
  currentContractHashes,
  decodePng,
  printableResult,
  schemaValidators,
  validateBoundDescriptors,
  validateCharacterModelSemantics,
  validateFileDescriptor,
  validateJobV2,
  validateMediaEvidence,
  validatePerformanceBibleBinding,
  validatePowerPointEvidence,
  validateProviderReceipt,
  validateRenderEvidence,
  validateRenderedSlides,
};

if (require.main === module) main();

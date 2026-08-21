#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { probe, runTool } = require("./media_contract");

const SCHEMA_VERSION = "1.0.0";
const STAGES = Object.freeze([
  "initialized",
  "briefed",
  "researched",
  "content-planned",
  "character-ready",
  "visual-planned",
  "layout-ready",
  "stills-ready",
  "videos-ready",
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
  assetManifest: "asset-manifest.json",
  deck: "deck.json",
});

const CONTRACT_STAGE = Object.freeze({
  brief: "briefed",
  contentPlan: "content-planned",
  characterModel: "character-ready",
  visualPlan: "visual-planned",
  assetManifest: "videos-ready",
  deck: "packaged",
});

const LAYOUTS_PATH = path.resolve(__dirname, "..", "references", "layouts.json");
const SCHEMAS_DIR = path.resolve(__dirname, "..", "schemas");
const SCHEMA_FILES = Object.freeze({
  brief: "brief.schema.json",
  characterModel: "character-model.schema.json",
  contentPlan: "content-plan.schema.json",
  visualPlan: "visual-plan.schema.json",
  assetManifest: "asset-manifest.schema.json",
  deck: "deck.schema.json",
  job: "job.schema.json",
});
let compiledSchemaValidators = null;

const HUMANOID_FULL_BODY_PARTS = Object.freeze([
  "head",
  "torso",
  "left-arm",
  "right-arm",
  "left-hand",
  "right-hand",
  "left-leg",
  "right-leg",
  "left-foot",
  "right-foot",
]);

const FULL_BODY_ACTIONS = new Set([
  "locomotion",
  "jump",
  "landing",
  "push-pull",
  "large-prop",
]);

const QA_CHECKS = Object.freeze([
  "identityConsistent",
  "requiredBodyPartsVisible",
  "limbCountStable",
  "supportContactValid",
  "actionInsideSafeCrop",
  "occlusionContinuous",
  "framingIntentional",
  "noReadableText",
  "slotCropSafe",
]);

const decodedAssetCache = new Set();
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
    else if (type === "IEND") {
      ended = true;
      break;
    }
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
  if (interlace === 0) {
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    if (inflated.length !== (rowBytes + 1) * height) throw new Error("PNG scanline payload length mismatch");
  } else if (inflated.length === 0) {
    throw new Error("empty interlaced PNG payload");
  }
  return { width, height };
}

function issue(errors, code, pointer, message) {
  errors.push({ code, path: pointer, message });
}

function schemaValidators() {
  if (compiledSchemaValidators) return compiledSchemaValidators;
  // The schemas use conditional subschemas that refine properties declared by
  // their parent.  Draft 2020-12 permits this; Ajv's authoring-lint strict
  // modes require redundant local declarations, so disable only that linting
  // layer while still executing every schema keyword at runtime.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validators = {};
  for (const [key, fileName] of Object.entries(SCHEMA_FILES)) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, fileName), "utf8"));
    validators[key] = ajv.compile(schema);
  }
  compiledSchemaValidators = validators;
  return validators;
}

function validateSchema(value, key, pointer, errors) {
  let validator;
  try {
    validator = schemaValidators()[key];
  } catch (error) {
    issue(errors, "SCHEMA_RUNTIME", pointer, `schema runtime failed: ${error.message}`);
    return;
  }
  if (validator(value)) return;
  for (const error of validator.errors || []) {
    const location = `${pointer}${error.instancePath || ""}`;
    issue(errors, "SCHEMA_VALIDATION", location, `${error.keyword}: ${error.message}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validHash(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sha256Buffer(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function isSafeRelativePath(value) {
  if (!isNonEmptyString(value) || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return path.posix.normalize(value) === value;
}

function resolveJobPath(jobDir, relativePath, options = {}) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`unsafe job-relative path: ${String(relativePath)}`);
  }
  const root = path.resolve(jobDir);
  const target = path.resolve(root, ...relativePath.split("/"));
  const lexical = path.relative(root, target);
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
    throw new Error(`path leaves job directory: ${relativePath}`);
  }
  if (fs.existsSync(target)) {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`symlink leaves job directory: ${relativePath}`);
    }
  } else if (options.mustExist) {
    throw new Error(`missing file: ${relativePath}`);
  }
  return target;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadJsonContract(jobDir, relativePath, pointer, errors, required = true) {
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
    return loadJson(filePath);
  } catch (error) {
    issue(errors, "INVALID_JSON", pointer, `${relativePath}: ${error.message}`);
    return null;
  }
}

function validateVersionAndJobId(doc, jobId, pointer, errors) {
  if (!isObject(doc)) {
    issue(errors, "INVALID_CONTRACT", pointer, "contract must be a JSON object");
    return;
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    issue(errors, "SCHEMA_VERSION", `${pointer}.schemaVersion`, `expected ${SCHEMA_VERSION}`);
  }
  if (doc.jobId !== jobId) {
    issue(errors, "JOB_ID_MISMATCH", `${pointer}.jobId`, `expected ${jobId}`);
  }
}

function validatePathValue(value, pointer, errors) {
  if (!isSafeRelativePath(value)) {
    issue(errors, "UNSAFE_PATH", pointer, "path must be normalized, job-relative, use / separators, and contain no . or .. segments");
  }
}

function validateAllDeclaredPaths(value, pointer, errors, parentKey = "") {
  if (Array.isArray(value)) {
    if (["assetPaths", "evidence"].includes(parentKey)) {
      value.forEach((item, index) => validatePathValue(item, `${pointer}[${index}]`, errors));
    } else {
      value.forEach((item, index) => validateAllDeclaredPaths(item, `${pointer}[${index}]`, errors, parentKey));
    }
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}.${key}`;
    const pathLike = key === "path" || key === "artifact" || key === "evidencePath" || key.endsWith("Path");
    if (pathLike && child !== null) {
      validatePathValue(child, childPointer, errors);
    } else if (key === "artifacts" && isObject(child)) {
      for (const [artifactKey, artifactPath] of Object.entries(child)) {
        validatePathValue(artifactPath, `${childPointer}.${artifactKey}`, errors);
      }
    } else {
      validateAllDeclaredPaths(child, childPointer, errors, key);
    }
  }
}

function validateHashFile(jobDir, descriptor, pointer, errors, kind = "file") {
  if (!isObject(descriptor)) {
    issue(errors, "INVALID_ASSET", pointer, "asset descriptor must be an object");
    return null;
  }
  validatePathValue(descriptor.path, `${pointer}.path`, errors);
  if (!validHash(descriptor.sha256)) {
    issue(errors, "INVALID_HASH", `${pointer}.sha256`, "expected sha256:<64 lowercase hex characters>");
    return null;
  }
  let filePath;
  try {
    filePath = resolveJobPath(jobDir, descriptor.path, { mustExist: true });
  } catch (error) {
    issue(errors, "MISSING_ASSET", `${pointer}.path`, error.message);
    return null;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    issue(errors, "INVALID_ASSET", `${pointer}.path`, "asset is not a regular file");
    return null;
  }
  const actualHash = sha256File(filePath);
  if (actualHash !== descriptor.sha256) {
    issue(errors, "STALE_ASSET", `${pointer}.sha256`, `declared ${descriptor.sha256}, actual ${actualHash}`);
  }
  if (Number.isInteger(descriptor.bytes) && descriptor.bytes !== stat.size) {
    issue(errors, "SIZE_MISMATCH", `${pointer}.bytes`, `declared ${descriptor.bytes}, actual ${stat.size}`);
  }
  const head = fs.readFileSync(filePath).subarray(0, 32);
  if (kind === "png") {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (head.length < 24 || !head.subarray(0, 8).equals(pngSig) || head.toString("ascii", 12, 16) !== "IHDR") {
      issue(errors, "CORRUPT_PNG", `${pointer}.path`, "file is not a valid PNG header with IHDR");
    } else {
      const width = head.readUInt32BE(16);
      const height = head.readUInt32BE(20);
      if (descriptor.width !== width || descriptor.height !== height) {
        issue(errors, "DIMENSION_MISMATCH", pointer, `declared ${descriptor.width}x${descriptor.height}, PNG is ${width}x${height}`);
      }
    }
    if (!decodedAssetCache.has(`png:${actualHash}`)) {
      try {
        const decoded = decodePng(fs.readFileSync(filePath));
        if (decoded.width !== descriptor.width || decoded.height !== descriptor.height) {
          issue(errors, "CORRUPT_PNG", `${pointer}.path`, "PNG is not fully decodable at the declared dimensions");
        } else {
          decodedAssetCache.add(`png:${actualHash}`);
        }
      } catch (error) {
        issue(errors, "CORRUPT_PNG", `${pointer}.path`, `PNG decode failed: ${error.message}`);
      }
    }
  } else if (kind === "mp4") {
    if (head.length < 12 || head.toString("ascii", 4, 8) !== "ftyp") {
      issue(errors, "CORRUPT_MP4", `${pointer}.path`, "file has no ISO BMFF ftyp box");
    } else if (!decodedAssetCache.has(`mp4:${actualHash}`)) {
      try {
        const info = probe(filePath);
        const videoStream = (info.streams || []).find((stream) => stream.codec_type === "video");
        if (!videoStream || !Number.isFinite(Number(info.format && info.format.duration)) || Number(info.format.duration) <= 0) {
          issue(errors, "CORRUPT_MP4", `${pointer}.path`, "MP4 must contain a decodable video stream with positive duration");
        } else {
          runTool("ffmpeg", ["-v", "error", "-i", filePath, "-f", "null", "-"]);
          decodedAssetCache.add(`mp4:${actualHash}`);
        }
      } catch (error) {
        issue(errors, "CORRUPT_MP4", `${pointer}.path`, `MP4 decode failed: ${error.message}`);
      }
    }
  } else if (kind === "pptx") {
    if (head.length < 4 || !head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      issue(errors, "CORRUPT_PPTX", `${pointer}.path`, "file is not a ZIP/OOXML package");
    }
  }
  return { filePath, actualHash, bytes: stat.size };
}

function parseRate(value) {
  if (typeof value !== "string") return NaN;
  const match = value.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!match) return NaN;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  return denominator > 0 ? numerator / denominator : NaN;
}

function validateBrief(jobDir, brief, jobId, errors) {
  validateVersionAndJobId(brief, jobId, "brief", errors);
  if (!isObject(brief)) return;
  for (const key of ["topic", "purpose", "coreMessage"]) {
    if (!isNonEmptyString(brief[key])) issue(errors, "REQUIRED_FIELD", `brief.${key}`, "must be non-empty");
  }
  if (!isObject(brief.audience) || !isNonEmptyString(brief.audience.description)) {
    issue(errors, "REQUIRED_FIELD", "brief.audience", "audience description is required");
  }
  if (!Array.isArray(brief.mustCover) || brief.mustCover.length === 0 || brief.mustCover.some((v) => !isNonEmptyString(v))) {
    issue(errors, "REQUIRED_FIELD", "brief.mustCover", "at least one non-empty item is required");
  }
  if (!isObject(brief.brand) || !Array.isArray(brief.brand.assetPaths)) {
    issue(errors, "REQUIRED_FIELD", "brief.brand", "brand object and assetPaths are required");
  } else {
    for (const [index, assetPath] of brief.brand.assetPaths.entries()) {
      validatePathValue(assetPath, `brief.brand.assetPaths[${index}]`, errors);
    }
  }
  const creative = brief.creativeDirection;
  if (!isObject(creative) || !isNonEmptyString(creative.language) || !isNonEmptyString(creative.desiredStyle) || !isNonEmptyString(creative.energy) || !Array.isArray(creative.mood) || creative.mood.length === 0 || creative.mood.some((item) => !isNonEmptyString(item)) || !Array.isArray(creative.avoid) || creative.avoid.some((item) => !isNonEmptyString(item))) {
    issue(errors, "CREATIVE_DIRECTION", "brief.creativeDirection", "language, desiredStyle, mood, energy, and avoid are required structured inputs");
  }
  if (!isObject(brief.sourcePolicy) || brief.sourcePolicy.privateMaterialMayLeaveJob !== false) {
    issue(errors, "PRIVATE_SOURCE_POLICY", "brief.sourcePolicy.privateMaterialMayLeaveJob", "must be false");
  }
  if (brief.requestedPageCount !== null && (!Number.isInteger(brief.requestedPageCount) || brief.requestedPageCount < 2 || brief.requestedPageCount > 10)) {
    issue(errors, "PAGE_COUNT", "brief.requestedPageCount", "must be null or an integer from 2 through 10");
  }
  if (!Array.isArray(brief.sourceMaterials)) {
    issue(errors, "REQUIRED_FIELD", "brief.sourceMaterials", "must be an array");
  } else {
    brief.sourceMaterials.forEach((material, index) => {
      validateHashFile(jobDir, material, `brief.sourceMaterials[${index}]`, errors);
      if (typeof material.private !== "boolean") issue(errors, "REQUIRED_FIELD", `brief.sourceMaterials[${index}].private`, "must be boolean");
    });
  }
  const materialByPath = new Map((Array.isArray(brief.sourceMaterials) ? brief.sourceMaterials : []).map((material) => [material && material.path, material]));
  for (const assetPath of (brief.brand && Array.isArray(brief.brand.assetPaths) ? brief.brand.assetPaths : [])) {
    const descriptor = materialByPath.get(assetPath);
    if (!descriptor || !validHash(descriptor.sha256)) issue(errors, "BRAND_ASSET_BINDING", "brief.brand.assetPaths", `${assetPath} must have a matching path+hash descriptor in sourceMaterials`);
  }
}

function assertUpstream(doc, expected, pointer, errors) {
  if (!isObject(doc) || !isObject(doc.upstreamHashes)) {
    issue(errors, "MISSING_UPSTREAM_HASH", `${pointer}.upstreamHashes`, "upstream hash binding is required");
    return;
  }
  for (const [key, hash] of Object.entries(expected)) {
    if (doc.upstreamHashes[key] !== hash) {
      issue(errors, "STALE_UPSTREAM", `${pointer}.upstreamHashes.${key}`, `expected ${hash}, got ${String(doc.upstreamHashes[key])}`);
    }
  }
}

function validateContentPlan(content, brief, jobId, errors) {
  validateVersionAndJobId(content, jobId, "contentPlan", errors);
  if (!isObject(content)) return;
  if (!isNonEmptyString(content.thesis)) issue(errors, "REQUIRED_FIELD", "contentPlan.thesis", "must be non-empty");
  if (!isObject(content.narrative) || ["promise", "development", "proof", "conclusion"].some((key) => !isNonEmptyString(content.narrative[key]))) {
    issue(errors, "NARRATIVE_GAP", "contentPlan.narrative", "promise, development, proof, and conclusion are all required");
  }
  if (!Array.isArray(content.sources)) issue(errors, "REQUIRED_FIELD", "contentPlan.sources", "must be an array");
  const sources = Array.isArray(content.sources) ? content.sources : [];
  const sourceIds = new Set(sources.map((source) => source && source.id));
  const sourceById = new Map(sources.map((source) => [source && source.id, source]));
  if (sourceIds.size !== (Array.isArray(content.sources) ? content.sources.length : 0)) {
    issue(errors, "DUPLICATE_ID", "contentPlan.sources", "source IDs must be unique");
  }
  sources.forEach((source, index) => {
    const pointer = `contentPlan.sources[${index}]`;
    if (!isObject(source) || !isNonEmptyString(source.id) || !isNonEmptyString(source.title) || !["user-material", "public-url", "inference"].includes(source.kind)) {
      issue(errors, "SOURCE_CONTRACT", pointer, "id, title, and recognized kind are required");
      return;
    }
    if (!Array.isArray(source.supports) || source.supports.length === 0 || source.supports.some((id) => !isNonEmptyString(id))) issue(errors, "SOURCE_CONTRACT", `${pointer}.supports`, "must list at least one supported slide ID");
    if (source.kind === "public-url" && (!/^https?:\/\//.test(source.url || "") || !isDateTime(source.retrievedAt))) issue(errors, "SOURCE_CONTRACT", pointer, "public-url sources require an http(s) URL and retrievedAt");
  });
  if (!Array.isArray(content.slides) || content.slides.length < 2 || content.slides.length > 10) {
    issue(errors, "PAGE_COUNT", "contentPlan.slides", "must contain 2 through 10 slides");
    return;
  }
  if (brief && brief.requestedPageCount === null && (content.slides.length < 6 || content.slides.length > 10)) {
    issue(errors, "AUTO_PAGE_COUNT", "contentPlan.slides", "when requestedPageCount is null, derive 6 through 10 slides");
  }
  if (brief && Number.isInteger(brief.requestedPageCount) && content.slides.length !== brief.requestedPageCount) {
    issue(errors, "PAGE_COUNT_MISMATCH", "contentPlan.slides", `expected ${brief.requestedPageCount} slides`);
  }
  const slideIds = new Set();
  let contentPages = 0;
  content.slides.forEach((slide, index) => {
    const pointer = `contentPlan.slides[${index}]`;
    if (!isObject(slide)) return issue(errors, "INVALID_SLIDE", pointer, "must be an object");
    if (!isNonEmptyString(slide.id) || slideIds.has(slide.id)) issue(errors, "DUPLICATE_ID", `${pointer}.id`, "slide ID must be non-empty and unique");
    slideIds.add(slide.id);
    for (const key of ["role", "claim", "transition", "takeaway"]) {
      if (!isNonEmptyString(slide[key])) issue(errors, "REQUIRED_FIELD", `${pointer}.${key}`, "must be non-empty");
    }
    if (!isNonEmptyString(slide.title)) issue(errors, "DISPLAY_COPY", `${pointer}.title`, "display title must be non-empty");
    if (!Array.isArray(slide.body) || slide.body.length < 1 || slide.body.length > 3 || slide.body.some((line) => !isNonEmptyString(line))) {
      issue(errors, "DISPLAY_COPY", `${pointer}.body`, "display body must contain 1 through 3 non-empty lines");
    }
    if (!Array.isArray(slide.evidence) || slide.evidence.length === 0 || slide.evidence.some((item) => !isNonEmptyString(item))) {
      issue(errors, "EVIDENCE_GAP", `${pointer}.evidence`, "at least one evidence statement is required");
    }
    if (!Array.isArray(slide.sourceIds) || slide.sourceIds.some((id) => !sourceIds.has(id))) {
      issue(errors, "UNKNOWN_SOURCE", `${pointer}.sourceIds`, "every source ID must exist in contentPlan.sources");
    }
    if (slide.type === "content" || slide.type === "closing") {
      contentPages += 1;
      if (slide.videoRequired !== true) issue(errors, "VIDEO_REQUIRED", `${pointer}.videoRequired`, "content and closing slides must require video");
      if (!Array.isArray(slide.sourceIds) || slide.sourceIds.length === 0) {
        issue(errors, "SOURCE_REQUIRED", `${pointer}.sourceIds`, "dynamic content slides require at least one source");
      } else {
        const cited = slide.sourceIds.map((id) => sourceById.get(id)).filter(Boolean);
        const bases = new Set(cited.map((source) => source.kind === "public-url" ? "public-source" : source.kind));
        const expectedBasis = bases.size > 1 ? "mixed" : [...bases][0];
        if (slide.evidenceBasis !== expectedBasis) issue(errors, "EVIDENCE_BASIS", `${pointer}.evidenceBasis`, `expected ${expectedBasis}`);
        cited.forEach((source) => {
          if (!Array.isArray(source.supports) || !source.supports.includes(slide.id)) issue(errors, "SOURCE_SUPPORT", `${pointer}.sourceIds`, `${source.id} does not declare support for slide ${slide.id}`);
        });
      }
    } else if (slide.videoRequired !== false) {
      issue(errors, "UNEXPECTED_VIDEO_REQUIREMENT", `${pointer}.videoRequired`, "cover and section slides must not be marked videoRequired");
    } else if (slide.evidenceBasis !== "none") {
      issue(errors, "EVIDENCE_BASIS", `${pointer}.evidenceBasis`, "cover/section evidenceBasis must be none");
    }
  });
  sources.forEach((source, index) => {
    if (Array.isArray(source.supports) && source.supports.some((id) => !slideIds.has(id))) issue(errors, "SOURCE_SUPPORT", `contentPlan.sources[${index}].supports`, "contains an unknown slide ID");
  });
  if (contentPages < 1 || contentPages > 8) issue(errors, "CONTENT_PAGE_COUNT", "contentPlan.slides", "must contain 1 through 8 video content slides");
  const mustCover = Array.isArray(brief && brief.mustCover) ? brief.mustCover : [];
  const matrix = content.coverageMatrix;
  if (!Array.isArray(matrix)) {
    issue(errors, "COVERAGE_MATRIX", "contentPlan.coverageMatrix", "coverage matrix is required");
  } else {
    const counts = new Map();
    matrix.forEach((entry, index) => {
      const pointer = `contentPlan.coverageMatrix[${index}]`;
      if (!isObject(entry) || !isNonEmptyString(entry.mustCover)) {
        issue(errors, "COVERAGE_MATRIX", pointer, "mustCover is required");
        return;
      }
      counts.set(entry.mustCover, (counts.get(entry.mustCover) || 0) + 1);
      if (!mustCover.includes(entry.mustCover)) issue(errors, "UNKNOWN_COVERAGE_ITEM", `${pointer}.mustCover`, "must exactly match an item from brief.mustCover");
      if (!Array.isArray(entry.slideIds) || entry.slideIds.length === 0 || entry.slideIds.some((id) => !slideIds.has(id))) {
        issue(errors, "COVERAGE_MATRIX", `${pointer}.slideIds`, "must contain at least one existing slide ID");
      }
      if (!isNonEmptyString(entry.support)) issue(errors, "COVERAGE_MATRIX", `${pointer}.support`, "support must be non-empty");
    });
    for (const item of mustCover) {
      if (counts.get(item) !== 1) issue(errors, "COVERAGE_MATRIX", "contentPlan.coverageMatrix", `${item} must appear exactly once`);
    }
  }
}

function validateCharacterModel(jobDir, model, jobId, errors) {
  validateVersionAndJobId(model, jobId, "characterModel", errors);
  if (!isObject(model)) return;
  validateHashFile(jobDir, model.sourceReference, "characterModel.sourceReference", errors);
  const diagnostic = model.referenceDiagnostic;
  if (!isObject(diagnostic) || !["headshot", "bust", "half-body", "three-quarter", "full-body", "occluded", "multi-subject", "non-human"].includes(diagnostic.coverage)) {
    issue(errors, "REFERENCE_DIAGNOSTIC", "characterModel.referenceDiagnostic.coverage", "recognized coverage is required");
  }
  if (diagnostic && (!(diagnostic.selectionConfidence >= 0.75) || !isNonEmptyString(diagnostic.selectedSubject))) {
    issue(errors, "AMBIGUOUS_SUBJECT", "characterModel.referenceDiagnostic", "subject selection must be explicit with confidence >= 0.75");
  }
  if (diagnostic && (model.subjectKind === "human" || model.subjectKind === "humanoid-mascot")) {
    if (diagnostic.faceClarity === "low" || diagnostic.faceClarity === "not-applicable") {
      issue(errors, "IDENTITY_EVIDENCE", "characterModel.referenceDiagnostic.faceClarity", "human or humanoid identity needs a usable face reference");
    }
    if (diagnostic.viewAngle === "rear" || diagnostic.viewAngle === "not-applicable") {
      issue(errors, "IDENTITY_EVIDENCE", "characterModel.referenceDiagnostic.viewAngle", "human or humanoid identity cannot be established from a rear-only reference");
    }
  }
  if (!Array.isArray(model.identityLock) || model.identityLock.length === 0) {
    issue(errors, "IDENTITY_LOCK", "characterModel.identityLock", "at least one identity characteristic is required");
  }
  const identity = validateHashFile(jobDir, model.identityBible, "characterModel.identityBible", errors);
  if (identity && model.identityBible.qaPassed !== true) issue(errors, "IDENTITY_QA", "characterModel.identityBible.qaPassed", "must be true");
  const perf = model.performanceBible;
  if (!isObject(perf)) {
    issue(errors, "PERFORMANCE_BIBLE", "characterModel.performanceBible", "performance bible is required");
    return;
  }
  if (!Array.isArray(perf.candidates) || perf.candidates.length < 2) {
    issue(errors, "PERFORMANCE_CANDIDATES", "characterModel.performanceBible.candidates", "at least two candidates are required");
  }
  let selected = null;
  const seenCandidateIds = new Set();
  const seenCandidatePaths = new Set();
  const seenCandidateHashes = new Set();
  const passedCandidateScores = [];
  for (const [index, candidate] of (perf.candidates || []).entries()) {
    const pointer = `characterModel.performanceBible.candidates[${index}]`;
    validateHashFile(jobDir, candidate, pointer, errors);
    if (!isNonEmptyString(candidate.id) || seenCandidateIds.has(candidate.id)) issue(errors, "DUPLICATE_ID", `${pointer}.id`, "candidate ID must be unique");
    if (!isNonEmptyString(candidate.path) || seenCandidatePaths.has(candidate.path)) issue(errors, "DUPLICATE_CANDIDATE", `${pointer}.path`, "candidate path must be unique");
    if (!validHash(candidate.sha256) || seenCandidateHashes.has(candidate.sha256)) issue(errors, "DUPLICATE_CANDIDATE", `${pointer}.sha256`, "candidate hash must be unique");
    seenCandidateIds.add(candidate.id);
    seenCandidatePaths.add(candidate.path);
    seenCandidateHashes.add(candidate.sha256);
    if (candidate.qa && candidate.qa.passed === true) {
      const scoreFields = ["identityConsistency", "bodyCompleteness", "proportionStability", "animatability"];
      if (scoreFields.some((field) => !(candidate.qa[field] >= 0.85))) issue(errors, "CANDIDATE_SCORE", `${pointer}.qa`, "passed candidate scores must all be >= 0.85");
      const score = candidate.qa.identityConsistency * 0.35 + candidate.qa.bodyCompleteness * 0.30 + candidate.qa.proportionStability * 0.20 + candidate.qa.animatability * 0.15;
      passedCandidateScores.push({ id: candidate.id, score });
    }
    if (candidate.id === perf.selectedCandidateId) selected = candidate;
  }
  if (!selected) {
    issue(errors, "SELECTED_CANDIDATE", "characterModel.performanceBible.selectedCandidateId", "must select one declared candidate");
  } else {
    if (selected.sha256 !== perf.selectedSha256) issue(errors, "SELECTED_HASH", "characterModel.performanceBible.selectedSha256", "must match selected candidate hash");
    if (!selected.qa || selected.qa.passed !== true) issue(errors, "SELECTED_QA", "characterModel.performanceBible.selectedCandidateId", "selected candidate QA must pass");
    const selectedScore = passedCandidateScores.find((item) => item.id === selected.id);
    const bestScore = Math.max(...passedCandidateScores.map((item) => item.score));
    if (!selectedScore || selectedScore.score < bestScore - 1e-12) issue(errors, "SELECTED_CANDIDATE_SCORE", "characterModel.performanceBible.selectedCandidateId", "must select a highest weighted-score passing candidate");
  }
  const sideAction = validateHashFile(jobDir, perf.sideActionReference, "characterModel.performanceBible.sideActionReference", errors);
  if (sideAction && perf.sideActionReference.qaPassed !== true) issue(errors, "SIDE_ACTION_QA", "characterModel.performanceBible.sideActionReference.qaPassed", "must be true");
  const bodyDesign = perf.bodyDesign;
  if (!isObject(bodyDesign)) {
    issue(errors, "BODY_DESIGN", "characterModel.performanceBible.bodyDesign", "structured body design is required");
  } else {
    for (const key of ["stature", "proportionNotes", "footwearOrBase", "handsOrExtremities", "silhouette"]) {
      if (!isNonEmptyString(bodyDesign[key])) issue(errors, "BODY_DESIGN", `characterModel.performanceBible.bodyDesign.${key}`, "must be non-empty");
    }
    if (!Array.isArray(bodyDesign.clothing) || bodyDesign.clothing.length === 0 || bodyDesign.clothing.some((item) => !isNonEmptyString(item))) {
      issue(errors, "BODY_DESIGN", "characterModel.performanceBible.bodyDesign.clothing", "at least one clothing item is required");
    }
    if (!Array.isArray(bodyDesign.designedCompletions) || bodyDesign.designedCompletions.some((item) => !isNonEmptyString(item))) {
      issue(errors, "BODY_DESIGN", "characterModel.performanceBible.bodyDesign.designedCompletions", "must be an array of non-empty descriptions");
    }
  }
  const profile = perf.fullBodyProfile;
  if (!isObject(profile) || profile.coverage !== "full-body") {
    issue(errors, "HALF_BODY_PERFORMANCE_MODEL", "characterModel.performanceBible.fullBodyProfile.coverage", "performance model must be full-body even when the source is cropped");
  } else {
    const required = new Set(Array.isArray(profile.requiredParts) ? profile.requiredParts : []);
    const visible = new Set(Array.isArray(profile.visibleParts) ? profile.visibleParts : []);
    if (model.subjectKind === "human" || model.subjectKind === "humanoid-mascot") {
      for (const part of HUMANOID_FULL_BODY_PARTS) {
        if (!required.has(part)) issue(errors, "FULL_BODY_PART", "characterModel.performanceBible.fullBodyProfile.requiredParts", `missing required humanoid part ${part}`);
      }
    }
    for (const part of required) {
      if (!visible.has(part)) issue(errors, "MISSING_BODY_PART", "characterModel.performanceBible.fullBodyProfile.visibleParts", `${part} is required but not visible`);
    }
    if (Array.isArray(profile.missingParts) && profile.missingParts.length > 0) issue(errors, "MISSING_BODY_PART", "characterModel.performanceBible.fullBodyProfile.missingParts", "must be empty");
    for (const key of ["limbEndpointsVisible", "supportContactVisible", "groundContactStable"]) {
      if (profile[key] !== true) issue(errors, "FULL_BODY_QA", `characterModel.performanceBible.fullBodyProfile.${key}`, "must be true");
    }
    if (!(profile.safeMarginPercent >= 5)) issue(errors, "BODY_MARGIN", "characterModel.performanceBible.fullBodyProfile.safeMarginPercent", "must be at least 5 percent");
  }
  for (const key of ["identityConsistent", "bodyComplete", "proportionsStable", "animatable", "passed"]) {
    if (!perf.qa || perf.qa[key] !== true) issue(errors, "PERFORMANCE_QA", `characterModel.performanceBible.qa.${key}`, "must be true");
  }
  const doNotCopy = new Set((model.promptPolicy && model.promptPolicy.doNotCopyFromSource) || []);
  for (const concept of ["crop", "pose", "background", "subject-scale", "camera-distance"]) {
    if (!doNotCopy.has(concept)) issue(errors, "PROMPT_POLICY", "characterModel.promptPolicy.doNotCopyFromSource", `must explicitly contain ${concept}`);
  }
  const forbidden = new Set((model.cropPolicy && model.cropPolicy.forbiddenJoints) || []);
  for (const joint of ["neck", "shoulder", "elbow", "wrist", "waist", "knee", "ankle"]) {
    if (!forbidden.has(joint)) issue(errors, "CROP_POLICY", "characterModel.cropPolicy.forbiddenJoints", `must forbid crop at ${joint}`);
  }
}

function rectValid(rect) {
  return isObject(rect) && ["left", "top", "right", "bottom"].every((key) => typeof rect[key] === "number" && rect[key] >= 0 && rect[key] <= 1) && rect.left < rect.right && rect.top < rect.bottom;
}

function rectContains(outer, inner) {
  return outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

function parseAspect(aspect) {
  const match = typeof aspect === "string" && aspect.match(/^([1-9][0-9]*):([1-9][0-9]*)$/);
  return match ? Number(match[1]) / Number(match[2]) : null;
}

function validateVisualPlan(visual, content, model, layoutsDoc, jobId, errors) {
  validateVersionAndJobId(visual, jobId, "visualPlan", errors);
  if (!isObject(visual)) return;
  if (!isObject(visual.brandDirection) || !isObject(visual.brandDirection.deckPalette) || !Array.isArray(visual.brandDirection.sourceSwatches) || visual.brandDirection.sourceSwatches.length < 3) {
    issue(errors, "BRAND_DIRECTION", "visualPlan.brandDirection", "named deckPalette, source swatches, and brand direction are required");
  } else {
    for (const key of ["bg", "panel", "title", "body", "muted", "accent", "ink", "inkMuted"]) {
      if (!/^#[A-Fa-f0-9]{6}$/.test(visual.brandDirection.deckPalette[key] || "")) issue(errors, "DECK_PALETTE", `visualPlan.brandDirection.deckPalette.${key}`, "must be a #RRGGBB color");
    }
  }
  const typography = visual.brandDirection && visual.brandDirection.typography;
  if (!isObject(typography) || ["title", "body", "number", "rationale"].some((key) => !isNonEmptyString(typography[key]))) {
    issue(errors, "TYPOGRAPHY", "visualPlan.brandDirection.typography", "title, body, number, and rationale are required");
  }
  const contentIds = new Set((content && content.slides || []).filter((slide) => slide.videoRequired === true).map((slide) => slide.id));
  if (!Array.isArray(visual.slides) || visual.slides.length !== contentIds.size) {
    issue(errors, "VISUAL_COVERAGE", "visualPlan.slides", "must contain exactly one shot plan for every content slide");
    return;
  }
  const visualIds = new Set();
  visual.slides.forEach((slide, index) => {
    const pointer = `visualPlan.slides[${index}]`;
    if (!contentIds.has(slide.id) || visualIds.has(slide.id)) issue(errors, "VISUAL_COVERAGE", `${pointer}.id`, "must be a unique content slide ID");
    visualIds.add(slide.id);
    if (!isNonEmptyString(slide.visualProposition) || !Array.isArray(slide.required) || slide.required.length === 0 || !Array.isArray(slide.optional) || !Array.isArray(slide.forbidden)) {
      issue(errors, "VISUAL_CONTRACT", pointer, "visualProposition plus required/optional/forbidden lists are required");
    }
    if (!Array.isArray(slide.forbidden) || !slide.forbidden.includes("readable-text")) {
      issue(errors, "VISUAL_CONTRACT", `${pointer}.forbidden`, "must explicitly forbid readable-text");
    }
    if (!isObject(slide.characterPerformance) || slide.characterPerformance.present !== true || !isNonEmptyString(slide.characterPerformance.roleInClaim) || !isNonEmptyString(slide.characterPerformance.action)) {
      issue(errors, "CHARACTER_PERFORMANCE", `${pointer}.characterPerformance`, "the recurring character must be present with a claim role and action");
    }
    const selectedLayout = layoutsDoc && layoutsDoc.layouts && layoutsDoc.layouts[slide.layoutId];
    if (!selectedLayout || selectedLayout.contentSlide !== true) {
      issue(errors, "LAYOUT_ID", `${pointer}.layoutId`, "must be one of the content layouts in references/layouts.json");
    } else {
      if (slide.layoutFamily !== selectedLayout.family) issue(errors, "LAYOUT_FAMILY", `${pointer}.layoutFamily`, `expected ${selectedLayout.family} for ${slide.layoutId}`);
      const expectedAspect = selectedLayout.mediaAspect && selectedLayout.mediaAspect.label;
      if (!slide.slot || slide.slot.aspect !== expectedAspect) issue(errors, "LAYOUT_ASPECT", `${pointer}.slot.aspect`, `expected ${expectedAspect} for ${slide.layoutId}`);
    }
    const slot = slide.slot;
    const declaredAspect = slot && parseAspect(slot.aspect);
    if (!declaredAspect || !Number.isInteger(slot.widthPx) || !Number.isInteger(slot.heightPx) || Math.max(slot.widthPx, slot.heightPx) > 1920 || Math.min(slot.widthPx, slot.heightPx) > 1080) {
      issue(errors, "VIDEO_SLOT", `${pointer}.slot`, "valid aspect and 1080p-class dimensions are required (long edge <=1920, short edge <=1080)");
    } else if (Math.abs(slot.widthPx / slot.heightPx - declaredAspect) / declaredAspect > 0.01) {
      issue(errors, "ASPECT_MISMATCH", `${pointer}.slot`, "slot pixel dimensions must match declared aspect within 1 percent");
    }
    const shot = slide.shotPlan;
    if (!isObject(shot)) return issue(errors, "SHOT_PLAN", `${pointer}.shotPlan`, "shot plan is required");
    if (!rectValid(shot.safeCrop)) issue(errors, "SAFE_CROP", `${pointer}.shotPlan.safeCrop`, "must be a non-empty normalized rectangle");
    if (!rectValid(shot.actionEnvelope)) issue(errors, "ACTION_ENVELOPE", `${pointer}.shotPlan.actionEnvelope`, "must be a non-empty normalized rectangle");
    if (rectValid(shot.safeCrop) && rectValid(shot.actionEnvelope) && !rectContains(shot.safeCrop, shot.actionEnvelope)) {
      issue(errors, "ACTION_OUTSIDE_SAFE_CROP", `${pointer}.shotPlan.actionEnvelope`, "action envelope must fit inside safe crop");
    }
    if (shot.derivedFromSourceCrop !== false) issue(errors, "SOURCE_CROP_INHERITANCE", `${pointer}.shotPlan.derivedFromSourceCrop`, "must be false");
    if (shot.cutsAtJoints !== false) issue(errors, "JOINT_CROP", `${pointer}.shotPlan.cutsAtJoints`, "must be false");
    if (!isNonEmptyString(shot.framingRationale)) issue(errors, "FRAMING_RATIONALE", `${pointer}.shotPlan.framingRationale`, "must explain why this shot fits the page");
    if (!isNonEmptyString(shot.bodyContinuation)) issue(errors, "BODY_CONTINUATION", `${pointer}.shotPlan.bodyContinuation`, "must explain where the body continues or is contained");
    if (FULL_BODY_ACTIONS.has(slide.actionClass) && shot.shotType !== "full-body") {
      issue(errors, "ACTION_REQUIRES_FULL_BODY", `${pointer}.shotPlan.shotType`, `${slide.actionClass} requires full-body framing`);
    }
    if (shot.shotType === "full-body") {
      if (shot.framingBoundary !== "full-body-contained") issue(errors, "FRAMING_BOUNDARY", `${pointer}.shotPlan.framingBoundary`, "full-body shots must be fully contained");
      const visible = new Set(Array.isArray(shot.bodyVisibility) ? shot.bodyVisibility : []);
      if (model && (model.subjectKind === "human" || model.subjectKind === "humanoid-mascot")) {
        for (const part of HUMANOID_FULL_BODY_PARTS) {
          if (!visible.has(part)) issue(errors, "SHOT_BODY_VISIBILITY", `${pointer}.shotPlan.bodyVisibility`, `full-body shot must include ${part}`);
        }
      }
      if (shot.groundContact === "not-visible-intentionally") issue(errors, "GROUND_CONTACT", `${pointer}.shotPlan.groundContact`, "full-body shots must show or define support contact");
    } else {
      if (!["natural-edge-exit", "explained-occlusion", "close-up"].includes(shot.framingBoundary)) issue(errors, "FRAMING_BOUNDARY", `${pointer}.shotPlan.framingBoundary`, "non-full-body framing must explain the body's continuation");
      if (shot.framingBoundary === "explained-occlusion" && !isNonEmptyString(shot.occlusionReason)) issue(errors, "FRAMING_BOUNDARY", `${pointer}.shotPlan.occlusionReason`, "explained occlusion requires a reason");
      if (shot.framingBoundary === "close-up" && shot.shotType !== "close-up") issue(errors, "FRAMING_BOUNDARY", `${pointer}.shotPlan.framingBoundary`, "close-up boundary is only valid for close-up shots");
    }
    const generation = slide.generation;
    if (!isObject(generation) || !Number.isInteger(generation.stillCandidateCount) || generation.stillCandidateCount < 2 || generation.stillCandidateCount > 3 || generation.videoMaxAttempts !== 3 || generation.noReadableText !== true) {
      issue(errors, "GENERATION_POLICY", `${pointer}.generation`, "requires 2-3 still candidates, 3 video attempts maximum, and no readable text");
    }
  });
}

function validateAttempt(jobDir, attempt, pointer, errors) {
  validateHashFile(jobDir, attempt, pointer, errors);
  if (!["selected", "rejected"].includes(attempt && attempt.status)) issue(errors, "ATTEMPT_STATUS", `${pointer}.status`, "must be selected or rejected");
  if (!isNonEmptyString(attempt && attempt.reason)) issue(errors, "ATTEMPT_REASON", `${pointer}.reason`, "must be non-empty");
}

function validateAttemptUniqueness(attempts, pointer, errors) {
  for (const field of ["id", "path", "sha256"]) {
    const values = attempts.map((attempt) => attempt && attempt[field]);
    if (new Set(values).size !== values.length) issue(errors, "DUPLICATE_ATTEMPT", pointer, `${field} must be unique within this attempt set`);
  }
}

function validateAssetManifest(jobDir, manifest, content, visual, model, currentHashes, jobId, errors) {
  validateVersionAndJobId(manifest, jobId, "assetManifest", errors);
  if (!isObject(manifest)) return;
  const contentIds = new Set((content && content.slides || []).filter((slide) => slide.videoRequired === true).map((slide) => slide.id));
  const visualById = new Map((visual && visual.slides || []).map((slide) => [slide.id, slide]));
  if (!Array.isArray(manifest.slides) || manifest.slides.length !== contentIds.size) {
    issue(errors, "ASSET_COVERAGE", "assetManifest.slides", "must contain exactly one asset record for every content slide");
    return;
  }
  const seen = new Set();
  manifest.slides.forEach((slide, index) => {
    const pointer = `assetManifest.slides[${index}]`;
    if (!contentIds.has(slide.id) || seen.has(slide.id)) issue(errors, "ASSET_COVERAGE", `${pointer}.id`, "must be a unique content slide ID");
    seen.add(slide.id);
    const poster = validateHashFile(jobDir, slide.poster, `${pointer}.poster`, errors, "png");
    const video = validateHashFile(jobDir, slide.video, `${pointer}.video`, errors, "mp4");
    if (slide.poster && slide.poster.mime !== "image/png") issue(errors, "POSTER_MIME", `${pointer}.poster.mime`, "must be image/png");
    if (slide.video) {
      if (slide.video.mime !== "video/mp4" || slide.video.codec !== "h264" || slide.video.pixelFormat !== "yuv420p" || slide.video.muted !== true) {
        issue(errors, "VIDEO_FORMAT", `${pointer}.video`, "must be silent H.264 MP4 with yuv420p pixel format");
      }
      if (Math.max(slide.video.width, slide.video.height) > 1920 || Math.min(slide.video.width, slide.video.height) > 1080) issue(errors, "VIDEO_RESOLUTION", `${pointer}.video`, "must be 1080p class (long edge <=1920, short edge <=1080)");
    }
    const plan = visualById.get(slide.id);
    if (plan && slide.poster && slide.video) {
      const expected = parseAspect(plan.slot.aspect);
      for (const [kind, asset] of [["poster", slide.poster], ["video", slide.video]]) {
        if (expected && asset.width && asset.height && Math.abs(asset.width / asset.height - expected) / expected > 0.01) {
          issue(errors, "ASPECT_MISMATCH", `${pointer}.${kind}`, `${kind} dimensions must match the final slot aspect`);
        }
      }
    }
    const stillAttempts = slide.attempts && slide.attempts.stills;
    const videoAttempts = slide.attempts && slide.attempts.videos;
    if (!Array.isArray(stillAttempts) || stillAttempts.length < 2 || stillAttempts.length > 3) {
      issue(errors, "STILL_ATTEMPTS", `${pointer}.attempts.stills`, "must contain 2 or 3 still candidates");
    } else {
      stillAttempts.forEach((attempt, attemptIndex) => validateAttempt(jobDir, attempt, `${pointer}.attempts.stills[${attemptIndex}]`, errors));
      validateAttemptUniqueness(stillAttempts, `${pointer}.attempts.stills`, errors);
      const selected = stillAttempts.filter((attempt) => attempt.status === "selected");
      if (selected.length !== 1 || !slide.poster || selected[0].path !== slide.poster.path || selected[0].sha256 !== slide.poster.sha256) {
        issue(errors, "SELECTED_STILL", `${pointer}.attempts.stills`, "exactly one selected attempt must match poster path and hash");
      }
    }
    if (!Array.isArray(videoAttempts) || videoAttempts.length < 1 || videoAttempts.length > 3) {
      issue(errors, "VIDEO_ATTEMPTS", `${pointer}.attempts.videos`, "must contain 1 through 3 video attempts");
    } else {
      videoAttempts.forEach((attempt, attemptIndex) => validateAttempt(jobDir, attempt, `${pointer}.attempts.videos[${attemptIndex}]`, errors));
      validateAttemptUniqueness(videoAttempts, `${pointer}.attempts.videos`, errors);
      const selected = videoAttempts.filter((attempt) => attempt.status === "selected");
      if (selected.length !== 1 || !slide.video || selected[0].path !== slide.video.path || selected[0].sha256 !== slide.video.sha256) {
        issue(errors, "SELECTED_VIDEO", `${pointer}.attempts.videos`, "exactly one selected attempt must match video path and hash");
      }
    }
    const qa = slide.qa;
    if (!isObject(qa) || qa.passed !== true) {
      issue(errors, "QA_REQUIRED", `${pointer}.qa`, "bound QA must pass");
      return;
    }
    const binding = qa.binding || {};
    if (!slide.poster || binding.posterSha256 !== slide.poster.sha256) issue(errors, "STALE_QA", `${pointer}.qa.binding.posterSha256`, "must bind the selected poster hash");
    if (!slide.video || binding.videoSha256 !== slide.video.sha256) issue(errors, "STALE_QA", `${pointer}.qa.binding.videoSha256`, "must bind the selected video hash");
    if (!model || !model.performanceBible || binding.performanceBibleSha256 !== model.performanceBible.selectedSha256) issue(errors, "STALE_QA", `${pointer}.qa.binding.performanceBibleSha256`, "must bind the selected performance bible hash");
    if (binding.visualPlanSha256 !== currentHashes.visualPlan) issue(errors, "STALE_QA", `${pointer}.qa.binding.visualPlanSha256`, "must bind the current visual plan hash");
    if (!Array.isArray(qa.frames) || qa.frames.length !== 5) {
      issue(errors, "QA_FRAME_COUNT", `${pointer}.qa.frames`, "exactly five frames are required");
    } else {
      const expectedRatios = [0, 0.2, 0.5, 0.8, 1];
      qa.frames.forEach((frame, frameIndex) => {
        validateHashFile(jobDir, frame, `${pointer}.qa.frames[${frameIndex}]`, errors, "png");
        if (Math.abs(frame.timeRatio - expectedRatios[frameIndex]) > 0.001) issue(errors, "QA_FRAME_TIMING", `${pointer}.qa.frames[${frameIndex}].timeRatio`, `expected ${expectedRatios[frameIndex]}`);
      });
    }
    validateHashFile(jobDir, qa.slotComposite, `${pointer}.qa.slotComposite`, errors, "png");
    for (const check of QA_CHECKS) {
      if (!qa.checks || qa.checks[check] !== true) issue(errors, "QA_HARD_GATE", `${pointer}.qa.checks.${check}`, "must be true");
    }
    if (!isDateTime(qa.reviewedAt)) issue(errors, "INVALID_DATE", `${pointer}.qa.reviewedAt`, "must be an ISO date-time");
    if (!poster || !video) issue(errors, "MEDIA_REQUIRED", pointer, "content page must have both a valid poster and video");
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateDeck(deck, content, visual, manifest, layoutsDoc, currentHashes, jobId, errors) {
  validateVersionAndJobId(deck, jobId, "deck", errors);
  if (!isObject(deck)) return;
  const expectedCompiledFrom = {
    contentPlan: currentHashes.contentPlan,
    visualPlan: currentHashes.visualPlan,
    assetManifest: currentHashes.assetManifest,
    layouts: currentHashes.layouts,
  };
  if (!isObject(deck.compiledFrom)) {
    issue(errors, "DECK_COMPILED_FROM", "deck.compiledFrom", "compiled input hashes are required");
  } else {
    for (const [key, hash] of Object.entries(expectedCompiledFrom)) {
      if (deck.compiledFrom[key] !== hash) issue(errors, "STALE_DECK_INPUT", `deck.compiledFrom.${key}`, `expected ${hash}`);
    }
  }
  const typography = visual && visual.brandDirection && visual.brandDirection.typography;
  const expectedFonts = typography && { title: typography.title, body: typography.body, number: typography.number };
  if (!expectedFonts || !sameJson(deck.fonts, expectedFonts)) issue(errors, "DECK_FONTS", "deck.fonts", "must exactly copy visualPlan.brandDirection.typography title/body/number");
  const expectedPalette = visual && visual.brandDirection && visual.brandDirection.deckPalette;
  if (!expectedPalette || !sameJson(deck.palette, expectedPalette)) issue(errors, "DECK_PALETTE", "deck.palette", "must exactly copy visualPlan.brandDirection.deckPalette");
  if (!isObject(deck.media) || deck.media.videoVolume !== 0) issue(errors, "DECK_MEDIA", "deck.media.videoVolume", "must be 0");
  const contentSlides = content && Array.isArray(content.slides) ? content.slides : [];
  if (!Array.isArray(deck.slides) || deck.slides.length !== contentSlides.length) {
    issue(errors, "DECK_SLIDE_COUNT", "deck.slides", `expected ${contentSlides.length} compiled slides`);
    return;
  }
  const visualById = new Map((visual && visual.slides || []).map((slide) => [slide.id, slide]));
  const assetById = new Map((manifest && manifest.slides || []).map((slide) => [slide.id, slide]));
  const sourceById = new Map((content && content.sources || []).map((source) => [source.id, source]));
  contentSlides.forEach((sourceSlide, index) => {
    const compiled = deck.slides[index];
    const pointer = `deck.slides[${index}]`;
    if (!isObject(compiled)) return issue(errors, "DECK_SLIDE", pointer, "must be an object");
    if (compiled.id !== sourceSlide.id) issue(errors, "DECK_SLIDE_ID", `${pointer}.id`, `expected ${sourceSlide.id}`);
    if (compiled.title !== sourceSlide.title || !sameJson(compiled.body, sourceSlide.body)) issue(errors, "DECK_COPY_DRIFT", pointer, "title/body must exactly match content-plan display copy");
    if (compiled.kicker !== sourceSlide.role) issue(errors, "DECK_COPY_DRIFT", `${pointer}.kicker`, "must match content-plan role");
    const expectedSources = (sourceSlide.sourceIds || []).map((id) => sourceById.get(id));
    if (!sameJson(compiled.sources, expectedSources)) issue(errors, "DECK_SOURCE_DRIFT", `${pointer}.sources`, "must exactly resolve content-plan sourceIds");
    if (sourceSlide.videoRequired === true) {
      const visualSlide = visualById.get(sourceSlide.id);
      const assets = assetById.get(sourceSlide.id);
      if (!visualSlide || compiled.layoutId !== visualSlide.layoutId) issue(errors, "DECK_LAYOUT_DRIFT", `${pointer}.layoutId`, "must match visual-plan layoutId");
      if (!assets || compiled.poster !== assets.poster.path || compiled.video !== assets.video.path) issue(errors, "DECK_MEDIA_DRIFT", pointer, "poster/video must exactly match asset-manifest canonical selections");
      if (compiled.videoVolume !== 0) issue(errors, "DECK_MEDIA", `${pointer}.videoVolume`, "dynamic slide videoVolume must be 0");
    } else {
      if (compiled.layoutId !== "title-card") issue(errors, "DECK_LAYOUT_DRIFT", `${pointer}.layoutId`, "static cover/section must use title-card");
      if (Object.hasOwn(compiled, "poster") || Object.hasOwn(compiled, "video")) issue(errors, "DECK_MEDIA_DRIFT", pointer, "static slide must not contain poster/video");
    }
    if (!layoutsDoc || !layoutsDoc.layouts || !layoutsDoc.layouts[compiled.layoutId]) issue(errors, "DECK_LAYOUT_DRIFT", `${pointer}.layoutId`, "unknown layoutId");
  });
}

function validateJobShape(job, errors) {
  if (!isObject(job)) return issue(errors, "INVALID_JOB", "job", "job.json must be an object");
  if (job.schemaVersion !== SCHEMA_VERSION) issue(errors, "SCHEMA_VERSION", "job.schemaVersion", `expected ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(job.jobId) || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(job.jobId)) issue(errors, "JOB_ID", "job.jobId", "must be a lowercase slug");
  if (!isObject(job.state) || !STAGES.includes(job.state.stage)) issue(errors, "JOB_STAGE", "job.state.stage", "unknown stage");
  if (!job.state || !["active", "blocked", "failed", "complete"].includes(job.state.status)) issue(errors, "JOB_STATUS", "job.state.status", "unknown status");
  if (!job.state || !Array.isArray(job.state.completedStages)) issue(errors, "JOB_STATE", "job.state.completedStages", "must be an array");
  if (!job.state || !Array.isArray(job.state.invalidatedStages)) issue(errors, "JOB_STATE", "job.state.invalidatedStages", "must be an array");
  if (!job.state || !Array.isArray(job.state.history)) issue(errors, "JOB_STATE", "job.state.history", "must be an array");
  if (!isObject(job.artifacts)) issue(errors, "JOB_ARTIFACTS", "job.artifacts", "must be an object");
  for (const [key, expectedPath] of Object.entries(CONTRACT_FILES)) {
    if (!job.artifacts || job.artifacts[key] !== expectedPath) issue(errors, "JOB_ARTIFACTS", `job.artifacts.${key}`, `must be ${expectedPath}`);
  }
  if (!isObject(job.trackedArtifacts)) issue(errors, "TRACKED_ARTIFACTS", "job.trackedArtifacts", "must be an object");
  if (!isObject(job.release) || !isObject(job.release.candidate) || !isObject(job.release.final)) issue(errors, "RELEASE_STATE", "job.release", "candidate and final release records are required");
  validateAllDeclaredPaths(job, "job", errors);
}

function currentContractHashes(jobDir, contracts) {
  const hashes = {};
  for (const [key, relativePath] of Object.entries(CONTRACT_FILES)) {
    if (contracts[key]) hashes[key] = sha256File(resolveJobPath(jobDir, relativePath, { mustExist: true }));
  }
  hashes.layouts = sha256File(LAYOUTS_PATH);
  return hashes;
}

function validateTrackedArtifacts(jobDir, job, currentHashes, errors, strict) {
  const tracked = isObject(job.trackedArtifacts) ? job.trackedArtifacts : {};
  if (strict) {
    for (const key of Object.keys(CONTRACT_FILES)) {
      if (!tracked[key]) issue(errors, "UNTRACKED_ARTIFACT", `job.trackedArtifacts.${key}`, "strict release requires a recorded artifact hash");
    }
  }
  for (const [key, record] of Object.entries(tracked)) {
    if (!isObject(record) || !isSafeRelativePath(record.path) || !validHash(record.sha256) || !STAGES.includes(record.stage)) {
      issue(errors, "TRACKED_ARTIFACT", `job.trackedArtifacts.${key}`, "invalid tracked artifact record");
      continue;
    }
    let actual;
    try {
      actual = sha256File(resolveJobPath(jobDir, record.path, { mustExist: true }));
    } catch (error) {
      issue(errors, "STALE_ARTIFACT", `job.trackedArtifacts.${key}`, error.message);
      continue;
    }
    if (actual !== record.sha256) issue(errors, "STALE_ARTIFACT", `job.trackedArtifacts.${key}.sha256`, `declared ${record.sha256}, actual ${actual}`);
    if (currentHashes[key] && actual !== currentHashes[key]) issue(errors, "STALE_ARTIFACT", `job.trackedArtifacts.${key}.sha256`, "does not match current contract hash");
  }
}

function validateStageState(job, errors) {
  if (!isObject(job.state) || !STAGES.includes(job.state.stage) || !Array.isArray(job.state.completedStages)) return;
  const currentIndex = STAGES.indexOf(job.state.stage);
  const completed = job.state.completedStages;
  const unique = new Set(completed);
  if (unique.size !== completed.length) issue(errors, "STAGE_HISTORY", "job.state.completedStages", "must not contain duplicates");
  for (const stage of completed) {
    if (!STAGES.includes(stage) || STAGES.indexOf(stage) > currentIndex) issue(errors, "STAGE_HISTORY", "job.state.completedStages", `${stage} cannot be complete at ${job.state.stage}`);
  }
  for (let index = 1; index <= currentIndex; index += 1) {
    if (!unique.has(STAGES[index])) issue(errors, "STAGE_HISTORY", "job.state.completedStages", `missing completed stage ${STAGES[index]}`);
  }
  if (currentIndex >= STAGES.indexOf("candidate-released") && (!job.release || !job.release.candidate || job.release.candidate.status !== "released")) {
    issue(errors, "RELEASE_STATE", "job.release.candidate.status", "candidate-released stage requires released candidate state");
  }
  if (currentIndex >= STAGES.indexOf("final-released") && (!job.release || !job.release.final || job.release.final.status !== "released")) {
    issue(errors, "RELEASE_STATE", "job.release.final.status", "final-released stage requires released final state");
  }
  if (job.state.stage === "final-released" && job.state.status !== "complete") issue(errors, "JOB_STATUS", "job.state.status", "final-released job must be complete");
}

function validateRenderQa(jobDir, renderQa, artifactAsset, slideCount, expectedIndexPath, expectedArtifactPath, pointer, errors) {
  if (!isObject(renderQa) || renderQa.passed !== true) {
    issue(errors, "RENDER_QA", pointer, "passing true-render QA bound to the PPTX is required");
    return;
  }
  if (artifactAsset && renderQa.artifactSha256 !== artifactAsset.actualHash) {
    issue(errors, "STALE_RENDER_QA", `${pointer}.artifactSha256`, "must bind the inspected PPTX artifact hash");
  }
  if (renderQa.slideCount !== slideCount) {
    issue(errors, "RENDER_SLIDE_COUNT", `${pointer}.slideCount`, `expected ${slideCount}`);
  }
  if (renderQa.renderIndexPath !== expectedIndexPath) {
    issue(errors, "RENDER_INDEX", `${pointer}.renderIndexPath`, `expected ${expectedIndexPath}`);
  }
  const indexAsset = validateHashFile(
    jobDir,
    { path: renderQa.renderIndexPath, sha256: renderQa.renderIndexSha256 },
    `${pointer}.renderIndex`,
    errors,
  );
  if (indexAsset) {
    try {
      const index = loadJson(indexAsset.filePath);
      const legacyIndex = index.version === 1 && index.producer === "ppt-cast/render-pptx-qa@1";
      const receiptIndex = index.version === 2 && index.producer === "ppt-cast/render-pptx-qa@2";
      if (!legacyIndex && !receiptIndex) {
        issue(errors, "RENDER_INDEX", `${pointer}.renderIndex`, "must be produced by a supported ppt-cast/render-pptx-qa producer");
      }
      if (index.artifactPath !== expectedArtifactPath || index.artifactSha256 !== renderQa.artifactSha256) {
        issue(errors, "STALE_RENDER_INDEX", `${pointer}.renderIndex`, "must bind the exact staging PPTX path and hash");
      }
      if (index.slideCount !== renderQa.slideCount || index.overflowPassed !== true) {
        issue(errors, "RENDER_INDEX", `${pointer}.renderIndex`, "slide count and overflow result must match render QA");
      }
      if (!sameJson(index.renderedSlides, renderQa.renderedSlides)) {
        issue(errors, "STALE_RENDER_INDEX", `${pointer}.renderedSlides`, "must exactly copy the bound render index descriptors");
      }
      if (legacyIndex) {
        if (path.basename(String(index.renderer || "")) !== "render_slides.py" || path.basename(String(index.slidesTest || "")) !== "slides_test.py") {
          issue(errors, "RENDER_INDEX", `${pointer}.renderIndex`, "must record the target presentation renderer and overflow checker");
        }
      } else if (receiptIndex) {
        for (const [key, expectedName] of [["renderer", "render_slides.py"], ["slidesTest", "slides_test.py"]]) {
          const receipt = index[key];
          if (!isObject(receipt) || path.basename(String(receipt.name || "")) !== expectedName || !validHash(receipt.sha256)) {
            issue(errors, "RENDER_IMPLEMENTATION_RECEIPT", `${pointer}.renderIndex.${key}`, `must bind ${expectedName} by name and SHA-256`);
          }
        }
        if (!validHash(index.producerSha256) || !isObject(index.runtime) || !isObject(index.runtime.python) || !isNonEmptyString(index.runtime.python.version)) {
          issue(errors, "RENDER_RUNTIME_RECEIPT", `${pointer}.renderIndex`, "v2 render evidence must bind the producer and Python runtime");
        }
      }
    } catch (error) {
      issue(errors, "RENDER_INDEX", `${pointer}.renderIndex`, `invalid render index JSON: ${error.message}`);
    }
  }
  if (!Array.isArray(renderQa.renderedSlides) || renderQa.renderedSlides.length !== slideCount) {
    issue(errors, "RENDER_PIXEL_EVIDENCE", `${pointer}.renderedSlides`, `expected ${slideCount} rendered slide PNGs`);
  } else {
    const pageNumbers = new Set();
    renderQa.renderedSlides.forEach((rendered, index) => {
      const renderedPointer = `${pointer}.renderedSlides[${index}]`;
      validateHashFile(jobDir, rendered, renderedPointer, errors, "png");
      if (!Number.isInteger(rendered.slideNumber) || rendered.slideNumber < 1 || rendered.slideNumber > slideCount || pageNumbers.has(rendered.slideNumber)) {
        issue(errors, "RENDER_PIXEL_EVIDENCE", `${renderedPointer}.slideNumber`, "slide numbers must cover 1..N exactly once");
      }
      pageNumbers.add(rendered.slideNumber);
      if (rendered.mime !== "image/png") issue(errors, "RENDER_PIXEL_EVIDENCE", `${renderedPointer}.mime`, "must be image/png");
    });
    for (let number = 1; number <= slideCount; number += 1) {
      if (!pageNumbers.has(number)) issue(errors, "RENDER_PIXEL_EVIDENCE", `${pointer}.renderedSlides`, `missing slide ${number}`);
    }
  }
  for (const key of ["allSlidesInspected", "overflowPassed", "textWrapPassed", "cropPassed", "mediaPosterPassed", "layoutRhythmPassed", "passed"]) {
    if (renderQa[key] !== true) issue(errors, "RENDER_QA", `${pointer}.${key}`, "must be true");
  }
  validateHashFile(jobDir, { path: renderQa.evidencePath, sha256: renderQa.evidenceSha256 }, `${pointer}.evidence`, errors);
}

function validatePptxRelease(jobDir, job, content, currentHashes, level, errors) {
  const contentPageCount = (content && content.slides || []).filter((slide) => slide.videoRequired === true).length;
  const slideCount = (content && content.slides || []).length;
  const candidate = job.release.candidate;
  if (!isObject(candidate)) return;
  if (!["none", "released"].includes(candidate.status)) issue(errors, "CANDIDATE_SEMANTICS", "job.release.candidate.status", "must be none or released");
  if (candidate.status === "released" && !isDateTime(candidate.validatedAt)) issue(errors, "CANDIDATE_SEMANTICS", "job.release.candidate.validatedAt", "released candidate needs validatedAt");
  if (candidate.playbackVerified !== false) issue(errors, "CANDIDATE_SEMANTICS", "job.release.candidate.playbackVerified", "candidate must explicitly remain unverified in PowerPoint");
  const expectedCandidatePath = candidate.status === "released" ? "candidate.pptx" : "build/candidate.staging.pptx";
  if (candidate.artifact !== expectedCandidatePath) issue(errors, "CANDIDATE_NAME", "job.release.candidate.artifact", `expected ${expectedCandidatePath}`);
  const candidateAsset = validateHashFile(jobDir, { path: candidate.artifact, sha256: candidate.sha256 }, "job.release.candidate", errors, "pptx");
  const packageQa = candidate.packageQa;
  if (!isObject(packageQa) || packageQa.passed !== true) {
    issue(errors, "PACKAGE_QA", "job.release.candidate.packageQa", "passing package QA is required");
  } else {
    if (candidateAsset && packageQa.artifactSha256 !== candidateAsset.actualHash) issue(errors, "STALE_PACKAGE_QA", "job.release.candidate.packageQa.artifactSha256", "must bind the candidate artifact hash");
    if (packageQa.deckSha256 !== currentHashes.deck || packageQa.deckSha256 !== (job.trackedArtifacts.deck && job.trackedArtifacts.deck.sha256)) issue(errors, "STALE_PACKAGE_QA", "job.release.candidate.packageQa.deckSha256", "must bind the current tracked deck hash");
    for (const key of ["expectedContentPages", "embeddedVideoCount", "posterCount", "timingCount"]) {
      if (packageQa[key] !== contentPageCount) issue(errors, "PACKAGE_MEDIA_COUNT", `job.release.candidate.packageQa.${key}`, `expected ${contentPageCount}`);
    }
    for (const key of ["relationshipsValid", "mimeTypesValid", "aspectRatiosValid", "passed"]) {
      if (packageQa[key] !== true) issue(errors, "PACKAGE_QA", `job.release.candidate.packageQa.${key}`, "must be true");
    }
    validateHashFile(jobDir, { path: packageQa.evidencePath, sha256: packageQa.evidenceSha256 }, "job.release.candidate.packageQa.evidence", errors);
  }
  validateRenderQa(
    jobDir,
    candidate.renderQa,
    candidateAsset,
    slideCount,
    "qa/rendered-candidate/render-index.json",
    "build/candidate.staging.pptx",
    "job.release.candidate.renderQa",
    errors,
  );
  if (level !== "final") return;
  if (candidate.status !== "released") issue(errors, "FINAL_REQUIRES_CANDIDATE", "job.release.candidate.status", "candidate must be released first");
  const finalRecord = job.release.final;
  if (!isObject(finalRecord)) return;
  if (!["none", "released"].includes(finalRecord.status)) issue(errors, "FINAL_SEMANTICS", "job.release.final.status", "must be none or released");
  if (finalRecord.status === "released" && !isDateTime(finalRecord.validatedAt)) issue(errors, "FINAL_SEMANTICS", "job.release.final.validatedAt", "released final needs validatedAt");
  const expectedFinalPath = finalRecord.status === "released" ? "final.pptx" : "build/final.staging.pptx";
  if (finalRecord.artifact !== expectedFinalPath) issue(errors, "FINAL_NAME", "job.release.final.artifact", `expected ${expectedFinalPath}`);
  const finalAsset = validateHashFile(jobDir, { path: finalRecord.artifact, sha256: finalRecord.sha256 }, "job.release.final", errors, "pptx");
  const finalPackageQa = finalRecord.packageQa;
  if (!isObject(finalPackageQa) || finalPackageQa.passed !== true) {
    issue(errors, "FINAL_PACKAGE_QA", "job.release.final.packageQa", "passing package QA bound to final.pptx is required");
  } else {
    if (finalAsset && finalPackageQa.artifactSha256 !== finalAsset.actualHash) issue(errors, "STALE_FINAL_PACKAGE_QA", "job.release.final.packageQa.artifactSha256", "must bind the final artifact hash");
    if (finalPackageQa.deckSha256 !== currentHashes.deck || finalPackageQa.deckSha256 !== (job.trackedArtifacts.deck && job.trackedArtifacts.deck.sha256)) issue(errors, "STALE_FINAL_PACKAGE_QA", "job.release.final.packageQa.deckSha256", "must bind the current tracked deck hash");
    for (const key of ["expectedContentPages", "embeddedVideoCount", "posterCount", "timingCount"]) {
      if (finalPackageQa[key] !== contentPageCount) issue(errors, "FINAL_PACKAGE_MEDIA_COUNT", `job.release.final.packageQa.${key}`, `expected ${contentPageCount}`);
    }
    for (const key of ["relationshipsValid", "mimeTypesValid", "aspectRatiosValid", "passed"]) {
      if (finalPackageQa[key] !== true) issue(errors, "FINAL_PACKAGE_QA", `job.release.final.packageQa.${key}`, "must be true");
    }
    validateHashFile(jobDir, { path: finalPackageQa.evidencePath, sha256: finalPackageQa.evidenceSha256 }, "job.release.final.packageQa.evidence", errors);
  }
  validateRenderQa(
    jobDir,
    finalRecord.renderQa,
    finalAsset,
    slideCount,
    "qa/rendered-final/render-index.json",
    "build/final.staging.pptx",
    "job.release.final.renderQa",
    errors,
  );
  const verification = finalRecord.powerPointVerification;
  if (!isObject(verification) || verification.passed !== true) {
    issue(errors, "POWERPOINT_VERIFICATION", "job.release.final.powerPointVerification", "final requires real PowerPoint playback verification");
    return;
  }
  if (!["macos", "windows"].includes(verification.platform) || !isNonEmptyString(verification.appVersion) || !isDateTime(verification.testedAt)) {
    issue(errors, "POWERPOINT_VERIFICATION", "job.release.final.powerPointVerification", "platform, appVersion, and testedAt are required");
  }
  for (const key of ["autoPlayOnce", "noLoop", "manualAdvance", "passed"]) {
    if (verification[key] !== true) issue(errors, "POWERPOINT_VERIFICATION", `job.release.final.powerPointVerification.${key}`, "must be true");
  }
  if (finalAsset && verification.artifactSha256 !== finalAsset.actualHash) issue(errors, "STALE_POWERPOINT_VERIFICATION", "job.release.final.powerPointVerification.artifactSha256", "must bind the tested final.pptx hash");
  if (typeof verification.capturePath !== "string" || !verification.capturePath.endsWith(".mp4")) issue(errors, "POWERPOINT_CAPTURE", "job.release.final.powerPointVerification.capturePath", "must be an .mp4 capture");
  const captureAsset = validateHashFile(jobDir, { path: verification.capturePath, sha256: verification.captureSha256 }, "job.release.final.powerPointVerification.capture", errors, "mp4");
  if (captureAsset) {
    try {
      const info = probe(captureAsset.filePath);
      const stream = (info.streams || []).find((item) => item.codec_type === "video");
      const fps = stream ? Math.max(parseRate(stream.avg_frame_rate), parseRate(stream.r_frame_rate)) : NaN;
      if (!stream || Number(stream.width) < 1920 || Number(stream.height) < 1080 || !Number.isFinite(fps) || fps < 29) {
        issue(errors, "POWERPOINT_CAPTURE", "job.release.final.powerPointVerification.capture", "capture must contain decodable video at 1920x1080 or higher and at least 29 fps");
      }
    } catch (error) {
      issue(errors, "POWERPOINT_CAPTURE", "job.release.final.powerPointVerification.capture", `capture probe failed: ${error.message}`);
    }
  }
  const expectedTestedIds = (content && content.slides || []).filter((slide) => slide.videoRequired === true).map((slide) => slide.id).sort();
  const actualTestedIds = Array.isArray(verification.testedSlideIds) ? [...verification.testedSlideIds].sort() : [];
  if (!sameJson(actualTestedIds, expectedTestedIds)) issue(errors, "POWERPOINT_SLIDE_COVERAGE", "job.release.final.powerPointVerification.testedSlideIds", "must cover every dynamic slide ID exactly once");
  validateHashFile(jobDir, { path: verification.evidencePath, sha256: verification.evidenceSha256 }, "job.release.final.powerPointVerification.evidence", errors);
}

function validateJob(jobDir, options = {}) {
  const root = path.resolve(jobDir);
  const errors = [];
  const warnings = [];
  let job = options.jobOverride || null;
  if (!job) {
    const jobPath = path.join(root, "job.json");
    if (!fs.existsSync(jobPath)) {
      issue(errors, "MISSING_JOB", "job", "missing job.json");
      return { ok: false, errors, warnings, stage: null, currentHashes: {} };
    }
    try {
      job = loadJson(jobPath);
    } catch (error) {
      issue(errors, "INVALID_JSON", "job", error.message);
      return { ok: false, errors, warnings, stage: null, currentHashes: {} };
    }
  }
  validateSchema(job, "job", "job", errors);
  validateJobShape(job, errors);
  validateStageState(job, errors);
  let layoutsDoc = null;
  try {
    layoutsDoc = loadJson(LAYOUTS_PATH);
  } catch (error) {
    issue(errors, "LAYOUTS_CONTRACT", "references/layouts.json", `fixed layout contract cannot be read: ${error.message}`);
  }
  const actualStage = STAGES.includes(job.state && job.state.stage) ? job.state.stage : "initialized";
  const throughStage = options.throughStage && STAGES.includes(options.throughStage) ? options.throughStage : actualStage;
  const stageIndex = Math.max(STAGES.indexOf(actualStage), STAGES.indexOf(throughStage));
  const strict = options.releaseLevel === "candidate" || options.releaseLevel === "final";
  const contracts = {};
  for (const [key, relativePath] of Object.entries(CONTRACT_FILES)) {
    const required = stageIndex >= STAGES.indexOf(CONTRACT_STAGE[key]) || strict;
    contracts[key] = required ? loadJsonContract(root, relativePath, key, errors, true) : null;
    if (contracts[key]) {
      validateSchema(contracts[key], key, key, errors);
      validateVersionAndJobId(contracts[key], job.jobId, key, errors);
      validateAllDeclaredPaths(contracts[key], key, errors);
    }
  }
  const currentHashes = currentContractHashes(root, contracts);
  if (contracts.brief) validateBrief(root, contracts.brief, job.jobId, errors);
  if (contracts.contentPlan) {
    if (currentHashes.brief) assertUpstream(contracts.contentPlan, { brief: currentHashes.brief }, "contentPlan", errors);
    validateContentPlan(contracts.contentPlan, contracts.brief, job.jobId, errors);
  }
  if (contracts.characterModel) {
    if (currentHashes.brief) assertUpstream(contracts.characterModel, { brief: currentHashes.brief }, "characterModel", errors);
    validateCharacterModel(root, contracts.characterModel, job.jobId, errors);
  }
  if (contracts.visualPlan) {
    const expected = {};
    if (currentHashes.brief) expected.brief = currentHashes.brief;
    if (currentHashes.characterModel) expected.characterModel = currentHashes.characterModel;
    if (currentHashes.contentPlan) expected.contentPlan = currentHashes.contentPlan;
    assertUpstream(contracts.visualPlan, expected, "visualPlan", errors);
    validateVisualPlan(contracts.visualPlan, contracts.contentPlan, contracts.characterModel, layoutsDoc, job.jobId, errors);
  }
  if (contracts.assetManifest) {
    const expected = {};
    if (currentHashes.characterModel) expected.characterModel = currentHashes.characterModel;
    if (currentHashes.contentPlan) expected.contentPlan = currentHashes.contentPlan;
    if (currentHashes.visualPlan) expected.visualPlan = currentHashes.visualPlan;
    assertUpstream(contracts.assetManifest, expected, "assetManifest", errors);
    validateAssetManifest(root, contracts.assetManifest, contracts.contentPlan, contracts.visualPlan, contracts.characterModel, currentHashes, job.jobId, errors);
  }
  if (contracts.deck) validateDeck(contracts.deck, contracts.contentPlan, contracts.visualPlan, contracts.assetManifest, layoutsDoc, currentHashes, job.jobId, errors);
  validateTrackedArtifacts(root, job, currentHashes, errors, strict);
  if (strict) validatePptxRelease(root, job, contracts.contentPlan, currentHashes, options.releaseLevel, errors);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stage: actualStage,
    checkedThrough: throughStage,
    releaseLevel: options.releaseLevel || null,
    currentHashes,
    job,
    contracts,
  };
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
  if (!jobDir) throw new Error("usage: node validate_job.js <job-dir> [--release candidate|final] [--json]");
  if (releaseLevel && !["candidate", "final"].includes(releaseLevel)) throw new Error("--release must be candidate or final");
  return { jobDir, releaseLevel, json };
}

function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const result = validateJob(options.jobDir, { releaseLevel: options.releaseLevel });
  if (options.json) {
    console.log(JSON.stringify(printableResult(result), null, 2));
  } else if (result.ok) {
    console.log(`PASS ${path.resolve(options.jobDir)} (${options.releaseLevel || `through ${result.checkedThrough}`})`);
  } else {
    console.error(`FAIL ${path.resolve(options.jobDir)} (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`);
    for (const error of result.errors) console.error(`- [${error.code}] ${error.path}: ${error.message}`);
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  SCHEMA_VERSION,
  STAGES,
  CONTRACT_FILES,
  CONTRACT_STAGE,
  sha256Buffer,
  sha256File,
  isSafeRelativePath,
  resolveJobPath,
  loadJson,
  validateJob,
  printableResult,
};

if (require.main === module) main();

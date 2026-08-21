#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { COMPOSITIONS, COMPOSITION_IDS_BY_FAMILY, FAMILY_FOR_ROLE } = require("./design_catalog");
const { normalizeMotionPlan } = require("./motion_timing");
const { fitText, resolveTypography, sha256File } = require("./typography");

const SKILL_DIR = path.resolve(__dirname, "..");
const SCHEMA_DIR = path.join(SKILL_DIR, "schemas", "v2");
const STYLE_PACK_DIR = path.join(SKILL_DIR, "references", "presets");
const DEFAULT_OUTPUT = "design-plan.json";
const DATA_LAYER_TYPES = new Set(["metric", "quote", "chart", "table", "timeline", "process"]);
const ASSET_LAYER_TYPES = new Set(["image", "logo", "uiScreenshot"]);
const TEXT_LAYER_TYPES = new Set(["headline", "body", "metric", "quote", "chart", "table", "timeline", "process", "annotation"]);
const PRIMARY_TYPE_FOR_ROLE = Object.freeze({
  metric: "metric",
  timeline: "timeline",
  process: "process",
  quote: "quote",
  "product-ui": "uiScreenshot",
  chart: "chart",
  table: "table",
});
const Z_BASE = Object.freeze({
  video: 10,
  image: 20,
  uiScreenshot: 22,
  chart: 30,
  table: 31,
  timeline: 32,
  process: 33,
  metric: 40,
  quote: 42,
  body: 70,
  headline: 80,
  annotation: 90,
  logo: 100,
});
const ALLOWED_INTENT_KEYS = Object.freeze({
  video: new Set(["type", "key", "poster", "video", "slot"]),
  headline: new Set(["type", "key", "contentRef", "styleToken"]),
  body: new Set(["type", "key", "contentRef", "styleToken"]),
  metric: new Set(["type", "key", "styleToken", "sourceIds", "data"]),
  quote: new Set(["type", "key", "styleToken", "sourceIds", "data"]),
  chart: new Set(["type", "key", "styleToken", "sourceIds", "data"]),
  table: new Set(["type", "key", "styleToken", "sourceIds", "data"]),
  timeline: new Set(["type", "key", "styleToken", "sourceIds", "data"]),
  process: new Set(["type", "key", "styleToken", "sourceIds", "data"]),
  image: new Set(["type", "key", "assetId"]),
  logo: new Set(["type", "key", "assetId"]),
  uiScreenshot: new Set(["type", "key", "assetId"]),
  annotation: new Set(["type", "key", "text", "styleToken", "targetKey"]),
});

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Buffer(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isObject(value)) fail(`${label} must contain a JSON object`);
  return value;
}

function isSafeRelative(value) {
  if (!nonEmpty(value) || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return !parts.some((part) => !part || part === "." || part === "..") && path.posix.normalize(value) === value;
}

function resolveSafeOutput(jobDir, relativePath) {
  if (!isSafeRelative(relativePath)) fail(`--output must be a normalized job-relative path: ${String(relativePath)}`);
  const target = path.resolve(jobDir, ...relativePath.split("/"));
  const relative = path.relative(jobDir, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("--output leaves the job directory");
  return target;
}

function resolveSafeAsset(jobDir, relativePath, label) {
  if (!isSafeRelative(relativePath)) fail(`${label} must be a normalized job-relative path`);
  const target = path.resolve(jobDir, ...relativePath.split("/"));
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) fail(`${label} not found: ${relativePath}`);
  const realRoot = fs.realpathSync(jobDir);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(realRoot, realTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${label} resolves outside the job directory`);
  return realTarget;
}

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, fontDirectories: [] };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--output" || arg === "--font-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      if (arg === "--output") options.output = value;
      else options.fontDirectories.push(path.resolve(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--font-dir=")) {
      options.fontDirectories.push(path.resolve(arg.slice("--font-dir=".length)));
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  if (positional.length !== 1) {
    fail("usage: node compile_design.js <job-dir> [--output design-plan.json] [--font-dir directory]");
  }
  return { jobDir: path.resolve(positional[0]), ...options };
}

function schemaValidators() {
  let Ajv2020;
  let addFormats;
  try {
    Ajv2020 = require("ajv/dist/2020").default;
    addFormats = require("ajv-formats");
  } catch (error) {
    fail(`v2 schema validation dependencies are missing; run npm ci in ${__dirname}: ${error.message}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const names = ["typography", "content-plan", "visual-plan", "design-plan"];
  const schemas = Object.fromEntries(names.map((name) => [name, readJson(path.join(SCHEMA_DIR, `${name}.schema.json`), `${name} schema`)]));
  names.forEach((name) => ajv.addSchema(schemas[name]));
  return Object.fromEntries(names.map((name) => [name, ajv.getSchema(schemas[name].$id)]));
}

function formatValidationErrors(label, errors) {
  return `${label} failed v2 schema validation:\n- ${errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("\n- ")}`;
}

function validateSchema(validator, value, label) {
  if (!validator(value)) fail(formatValidationErrors(label, validator.errors || []));
}

function validateUniqueIds(items, label) {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) fail(`${label}[${index}] duplicates id ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function validateSources(contentPlan) {
  const sourceById = new Map();
  for (const [index, source] of contentPlan.sources.entries()) {
    if (sourceById.has(source.id)) fail(`content-plan.json sources[${index}] duplicates id ${source.id}`);
    sourceById.set(source.id, source);
  }
  for (const [index, slide] of contentPlan.slides.entries()) {
    for (const sourceId of slide.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) fail(`content-plan.json slides[${index}] references unknown source ${sourceId}`);
      if (!source.supports.includes(slide.id)) fail(`source ${sourceId} does not declare support for slide ${slide.id}`);
    }
    if (slide.videoRequired) {
      const bases = new Set(slide.sourceIds.map((id) => {
        const kind = sourceById.get(id).kind;
        return kind === "public-url" ? "public-source" : kind;
      }));
      const expected = bases.size > 1 ? "mixed" : [...bases][0];
      if (slide.evidenceBasis !== expected) fail(`slide ${slide.id}.evidenceBasis must be ${expected} for its selected sources`);
    }
  }
  return sourceById;
}

function validateStructuredData(intent, label) {
  if (intent.type === "chart") {
    const expected = intent.data.categories.length;
    intent.data.series.forEach((series, index) => {
      if (series.values.length !== expected) fail(`${label}.data.series[${index}].values must match categories length ${expected}`);
    });
  }
  if (intent.type === "table") {
    const expected = intent.data.columns.length;
    intent.data.rows.forEach((row, index) => {
      if (row.length !== expected) fail(`${label}.data.rows[${index}] must match columns length ${expected}`);
    });
  }
}

function validateIntent(intent, slide, sourceById, assetById, label) {
  const allowed = ALLOWED_INTENT_KEYS[intent.type];
  if (!allowed) fail(`${label}.type is unsupported: ${String(intent.type)}`);
  const extra = Object.keys(intent).filter((key) => !allowed.has(key));
  if (extra.length) fail(`${label} has fields not allowed for ${intent.type}: ${extra.join(", ")}`);
  if (intent.type === "headline" && intent.contentRef !== "title") fail(`${label}.contentRef must be title`);
  if (intent.type === "body" && intent.contentRef !== "body") fail(`${label}.contentRef must be body`);
  if (intent.type === "video") {
    const [aspectW, aspectH] = intent.slot.aspect.split(":").map(Number);
    if (intent.slot.widthPx * aspectH !== intent.slot.heightPx * aspectW) {
      fail(`${label}.slot dimensions must exactly match its ${intent.slot.aspect} aspect`);
    }
    for (const key of ["poster", "video"]) {
      if (intent[key] !== null && intent[key] !== undefined && !isSafeRelative(intent[key])) {
        fail(`${label}.${key} must be null or a normalized job-relative path`);
      }
    }
  }
  if (DATA_LAYER_TYPES.has(intent.type)) {
    for (const sourceId of intent.sourceIds) {
      if (!sourceById.has(sourceId)) fail(`${label}.sourceIds references unknown source ${sourceId}`);
      if (!slide.sourceIds.includes(sourceId)) fail(`${label}.sourceIds includes ${sourceId}, which is not attached to slide ${slide.id}`);
    }
    validateStructuredData(intent, label);
  }
  if (ASSET_LAYER_TYPES.has(intent.type)) {
    const asset = assetById.get(intent.assetId);
    if (!asset) fail(`${label}.assetId references unregistered asset ${intent.assetId}`);
    if (asset.kind !== intent.type) fail(`${label}.assetId ${intent.assetId} is ${asset.kind}, not ${intent.type}`);
  }
}

function validateCrossContracts(jobDir, contentPlan, visualPlan, hashes) {
  if (contentPlan.planningStatus !== "approved" || visualPlan.planningStatus !== "approved") {
    fail("compile_design requires approved content and visual plans; migrated drafts must be redesigned first");
  }
  if ((contentPlan.migration && contentPlan.migration.needsDesignReplan) || (visualPlan.migration && visualPlan.migration.needsDesignReplan)) {
    fail("migrated v1 drafts cannot compile until migration metadata is removed by an explicit v2 design replan");
  }
  if (contentPlan.jobId !== visualPlan.jobId) fail("content-plan.json and visual-plan.json jobId values must match");
  if (visualPlan.upstreamHashes.contentPlan !== hashes.contentPlan) {
    fail(`visual-plan.json is stale: upstreamHashes.contentPlan must equal ${hashes.contentPlan}`);
  }
  if (contentPlan.upstreamHashes.brief !== hashes.brief) fail("content-plan.json does not bind the current brief.json");
  if (visualPlan.upstreamHashes.brief !== hashes.brief) fail("visual-plan.json does not bind the current brief.json");
  if (visualPlan.upstreamHashes.characterModel !== hashes.characterModel) fail("visual-plan.json does not bind the current character-model.json");
  validateUniqueIds(contentPlan.slides, "content-plan.json slides");
  validateUniqueIds(visualPlan.slides, "visual-plan.json slides");
  const contentIds = contentPlan.slides.map((slide) => slide.id);
  const visualIds = visualPlan.slides.map((slide) => slide.id);
  if (contentIds.length !== visualIds.length || contentIds.some((id, index) => id !== visualIds[index])) {
    fail(`visual-plan.json slide IDs must exactly match content order: [${contentIds.join(", ")}]`);
  }
  const sourceById = validateSources(contentPlan);
  const assetById = new Map();
  for (const [index, asset] of visualPlan.registeredAssets.entries()) {
    if (assetById.has(asset.id)) fail(`visual-plan.json registeredAssets[${index}] duplicates id ${asset.id}`);
    assetById.set(asset.id, asset);
  }
  contentPlan.slides.forEach((contentSlide, index) => {
    const visualSlide = visualPlan.slides[index];
    const dynamic = contentSlide.type === "content" || contentSlide.type === "closing";
    const expectedMode = dynamic ? "hybrid-video" : "static-native";
    if (visualSlide.mediaMode !== expectedMode) {
      fail(`slide ${contentSlide.id} mediaMode must be ${expectedMode} for ${contentSlide.type}`);
    }
    if (contentSlide.videoRequired !== dynamic) fail(`slide ${contentSlide.id}.videoRequired conflicts with its type`);
    if (dynamic && (!isObject(visualSlide.motionPlan) || !isObject(visualSlide.mediaBudget))) {
      fail(`slide ${contentSlide.id} hybrid-video requires motionPlan and mediaBudget`);
    }
    if (!dynamic && (visualSlide.motionPlan !== null || visualSlide.mediaBudget !== null)) {
      fail(`slide ${contentSlide.id} static-native requires null motionPlan and mediaBudget`);
    }
    const keys = new Set();
    visualSlide.layerIntents.forEach((intent, intentIndex) => {
      const label = `visual-plan.json slide ${contentSlide.id} layerIntents[${intentIndex}]`;
      validateIntent(intent, contentSlide, sourceById, assetById, label);
      if (intent.key) {
        if (keys.has(intent.key)) fail(`${label}.key duplicates ${intent.key}`);
        keys.add(intent.key);
      }
    });
    const videoCount = visualSlide.layerIntents.filter((intent) => intent.type === "video").length;
    if (videoCount > 1) fail(`slide ${contentSlide.id} cannot declare more than one video layer intent`);
    if (!dynamic && videoCount) fail(`slide ${contentSlide.id} static-native cannot contain a video layer intent`);
    for (const type of ["headline", "body"]) {
      if (visualSlide.layerIntents.filter((intent) => intent.type === type).length > 1) {
        fail(`slide ${contentSlide.id} cannot declare more than one ${type} layer intent`);
      }
    }
    const requiredPrimary = PRIMARY_TYPE_FOR_ROLE[contentSlide.pageRole];
    if (requiredPrimary && !visualSlide.layerIntents.some((intent) => intent.type === requiredPrimary)) {
      fail(`slide ${contentSlide.id} pageRole ${contentSlide.pageRole} requires a ${requiredPrimary} layer intent`);
    }
  });
  for (const asset of visualPlan.registeredAssets) {
    const used = visualPlan.slides.some((slide) => slide.layerIntents.some((intent) => intent.assetId === asset.id));
    if (!used) continue;
    if (!asset.path || !asset.sha256) fail(`registered asset ${asset.id} is used and therefore requires path and sha256`);
    const target = resolveSafeAsset(jobDir, asset.path, `registered asset ${asset.id}.path`);
    const actual = sha256File(target);
    if (actual !== asset.sha256) fail(`registered asset ${asset.id}.sha256 is stale: declared ${asset.sha256}, actual ${actual}`);
  }
  return { sourceById, assetById };
}

function loadStylePack(id) {
  const index = readJson(path.join(STYLE_PACK_DIR, "style-packs.json"), "style pack index");
  const entry = Array.isArray(index.stylePacks) && index.stylePacks.find((item) => item.id === id);
  if (!entry || !isSafeRelative(entry.reference)) fail(`style pack ${id} is not registered`);
  const filePath = path.join(STYLE_PACK_DIR, entry.reference);
  const pack = readJson(filePath, `style pack ${id}`);
  if (pack.stylePackId !== id || !pack.material || !pack.composition || !pack.camera || !pack.motion) {
    fail(`style pack ${id} is incomplete`);
  }
  return {
    id,
    version: 1,
    implementationSha256: sha256File(filePath),
    materials: [pack.material.medium, pack.material.surface],
    compositionPreferences: [...pack.composition.preferredFamilies],
    camera: pack.camera.default,
    motion: pack.motion.cadence,
  };
}

function chooseDensity(contentSlide, visualSlide) {
  if (visualSlide.density !== "auto") {
    return {
      density: visualSlide.density,
      score: null,
      reason: "The approved visual plan explicitly selected density.",
    };
  }
  const textScore = Array.from([contentSlide.title, ...contentSlide.body].join(" ")).length;
  const layerScore = visualSlide.layerIntents.reduce((sum, intent) => sum + (DATA_LAYER_TYPES.has(intent.type) ? 55 : ASSET_LAYER_TYPES.has(intent.type) ? 35 : 12), 0);
  const score = textScore + layerScore;
  return {
    density: score <= 105 ? "sparse" : score <= 220 ? "balanced" : "dense",
    score,
    reason: `Auto density used a deterministic content-and-layer score of ${score}.`,
  };
}

function chooseComposition(contentSlide, visualSlide) {
  const expectedFamily = FAMILY_FOR_ROLE[contentSlide.pageRole];
  const family = visualSlide.composition === "auto" ? expectedFamily : visualSlide.composition;
  if (family !== expectedFamily) {
    fail(`slide ${contentSlide.id} pageRole ${contentSlide.pageRole} requires composition family ${expectedFamily}, not ${family}`);
  }
  const candidates = COMPOSITION_IDS_BY_FAMILY[family] || [];
  if (!candidates.length) fail(`composition family ${family} has no implementation`);
  let selected = candidates[0];
  if (candidates.length > 1) {
    if (visualSlide.negativeSpace === "left") selected = candidates.find((id) => id.endsWith("media-right")) || selected;
    else if (visualSlide.negativeSpace === "right") selected = candidates.find((id) => id.endsWith("media-left")) || selected;
    else if (["locomotion", "push-pull", "large-prop"].includes(visualSlide.actionClass)) selected = candidates.find((id) => id.endsWith("media-left")) || selected;
    else selected = candidates.find((id) => id.endsWith("media-right")) || selected;
  }
  const composition = COMPOSITIONS[selected];
  if (composition.mediaMode !== visualSlide.mediaMode) {
    fail(`composition ${selected} is ${composition.mediaMode}, not ${visualSlide.mediaMode}`);
  }
  return {
    family,
    selected,
    candidates,
    reason: visualSlide.composition === "auto"
      ? `Page role ${contentSlide.pageRole}, negative space ${visualSlide.negativeSpace}, and action ${visualSlide.actionClass} selected this variant.`
      : `The approved ${family} family was resolved to a deterministic ${selected} variant.`,
  };
}

function defaultSlot(box) {
  const ratio = box.w / box.h;
  if (ratio > 1.35) return { aspect: "16:9", widthPx: 1920, heightPx: 1080 };
  if (ratio < 0.85) return { aspect: "9:16", widthPx: 1080, heightPx: 1920 };
  return { aspect: "1:1", widthPx: 1080, heightPx: 1080 };
}

function intentFingerprint(intent) {
  return sha256Buffer(stableStringify(intent)).slice("sha256:".length, "sha256:".length + 10);
}

function createLayerIntents(contentSlide, visualSlide, composition) {
  const intents = visualSlide.layerIntents.map((intent) => ({ ...intent }));
  if (!intents.some((intent) => intent.type === "headline")) {
    intents.push({ type: "headline", key: "primary", contentRef: "title", styleToken: contentSlide.type === "cover" ? "display" : "headline" });
  }
  if (!intents.some((intent) => intent.type === "body")) {
    intents.push({ type: "body", key: "primary", contentRef: "body", styleToken: "body" });
  }
  if (!intents.some((intent) => intent.type === "annotation" && intent.key === "kicker")) {
    intents.push({ type: "annotation", key: "kicker", text: contentSlide.kicker, styleToken: "caption", targetKey: null });
  }
  if (visualSlide.mediaMode === "hybrid-video" && !intents.some((intent) => intent.type === "video")) {
    intents.push({ type: "video", key: "performance", poster: null, video: null, slot: defaultSlot(composition.boxes.video) });
  }
  return intents;
}

function intentText(intent, contentSlide) {
  if (intent.type === "headline" || intent.type === "body") {
    const values = {
      title: contentSlide.title,
      body: contentSlide.body.join("\n"),
      kicker: contentSlide.kicker,
      takeaway: contentSlide.takeaway,
    };
    return values[intent.contentRef];
  }
  if (intent.type === "annotation") return intent.text;
  if (intent.type === "metric") return `${intent.data.value}${intent.data.unit || ""}\n${intent.data.label}`;
  if (intent.type === "quote") return `${intent.data.text}\n${intent.data.attribution}`;
  if (intent.type === "chart") return [intent.data.categories, intent.data.series.map((series) => [series.name, ...series.values])].flat(2).join(" ");
  if (intent.type === "table") return [intent.data.columns, ...intent.data.rows].flat(2).filter((value) => value !== null).join(" ");
  if (intent.type === "timeline") return intent.data.items.flatMap((item) => [item.label, item.detail]).join(" ");
  if (intent.type === "process") return intent.data.steps.flatMap((item) => [item.label, item.detail]).join(" ");
  return null;
}

function defaultStyleToken(type) {
  if (type === "headline") return "headline";
  if (type === "body") return "body";
  if (type === "metric") return "number";
  if (type === "quote") return "subhead";
  if (["chart", "table", "timeline", "process"].includes(type)) return "caption";
  return "caption";
}

function zoneForType(type) {
  if (["video", "headline", "body", "annotation", "logo"].includes(type)) return type;
  return "data";
}

function resolveLayerBoxes(items, composition) {
  const byZone = new Map();
  for (const item of items) {
    const zone = zoneForType(item.intent.type);
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(item);
  }
  for (const [zone, group] of byZone.entries()) {
    const base = composition.boxes[zone] || composition.boxes.data;
    if (!base) fail(`composition ${composition.family} has no ${zone} box`);
    group.sort((left, right) => left.id.localeCompare(right.id, "en"));
    const gap = group.length > 1 ? 0.08 : 0;
    const height = (base.h - gap * (group.length - 1)) / group.length;
    if (height <= 0.15) fail(`composition ${composition.family} cannot fit ${group.length} layers in its ${zone} zone`);
    group.forEach((item, index) => {
      item.box = {
        x: base.x,
        y: Math.round((base.y + index * (height + gap)) * 1000) / 1000,
        w: base.w,
        h: Math.round(height * 1000) / 1000,
      };
    });
  }
}

function resolveLayers(contentSlide, visualSlide, composition, typography, fontResolution) {
  const intents = createLayerIntents(contentSlide, visualSlide, composition);
  const keyed = intents.map((intent) => {
    const suffix = intent.key || intentFingerprint(intent);
    return { intent, id: `${contentSlide.id}.${intent.type}.${suffix}` };
  });
  const duplicateIds = new Set();
  const seenIds = new Set();
  keyed.forEach((item) => {
    if (seenIds.has(item.id)) duplicateIds.add(item.id);
    seenIds.add(item.id);
  });
  if (duplicateIds.size) fail(`slide ${contentSlide.id} produces duplicate stable layer IDs: ${[...duplicateIds].join(", ")}`);
  resolveLayerBoxes(keyed, composition);
  const typeOrdinals = new Map();
  keyed.sort((left, right) => (Z_BASE[left.intent.type] - Z_BASE[right.intent.type]) || left.id.localeCompare(right.id, "en"));
  const layers = [];
  const textFit = [];
  for (const item of keyed) {
    const type = item.intent.type;
    const ordinal = typeOrdinals.get(type) || 0;
    typeOrdinals.set(type, ordinal + 1);
    const layer = { id: item.id, type, z: Z_BASE[type] + ordinal, box: item.box };
    if (type === "video") {
      Object.assign(layer, {
        poster: item.intent.poster ?? null,
        video: item.intent.video ?? null,
        mediaKey: contentSlide.id,
        slot: { ...item.intent.slot },
      });
    } else if (type === "headline" || type === "body") {
      layer.text = intentText(item.intent, contentSlide);
      layer.styleToken = item.intent.styleToken;
    } else if (DATA_LAYER_TYPES.has(type)) {
      layer.data = JSON.parse(JSON.stringify(item.intent.data));
      layer.sourceIds = [...item.intent.sourceIds];
      layer.styleToken = item.intent.styleToken || defaultStyleToken(type);
    } else if (ASSET_LAYER_TYPES.has(type)) {
      layer.assetId = item.intent.assetId;
    } else if (type === "annotation") {
      layer.text = item.intent.text;
      layer.styleToken = item.intent.styleToken;
      layer.targetLayerId = null;
    }
    if (TEXT_LAYER_TYPES.has(type)) {
      const receipt = fitText({
        text: intentText(item.intent, contentSlide),
        box: item.box,
        styleToken: layer.styleToken,
        typography,
        fontResolution,
        layerId: layer.id,
      });
      textFit.push(receipt);
      layer.resolvedStyle = {
        family: fontResolution.tokens[layer.styleToken].resolvedFamily,
        fontSize: receipt.fontSize,
        weight: typography.tokens[layer.styleToken].weight,
        lineHeight: receipt.lineHeight,
        letterSpacing: receipt.letterSpacing,
      };
    }
    layers.push(layer);
  }
  const videos = layers.filter((layer) => layer.type === "video");
  if (visualSlide.mediaMode === "hybrid-video" && videos.length !== 1) {
    fail(`slide ${contentSlide.id} hybrid-video must resolve to exactly one video layer`);
  }
  if (visualSlide.mediaMode === "static-native" && videos.length !== 0) {
    fail(`slide ${contentSlide.id} static-native cannot resolve a video layer`);
  }
  return { layers, textFit };
}

function slideSources(contentSlide, sourceById) {
  return contentSlide.sourceIds.map((id) => ({ ...sourceById.get(id) }));
}

function speakerNotes(slide) {
  return [
    `Page role: ${slide.pageRole}`,
    `Kicker: ${slide.kicker}`,
    `Claim: ${slide.claim}`,
    "Evidence:",
    ...slide.evidence.map((line) => `- ${line}`),
    `Transition: ${slide.transition}`,
    `Takeaway: ${slide.takeaway}`,
  ].join("\n");
}

function decision(stage, selected, reason, candidates, rejected) {
  return { stage, selected, reason, candidates, rejected };
}

function compileDesign({ jobDir, contentPlan, visualPlan, hashes, fontDirectories = [] }) {
  const { sourceById } = validateCrossContracts(jobDir, contentPlan, visualPlan, hashes);
  const stylePack = loadStylePack(visualPlan.stylePack);
  const typography = visualPlan.brandDirection.typography;
  const fontResolution = resolveTypography(typography, { fontDirectories, allowConservative: false });
  if (fontResolution.measurementMethod !== "fontkit-xadvance-v1" || Object.values(fontResolution.tokens).some((receipt) => receipt.precision !== "fontkit")) {
    fail("candidate-ready design compilation requires fontkit precision for every typography token");
  }
  const visualById = new Map(visualPlan.slides.map((slide) => [slide.id, slide]));
  const slides = contentPlan.slides.map((contentSlide) => {
    const visualSlide = visualById.get(contentSlide.id);
    const densityChoice = chooseDensity(contentSlide, visualSlide);
    const compositionChoice = chooseComposition(contentSlide, visualSlide);
    const composition = COMPOSITIONS[compositionChoice.selected];
    const { layers, textFit } = resolveLayers(contentSlide, visualSlide, composition, typography, fontResolution);
    const layerIds = layers.map((layer) => layer.id);
    const videoLayer = layers.find((layer) => layer.type === "video");
    const motionPlan = visualSlide.mediaMode === "hybrid-video"
      ? normalizeMotionPlan(visualSlide.motionPlan, { videoLayerId: videoLayer.id, layerIds })
      : null;
    const mediaBudget = visualSlide.mediaMode === "hybrid-video"
      ? {
          durationSeconds: motionPlan.durationSeconds,
          fps: visualSlide.mediaBudget.fps,
          codec: visualSlide.mediaBudget.codec || "h264",
          pixelFormat: visualSlide.mediaBudget.pixelFormat || "yuv420p",
          muted: visualSlide.mediaBudget.muted !== false,
          maxBytes: visualSlide.mediaBudget.maxBytes || 12582912,
        }
      : undefined;
    const injectedTypes = ["headline", "body", "annotation", ...(visualSlide.mediaMode === "hybrid-video" ? ["video"] : [])]
      .filter((type) => !visualSlide.layerIntents.some((intent) => intent.type === type));
    const decisions = [
      decision(
        "media-boundary",
        visualSlide.mediaMode,
        `${contentSlide.type} pages are contractually ${visualSlide.mediaMode}.`,
        ["static-native", "hybrid-video"],
        [visualSlide.mediaMode === "static-native" ? "hybrid-video" : "static-native"],
      ),
      decision(
        "density",
        densityChoice.density,
        densityChoice.reason,
        ["sparse", "balanced", "dense"],
        ["sparse", "balanced", "dense"].filter((item) => item !== densityChoice.density),
      ),
      decision(
        "composition",
        compositionChoice.selected,
        compositionChoice.reason,
        compositionChoice.candidates,
        compositionChoice.candidates.filter((item) => item !== compositionChoice.selected),
      ),
      decision(
        "layer-resolution",
        `${layers.length} stable layers`,
        injectedTypes.length ? `Injected required layers: ${injectedTypes.join(", ")}.` : "All required layers were explicit.",
        layers.map((layer) => layer.id),
        [],
      ),
      decision(
        "typography",
        fontResolution.measurementMethod,
        "Every textual layer fit at or above its semantic minimum using the resolved font files.",
        Object.values(fontResolution.tokens).map((item) => `${item.resolvedFamily}:${item.sha256}`),
        [],
      ),
    ];
    return {
      id: contentSlide.id,
      type: contentSlide.type,
      pageRole: contentSlide.pageRole,
      mediaMode: visualSlide.mediaMode,
      compositionId: compositionChoice.selected,
      density: densityChoice.density,
      layers,
      speakerNotes: speakerNotes(contentSlide),
      sources: slideSources(contentSlide, sourceById),
      decisionTrace: decisions,
      textFit,
      fontResolution,
      motionPlan,
      ...(mediaBudget ? { mediaBudget } : {}),
    };
  });
  const cover = contentPlan.slides.find((slide) => slide.type === "cover");
  return {
    schemaVersion: "2.0.0",
    artifactKind: "design-plan",
    releaseEligibility: "candidate-ready",
    jobId: contentPlan.jobId,
    title: cover ? cover.title : contentPlan.thesis,
    compiledFrom: {
      brief: hashes.brief,
      characterModel: hashes.characterModel,
      contentPlan: hashes.contentPlan,
      visualPlan: hashes.visualPlan,
    },
    stylePack,
    registeredAssets: visualPlan.registeredAssets.map((asset) => ({ ...asset })),
    slides,
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!fs.existsSync(options.jobDir) || !fs.statSync(options.jobDir).isDirectory()) fail(`job directory not found: ${options.jobDir}`);
  const contentPath = path.join(options.jobDir, "content-plan.json");
  const visualPath = path.join(options.jobDir, "visual-plan.json");
  const briefPath = path.join(options.jobDir, "brief.json");
  const characterPath = path.join(options.jobDir, "character-model.json");
  if (![briefPath, characterPath, contentPath, visualPath].every(fs.existsSync)) fail("job must contain brief.json, character-model.json, content-plan.json, and visual-plan.json");
  const contentPlan = readJson(contentPath, "content-plan.json");
  const visualPlan = readJson(visualPath, "visual-plan.json");
  const validators = schemaValidators();
  validateSchema(validators["content-plan"], contentPlan, "content-plan.json");
  validateSchema(validators["visual-plan"], visualPlan, "visual-plan.json");
  const hashes = {
    brief: sha256File(briefPath),
    characterModel: sha256File(characterPath),
    contentPlan: sha256File(contentPath),
    visualPlan: sha256File(visualPath),
  };
  const designPlan = compileDesign({ ...options, contentPlan, visualPlan, hashes });
  validateSchema(validators["design-plan"], designPlan, "compiled design-plan.json");
  const output = resolveSafeOutput(options.jobDir, options.output);
  atomicWriteJson(output, designPlan);
  process.stdout.write(`${path.relative(options.jobDir, output).split(path.sep).join("/")}\n`);
  return designPlan;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`compile_design: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  chooseComposition,
  chooseDensity,
  compileDesign,
  main,
  parseArgs,
  schemaValidators,
  validateCrossContracts,
};

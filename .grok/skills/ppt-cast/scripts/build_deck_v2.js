#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const PptxGenJS = require("pptxgenjs");

const {
  inspectPoster,
  inspectVideo,
  parseAspect,
  resolveSafeRelative,
} = require("./media_contract");
const { renderLayers } = require("./layer_renderer_v2");
const { mediaDescriptorSetSha256, validateMediaBudget } = require("./media_budget");
const { buildPowerPointTimingTree } = require("./motion_timing");
const { injectAutoplay, sha256, validatePackageBuffer } = require("./pptx_package");
const { verifyHashBoundReceipt } = require("./runtime/hash_bound_receipt");
const { validateEvaluationReceipt } = require("./evaluation_receipt");
const { compileDeck, createValidators: createV2Validators } = require("./compile_deck_v2");
const { validateMediaEvidence } = require("./validate_job_v2");

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function parseArgs(argv) {
  const positional = [];
  const options = { release: "candidate", report: null, experimentalNativeAnimations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--powerpoint-verified") fail("build_deck_v2 only produces candidate bytes; publish final with jobctl_v2 after exact-byte PowerPoint verification");
    else if (arg === "--experimental-native-animations") fail("native appear/fade authoring is not yet materialized into PowerPoint XML and is therefore blocked from candidate builds");
    else if (["--release", "--report"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      if (arg === "--release") options.release = value;
      else options.report = value;
    } else if (arg.startsWith("--release=")) options.release = arg.slice("--release=".length);
    else if (arg.startsWith("--report=")) options.report = arg.slice("--report=".length);
    else fail(`unknown option: ${arg}`);
  }
  if (positional.length !== 2) fail("usage: build_deck_v2.js <job-dir> <out.pptx> [--release candidate] [--report <path>]");
  if (!["candidate", "final"].includes(options.release)) fail("v2 release must be candidate or final");
  if (options.release === "final") fail("build_deck_v2 cannot create final bytes; publish the exact candidate bytes with jobctl_v2 after PowerPoint verification");
  return { jobDir: positional[0], outPath: positional[1], ...options };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} cannot be read as JSON: ${error.message}`);
  }
}

function compileSchema(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(readJson(schemaPath, path.basename(schemaPath)));
}

function assertSchema(value, validator, label) {
  if (validator(value)) return;
  const detail = (validator.errors || []).map((error) => `${label}${error.instancePath || ""}: ${error.message}`).join("\n- ");
  fail(`${label} schema validation failed:\n- ${detail}`);
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveJobOutput(jobDir, requestedPath, options = {}) {
  const label = options.label || "output";
  const extension = String(options.extension || "").toLowerCase();
  if (typeof requestedPath !== "string" || !requestedPath || requestedPath.includes("\0") || requestedPath.includes("\\")) {
    fail(`${label} must be a valid job-local path`);
  }
  if (!extension.startsWith(".") || extension.length < 2) fail(`${label} resolver requires an expected extension`);
  if (path.win32.isAbsolute(requestedPath) && !path.isAbsolute(requestedPath)) fail(`${label} must not use a Windows absolute path`);

  const root = fs.realpathSync(path.resolve(jobDir));
  if (!fs.statSync(root).isDirectory()) fail(`job directory not found: ${root}`);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(root, requestedPath);
  if (path.extname(candidate).toLowerCase() !== extension) fail(`${label} path must end in ${extension}`);

  let ancestor = path.dirname(candidate);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail(`${label} parent cannot be resolved inside the job directory`);
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) fail(`${label} parent must be a directory`);
  const realAncestor = fs.realpathSync(ancestor);
  if (!isInside(root, realAncestor)) fail(`${label} parent resolves outside the job directory`);
  const resolvedCandidate = path.resolve(realAncestor, path.relative(ancestor, candidate));
  if (!isInside(root, resolvedCandidate)) fail(`${label} path resolves outside the job directory`);
  const targetStat = fs.lstatSync(resolvedCandidate, { throwIfNoEntry: false });
  if (targetStat && targetStat.isSymbolicLink()) fail(`${label} path must not be a symbolic link`);
  return resolvedCandidate;
}

function assertDescriptor(jobDir, descriptor, label) {
  if (!descriptor || typeof descriptor.path !== "string" || !/^sha256:[a-f0-9]{64}$/.test(String(descriptor.sha256 || ""))) {
    fail(`${label} must contain a job-relative path and SHA-256`);
  }
  const filePath = resolveSafeRelative(jobDir, descriptor.path, `${label}.path`);
  const actualHash = hashFile(filePath);
  const bytes = fs.statSync(filePath).size;
  if (actualHash !== descriptor.sha256) fail(`${label}.sha256 is stale: declared ${descriptor.sha256}, actual ${actualHash}`);
  if (descriptor.bytes !== undefined && descriptor.bytes !== bytes) fail(`${label}.bytes is stale: declared ${descriptor.bytes}, actual ${bytes}`);
  return { filePath, sha256: actualHash, bytes };
}

function assertSelected(attempts, canonical, label) {
  const selected = (attempts || []).filter((attempt) => attempt && attempt.status === "selected");
  if (selected.length !== 1 || selected[0].path !== canonical.path || selected[0].sha256 !== canonical.sha256) {
    fail(`${label} must have exactly one selected attempt matching the canonical media descriptor`);
  }
}

function normalizedSource(source) {
  if (!source || typeof source !== "object") return null;
  return [source.title || source.id || "Source", source.url, source.publisher, source.kind].filter(Boolean).join(" — ");
}

function speakerNotes(slide) {
  const preface = String(slide.speakerNotes || "").trim().replace(/\n\[Sources\][\s\S]*$/m, "").trim();
  const sources = (slide.sources || []).map(normalizedSource).filter(Boolean);
  return [preface, "[Sources]", ...(sources.length ? sources.map((source) => `- ${source}`) : ["- No external sources declared for this slide."])].filter(Boolean).join("\n");
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, filePath);
  } finally {
    if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function relativeForReport(jobDir, filePath) {
  const relative = path.relative(jobDir, filePath);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : path.basename(filePath);
}

function validateRegisteredAssets(jobDir, designPlan) {
  const assetById = new Map();
  for (const asset of designPlan.registeredAssets || []) {
    if (assetById.has(asset.id)) fail(`duplicate registered asset id: ${asset.id}`);
    const actual = assertDescriptor(jobDir, asset, `registeredAssets.${asset.id}`);
    assetById.set(asset.id, { ...asset, ...actual, path: asset.path });
  }
  return assetById;
}

function receiptFile(jobDir, reference, label) {
  const asset = assertDescriptor(jobDir, reference, label);
  return { asset, value: readJson(asset.filePath, label) };
}

function assertExternalVideoGeneration(receipt, expected, label, options = {}) {
  const producer = receipt && receipt.producer;
  const metadata = receipt && receipt.metadata;
  const outputMp4 = metadata && metadata.outputMp4;
  const canonicalOutput = expected && typeof expected === "object" ? expected : {};
  const outputMatches = outputMp4 && outputMp4.path === canonicalOutput.path && outputMp4.sha256 === canonicalOutput.sha256 && outputMp4.bytes === canonicalOutput.bytes;
  const receiptOutputs = receipt && Array.isArray(receipt.outputs) ? receipt.outputs : [];
  const oneCanonicalOutput = receiptOutputs.length === 1 && receiptOutputs[0].path === canonicalOutput.path && receiptOutputs[0].sha256 === canonicalOutput.sha256 && receiptOutputs[0].bytes === canonicalOutput.bytes;
  const providerMetadata = metadata && metadata.providerMetadata;
  const explicitlySynthetic = providerMetadata && (providerMetadata.syntheticFixture === true || providerMetadata.liveProviderProof === false);
  if (
    !metadata || metadata.contractVersion !== "deckformance.provider-video/1" ||
    metadata.providerClass !== "external-video-generation-model" || typeof metadata.adapterClass !== "string" || !metadata.adapterClass.trim() ||
    metadata.operation !== "generate-video" || !["host", "http", "command", "api"].includes(metadata.transport) ||
    typeof metadata.provider !== "string" || !metadata.provider.trim() || metadata.provider !== (producer && producer.name) ||
    typeof metadata.providerVersion !== "string" || !metadata.providerVersion.trim() || metadata.providerVersion !== (producer && producer.version) ||
    typeof metadata.model !== "string" || !metadata.model.trim() ||
    typeof metadata.requestId !== "string" || !metadata.requestId.trim() ||
    !/^sha256:[a-f0-9]{64}$/.test(String(metadata.promptSha256 || "")) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(metadata.generationRequestSha256 || "")) ||
    metadata.motionPlanSha256 !== options.motionPlanSha256 || metadata.slideId !== options.slideId || metadata.layerId !== options.layerId ||
    !Number.isFinite(metadata.durationMs) || metadata.durationMs < 0 ||
    !(metadata.cost === null || metadata.cost && typeof metadata.cost === "object" && !Array.isArray(metadata.cost)) ||
    metadata.mediaContractValidated !== true ||
    explicitlySynthetic || typeof canonicalOutput.path !== "string" || !canonicalOutput.path.toLowerCase().endsWith(".mp4") || !outputMatches || !oneCanonicalOutput
  ) {
    fail(`${label} must prove external generate-video provenance and bind metadata.outputMp4 to the canonical MP4`);
  }
}

function assertProviderReceipt(jobDir, reference, expected, label, options = {}) {
  const receipt = receiptFile(jobDir, reference, label);
  const verified = verifyHashBoundReceipt(jobDir, receipt.value);
  if (!verified.ok || receipt.value.kind !== "provider") fail(`${label} is not a valid hash-bound provider receipt: ${verified.errors.join("; ")}`);
  const output = expected && typeof expected === "object" ? (receipt.value.outputs || []).find((item) => item.path === expected.path) : null;
  if (!output || output.sha256 !== expected.sha256 || output.bytes !== expected.bytes) fail(`${label} does not bind ${expected && expected.path || "the canonical output"}`);
  if (options.requireExternalVideoGeneration === true) assertExternalVideoGeneration(receipt.value, expected, label, options);
  return { ...receipt, externalVideoGenerationVerified: options.requireExternalVideoGeneration === true };
}

function collectMedia(jobDir, designPlan, manifest, options = {}) {
  const evidenceErrors = [];
  validateMediaEvidence(jobDir, designPlan, manifest, options.characterModel || null, evidenceErrors, {
    ffmpegPath: options.ffmpegPath,
    requireHumanApproval: options.release === "final",
  });
  if (evidenceErrors.length) {
    fail(`v2 media evidence failed:\n- ${evidenceErrors.map((error) => `${error.path}: ${error.message}`).join("\n- ")}`);
  }
  const budgetReceiptFile = receiptFile(jobDir, manifest.mediaBudgetReceipt, "mediaBudgetReceipt");
  const manifestByKey = new Map();
  for (const slide of manifest.slides || []) {
    if (manifestByKey.has(slide.mediaKey)) fail(`duplicate v2 mediaKey ${slide.mediaKey}`);
    manifestByKey.set(slide.mediaKey, slide);
  }
  const mediaByLayer = new Map();
  const budgetDescriptors = [];
  const timingTrees = [];
  const dynamicSlides = designPlan.slides.filter((slide) => slide.mediaMode === "hybrid-video");
  for (const [slideIndex, slide] of designPlan.slides.entries()) {
    const videoLayers = slide.layers.filter((layer) => layer.type === "video");
    if (slide.mediaMode === "static-native") {
      if (videoLayers.length) fail(`slide ${slide.id} static-native mode cannot contain video`);
      continue;
    }
    if (videoLayers.length !== 1) fail(`slide ${slide.id} hybrid-video mode requires exactly one video layer`);
    const layer = videoLayers[0];
    const mediaKey = layer.mediaKey || slide.id;
    const record = manifestByKey.get(mediaKey);
    if (!record || record.id !== slide.id || record.layerId !== layer.id) fail(`slide ${slide.id} media manifest does not bind layer ${layer.id}`);
    if (record.qa && record.qa.passed !== true) fail(`slide ${slide.id} media QA did not pass`);
    const designHash = manifest.upstreamHashes && manifest.upstreamHashes.designPlan;
    if (!record.qa || !record.qa.binding || record.qa.binding.designPlanSha256 !== designHash) fail(`slide ${slide.id} media QA is not bound to the current design plan`);
    if (record.qa.binding.posterSha256 !== record.poster.sha256 || record.qa.binding.videoSha256 !== record.video.sha256) {
      fail(`slide ${slide.id} media QA does not bind canonical poster/video bytes`);
    }
    if (record.qa.binding.mediaBudgetReceiptSha256 !== budgetReceiptFile.asset.sha256) fail(`slide ${slide.id} QA does not bind the media budget receipt`);
    assertSelected(record.attempts && record.attempts.stills, record.poster, `slide ${slide.id} still attempts`);
    assertSelected(record.attempts && record.attempts.videos, record.video, `slide ${slide.id} video attempts`);
    const poster = assertDescriptor(jobDir, record.poster, `slide ${slide.id} poster`);
    const video = assertDescriptor(jobDir, record.video, `slide ${slide.id} video`);
    const posterProvider = assertProviderReceipt(jobDir, record.providerReceipts.poster, record.poster, `slide ${slide.id} poster provider receipt`);
    const videoProvider = assertProviderReceipt(
      jobDir,
      record.providerReceipts.video,
      record.video,
      `slide ${slide.id} video provider receipt`,
      {
        requireExternalVideoGeneration: true,
        motionPlanSha256: slide.motionPlan && slide.motionPlan.planSha256,
        slideId: slide.id,
        layerId: layer.id,
      },
    );
    if (record.qa.binding.posterProviderReceiptSha256 !== posterProvider.asset.sha256 || record.qa.binding.videoProviderReceiptSha256 !== videoProvider.asset.sha256) {
      fail(`slide ${slide.id} QA does not bind provider receipts`);
    }
    const aspect = parseAspect(layer.slot && layer.slot.aspect);
    if (!aspect) fail(`slide ${slide.id} video layer needs a valid slot aspect`);
    const posterInfo = inspectPoster(poster.filePath, aspect);
    const videoInfo = inspectVideo(video.filePath, aspect);
    const errors = [...posterInfo.errors, ...videoInfo.errors];
    if (errors.length) fail(`slide ${slide.id} media preflight failed:\n- ${errors.join("\n- ")}`);
    if (record.poster.width !== posterInfo.width || record.poster.height !== posterInfo.height) fail(`slide ${slide.id} poster dimensions are stale`);
    if (record.video.width !== videoInfo.width || record.video.height !== videoInfo.height) fail(`slide ${slide.id} video dimensions are stale`);
    if (Math.abs(Number(record.video.fps) - videoInfo.fps) > 0.05) fail(`slide ${slide.id} declared fps ${record.video.fps} does not match actual ${videoInfo.fps}`);
    if (slide.motionPlan && Math.abs(Number(slide.motionPlan.durationSeconds) - videoInfo.duration) > 0.3) {
      fail(`slide ${slide.id} video duration ${videoInfo.duration}s does not match motion plan ${slide.motionPlan.durationSeconds}s`);
    }
    if (!slide.motionPlan || slide.motionPlan.targetLayerId !== layer.id) fail(`slide ${slide.id} motion plan must target ${layer.id}`);
    const nonVideoBeats = (slide.motionPlan.beats || []).filter((beat) => beat.targetLayerId !== layer.id);
    if (nonVideoBeats.length && !options.experimentalNativeAnimations) fail(`slide ${slide.id} native appear/fade beats require the experimental flag`);
    const timingTree = buildPowerPointTimingTree(slide.motionPlan);
    timingTrees.push({ slideId: slide.id, layerId: layer.id, ...timingTree });
    mediaByLayer.set(layer.id, {
      posterPath: poster.filePath,
      videoPath: video.filePath,
      posterSha256: poster.sha256,
      videoSha256: video.sha256,
      durationMs: Math.round(videoInfo.duration * 1000),
      externalGenerationVerified: videoProvider.externalVideoGenerationVerified === true,
    });
    budgetDescriptors.push({
      slideId: slide.id,
      layerId: layer.id,
      sha256: video.sha256,
      bytes: video.bytes,
      durationSeconds: videoInfo.duration,
      fps: record.video.fps,
      codec: videoInfo.codec,
      pixelFormat: videoInfo.pixFmt,
      muted: true,
      audioStreamCount: videoInfo.audioStreamCount,
    });
    const evaluation = receiptFile(jobDir, record.evaluationReceipt, `slide ${slide.id} evaluation receipt`);
    if (record.qa.binding.evaluationReceiptSha256 !== evaluation.asset.sha256) fail(`slide ${slide.id} QA does not bind its evaluation receipt`);
    const evaluationResult = validateEvaluationReceipt(evaluation.value, {
      evidenceRoot: jobDir,
      expectedArtifactSha256: video.sha256,
      expectedMediaBudgetReceiptSha256: budgetReceiptFile.asset.sha256,
      requireHumanApproval: options.release === "final",
    });
    if (!evaluationResult.valid || !evaluationResult.accepted) {
      fail(`slide ${slide.id} evaluation receipt failed:\n- ${evaluationResult.errors.map((error) => `${error.code}: ${error.message}`).join("\n- ") || "derived outcome was not accepted"}`);
    }
    if (slideIndex + 1 > 10) fail("v2 supports at most ten slides");
  }
  if (dynamicSlides.length < 1) fail("candidate/final v2 deck requires at least one hybrid-video slide");
  if (manifestByKey.size !== dynamicSlides.length) fail("v2 asset manifest must exactly cover every hybrid-video slide");
  const budgetReceipt = validateMediaBudget(budgetDescriptors);
  if (!budgetReceipt.passed) fail(`v2 media budget failed:\n- ${budgetReceipt.errors.map((error) => `${error.pointer}: ${error.message}`).join("\n- ")}`);
  if (
    budgetReceiptFile.value.receiptType !== "deckformance-media-budget" ||
    budgetReceiptFile.value.stage !== "pre-qa" ||
    budgetReceiptFile.value.passed !== true ||
    budgetReceiptFile.value.descriptorSetSha256 !== mediaDescriptorSetSha256(budgetDescriptors) ||
    budgetReceiptFile.value.descriptorSetSha256 !== budgetReceipt.descriptorSetSha256
  ) {
    fail("media budget receipt is stale or does not bind the final deck video descriptor set");
  }
  return { mediaByLayer, budgetReceipt, budgetReceiptSha256: budgetReceiptFile.asset.sha256, timingTrees, dynamicSlides };
}

async function build(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const jobDir = fs.realpathSync(path.resolve(args.jobDir));
  if (!fs.statSync(jobDir).isDirectory()) fail(`job directory not found: ${jobDir}`);
  const output = resolveJobOutput(jobDir, args.outPath, { label: "output", extension: ".pptx" });
  const reportOutput = args.report
    ? resolveJobOutput(jobDir, args.report, { label: "report", extension: ".json" })
    : null;
  const skillDir = path.resolve(__dirname, "..");
  const v2Schemas = path.join(skillDir, "schemas", "v2");
  const designPath = path.join(jobDir, "design-plan.json");
  const manifestPath = path.join(jobDir, "asset-manifest.json");
  const deckPath = path.join(jobDir, "deck.json");
  const contentPath = path.join(jobDir, "content-plan.json");
  const visualPath = path.join(jobDir, "visual-plan.json");
  for (const required of [contentPath, visualPath, designPath, manifestPath, deckPath]) if (!fs.existsSync(required)) fail(`missing ${path.basename(required)}`);
  const designPlan = readJson(designPath, "design-plan.json");
  const manifest = readJson(manifestPath, "asset-manifest.json");
  const deck = readJson(deckPath, "deck.json");
  const visualPlan = readJson(visualPath, "visual-plan.json");
  const characterModelPath = path.join(jobDir, "character-model.json");
  const characterModel = fs.existsSync(characterModelPath) ? readJson(characterModelPath, "character-model.json") : null;
  assertSchema(designPlan, compileSchema(path.join(v2Schemas, "design-plan.schema.json")), "design-plan.json");
  assertSchema(manifest, compileSchema(path.join(v2Schemas, "asset-manifest.schema.json")), "asset-manifest.json");
  assertSchema(deck, createV2Validators().deck, "deck.json");
  if (designPlan.releaseEligibility !== "candidate-ready") fail("design-plan.json is draft-only and cannot produce candidate/final");
  if (designPlan.compiledFrom.visualPlan !== hashFile(visualPath)) fail("design-plan.json does not bind the current visual-plan.json");
  const designHash = hashFile(designPath);
  if (manifest.upstreamHashes.designPlan !== designHash) fail("asset-manifest.json does not bind the current design-plan.json");
  if (manifest.upstreamHashes.visualPlan !== hashFile(visualPath)) fail("asset-manifest.json does not bind the current visual-plan.json");
  if (designPlan.jobId !== manifest.jobId || designPlan.jobId !== visualPlan.jobId) fail("v2 job IDs do not match");
  const deckHash = hashFile(deckPath);
  const expectedDeck = compileDeck({
    jobDir,
    designPlan,
    manifest,
    hashes: {
      contentPlan: hashFile(contentPath),
      visualPlan: hashFile(visualPath),
      designPlan: designHash,
      assetManifest: hashFile(manifestPath),
    },
  });
  if (!util.isDeepStrictEqual(deck, expectedDeck)) fail("deck.json is stale or differs from the deterministic design/media compilation");
  const assetById = validateRegisteredAssets(jobDir, designPlan);
  const media = collectMedia(jobDir, designPlan, manifest, {
    release: args.release,
    experimentalNativeAnimations: args.experimentalNativeAnimations,
    characterModel,
  });
  const palette = visualPlan.brandDirection && visualPlan.brandDirection.deckPalette;
  const typography = visualPlan.brandDirection && visualPlan.brandDirection.typography;
  if (!palette || !typography) fail("visual-plan.json must supply deckPalette and typography");

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "DECKFORMANCE_V2_16x9", width: 10, height: 5.625 });
  pptx.layout = "DECKFORMANCE_V2_16x9";
  pptx.title = deck.title;
  pptx.author = "Deckformance";
  pptx.subject = `ppt-cast release:${args.release}; powerpoint-verified:${args.release === "final" ? "true" : "false"}; schema:2.0.0`;
  pptx.comments = "PowerPoint playback has not been verified on a real PowerPoint installation.";
  const videoSlides = [];
  for (let index = 0; index < deck.slides.length; index += 1) {
    const spec = deck.slides[index];
    const slide = pptx.addSlide();
    slide.background = { color: String(palette.bg).replace(/^#/, "").toUpperCase() };
    renderLayers(slide, pptx, spec.layers, {
      jobDir,
      slideNumber: index + 1,
      theme: { palette, typography },
      assetById,
      mediaByLayer: media.mediaByLayer,
      videoSlides,
      motionPlan: spec.motionPlan,
      textFitByLayer: new Map((spec.textFit || []).map((receipt) => [receipt.layerId, receipt])),
    });
    slide.addNotes(speakerNotes(spec));
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const base = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.base.pptx`);
  try {
    await pptx.writeFile({ fileName: base });
    const authored = fs.readFileSync(base);
    const packaged = await injectAutoplay(authored, videoSlides);
    const packageQa = await validatePackageBuffer(packaged, {
      expectedMediaCount: media.dynamicSlides.length,
      expectedContentPages: media.dynamicSlides.length,
      videoSlides,
      aspectRatiosValid: true,
      release: args.release,
    });
    if (!packageQa.valid) fail(`v2 package QA failed:\n- ${packageQa.errors.join("\n- ")}`);
    atomicWrite(output, packaged);
    const report = {
      version: 2,
      schemaVersion: "2.0.0",
      valid: true,
      passed: true,
      release: args.release,
      output: relativeForReport(jobDir, output),
      jobId: designPlan.jobId,
      deckSha256: deckHash,
      designPlanSha256: designHash,
      assetManifestSha256: hashFile(manifestPath),
      artifactSha256: sha256(packaged),
      slideCount: packageQa.slideCount,
      embeddedVideoCount: packageQa.embeddedVideoCount,
      posterCount: packageQa.posterCount,
      timingCount: packageQa.timingCount,
      embeddedMediaBytes: packageQa.embeddedMediaBytes,
      maxEmbeddedMediaBytes: packageQa.maxEmbeddedMediaBytes,
      relationshipsValid: packageQa.relationshipsValid,
      mimeTypesValid: packageQa.mimeTypesValid,
      mediaBudget: media.budgetReceipt,
      timingTrees: media.timingTrees,
      generatedAt: new Date().toISOString(),
    };
    if (reportOutput) atomicWrite(reportOutput, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    console.log(output);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    if (fs.existsSync(base)) fs.unlinkSync(base);
  }
}

if (require.main === module) {
  build().catch((error) => {
    console.error(error && error.stack && !error.isUserError ? error.stack : error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  assertDescriptor,
  assertExternalVideoGeneration,
  collectMedia,
  parseArgs,
  resolveJobOutput,
  speakerNotes,
  build,
};

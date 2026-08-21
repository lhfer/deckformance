"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, ".grok", "skills", "ppt-cast");
const SCRIPTS = path.join(SKILL, "scripts");
const SCHEMAS = path.join(SKILL, "schemas", "v2");
const COMPILE = path.join(SCRIPTS, "compile_design.js");
const COMPILE_DECK = path.join(SCRIPTS, "compile_deck_v2.js");
const PREVIEW_V2 = path.join(SCRIPTS, "preview_design_v2.js");
const MIGRATE = path.join(SCRIPTS, "migrate_v1.js");
const BUILD_V2 = path.join(SCRIPTS, "build_deck_v2.js");
const VALIDATE_V2 = path.join(SCRIPTS, "validate_pptx_v2.js");
const VALIDATE_PPTX_V2 = path.join(SCRIPTS, "validate_pptx_v2.js");
const { createHashBoundReceipt } = require(path.join(SCRIPTS, "runtime", "hash_bound_receipt"));
const { validateMediaBudget } = require(path.join(SCRIPTS, "media_budget"));
const { evaluationReceiptSha256 } = require(path.join(SCRIPTS, "evaluation_receipt"));
const { validateMediaEvidence } = require(path.join(SCRIPTS, "validate_job_v2"));
const { assertSafeOutputParent } = require(path.join(SCRIPTS, "compile_deck_v2"));
const HASH = `sha256:${"a".repeat(64)}`;

function hashBytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function writeJson(filePath, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return hashBytes(bytes);
}

function typography() {
  const token = (family, weight, min, preferred, max, lineHeight, maxLines) => ({
    family,
    fallbacks: ["Helvetica Neue", "DejaVu Sans"],
    weight,
    size: { min, preferred, max },
    lineHeight,
    letterSpacing: 0,
    maxLines,
  });
  return {
    schemaVersion: "2.0.0",
    measurementPolicy: "fail-closed",
    tokens: {
      display: token("Arial", 700, 50, 60, 72, 1.05, 2),
      headline: token("Arial", 700, 35, 40, 52, 1.1, 3),
      subhead: token("Arial", 600, 24, 28, 34, 1.18, 4),
      body: token("Arial", 400, 16, 18, 22, 1.3, 6),
      caption: token("Arial", 400, 12, 13, 16, 1.2, 5),
      data: token("Arial", 700, 24, 30, 44, 1.08, 3),
      number: token("Arial", 700, 35, 46, 64, 1.0, 2),
    },
    cjk: { kinsoku: true, orphanControl: true, mixedScript: "balanced" },
  };
}

function source() {
  return {
    id: "official",
    title: "Official fixture",
    kind: "public-url",
    url: "https://example.com/evidence",
    publisher: "Example",
    retrievedAt: "2026-08-20T00:00:00.000Z",
    isPrimary: true,
    supports: ["01"],
  };
}

function makeV2Fixture(name) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), `deckformance-v2-${name}-`));
  const briefHash = writeJson(path.join(jobDir, "brief.json"), { fixture: "brief", name });
  const characterModelHash = writeJson(path.join(jobDir, "character-model.json"), { fixture: "character-model", name });
  const content = {
    schemaVersion: "2.0.0",
    planningStatus: "approved",
    jobId: "v2-design-fixture",
    upstreamHashes: { brief: briefHash },
    thesis: "A deterministic v2 design compiler",
    narrative: { promise: "Promise", development: "Develop", proof: "Prove", conclusion: "Conclude" },
    coverageMatrix: [{ mustCover: "design", slideIds: ["01"], support: "Structured fixture" }],
    sources: [source()],
    slides: [
      {
        id: "00", type: "cover", pageRole: "cover", kicker: "Introduction",
        title: "Design before media", body: ["Resolve native structure before generation."],
        claim: "Design is upstream of media", evidence: ["The compiler emits a design plan"], evidenceBasis: "none",
        transition: "Move to proof", takeaway: "Plan first", sourceIds: [], videoRequired: false,
      },
      {
        id: "01", type: "content", pageRole: "evidence", kicker: "Evidence",
        title: "One performer, one proof", body: ["Native text remains editable.", "Video performs the claim."],
        claim: "Hybrid composition separates evidence from performance", evidence: ["Structured source-backed fixture"], evidenceBasis: "public-source",
        transition: "End on the implication", takeaway: "Keep the layers explicit", sourceIds: ["official"], videoRequired: true,
      },
    ],
  };
  const contentHash = writeJson(path.join(jobDir, "content-plan.json"), content);
  const visual = {
    schemaVersion: "2.0.0",
    planningStatus: "approved",
    jobId: content.jobId,
    upstreamHashes: { brief: briefHash, characterModel: characterModelHash, contentPlan: contentHash },
    stylePack: "felt-yarn",
    brandDirection: {
      deckPalette: {
        bg: "#F2F3F5", panel: "#0B0D10", title: "#F7F7F7", body: "#B8B8B8",
        muted: "#7A7A7A", accent: "#C8102E", ink: "#0B0D10", inkMuted: "#5A5A5A",
      },
      typography: typography(),
      materials: ["felt"],
      lighting: "controlled miniature light",
      motionLanguage: "one readable gesture",
    },
    registeredAssets: [],
    slides: [
      {
        id: "00", composition: "auto", mediaMode: "static-native", density: "auto", negativeSpace: "center",
        visualProposition: "A restrained native title frame.", actionClass: "idle", layerIntents: [], motionPlan: null, mediaBudget: null,
      },
      {
        id: "01", composition: "auto", mediaMode: "hybrid-video", density: "auto", negativeSpace: "right",
        visualProposition: "The performer occupies the left while source-backed native evidence remains readable.",
        actionClass: "upper-body-gesture",
        layerIntents: [
          { type: "video", key: "performance", poster: null, video: null, slot: { aspect: "1:1", widthPx: 1080, heightPx: 1080 } },
        ],
        motionPlan: {
          durationSeconds: 6,
          loopPolicy: "hold-last-frame",
          finalHoldSeconds: 1,
          beats: [{ at: 0, action: "enter" }, { at: 4.5, action: "settle" }],
          camera: { movement: "static", gaze: "audience" },
        },
        mediaBudget: { fps: 30, codec: "h264", pixelFormat: "yuv420p", muted: true, maxBytes: 12582912 },
      },
    ],
  };
  writeJson(path.join(jobDir, "visual-plan.json"), visual);
  return { jobDir, content, visual, briefHash, characterModelHash };
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

test("all v2 schemas compile as Draft 2020-12 with their cross-schema references", () => {
  const Ajv2020 = require(path.join(SCRIPTS, "node_modules", "ajv", "dist", "2020")).default;
  const addFormats = require(path.join(SCRIPTS, "node_modules", "ajv-formats"));
  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const files = fs.readdirSync(SCHEMAS).filter((name) => name.endsWith(".schema.json")).sort();
  const schemas = files.map((name) => JSON.parse(fs.readFileSync(path.join(SCHEMAS, name), "utf8")));
  schemas.forEach((schema) => ajv.addSchema(schema));
  schemas.forEach((schema) => assert.equal(typeof ajv.getSchema(schema.$id), "function", schema.$id));
});

test("v2 design compilation and pre-media preview share resolved typography, layers, and video slots", async (t) => {
  const fixture = makeV2Fixture("compile");
  t.after(() => fs.rmSync(fixture.jobDir, { recursive: true, force: true }));
  let result = run(COMPILE, [fixture.jobDir, "--output", "design-a.json"]);
  assert.equal(result.status, 0, result.stderr);
  result = run(COMPILE, [fixture.jobDir, "--output", "design-b.json"]);
  assert.equal(result.status, 0, result.stderr);
  const a = fs.readFileSync(path.join(fixture.jobDir, "design-a.json"));
  const b = fs.readFileSync(path.join(fixture.jobDir, "design-b.json"));
  assert.deepEqual(a, b);
  const design = JSON.parse(a);
  assert.equal(design.releaseEligibility, "candidate-ready");
  assert.equal(design.slides.length, 2);
  const dynamic = design.slides[1];
  assert.deepEqual(
    Object.keys(dynamic).sort(),
    ["compositionId", "decisionTrace", "density", "fontResolution", "id", "layers", "mediaBudget", "mediaMode", "motionPlan", "pageRole", "sources", "speakerNotes", "textFit", "type"].sort(),
  );
  const videos = dynamic.layers.filter((layer) => layer.type === "video");
  assert.equal(videos.length, 1);
  assert.equal(videos[0].mediaKey, "01");
  assert.equal(videos[0].poster, null);
  assert.equal(videos[0].video, null);
  assert.equal(dynamic.motionPlan.targetLayerId, videos[0].id);
  assert.equal(dynamic.motionPlan.playback.advanceMode, "manual");
  assert.equal(new Set(dynamic.layers.map((layer) => layer.id)).size, dynamic.layers.length);
  assert.equal(new Set(dynamic.layers.map((layer) => layer.z)).size, dynamic.layers.length);
  assert.ok(dynamic.textFit.every((item) => item.fit && item.measurementMethod === "fontkit-xadvance-v1"));
  for (const receipt of Object.values(dynamic.fontResolution.tokens)) {
    assert.equal(receipt.precision, "fontkit");
    assert.match(receipt.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(receipt, "path"), false);
    assert.equal(path.isAbsolute(receipt.fileName), false);
  }
  fs.writeFileSync(path.join(fixture.jobDir, "design-plan.json"), a);
  result = run(PREVIEW_V2, [fixture.jobDir]);
  assert.equal(result.status, 0, result.stderr);
  const previewPath = path.join(fixture.jobDir, "qa", "design-preview.pptx");
  const JSZip = require(path.join(SCRIPTS, "node_modules", "jszip"));
  const preview = await JSZip.loadAsync(fs.readFileSync(previewPath));
  const slide2 = await preview.file("ppt/slides/slide2.xml").async("string");
  assert.match(slide2, /One performer,[\s\S]*<\/a:p><a:p>[\s\S]*one proof/, "resolved textFit lines must be authored as explicit PowerPoint paragraphs");
  assert.match(slide2, /VIDEO SLOT/);
  assert.match(slide2, new RegExp(`name="${videos[0].id}"`));
  assert.equal(Object.keys(preview.files).some((name) => /ppt\/media\/.*\.mp4$/i.test(name)), false);
});

test("v2 design compilation fails closed on media boundary drift without publishing output", (t) => {
  const fixture = makeV2Fixture("boundary");
  t.after(() => fs.rmSync(fixture.jobDir, { recursive: true, force: true }));
  fixture.visual.slides[1].mediaMode = "static-native";
  writeJson(path.join(fixture.jobDir, "visual-plan.json"), fixture.visual);
  const result = run(COMPILE, [fixture.jobDir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mediaMode must be hybrid-video/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "design-plan.json")), false);
});

test("v2 deterministic outputs reject a symlinked parent that leaves the job", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-output-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-output-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.symlinkSync(outside, path.join(root, "escaped"), "dir");
  assert.throws(() => assertSafeOutputParent(fs.realpathSync(root), path.join(root, "escaped", "deck.json")), /outside|symbolic/);
});

test("migrate_v1 emits only a blocked draft and compile_design refuses it", (t) => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v1-migrate-"));
  t.after(() => fs.rmSync(jobDir, { recursive: true, force: true }));
  const fixture = makeV2Fixture("migration-source");
  t.after(() => fs.rmSync(fixture.jobDir, { recursive: true, force: true }));
  const v1Content = {
    ...fixture.content,
    schemaVersion: "1.0.0",
    slides: fixture.content.slides.map(({ pageRole, kicker, ...slide }) => ({ ...slide, role: kicker })),
  };
  delete v1Content.planningStatus;
  const v1Visual = {
    schemaVersion: "1.0.0",
    jobId: fixture.visual.jobId,
    upstreamHashes: fixture.visual.upstreamHashes,
    brandDirection: {
      deckPalette: fixture.visual.brandDirection.deckPalette,
      sourceSwatches: ["#F2F3F5", "#0B0D10", "#C8102E"],
      typography: { title: "Arial", body: "Arial", number: "Arial", rationale: "Fixture" },
      materials: ["felt"], lighting: "fixture", motionLanguage: "fixture",
    },
    slides: [{
      id: "01", visualProposition: "Fixture", actionClass: "idle",
      slot: { aspect: "1:1", widthPx: 1080, heightPx: 1080, posterFormat: "png" },
    }],
  };
  writeJson(path.join(jobDir, "content-plan.json"), v1Content);
  writeJson(path.join(jobDir, "visual-plan.json"), v1Visual);
  let result = run(MIGRATE, [jobDir]);
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(jobDir, "v2-migration-draft");
  const report = JSON.parse(fs.readFileSync(path.join(output, "migration-report.json"), "utf8"));
  assert.equal(report.releaseEligibility, "draft-only");
  assert.equal(report.designPlanProduced, false);
  assert.equal(report.candidateProduced, false);
  assert.equal(fs.existsSync(path.join(output, "design-plan.json")), false);
  result = run(COMPILE, [output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires approved content and visual plans|must contain brief\.json, character-model\.json, content-plan\.json, and visual-plan\.json/);
  assert.equal(fs.existsSync(path.join(output, "design-plan.json")), false);
});

function mediaDescriptor(filePath, relativePath, width, height, extra = {}) {
  return {
    path: relativePath,
    sha256: hashBytes(fs.readFileSync(filePath)),
    bytes: fs.statSync(filePath).size,
    width,
    height,
    ...extra,
  };
}

test("v2 design plan, hash-bound media manifest, Hybrid builder, and autoplay package form one candidate chain", async (t) => {
  const fixture = makeV2Fixture("candidate-chain");
  t.after(() => fs.rmSync(fixture.jobDir, { recursive: true, force: true }));
  let result = run(COMPILE, [fixture.jobDir]);
  assert.equal(result.status, 0, result.stderr);
  const designPath = path.join(fixture.jobDir, "design-plan.json");
  const design = JSON.parse(fs.readFileSync(designPath, "utf8"));
  const dynamic = design.slides.find((slide) => slide.mediaMode === "hybrid-video");
  const videoLayer = dynamic.layers.find((layer) => layer.type === "video");
  fs.mkdirSync(path.join(fixture.jobDir, "stills"), { recursive: true });
  fs.mkdirSync(path.join(fixture.jobDir, "videos"), { recursive: true });
  fs.mkdirSync(path.join(fixture.jobDir, "qa", "01"), { recursive: true });
  const posterPath = path.join(fixture.jobDir, "stills", "01.png");
  const rejectedPath = path.join(fixture.jobDir, "stills", "01-rejected.png");
  const videoPath = path.join(fixture.jobDir, "videos", "01.mp4");
  result = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x345678:s=1080x1080:d=0.1", "-frames:v", "1", "-c:v", "png", posterPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x765432:s=1080x1080:d=0.1", "-frames:v", "1", "-c:v", "png", rejectedPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1080:r=30:d=6",
    "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", videoPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const poster = mediaDescriptor(posterPath, "stills/01.png", 1080, 1080, { mime: "image/png" });
  const rejected = mediaDescriptor(rejectedPath, "stills/01-rejected.png", 1080, 1080, { mime: "image/png" });
  const video = mediaDescriptor(videoPath, "videos/01.mp4", 1080, 1080, {
    mime: "video/mp4", durationSeconds: 6, fps: 30, codec: "h264", pixelFormat: "yuv420p", muted: true, audioStreamCount: 0,
  });
  fs.writeFileSync(path.join(fixture.jobDir, "qa", "local-provider.js"), "module.exports = 'local-import';\n");
  const providerImpl = "qa/local-provider.js";
  const posterProvider = createHashBoundReceipt({
    root: fixture.jobDir,
    kind: "provider",
    producer: { name: "local-import", version: "1" },
    implementationFiles: [providerImpl],
    inputs: [],
    outputs: [poster.path],
    metadata: {
      provider: "local-import", providerVersion: "1", model: "local-file", operation: "import-poster",
      promptSha256: HASH, seed: null, requestId: "local-poster-01", durationMs: 0, cost: null, providerMetadata: {},
    },
    createdAt: "2026-08-20T20:50:00.000Z",
  });
  const videoProvider = createHashBoundReceipt({
    root: fixture.jobDir,
    kind: "provider",
    producer: { name: "local-import", version: "1" },
    implementationFiles: [providerImpl],
    inputs: [poster.path],
    outputs: [video.path],
    metadata: {
      provider: "local-import", providerVersion: "1", model: "local-file", operation: "import-video",
      promptSha256: HASH, seed: null, requestId: "local-video-01", durationMs: 0, cost: null, providerMetadata: {},
    },
    createdAt: "2026-08-20T20:51:00.000Z",
  });
  const posterProviderRelative = "qa/01/poster-provider.json";
  const videoProviderRelative = "qa/01/video-provider.json";
  const posterProviderHash = writeJson(path.join(fixture.jobDir, ...posterProviderRelative.split("/")), posterProvider);
  const videoProviderHash = writeJson(path.join(fixture.jobDir, ...videoProviderRelative.split("/")), videoProvider);
  const budget = validateMediaBudget([{
    slideId: dynamic.id,
    layerId: videoLayer.id,
    sha256: video.sha256,
    bytes: video.bytes,
    durationSeconds: 6,
    fps: 30,
    codec: "h264",
    pixelFormat: "yuv420p",
    muted: true,
    audioStreamCount: 0,
  }], { createdAt: "2026-08-20T20:55:00.000Z" });
  assert.equal(budget.passed, true, JSON.stringify(budget.errors));
  const budgetRelative = "qa/media-budget.json";
  const budgetHash = writeJson(path.join(fixture.jobDir, ...budgetRelative.split("/")), budget);
  const frameRatios = [0, 0.2, 0.5, 0.8, 1];
  const frames = frameRatios.map((timeRatio, index) => {
    const relative = `qa/01/frame-${index + 1}.png`;
    const target = path.join(fixture.jobDir, ...relative.split("/"));
    const timestamp = timeRatio === 0 ? 0 : Math.max(0, Math.min(5.95, 6 * timeRatio));
    const extract = spawnSync("ffmpeg", [
      "-y", "-v", "error", "-ss", timestamp.toFixed(3), "-i", videoPath,
      "-frames:v", "1", "-c:v", "png", target,
    ], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    return mediaDescriptor(target, relative, 1080, 1080, { mime: "image/png", timeRatio });
  });
  const slotRelative = "qa/01/slot-composite.png";
  const slotPath = path.join(fixture.jobDir, ...slotRelative.split("/"));
  result = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x102030:s=1920x1080:d=0.1",
    "-frames:v", "1", "-c:v", "png", slotPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const rubricRelative = "qa/visual-rubric.json";
  const rubric = { id: "candidate-visual-v2", version: "1.0.0", scale: { min: 1, max: 5, passAt: 4 } };
  const rubricHash = writeJson(path.join(fixture.jobDir, ...rubricRelative.split("/")), rubric);
  const frameIds = frameRatios.map((_, index) => `frame-${index + 1}`);
  const evaluation = {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-evaluation",
    createdAt: "2026-08-20T21:00:00.000Z",
    subject: { kind: "video", artifactSha256: video.sha256, mediaBudgetReceiptSha256: budgetHash },
    evaluator: { id: "fixture-visual-evaluator", version: "1.0.0", implementationPath: providerImpl, implementationSha256: hashBytes(fs.readFileSync(path.join(fixture.jobDir, providerImpl))) },
    rubric: { ...rubric, path: rubricRelative, sha256: rubricHash },
    scores: [
      { criterion: "identity", score: 4.5, evidenceFrameIds: frameIds },
      { criterion: "body-completeness", score: 4.5, evidenceFrameIds: frameIds },
      { criterion: "crop-safety", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "claim-expression", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "composition", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "motion-continuity", score: 4.25, evidenceFrameIds: frameIds },
    ],
    evidenceFrames: frames.map((frame, index) => ({
      id: frameIds[index], path: frame.path, sha256: frame.sha256, sourceArtifactSha256: video.sha256, timeRatio: frame.timeRatio,
    })),
    issues: [],
    humanReview: { status: "approved", reviewer: "fixture-reviewer", reviewedAt: "2026-08-20T21:01:00.000Z" },
    passed: true,
  };
  evaluation.receiptSha256 = evaluationReceiptSha256(evaluation);
  const evaluationRelative = "qa/01/evaluation.json";
  const evaluationHash = writeJson(path.join(fixture.jobDir, ...evaluationRelative.split("/")), evaluation);
  const manifest = {
    schemaVersion: "2.0.0",
    jobId: design.jobId,
    upstreamHashes: {
      characterModel: fixture.characterModelHash,
      contentPlan: hashBytes(fs.readFileSync(path.join(fixture.jobDir, "content-plan.json"))),
      visualPlan: hashBytes(fs.readFileSync(path.join(fixture.jobDir, "visual-plan.json"))),
      designPlan: hashBytes(fs.readFileSync(designPath)),
    },
    mediaBudgetReceipt: { path: budgetRelative, sha256: budgetHash },
    slides: [{
      id: dynamic.id,
      mediaKey: videoLayer.mediaKey,
      layerId: videoLayer.id,
      poster,
      video,
      providerReceipts: {
        poster: { path: posterProviderRelative, sha256: posterProviderHash },
        video: { path: videoProviderRelative, sha256: videoProviderHash },
      },
      evaluationReceipt: { path: evaluationRelative, sha256: evaluationHash },
      attempts: {
        stills: [
          { id: "still-selected", path: poster.path, sha256: poster.sha256, status: "selected", reason: "best claim composition" },
          { id: "still-rejected", path: rejected.path, sha256: rejected.sha256, status: "rejected", reason: "weaker silhouette" },
        ],
        videos: [{ id: "video-selected", path: video.path, sha256: video.sha256, status: "selected", reason: "passed final-media QA" }],
      },
      qa: {
        passed: true,
        binding: {
          posterSha256: poster.sha256,
          videoSha256: video.sha256,
          performanceBibleSha256: HASH,
          visualPlanSha256: manifestHashPlaceholder(),
          designPlanSha256: hashBytes(fs.readFileSync(designPath)),
          mediaBudgetReceiptSha256: budgetHash,
          posterProviderReceiptSha256: posterProviderHash,
          videoProviderReceiptSha256: videoProviderHash,
          evaluationReceiptSha256: evaluationHash,
        },
        frames,
        slotComposite: mediaDescriptor(slotPath, slotRelative, 1920, 1080, { mime: "image/png" }),
        reviewedAt: "2026-08-20T21:00:00.000Z",
      },
    }],
  };
  manifest.slides[0].qa.binding.visualPlanSha256 = manifest.upstreamHashes.visualPlan;
  const duplicateFrameManifest = structuredClone(manifest);
  duplicateFrameManifest.slides[0].qa.frames[1] = {
    ...duplicateFrameManifest.slides[0].qa.frames[0],
    timeRatio: 0.2,
  };
  const duplicateFrameErrors = [];
  validateMediaEvidence(fixture.jobDir, design, duplicateFrameManifest, null, duplicateFrameErrors);
  assert.ok(duplicateFrameErrors.some((error) => error.code === "MEDIA_FRAME_DUPLICATE"));

  const badCompositeManifest = structuredClone(manifest);
  badCompositeManifest.slides[0].qa.slotComposite = { ...poster };
  const badCompositeErrors = [];
  validateMediaEvidence(fixture.jobDir, design, badCompositeManifest, null, badCompositeErrors);
  assert.ok(badCompositeErrors.some((error) => error.code === "SLOT_COMPOSITE_DIMENSIONS"));

  const unboundVideoProvider = createHashBoundReceipt({
    root: fixture.jobDir,
    kind: "provider",
    producer: { name: "local-import", version: "1" },
    implementationFiles: [providerImpl],
    inputs: [],
    outputs: [video.path],
    metadata: {
      provider: "local-import", providerVersion: "1", model: "local-file", operation: "import-video",
      promptSha256: HASH, seed: null, requestId: "unbound-video", durationMs: 0, cost: null, providerMetadata: {},
    },
    createdAt: "2026-08-20T20:52:00.000Z",
  });
  const unboundProviderRelative = "qa/01/unbound-video-provider.json";
  const unboundProviderHash = writeJson(path.join(fixture.jobDir, ...unboundProviderRelative.split("/")), unboundVideoProvider);
  const unboundProviderManifest = structuredClone(manifest);
  unboundProviderManifest.slides[0].providerReceipts.video = { path: unboundProviderRelative, sha256: unboundProviderHash };
  unboundProviderManifest.slides[0].qa.binding.videoProviderReceiptSha256 = unboundProviderHash;
  const unboundProviderErrors = [];
  validateMediaEvidence(fixture.jobDir, design, unboundProviderManifest, null, unboundProviderErrors);
  assert.ok(unboundProviderErrors.some((error) => error.code === "PROVIDER_INPUT_BINDING"));

  const incompleteProvider = createHashBoundReceipt({
    root: fixture.jobDir,
    kind: "provider",
    producer: { name: "local-import", version: "1" },
    implementationFiles: [providerImpl],
    inputs: [],
    outputs: [poster.path],
    metadata: { operation: "import-poster", requestId: "manual-claim", promptSha256: HASH },
    createdAt: "2026-08-20T20:53:00.000Z",
  });
  const incompleteProviderRelative = "qa/01/incomplete-provider.json";
  const incompleteProviderHash = writeJson(path.join(fixture.jobDir, ...incompleteProviderRelative.split("/")), incompleteProvider);
  const incompleteProviderManifest = structuredClone(manifest);
  incompleteProviderManifest.slides[0].providerReceipts.poster = { path: incompleteProviderRelative, sha256: incompleteProviderHash };
  incompleteProviderManifest.slides[0].qa.binding.posterProviderReceiptSha256 = incompleteProviderHash;
  const incompleteProviderErrors = [];
  validateMediaEvidence(fixture.jobDir, design, incompleteProviderManifest, null, incompleteProviderErrors);
  assert.ok(incompleteProviderErrors.some((error) => error.code === "PROVIDER_PROVENANCE"));
  writeJson(path.join(fixture.jobDir, "asset-manifest.json"), manifest);
  result = run(COMPILE_DECK, [fixture.jobDir]);
  assert.equal(result.status, 0, result.stderr);
  const deckPath = path.join(fixture.jobDir, "deck.json");
  const firstDeckBytes = fs.readFileSync(deckPath);
  const deck = JSON.parse(firstDeckBytes);
  assert.equal(deck.releaseLevel, "candidate");
  assert.equal(deck.compiledFrom.designPlan, manifest.upstreamHashes.designPlan);
  assert.equal(deck.slides.find((slide) => slide.id === dynamic.id).layers.find((layer) => layer.type === "video").video, video.path);
  result = run(COMPILE_DECK, [fixture.jobDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(deckPath), firstDeckBytes, "deck compilation must be byte-deterministic");
  const output = path.join(fixture.jobDir, "build", "candidate.staging.pptx");
  const report = path.join(fixture.jobDir, "qa", "package-v2.json");
  result = run(BUILD_V2, [fixture.jobDir, output, "--release", "candidate", "--report", report]);
  assert.equal(result.status, 0, result.stderr);
  const packageReport = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(packageReport.passed, true);
  assert.equal(packageReport.schemaVersion, "2.0.0");
  assert.equal(packageReport.embeddedVideoCount, 1);
  assert.equal(packageReport.timingCount, 1);
  assert.equal(packageReport.mediaBudget.passed, true);
  assert.equal(packageReport.deckSha256, hashBytes(firstDeckBytes));
  assert.equal(packageReport.timingTrees[0].targetLayerId, videoLayer.id);
  const releaseReportPath = path.join(fixture.jobDir, "qa", "package-qa.json");
  result = run(VALIDATE_PPTX_V2, [fixture.jobDir, output, "--report", releaseReportPath]);
  assert.equal(result.status, 0, result.stderr);
  const releaseReport = JSON.parse(fs.readFileSync(releaseReportPath, "utf8"));
  assert.equal(releaseReport.receiptType, "deckformance-package-qa");
  assert.equal(releaseReport.collectMediaPassed, true);
  assert.equal(releaseReport.artifactSha256, hashBytes(fs.readFileSync(output)));
  assert.equal(releaseReport.deckSha256, hashBytes(firstDeckBytes));
  const JSZip = require(path.join(SCRIPTS, "node_modules", "jszip"));
  const zip = await JSZip.loadAsync(fs.readFileSync(output));
  const dynamicSlideNumber = design.slides.indexOf(dynamic) + 1;
  const slideXml = await zip.file(`ppt/slides/slide${dynamicSlideNumber}.xml`).async("string");
  assert.match(slideXml, new RegExp(`name="${videoLayer.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(slideXml, /<p:timing>/);
  const independentReport = path.join(fixture.jobDir, "qa", "package-v2-independent.json");
  result = run(VALIDATE_V2, [fixture.jobDir, "build/candidate.staging.pptx", "--release", "candidate", "--report", "qa/package-v2-independent.json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(independentReport, "utf8")).passed, true);

  const tamperedZip = await JSZip.loadAsync(fs.readFileSync(output));
  const tamperedXml = slideXml.replace(
    /(<p:cmd\b[^>]*cmd="playFrom\(0\.0\)"[\s\S]*?<p:cBhvr>[\s\S]*?<p:cTn\b[^>]*\bdur=")\d+("[^>]*\bfill="hold")/,
    (_match, before, after) => `${before}1234${after}`,
  );
  assert.notEqual(tamperedXml, slideXml);
  tamperedZip.file(`ppt/slides/slide${dynamicSlideNumber}.xml`, tamperedXml);
  const tamperedPath = path.join(fixture.jobDir, "build", "tampered-timing.pptx");
  fs.writeFileSync(tamperedPath, await tamperedZip.generateAsync({ type: "nodebuffer" }));
  result = run(VALIDATE_V2, [fixture.jobDir, "build/tampered-timing.pptx", "--release", "candidate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /timing duration must equal validated media duration/);

  if (process.env.DECKFORMANCE_CAPTURE_V2_JOB) {
    const captureRoot = path.resolve(process.env.DECKFORMANCE_CAPTURE_V2_JOB);
    if (fs.existsSync(captureRoot)) throw new Error(`DECKFORMANCE_CAPTURE_V2_JOB target already exists: ${captureRoot}`);
    fs.cpSync(fixture.jobDir, captureRoot, { recursive: true, errorOnExist: true });
  }

  result = run(BUILD_V2, [fixture.jobDir, path.join(fixture.jobDir, "build", "final.staging.pptx"), "--release", "final"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot create final bytes/);

  fs.appendFileSync(videoPath, Buffer.from("post-qa-drift"));
  result = run(BUILD_V2, [fixture.jobDir, path.join(fixture.jobDir, "build", "drifted.pptx"), "--release", "candidate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha256 is stale/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "build", "drifted.pptx")), false);
});

function manifestHashPlaceholder() {
  return HASH;
}

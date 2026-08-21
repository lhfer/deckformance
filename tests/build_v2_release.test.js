"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts");
const { compileDeck } = require(path.join(SCRIPTS, "compile_deck_v2"));
const { assertBindings } = require(path.join(SCRIPTS, "validate_pptx_v2"));
const {
  EXPECTED_STAGING,
  POWERPOINT_PRODUCER_ID,
  POWERPOINT_PRODUCER_VERSION,
  STAGES,
  validateFileDescriptor,
  validateJobV2,
  validatePerformanceBibleBinding,
  validatePowerPointEvidence,
  validateRenderEvidence,
  validateRenderedSlides,
} = require(path.join(SCRIPTS, "validate_job_v2"));
const {
  assertReleasePreflight,
  assertReleaseInputsUnchanged,
  compareDirectReport,
  defaultJob,
  emptyRelease,
  invalidateForDrift,
  releaseCandidate,
  releaseFinal,
  snapshotReleaseInputs,
  publishWithRollback,
} = require(path.join(SCRIPTS, "jobctl_v2"));
const { loadValidation } = require(path.join(SCRIPTS, "preflight"));
const { sha256File } = require(path.join(SCRIPTS, "validate_job"));

const HASH = `sha256:${"a".repeat(64)}`;
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function writeFile(root, relative, data) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

function writeJson(root, relative, value) {
  return writeFile(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function fakePptx() {
  return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0]);
}

function writePng(root, relative, color, width = 1920, height = 1080) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:d=0.1`,
    "-frames:v", "1", "-c:v", "png", target,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return target;
}

function trustedRenderFixture(root) {
  const renderer = writeFile(root, "qa/trusted/render_slides.py", "# trusted fixture renderer\n");
  const slidesTest = writeFile(root, "qa/trusted/slides_test.py", "# trusted fixture overflow test\n");
  const which = spawnSync("/usr/bin/env", ["python3", "-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" });
  assert.equal(which.status, 0, which.stderr);
  const pythonPath = which.stdout.trim();
  const runtime = spawnSync(pythonPath, [
    "-c",
    "import json,sys,PIL; print(json.dumps({'implementation':sys.implementation.name,'version':'.'.join(map(str,sys.version_info[:3])),'pillowVersion':PIL.__version__}))",
  ], { encoding: "utf8" });
  assert.equal(runtime.status, 0, runtime.stderr);
  return {
    options: {
      rendererTrustPolicy: {
        schema: "deckformance.renderer-trust-policy/1",
        policyId: "deckformance.renderer-trust.default.v1",
        approvedAdapters: [{
          id: "fixture-adapter",
          renderer: { name: "render_slides.py", version: "fixture-renderer-v1", sha256: sha256File(renderer) },
          slidesTest: { name: "slides_test.py", version: "fixture-slides-test-v1", sha256: sha256File(slidesTest) },
        }],
      },
      trustedRenderTools: {
        renderer: { path: renderer, version: "fixture-renderer-v1" },
        slidesTest: { path: slidesTest, version: "fixture-slides-test-v1" },
        python: { path: pythonPath },
      },
    },
    receipts: {
      renderer: { name: "render_slides.py", version: "fixture-renderer-v1", sha256: sha256File(renderer) },
      slidesTest: { name: "slides_test.py", version: "fixture-slides-test-v1", sha256: sha256File(slidesTest) },
      python: { ...JSON.parse(runtime.stdout), executable: path.basename(pythonPath), sha256: sha256File(pythonPath) },
    },
  };
}

function packagedJob(jobId = "v2-release-fixture") {
  const job = defaultJob(jobId, "2026-08-20T20:00:00.000Z");
  const packagedIndex = STAGES.indexOf("packaged");
  job.state.stage = "packaged";
  job.state.completedStages = STAGES.slice(1, packagedIndex + 1);
  return job;
}

function packageReport(artifactSha256, artifactPath = EXPECTED_STAGING) {
  return {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-package-qa",
    producer: { id: "deckformance/validate-pptx-v2", version: "2.0.0", implementationSha256: HASH },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: { version: process.version, executable: path.basename(process.execPath), sha256: sha256File(process.execPath) },
    },
    jobId: "v2-release-fixture",
    release: "candidate",
    artifactPath,
    artifactSha256,
    contentPlanSha256: HASH,
    visualPlanSha256: HASH,
    designPlanSha256: HASH,
    assetManifestSha256: HASH,
    deckSha256: HASH,
    slideCount: 2,
    expectedContentPages: 1,
    embeddedVideoCount: 1,
    posterCount: 1,
    timingCount: 1,
    embeddedMediaBytes: 1024,
    maxEmbeddedMediaBytes: 104857600,
    relationshipsValid: true,
    mimeTypesValid: true,
    aspectRatiosValid: true,
    collectMediaPassed: true,
    checkedAt: "2026-08-20T20:10:00.000Z",
    errors: [],
    passed: true,
  };
}

test("v2 state order resolves design before media and initialized jobs use the v2 schema", (t) => {
  assert.ok(STAGES.indexOf("design-planned") < STAGES.indexOf("media-ready"));
  assert.ok(STAGES.indexOf("media-ready") < STAGES.indexOf("packaged"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = defaultJob("v2-state-fixture", "2026-08-20T20:00:00.000Z");
  writeJson(root, "job.json", job);
  const result = validateJobV2(root, { skipEnvironmentBindings: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(Object.keys(job.artifacts).sort(), ["assetManifest", "brief", "characterModel", "contentPlan", "deck", "designPlan", "visualPlan"].sort());

  const routed = loadValidation(root, "candidate");
  assert.equal(routed.ok, false);
  assert.ok(routed.errors.some((error) => error.code === "MISSING_CONTRACT"));
  assert.ok(!routed.errors.some((error) => error.message.includes("expected 1.0.0")));
});

test("v2 deterministic deck binding rejects nested layer drift, not only media type and z", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-deck-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posterPath = writeFile(root, "stills/01.png", Buffer.from("poster"));
  const videoPath = writeFile(root, "videos/01.mp4", Buffer.from("video"));
  const hashes = { contentPlan: HASH, visualPlan: HASH, designPlan: HASH, assetManifest: HASH };
  const designPlan = {
    releaseEligibility: "candidate-ready",
    jobId: "deep-binding",
    title: "Deep binding",
    compiledFrom: { contentPlan: HASH, visualPlan: HASH },
    slides: [
      { id: "00", mediaMode: "static-native", layers: [{ id: "title", type: "headline", z: 1, box: { x: 1 }, text: "Bound title" }] },
      { id: "01", mediaMode: "hybrid-video", layers: [{ id: "video-01", type: "video", z: 1, mediaKey: "01", box: { x: 2 }, poster: null, video: null }] },
    ],
  };
  const manifest = {
    jobId: designPlan.jobId,
    upstreamHashes: { contentPlan: HASH, visualPlan: HASH, designPlan: HASH },
    slides: [{
      id: "01", mediaKey: "01", layerId: "video-01",
      poster: { path: "stills/01.png", sha256: sha256File(posterPath), bytes: fs.statSync(posterPath).size },
      video: { path: "videos/01.mp4", sha256: sha256File(videoPath), bytes: fs.statSync(videoPath).size },
    }],
  };
  const deck = compileDeck({ jobDir: root, designPlan, manifest, hashes });
  const contracts = {
    contentPlan: { jobId: designPlan.jobId, planningStatus: "approved" },
    visualPlan: { jobId: designPlan.jobId, planningStatus: "approved", upstreamHashes: { contentPlan: HASH } },
    designPlan,
    assetManifest: manifest,
    deck,
  };
  assert.equal(assertBindings(root, contracts, hashes), designPlan.jobId);
  const drifted = structuredClone(deck);
  drifted.slides[0].layers[0].text = "Unbound mutation";
  assert.throws(() => assertBindings(root, { ...contracts, deck: drifted }, hashes), /fresh deterministic compile/);
});

test("every dynamic media QA record binds the one selected performance-bible candidate", () => {
  const selected = `sha256:${"c".repeat(64)}`;
  const model = { performanceBible: { selectedSha256: selected } };
  const manifest = {
    slides: [
      { qa: { binding: { performanceBibleSha256: selected } } },
      { qa: { binding: { performanceBibleSha256: selected } } },
    ],
  };
  const errors = [];
  validatePerformanceBibleBinding(model, manifest, errors);
  assert.deepEqual(errors, []);
  manifest.slides[1].qa.binding.performanceBibleSha256 = HASH;
  validatePerformanceBibleBinding(model, manifest, errors);
  assert.ok(errors.some((error) => error.code === "PERFORMANCE_BIBLE_DRIFT"));
});

test("candidate release accepts only candidate.staging, revalidates directly, and final is the exact same bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobPath = path.join(root, "job.json");
  const job = packagedJob();
  writeJson(root, "job.json", job);
  const staging = writeFile(root, EXPECTED_STAGING, fakePptx());
  const artifactSha256 = sha256File(staging);
  const report = packageReport(artifactSha256);
  writeJson(root, "qa/package-qa.json", report);
  writeJson(root, "qa/rendered-candidate/render-index.json", { version: 2 });
  writeJson(root, "qa/render-qa.json", {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-render-qa",
    artifactSha256,
    renderIndexPath: "qa/rendered-candidate/render-index.json",
    slideCount: 2,
    passed: true,
  });
  const calls = [];
  const preflightCalls = [];
  const renderRecheckCalls = [];
  const dependencies = {
    preflightImpl: async (options) => {
      preflightCalls.push(options);
      return { status: "ready" };
    },
    renderRecheckImpl: async (_root, _record, options) => {
      renderRecheckCalls.push(options);
      return { passed: true };
    },
    validateJobImpl: () => ({ ok: true, errors: [], currentHashes: {} }),
    validatePptxImpl: async (_root, artifact, options) => {
      calls.push({ artifact, options });
      return { ...report, artifactPath: artifact };
    },
  };
  await assert.rejects(
    () => releaseCandidate(root, jobPath, structuredClone(job), { artifact: "build/other.pptx" }, dependencies),
    /candidate input must be build\/candidate\.staging\.pptx/,
  );
  await releaseCandidate(root, jobPath, job, {}, dependencies);
  assert.equal(calls[0].artifact, EXPECTED_STAGING);
  assert.equal(fs.existsSync(staging), false);
  const candidatePath = path.join(root, "candidate.pptx");
  assert.equal(sha256File(candidatePath), artifactSha256);
  let persisted = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  assert.equal(persisted.state.stage, "candidate-released");
  assert.equal(persisted.release.candidate.playbackVerified, false);

  writeFile(root, "qa/powerpoint-capture.mp4", Buffer.from("capture is validated by the real validator"));
  writeFile(root, "qa/powerpoint-test.log", Buffer.from(`PowerPoint fixture ${artifactSha256}\n`));
  writeJson(root, "qa/powerpoint-verification.json", {
    artifactSha256,
    powerPointVersion: "16.fixture (fixture-build)",
    system: { platform: "macos", osVersion: "fixture", arch: "arm64" },
    capturePath: "qa/powerpoint-capture.mp4",
    captureSha256: sha256File(path.join(root, "qa/powerpoint-capture.mp4")),
    testLogPath: "qa/powerpoint-test.log",
    testLogSha256: sha256File(path.join(root, "qa/powerpoint-test.log")),
    passed: true,
  });
  await releaseFinal(root, jobPath, persisted, {}, dependencies);
  persisted = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  assert.equal(persisted.state.stage, "final-released");
  assert.equal(persisted.release.final.sourceCandidateSha256, artifactSha256);
  assert.equal(sha256File(path.join(root, "final.pptx")), sha256File(candidatePath));
  assert.equal(calls[1].artifact, "candidate.pptx");
  assert.equal(calls[1].options.requireHumanApproval, true);
  assert.deepEqual(preflightCalls.map(({ release }) => release), ["candidate", "final"]);
  assert.equal(renderRecheckCalls.length, 2);
  assert.equal(renderRecheckCalls[0].sourceArtifactPath, undefined);
  assert.equal(renderRecheckCalls[1].sourceArtifactPath, "candidate.pptx");
});

test("release preflight blocks failures and never treats degraded state as external-video substitution", async () => {
  await assert.rejects(
    () => assertReleasePreflight("/tmp/unused", "candidate", {
      preflightImpl: async () => ({ status: "blocked" }),
    }),
    /preflight is blocked/,
  );
  const warnings = [];
  const result = await assertReleasePreflight("/tmp/unused", "candidate", {
    preflightImpl: async () => ({ status: "degraded" }),
    warnImpl: (message) => warnings.push(message),
  });
  assert.equal(result.status, "degraded");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /strict external generate-video evidence/);
});

test("direct report comparison permits only the staging-to-candidate path change during exact-byte promotion", () => {
  const stored = packageReport(HASH, EXPECTED_STAGING);
  const promoted = { ...stored, artifactPath: "candidate.pptx" };
  assert.doesNotThrow(() => compareDirectReport(stored, promoted, { allowPromotedPath: true }));
  assert.throws(() => compareDirectReport(stored, { ...promoted, deckSha256: `sha256:${"b".repeat(64)}` }, { allowPromotedPath: true }), /deckSha256/);
});

test("refresh invalidates from the earliest drift and archives released candidate/final instead of deleting", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = packagedJob();
  job.state.stage = "final-released";
  job.state.status = "complete";
  job.state.completedStages = STAGES.slice(1);
  job.release = emptyRelease();
  const bytes = fakePptx();
  writeFile(root, "candidate.pptx", bytes);
  writeFile(root, "final.pptx", bytes);
  const artifactSha256 = sha256File(path.join(root, "candidate.pptx"));
  job.release.candidate = { status: "released", artifact: "candidate.pptx", sha256: artifactSha256 };
  job.release.final = { status: "released", artifact: "final.pptx", sha256: artifactSha256 };
  job.trackedArtifacts = {
    contentPlan: { path: "content-plan.json", sha256: HASH, stage: "content-planned" },
    designPlan: { path: "design-plan.json", sha256: HASH, stage: "design-planned" },
  };
  const invalidation = invalidateForDrift(job, [
    { key: "designPlan", stage: "design-planned", reason: "changed" },
    { key: "contentPlan", stage: "content-planned", reason: "changed" },
  ], root, "2026-08-20T22:00:00.000Z");
  assert.equal(invalidation.resetStage, "researched");
  assert.equal(invalidation.archiveMoves.length, 2);
  assert.equal(fs.existsSync(path.join(root, "candidate.pptx")), false);
  assert.equal(fs.existsSync(path.join(root, "final.pptx")), false);
  for (const move of invalidation.archiveMoves) {
    assert.ok(move.relativeDestination.startsWith("archive/invalidated/"));
    assert.equal(fs.existsSync(move.destination), true);
  }
});

test("candidate publication re-hashes staging at the rename boundary", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-publish-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = writeFile(root, "candidate.staging.pptx", fakePptx());
  const published = path.join(root, "candidate.pptx");
  assert.throws(
    () => publishWithRollback(staging, published, `sha256:${"f".repeat(64)}`, () => {}),
    /changed after direct validation/,
  );
  assert.equal(fs.existsSync(staging), true);
  assert.equal(fs.existsSync(published), false);
});

test("release boundary snapshots reject changed, added, or symlinked evidence before publication", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-release-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFile(root, "job.json", "{}\n");
  writeFile(root, "qa/evidence.json", "{}\n");
  const snapshot = snapshotReleaseInputs(root);
  assert.doesNotThrow(() => assertReleaseInputsUnchanged(root, snapshot));
  fs.appendFileSync(path.join(root, "qa/evidence.json"), "drift");
  assert.throws(() => assertReleaseInputsUnchanged(root, snapshot), /qa\/evidence\.json/);
  fs.writeFileSync(path.join(root, "qa/evidence.json"), "{}\n");
  fs.symlinkSync(path.join(root, "job.json"), path.join(root, "qa", "link.json"));
  assert.throws(() => snapshotReleaseInputs(root), /symbolic link/);
});

test("final-only receipt drift archives final while preserving the still-valid candidate", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-final-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = packagedJob();
  job.state.stage = "final-released";
  job.state.status = "complete";
  job.state.completedStages = STAGES.slice(1);
  const artifactSha256 = sha256File(writeFile(root, "candidate.pptx", fakePptx()));
  writeFile(root, "final.pptx", fakePptx());
  job.release.candidate = { status: "released", artifact: "candidate.pptx", sha256: artifactSha256 };
  job.release.final = { status: "released", artifact: "final.pptx", sha256: artifactSha256 };
  const invalidation = invalidateForDrift(job, [{ key: "powerpoint-test-log", stage: "final-released", reason: "changed" }], root, "2026-08-20T22:05:00.000Z");
  assert.equal(invalidation.resetStage, "candidate-released");
  assert.deepEqual(invalidation.affectedLevels, ["final"]);
  assert.equal(fs.existsSync(path.join(root, "candidate.pptx")), true);
  assert.equal(fs.existsSync(path.join(root, "final.pptx")), false);
  assert.equal(job.release.candidate.status, "released");
  assert.equal(job.release.final.status, "none");
});

test("render gate requires a versioned numeric EvaluationReceipt bound one-to-one to fully decoded slide PNGs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-render-eval-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trusted = trustedRenderFixture(root);
  const artifactSha256 = sha256File(writeFile(root, EXPECTED_STAGING, fakePptx()));
  const renderedSlides = [1, 2].map((slideNumber) => {
    const relative = `qa/rendered-candidate/slide-${slideNumber}.png`;
    const filePath = writePng(root, relative, slideNumber === 1 ? "0x112233" : "0x334455");
    return { slideNumber, path: relative, sha256: sha256File(filePath), width: 1920, height: 1080, mime: "image/png" };
  });
  const renderIndex = {
    version: 2,
    producer: "ppt-cast/render-pptx-qa@2",
    producerSha256: sha256File(path.join(SCRIPTS, "render_pptx_qa.py")),
    artifactPath: EXPECTED_STAGING,
    artifactSha256,
    slideCount: 2,
    overflowPassed: true,
    renderedSlides,
    renderer: trusted.receipts.renderer,
    slidesTest: trusted.receipts.slidesTest,
    runtime: { python: trusted.receipts.python },
  };
  const indexPath = writeJson(root, "qa/rendered-candidate/render-index.json", renderIndex);
  const renderIndexSha256 = sha256File(indexPath);
  const frameIds = ["slide-1", "slide-2"];
  const evaluatorPath = writeFile(root, "qa/deck-render-evaluator.js", "module.exports = 'deck-render-evaluator-v2';\n");
  const rubricPath = writeJson(root, "qa/deck-render-rubric.json", { id: "deck-render-quality", version: "1.0.0" });
  const evaluation = {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-evaluation",
    createdAt: "2026-08-20T21:00:00.000Z",
    jobId: "render-fixture",
    renderIndexPath: "qa/rendered-candidate/render-index.json",
    renderIndexSha256,
    slideCount: 2,
    subject: { kind: "deck", artifactSha256 },
    evaluator: { id: "deck-render-evaluator", version: "2.0.0", implementationPath: "qa/deck-render-evaluator.js", implementationSha256: sha256File(evaluatorPath) },
    rubric: { id: "deck-render-quality", version: "1.0.0", path: "qa/deck-render-rubric.json", sha256: sha256File(rubricPath), scale: { min: 1, max: 5, passAt: 4 } },
    scores: [
      { criterion: "identity", score: 4.5, evidenceFrameIds: frameIds },
      { criterion: "body-completeness", score: 4.5, evidenceFrameIds: frameIds },
      { criterion: "crop-safety", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "claim-expression", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "typography-hierarchy", score: 4.5, evidenceFrameIds: frameIds },
      { criterion: "motion-continuity", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "composition", score: 4.25, evidenceFrameIds: frameIds },
    ],
    evidenceFrames: renderedSlides.map((slide, index) => ({ id: frameIds[index], path: slide.path, sha256: slide.sha256, sourceArtifactSha256: artifactSha256 })),
    issues: [],
    humanReview: { status: "pending" },
    passed: true,
  };
  const visualPath = writeJson(root, "qa/render-qa.json", evaluation);
  const record = {
    artifactSha256,
    renderIndexPath: "qa/rendered-candidate/render-index.json",
    renderIndexSha256,
    visualQaPath: "qa/render-qa.json",
    visualQaSha256: sha256File(visualPath),
    slideCount: 2,
    passed: true,
  };
  const errors = [];
  validateRenderEvidence(root, record, { actualHash: artifactSha256 }, evaluation.jobId, 2, errors, trusted.options);
  assert.deepEqual(errors, []);
  fs.appendFileSync(trusted.options.trustedRenderTools.renderer.path, "# drift\n");
  const rendererDrift = [];
  validateRenderEvidence(root, record, { actualHash: artifactSha256 }, evaluation.jobId, 2, rendererDrift, trusted.options);
  assert.ok(rendererDrift.some((error) => error.code === "RENDER_IMPLEMENTATION_DRIFT"));
  fs.writeFileSync(trusted.options.trustedRenderTools.renderer.path, "# trusted fixture renderer\n");
  const versionDrift = [];
  validateRenderEvidence(root, record, { actualHash: artifactSha256 }, evaluation.jobId, 2, versionDrift, {
    trustedRenderTools: {
      ...trusted.options.trustedRenderTools,
      slidesTest: { ...trusted.options.trustedRenderTools.slidesTest, version: "wrong-version" },
    },
  });
  assert.ok(versionDrift.some((error) => error.code === "RENDER_IMPLEMENTATION_DRIFT"));
  const noTrustedImplementation = [];
  validateRenderEvidence(root, record, { actualHash: artifactSha256 }, evaluation.jobId, 2, noTrustedImplementation);
  assert.ok(noTrustedImplementation.some((error) => error.code === "RENDER_TRUST_CONFIG"));

  const finalErrors = [];
  validateRenderEvidence(root, record, { actualHash: artifactSha256 }, evaluation.jobId, 2, finalErrors, { ...trusted.options, requireHumanApproval: true });
  assert.ok(finalErrors.some((error) => error.code === "RENDER_HUMAN_APPROVAL"));

  const anonymous = {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-evaluation",
    jobId: evaluation.jobId,
    renderIndexPath: evaluation.renderIndexPath,
    renderIndexSha256,
    slideCount: 2,
    checks: { overflow: true, typography: true, crop: true },
    passed: true,
  };
  writeJson(root, "qa/render-qa.json", anonymous);
  record.visualQaSha256 = sha256File(visualPath);
  const rejected = [];
  validateRenderEvidence(root, record, { actualHash: artifactSha256 }, evaluation.jobId, 2, rejected, trusted.options);
  assert.ok(rejected.some((error) => error.code === "RENDER_LEGACY_BOOLEAN_CHECKS"));

  const corruptPath = writeFile(root, "qa/rendered-candidate/corrupt.png", Buffer.from(PNG_1X1));
  const corrupt = fs.readFileSync(corruptPath);
  corrupt[corrupt.length - 1] ^= 0xff;
  fs.writeFileSync(corruptPath, corrupt);
  const pngErrors = [];
  validateFileDescriptor(root, { path: "qa/rendered-candidate/corrupt.png", sha256: sha256File(corruptPath), width: 1, height: 1 }, "corrupt", pngErrors, "png");
  assert.ok(pngErrors.some((error) => error.code === "INVALID_PNG"));

  const lowResolutionPath = writeFile(root, "qa/rendered-candidate/low-resolution.png", PNG_1X1);
  const lowResolutionErrors = [];
  validateRenderedSlides(root, [{
    slideNumber: 1,
    path: "qa/rendered-candidate/low-resolution.png",
    sha256: sha256File(lowResolutionPath),
    width: 1,
    height: 1,
    mime: "image/png",
  }], 1, "lowResolution", lowResolutionErrors);
  assert.ok(lowResolutionErrors.some((error) => error.code === "RENDER_RESOLUTION"));
});

test("PowerPoint validation rejects short fake captures and only accepts an explicit test-only producer fixture", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-powerpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = writeFile(root, "candidate.pptx", fakePptx());
  const artifactSha256 = sha256File(candidate);
  const capture = path.join(root, "qa", "capture.mp4");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  let run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x223344:s=1920x1080:r=30:d=0.2",
    "-t", "0.2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-an", capture,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const fixtureProducer = writeFile(root, "qa/fixture-powerpoint-producer.py", "# test-only PowerPoint receipt producer\n");
  const producer = {
    id: "deckformance/test-only-powerpoint-producer",
    version: "fixture-v1",
    implementationSha256: sha256File(fixtureProducer),
  };
  const producerOptions = {
    powerPointProducer: { id: producer.id, version: producer.version, path: fixtureProducer },
    allowFixturePowerPointProducer: true,
  };
  const receipt = {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-powerpoint-playback",
    producer,
    jobId: "powerpoint-fixture",
    artifactPath: "candidate.pptx",
    artifactSha256,
    powerPointVersion: "16.fixture (fixture-build)",
    powerPoint: {
      bundleIdentifier: "com.microsoft.Powerpoint",
      shortVersion: "16.fixture",
      bundleVersion: "fixture-build",
      executableSha256: HASH,
      codeSignature: {
        valid: true,
        identifier: "com.microsoft.Powerpoint",
        teamIdentifier: "TESTONLY",
        cdHash: "a".repeat(40),
        authorities: ["Fixture authority — not a real PowerPoint claim"],
      },
    },
    system: { platform: "macos", osVersion: "15.fixture", arch: "arm64" },
    testedAt: "2026-08-20T22:30:00.000Z",
    testedSlideIds: ["01"],
    capturePath: "qa/capture.mp4",
    captureSha256: sha256File(capture),
    testLogPath: "qa/powerpoint-test.log",
    testLogSha256: null,
    playback: {
      autoPlayOnce: true,
      noLoop: true,
      manualAdvance: true,
      forwardNavigationPassed: true,
      backNavigationPassed: true,
      reentryAutoplayOnce: true,
      autoPlayWithinSeconds: 0.4,
    },
    passed: true,
  };
  receipt.testLogPath = "qa/powerpoint-test-log.json";
  const testLogValue = {
    schemaVersion: "2.0.0",
    logType: "deckformance-powerpoint-playback-log",
    jobId: receipt.jobId,
    artifactSha256,
    powerPointVersion: receipt.powerPointVersion,
    completedAt: receipt.testedAt,
    testedSlideIds: ["01"],
    assertions: { ...receipt.playback },
    events: [
      { at: "2026-08-20T22:29:50.000Z", event: "enter", slideId: "01" },
      { at: "2026-08-20T22:29:50.400Z", event: "autoplay-start", slideId: "01" },
      { at: "2026-08-20T22:29:51.000Z", event: "autoplay-end", slideId: "01" },
      { at: "2026-08-20T22:29:52.000Z", event: "forward", slideId: "01" },
      { at: "2026-08-20T22:29:53.000Z", event: "back", slideId: "01" },
      { at: "2026-08-20T22:29:54.000Z", event: "reenter", slideId: "01" },
      { at: "2026-08-20T22:29:54.400Z", event: "reentry-autoplay-start", slideId: "01" },
    ],
  };
  const testLog = writeJson(root, receipt.testLogPath, testLogValue);
  receipt.testLogSha256 = sha256File(testLog);
  const receiptPath = writeJson(root, "qa/powerpoint-verification.json", receipt);
  const record = {
    artifactSha256,
    powerPointVersion: receipt.powerPointVersion,
    system: receipt.system,
    capturePath: receipt.capturePath,
    captureSha256: receipt.captureSha256,
    testLogPath: receipt.testLogPath,
    testLogSha256: receipt.testLogSha256,
    evidencePath: "qa/powerpoint-verification.json",
    evidenceSha256: sha256File(receiptPath),
    passed: true,
  };
  const shortCaptureRejected = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], shortCaptureRejected, producerOptions);
  assert.ok(shortCaptureRejected.some((error) => error.code === "POWERPOINT_CAPTURE"));

  run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x223344:s=1920x1080:r=30:d=5.1",
    "-t", "5.1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p", "-an", capture,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  receipt.captureSha256 = sha256File(capture);
  record.captureSha256 = receipt.captureSha256;
  writeJson(root, "qa/powerpoint-verification.json", receipt);
  record.evidenceSha256 = sha256File(receiptPath);
  const errors = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], errors, producerOptions);
  assert.deepEqual(errors, []);

  const officialReceipt = structuredClone(receipt);
  officialReceipt.producer = {
    id: POWERPOINT_PRODUCER_ID,
    version: POWERPOINT_PRODUCER_VERSION,
    implementationSha256: sha256File(path.join(SCRIPTS, "powerpoint_verify_macos.py")),
  };
  writeJson(root, "qa/powerpoint-verification.json", officialReceipt);
  record.evidenceSha256 = sha256File(receiptPath);
  let liveAttestationCalls = 0;
  const officialErrors = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], officialErrors, {
    powerPointLiveAttestationImpl: () => {
      liveAttestationCalls += 1;
      return { passed: true, errors: [] };
    },
  });
  assert.deepEqual(officialErrors, []);
  assert.equal(liveAttestationCalls, 1);
  const failedLiveErrors = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], failedLiveErrors, {
    powerPointLiveAttestationImpl: () => ({
      passed: false,
      errors: [{ code: "POWERPOINT_LIVE_DRIFT", path: "powerPointReceipt.powerPoint", message: "live app drift" }],
    }),
  });
  assert.ok(failedLiveErrors.some((error) => error.code === "POWERPOINT_LIVE_DRIFT"));
  writeJson(root, "qa/powerpoint-verification.json", receipt);
  record.evidenceSha256 = sha256File(receiptPath);
  const productionGateRejectsFixture = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], productionGateRejectsFixture);
  assert.ok(productionGateRejectsFixture.some((error) => error.code === "POWERPOINT_PRODUCER_DRIFT"));

  const incompleteEvents = structuredClone(testLogValue);
  incompleteEvents.events = incompleteEvents.events.filter((event) => event.event !== "autoplay-end");
  writeJson(root, receipt.testLogPath, incompleteEvents);
  receipt.testLogSha256 = sha256File(testLog);
  record.testLogSha256 = receipt.testLogSha256;
  writeJson(root, "qa/powerpoint-verification.json", receipt);
  record.evidenceSha256 = sha256File(receiptPath);
  const incompleteEventErrors = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], incompleteEventErrors, producerOptions);
  assert.ok(incompleteEventErrors.some((error) => error.code === "POWERPOINT_EVENT_COVERAGE"));

  const slowAutoplay = structuredClone(testLogValue);
  slowAutoplay.events[1].at = "2026-08-20T22:29:51.200Z";
  slowAutoplay.events[2].at = "2026-08-20T22:29:52.000Z";
  slowAutoplay.events[3].at = "2026-08-20T22:29:53.000Z";
  slowAutoplay.events[4].at = "2026-08-20T22:29:54.000Z";
  slowAutoplay.events[5].at = "2026-08-20T22:29:55.000Z";
  slowAutoplay.events[6].at = "2026-08-20T22:29:55.400Z";
  writeJson(root, receipt.testLogPath, slowAutoplay);
  receipt.testLogSha256 = sha256File(testLog);
  record.testLogSha256 = receipt.testLogSha256;
  writeJson(root, "qa/powerpoint-verification.json", receipt);
  record.evidenceSha256 = sha256File(receiptPath);
  const slowAutoplayErrors = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], slowAutoplayErrors, producerOptions);
  assert.ok(slowAutoplayErrors.some((error) => error.code === "POWERPOINT_AUTOPLAY_TIMING"));

  writeJson(root, receipt.testLogPath, testLogValue);
  receipt.testLogSha256 = sha256File(testLog);
  record.testLogSha256 = receipt.testLogSha256;
  receipt.playback.noLoop = false;
  writeJson(root, "qa/powerpoint-verification.json", receipt);
  record.evidenceSha256 = sha256File(receiptPath);
  const rejected = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], rejected, producerOptions);
  assert.ok(rejected.some((error) => error.code === "POWERPOINT_PLAYBACK"));
  receipt.playback.noLoop = true;
  receipt.playback.reentryAutoplayOnce = false;
  writeJson(root, "qa/powerpoint-verification.json", receipt);
  record.evidenceSha256 = sha256File(receiptPath);
  const navigationRejected = [];
  validatePowerPointEvidence(root, record, { actualHash: artifactSha256 }, receipt.jobId, ["01"], navigationRejected, producerOptions);
  assert.ok(navigationRejected.some((error) => error.path.endsWith("reentryAutoplayOnce")));
});

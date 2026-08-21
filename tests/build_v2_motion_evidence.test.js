"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, ".grok", "skills", "ppt-cast");
const SCRIPTS = path.join(SKILL, "scripts");
const REFERENCES = path.join(SKILL, "references");

const {
  DEFAULT_MEDIA_BUDGET,
  assertBudgetReceiptForQa,
  mediaDescriptorSetSha256,
  validateMediaBudget,
} = require(path.join(SCRIPTS, "media_budget"));
const {
  buildPowerPointTimingTree,
  normalizeMotionPlan,
  validateMotionPlan,
  validatePowerPointTimingTree,
} = require(path.join(SCRIPTS, "motion_timing"));
const {
  FRAME_RATIOS,
  evaluationReceiptSha256,
  validateEvaluationReceipt,
} = require(path.join(SCRIPTS, "evaluation_receipt"));
const { sha256File } = require(path.join(SCRIPTS, "runtime", "hash_bound_receipt"));

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function video(id, overrides = {}) {
  return {
    id,
    sha256: sha(id === "video-01" ? "1" : "2"),
    bytes: 6 * 1024 * 1024,
    durationSeconds: 6,
    fps: 24,
    codec: "h264",
    pixelFormat: "yuv420p",
    muted: true,
    audioStreamCount: 0,
    ...overrides,
  };
}

test("media budget validates every final video descriptor and the deck aggregate before QA", () => {
  const videos = [video("video-01"), video("video-02")];
  const receipt = validateMediaBudget(videos, { createdAt: "2026-08-20T20:00:00.000Z" });
  assert.equal(receipt.passed, true, JSON.stringify(receipt.errors));
  assert.equal(receipt.stage, "pre-qa");
  assert.equal(receipt.totals.clipCount, 2);
  assert.equal(receipt.totals.totalBytes, 12 * 1024 * 1024);
  assert.equal(receipt.descriptorSetSha256, mediaDescriptorSetSha256(videos));
  assert.equal(receipt.policy.maxClipBytes, 12 * 1024 * 1024);
  assert.equal(receipt.policy.maxDeckBytes, 100 * 1024 * 1024);
  assert.deepEqual(receipt.policy.allowedFps, [24, 30]);

  assert.equal(
    assertBudgetReceiptForQa(receipt, videos, { qaStartedAt: "2026-08-20T20:01:00.000Z" }),
    receipt,
  );
  assert.throws(
    () => assertBudgetReceiptForQa(receipt, [video("video-01", { sha256: sha("a") }), videos[1]]),
    /changed after media budget validation/,
  );
  assert.throws(
    () => assertBudgetReceiptForQa(receipt, videos, { qaStartedAt: "2026-08-20T19:59:00.000Z" }),
    /must predate the QA run/,
  );
});

test("media budget rejects duration, fps, codec, pixel format, audio, per-clip, and aggregate violations", () => {
  const invalid = validateMediaBudget([
    video("bad", {
      bytes: DEFAULT_MEDIA_BUDGET.maxClipBytes + 1,
      durationSeconds: 11,
      fps: 25,
      codec: "hevc",
      pixelFormat: "yuv444p",
      muted: false,
      audioStreamCount: 1,
    }),
  ]);
  assert.equal(invalid.passed, false);
  assert.deepEqual(
    new Set(invalid.errors.map((error) => error.code)),
    new Set(["CLIP_BUDGET", "DURATION_BUDGET", "FRAME_RATE", "VIDEO_CODEC", "PIXEL_FORMAT", "MUTED_MEDIA", "AUDIO_STREAM"]),
  );

  const tooLarge = validateMediaBudget(
    Array.from({ length: 9 }, (_, index) =>
      video(`deck-${index}`, {
        sha256: `sha256:${index.toString(16).repeat(64)}`,
        bytes: 12 * 1024 * 1024,
      }),
    ),
  );
  assert.equal(tooLarge.passed, false);
  assert.ok(tooLarge.errors.some((error) => error.code === "DECK_BUDGET"));
});

test("motion plan normalizes stable layer targets into a no-loop manual PowerPoint timing tree", () => {
  const plan = {
    durationSeconds: 6.25,
    loopPolicy: "hold-last-frame",
    finalHoldSeconds: 0.75,
    beats: [
      { at: 2.2, action: "perform" },
      { at: 0, action: "enter" },
      { at: 4.5, action: "fade-in", targetLayerId: "metric-primary" },
      { at: 5.5, action: "hold" },
    ],
    camera: {
      movement: "push-in",
      gaze: "audience",
      safeArea: { x: 0.04, y: 0.05, width: 0.92, height: 0.9 },
    },
  };
  const options = {
    videoLayerId: "video-performer",
    layerIds: ["video-performer", "metric-primary"],
    experimentalNativeAnimations: true,
  };
  const normalized = normalizeMotionPlan(plan, options);
  assert.equal(normalized.targetLayerId, "video-performer");
  assert.deepEqual(normalized.beats.map((beat) => beat.at), [0, 2.2, 4.5, 5.5]);
  assert.equal(normalized.beats[2].targetLayerId, "metric-primary");
  assert.deepEqual(normalized.playback, {
    startTrigger: "on-slide-enter",
    startDelayMs: 0,
    playCount: 1,
    restart: "never",
    endBehavior: "hold-last-frame",
    advanceMode: "manual",
  });

  const timing = buildPowerPointTimingTree(normalized);
  assert.equal(timing.targetLayerId, "video-performer");
  assert.equal(timing.durationMs, 6250);
  assert.equal(timing.autoplay.command, "playFrom(0.0)");
  assert.equal(timing.autoplay.playCount, 1);
  assert.equal(timing.mediaNode.fill, "hold");
  assert.equal(timing.loop, false);
  assert.equal(timing.autoAdvance, false);
  assert.equal(timing.advanceMode, "manual");
  assert.deepEqual(validatePowerPointTimingTree(timing), []);
});

test("motion contract rejects looping, auto-advance, unknown targets, and unguarded native animation", () => {
  const base = {
    durationSeconds: 6,
    loopPolicy: "hold-last-frame",
    finalHoldSeconds: 0.5,
    beats: [{ at: 0, action: "enter" }],
  };
  assert.match(validateMotionPlan({ ...base, loop: true }, { videoLayerId: "video-main" }).join("\n"), /loop\/repeat/);
  assert.match(validateMotionPlan({ ...base, autoAdvance: true }, { videoLayerId: "video-main" }).join("\n"), /manual slide advance/);
  assert.match(
    validateMotionPlan({ ...base, beats: [{ at: 1, action: "perform", targetLayerId: "missing" }] }, {
      videoLayerId: "video-main",
      layerIds: ["video-main"],
    }).join("\n"),
    /unknown layer/,
  );
  assert.match(
    validateMotionPlan({ ...base, beats: [{ at: 1, action: "appear", targetLayerId: "native-title" }] }, {
      videoLayerId: "video-main",
      layerIds: ["video-main", "native-title"],
    }).join("\n"),
    /experimentalNativeAnimations/,
  );

  const normalized = normalizeMotionPlan(base, { videoLayerId: "video-main" });
  const timing = buildPowerPointTimingTree(normalized);
  assert.match(validatePowerPointTimingTree({ ...timing, loop: true }).join("\n"), /must not loop/);
  assert.match(
    validatePowerPointTimingTree({ ...timing, autoAdvance: true, advanceMode: "automatic" }).join("\n"),
    /manual slide advance/,
  );
});

function validEvaluationReceipt() {
  const artifactSha256 = sha("a");
  const frameIds = FRAME_RATIOS.map((_, index) => `frame-${index}`);
  return {
    schemaVersion: "2.0.0",
    receiptType: "deckformance-evaluation",
    createdAt: "2026-08-20T20:05:00.000Z",
    subject: {
      kind: "video",
      artifactSha256,
      mediaBudgetReceiptSha256: sha("b"),
    },
    evaluator: {
      id: "deckformance-visual-evaluator",
      version: "2.1.0",
      implementationPath: "qa/evaluator.js",
      implementationSha256: sha("c"),
    },
    rubric: {
      id: "character-motion-quality",
      version: "1.0.0",
      path: "qa/rubric.json",
      sha256: sha("d"),
      scale: { min: 1, max: 5, passAt: 4 },
    },
    scores: [
      { criterion: "identity", score: 4.5, evidenceFrameIds: frameIds },
      { criterion: "body-completeness", score: 4, evidenceFrameIds: frameIds },
      { criterion: "crop-safety", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "claim-expression", score: 4.25, evidenceFrameIds: frameIds },
      { criterion: "motion-continuity", score: 4.25, evidenceFrameIds: frameIds.slice(1) },
    ],
    evidenceFrames: FRAME_RATIOS.map((timeRatio, index) => ({
      id: frameIds[index],
      path: `qa/frames/frame-${index}.png`,
      sha256: `sha256:${(index + 1).toString(16).repeat(64)}`,
      sourceArtifactSha256: artifactSha256,
      timeRatio,
    })),
    issues: [],
    humanReview: {
      status: "approved",
      reviewer: "visual-reviewer-01",
      reviewedAt: "2026-08-20T20:10:00.000Z",
    },
    passed: true,
  };
}

test("EvaluationReceipt binds evaluator, rubric, numeric scores, five frames, artifact, and human review", () => {
  const receipt = validEvaluationReceipt();
  const result = validateEvaluationReceipt(receipt, {
    expectedArtifactSha256: receipt.subject.artifactSha256,
    expectedMediaBudgetReceiptSha256: receipt.subject.mediaBudgetReceiptSha256,
    requireHumanApproval: true,
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.summary, {
    criterionCount: 5,
    evidenceFrameCount: 5,
    blockingIssueCount: 0,
    humanReviewStatus: "approved",
  });
  assert.match(evaluationReceiptSha256(receipt), /^sha256:[a-f0-9]{64}$/);
});

test("formal EvaluationReceipt validation binds current evaluator and rubric bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-evaluation-bindings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "qa"), { recursive: true });
  const evaluatorPath = path.join(root, "qa", "evaluator.js");
  const rubricPath = path.join(root, "qa", "rubric.json");
  fs.writeFileSync(evaluatorPath, "module.exports = 'evaluator-v1';\n");
  fs.writeFileSync(rubricPath, "{\"id\":\"rubric-v1\"}\n");
  const receipt = validEvaluationReceipt();
  receipt.evaluator.implementationSha256 = sha256File(evaluatorPath);
  receipt.rubric.sha256 = sha256File(rubricPath);
  assert.equal(validateEvaluationReceipt(receipt, { evidenceRoot: root }).valid, true);
  fs.appendFileSync(evaluatorPath, "// drift\n");
  const drifted = validateEvaluationReceipt(receipt, { evidenceRoot: root });
  assert.ok(drifted.errors.some((error) => error.code === "IMPLEMENTATION_DRIFT"));
});

test("EvaluationReceipt rejects anonymous all-true maps, stale frames, and hand-written pass claims", () => {
  const anonymous = validateEvaluationReceipt({
    schemaVersion: "2.0.0",
    receiptType: "deckformance-evaluation",
    createdAt: "2026-08-20T20:05:00.000Z",
    checks: { identity: true, framing: true, motion: true },
    passed: true,
  });
  assert.equal(anonymous.valid, false);
  assert.ok(anonymous.errors.some((error) => error.code === "LEGACY_BOOLEAN_CHECKS"));
  assert.ok(anonymous.errors.some((error) => error.code === "EVALUATOR"));
  assert.ok(anonymous.errors.some((error) => error.code === "RUBRIC"));

  const stale = validEvaluationReceipt();
  stale.evidenceFrames[2].sourceArtifactSha256 = sha("e");
  const staleResult = validateEvaluationReceipt(stale);
  assert.equal(staleResult.valid, false);
  assert.ok(staleResult.errors.some((error) => error.code === "FRAME_SOURCE_DRIFT"));

  const duplicated = validEvaluationReceipt();
  duplicated.evidenceFrames[1].sha256 = duplicated.evidenceFrames[0].sha256;
  const duplicatedResult = validateEvaluationReceipt(duplicated);
  assert.equal(duplicatedResult.valid, false);
  assert.ok(duplicatedResult.errors.some((error) => error.code === "FRAME_HASH" && /duplicate/.test(error.message)));

  const incompleteRubric = validEvaluationReceipt();
  incompleteRubric.scores = incompleteRubric.scores.filter((score) => score.criterion !== "claim-expression");
  const incompleteResult = validateEvaluationReceipt(incompleteRubric);
  assert.equal(incompleteResult.valid, false);
  assert.ok(incompleteResult.errors.some((error) => error.code === "CORE_CRITERION" && /claim-expression/.test(error.message)));

  const blocked = validEvaluationReceipt();
  blocked.issues.push({ severity: "P1", code: "CROP", message: "A hand leaves the slot." });
  const blockedResult = validateEvaluationReceipt(blocked);
  assert.equal(blockedResult.valid, false);
  assert.equal(blockedResult.accepted, false);
  assert.ok(blockedResult.errors.some((error) => error.code === "DERIVED_OUTCOME"));
});

test("benchmark suite separates deterministic compiler evidence from real generation evidence", () => {
  const directory = path.join(REFERENCES, "benchmarks");
  const suite = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(suite.tracks).sort(), ["fixed-media", "real-generation"]);
  assert.equal(suite.status, "defined-unexecuted");
  assert.deepEqual(
    suite.benchmarks.map((benchmark) => benchmark.id),
    ["layout-census", "human-bust-to-body", "mascot-cjk", "occlusion-selection", "failure-pack"],
  );
  for (const entry of suite.benchmarks) {
    const benchmark = JSON.parse(fs.readFileSync(path.join(directory, entry.manifest), "utf8"));
    assert.equal(benchmark.benchmarkId, entry.id);
    assert.equal(benchmark.track, entry.track);
    assert.equal(benchmark.status, "defined-unexecuted");
    assert.ok(benchmark.assertions.length >= 4);
    assert.equal(benchmark.releasePolicy.galleryEligible, false);
  }
});

test("historical jobs are inventoried only as immutable legacy-negative regression sources", () => {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(REFERENCES, "benchmarks", "legacy-negative.json"), "utf8"),
  );
  assert.equal(inventory.classification, "legacy-negative");
  assert.match(inventory.claimPolicy, /must never be presented/);
  assert.deepEqual(
    inventory.entries.map((entry) => entry.id),
    ["spacex-intro", "qwen-office", "layout-check", "felt-demo"],
  );
  for (const entry of inventory.entries) {
    assert.ok(entry.sourcePath.startsWith("../jobs/"));
    assert.ok(entry.allowedUse.length > 0);
    assert.ok(entry.negativeReasons.length > 0);
  }
});

test("four executable style packs carry fonts, palette, material, composition, camera, motion, and visual gates", () => {
  const directory = path.join(REFERENCES, "presets");
  const index = JSON.parse(fs.readFileSync(path.join(directory, "style-packs.json"), "utf8"));
  assert.deepEqual(index.stylePacks.map((pack) => pack.id), [
    "felt-yarn",
    "clay",
    "paper-cut",
    "cinematic-miniature",
  ]);
  for (const entry of index.stylePacks) {
    const pack = JSON.parse(fs.readFileSync(path.join(directory, entry.reference), "utf8"));
    assert.equal(pack.stylePackId, entry.id);
    assert.ok(pack.fontStacks.display.length >= 2);
    assert.ok(pack.fontStacks.text.length >= 2);
    assert.match(pack.palette.accent, /^#[A-F0-9]{6}$/);
    assert.ok(pack.material.medium);
    assert.ok(pack.material.forbidden.length >= 4);
    assert.ok(pack.composition.preferredFamilies.length >= 4);
    assert.ok(pack.camera.allowed.length >= 3);
    assert.equal(pack.motion.endBehavior, "hold-last-frame");
    assert.ok(pack.visualBenchmarks.every((criterion) => criterion.minimumScore >= 4));
  }
});

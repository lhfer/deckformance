"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts");
const { assertExternalVideoGeneration, parseArgs } = require(path.join(SCRIPTS, "build_deck_v2"));
const { renderLayer } = require(path.join(SCRIPTS, "layer_renderer_v2"));
const { requiresMediaEvidence, schemaValidators, STAGES, validateProviderReceipt } = require(path.join(SCRIPTS, "validate_job_v2"));

const HASH = `sha256:${"a".repeat(64)}`;
const VIDEO = { path: "videos/01.mp4", sha256: HASH, bytes: 1024 };

function externalReceipt() {
  return {
    receiptVersion: 1,
    kind: "provider",
    producer: {
      name: "test-external-model",
      version: "fixture-1",
      implementationSha256: HASH,
      implementationFiles: [{ path: "qa/provider.js", sha256: HASH, bytes: 12 }],
    },
    runtime: { node: "v-test", platform: "test", arch: "test" },
    inputs: [{ path: "stills/01.png", sha256: HASH, bytes: 512 }],
    outputs: [{ ...VIDEO }],
    metadata: {
      contractVersion: "deckformance.provider-video/1",
      provider: "test-external-model",
      providerVersion: "fixture-1",
      providerClass: "external-video-generation-model",
      adapterClass: "FixtureExternalVideoProviderAdapter",
      transport: "api",
      model: "synthetic-assembly-fixture",
      operation: "generate-video",
      promptSha256: HASH,
      motionPlanSha256: HASH,
      generationRequestSha256: HASH,
      slideId: "01",
      layerId: "01.video.performance",
      seed: null,
      requestId: "fixture-request-01",
      durationMs: 1,
      cost: null,
      providerMetadata: {},
      outputMp4: { ...VIDEO },
      mediaContractValidated: true,
    },
    createdAt: "2026-08-21T00:00:00.000Z",
    receiptSha256: HASH,
  };
}

test("external video receipt schema rejects import, inspect, poster, missing MP4 metadata, and unsupported transport", () => {
  const validate = schemaValidators()["provider-receipt"];
  assert.equal(validate(externalReceipt()), true, JSON.stringify(validate.errors));
  const uppercaseExtension = externalReceipt();
  uppercaseExtension.outputs[0].path = "videos/01.MP4";
  uppercaseExtension.metadata.outputMp4.path = "videos/01.MP4";
  assert.equal(validate(uppercaseExtension), true, JSON.stringify(validate.errors));

  const invalid = [
    (receipt) => { receipt.metadata.operation = "import-video"; },
    (receipt) => { receipt.metadata.operation = "inspect-video"; },
    (receipt) => { receipt.metadata.outputMp4.path = "stills/01.png"; },
    (receipt) => { delete receipt.metadata.outputMp4; },
    (receipt) => { receipt.metadata.transport = "file"; },
    (receipt) => { receipt.metadata.providerClass = "local-programmatic-video"; },
    (receipt) => { receipt.metadata.providerMetadata.syntheticFixture = true; },
    (receipt) => { receipt.metadata.providerMetadata.liveProviderProof = false; },
  ];
  for (const mutate of invalid) {
    const receipt = externalReceipt();
    mutate(receipt);
    assert.equal(validate(receipt), false, "invalid external video provenance must fail schema validation");
  }
});

test("missing canonical video receipt fails closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-external-video-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = [];
  const result = validateProviderReceipt(
    root,
    { path: "qa/missing-video-provider.json", sha256: HASH },
    VIDEO,
    [],
    "videoProvider",
    errors,
    { requireExternalVideoGeneration: true },
  );
  assert.equal(result.externalVideoGenerationVerified, false);
  assert.ok(errors.length > 0);
});

test("video provider receipt is bound to the current slide, layer, and motionPlan", () => {
  const receipt = externalReceipt();
  assert.doesNotThrow(() => assertExternalVideoGeneration(receipt, VIDEO, "video provider", {
    motionPlanSha256: HASH,
    slideId: "01",
    layerId: "01.video.performance",
  }));
  assert.throws(() => assertExternalVideoGeneration(receipt, VIDEO, "video provider", {
    motionPlanSha256: `sha256:${"b".repeat(64)}`,
    slideId: "01",
    layerId: "01.video.performance",
  }), /external generate-video provenance/);
});

test("media-ready state validation activates the external video evidence gate before release", () => {
  assert.equal(requiresMediaEvidence(STAGES.indexOf("design-planned"), false), false);
  assert.equal(requiresMediaEvidence(STAGES.indexOf("media-ready"), false), true);
  assert.equal(requiresMediaEvidence(STAGES.indexOf("packaged"), false), true);
  assert.equal(requiresMediaEvidence(STAGES.indexOf("initialized"), true), true);
});

test("release video rendering requires builder-verified external generation while preview placeholders remain allowed", () => {
  const layer = { id: "01.video.performance", type: "video", box: { x: 0, y: 0, w: 4, h: 4 }, slot: { aspect: "1:1", widthPx: 1080, heightPx: 1080 } };
  const releaseContext = {
    previewMode: false,
    mediaByLayer: new Map([[layer.id, { videoPath: "videos/01.mp4", posterPath: "stills/01.png" }]]),
  };
  assert.throws(
    () => renderLayer({}, {}, layer, releaseContext),
    /no verified external video generation binding/,
  );

  const previewSlide = { addShape() {}, addText() {} };
  assert.doesNotThrow(() => renderLayer(previewSlide, { shapes: { RECTANGLE: "rect" } }, layer, {
    previewMode: true,
    theme: {},
    pres: { shapes: { RECTANGLE: "rect" } },
  }));
});

test("native animation flag cannot substitute for external video generation", () => {
  assert.throws(
    () => parseArgs(["/tmp/job", "/tmp/job/build/candidate.pptx", "--experimental-native-animations"]),
    /not yet materialized into PowerPoint XML/,
  );
});

test("motion_timing is a pure direction/playback module and cannot emit MP4 bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-motion-purity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(SCRIPTS, "motion_timing.js");
  const script = `
    const motion = require(${JSON.stringify(modulePath)});
    const plan = motion.normalizeMotionPlan({
      durationSeconds: 3,
      loopPolicy: "hold-last-frame",
      finalHoldSeconds: 0.5,
      targetLayerId: "content.video",
      beats: [{ at: 0, action: "enter" }, { at: 2.5, action: "hold" }],
      camera: { movement: "static" }
    });
    motion.buildPowerPointTimingTree(plan);
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(root), []);
  const source = fs.readFileSync(modulePath, "utf8");
  assert.doesNotMatch(source, /child_process|ffmpeg|\.mp4\b|writeFile|createWriteStream/);
});

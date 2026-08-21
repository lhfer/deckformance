"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts");
const LAYOUTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "references", "layouts.json");
const COMPILE = path.join(SCRIPTS, "compile_deck.js");
const HASH = `sha256:${"a".repeat(64)}`;

let tempRoot;

function hashFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(jobDir, extra = []) {
  return spawnSync(process.execPath, [COMPILE, jobDir, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function assetDescriptor(filePath, width, height, mime) {
  return {
    path: path.relative(path.dirname(path.dirname(filePath)), filePath).split(path.sep).join("/"),
    sha256: hashFile(filePath),
    bytes: fs.statSync(filePath).size,
    width,
    height,
    mime,
    ...(mime === "video/mp4"
      ? { durationSeconds: 3, codec: "h264", pixelFormat: "yuv420p", muted: true }
      : {}),
  };
}

function makeSlide(id, type, sourceIds, overrides = {}) {
  const videoRequired = type === "content" || type === "closing";
  const evidenceBasis = !videoRequired
    ? "none"
    : sourceIds.length > 1
      ? "mixed"
      : sourceIds[0] === "official"
        ? "public-source"
        : "user-material";
  return {
    id,
    type,
    title: `Title ${id}`,
    body: [`Body ${id} A`, `Body ${id} B`],
    role: `Role ${id}`,
    claim: `Claim ${id}`,
    evidence: [`Evidence ${id}`],
    evidenceBasis,
    transition: `Transition ${id}`,
    takeaway: `Takeaway ${id}`,
    sourceIds,
    videoRequired,
    ...overrides,
  };
}

function visualSlide(id, layoutId, layoutFamily, aspect, widthPx, heightPx) {
  return {
    id,
    visualProposition: `Visual ${id}`,
    required: ["character"],
    optional: [],
    forbidden: ["readable-text"],
    characterPerformance: {
      present: true,
      roleInClaim: "The recurring character demonstrates the claim.",
      action: "A stable full-body presentation gesture.",
    },
    layoutId,
    layoutFamily,
    slot: { aspect, widthPx, heightPx, posterFormat: "png" },
    actionClass: "idle",
    shotPlan: {
      shotType: "full-body",
      bodyVisibility: ["head", "torso", "left-foot", "right-foot"],
      actionEnvelope: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 },
      occlusionReason: null,
      safeCrop: { left: 0.1, top: 0.05, right: 0.9, bottom: 0.95 },
      groundContact: "standing",
      framingRationale: "The full body and support plane explain the action.",
      framingBoundary: "full-body-contained",
      bodyContinuation: "The entire body remains inside the frame with both feet on the support plane.",
      derivedFromSourceCrop: false,
      cutsAtJoints: false,
    },
    generation: {
      stillCandidateCount: 2,
      videoMaxAttempts: 3,
      motionStrategy: "stable",
      noReadableText: true,
    },
  };
}

function manifestSlide(id, poster, video, visualPlanSha256) {
  return {
    id,
    poster,
    video,
    attempts: {
      stills: [
        { id: `${id}-still-a`, path: poster.path, sha256: poster.sha256, status: "selected", reason: "best" },
        { id: `${id}-still-b`, path: poster.path, sha256: poster.sha256, status: "rejected", reason: "duplicate fixture" },
      ],
      videos: [
        { id: `${id}-video-a`, path: video.path, sha256: video.sha256, status: "selected", reason: "best" },
      ],
    },
    qa: {
      passed: true,
      binding: {
        posterSha256: poster.sha256,
        videoSha256: video.sha256,
        performanceBibleSha256: HASH,
        visualPlanSha256,
      },
      frames: [0, 0.2, 0.5, 0.8, 1].map((timeRatio) => ({ ...poster, timeRatio })),
      slotComposite: { ...poster },
      checks: {
        identityConsistent: true,
        requiredBodyPartsVisible: true,
        limbCountStable: true,
        supportContactValid: true,
        actionInsideSafeCrop: true,
        occlusionContinuous: true,
        framingIntentional: true,
        noReadableText: true,
        slotCropSafe: true,
      },
      reviewedAt: "2026-08-20T00:00:00.000Z",
    },
  };
}

function createFixture(name, mutate = () => {}) {
  const jobDir = path.join(tempRoot, name);
  const mediaDir = path.join(jobDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const files = {
    poster02: path.join(mediaDir, "02.png"),
    video02: path.join(mediaDir, "02.mp4"),
    poster03: path.join(mediaDir, "03.png"),
    video03: path.join(mediaDir, "03.mp4"),
  };
  fs.writeFileSync(files.poster02, Buffer.from("poster-square"));
  fs.writeFileSync(files.video02, Buffer.from("video-square"));
  fs.writeFileSync(files.poster03, Buffer.from("poster-wide"));
  fs.writeFileSync(files.video03, Buffer.from("video-wide"));

  const content = {
    schemaVersion: "1.0.0",
    jobId: "compile-fixture",
    upstreamHashes: { brief: HASH },
    thesis: "A deterministic deck",
    narrative: { promise: "p", development: "d", proof: "p", conclusion: "c" },
    coverageMatrix: [
      { mustCover: "Deterministic compilation", slideIds: ["02", "03"], support: "Fixture evidence" },
    ],
    sources: [
      {
        id: "user",
        title: "User brief",
        kind: "user-material",
        url: null,
        publisher: null,
        retrievedAt: null,
        isPrimary: true,
        supports: ["00", "03"],
      },
      {
        id: "official",
        title: "Official source",
        kind: "public-url",
        url: "https://example.com/source",
        publisher: "Example",
        retrievedAt: "2026-08-20T00:00:00.000Z",
        isPrimary: true,
        supports: ["02", "03"],
      },
    ],
    slides: [
      makeSlide("00", "cover", ["user"], { title: "Compiled Deck" }),
      makeSlide("01", "section", []),
      makeSlide("02", "content", ["official"]),
      makeSlide("03", "closing", ["user", "official"]),
    ],
  };
  mutate({ stage: "content", content, files });
  const contentPath = path.join(jobDir, "content-plan.json");
  writeJson(contentPath, content);
  const contentHash = hashFile(contentPath);

  const visual = {
    schemaVersion: "1.0.0",
    jobId: content.jobId,
    upstreamHashes: { brief: HASH, characterModel: HASH, contentPlan: contentHash },
    brandDirection: {
      deckPalette: {
        bg: "#F2F3F5",
        panel: "#0B0D10",
        title: "#F7F7F7",
        body: "#B8B8B8",
        muted: "#7A7A7A",
        accent: "#C8102E",
        ink: "#0B0D10",
        inkMuted: "#5A5A5A",
      },
      sourceSwatches: ["#F2F3F5", "#0B0D10", "#C8102E"],
      typography: {
        title: "PingFang SC",
        body: "PingFang SC",
        number: "Arial",
        rationale: "Readable Chinese body copy with neutral numeric forms.",
      },
      materials: ["metal"],
      lighting: "cinematic",
      motionLanguage: "stable",
    },
    slides: [
      visualSlide("02", "split-left-video", "asymmetric-split-left", "1:1", 1080, 1080),
      visualSlide("03", "top-video", "top-widescreen", "16:9", 1920, 1080),
    ],
  };
  mutate({ stage: "visual", content, visual, files });
  const visualPath = path.join(jobDir, "visual-plan.json");
  writeJson(visualPath, visual);
  const visualHash = hashFile(visualPath);

  const poster02 = assetDescriptor(files.poster02, 1080, 1080, "image/png");
  const video02 = assetDescriptor(files.video02, 1080, 1080, "video/mp4");
  const poster03 = assetDescriptor(files.poster03, 1920, 1080, "image/png");
  const video03 = assetDescriptor(files.video03, 1920, 1080, "video/mp4");
  const manifest = {
    schemaVersion: "1.0.0",
    jobId: content.jobId,
    upstreamHashes: { characterModel: HASH, contentPlan: contentHash, visualPlan: visualHash },
    slides: [
      manifestSlide("02", poster02, video02, visualHash),
      manifestSlide("03", poster03, video03, visualHash),
    ],
  };
  mutate({ stage: "manifest", content, visual, manifest, files });
  writeJson(path.join(jobDir, "asset-manifest.json"), manifest);
  return { jobDir, files, contentHash, visualHash };
}

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-compile-tests-"));
});

after(() => {
  if (tempRoot && fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("compiles structured plans and selected media into deterministic deck and storyboard views", () => {
  const fixture = createFixture("success");
  const result = run(fixture.jobDir);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const deckPath = path.join(fixture.jobDir, "deck.json");
  const storyboardPath = path.join(fixture.jobDir, "storyboard.md");
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  assert.deepEqual(deck.compiledFrom, {
    contentPlan: fixture.contentHash,
    visualPlan: fixture.visualHash,
    assetManifest: hashFile(path.join(fixture.jobDir, "asset-manifest.json")),
    layouts: hashFile(LAYOUTS),
  });
  assert.deepEqual(deck.fonts, { title: "PingFang SC", body: "PingFang SC", number: "Arial" });
  assert.equal(deck.palette.accent, "#C8102E");
  assert.deepEqual(deck.slides.map((slide) => slide.layoutId), ["title-card", "title-card", "split-left-video", "top-video"]);
  assert.equal(deck.slides[0].poster, undefined);
  assert.equal(deck.slides[2].poster, "media/02.png");
  assert.equal(deck.slides[2].video, "media/02.mp4");
  assert.equal(deck.slides[2].number, "01");
  assert.equal(deck.slides[3].number, "02");
  assert.deepEqual(deck.slides[2].body, ["Body 02 A", "Body 02 B"]);
  assert.match(deck.slides[2].speakerNotes, /Claim: Claim 02/);
  assert.deepEqual(deck.slides[2].sources, [
    {
      id: "official",
      title: "Official source",
      kind: "public-url",
      url: "https://example.com/source",
      publisher: "Example",
      retrievedAt: "2026-08-20T00:00:00.000Z",
      isPrimary: true,
      supports: ["02", "03"],
    },
  ]);
  const storyboard = fs.readFileSync(storyboardPath, "utf8");
  assert.match(storyboard, /## 03 · 02 · content/);
  assert.match(storyboard, /Visual proposition: Visual 02/);
  assert.match(storyboard, /Official source — https:\/\/example\.com\/source/);
});

test("fails when job IDs are not aligned", () => {
  const fixture = createFixture("job-id", ({ stage, manifest }) => {
    if (stage === "manifest") manifest.jobId = "another-job";
  });
  const result = run(fixture.jobDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /jobId .* does not match/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "deck.json")), false);
});

test("fails when visual and manifest slide IDs do not exactly follow content order", () => {
  const fixture = createFixture("slide-id", ({ stage, visual }) => {
    if (stage === "visual") visual.slides.reverse();
  });
  const result = run(fixture.jobDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IDs must exactly match video-required content order/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "deck.json")), false);
});

test("fails when layoutId and layoutFamily disagree", () => {
  const fixture = createFixture("layout-family", ({ stage, visual }) => {
    if (stage === "visual") visual.slides[0].layoutFamily = "top-widescreen";
  });
  const result = run(fixture.jobDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /layout family mismatch/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "storyboard.md")), false);
});

test("fails when slot dimensions or declared aspect differ from the selected layout", () => {
  const fixture = createFixture("layout-aspect", ({ stage, visual }) => {
    if (stage === "visual") {
      visual.slides[0].slot.aspect = "16:9";
      visual.slides[0].slot.widthPx = 1920;
      visual.slides[0].slot.heightPx = 1080;
    }
  });
  const result = run(fixture.jobDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /slot aspect .*layout/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "deck.json")), false);
});

test("missing selected media fails before publication and preserves existing outputs", () => {
  const fixture = createFixture("missing-media");
  const deckPath = path.join(fixture.jobDir, "deck.json");
  const storyboardPath = path.join(fixture.jobDir, "storyboard.md");
  fs.writeFileSync(deckPath, "existing deck sentinel\n");
  fs.writeFileSync(storyboardPath, "existing storyboard sentinel\n");
  fs.unlinkSync(fixture.files.video03);

  const result = run(fixture.jobDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /video\.path not found/);
  assert.equal(fs.readFileSync(deckPath, "utf8"), "existing deck sentinel\n");
  assert.equal(fs.readFileSync(storyboardPath, "utf8"), "existing storyboard sentinel\n");
});

test("refuses media whose manifest QA is absent, failed, or bound to another visual plan", () => {
  const fixture = createFixture("stale-manifest-qa", ({ stage, manifest }) => {
    if (stage === "manifest") manifest.slides[0].qa.binding.visualPlanSha256 = HASH;
  });
  const result = run(fixture.jobDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest QA does not bind the current visual plan/);
  assert.equal(fs.existsSync(path.join(fixture.jobDir, "deck.json")), false);
});

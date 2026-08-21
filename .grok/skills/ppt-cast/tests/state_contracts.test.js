#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const skillDir = path.resolve(__dirname, "..");
const validatorPath = path.join(skillDir, "scripts", "validate_job.js");
const jobctlPath = path.join(skillDir, "scripts", "jobctl.js");
const builderPath = path.join(skillDir, "scripts", "build_deck.js");
const pptxValidatorPath = path.join(skillDir, "scripts", "validate_pptx.js");
const {
  STAGES,
  sha256File,
  validateJob,
} = require(validatorPath);
const { publishWithRollback, invalidateForDrift, commitInvalidation } = require(jobctlPath);

function writeFile(root, relativePath, data) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

function writeJson(root, relativePath, value) {
  return writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fakePng(width, height, marker = 0) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  buffer[32] = marker;
  return buffer;
}

function fakeMp4(corrupt = false) {
  if (corrupt) return Buffer.from("this is not an mp4");
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(24, 0);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  buffer.write("isomiso2avc1", 16, "ascii");
  return buffer;
}

function fakePptx() {
  return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
}

function basicDescriptor(root, relativePath, data) {
  const target = writeFile(root, relativePath, data);
  return { path: relativePath, sha256: sha256File(target) };
}

function pngDescriptor(root, relativePath, width = 720, height = 720, marker = 0) {
  const target = writeFile(root, relativePath, fakePng(width, height, marker));
  return {
    path: relativePath,
    sha256: sha256File(target),
    bytes: fs.statSync(target).size,
    width,
    height,
    mime: "image/png",
  };
}

function videoDescriptor(root, relativePath, corrupt = false, width = 720, height = 720) {
  const target = writeFile(root, relativePath, fakeMp4(corrupt));
  return {
    path: relativePath,
    sha256: sha256File(target),
    bytes: fs.statSync(target).size,
    width,
    height,
    mime: "video/mp4",
    durationSeconds: 6,
    codec: "h264",
    pixelFormat: "yuv420p",
    muted: true,
  };
}

function writeRenderIndex(root, directory, artifactPath, artifactSha256, renderedSlides) {
  const relativePath = `${directory}/render-index.json`;
  const indexPath = writeJson(root, relativePath, {
    version: 1,
    producer: "ppt-cast/render-pptx-qa@1",
    artifactPath,
    artifactSha256,
    slideCount: renderedSlides.length,
    overflowPassed: true,
    renderedSlides,
    renderer: "/trusted/presentations/container_tools/render_slides.py",
    slidesTest: "/trusted/presentations/container_tools/slides_test.py",
  });
  return { renderIndexPath: relativePath, renderIndexSha256: sha256File(indexPath) };
}

function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-state-"));
  const jobId = "minimal-job";
  const sourceReference = basicDescriptor(root, "inputs/source.png", fakePng(600, 600));

  const brief = {
    schemaVersion: "1.0.0",
    jobId,
    topic: "Reusable rockets",
    audience: { description: "General technology audience", knowledgeLevel: "mixed" },
    purpose: "Explain the operating model",
    coreMessage: "Reuse changes launch economics",
    mustCover: ["recovery", "reflying"],
    brand: { name: "Space company", attributes: ["precise", "bold"], assetPaths: [], colorGuidance: "dark neutral and red" },
    creativeDirection: { language: "English", desiredStyle: "cinematic felt character performance", mood: ["bold", "precise"], energy: "high", avoid: ["rigid templates"] },
    sourcePolicy: { allowPublicResearch: true, preferPrimarySources: true, privateMaterialMayLeaveJob: false },
    requestedPageCount: 2,
    sourceMaterials: [],
  };
  const briefPath = writeJson(root, "brief.json", brief);
  const briefHash = sha256File(briefPath);

  const contentPlan = {
    schemaVersion: "1.0.0",
    jobId,
    upstreamHashes: { brief: briefHash },
    thesis: "Recovery turns a rocket stage into a reusable transport asset.",
    narrative: {
      promise: "Show why reuse matters",
      development: "Explain landing",
      proof: "Connect reuse with cadence",
      conclusion: "Treat launch as transport",
    },
    coverageMatrix: [
      { mustCover: "recovery", slideIds: ["01"], support: "The landing mechanism is the page claim." },
      { mustCover: "reflying", slideIds: ["01"], support: "The page takeaway connects recovery to reuse." },
    ],
    sources: [
      { id: "inference-1", title: "Reasoning from user brief", kind: "inference", url: null, publisher: null, retrievedAt: null, isPrimary: false, supports: ["01"] },
    ],
    slides: [
      {
        id: "00",
        type: "cover",
        title: "Reusable rockets",
        body: ["Recovery changes the operating model."],
        role: "promise",
        claim: "Rockets can become transport",
        evidence: ["The deck will show recovery and reflying"],
        evidenceBasis: "none",
        transition: "Move from promise to mechanism",
        takeaway: "Reuse is the thesis",
        sourceIds: [],
        videoRequired: false,
      },
      {
        id: "01",
        type: "content",
        title: "Land it. Fly it again.",
        body: ["Recovery preserves the first stage.", "Inspection turns it into reusable transport."],
        role: "proof",
        claim: "A recovered first stage can fly again",
        evidence: ["Landing preserves the stage for inspection and reflying"],
        evidenceBasis: "inference",
        transition: "Close on the operating implication",
        takeaway: "The stage is no longer a consumable",
        sourceIds: ["inference-1"],
        videoRequired: true,
      },
    ],
  };
  const contentPath = writeJson(root, "content-plan.json", contentPlan);
  const contentHash = sha256File(contentPath);

  const identity = basicDescriptor(root, "bible/identity.png", fakePng(512, 512, 1));
  const performanceA = basicDescriptor(root, "bible/performance-a.png", fakePng(720, 900, 2));
  const performanceB = basicDescriptor(root, "bible/performance-b.png", fakePng(720, 900, 3));
  const sideAction = basicDescriptor(root, "bible/side-action.png", fakePng(720, 900, 4));
  const fullParts = [
    "head", "torso", "left-arm", "right-arm", "left-hand", "right-hand",
    "left-leg", "right-leg", "left-foot", "right-foot",
  ];
  const characterModel = {
    schemaVersion: "1.0.0",
    jobId,
    upstreamHashes: { brief: briefHash },
    subjectKind: "human",
    sourceReference,
    referenceDiagnostic: {
      coverage: "half-body",
      subjectCount: 1,
      selectedSubject: "the only person",
      selectionConfidence: options.lowConfidence ? 0.6 : 0.99,
      faceClarity: options.lowFace ? "low" : "high",
      viewAngle: options.rearView ? "rear" : "three-quarter",
      occlusions: [],
      visibleClothing: ["black jacket"],
      missingBodyParts: ["left-leg", "right-leg", "left-foot", "right-foot"],
      backgroundEntanglement: false,
    },
    identityLock: ["face", "hair", "black jacket", "felt material"],
    identityBible: { ...identity, qaPassed: true },
    performanceBible: {
      candidates: [
        { id: "a", ...performanceA, qa: { identityConsistency: 0.96, bodyCompleteness: 0.99, proportionStability: 0.95, animatability: 0.96, passed: true } },
        { id: "b", ...performanceB, qa: { identityConsistency: 0.91, bodyCompleteness: 0.98, proportionStability: 0.93, animatability: 0.94, passed: true } },
      ],
      selectedCandidateId: "a",
      selectedSha256: performanceA.sha256,
      sideActionReference: { ...sideAction, qaPassed: true },
      bodyDesign: {
        stature: "tall adult with a stable upright stance",
        proportionNotes: "natural seven-head proportion with grounded center of mass",
        clothing: ["black jacket", "black trousers"],
        footwearOrBase: "plain black closed shoes with visible soles",
        handsOrExtremities: "two complete hands with five fingers each",
        silhouette: "clean shoulder line tapering to full legs and shoes",
        designedCompletions: ["trousers and shoes inferred because the source ends at the waist"],
      },
      fullBodyProfile: {
        coverage: options.halfBodyPerformance ? "half-body" : "full-body",
        requiredParts: fullParts,
        visibleParts: options.halfBodyPerformance ? fullParts.slice(0, 6) : fullParts,
        missingParts: options.halfBodyPerformance ? ["left-leg", "right-leg", "left-foot", "right-foot"] : [],
        limbEndpointsVisible: !options.halfBodyPerformance,
        supportContactVisible: !options.halfBodyPerformance,
        groundContactStable: !options.halfBodyPerformance,
        headToBodyRatio: 0.14,
        safeMarginPercent: 10,
      },
      qa: { identityConsistent: true, bodyComplete: true, proportionsStable: true, animatable: true, passed: true },
    },
    promptPolicy: {
      preserve: ["identity", "clothing", "material", "body proportions"],
      doNotCopyFromSource: ["crop", "pose", "background", "subject-scale", "camera-distance"],
    },
    cropPolicy: {
      allowed: ["full-body", "three-quarter", "waist-up", "close-up"],
      forbiddenJoints: ["neck", "shoulder", "elbow", "wrist", "waist", "hip", "knee", "ankle"],
    },
  };
  const characterPath = writeJson(root, "character-model.json", characterModel);
  const characterHash = sha256File(characterPath);

  const visualPlan = {
    schemaVersion: "1.0.0",
    jobId,
    upstreamHashes: { brief: briefHash, characterModel: characterHash, contentPlan: contentHash },
    brandDirection: {
      deckPalette: {
        bg: "#F2F3F5", panel: "#0B0D10", title: "#F7F7F7", body: "#B8B8B8",
        muted: "#7A7A7A", accent: "#C8102E", ink: "#0B0D10", inkMuted: "#5A5A5A",
      },
      sourceSwatches: ["#F2F3F5", "#0B0D10", "#C8102E"],
      typography: { title: "Aptos Display", body: "Aptos", number: "Arial", rationale: "Readable Latin typography with a strong display hierarchy." },
      materials: ["felt"],
      lighting: "high contrast launch light",
      motionLanguage: "stable action with one completed gesture",
    },
    slides: [
      {
        id: "01",
        visualProposition: "A complete character guides a recovered stage onto its landing legs.",
        required: ["complete character", "landing legs", "support surface"],
        optional: ["launch glow"],
        forbidden: ["readable-text", "missing limbs", "waist emerging from ground"],
        characterPerformance: { present: true, roleInClaim: "Guides the recovered stage to a stable landing", action: "Walks alongside and signals touchdown" },
        layoutId: options.portrait ? "character-stage-left" : "split-left-video",
        layoutFamily: options.portrait ? "character-stage-left" : "asymmetric-split-left",
        slot: options.portrait
          ? { aspect: "9:16", widthPx: 1080, heightPx: 1920, posterFormat: "png" }
          : { aspect: "1:1", widthPx: 720, heightPx: 720, posterFormat: "png" },
        actionClass: "locomotion",
        shotPlan: {
          shotType: "full-body",
          bodyVisibility: fullParts,
          actionEnvelope: { left: 0.15, top: 0.1, right: 0.85, bottom: 0.9 },
          occlusionReason: null,
          safeCrop: { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 },
          groundContact: "standing",
          framingRationale: "The walking action and landing scale require both feet and their support plane.",
          framingBoundary: "full-body-contained",
          bodyContinuation: "The complete figure, both shoes, and support plane remain inside the frame.",
          derivedFromSourceCrop: false,
          cutsAtJoints: false,
        },
        generation: { stillCandidateCount: 2, videoMaxAttempts: 3, motionStrategy: "stable", noReadableText: true },
      },
    ],
  };
  const visualPath = writeJson(root, "visual-plan.json", visualPlan);
  const visualHash = sha256File(visualPath);

  const mediaWidth = options.portrait ? 1080 : 720;
  const mediaHeight = options.portrait ? 1920 : 720;
  const poster = pngDescriptor(root, "stills/01.png", mediaWidth, mediaHeight, 5);
  const rejectedStill = basicDescriptor(root, "stills/01-b.png", fakePng(mediaWidth, mediaHeight, 6));
  const video = videoDescriptor(root, "videos/01.mp4", options.corruptVideo, mediaWidth, mediaHeight);
  const frames = [0, 0.2, 0.5, 0.8, 1].map((timeRatio, index) => ({
    ...pngDescriptor(root, `qa/01/frame-${index + 1}.png`, mediaWidth, mediaHeight, 10 + index),
    timeRatio,
  }));
  const slotComposite = pngDescriptor(root, "qa/01/slot-composite.png", mediaWidth, mediaHeight, 20);
  const assetManifest = {
    schemaVersion: "1.0.0",
    jobId,
    upstreamHashes: { characterModel: characterHash, contentPlan: contentHash, visualPlan: visualHash },
    slides: [
      {
        id: "01",
        poster,
        video,
        attempts: {
          stills: [
            { id: "still-a", path: poster.path, sha256: poster.sha256, status: "selected", reason: "best composition" },
            { id: "still-b", path: rejectedStill.path, sha256: rejectedStill.sha256, status: "rejected", reason: "weaker silhouette" },
          ],
          videos: [
            { id: "video-a", path: video.path, sha256: video.sha256, status: "selected", reason: "all gates passed" },
          ],
        },
        qa: {
          passed: true,
          binding: {
            posterSha256: poster.sha256,
            videoSha256: video.sha256,
            performanceBibleSha256: performanceA.sha256,
            visualPlanSha256: visualHash,
          },
          frames,
          slotComposite,
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
          reviewedAt: "2026-08-20T12:00:00.000Z",
        },
      },
    ],
  };
  const manifestPath = writeJson(root, "asset-manifest.json", assetManifest);
  const manifestHash = sha256File(manifestPath);

  const layoutsHash = sha256File(path.join(skillDir, "references", "layouts.json"));
  const deck = {
    schemaVersion: "1.0.0",
    jobId,
    title: "Reusable rockets",
    releaseLevel: "candidate",
    compiledFrom: { contentPlan: contentHash, visualPlan: visualHash, assetManifest: manifestHash, layouts: layoutsHash },
    fonts: { title: visualPlan.brandDirection.typography.title, body: visualPlan.brandDirection.typography.body, number: visualPlan.brandDirection.typography.number },
    palette: visualPlan.brandDirection.deckPalette,
    media: { videoVolume: 0 },
    slides: [
      {
        id: "00",
        layoutId: "title-card",
        kicker: contentPlan.slides[0].role,
        number: "",
        title: contentPlan.slides[0].title,
        body: contentPlan.slides[0].body,
        speakerNotes: "Claim: Rockets can become transport.",
        sources: [],
      },
      {
        id: "01",
        layoutId: visualPlan.slides[0].layoutId,
        kicker: contentPlan.slides[1].role,
        number: "01",
        title: contentPlan.slides[1].title,
        body: contentPlan.slides[1].body,
        speakerNotes: "Claim: A recovered first stage can fly again.",
        sources: [contentPlan.sources[0]],
        poster: poster.path,
        video: video.path,
        videoVolume: 0,
      },
    ],
  };
  const deckPath = writeJson(root, "deck.json", deck);
  const deckHash = sha256File(deckPath);
  const candidatePath = writeFile(root, "build/candidate.staging.pptx", fakePptx());
  const candidateHash = sha256File(candidatePath);
  const packageEvidence = {
    artifactSha256: candidateHash,
    deckSha256: deckHash,
    expectedContentPages: 1,
    embeddedVideoCount: 1,
    posterCount: 1,
    timingCount: 1,
    relationshipsValid: true,
    mimeTypesValid: true,
    aspectRatiosValid: true,
    passed: true,
  };
  const packageEvidencePath = writeJson(root, "qa/package-qa.json", packageEvidence);
  const renderedSlides = [1, 2].map((slideNumber) => {
    const rendered = pngDescriptor(root, `qa/rendered-candidate/slide-${slideNumber}.png`, 1600, 900, 30 + slideNumber);
    return { slideNumber, path: rendered.path, sha256: rendered.sha256, width: rendered.width, height: rendered.height, mime: rendered.mime };
  });
  const renderIndexRelative = "qa/rendered-candidate/render-index.json";
  const renderIndexPath = writeJson(root, renderIndexRelative, {
    version: 1,
    producer: "ppt-cast/render-pptx-qa@1",
    artifactPath: "build/candidate.staging.pptx",
    artifactSha256: candidateHash,
    slideCount: 2,
    overflowPassed: true,
    renderedSlides,
    renderer: "/trusted/presentations/container_tools/render_slides.py",
    slidesTest: "/trusted/presentations/container_tools/slides_test.py",
  });
  const renderEvidence = {
    artifactSha256: candidateHash,
    slideCount: 2,
    renderIndexPath: renderIndexRelative,
    renderIndexSha256: sha256File(renderIndexPath),
    renderedSlides,
    allSlidesInspected: true,
    overflowPassed: true,
    textWrapPassed: true,
    cropPassed: true,
    mediaPosterPassed: true,
    layoutRhythmPassed: true,
    passed: true,
  };
  const renderEvidencePath = writeJson(root, "qa/render-qa.json", renderEvidence);
  const timestamp = "2026-08-20T12:00:00.000Z";
  const qaStageIndex = STAGES.indexOf("qa-passed");
  const job = {
    schemaVersion: "1.0.0",
    jobId,
    state: {
      stage: "qa-passed",
      status: "active",
      completedStages: STAGES.slice(1, qaStageIndex + 1),
      invalidatedStages: [],
      updatedAt: timestamp,
      history: [],
    },
    artifacts: {
      brief: "brief.json",
      characterModel: "character-model.json",
      contentPlan: "content-plan.json",
      visualPlan: "visual-plan.json",
      assetManifest: "asset-manifest.json",
      deck: "deck.json",
    },
    trackedArtifacts: {
      brief: { path: "brief.json", sha256: briefHash, stage: "briefed" },
      contentPlan: { path: "content-plan.json", sha256: contentHash, stage: "content-planned" },
      characterModel: { path: "character-model.json", sha256: characterHash, stage: "character-ready" },
      visualPlan: { path: "visual-plan.json", sha256: visualHash, stage: "visual-planned" },
      assetManifest: { path: "asset-manifest.json", sha256: manifestHash, stage: "videos-ready" },
      deck: { path: "deck.json", sha256: deckHash, stage: "packaged" },
    },
    release: {
      candidate: {
        status: "none",
        artifact: "build/candidate.staging.pptx",
        sha256: candidateHash,
        validatedAt: null,
        playbackVerified: false,
        packageQa: {
          artifactSha256: candidateHash,
          ...packageEvidence,
          evidencePath: "qa/package-qa.json",
          evidenceSha256: sha256File(packageEvidencePath),
        },
        renderQa: {
          ...renderEvidence,
          evidencePath: "qa/render-qa.json",
          evidenceSha256: sha256File(renderEvidencePath),
        },
      },
      final: {
        status: "none",
        artifact: null,
        sha256: null,
        validatedAt: null,
        packageQa: null,
        renderQa: null,
        powerPointVerification: null,
      },
    },
  };
  writeJson(root, "job.json", job);
  return { root, job, poster, video, deckHash };
}

function materializeRealCandidate(fixture) {
  const posterPath = path.join(fixture.root, "stills", "01.png");
  const videoPath = path.join(fixture.root, "videos", "01.mp4");
  let run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=1080x1080:d=0.2",
    "-frames:v", "1", "-c:v", "png", posterPath,
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=1080x1080:d=0.3",
    "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", videoPath,
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  const manifestPath = path.join(fixture.root, "asset-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const posterHash = sha256File(posterPath);
  const videoHash = sha256File(videoPath);
  manifest.slides[0].poster = { path: "stills/01.png", sha256: posterHash, bytes: fs.statSync(posterPath).size, width: 1080, height: 1080, mime: "image/png" };
  manifest.slides[0].video = { path: "videos/01.mp4", sha256: videoHash, bytes: fs.statSync(videoPath).size, width: 1080, height: 1080, mime: "video/mp4", durationSeconds: 0.3, codec: "h264", pixelFormat: "yuv420p", muted: true };
  manifest.slides[0].attempts.stills[0].sha256 = posterHash;
  manifest.slides[0].attempts.videos[0].sha256 = videoHash;
  manifest.slides[0].qa.binding.posterSha256 = posterHash;
  manifest.slides[0].qa.binding.videoSha256 = videoHash;
  writeJson(fixture.root, "asset-manifest.json", manifest);
  const manifestHash = sha256File(manifestPath);
  const deckPath = path.join(fixture.root, "deck.json");
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  deck.compiledFrom.assetManifest = manifestHash;
  writeJson(fixture.root, "deck.json", deck);
  const deckHash = sha256File(deckPath);
  fixture.deckHash = deckHash;
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.trackedArtifacts.assetManifest.sha256 = manifestHash;
  job.trackedArtifacts.deck.sha256 = deckHash;
  writeJson(fixture.root, "job.json", job);
  const stagingPath = path.join(fixture.root, "build", "candidate.staging.pptx");
  run = spawnSync(process.execPath, [builderPath, deckPath, stagingPath, "--release", "candidate"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  const packageQaPath = path.join(fixture.root, "qa/package-qa.json");
  run = spawnSync(process.execPath, [pptxValidatorPath, stagingPath, "--deck", deckPath, "--release", "candidate", "--report", packageQaPath], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  const actualHash = sha256File(stagingPath);
  const renderQa = JSON.parse(fs.readFileSync(path.join(fixture.root, "qa/render-qa.json"), "utf8"));
  renderQa.artifactSha256 = actualHash;
  const renderIndexPath = path.join(fixture.root, ...renderQa.renderIndexPath.split("/"));
  const renderIndex = JSON.parse(fs.readFileSync(renderIndexPath, "utf8"));
  renderIndex.artifactSha256 = actualHash;
  writeJson(fixture.root, renderQa.renderIndexPath, renderIndex);
  renderQa.renderIndexSha256 = sha256File(renderIndexPath);
  writeJson(fixture.root, "qa/render-qa.json", renderQa);
  return { actualHash, deckHash, stagingPath };
}

function errorCodes(result) {
  return new Set(result.errors.map((error) => error.code));
}

test("all schema files parse and declare schema version 1.0.0", () => {
  const schemaDir = path.join(skillDir, "schemas");
  const expected = ["brief", "character-model", "content-plan", "visual-plan", "asset-manifest", "deck", "job"];
  for (const name of expected) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, `${name}.schema.json`), "utf8"));
    assert.equal(schema.properties.schemaVersion.const, "1.0.0");
  }
});

test("runtime schema validation rejects unknown enum values before release", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const characterPath = path.join(fixture.root, "character-model.json");
  const character = JSON.parse(fs.readFileSync(characterPath, "utf8"));
  character.subjectKind = "unknown-cyborg-kind";
  writeJson(fixture.root, "character-model.json", character);
  let result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("SCHEMA_VALIDATION"), true);
  assert.ok(result.errors.some((error) => error.code === "SCHEMA_VALIDATION" && error.path.includes("subjectKind")));

  writeJson(fixture.root, "character-model.json", { ...character, subjectKind: "human" });
  const visualPath = path.join(fixture.root, "visual-plan.json");
  const visual = JSON.parse(fs.readFileSync(visualPath, "utf8"));
  visual.slides[0].actionClass = "teleport-through-floor";
  writeJson(fixture.root, "visual-plan.json", visual);
  result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "SCHEMA_VALIDATION" && error.path.includes("actionClass")));
});

test("minimal candidate passes with half-body source after full-body adaptation", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("1080x1920 portrait character-stage media is valid 1080p class", (t) => {
  const fixture = makeFixture({ portrait: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("legacy half-body performance bible is a hard failure", (t) => {
  const fixture = makeFixture({ halfBodyPerformance: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("HALF_BODY_PERFORMANCE_MODEL"), true);
});

test("low-resolution or rear-only human identity evidence is rejected", (t) => {
  const lowFace = makeFixture({ lowFace: true });
  const rear = makeFixture({ rearView: true });
  t.after(() => fs.rmSync(lowFace.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(rear.root, { recursive: true, force: true }));
  assert.equal(errorCodes(validateJob(lowFace.root, { releaseLevel: "candidate" })).has("IDENTITY_EVIDENCE"), true);
  assert.equal(errorCodes(validateJob(rear.root, { releaseLevel: "candidate" })).has("IDENTITY_EVIDENCE"), true);
});

test("low-confidence subject selection is rejected for any reference", (t) => {
  const fixture = makeFixture({ lowConfidence: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(errorCodes(validateJob(fixture.root, { releaseLevel: "candidate" })).has("AMBIGUOUS_SUBJECT"), true);
});

test("coverage matrix cannot omit a brief must-cover item", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const contentPath = path.join(fixture.root, "content-plan.json");
  const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
  content.coverageMatrix.pop();
  writeJson(fixture.root, "content-plan.json", content);
  assert.equal(errorCodes(validateJob(fixture.root, { releaseLevel: "candidate" })).has("COVERAGE_MATRIX"), true);
});

test("brand asset paths require matching hashed source-material descriptors", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const briefPath = path.join(fixture.root, "brief.json");
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  brief.brand.assetPaths = ["inputs/logo.png"];
  writeJson(fixture.root, "brief.json", brief);
  assert.equal(errorCodes(validateJob(fixture.root, { releaseLevel: "candidate" })).has("BRAND_ASSET_BINDING"), true);
});

test("a content slide cannot claim user support with an empty source list", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const contentPath = path.join(fixture.root, "content-plan.json");
  const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
  content.slides[1].sourceIds = [];
  writeJson(fixture.root, "content-plan.json", content);
  assert.equal(errorCodes(validateJob(fixture.root, { releaseLevel: "candidate" })).has("SOURCE_REQUIRED"), true);
});

test("passed performance candidates cannot carry sub-threshold scores", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const modelPath = path.join(fixture.root, "character-model.json");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  model.performanceBible.candidates[0].qa.bodyCompleteness = 0.7;
  writeJson(fixture.root, "character-model.json", model);
  assert.equal(errorCodes(validateJob(fixture.root, { releaseLevel: "candidate" })).has("CANDIDATE_SCORE"), true);
});

test("selected performance candidate must have the highest weighted passing score", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const modelPath = path.join(fixture.root, "character-model.json");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  Object.assign(model.performanceBible.candidates[1].qa, {
    identityConsistency: 1,
    bodyCompleteness: 1,
    proportionStability: 1,
    animatability: 1,
  });
  writeJson(fixture.root, "character-model.json", model);
  assert.equal(errorCodes(validateJob(fixture.root, { releaseLevel: "candidate" })).has("SELECTED_CANDIDATE_SCORE"), true);
});

test("duplicate candidate or attempt assets cannot impersonate independent choices", (t) => {
  const candidateFixture = makeFixture();
  const attemptFixture = makeFixture();
  t.after(() => fs.rmSync(candidateFixture.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(attemptFixture.root, { recursive: true, force: true }));
  const modelPath = path.join(candidateFixture.root, "character-model.json");
  const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  model.performanceBible.candidates[1].path = model.performanceBible.candidates[0].path;
  model.performanceBible.candidates[1].sha256 = model.performanceBible.candidates[0].sha256;
  writeJson(candidateFixture.root, "character-model.json", model);
  assert.equal(errorCodes(validateJob(candidateFixture.root, { releaseLevel: "candidate" })).has("DUPLICATE_CANDIDATE"), true);

  const manifestPath = path.join(attemptFixture.root, "asset-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.slides[0].attempts.stills[1].path = manifest.slides[0].attempts.stills[0].path;
  manifest.slides[0].attempts.stills[1].sha256 = manifest.slides[0].attempts.stills[0].sha256;
  writeJson(attemptFixture.root, "asset-manifest.json", manifest);
  assert.equal(errorCodes(validateJob(attemptFixture.root, { releaseLevel: "candidate" })).has("DUPLICATE_ATTEMPT"), true);
});

test("missing content video blocks candidate release", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.unlinkSync(path.join(fixture.root, fixture.video.path));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("MISSING_ASSET"), true);
});

test("corrupt MP4 blocks candidate release even when its hash is current", (t) => {
  const fixture = makeFixture({ corruptVideo: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("CORRUPT_MP4"), true);
});

test("stale poster and stale QA binding cannot be released", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  writeFile(fixture.root, fixture.poster.path, fakePng(720, 720, 99));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("STALE_ASSET"), true);
});

test("missing true-render QA blocks candidate release", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.release.candidate.renderQa = null;
  writeJson(fixture.root, "job.json", job);
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("RENDER_QA"), true);
});

test("true-render QA bound to an older PPTX hash is rejected", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  writeFile(fixture.root, "build/candidate.staging.pptx", Buffer.concat([fakePptx(), Buffer.from([0x55])]));
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("STALE_RENDER_QA"), true);
});

test("render QA without one PNG per slide is rejected", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.release.candidate.renderQa.renderedSlides.pop();
  writeJson(fixture.root, "job.json", job);
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(errorCodes(result).has("RENDER_PIXEL_EVIDENCE"), true);
});

test("render QA cannot substitute arbitrary PNGs outside its bound render index", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const replacement = pngDescriptor(fixture.root, "qa/substitute-slide.png", 1600, 900, 97);
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.release.candidate.renderQa.renderedSlides[0] = {
    slideNumber: 1,
    path: replacement.path,
    sha256: replacement.sha256,
    width: replacement.width,
    height: replacement.height,
    mime: replacement.mime,
  };
  writeJson(fixture.root, "job.json", job);
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("STALE_RENDER_INDEX"), true);
});

test("unsafe parent path is rejected before media lookup", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(fixture.root, "asset-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.slides[0].poster.path = "../escape.png";
  writeJson(fixture.root, "asset-manifest.json", manifest);
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("UNSAFE_PATH"), true);
});

test("compiledFrom, display copy, and canonical media drift are independently rejected", (t) => {
  for (const [mutation, expectedCode] of [
    [(deck) => { deck.compiledFrom.contentPlan = `sha256:${"0".repeat(64)}`; }, "STALE_DECK_INPUT"],
    [(deck) => { deck.slides[1].title = "Drifted display copy"; }, "DECK_COPY_DRIFT"],
    [(deck) => { deck.slides[1].video = "videos/wrong.mp4"; }, "DECK_MEDIA_DRIFT"],
  ]) {
    const fixture = makeFixture();
    const deckPath = path.join(fixture.root, "deck.json");
    const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
    mutation(deck);
    writeJson(fixture.root, "deck.json", deck);
    const jobPath = path.join(fixture.root, "job.json");
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    job.trackedArtifacts.deck.sha256 = sha256File(deckPath);
    writeJson(fixture.root, "job.json", job);
    const result = validateJob(fixture.root, { releaseLevel: "candidate" });
    assert.equal(errorCodes(result).has(expectedCode), true, JSON.stringify(result.errors, null, 2));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("deck drift invalidates packaged and downstream but preserves video-ready assets", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const deckPath = path.join(fixture.root, "deck.json");
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  deck.title = "Changed after packaging";
  writeJson(fixture.root, "deck.json", deck);
  const run = spawnSync(process.execPath, [jobctlPath, "refresh", fixture.root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const job = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(job.state.stage, "videos-ready");
  assert.equal(job.trackedArtifacts.deck, undefined);
  assert.ok(job.trackedArtifacts.assetManifest);
  assert.equal(job.release.candidate.status, "none");
});

test("layout registry hash drift in a tracked deck triggers refresh rollback", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const deckPath = path.join(fixture.root, "deck.json");
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  deck.compiledFrom.layouts = `sha256:${"0".repeat(64)}`;
  writeJson(fixture.root, "deck.json", deck);
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.trackedArtifacts.deck.sha256 = sha256File(deckPath);
  writeJson(fixture.root, "job.json", job);
  const run = spawnSync(process.execPath, [jobctlPath, "refresh", fixture.root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const refreshed = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  assert.equal(refreshed.state.stage, "videos-ready");
  assert.match(refreshed.state.history.at(-1).note, /deck-layouts/);
});

test("jobctl init refuses a non-empty directory containing prior outputs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFile(root, "deck.json", "{}\n");
  const run = spawnSync(process.execPath, [jobctlPath, "init", root, "--job-id", "fresh-job"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /prior artifacts/);
  assert.equal(fs.existsSync(path.join(root, "job.json")), false);
});

test("atomic publication rolls the PPTX back to staging when state commit fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-publish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = writeFile(root, "build/candidate.staging.pptx", fakePptx());
  const published = path.join(root, "candidate.pptx");
  assert.throws(() => publishWithRollback(staging, published, () => { throw new Error("injected job write failure"); }), /injected job write failure/);
  assert.equal(fs.existsSync(staging), true);
  assert.equal(fs.existsSync(published), false);
});

test("invalidation restores archived releases when the state commit fails", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  fs.renameSync(path.join(fixture.root, "build/candidate.staging.pptx"), path.join(fixture.root, "candidate.pptx"));
  job.release.candidate.status = "released";
  job.release.candidate.artifact = "candidate.pptx";
  job.release.candidate.validatedAt = "2026-08-20T12:00:00.000Z";
  writeJson(fixture.root, "job.json", job);
  const invalidation = invalidateForDrift(job, [{ key: "brief", stage: "briefed", reason: "injected drift" }], fixture.root);
  assert.equal(fs.existsSync(path.join(fixture.root, "candidate.pptx")), false);
  assert.throws(() => commitInvalidation(jobPath, job, invalidation, () => { throw new Error("injected commit failure"); }), /injected commit failure/);
  assert.equal(fs.existsSync(path.join(fixture.root, "candidate.pptx")), true);
  assert.equal(invalidation.archiveMoves.some((move) => fs.existsSync(move.destination)), false);
});

test("jobctl refresh invalidates changed upstream and clears release state", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const briefPath = path.join(fixture.root, "brief.json");
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  brief.coreMessage = "Changed upstream message";
  writeJson(fixture.root, "brief.json", brief);
  const run = spawnSync(process.execPath, [jobctlPath, "refresh", fixture.root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const job = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(job.state.stage, "initialized");
  assert.deepEqual(job.trackedArtifacts, {});
  assert.equal(job.release.candidate.status, "none");
  assert.match(run.stdout, /invalidated/);
});

test("invalidating a released job archives prior PPTX bytes instead of blocking regeneration", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  materializeRealCandidate(fixture);
  let run = spawnSync(process.execPath, [
    jobctlPath, "release", fixture.root, "candidate",
    "--artifact", "build/candidate.staging.pptx",
    "--package-qa", "qa/package-qa.json",
    "--render-qa", "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const releasedHash = sha256File(path.join(fixture.root, "candidate.pptx"));
  const briefPath = path.join(fixture.root, "brief.json");
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
  brief.coreMessage = "A new generation needs new compiled output";
  writeJson(fixture.root, "brief.json", brief);
  run = spawnSync(process.execPath, [jobctlPath, "refresh", fixture.root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const job = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  const archivePath = job.state.history.at(-1).evidence.find((entry) => entry.includes("candidate"));
  assert.ok(archivePath);
  assert.equal(fs.existsSync(path.join(fixture.root, "candidate.pptx")), false);
  assert.equal(sha256File(path.join(fixture.root, ...archivePath.split("/"))), releasedHash);
  assert.equal(job.release.candidate.status, "none");
});

test("candidate remains distinct from final until PowerPoint evidence is bound", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let result = validateJob(fixture.root, { releaseLevel: "final" });
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).has("FINAL_REQUIRES_CANDIDATE"), true);

  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  fs.renameSync(path.join(fixture.root, "build/candidate.staging.pptx"), path.join(fixture.root, "candidate.pptx"));
  job.release.candidate.status = "released";
  job.release.candidate.artifact = "candidate.pptx";
  job.release.candidate.validatedAt = "2026-08-20T12:10:00.000Z";
  job.state.stage = "candidate-released";
  job.state.completedStages.push("candidate-released");
  writeFile(fixture.root, "build/final.staging.pptx", Buffer.concat([fakePptx(), Buffer.from([0x41])]));
  const finalHash = sha256File(path.join(fixture.root, "build/final.staging.pptx"));
  const finalPackageEvidence = {
    artifactSha256: finalHash,
    deckSha256: fixture.deckHash,
    expectedContentPages: 1,
    embeddedVideoCount: 1,
    posterCount: 1,
    timingCount: 1,
    relationshipsValid: true,
    mimeTypesValid: true,
    aspectRatiosValid: true,
    passed: true,
  };
  const finalPackageEvidencePath = writeJson(fixture.root, "qa/final-package-qa.json", finalPackageEvidence);
  const finalRenderedSlides = [1, 2].map((slideNumber) => {
    const rendered = pngDescriptor(fixture.root, `qa/rendered-final/slide-${slideNumber}.png`, 1600, 900, 50 + slideNumber);
    return { slideNumber, path: rendered.path, sha256: rendered.sha256, width: rendered.width, height: rendered.height, mime: rendered.mime };
  });
  const finalRenderIndex = writeRenderIndex(
    fixture.root,
    "qa/rendered-final",
    "build/final.staging.pptx",
    finalHash,
    finalRenderedSlides,
  );
  const finalRenderEvidence = {
    artifactSha256: finalHash,
    slideCount: 2,
    ...finalRenderIndex,
    renderedSlides: finalRenderedSlides,
    allSlidesInspected: true,
    overflowPassed: true,
    textWrapPassed: true,
    cropPassed: true,
    mediaPosterPassed: true,
    layoutRhythmPassed: true,
    passed: true,
  };
  const finalRenderEvidencePath = writeJson(fixture.root, "qa/final-render-qa.json", finalRenderEvidence);
  const capturePath = writeFile(fixture.root, "qa/powerpoint-capture.mp4", fakeMp4());
  const verification = {
    artifactSha256: finalHash,
    platform: "macos",
    appVersion: "PowerPoint test build",
    testedAt: "2026-08-20T12:20:00.000Z",
    capturePath: "qa/powerpoint-capture.mp4",
    captureSha256: sha256File(capturePath),
    testedSlideIds: ["01"],
    autoPlayOnce: true,
    noLoop: true,
    manualAdvance: true,
    passed: true,
  };
  const verificationPath = writeJson(fixture.root, "qa/powerpoint-verification.json", verification);
  job.release.final = {
    status: "none",
    artifact: "build/final.staging.pptx",
    sha256: finalHash,
    validatedAt: null,
    packageQa: {
      ...finalPackageEvidence,
      evidencePath: "qa/final-package-qa.json",
      evidenceSha256: sha256File(finalPackageEvidencePath),
    },
    renderQa: {
      ...finalRenderEvidence,
      evidencePath: "qa/final-render-qa.json",
      evidenceSha256: sha256File(finalRenderEvidencePath),
    },
    powerPointVerification: {
      ...verification,
      evidencePath: "qa/powerpoint-verification.json",
      evidenceSha256: sha256File(verificationPath),
    },
  };
  job.release.final.powerPointVerification.artifactSha256 = job.release.candidate.sha256;
  writeJson(fixture.root, "job.json", job);
  result = validateJob(fixture.root, { releaseLevel: "final" });
  assert.equal(errorCodes(result).has("STALE_POWERPOINT_VERIFICATION"), true);
  job.release.final.powerPointVerification.artifactSha256 = finalHash;
  writeJson(fixture.root, "job.json", job);
  result = validateJob(fixture.root, { releaseLevel: "final" });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("jobctl candidate release binds package evidence and records gated stages", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  materializeRealCandidate(fixture);
  const run = spawnSync(process.execPath, [
    jobctlPath,
    "release",
    fixture.root,
    "candidate",
    "--artifact",
    "build/candidate.staging.pptx",
    "--package-qa",
    "qa/package-qa.json",
    "--render-qa",
    "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const job = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(job.state.stage, "candidate-released");
  assert.equal(job.release.candidate.status, "released");
  assert.equal(job.release.candidate.playbackVerified, false);
  assert.equal(fs.existsSync(path.join(fixture.root, "candidate.pptx")), true);
  assert.equal(fs.existsSync(path.join(fixture.root, "build/candidate.staging.pptx")), false);
  assert.equal(job.state.completedStages.includes("candidate-released"), true);
  const result = validateJob(fixture.root, { releaseLevel: "candidate" });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("real builder package evidence is accepted by the strict candidate state gate", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const posterPath = path.join(fixture.root, "stills", "01.png");
  const videoPath = path.join(fixture.root, "videos", "01.mp4");
  let run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=1080x1080:d=0.2",
    "-frames:v", "1", "-c:v", "png", posterPath,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  run = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=1080x1080:d=0.3",
    "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", videoPath,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const manifestPath = path.join(fixture.root, "asset-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const posterHash = sha256File(posterPath);
  const videoHash = sha256File(videoPath);
  manifest.slides[0].poster = { path: "stills/01.png", sha256: posterHash, bytes: fs.statSync(posterPath).size, width: 1080, height: 1080, mime: "image/png" };
  manifest.slides[0].video = { path: "videos/01.mp4", sha256: videoHash, bytes: fs.statSync(videoPath).size, width: 1080, height: 1080, mime: "video/mp4", durationSeconds: 0.3, codec: "h264", pixelFormat: "yuv420p", muted: true };
  manifest.slides[0].attempts.stills[0].sha256 = posterHash;
  manifest.slides[0].attempts.videos[0].sha256 = videoHash;
  manifest.slides[0].qa.binding.posterSha256 = posterHash;
  manifest.slides[0].qa.binding.videoSha256 = videoHash;
  writeJson(fixture.root, "asset-manifest.json", manifest);
  const manifestHash = sha256File(manifestPath);
  const deckPath = path.join(fixture.root, "deck.json");
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  deck.compiledFrom.assetManifest = manifestHash;
  writeJson(fixture.root, "deck.json", deck);
  const deckHash = sha256File(deckPath);
  const jobPath = path.join(fixture.root, "job.json");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.trackedArtifacts.assetManifest.sha256 = manifestHash;
  job.trackedArtifacts.deck.sha256 = deckHash;
  writeJson(fixture.root, "job.json", job);
  const candidatePath = path.join(fixture.root, "build", "candidate.staging.pptx");
  run = spawnSync(process.execPath, [builderPath, deckPath, candidatePath, "--release", "candidate"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const packageQaPath = path.join(fixture.root, "qa/package-qa.json");
  run = spawnSync(process.execPath, [
    pptxValidatorPath,
    candidatePath,
    "--deck",
    deckPath,
    "--release",
    "candidate",
    "--report",
    packageQaPath,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const actualHash = sha256File(candidatePath);
  const renderQa = JSON.parse(fs.readFileSync(path.join(fixture.root, "qa/render-qa.json"), "utf8"));
  renderQa.artifactSha256 = actualHash;
  const renderIndexPath = path.join(fixture.root, ...renderQa.renderIndexPath.split("/"));
  const renderIndex = JSON.parse(fs.readFileSync(renderIndexPath, "utf8"));
  renderIndex.artifactSha256 = actualHash;
  writeJson(fixture.root, renderQa.renderIndexPath, renderIndex);
  renderQa.renderIndexSha256 = sha256File(renderIndexPath);
  writeJson(fixture.root, "qa/render-qa.json", renderQa);
  run = spawnSync(process.execPath, [
    jobctlPath,
    "release",
    fixture.root,
    "candidate",
    "--artifact",
    "build/candidate.staging.pptx",
    "--package-qa",
    "qa/package-qa.json",
    "--render-qa",
    "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const persisted = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(persisted.release.candidate.sha256, actualHash);
  assert.equal(persisted.release.candidate.packageQa.artifactSha256, actualHash);
  assert.equal(validateJob(fixture.root, { releaseLevel: "candidate" }).ok, true);
});

test("jobctl candidate release rejects package QA bound to an older artifact", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const qaPath = path.join(fixture.root, "qa/package-qa.json");
  const qa = JSON.parse(fs.readFileSync(qaPath, "utf8"));
  qa.artifactSha256 = `sha256:${"0".repeat(64)}`;
  fs.writeFileSync(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
  const run = spawnSync(process.execPath, [
    jobctlPath,
    "release",
    fixture.root,
    "candidate",
    "--artifact",
    "build/candidate.staging.pptx",
    "--package-qa",
    "qa/package-qa.json",
    "--render-qa",
    "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /STALE_PACKAGE_QA/);
  const persisted = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(persisted.state.stage, "qa-passed");
  assert.equal(persisted.release.candidate.status, "none");
});

test("hand-written all-true package JSON cannot release a package with no embedded media", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [
    jobctlPath, "release", fixture.root, "candidate",
    "--artifact", "build/candidate.staging.pptx",
    "--package-qa", "qa/package-qa.json",
    "--render-qa", "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /direct PPTX package preflight failed/);
  assert.equal(fs.existsSync(path.join(fixture.root, "candidate.pptx")), false);
  assert.equal(fs.existsSync(path.join(fixture.root, "build/candidate.staging.pptx")), true);
});

test("package QA must bind the tracked compiled deck", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const qaPath = path.join(fixture.root, "qa/package-qa.json");
  const qa = JSON.parse(fs.readFileSync(qaPath, "utf8"));
  qa.deckSha256 = `sha256:${"0".repeat(64)}`;
  writeJson(fixture.root, "qa/package-qa.json", qa);
  const run = spawnSync(process.execPath, [
    jobctlPath, "release", fixture.root, "candidate",
    "--artifact", "build/candidate.staging.pptx",
    "--package-qa", "qa/package-qa.json",
    "--render-qa", "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /deckSha256/);
});

test("jobctl final release rejects stale final-package QA, then accepts correctly bound dual evidence", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  materializeRealCandidate(fixture);
  let run = spawnSync(process.execPath, [
    jobctlPath,
    "release",
    fixture.root,
    "candidate",
    "--artifact",
    "build/candidate.staging.pptx",
    "--package-qa",
    "qa/package-qa.json",
    "--render-qa",
    "qa/render-qa.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const candidateJob = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));

  const finalStagingPath = path.join(fixture.root, "build", "final.staging.pptx");
  run = spawnSync(process.execPath, [builderPath, path.join(fixture.root, "deck.json"), finalStagingPath, "--release", "final", "--powerpoint-verified"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  run = spawnSync(process.execPath, [pptxValidatorPath, finalStagingPath, "--deck", path.join(fixture.root, "deck.json"), "--release", "final", "--report", path.join(fixture.root, "qa/final-package-qa.json")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const finalHash = sha256File(finalStagingPath);
  const finalPackageQa = JSON.parse(fs.readFileSync(path.join(fixture.root, "qa/final-package-qa.json"), "utf8"));
  finalPackageQa.artifactSha256 = candidateJob.release.candidate.sha256;
  writeJson(fixture.root, "qa/final-package-qa.json", finalPackageQa);
  const finalRenderedSlides = [1, 2].map((slideNumber) => {
    const rendered = pngDescriptor(fixture.root, `qa/rendered-final/slide-${slideNumber}.png`, 1600, 900, 70 + slideNumber);
    return { slideNumber, path: rendered.path, sha256: rendered.sha256, width: rendered.width, height: rendered.height, mime: rendered.mime };
  });
  const finalRenderIndex = writeRenderIndex(
    fixture.root,
    "qa/rendered-final",
    "build/final.staging.pptx",
    finalHash,
    finalRenderedSlides,
  );
  writeJson(fixture.root, "qa/final-render-qa.json", {
    artifactSha256: finalHash,
    slideCount: 2,
    ...finalRenderIndex,
    renderedSlides: finalRenderedSlides,
    allSlidesInspected: true,
    overflowPassed: true,
    textWrapPassed: true,
    cropPassed: true,
    mediaPosterPassed: true,
    layoutRhythmPassed: true,
    passed: true,
  });
  const capturePath = writeFile(fixture.root, "qa/powerpoint-capture.mp4", fakeMp4());
  const powerPointEvidence = {
    artifactSha256: finalHash,
    platform: "macos",
    appVersion: "PowerPoint test build",
    testedAt: "2026-08-20T12:30:00.000Z",
    capturePath: "qa/powerpoint-capture.mp4",
    captureSha256: sha256File(capturePath),
    testedSlideIds: ["01"],
    autoPlayOnce: true,
    noLoop: true,
    manualAdvance: true,
    passed: true,
  };
  writeJson(fixture.root, "qa/powerpoint-verification.json", powerPointEvidence);
  const finalArgs = [
    jobctlPath,
    "release",
    fixture.root,
    "final",
    "--artifact",
    "build/final.staging.pptx",
    "--package-qa",
    "qa/final-package-qa.json",
    "--render-qa",
    "qa/final-render-qa.json",
    "--powerpoint-verification",
    "qa/powerpoint-verification.json",
  ];
  run = spawnSync(process.execPath, finalArgs, { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /STALE_FINAL_PACKAGE_QA/);
  let persisted = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(persisted.state.stage, "candidate-released");
  assert.equal(persisted.release.final.status, "none");

  finalPackageQa.artifactSha256 = finalHash;
  writeJson(fixture.root, "qa/final-package-qa.json", finalPackageQa);
  powerPointEvidence.artifactSha256 = candidateJob.release.candidate.sha256;
  writeJson(fixture.root, "qa/powerpoint-verification.json", powerPointEvidence);
  run = spawnSync(process.execPath, finalArgs, { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /STALE_POWERPOINT_VERIFICATION/);
  powerPointEvidence.artifactSha256 = finalHash;
  writeJson(fixture.root, "qa/powerpoint-verification.json", powerPointEvidence);
  run = spawnSync(process.execPath, finalArgs, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  persisted = JSON.parse(fs.readFileSync(path.join(fixture.root, "job.json"), "utf8"));
  assert.equal(persisted.state.stage, "final-released");
  assert.equal(persisted.release.final.status, "released");
  assert.equal(persisted.release.final.packageQa.artifactSha256, finalHash);
  assert.equal(fs.existsSync(path.join(fixture.root, "final.pptx")), true);
  assert.equal(fs.existsSync(path.join(fixture.root, "build/final.staging.pptx")), false);
  assert.equal(validateJob(fixture.root, { releaseLevel: "final" }).ok, true);
});

test("validator CLI is executable and returns machine-readable success", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [validatorPath, fixture.root, "--release", "candidate", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
});

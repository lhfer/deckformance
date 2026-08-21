"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, ".grok", "skills", "ppt-cast");
const SCRIPTS = path.join(SKILL, "scripts");
const {
  GalleryManifestError,
  buildGallery,
  readRunManifest,
  validateGalleryRunManifest,
} = require(path.join(SCRIPTS, "build_gallery"));
const {
  REQUIRED_DIMENSIONS,
  aggregateBlindRatings,
  generateBlindStudy,
  loadRubric,
  objectSha256,
} = require(path.join(SCRIPTS, "blind_test"));

let tempRoot;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-gallery-blind-"));
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeRoot(name) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function writeArtifact(root, relative, content) {
  const output = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);
  return { path: relative, sha256: sha256(content), label: path.basename(relative) };
}

function writeJson(root, relative, value) {
  const output = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
}

function galleryFixture(name = "gallery-valid", release = "candidate") {
  const root = makeRoot(name);
  const runId = `${name}-run-01`;
  const artifacts = {
    brief: writeArtifact(root, "evidence/brief.json", "brief"),
    content: writeArtifact(root, "evidence/content-plan.json", "content"),
    visual: writeArtifact(root, "evidence/visual-plan.json", "visual"),
    design: writeArtifact(root, "evidence/design-plan.json", "design"),
    render: [
      writeArtifact(root, "evidence/render-receipt.json", "render receipt"),
      writeArtifact(root, "evidence/slide-01.png", "slide pixels"),
    ],
    pptx: writeArtifact(root, release === "final-macos" ? "evidence/final.pptx" : "evidence/candidate.pptx", "pptx bytes"),
    qa: [
      writeArtifact(root, "evidence/evaluation-receipt.json", "qa receipt"),
      writeArtifact(root, "evidence/powerpoint-playback.json", "playback receipt"),
    ],
    sources: [writeArtifact(root, "evidence/sources.json", "source index with https://example.com/source")],
  };
  const benchmarkReport = {
    schemaVersion: "1.0.0",
    reportType: "deckformance-benchmark-report",
    suiteId: "gallery-fixture-suite",
    sourceSha256: sha256("fixture runs"),
    runCount: 1,
    passed: true,
    gates: {},
    runs: [{ runId, benchmarkId: "fictional-launch", track: "fixed-media", attemptsUsed: 1, retryBudget: 0, firstPass: true, passedWithinBudget: true }],
  };
  benchmarkReport.reportSha256 = objectSha256(benchmarkReport);
  artifacts.benchmark = writeArtifact(root, "evidence/benchmark-report.json", `${JSON.stringify(benchmarkReport, null, 2)}\n`);
  const manifest = {
    schemaVersion: "1.0.0",
    manifestType: "deckformance-benchmark-run",
    runId,
    benchmarkId: "fictional-launch",
    title: "Fictional product launch",
    track: "fixed-media",
    status: "completed",
    outcome: "passed",
    completedAt: "2026-08-20T20:00:00.000Z",
    classification: "public-proof",
    visibility: "public",
    publicEligible: true,
    galleryEligible: true,
    release,
    jobDir: ".",
    artifacts,
    knownLimits: ["PowerPoint playback was verified only on macOS."],
  };
  const manifestPath = writeJson(root, "benchmark-run.json", manifest);
  const releaseValidator = () => ({ ok: true, artifactSha256: artifacts.pptx.sha256 });
  return { artifacts, manifest, manifestPath, releaseValidator, root };
}

test("gallery publishes only a completed hash-bound public candidate and exposes every proof category", () => {
  const fixture = galleryFixture();
  const outputDir = path.join(fixture.root, "public-gallery");
  const result = buildGallery({
    manifests: [fixture.manifestPath],
    outputDir,
    generatedAt: "2026-08-20T21:00:00.000Z",
    releaseValidator: fixture.releaseValidator,
  });
  assert.equal(result.index.runCount, 1);
  assert.equal(result.index.runs[0].release, "candidate");
  assert.deepEqual(Object.keys(result.index.runs[0].evidence), ["brief", "content", "visual", "design", "render", "pptx", "qa", "sources", "benchmark"]);
  assert.match(result.index.runs[0].manifestSha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(result.index.runs[0].evidence.pptx[0].href.startsWith("assets/"));
  assert.equal(fs.readFileSync(path.join(outputDir, result.index.runs[0].evidence.pptx[0].href), "utf8"), "pptx bytes");

  const diskIndex = JSON.parse(fs.readFileSync(path.join(outputDir, "gallery-index.json"), "utf8"));
  assert.equal(objectSha256(diskIndex.runs[0].knownLimits), objectSha256(["PowerPoint playback was verified only on macOS."]));
  const html = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
  for (const label of ["Brief", "Content", "Visual", "Design", "Render", "PPTX", "QA", "Sources", "Benchmark gate", "Status", "Known limits", "candidate"]) {
    assert.match(html, new RegExp(label, "i"));
  }
  assert.doesNotMatch(JSON.stringify(diskIndex), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("gallery keeps final-macos distinct and fails closed on legacy, private, ineligible, incomplete, unhashed, or drifted evidence", () => {
  const finalFixture = galleryFixture("gallery-final", "final-macos");
  const finalResult = buildGallery({
    manifests: [finalFixture.manifestPath],
    outputDir: path.join(finalFixture.root, "gallery"),
    generatedAt: "2026-08-20T21:00:00.000Z",
    releaseValidator: finalFixture.releaseValidator,
  });
  assert.equal(finalResult.index.runs[0].release, "final-macos");

  const base = finalFixture.manifest;
  const cases = [
    [{ ...base, classification: "legacy-negative" }, "LEGACY_NEGATIVE"],
    [{ ...base, artifacts: { ...base.artifacts, sources: [{ ...base.artifacts.sources[0], private: true }] } }, "PRIVATE_EVIDENCE"],
    [{ ...base, galleryEligible: false }, "NOT_GALLERY_ELIGIBLE"],
    [{ ...base, status: "running" }, "RUN_INCOMPLETE"],
    [{ ...base, artifacts: { ...base.artifacts, qa: [{ path: "evidence/evaluation-receipt.json" }] } }, "EVIDENCE_HASH"],
    [{ ...base, release: "final" }, "RELEASE_LABEL"],
    [{ ...base, visibility: undefined }, "NOT_PUBLIC"],
    [{ ...base, artifacts: { ...base.artifacts, sources: [{ label: "Remote", url: "https://example.com/source", sha256: sha256("source") }] } }, "REMOTE_UNVERIFIED"],
  ];
  for (const [manifest, code] of cases) {
    const validation = validateGalleryRunManifest(manifest, { baseDir: finalFixture.root, verifyFiles: false, releaseValidator: finalFixture.releaseValidator });
    assert.equal(validation.valid, false, code);
    assert.ok(validation.issues.some((entry) => entry.code === code), JSON.stringify(validation.issues));
  }
  const invalidJob = validateGalleryRunManifest(base, {
    baseDir: finalFixture.root,
    verifyFiles: false,
    releaseValidator: () => ({ ok: false }),
  });
  assert.ok(invalidJob.issues.some((entry) => entry.code === "JOB_VALIDATION"));
  const mismatchedRelease = validateGalleryRunManifest(base, {
    baseDir: finalFixture.root,
    verifyFiles: false,
    releaseValidator: () => ({ ok: true, artifactSha256: `sha256:${"e".repeat(64)}` }),
  });
  assert.ok(mismatchedRelease.issues.some((entry) => entry.code === "JOB_VALIDATION"));

  const drifted = structuredClone(base);
  drifted.artifacts.pptx.sha256 = `sha256:${"0".repeat(64)}`;
  const driftPath = writeJson(finalFixture.root, "drifted-run.json", drifted);
  assert.throws(() => readRunManifest(driftPath, { releaseValidator: finalFixture.releaseValidator }), (error) =>
    error instanceof GalleryManifestError && error.issues.some((entry) => entry.code === "EVIDENCE_DRIFT"),
  );
});

function blindDefinition(name = "study") {
  return {
    studyId: name,
    seed: "fixed-and-secret-study-seed",
    reviewerIds: ["reviewer-05", "reviewer-03", "reviewer-01", "reviewer-04", "reviewer-02"],
    benchmarks: [
      {
        benchmarkId: "launch",
        title: "Launch benchmark",
        variants: {
          v1: { artifactId: "launch-left", path: "launch-left.pptx", sha256: `sha256:${"1".repeat(64)}` },
          v2: { artifactId: "launch-right", path: "launch-right.pptx", sha256: `sha256:${"2".repeat(64)}` },
        },
      },
      {
        benchmarkId: "science",
        title: "Science benchmark",
        variants: {
          v1: { artifactId: "science-left", path: "science-left.pptx", sha256: `sha256:${"3".repeat(64)}` },
          v2: { artifactId: "science-right", path: "science-right.pptx", sha256: `sha256:${"4".repeat(64)}` },
        },
      },
    ],
  };
}

function answerById(study) {
  return new Map(study.answerKey.assignments.map((assignment) => [assignment.assignmentId, assignment]));
}

function passingReviews(study) {
  const answers = answerById(study);
  return study.ballots.reviewers.flatMap((reviewer) => reviewer.assignments.map((assignment) => {
    const answer = answers.get(assignment.assignmentId);
    const v2Label = answer.labels.A === "v2" ? "A" : "B";
    const v1Label = v2Label === "A" ? "B" : "A";
    const scores = Object.fromEntries(REQUIRED_DIMENSIONS.map((dimension) => [dimension, 5]));
    const oldScores = Object.fromEntries(REQUIRED_DIMENSIONS.map((dimension) => [dimension, 3]));
    return {
      assignmentId: assignment.assignmentId,
      reviewerId: reviewer.reviewerId,
      preference: v2Label,
      ratings: { [v2Label]: scores, [v1Label]: oldScores },
      issues: [],
    };
  }));
}

test("blind assignments are deterministic, balanced, shuffled, hash-bound, and keep the answer key separate", () => {
  const first = generateBlindStudy(blindDefinition("deterministic"));
  const second = generateBlindStudy(blindDefinition("deterministic"));
  assert.deepEqual(first, second);
  assert.equal(first.ballots.reviewers.length, 5);
  assert.equal(first.answerKey.assignments.length, 10);
  assert.equal(first.answerKey.ballotsSha256, objectSha256(first.ballots));
  assert.doesNotMatch(JSON.stringify(first.ballots), /"labels"\s*:/);

  for (const benchmarkId of ["launch", "science"]) {
    const v2InA = first.answerKey.assignments.filter((answer) => answer.benchmarkId === benchmarkId && answer.labels.A === "v2").length;
    assert.ok(v2InA === 2 || v2InA === 3, `${benchmarkId}: ${v2InA}`);
  }
  assert.equal(loadRubric().dimensions.map((dimension) => dimension.id).join(","), REQUIRED_DIMENSIONS.join(","));
});

test("blind aggregation passes five complete reviewers at 70/60 preference, 4/5 medians, and zero v2 P0/P1", () => {
  const study = generateBlindStudy(blindDefinition("passing"));
  const reviews = passingReviews(study);
  reviews[0].issues.push({ target: study.answerKey.assignments.find((entry) => entry.assignmentId === reviews[0].assignmentId).labels.A === "v1" ? "A" : "B", severity: "P0", code: "OLD_DEFECT", message: "The legacy version is broken." });
  reviews[1].issues.push({ target: study.answerKey.assignments.find((entry) => entry.assignmentId === reviews[1].assignmentId).labels.A === "v2" ? "A" : "B", severity: "P2", code: "POLISH", message: "Minor polish remains." });
  const report = aggregateBlindRatings(study.ballots, study.answerKey, reviews);
  assert.equal(report.passed, true, JSON.stringify(report.gates));
  assert.equal(report.gates.completion.passed, true);
  assert.equal(report.gates.reviewers.actual, 5);
  assert.equal(report.gates.overallV2Preference.rate, 1);
  assert.ok(report.gates.perBenchmarkV2Preference.every((gate) => gate.rate === 1 && gate.passed));
  assert.ok(report.gates.v2DimensionMedians.every((gate) => gate.median === 5 && gate.passed));
  assert.equal(report.gates.v2BlockingIssues.actual, 0, "a P0 on v1 is not a v2 release defect");
  assert.match(report.reportSha256, /^sha256:[a-f0-9]{64}$/);
});

test("blind aggregation fails closed below preference and median gates or when v2 has a P0/P1", () => {
  const study = generateBlindStudy({ ...blindDefinition("failing"), benchmarks: [blindDefinition().benchmarks[0]] });
  const reviews = passingReviews(study);
  const answers = answerById(study);
  reviews.forEach((review, index) => {
    const answer = answers.get(review.assignmentId);
    const v2Label = answer.labels.A === "v2" ? "A" : "B";
    const v1Label = v2Label === "A" ? "B" : "A";
    review.preference = index < 2 ? v2Label : v1Label;
    review.ratings[v2Label]["typography-hierarchy"] = 3;
  });
  const firstAnswer = answers.get(reviews[0].assignmentId);
  reviews[0].issues.push({
    target: firstAnswer.labels.A === "v2" ? "A" : "B",
    severity: "P1",
    code: "TYPE_OVERFLOW",
    message: "Headline overflows its resolved bounds.",
  });
  const report = aggregateBlindRatings(study.ballots, study.answerKey, { reviews });
  assert.equal(report.passed, false);
  assert.equal(report.gates.reviewers.passed, true);
  assert.equal(report.gates.overallV2Preference.rate, 0.4);
  assert.equal(report.gates.overallV2Preference.passed, false);
  assert.equal(report.gates.perBenchmarkV2Preference[0].passed, false);
  assert.equal(report.gates.v2DimensionMedians.find((gate) => gate.dimension === "typography-hierarchy").median, 3);
  assert.equal(report.gates.v2BlockingIssues.actual, 1);
  assert.equal(report.blockingIssues[0].code, "TYPE_OVERFLOW");
});

test("blind aggregation rejects duplicate, foreign, and hash-drifted ballots instead of guessing", () => {
  const study = generateBlindStudy(blindDefinition("tamper"));
  const reviews = passingReviews(study);
  assert.throws(
    () => aggregateBlindRatings(study.ballots, study.answerKey, [...reviews, reviews[0]]),
    /already been submitted/,
  );
  const foreign = structuredClone(reviews);
  foreign[0].assignmentId = "blind-not-generated";
  assert.throws(() => aggregateBlindRatings(study.ballots, study.answerKey, foreign), /does not reference/);
  const drifted = structuredClone(study.ballots);
  drifted.reviewers[0].assignments[0].presentationA.sha256 = `sha256:${"f".repeat(64)}`;
  assert.throws(() => aggregateBlindRatings(drifted, study.answerKey, reviews), /ballot bytes drifted/);
});

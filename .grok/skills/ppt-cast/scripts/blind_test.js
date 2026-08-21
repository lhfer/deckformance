#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BLIND_TEST_VERSION = "1.0.0";
const DEFAULT_RUBRIC_PATH = path.resolve(__dirname, "..", "references", "benchmarks", "blind-test-rubric.json");
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const REQUIRED_DIMENSIONS = Object.freeze([
  "identity",
  "body-completeness",
  "crop-safety",
  "claim-expression",
  "typography-hierarchy",
  "motion-continuity",
]);
const BLOCKING_SEVERITIES = new Set(["P0", "P1"]);

class BlindTestError extends Error {
  constructor(message, issues = []) {
    super(issues.length ? `${message}:\n${issues.map((entry) => `${entry.pointer}: ${entry.message}`).join("\n")}` : message);
    this.name = "BlindTestError";
    this.issues = issues;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function objectSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function rank(seed, ...parts) {
  return crypto.createHash("sha256").update([seed, ...parts].join("\u0000")).digest("hex");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addIssue(issues, pointer, message) {
  issues.push({ pointer, message });
}

function loadRubric(rubricPath = DEFAULT_RUBRIC_PATH) {
  const absolutePath = path.resolve(rubricPath);
  const rubric = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  validateRubric(rubric);
  return rubric;
}

function validateRubric(rubric) {
  const issues = [];
  if (!isObject(rubric)) throw new BlindTestError("blind-test rubric must be an object");
  if (typeof rubric.rubricId !== "string" || !rubric.rubricId.trim()) addIssue(issues, "rubric.rubricId", "is required");
  if (!Array.isArray(rubric.dimensions)) addIssue(issues, "rubric.dimensions", "must be an array");
  const ids = Array.isArray(rubric.dimensions) ? rubric.dimensions.map((dimension) => dimension && dimension.id) : [];
  if (JSON.stringify(ids) !== JSON.stringify(REQUIRED_DIMENSIONS)) {
    addIssue(issues, "rubric.dimensions", `must contain exactly ${REQUIRED_DIMENSIONS.join(", ")} in that order`);
  }
  for (const [index, dimension] of (rubric.dimensions || []).entries()) {
    if (!isObject(dimension) || typeof dimension.label !== "string" || !dimension.label.trim()) {
      addIssue(issues, `rubric.dimensions[${index}].label`, "is required");
    }
  }
  if (!isObject(rubric.scale) || rubric.scale.min !== 1 || rubric.scale.max !== 5 || rubric.scale.medianPassAt !== 4) {
    addIssue(issues, "rubric.scale", "must define the 1-5 scale with medianPassAt 4");
  }
  const gates = rubric.gates;
  if (!isObject(gates) || gates.minimumReviewers !== 5 || gates.overallV2PreferenceAtLeast !== 0.7 || gates.perBenchmarkV2PreferenceAtLeast !== 0.6) {
    addIssue(issues, "rubric.gates", "must define 5 reviewers, 70% overall v2 preference, and 60% per-benchmark v2 preference");
  }
  if (!gates || gates.blockingIssueScope !== "v2" || gates.maximumP0P1 !== 0) {
    addIssue(issues, "rubric.gates.blockingIssueScope", "must block on every v2 P0/P1 issue");
  }
  if (issues.length) throw new BlindTestError("invalid blind-test rubric", issues);
  return rubric;
}

function normalizeArtifact(value, pointer, issues) {
  if (!isObject(value)) {
    addIssue(issues, pointer, "must be a hash-bound artifact descriptor");
    return null;
  }
  const artifactSha256 = String(value.sha256 || value.artifactSha256 || "").toLowerCase();
  if (!SHA256_RE.test(artifactSha256)) addIssue(issues, `${pointer}.sha256`, "must be sha256:<64 lowercase hex>");
  const location = value.path || value.url || value.href;
  if (typeof location !== "string" || !location.trim()) addIssue(issues, pointer, "must include path, url, or href");
  return {
    artifactId: typeof value.artifactId === "string" && value.artifactId.trim() ? value.artifactId.trim() : path.basename(location || "artifact"),
    location: typeof location === "string" ? location : "",
    sha256: artifactSha256,
  };
}

function normalizeStudyDefinition(definition) {
  const issues = [];
  if (!isObject(definition)) throw new BlindTestError("blind-test study definition must be an object");
  if (typeof definition.studyId !== "string" || !definition.studyId.trim()) addIssue(issues, "definition.studyId", "is required");
  if (typeof definition.seed !== "string" || !definition.seed) addIssue(issues, "definition.seed", "a non-empty deterministic randomization seed is required");
  const reviewers = definition.reviewerIds || definition.reviewers;
  if (!Array.isArray(reviewers) || reviewers.length < 5) {
    addIssue(issues, "definition.reviewerIds", "must contain at least five reviewer IDs");
  }
  const reviewerIds = Array.isArray(reviewers) ? reviewers.map((reviewer) => String(reviewer).trim()) : [];
  if (reviewerIds.some((reviewer) => !reviewer)) addIssue(issues, "definition.reviewerIds", "reviewer IDs must be non-empty");
  if (new Set(reviewerIds).size !== reviewerIds.length) addIssue(issues, "definition.reviewerIds", "reviewer IDs must be unique");
  if (!Array.isArray(definition.benchmarks) || definition.benchmarks.length === 0) {
    addIssue(issues, "definition.benchmarks", "must contain at least one v1/v2 benchmark pair");
  }
  const benchmarkIds = new Set();
  const benchmarks = (definition.benchmarks || []).map((benchmark, index) => {
    const pointer = `definition.benchmarks[${index}]`;
    if (!isObject(benchmark)) {
      addIssue(issues, pointer, "must be an object");
      return null;
    }
    const benchmarkId = typeof benchmark.benchmarkId === "string" ? benchmark.benchmarkId.trim() : "";
    if (!benchmarkId) addIssue(issues, `${pointer}.benchmarkId`, "is required");
    if (benchmarkIds.has(benchmarkId)) addIssue(issues, `${pointer}.benchmarkId`, "must be unique");
    benchmarkIds.add(benchmarkId);
    const variants = isObject(benchmark.variants) ? benchmark.variants : benchmark;
    return {
      benchmarkId,
      title: typeof benchmark.title === "string" && benchmark.title.trim() ? benchmark.title.trim() : benchmarkId,
      v1: normalizeArtifact(variants.v1, `${pointer}.variants.v1`, issues),
      v2: normalizeArtifact(variants.v2, `${pointer}.variants.v2`, issues),
    };
  }).filter(Boolean);
  if (issues.length) throw new BlindTestError("invalid blind-test study definition", issues);
  return {
    studyId: definition.studyId.trim(),
    seed: definition.seed,
    reviewerIds: [...reviewerIds].sort(),
    benchmarks: [...benchmarks].sort((left, right) => left.benchmarkId.localeCompare(right.benchmarkId)),
  };
}

function publicArtifact(artifact) {
  return { artifactId: artifact.artifactId, href: artifact.location, sha256: artifact.sha256 };
}

function generateBlindStudy(definition, options = {}) {
  const normalized = normalizeStudyDefinition(definition);
  const rubric = options.rubric || loadRubric(options.rubricPath);
  validateRubric(rubric);
  const rubricSha256 = objectSha256(rubric);
  const reviewerBallots = new Map(normalized.reviewerIds.map((reviewerId) => [reviewerId, []]));
  const answers = [];

  for (const benchmark of normalized.benchmarks) {
    const positionOrder = [...normalized.reviewerIds].sort((left, right) =>
      rank(normalized.seed, "position", benchmark.benchmarkId, left).localeCompare(rank(normalized.seed, "position", benchmark.benchmarkId, right)),
    );
    const position = new Map(positionOrder.map((reviewerId, index) => [reviewerId, index]));
    for (const reviewerId of normalized.reviewerIds) {
      const v2IsA = position.get(reviewerId) % 2 === 0;
      const assignmentId = `blind-${rank(normalized.seed, normalized.studyId, reviewerId, benchmark.benchmarkId).slice(0, 20)}`;
      const variants = v2IsA
        ? { A: benchmark.v2, B: benchmark.v1 }
        : { A: benchmark.v1, B: benchmark.v2 };
      reviewerBallots.get(reviewerId).push({
        assignmentId,
        benchmarkId: benchmark.benchmarkId,
        title: benchmark.title,
        presentationA: publicArtifact(variants.A),
        presentationB: publicArtifact(variants.B),
      });
      answers.push({
        assignmentId,
        reviewerId,
        benchmarkId: benchmark.benchmarkId,
        labels: v2IsA ? { A: "v2", B: "v1" } : { A: "v1", B: "v2" },
        artifactHashes: { A: variants.A.sha256, B: variants.B.sha256 },
      });
    }
  }

  const ballots = {
    schemaVersion: BLIND_TEST_VERSION,
    documentType: "deckformance-blind-ballots",
    studyId: normalized.studyId,
    seedSha256: sha256(normalized.seed),
    rubric: {
      rubricId: rubric.rubricId,
      version: rubric.version,
      sha256: rubricSha256,
      scale: rubric.scale,
      dimensions: rubric.dimensions,
      preferenceOptions: ["A", "B", "tie"],
    },
    reviewers: normalized.reviewerIds.map((reviewerId) => ({
      reviewerId,
      assignments: reviewerBallots.get(reviewerId).sort((left, right) =>
        rank(normalized.seed, "order", reviewerId, left.benchmarkId).localeCompare(rank(normalized.seed, "order", reviewerId, right.benchmarkId)),
      ),
    })),
  };
  const ballotsSha256 = objectSha256(ballots);
  const answerKey = {
    schemaVersion: BLIND_TEST_VERSION,
    documentType: "deckformance-blind-answer-key",
    studyId: normalized.studyId,
    ballotsSha256,
    rubricSha256,
    assignments: answers.sort((left, right) => left.assignmentId.localeCompare(right.assignmentId)),
  };
  return { ballots, answerKey };
}

function assignmentMaps(ballots, answerKey) {
  if (!isObject(ballots) || ballots.documentType !== "deckformance-blind-ballots") throw new BlindTestError("invalid blind ballots document");
  if (!isObject(answerKey) || answerKey.documentType !== "deckformance-blind-answer-key") throw new BlindTestError("invalid blind answer key document");
  if (answerKey.studyId !== ballots.studyId) throw new BlindTestError("blind answer key belongs to another study");
  if (answerKey.ballotsSha256 !== objectSha256(ballots)) throw new BlindTestError("blind ballot bytes drifted after randomization");
  const ballotsById = new Map();
  for (const reviewer of ballots.reviewers || []) {
    for (const assignment of reviewer.assignments || []) {
      if (ballotsById.has(assignment.assignmentId)) throw new BlindTestError(`duplicate ballot assignment ${assignment.assignmentId}`);
      ballotsById.set(assignment.assignmentId, { ...assignment, reviewerId: reviewer.reviewerId });
    }
  }
  const answersById = new Map();
  for (const answer of answerKey.assignments || []) {
    if (answersById.has(answer.assignmentId)) throw new BlindTestError(`duplicate answer-key assignment ${answer.assignmentId}`);
    answersById.set(answer.assignmentId, answer);
  }
  if (ballotsById.size !== answersById.size) throw new BlindTestError("blind ballots and answer key do not cover the same assignments");
  for (const [assignmentId, ballot] of ballotsById) {
    const answer = answersById.get(assignmentId);
    if (!answer || answer.reviewerId !== ballot.reviewerId || answer.benchmarkId !== ballot.benchmarkId) {
      throw new BlindTestError(`answer key does not bind ballot ${assignmentId}`);
    }
    if (answer.artifactHashes.A !== ballot.presentationA.sha256 || answer.artifactHashes.B !== ballot.presentationB.sha256) {
      throw new BlindTestError(`artifact hash drift in ballot ${assignmentId}`);
    }
  }
  return { ballotsById, answersById };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function validateReview(review, assignment, rubric, pointer, issues) {
  if (!isObject(review)) {
    addIssue(issues, pointer, "must be an object");
    return;
  }
  if (review.reviewerId !== assignment.reviewerId) addIssue(issues, `${pointer}.reviewerId`, "does not match the assigned reviewer");
  if (!["A", "B", "tie"].includes(review.preference)) addIssue(issues, `${pointer}.preference`, "must be A, B, or tie");
  if (!isObject(review.ratings)) {
    addIssue(issues, `${pointer}.ratings`, "must score both A and B");
  } else {
    for (const label of ["A", "B"]) {
      const scores = review.ratings[label];
      if (!isObject(scores)) {
        addIssue(issues, `${pointer}.ratings.${label}`, "is required");
        continue;
      }
      for (const dimension of rubric.dimensions) {
        const score = scores[dimension.id];
        if (!Number.isInteger(score) || score < rubric.scale.min || score > rubric.scale.max) {
          addIssue(issues, `${pointer}.ratings.${label}.${dimension.id}`, "must be an integer from 1 to 5");
        }
      }
      const extra = Object.keys(scores).filter((key) => !REQUIRED_DIMENSIONS.includes(key));
      if (extra.length) addIssue(issues, `${pointer}.ratings.${label}`, `contains unknown dimensions: ${extra.join(", ")}`);
    }
  }
  if (review.issues !== undefined && !Array.isArray(review.issues)) {
    addIssue(issues, `${pointer}.issues`, "must be an array");
  }
  for (const [index, reported] of (review.issues || []).entries()) {
    const issuePointer = `${pointer}.issues[${index}]`;
    if (!isObject(reported)) {
      addIssue(issues, issuePointer, "must be an object");
      continue;
    }
    if (!["P0", "P1", "P2", "P3"].includes(reported.severity)) addIssue(issues, `${issuePointer}.severity`, "must be P0, P1, P2, or P3");
    if (!["A", "B", "study"].includes(reported.target)) addIssue(issues, `${issuePointer}.target`, "must be A, B, or study");
    if (typeof reported.code !== "string" || !reported.code.trim()) addIssue(issues, `${issuePointer}.code`, "is required");
    if (typeof reported.message !== "string" || !reported.message.trim()) addIssue(issues, `${issuePointer}.message`, "is required");
  }
}

function preferenceGate(v2Wins, total, threshold) {
  const rate = total === 0 ? 0 : v2Wins / total;
  return { v2Wins, comparisons: total, rate, threshold, passed: total > 0 && rate >= threshold };
}

function aggregateBlindRatings(ballots, answerKey, reviewsInput, options = {}) {
  const rubric = options.rubric || loadRubric(options.rubricPath);
  validateRubric(rubric);
  if (answerKey.rubricSha256 !== objectSha256(rubric) || ballots.rubric.sha256 !== objectSha256(rubric)) {
    throw new BlindTestError("blind-test rubric drifted after assignment generation");
  }
  const { ballotsById, answersById } = assignmentMaps(ballots, answerKey);
  const reviews = Array.isArray(reviewsInput) ? reviewsInput : isObject(reviewsInput) && Array.isArray(reviewsInput.reviews) ? reviewsInput.reviews : null;
  if (!reviews) throw new BlindTestError("reviews must be an array or a document with a reviews array");

  const issues = [];
  const seen = new Set();
  for (const [index, review] of reviews.entries()) {
    const assignmentId = review && review.assignmentId;
    const assignment = ballotsById.get(assignmentId);
    if (!assignment) {
      addIssue(issues, `reviews[${index}].assignmentId`, "does not reference a generated blind assignment");
      continue;
    }
    if (seen.has(assignmentId)) {
      addIssue(issues, `reviews[${index}].assignmentId`, "has already been submitted");
      continue;
    }
    seen.add(assignmentId);
    validateReview(review, assignment, rubric, `reviews[${index}]`, issues);
  }
  if (issues.length) throw new BlindTestError("invalid blind-test ratings", issues);

  const reviewerIds = new Set();
  const benchmarkStats = new Map();
  const dimensionValues = new Map(REQUIRED_DIMENSIONS.map((dimension) => [dimension, []]));
  const reportedIssues = [];
  let totalV2Wins = 0;
  for (const review of reviews) {
    const assignment = ballotsById.get(review.assignmentId);
    const answer = answersById.get(review.assignmentId);
    reviewerIds.add(review.reviewerId);
    const stats = benchmarkStats.get(assignment.benchmarkId) || { benchmarkId: assignment.benchmarkId, reviewers: new Set(), comparisons: 0, v2Wins: 0 };
    stats.reviewers.add(review.reviewerId);
    stats.comparisons += 1;
    const preferredVersion = review.preference === "tie" ? "tie" : answer.labels[review.preference];
    if (preferredVersion === "v2") {
      stats.v2Wins += 1;
      totalV2Wins += 1;
    }
    benchmarkStats.set(assignment.benchmarkId, stats);
    const v2Label = answer.labels.A === "v2" ? "A" : "B";
    for (const dimension of REQUIRED_DIMENSIONS) dimensionValues.get(dimension).push(review.ratings[v2Label][dimension]);
    for (const reported of review.issues || []) {
      const version = reported.target === "study" ? "study" : answer.labels[reported.target];
      reportedIssues.push({ benchmarkId: assignment.benchmarkId, version, severity: reported.severity, code: reported.code, message: reported.message });
    }
  }

  const expectedBenchmarkIds = [...new Set([...ballotsById.values()].map((assignment) => assignment.benchmarkId))].sort();
  const expectedAssignments = ballotsById.size;
  const completion = { submitted: seen.size, expected: expectedAssignments, passed: seen.size === expectedAssignments };
  const reviewerGate = { actual: reviewerIds.size, minimum: rubric.gates.minimumReviewers, passed: reviewerIds.size >= rubric.gates.minimumReviewers };
  const overallPreference = preferenceGate(totalV2Wins, reviews.length, rubric.gates.overallV2PreferenceAtLeast);
  const benchmarkPreferences = expectedBenchmarkIds.map((benchmarkId) => {
    const stats = benchmarkStats.get(benchmarkId) || { reviewers: new Set(), comparisons: 0, v2Wins: 0 };
    const preference = preferenceGate(stats.v2Wins, stats.comparisons, rubric.gates.perBenchmarkV2PreferenceAtLeast);
    return {
      benchmarkId,
      reviewerCount: stats.reviewers.size,
      minimumReviewers: rubric.gates.minimumReviewers,
      ...preference,
      passed: preference.passed && stats.reviewers.size >= rubric.gates.minimumReviewers,
    };
  });
  const dimensionMedians = REQUIRED_DIMENSIONS.map((dimension) => {
    const value = median(dimensionValues.get(dimension));
    return { dimension, median: value, minimum: rubric.scale.medianPassAt, passed: value !== null && value >= rubric.scale.medianPassAt };
  });
  const blockingIssues = reportedIssues.filter((reported) =>
    (reported.version === "v2" || reported.version === "study") && BLOCKING_SEVERITIES.has(reported.severity),
  );
  const blockingIssueGate = { actual: blockingIssues.length, maximum: rubric.gates.maximumP0P1, passed: blockingIssues.length === 0 };
  const passed = completion.passed && reviewerGate.passed && overallPreference.passed &&
    benchmarkPreferences.every((entry) => entry.passed) && dimensionMedians.every((entry) => entry.passed) && blockingIssueGate.passed;
  const report = {
    schemaVersion: BLIND_TEST_VERSION,
    documentType: "deckformance-blind-test-report",
    studyId: ballots.studyId,
    ballotsSha256: objectSha256(ballots),
    rubricSha256: objectSha256(rubric),
    passed,
    gates: {
      completion,
      reviewers: reviewerGate,
      overallV2Preference: overallPreference,
      perBenchmarkV2Preference: benchmarkPreferences,
      v2DimensionMedians: dimensionMedians,
      v2BlockingIssues: blockingIssueGate,
    },
    issueSummary: {
      total: reportedIssues.length,
      v2P0P1: blockingIssues.length,
      bySeverity: Object.fromEntries(["P0", "P1", "P2", "P3"].map((severity) => [severity, reportedIssues.filter((entry) => entry.severity === severity).length])),
    },
    blockingIssues,
  };
  report.reportSha256 = objectSha256(report);
  return report;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJsonExclusive(filePath, value) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return absolutePath;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!["assign", "aggregate"].includes(command)) throw new Error("usage: blind_test.js assign|aggregate [options]");
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected positional argument: ${arg}`);
    const key = arg.includes("=") ? arg.slice(2, arg.indexOf("=")) : arg.slice(2);
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
    if (!value) throw new Error(`missing value for --${key}`);
    if (!new Set(["input", "ballots", "key", "ratings", "output", "rubric"]).has(key)) throw new Error(`unknown option: --${key}`);
    options[key] = value;
  }
  if (command === "assign" && (!options.input || !options.ballots || !options.key)) {
    throw new Error("usage: blind_test.js assign --input study.json --ballots ballots.json --key answer-key.json [--rubric rubric.json]");
  }
  if (command === "aggregate" && (!options.ballots || !options.key || !options.ratings || !options.output)) {
    throw new Error("usage: blind_test.js aggregate --ballots ballots.json --key answer-key.json --ratings ratings.json --output report.json [--rubric rubric.json]");
  }
  return options;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const rubricOptions = args.rubric ? { rubricPath: args.rubric } : {};
    if (args.command === "assign") {
      const result = generateBlindStudy(readJson(args.input), rubricOptions);
      const ballotsPath = writeJsonExclusive(args.ballots, result.ballots);
      const keyPath = writeJsonExclusive(args.key, result.answerKey);
      console.log(JSON.stringify({ ballotsPath, keyPath, assignmentCount: result.answerKey.assignments.length }, null, 2));
    } else {
      const report = aggregateBlindRatings(readJson(args.ballots), readJson(args.key), readJson(args.ratings), rubricOptions);
      const outputPath = writeJsonExclusive(args.output, report);
      console.log(JSON.stringify({ outputPath, passed: report.passed }, null, 2));
      if (!report.passed) process.exitCode = 2;
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  BLIND_TEST_VERSION,
  BLOCKING_SEVERITIES,
  BlindTestError,
  DEFAULT_RUBRIC_PATH,
  REQUIRED_DIMENSIONS,
  aggregateBlindRatings,
  aggregateRatings: aggregateBlindRatings,
  generateAssignments: generateBlindStudy,
  generateBlindStudy,
  loadRubric,
  median,
  normalizeStudyDefinition,
  objectSha256,
  parseArgs,
  validateRubric,
};

if (require.main === module) main();

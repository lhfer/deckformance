#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DIMENSIONS = Object.freeze([
  "identity",
  "body-completeness",
  "crop-safety",
  "claim-expression",
  "typography-hierarchy",
  "motion-continuity",
]);
const BLOCKING_SEVERITIES = new Set(["P0", "P1"]);
const DEFAULT_GATES = Object.freeze({ firstPassAtLeast: 0.8, withinRetryAtLeast: 0.95, dimensionMedianAtLeast: 4 });

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function objectSha256(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rateGate(actual, total, minimum) {
  const rate = total ? actual / total : 0;
  return { actual, total, rate, minimum, passed: total > 0 && rate >= minimum };
}

function requireIssue(issue, pointer) {
  if (!issue || typeof issue !== "object" || !["P0", "P1", "P2", "P3"].includes(issue.severity)) {
    throw new Error(`${pointer} must declare severity P0-P3`);
  }
  if (typeof issue.code !== "string" || !issue.code.trim() || typeof issue.message !== "string" || !issue.message.trim()) {
    throw new Error(`${pointer} must declare code and message`);
  }
}

function validateRun(run, index) {
  const pointer = `runs[${index}]`;
  if (!run || typeof run !== "object" || !run.runId || !run.benchmarkId) throw new Error(`${pointer} requires runId and benchmarkId`);
  if (!new Set(["fixed-media", "real-generation"]).has(run.track)) throw new Error(`${pointer}.track is invalid`);
  if (!Number.isInteger(run.retryBudget) || run.retryBudget < 0) throw new Error(`${pointer}.retryBudget must be a non-negative integer`);
  if (!Array.isArray(run.attempts) || run.attempts.length < 1 || run.attempts.length > run.retryBudget + 1) {
    throw new Error(`${pointer}.attempts must fit the declared retry budget`);
  }
  let alreadyPassed = false;
  run.attempts.forEach((attempt, attemptIndex) => {
    const attemptPointer = `${pointer}.attempts[${attemptIndex}]`;
    if (!attempt || attempt.attempt !== attemptIndex + 1 || typeof attempt.passed !== "boolean") {
      throw new Error(`${attemptPointer} must be contiguous, one-indexed, and declare passed`);
    }
    if (alreadyPassed) throw new Error(`${attemptPointer} appears after an earlier passing attempt`);
    if (!Array.isArray(attempt.issues)) throw new Error(`${attemptPointer}.issues must be an array`);
    attempt.issues.forEach((issue, issueIndex) => requireIssue(issue, `${attemptPointer}.issues[${issueIndex}]`));
    if (attempt.passed && attempt.issues.some((issue) => BLOCKING_SEVERITIES.has(issue.severity))) {
      throw new Error(`${attemptPointer} cannot pass with a P0/P1 issue`);
    }
    if (attempt.passed && run.track === "real-generation") {
      if (!attempt.scores || typeof attempt.scores !== "object" || Array.isArray(attempt.scores)) throw new Error(`${attemptPointer}.scores is required`);
      const keys = Object.keys(attempt.scores).sort();
      if (keys.join("\0") !== [...DIMENSIONS].sort().join("\0")) throw new Error(`${attemptPointer}.scores must contain exactly the six quality dimensions`);
      for (const dimension of DIMENSIONS) {
        const score = attempt.scores[dimension];
        if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error(`${attemptPointer}.scores.${dimension} must be between 1 and 5`);
      }
    }
    alreadyPassed = alreadyPassed || attempt.passed;
  });
  return { ...run, selectedAttempt: run.attempts.find((attempt) => attempt.passed) || null };
}

function aggregateBenchmarkRuns(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("benchmark runs document must be an object");
  if (!Array.isArray(document.runs) || document.runs.length === 0) throw new Error("benchmark runs document needs at least one run");
  const gates = { ...DEFAULT_GATES, ...(options.gates || document.gates || {}) };
  const runs = document.runs.map(validateRun);
  const ids = new Set();
  for (const run of runs) {
    if (ids.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`);
    ids.add(run.runId);
  }
  const firstPass = rateGate(runs.filter((run) => run.attempts[0].passed).length, runs.length, gates.firstPassAtLeast);
  const withinRetry = rateGate(runs.filter((run) => run.selectedAttempt).length, runs.length, gates.withinRetryAtLeast);
  const selectedReal = runs.filter((run) => run.track === "real-generation" && run.selectedAttempt);
  const dimensionMedians = DIMENSIONS.map((dimension) => {
    const value = median(selectedReal.map((run) => run.selectedAttempt.scores[dimension]));
    return { dimension, median: value, minimum: gates.dimensionMedianAtLeast, passed: value !== null && value >= gates.dimensionMedianAtLeast };
  });
  const selectedBlockingIssues = runs.flatMap((run) => run.selectedAttempt
    ? run.selectedAttempt.issues.filter((issue) => BLOCKING_SEVERITIES.has(issue.severity)).map((issue) => ({ runId: run.runId, ...issue }))
    : []);
  const qualityApplicable = selectedReal.length > 0;
  const quality = {
    applicable: qualityApplicable,
    selectedRealGenerationRuns: selectedReal.length,
    dimensionMedians,
    blockingIssues: selectedBlockingIssues,
    passed: qualityApplicable && dimensionMedians.every((entry) => entry.passed) && selectedBlockingIssues.length === 0,
  };
  const passed = firstPass.passed && withinRetry.passed && quality.passed;
  const report = {
    schemaVersion: "1.0.0",
    reportType: "deckformance-benchmark-report",
    suiteId: String(document.suiteId || "unnamed-suite"),
    sourceSha256: objectSha256(document),
    runCount: runs.length,
    passed,
    gates: { firstPass, withinRetry, quality },
    runs: runs.map((run) => ({
      runId: run.runId,
      benchmarkId: run.benchmarkId,
      track: run.track,
      attemptsUsed: run.attempts.length,
      retryBudget: run.retryBudget,
      firstPass: run.attempts[0].passed,
      passedWithinBudget: Boolean(run.selectedAttempt),
    })),
  };
  report.reportSha256 = objectSha256(report);
  return report;
}

function parseArgs(argv) {
  const positional = [];
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output" || arg.startsWith("--output=")) {
      output = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      if (!output || output.startsWith("--")) throw new Error("--output requires a value");
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1 || !output) throw new Error("usage: benchmark_report.js <runs.json> --output <report.json>");
  return { input: path.resolve(positional[0]), output: path.resolve(output) };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const document = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const report = aggregateBenchmarkRuns(document);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${args.output}\n`);
  if (!report.passed) process.exitCode = 2;
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { DEFAULT_GATES, DIMENSIONS, aggregateBenchmarkRuns, median, objectSha256, parseArgs };

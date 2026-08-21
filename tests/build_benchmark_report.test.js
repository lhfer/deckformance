"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { DIMENSIONS, aggregateBenchmarkRuns } = require(path.resolve(__dirname, "..", ".grok", "skills", "ppt-cast", "scripts", "benchmark_report"));

function scores(value = 4) {
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, value]));
}

function run(index, options = {}) {
  const firstPass = options.firstPass !== false;
  const track = options.track || "real-generation";
  const passing = { attempt: firstPass ? 1 : 2, passed: true, issues: [], ...(track === "real-generation" ? { scores: options.scores || scores() } : {}) };
  return {
    runId: `run-${index}`,
    benchmarkId: options.benchmarkId || "fixture",
    track,
    retryBudget: firstPass ? 0 : 1,
    attempts: firstPass ? [passing] : [{ attempt: 1, passed: false, issues: [{ severity: "P2", code: "RETRY", message: "Retryable defect" }] }, passing],
  };
}

test("benchmark report enforces 80% first-pass, 95% within-budget, six 4/5 medians, and zero selected P0/P1", () => {
  const document = { suiteId: "passing", runs: Array.from({ length: 20 }, (_, index) => run(index, { firstPass: index < 16 })) };
  const report = aggregateBenchmarkRuns(document);
  assert.equal(report.passed, true, JSON.stringify(report.gates));
  assert.equal(report.gates.firstPass.rate, 0.8);
  assert.equal(report.gates.withinRetry.rate, 1);
  assert.deepEqual(report.gates.quality.dimensionMedians.map((entry) => entry.dimension), DIMENSIONS);
  assert.ok(report.gates.quality.dimensionMedians.every((entry) => entry.median === 4 && entry.passed));
  assert.match(report.reportSha256, /^sha256:[a-f0-9]{64}$/);
});

test("benchmark report fails below stability or quality gates", () => {
  const lowFirstPass = Array.from({ length: 20 }, (_, index) => run(index, { firstPass: index < 15 }));
  lowFirstPass[19] = { ...run(19), retryBudget: 0, attempts: [{ attempt: 1, passed: false, issues: [] }] };
  const report = aggregateBenchmarkRuns({ suiteId: "failing", runs: lowFirstPass });
  assert.equal(report.passed, false);
  assert.equal(report.gates.firstPass.rate, 0.75);
  assert.equal(report.gates.withinRetry.rate, 0.95);

  const weak = Array.from({ length: 5 }, (_, index) => run(index, { scores: scores(index < 3 ? 3 : 5) }));
  const weakReport = aggregateBenchmarkRuns({ suiteId: "weak", runs: weak });
  assert.equal(weakReport.gates.quality.dimensionMedians[0].median, 3);
  assert.equal(weakReport.passed, false);
});

test("benchmark report rejects malformed retries, duplicate runs, and a passing attempt with P0/P1", () => {
  const malformed = run(1, { firstPass: false });
  malformed.attempts[1].attempt = 3;
  assert.throws(() => aggregateBenchmarkRuns({ runs: [malformed] }), /contiguous/);
  assert.throws(() => aggregateBenchmarkRuns({ runs: [run(1), run(1)] }), /duplicate runId/);
  const blocked = run(2);
  blocked.attempts[0].issues.push({ severity: "P1", code: "BROKEN", message: "Release blocker" });
  assert.throws(() => aggregateBenchmarkRuns({ runs: [blocked] }), /cannot pass with a P0\/P1/);
  const missingDimension = run(3);
  delete missingDimension.attempts[0].scores.identity;
  assert.throws(() => aggregateBenchmarkRuns({ runs: [missingDimension] }), /exactly the six/);
});

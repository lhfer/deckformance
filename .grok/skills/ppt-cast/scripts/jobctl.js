#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  SCHEMA_VERSION,
  STAGES,
  CONTRACT_FILES,
  CONTRACT_STAGE,
  sha256File,
  isSafeRelativePath,
  resolveJobPath,
  loadJson,
  validateJob,
  printableResult,
} = require("./validate_job.js");

const LAYOUTS_PATH = path.resolve(__dirname, "..", "references", "layouts.json");
const PPTX_VALIDATOR_PATH = path.resolve(__dirname, "validate_pptx.js");

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function releaseGateError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function now() {
  return new Date().toISOString();
}

function emptyRelease() {
  return {
    candidate: {
      status: "none",
      artifact: null,
      sha256: null,
      validatedAt: null,
      playbackVerified: false,
      packageQa: null,
      renderQa: null,
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
  };
}

function defaultJob(jobId) {
  const timestamp = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId,
    state: {
      stage: "initialized",
      status: "active",
      completedStages: [],
      invalidatedStages: [],
      updatedAt: timestamp,
      history: [],
    },
    artifacts: {
      brief: CONTRACT_FILES.brief,
      characterModel: CONTRACT_FILES.characterModel,
      contentPlan: CONTRACT_FILES.contentPlan,
      visualPlan: CONTRACT_FILES.visualPlan,
      assetManifest: CONTRACT_FILES.assetManifest,
      deck: "deck.json",
    },
    trackedArtifacts: {},
    release: emptyRelease(),
  };
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  const temp = path.join(dir, `.job-json-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, filePath);
}

function publishWithRollback(stagingPath, publishedPath, commit) {
  if (fs.existsSync(publishedPath)) throw new Error(`refusing to overwrite existing released artifact: ${path.basename(publishedPath)}`);
  fs.renameSync(stagingPath, publishedPath);
  try {
    commit();
  } catch (error) {
    try {
      fs.renameSync(publishedPath, stagingPath);
    } catch (rollbackError) {
      throw new Error(`${error.message}; artifact rollback also failed: ${rollbackError.message}`);
    }
    throw error;
  }
}

function loadJob(jobDir) {
  const jobPath = path.join(path.resolve(jobDir), "job.json");
  if (!fs.existsSync(jobPath)) throw new Error(`missing ${jobPath}; run jobctl init first`);
  return { jobPath, job: loadJson(jobPath) };
}

function parseOptions(args) {
  const positional = [];
  const options = { evidence: [] };
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--json") options.json = true;
    else if (arg === "--job-id") options.jobId = args.shift();
    else if (arg === "--evidence") options.evidence.push(args.shift());
    else if (arg === "--note") options.note = args.shift();
    else if (arg === "--artifact") options.artifact = args.shift();
    else if (arg === "--package-qa") options.packageQa = args.shift();
    else if (arg === "--render-qa") options.renderQa = args.shift();
    else if (arg === "--powerpoint-verification") options.powerPointVerification = args.shift();
    else throw new Error(`unknown option: ${arg}`);
  }
  return { positional, options };
}

function validateEvidence(jobDir, evidence) {
  for (const relativePath of evidence) {
    if (!isSafeRelativePath(relativePath)) throw new Error(`unsafe evidence path: ${String(relativePath)}`);
    resolveJobPath(jobDir, relativePath, { mustExist: true });
  }
}

function findDrift(jobDir, job) {
  const drift = [];
  for (const [key, record] of Object.entries(job.trackedArtifacts || {})) {
    if (!record || !isSafeRelativePath(record.path)) {
      drift.push({ key, stage: record && record.stage || "briefed", reason: "invalid tracked path" });
      continue;
    }
    try {
      const actual = sha256File(resolveJobPath(jobDir, record.path, { mustExist: true }));
      if (actual !== record.sha256) drift.push({ key, stage: record.stage, reason: `hash changed from ${record.sha256} to ${actual}` });
    } catch (error) {
      drift.push({ key, stage: record.stage, reason: error.message });
    }
  }
  const deckRecord = job.trackedArtifacts && job.trackedArtifacts.deck;
  if (deckRecord && isSafeRelativePath(deckRecord.path)) {
    try {
      const deck = loadJson(resolveJobPath(jobDir, deckRecord.path, { mustExist: true }));
      const currentLayoutsHash = sha256File(LAYOUTS_PATH);
      if (!deck.compiledFrom || deck.compiledFrom.layouts !== currentLayoutsHash) {
        drift.push({ key: "deck-layouts", stage: "packaged", reason: `layout registry changed to ${currentLayoutsHash}` });
      }
    } catch (error) {
      drift.push({ key: "deck-layouts", stage: "packaged", reason: error.message });
    }
  }
  return drift;
}

function archiveReleasedArtifacts(jobDir, job, timestamp) {
  if (!jobDir) return [];
  const moves = [];
  const stamp = timestamp.replace(/[:.]/g, "-");
  try {
    for (const level of ["candidate", "final"]) {
      const record = job.release && job.release[level];
      if (!record || record.status !== "released" || !isSafeRelativePath(record.artifact)) continue;
      const source = resolveJobPath(jobDir, record.artifact);
      if (!fs.existsSync(source)) continue;
      const hash = validReleaseHash(record.sha256) ? record.sha256.slice("sha256:".length, "sha256:".length + 8) : sha256File(source).slice("sha256:".length, "sha256:".length + 8);
      const relativeDestination = `archive/invalidated/${stamp}-${level}-${hash}.pptx`;
      const destination = resolveJobPath(jobDir, relativeDestination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) throw new Error(`archive destination already exists: ${relativeDestination}`);
      fs.renameSync(source, destination);
      moves.push({ source, destination, relativeDestination });
    }
  } catch (error) {
    for (const move of [...moves].reverse()) {
      if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) fs.renameSync(move.destination, move.source);
    }
    throw error;
  }
  return moves;
}

function validReleaseHash(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function invalidateForDrift(job, drift, jobDir = null) {
  if (drift.length === 0) return null;
  const previousStage = job.state.stage;
  const firstIndex = Math.min(...drift.map((item) => Math.max(1, STAGES.indexOf(item.stage))));
  const resetStage = STAGES[firstIndex - 1];
  const timestamp = now();
  const reason = drift.map((item) => `${item.key}: ${item.reason}`).join("; ");
  const archiveMoves = archiveReleasedArtifacts(jobDir, job, timestamp);
  const archivedEvidence = archiveMoves.map((move) => move.relativeDestination);
  job.state.invalidatedStages.push(...STAGES.slice(firstIndex).map((stage) => ({ stage, reason, at: timestamp })));
  job.state.completedStages = job.state.completedStages.filter((stage) => STAGES.indexOf(stage) < firstIndex);
  job.state.stage = resetStage;
  job.state.status = "active";
  job.state.updatedAt = timestamp;
  job.state.history.push({
    from: previousStage,
    to: resetStage,
    at: timestamp,
    inputHashes: Object.fromEntries(Object.entries(job.trackedArtifacts || {}).map(([key, record]) => [key, record.sha256])),
    evidence: archivedEvidence,
    note: `automatic upstream invalidation: ${reason}`,
  });
  for (const [key, record] of Object.entries(job.trackedArtifacts || {})) {
    if (STAGES.indexOf(record.stage) >= firstIndex) delete job.trackedArtifacts[key];
  }
  job.release = emptyRelease();
  return { previousStage, resetStage, reason, archiveMoves };
}

function rollbackArchivedArtifacts(moves) {
  for (const move of [...(moves || [])].reverse()) {
    if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) fs.renameSync(move.destination, move.source);
  }
}

function commitInvalidation(jobPath, job, invalidation, writer = atomicWriteJson) {
  try {
    writer(jobPath, job);
  } catch (error) {
    try {
      rollbackArchivedArtifacts(invalidation && invalidation.archiveMoves);
    } catch (rollbackError) {
      throw new Error(`${error.message}; archive rollback also failed: ${rollbackError.message}`);
    }
    throw error;
  }
}

function trackStageArtifact(job, stage, hashes) {
  for (const [key, outputStage] of Object.entries(CONTRACT_STAGE)) {
    if (outputStage !== stage || !hashes[key]) continue;
    job.trackedArtifacts[key] = {
      path: CONTRACT_FILES[key],
      sha256: hashes[key],
      stage,
    };
  }
}

function appendTransition(job, to, evidence, note, hashes) {
  const from = job.state.stage;
  const timestamp = now();
  job.state.history.push({
    from,
    to,
    at: timestamp,
    inputHashes: { ...hashes },
    evidence: [...evidence],
    note: note || "",
  });
  job.state.stage = to;
  if (to !== "initialized" && !job.state.completedStages.includes(to)) job.state.completedStages.push(to);
  job.state.status = to === "final-released" ? "complete" : "active";
  job.state.updatedAt = timestamp;
}

function reportValidation(result, json) {
  if (json) console.log(JSON.stringify(printableResult(result), null, 2));
  else if (result.ok) console.log(`PASS (${result.releaseLevel || `through ${result.checkedThrough}`})`);
  else {
    for (const error of result.errors) console.error(`[${error.code}] ${error.path}: ${error.message}`);
  }
}

function commandInit(positional, options) {
  const jobDir = positional[0];
  if (!jobDir) throw new Error("usage: jobctl init <job-dir> [--job-id <id>]");
  const root = path.resolve(jobDir);
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new Error(`job path is not a directory: ${root}`);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const unexpected = entries.filter((entry) => entry.name !== ".DS_Store" && !(entry.name === "inputs" && entry.isDirectory() && !entry.isSymbolicLink()));
    if (unexpected.length > 0) {
      throw new Error(`refusing to initialize non-empty job directory with prior artifacts: ${unexpected.map((entry) => entry.name).join(", ")}`);
    }
  }
  fs.mkdirSync(root, { recursive: true });
  const jobPath = path.join(root, "job.json");
  if (fs.existsSync(jobPath)) throw new Error(`refusing to overwrite existing ${jobPath}`);
  const inferred = path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const jobId = options.jobId || inferred;
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(jobId)) throw new Error("job ID must be a lowercase slug with 2 through 64 characters");
  atomicWriteJson(jobPath, defaultJob(jobId));
  console.log(jobPath);
}

function commandRefresh(positional) {
  const jobDir = positional[0];
  if (!jobDir) throw new Error("usage: jobctl refresh <job-dir>");
  const { jobPath, job } = loadJob(jobDir);
  const drift = findDrift(jobDir, job);
  if (drift.length === 0) {
    console.log("no tracked artifact drift");
    return;
  }
  const invalidation = invalidateForDrift(job, drift, jobDir);
  commitInvalidation(jobPath, job, invalidation);
  console.log(`invalidated ${invalidation.previousStage} -> ${invalidation.resetStage}: ${invalidation.reason}`);
}

function commandStatus(positional, options) {
  const jobDir = positional[0];
  if (!jobDir) throw new Error("usage: jobctl status <job-dir> [--json]");
  const result = validateJob(jobDir);
  reportValidation(result, options.json);
  if (!result.ok) process.exitCode = 1;
}

function commandAdvance(positional, options) {
  const [jobDir, target] = positional;
  if (!jobDir || !target) throw new Error("usage: jobctl advance <job-dir> <stage> [--evidence <relative-path>] [--note <text>]");
  if (!STAGES.includes(target)) throw new Error(`unknown stage: ${target}`);
  if (["qa-passed", "candidate-released", "final-released"].includes(target)) {
    throw new Error(`${target} is a release gate; use jobctl release instead`);
  }
  const { jobPath, job } = loadJob(jobDir);
  const drift = findDrift(jobDir, job);
  if (drift.length) {
    const invalidation = invalidateForDrift(job, drift, jobDir);
    commitInvalidation(jobPath, job, invalidation);
    throw new Error(`upstream drift invalidated the job to ${invalidation.resetStage}; update downstream contracts before advancing`);
  }
  const currentIndex = STAGES.indexOf(job.state.stage);
  if (STAGES[currentIndex + 1] !== target) throw new Error(`illegal transition ${job.state.stage} -> ${target}; expected ${STAGES[currentIndex + 1]}`);
  validateEvidence(jobDir, options.evidence);
  const result = validateJob(jobDir, { throughStage: target });
  if (!result.ok) {
    reportValidation(result, options.json);
    process.exitCode = 1;
    return;
  }
  if (target === "packaged") {
    const relativePath = job.release.candidate.artifact || "build/candidate.staging.pptx";
    const absolutePath = resolveJobPath(jobDir, relativePath, { mustExist: true });
    const head = fs.readFileSync(absolutePath).subarray(0, 4);
    if (head.length < 4 || !head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error(`${relativePath} is not a PPTX/ZIP package`);
  }
  trackStageArtifact(job, target, result.currentHashes);
  appendTransition(job, target, options.evidence, options.note, result.currentHashes);
  atomicWriteJson(jobPath, job);
  console.log(`${job.state.history.at(-1).from} -> ${target}`);
}

function loadEvidenceObject(jobDir, relativePath, label) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`unsafe ${label} path: ${String(relativePath)}`);
  const absolutePath = resolveJobPath(jobDir, relativePath, { mustExist: true });
  const value = loadJson(absolutePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return { value, sha256: sha256File(absolutePath) };
}

function runDirectPackagePreflight(jobDir, artifactPath, releaseLevel, providedQa) {
  const qaDir = path.join(path.resolve(jobDir), "qa");
  fs.mkdirSync(qaDir, { recursive: true });
  const reportPath = path.join(qaDir, `.direct-package-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  let report = null;
  try {
    const run = spawnSync(process.execPath, [
      PPTX_VALIDATOR_PATH,
      artifactPath,
      "--deck",
      path.join(path.resolve(jobDir), "deck.json"),
      "--release",
      releaseLevel,
      "--report",
      reportPath,
    ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (fs.existsSync(reportPath)) report = loadJson(reportPath);
    if (run.status !== 0 || !report || report.passed !== true) {
      const details = report && Array.isArray(report.errors) ? report.errors.join("; ") : (run.stderr || run.stdout || "no report").trim();
      throw releaseGateError(`direct PPTX package preflight failed: ${details}`);
    }
    for (const key of ["artifactSha256", "deckSha256", "expectedContentPages", "embeddedVideoCount", "posterCount", "timingCount", "relationshipsValid", "mimeTypesValid", "aspectRatiosValid", "passed"]) {
      if (providedQa[key] !== report[key]) throw releaseGateError(`provided package QA differs from direct preflight at ${key}`);
    }
    return report;
  } finally {
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  }
}

function commandReleaseCandidate(jobDir, jobPath, job, options) {
  if (!["packaged", "qa-passed"].includes(job.state.stage)) throw new Error(`candidate release requires packaged stage, got ${job.state.stage}`);
  const artifact = options.artifact || "build/candidate.staging.pptx";
  const packageQaPath = options.packageQa || "qa/package-qa.json";
  const renderQaPath = options.renderQa || "qa/render-qa.json";
  if (artifact !== "build/candidate.staging.pptx") throw new Error("candidate input must be build/candidate.staging.pptx");
  const artifactPath = resolveJobPath(jobDir, artifact, { mustExist: true });
  const evidence = loadEvidenceObject(jobDir, packageQaPath, "package QA evidence");
  const renderEvidence = loadEvidenceObject(jobDir, renderQaPath, "render QA evidence");
  const artifactSha256 = sha256File(artifactPath);
  const packageQa = {
    artifactSha256: evidence.value.artifactSha256,
    deckSha256: evidence.value.deckSha256,
    expectedContentPages: evidence.value.expectedContentPages,
    embeddedVideoCount: evidence.value.embeddedVideoCount,
    posterCount: evidence.value.posterCount,
    timingCount: evidence.value.timingCount,
    relationshipsValid: evidence.value.relationshipsValid,
    mimeTypesValid: evidence.value.mimeTypesValid,
    aspectRatiosValid: evidence.value.aspectRatiosValid,
    passed: evidence.value.passed,
    evidencePath: packageQaPath,
    evidenceSha256: evidence.sha256,
  };
  const renderQa = {
    artifactSha256: renderEvidence.value.artifactSha256,
    slideCount: renderEvidence.value.slideCount,
    renderIndexPath: renderEvidence.value.renderIndexPath,
    renderIndexSha256: renderEvidence.value.renderIndexSha256,
    renderedSlides: renderEvidence.value.renderedSlides,
    allSlidesInspected: renderEvidence.value.allSlidesInspected,
    overflowPassed: renderEvidence.value.overflowPassed,
    textWrapPassed: renderEvidence.value.textWrapPassed,
    cropPassed: renderEvidence.value.cropPassed,
    mediaPosterPassed: renderEvidence.value.mediaPosterPassed,
    layoutRhythmPassed: renderEvidence.value.layoutRhythmPassed,
    passed: renderEvidence.value.passed,
    evidencePath: renderQaPath,
    evidenceSha256: renderEvidence.sha256,
  };
  job.release.candidate = {
    status: "none",
    artifact,
    sha256: artifactSha256,
    validatedAt: null,
    playbackVerified: false,
    packageQa,
    renderQa,
  };
  const result = validateJob(jobDir, { jobOverride: job, throughStage: "qa-passed", releaseLevel: "candidate" });
  if (!result.ok) {
    reportValidation(result, options.json);
    process.exitCode = 1;
    return;
  }
  runDirectPackagePreflight(jobDir, artifactPath, "candidate", packageQa);
  const publishedArtifact = "candidate.pptx";
  const publishedPath = resolveJobPath(jobDir, publishedArtifact);
  publishWithRollback(artifactPath, publishedPath, () => {
    job.release.candidate.artifact = publishedArtifact;
    if (job.state.stage === "packaged") appendTransition(job, "qa-passed", [packageQaPath, renderQaPath], "package and true-render QA passed", result.currentHashes);
    job.release.candidate.status = "released";
    job.release.candidate.validatedAt = now();
    appendTransition(job, "candidate-released", [publishedArtifact, packageQaPath, renderQaPath], "candidate released; PowerPoint playback remains unverified", result.currentHashes);
    atomicWriteJson(jobPath, job);
  });
  console.log(publishedPath);
}

function commandReleaseFinal(jobDir, jobPath, job, options) {
  if (job.state.stage !== "candidate-released" || job.release.candidate.status !== "released") {
    throw new Error("final release requires a released candidate");
  }
  const artifact = options.artifact || "build/final.staging.pptx";
  const packageQaPath = options.packageQa || "qa/final-package-qa.json";
  const renderQaPath = options.renderQa || "qa/final-render-qa.json";
  const verificationPath = options.powerPointVerification || "qa/powerpoint-verification.json";
  if (artifact !== "build/final.staging.pptx") throw new Error("final input must be build/final.staging.pptx");
  const artifactPath = resolveJobPath(jobDir, artifact, { mustExist: true });
  const packageEvidence = loadEvidenceObject(jobDir, packageQaPath, "final package QA evidence");
  const renderEvidence = loadEvidenceObject(jobDir, renderQaPath, "final render QA evidence");
  const evidence = loadEvidenceObject(jobDir, verificationPath, "PowerPoint verification evidence");
  const packageQa = {
    artifactSha256: packageEvidence.value.artifactSha256,
    deckSha256: packageEvidence.value.deckSha256,
    expectedContentPages: packageEvidence.value.expectedContentPages,
    embeddedVideoCount: packageEvidence.value.embeddedVideoCount,
    posterCount: packageEvidence.value.posterCount,
    timingCount: packageEvidence.value.timingCount,
    relationshipsValid: packageEvidence.value.relationshipsValid,
    mimeTypesValid: packageEvidence.value.mimeTypesValid,
    aspectRatiosValid: packageEvidence.value.aspectRatiosValid,
    passed: packageEvidence.value.passed,
    evidencePath: packageQaPath,
    evidenceSha256: packageEvidence.sha256,
  };
  const renderQa = {
    artifactSha256: renderEvidence.value.artifactSha256,
    slideCount: renderEvidence.value.slideCount,
    renderIndexPath: renderEvidence.value.renderIndexPath,
    renderIndexSha256: renderEvidence.value.renderIndexSha256,
    renderedSlides: renderEvidence.value.renderedSlides,
    allSlidesInspected: renderEvidence.value.allSlidesInspected,
    overflowPassed: renderEvidence.value.overflowPassed,
    textWrapPassed: renderEvidence.value.textWrapPassed,
    cropPassed: renderEvidence.value.cropPassed,
    mediaPosterPassed: renderEvidence.value.mediaPosterPassed,
    layoutRhythmPassed: renderEvidence.value.layoutRhythmPassed,
    passed: renderEvidence.value.passed,
    evidencePath: renderQaPath,
    evidenceSha256: renderEvidence.sha256,
  };
  job.release.final = {
    status: "none",
    artifact,
    sha256: sha256File(artifactPath),
    validatedAt: null,
    packageQa,
    renderQa,
    powerPointVerification: {
      artifactSha256: evidence.value.artifactSha256,
      platform: evidence.value.platform,
      appVersion: evidence.value.appVersion,
      testedAt: evidence.value.testedAt,
      capturePath: evidence.value.capturePath,
      captureSha256: evidence.value.captureSha256,
      testedSlideIds: evidence.value.testedSlideIds,
      evidencePath: verificationPath,
      evidenceSha256: evidence.sha256,
      autoPlayOnce: evidence.value.autoPlayOnce,
      noLoop: evidence.value.noLoop,
      manualAdvance: evidence.value.manualAdvance,
      passed: evidence.value.passed,
    },
  };
  const result = validateJob(jobDir, { jobOverride: job, throughStage: "final-released", releaseLevel: "final" });
  if (!result.ok) {
    reportValidation(result, options.json);
    process.exitCode = 1;
    return;
  }
  runDirectPackagePreflight(jobDir, artifactPath, "final", packageQa);
  const publishedArtifact = "final.pptx";
  const publishedPath = resolveJobPath(jobDir, publishedArtifact);
  publishWithRollback(artifactPath, publishedPath, () => {
    job.release.final.artifact = publishedArtifact;
    job.release.final.status = "released";
    job.release.final.validatedAt = now();
    appendTransition(job, "final-released", [publishedArtifact, packageQaPath, renderQaPath, verificationPath], "final package, true render, and PowerPoint playback verified; final released", result.currentHashes);
    atomicWriteJson(jobPath, job);
  });
  console.log(publishedPath);
}

function commandRelease(positional, options) {
  const [jobDir, level] = positional;
  if (!jobDir || !["candidate", "final"].includes(level)) {
    throw new Error("usage: jobctl release <job-dir> candidate|final [--artifact <relative-path>] [--package-qa <relative-path>] [--render-qa <relative-path>] [--powerpoint-verification <relative-path>]");
  }
  const { jobPath, job } = loadJob(jobDir);
  const drift = findDrift(jobDir, job);
  if (drift.length) {
    const invalidation = invalidateForDrift(job, drift, jobDir);
    commitInvalidation(jobPath, job, invalidation);
    throw new Error(`upstream drift invalidated the job to ${invalidation.resetStage}; release refused`);
  }
  if (level === "candidate") commandReleaseCandidate(jobDir, jobPath, job, options);
  else commandReleaseFinal(jobDir, jobPath, job, options);
}

function usage() {
  return [
    "usage:",
    "  jobctl init <job-dir> [--job-id <id>]",
    "  jobctl advance <job-dir> <stage> [--evidence <relative-path>] [--note <text>]",
    "  jobctl refresh <job-dir>",
    "  jobctl status <job-dir> [--json]",
    "  jobctl release <job-dir> candidate [--artifact build/candidate.staging.pptx] [--package-qa qa/package-qa.json] [--render-qa qa/render-qa.json]",
    "  jobctl release <job-dir> final [--artifact build/final.staging.pptx] [--package-qa qa/final-package-qa.json] [--render-qa qa/final-render-qa.json] [--powerpoint-verification qa/powerpoint-verification.json]",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
    return;
  }
  let parsed;
  try {
    parsed = parseOptions(args);
    if (command === "init") commandInit(parsed.positional, parsed.options);
    else if (command === "advance") commandAdvance(parsed.positional, parsed.options);
    else if (command === "refresh") commandRefresh(parsed.positional, parsed.options);
    else if (command === "status") commandStatus(parsed.positional, parsed.options);
    else if (command === "release") commandRelease(parsed.positional, parsed.options);
    else throw new Error(`unknown command: ${command}\n${usage()}`);
  } catch (error) {
    fail(error && error.message ? error.message : String(error), error && error.exitCode ? error.exitCode : 2);
  }
}

module.exports = {
  defaultJob,
  atomicWriteJson,
  publishWithRollback,
  runDirectPackagePreflight,
  rollbackArchivedArtifacts,
  commitInvalidation,
  findDrift,
  invalidateForDrift,
};

if (require.main === module) main();

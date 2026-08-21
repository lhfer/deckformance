#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  CONTRACT_FILES,
  CONTRACT_STAGE,
  EXPECTED_PACKAGE_REPORT,
  EXPECTED_POWERPOINT_RECEIPT,
  EXPECTED_RENDER_INDEX,
  EXPECTED_RENDER_QA,
  EXPECTED_STAGING,
  SCHEMA_VERSION,
  STAGES,
  printableResult,
  validateJobV2,
} = require("./validate_job_v2");
const {
  isSafeRelativePath,
  loadJson,
  resolveJobPath,
  sha256File,
} = require("./validate_job");
const { validatePptxV2 } = require("./validate_pptx_v2");
const { recheckRenderEvidence } = require("./runtime/render_recheck");

function now() {
  return new Date().toISOString();
}

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

async function assertReleasePreflight(root, release, dependencies = {}) {
  const preflightImpl = dependencies.preflightImpl || require("./preflight").runPreflight;
  const result = await preflightImpl({ jobDir: root, release });
  if (!result || !["ready", "degraded", "blocked"].includes(result.status)) {
    fail(`${release} release preflight returned an invalid status`);
  }
  if (result.status === "blocked") {
    fail(`${release} release preflight is blocked; resolve every required runtime and contract failure before publication`);
  }
  if (result.status === "degraded") {
    (dependencies.warnImpl || console.error)(`${release} release preflight is degraded; publication still requires strict external generate-video evidence for every dynamic slide and no missing capability may be substituted`);
  }
  return result;
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
      sourceCandidateSha256: null,
      powerPointVerification: null,
    },
  };
}

function defaultJob(jobId, timestamp = now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactKind: "job-state",
    jobId,
    state: {
      stage: "initialized",
      status: "active",
      completedStages: [],
      invalidatedStages: [],
      updatedAt: timestamp,
      history: [],
    },
    artifacts: { ...CONTRACT_FILES },
    trackedArtifacts: {},
    release: emptyRelease(),
  };
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.job-v2-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function snapshotReleaseInputs(jobDir) {
  const root = fs.realpathSync(path.resolve(jobDir));
  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) fail(`release inputs contain a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ path: relative, bytes: fs.statSync(absolute).size, sha256: sha256File(absolute) });
      else fail(`release inputs contain an unsupported filesystem entry: ${relative}`);
    }
  }
  visit(root);
  return files;
}

function assertReleaseInputsUnchanged(jobDir, snapshot) {
  const current = snapshotReleaseInputs(jobDir);
  if (sameJson(current, snapshot)) return current;
  const before = new Map((snapshot || []).map((item) => [item.path, item]));
  const after = new Map(current.map((item) => [item.path, item]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].sort().find((key) => !sameJson(before.get(key), after.get(key)));
  fail(`release inputs changed after validation${changed ? `: ${changed}` : ""}`);
}

function loadJob(jobDir) {
  const root = path.resolve(jobDir);
  const jobPath = path.join(root, "job.json");
  if (!fs.existsSync(jobPath)) fail(`missing ${jobPath}; run jobctl_v2 init first`, 2);
  const job = loadJson(jobPath);
  if (job.schemaVersion !== SCHEMA_VERSION || job.artifactKind !== "job-state") fail("job.json is not a Deckformance v2 job", 2);
  return { root, jobPath, job };
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
    else fail(`unknown option: ${arg}`, 2);
  }
  for (const [key, value] of Object.entries(options)) if (key !== "evidence" && key !== "json" && value === undefined) fail(`missing value for --${key}`, 2);
  if (options.evidence.some((value) => value === undefined)) fail("--evidence requires a value", 2);
  return { positional, options };
}

function validateEvidence(jobDir, evidence) {
  for (const relativePath of evidence) {
    if (!isSafeRelativePath(relativePath)) fail(`unsafe evidence path: ${String(relativePath)}`, 2);
    resolveJobPath(jobDir, relativePath, { mustExist: true });
  }
}

function loadEvidence(jobDir, relativePath, label) {
  if (!isSafeRelativePath(relativePath)) fail(`unsafe ${label} path: ${String(relativePath)}`, 2);
  const filePath = resolveJobPath(jobDir, relativePath, { mustExist: true });
  const value = loadJson(filePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must contain a JSON object`, 2);
  return { value, sha256: sha256File(filePath) };
}

function appendTransition(job, target, evidence, note, hashes, timestamp = now()) {
  const from = job.state.stage;
  job.state.history.push({ from, to: target, at: timestamp, inputHashes: { ...hashes }, evidence: [...evidence], note: note || "" });
  job.state.stage = target;
  if (target !== "initialized" && !job.state.completedStages.includes(target)) job.state.completedStages.push(target);
  job.state.status = target === "final-released" ? "complete" : "active";
  job.state.updatedAt = timestamp;
}

function trackStageArtifact(job, stage, hashes) {
  for (const [key, artifactStage] of Object.entries(CONTRACT_STAGE)) {
    if (artifactStage !== stage || !hashes[key]) continue;
    job.trackedArtifacts[key] = { path: CONTRACT_FILES[key], sha256: hashes[key], stage };
  }
}

function reportValidation(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(printableResult(result), null, 2)}\n`);
  else if (result.ok) process.stdout.write(`PASS (${result.releaseLevel || `through ${result.checkedThrough}`})\n`);
  else result.errors.forEach((error) => process.stderr.write(`[${error.code}] ${error.path}: ${error.message}\n`));
}

function descriptorDrift(jobDir, value, stage, prefix, drift, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value) && isSafeRelativePath(value.path) && typeof value.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(value.sha256)) {
    try {
      const actual = sha256File(resolveJobPath(jobDir, value.path, { mustExist: true }));
      if (actual !== value.sha256) drift.push({ key: prefix, stage, reason: `${value.path} changed from ${value.sha256} to ${actual}` });
    } catch (error) {
      drift.push({ key: prefix, stage, reason: error.message });
    }
  }
  if (Array.isArray(value)) value.forEach((item, index) => descriptorDrift(jobDir, item, stage, `${prefix}[${index}]`, drift, seen));
  else Object.entries(value).forEach(([key, child]) => descriptorDrift(jobDir, child, stage, `${prefix}.${key}`, drift, seen));
}

function mappedValidationDrift(jobDir, job, drift) {
  const releaseLevel = job.release && job.release.final && job.release.final.status === "released"
    ? "final"
    : job.release && job.release.candidate && job.release.candidate.status === "released"
      ? "candidate"
      : null;
  const stage = job.state && job.state.stage;
  const result = validateJobV2(jobDir, {
    jobOverride: job,
    releaseLevel,
    skipEnvironmentBindings: false,
  });
  const mapping = {
    STYLE_PACK_DRIFT: "design-planned",
    FONT_DRIFT: "design-planned",
    PERFORMANCE_BIBLE_DRIFT: "media-ready",
    DECK_DRIFT: "packaged",
    PACKAGE_VALIDATOR_DRIFT: "qa-passed",
    PACKAGE_QA: "qa-passed",
    STALE_PACKAGE_QA: "qa-passed",
    PACKAGE_QA_RECEIPT: "qa-passed",
    PACKAGE_RUNTIME_RECEIPT: "qa-passed",
    RENDER_PRODUCER_DRIFT: "qa-passed",
    RENDER_QA: "qa-passed",
    STALE_RENDER_QA: "qa-passed",
    RENDER_INDEX: "qa-passed",
    RENDER_IMPLEMENTATION_RECEIPT: "qa-passed",
    RENDER_RUNTIME_RECEIPT: "qa-passed",
    RENDER_FRAME_BINDING: "qa-passed",
    POWERPOINT_VERIFICATION: "final-released",
    STALE_POWERPOINT_VERIFICATION: "final-released",
    POWERPOINT_CAPTURE: "final-released",
    POWERPOINT_SYSTEM: "final-released",
    POWERPOINT_TEST_LOG: "final-released",
    POWERPOINT_PLAYBACK: "final-released",
    POWERPOINT_SLIDE_COVERAGE: "final-released",
  };
  for (const error of result.errors) {
    let driftStage = mapping[error.code];
    if (!driftStage && ["STALE_EVIDENCE", "MISSING_EVIDENCE", "INVALID_PNG", "INVALID_PPTX"].includes(error.code)) {
      driftStage = /powerpoint|job\.release\.final/i.test(error.path) ? "final-released" : "qa-passed";
    }
    if (!driftStage || STAGES.indexOf(driftStage) > STAGES.indexOf(stage)) continue;
    drift.push({ key: error.code.toLowerCase(), stage: driftStage, reason: `${error.path}: ${error.message}` });
  }
}

function findDrift(jobDir, job) {
  const drift = [];
  for (const [key, record] of Object.entries(job.trackedArtifacts || {})) {
    if (!record || !isSafeRelativePath(record.path) || !STAGES.includes(record.stage)) {
      drift.push({ key, stage: record && record.stage || "briefed", reason: "invalid tracked artifact record" });
      continue;
    }
    try {
      const actual = sha256File(resolveJobPath(jobDir, record.path, { mustExist: true }));
      if (actual !== record.sha256) drift.push({ key, stage: record.stage, reason: `hash changed from ${record.sha256} to ${actual}` });
    } catch (error) {
      drift.push({ key, stage: record.stage, reason: error.message });
    }
  }
  try {
    if (job.trackedArtifacts && job.trackedArtifacts.brief) descriptorDrift(jobDir, loadJson(resolveJobPath(jobDir, CONTRACT_FILES.brief, { mustExist: true })), "briefed", "brief", drift);
    if (job.trackedArtifacts && job.trackedArtifacts.characterModel) descriptorDrift(jobDir, loadJson(resolveJobPath(jobDir, CONTRACT_FILES.characterModel, { mustExist: true })), "character-ready", "characterModel", drift);
    if (job.trackedArtifacts && job.trackedArtifacts.visualPlan) descriptorDrift(jobDir, loadJson(resolveJobPath(jobDir, CONTRACT_FILES.visualPlan, { mustExist: true })), "visual-planned", "visualPlan", drift);
    if (job.trackedArtifacts && job.trackedArtifacts.designPlan) descriptorDrift(jobDir, loadJson(resolveJobPath(jobDir, CONTRACT_FILES.designPlan, { mustExist: true })), "design-planned", "designPlan", drift);
    if (job.trackedArtifacts && job.trackedArtifacts.assetManifest) descriptorDrift(jobDir, loadJson(resolveJobPath(jobDir, CONTRACT_FILES.assetManifest, { mustExist: true })), "media-ready", "assetManifest", drift);
  } catch (error) {
    drift.push({ key: "bound-assets", stage: "design-planned", reason: error.message });
  }
  mappedValidationDrift(jobDir, job, drift);
  const unique = new Map();
  for (const item of drift) unique.set(`${item.key}|${item.stage}|${item.reason}`, item);
  return [...unique.values()];
}

function archiveReleasedArtifacts(jobDir, job, timestamp, levels = ["candidate", "final"]) {
  const moves = [];
  const stamp = timestamp.replace(/[:.]/g, "-");
  try {
    for (const level of levels) {
      const record = job.release && job.release[level];
      if (!record || record.status !== "released" || !isSafeRelativePath(record.artifact)) continue;
      const source = resolveJobPath(jobDir, record.artifact);
      if (!fs.existsSync(source)) continue;
      const actualHash = sha256File(source);
      const shortHash = actualHash.slice("sha256:".length, "sha256:".length + 12);
      const relativeDestination = `archive/invalidated/${stamp}-${level}-${shortHash}.pptx`;
      const destination = resolveJobPath(jobDir, relativeDestination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) fail(`archive destination already exists: ${relativeDestination}`);
      fs.renameSync(source, destination);
      moves.push({ source, destination, relativeDestination, level });
    }
    return moves;
  } catch (error) {
    rollbackArchivedArtifacts(moves);
    throw error;
  }
}

function rollbackArchivedArtifacts(moves) {
  for (const move of [...(moves || [])].reverse()) if (fs.existsSync(move.destination) && !fs.existsSync(move.source)) fs.renameSync(move.destination, move.source);
}

function invalidateForDrift(job, drift, jobDir = null, timestamp = now()) {
  if (!drift.length) return null;
  const previousStage = job.state.stage;
  const firstIndex = Math.min(...drift.map((item) => Math.max(1, STAGES.indexOf(item.stage))));
  const resetStage = STAGES[firstIndex - 1];
  const reason = drift.map((item) => `${item.key}: ${item.reason}`).join("; ");
  const candidateIndex = STAGES.indexOf("candidate-released");
  const affectedLevels = firstIndex > candidateIndex ? ["final"] : ["candidate", "final"];
  const archiveMoves = jobDir ? archiveReleasedArtifacts(jobDir, job, timestamp, affectedLevels) : [];
  const archiveEvidence = archiveMoves.map((move) => move.relativeDestination);
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
    evidence: archiveEvidence,
    note: `automatic upstream invalidation: ${reason}`,
  });
  for (const [key, record] of Object.entries(job.trackedArtifacts || {})) if (STAGES.indexOf(record.stage) >= firstIndex) delete job.trackedArtifacts[key];
  if (affectedLevels.includes("candidate")) job.release = emptyRelease();
  else job.release.final = emptyRelease().final;
  return { previousStage, resetStage, reason, archiveMoves, affectedLevels };
}

function commitInvalidation(jobPath, job, invalidation, writer = atomicWriteJson) {
  try { writer(jobPath, job); }
  catch (error) {
    try { rollbackArchivedArtifacts(invalidation && invalidation.archiveMoves); }
    catch (rollbackError) { throw new Error(`${error.message}; archive rollback failed: ${rollbackError.message}`); }
    throw error;
  }
}

function publishWithRollback(stagingPath, publishedPath, expectedHash, commit, assertBoundary = () => {}) {
  assertBoundary();
  if (fs.existsSync(publishedPath)) fail(`refusing to overwrite existing released artifact: ${path.basename(publishedPath)}`);
  if (sha256File(stagingPath) !== expectedHash) fail("candidate staging bytes changed after direct validation");
  fs.renameSync(stagingPath, publishedPath);
  try {
    if (sha256File(publishedPath) !== expectedHash) fail("published candidate differs from the directly validated staging bytes");
    commit();
  }
  catch (error) {
    try { fs.renameSync(publishedPath, stagingPath); }
    catch (rollbackError) { throw new Error(`${error.message}; artifact rollback failed: ${rollbackError.message}`); }
    throw error;
  }
}

function promoteExactCopyWithRollback(candidatePath, finalPath, expectedHash, commit, assertBoundary = () => {}) {
  assertBoundary();
  if (fs.existsSync(finalPath)) fail("refusing to overwrite existing final.pptx");
  if (sha256File(candidatePath) !== expectedHash) fail("candidate bytes changed before final promotion");
  fs.copyFileSync(candidatePath, finalPath, fs.constants.COPYFILE_EXCL);
  try {
    if (sha256File(finalPath) !== expectedHash) fail("final copy differs from the verified candidate bytes");
    commit();
  } catch (error) {
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    throw error;
  }
}

function packageRecord(evidencePath, evidence) {
  const value = evidence.value;
  return {
    artifactSha256: value.artifactSha256,
    contentPlanSha256: value.contentPlanSha256,
    visualPlanSha256: value.visualPlanSha256,
    designPlanSha256: value.designPlanSha256,
    assetManifestSha256: value.assetManifestSha256,
    deckSha256: value.deckSha256,
    evidencePath,
    evidenceSha256: evidence.sha256,
    passed: value.passed,
  };
}

function renderRecord(visualQaPath, visualEvidence, jobDir) {
  const value = visualEvidence.value;
  const renderIndexPath = value.renderIndexPath;
  if (!isSafeRelativePath(renderIndexPath)) fail("render QA contains an unsafe renderIndexPath", 2);
  const renderIndex = resolveJobPath(jobDir, renderIndexPath, { mustExist: true });
  return {
    artifactSha256: value.artifactSha256,
    renderIndexPath,
    renderIndexSha256: sha256File(renderIndex),
    visualQaPath,
    visualQaSha256: visualEvidence.sha256,
    slideCount: value.slideCount,
    passed: value.passed,
  };
}

function powerpointRecord(receiptPath, evidence) {
  const value = evidence.value;
  return {
    artifactSha256: value.artifactSha256,
    powerPointVersion: value.powerPointVersion,
    system: value.system,
    capturePath: value.capturePath,
    captureSha256: value.captureSha256,
    testLogPath: value.testLogPath,
    testLogSha256: value.testLogSha256,
    evidencePath: receiptPath,
    evidenceSha256: evidence.sha256,
    passed: value.passed,
  };
}

function prepareCandidateRelease(root, job, options = {}) {
  const artifact = options.artifact || EXPECTED_STAGING;
  const packageQaPath = options.packageQa || EXPECTED_PACKAGE_REPORT;
  const renderQaPath = options.renderQa || EXPECTED_RENDER_QA;
  if (artifact !== EXPECTED_STAGING) fail(`candidate input must be ${EXPECTED_STAGING}`, 2);
  const artifactPath = resolveJobPath(root, artifact, { mustExist: true });
  const packageEvidence = loadEvidence(root, packageQaPath, "v2 package QA");
  const visualEvidence = loadEvidence(root, renderQaPath, "v2 render QA");
  const packageQa = packageRecord(packageQaPath, packageEvidence);
  const renderQa = renderRecord(renderQaPath, visualEvidence, root);
  job.release.candidate = {
    status: "none",
    artifact,
    sha256: sha256File(artifactPath),
    validatedAt: null,
    playbackVerified: false,
    packageQa,
    renderQa,
  };
  return { artifact, artifactPath, packageQaPath, renderQaPath, packageEvidence, packageQa, renderQa };
}

function prepareFinalRelease(root, job, options = {}) {
  if (options.artifact && options.artifact !== "candidate.pptx") fail("final promotion accepts candidate.pptx only; no rebuilt final staging bytes are allowed", 2);
  const receiptPath = options.powerPointVerification || EXPECTED_POWERPOINT_RECEIPT;
  const receiptEvidence = loadEvidence(root, receiptPath, "PowerPoint verification");
  const candidatePath = resolveJobPath(root, "candidate.pptx", { mustExist: true });
  const candidateHash = sha256File(candidatePath);
  const verification = powerpointRecord(receiptPath, receiptEvidence);
  job.release.final = {
    status: "none",
    artifact: "candidate.pptx",
    sha256: candidateHash,
    validatedAt: null,
    sourceCandidateSha256: candidateHash,
    powerPointVerification: verification,
  };
  return { receiptPath, receiptEvidence, candidatePath, candidateHash, verification };
}

const DIRECT_REPORT_KEYS = Object.freeze([
  "schemaVersion", "receiptType", "jobId", "release", "artifactPath", "artifactSha256",
  "contentPlanSha256", "visualPlanSha256", "designPlanSha256", "assetManifestSha256", "deckSha256",
  "slideCount", "expectedContentPages", "embeddedVideoCount", "posterCount", "timingCount",
  "embeddedMediaBytes", "maxEmbeddedMediaBytes",
  "relationshipsValid", "mimeTypesValid", "aspectRatiosValid", "collectMediaPassed", "passed",
  "runtime",
]);

function compareDirectReport(provided, direct, options = {}) {
  for (const key of DIRECT_REPORT_KEYS) {
    if (key === "artifactPath" && options.allowPromotedPath === true) {
      if (provided.artifactPath !== EXPECTED_STAGING || direct.artifactPath !== "candidate.pptx") fail("promoted-byte preflight must compare staging evidence with candidate.pptx");
      continue;
    }
    if (key === "runtime" && options.allowRuntimeDrift === true) continue;
    if (!sameJson(provided[key], direct[key])) fail(`provided package QA differs from direct v2 preflight at ${key}`);
  }
  if (!provided.producer || !direct.producer || provided.producer.id !== direct.producer.id || provided.producer.version !== direct.producer.version || provided.producer.implementationSha256 !== direct.producer.implementationSha256) {
    fail("provided package QA producer differs from direct v2 preflight");
  }
  if (!Array.isArray(provided.errors) || provided.errors.length || !Array.isArray(direct.errors) || direct.errors.length) fail("package QA contains errors");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commandInit(positional, options) {
  const jobDir = positional[0];
  if (!jobDir) fail("usage: jobctl_v2 init <job-dir> [--job-id <id>]", 2);
  const root = path.resolve(jobDir);
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) fail(`job path is not a directory: ${root}`, 2);
    const unexpected = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name !== ".DS_Store" && !(entry.name === "inputs" && entry.isDirectory() && !entry.isSymbolicLink()));
    if (unexpected.length) fail(`refusing to initialize non-empty job directory: ${unexpected.map((entry) => entry.name).join(", ")}`, 2);
  }
  fs.mkdirSync(root, { recursive: true });
  const inferred = path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const jobId = options.jobId || inferred;
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(jobId)) fail("job ID must be a lowercase slug with 2 through 64 characters", 2);
  const jobPath = path.join(root, "job.json");
  if (fs.existsSync(jobPath)) fail(`refusing to overwrite ${jobPath}`, 2);
  atomicWriteJson(jobPath, defaultJob(jobId));
  process.stdout.write(`${jobPath}\n`);
}

function commandRefresh(positional) {
  const jobDir = positional[0];
  if (!jobDir) fail("usage: jobctl_v2 refresh <job-dir>", 2);
  const { root, jobPath, job } = loadJob(jobDir);
  const drift = findDrift(root, job);
  if (!drift.length) {
    process.stdout.write("no tracked artifact drift\n");
    return null;
  }
  const invalidation = invalidateForDrift(job, drift, root);
  commitInvalidation(jobPath, job, invalidation);
  process.stdout.write(`invalidated ${invalidation.previousStage} -> ${invalidation.resetStage}: ${invalidation.reason}\n`);
  return invalidation;
}

function commandStatus(positional, options) {
  const jobDir = positional[0];
  if (!jobDir) fail("usage: jobctl_v2 status <job-dir> [--json]", 2);
  const result = validateJobV2(jobDir);
  reportValidation(result, options.json);
  if (!result.ok) process.exitCode = 1;
  return result;
}

function commandAdvance(positional, options) {
  const [jobDir, target] = positional;
  if (!jobDir || !target) fail("usage: jobctl_v2 advance <job-dir> <stage> [--evidence path] [--note text]", 2);
  if (!STAGES.includes(target)) fail(`unknown stage: ${target}`, 2);
  if (["qa-passed", "candidate-released", "final-released"].includes(target)) fail(`${target} is a release gate; use jobctl_v2 release`, 2);
  const { root, jobPath, job } = loadJob(jobDir);
  const drift = findDrift(root, job);
  if (drift.length) {
    const invalidation = invalidateForDrift(job, drift, root);
    commitInvalidation(jobPath, job, invalidation);
    fail(`upstream drift invalidated the job to ${invalidation.resetStage}; update downstream contracts before advancing`);
  }
  const currentIndex = STAGES.indexOf(job.state.stage);
  if (STAGES[currentIndex + 1] !== target) fail(`illegal transition ${job.state.stage} -> ${target}; expected ${STAGES[currentIndex + 1]}`, 2);
  validateEvidence(root, options.evidence);
  const result = validateJobV2(root, { throughStage: target });
  if (!result.ok) {
    reportValidation(result, options.json);
    process.exitCode = 1;
    return result;
  }
  if (target === "packaged") {
    const staging = resolveJobPath(root, EXPECTED_STAGING, { mustExist: true });
    const head = fs.readFileSync(staging).subarray(0, 4);
    if (head.length !== 4 || !head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) fail(`${EXPECTED_STAGING} is not a PPTX/ZIP package`);
  }
  trackStageArtifact(job, target, result.currentHashes);
  appendTransition(job, target, options.evidence, options.note, result.currentHashes);
  atomicWriteJson(jobPath, job);
  process.stdout.write(`${job.state.history.at(-1).from} -> ${target}\n`);
  return result;
}

async function releaseCandidate(root, jobPath, job, options = {}, dependencies = {}) {
  if (!["packaged", "qa-passed"].includes(job.state.stage)) fail(`candidate release requires packaged stage, got ${job.state.stage}`, 2);
  const prepared = prepareCandidateRelease(root, job, options);
  const { artifact, artifactPath, packageQaPath, renderQaPath, packageEvidence, renderQa } = prepared;
  await assertReleasePreflight(root, "candidate", dependencies);
  const result = (dependencies.validateJobImpl || validateJobV2)(root, { jobOverride: job, releaseLevel: "candidate" });
  if (!result.ok) {
    reportValidation(result, options.json);
    process.exitCode = 1;
    return null;
  }
  const inputSnapshot = (dependencies.snapshotImpl || snapshotReleaseInputs)(root);
  const renderRecheck = await (dependencies.renderRecheckImpl || recheckRenderEvidence)(root, job.release.candidate.renderQa, dependencies.renderRecheckOptions || {});
  if (!renderRecheck || renderRecheck.passed !== true) fail("release-time render reproduction did not pass");
  const direct = await (dependencies.validatePptxImpl || validatePptxV2)(root, artifact, { release: "candidate" });
  if (!direct.passed) fail(`direct v2 PPTX preflight failed: ${(direct.errors || []).join("; ")}`);
  compareDirectReport(packageEvidence.value, direct);
  const publishedArtifact = "candidate.pptx";
  const publishedPath = resolveJobPath(root, publishedArtifact);
  (dependencies.publishImpl || publishWithRollback)(artifactPath, publishedPath, job.release.candidate.sha256, () => {
    job.release.candidate.artifact = publishedArtifact;
    job.release.candidate.status = "released";
    job.release.candidate.validatedAt = now();
    if (job.state.stage === "packaged") appendTransition(job, "qa-passed", [packageQaPath, renderQa.renderIndexPath, renderQaPath], "hash-bound package, render, and visual QA passed", result.currentHashes);
    appendTransition(job, "candidate-released", [publishedArtifact, packageQaPath, renderQa.renderIndexPath, renderQaPath], "candidate released; PowerPoint playback remains unverified", result.currentHashes);
    (dependencies.writeJobImpl || atomicWriteJson)(jobPath, job);
  }, () => (dependencies.assertSnapshotImpl || assertReleaseInputsUnchanged)(root, inputSnapshot));
  process.stdout.write(`${publishedPath}\n`);
  return publishedPath;
}

async function releaseFinal(root, jobPath, job, options = {}, dependencies = {}) {
  if (job.state.stage !== "candidate-released" || job.release.candidate.status !== "released") fail("final promotion requires a released candidate", 2);
  const prepared = prepareFinalRelease(root, job, options);
  const { receiptPath, candidatePath, candidateHash, verification } = prepared;
  await assertReleasePreflight(root, "final", dependencies);
  const result = (dependencies.validateJobImpl || validateJobV2)(root, { jobOverride: job, releaseLevel: "final" });
  if (!result.ok) {
    reportValidation(result, options.json);
    process.exitCode = 1;
    return null;
  }
  const inputSnapshot = (dependencies.snapshotImpl || snapshotReleaseInputs)(root);
  const renderRecheck = await (dependencies.renderRecheckImpl || recheckRenderEvidence)(root, job.release.candidate.renderQa, {
    ...(dependencies.renderRecheckOptions || {}),
    sourceArtifactPath: "candidate.pptx",
  });
  if (!renderRecheck || renderRecheck.passed !== true) fail("release-time render reproduction did not pass");
  const direct = await (dependencies.validatePptxImpl || validatePptxV2)(root, "candidate.pptx", {
    release: "candidate",
    requireHumanApproval: true,
  });
  if (!direct.passed) fail(`direct candidate-byte revalidation failed before final promotion: ${(direct.errors || []).join("; ")}`);
  const storedPackage = loadEvidence(root, job.release.candidate.packageQa.evidencePath, "candidate package QA");
  compareDirectReport(storedPackage.value, direct, { allowPromotedPath: true, allowRuntimeDrift: true });
  const finalPath = resolveJobPath(root, "final.pptx");
  (dependencies.promoteImpl || promoteExactCopyWithRollback)(candidatePath, finalPath, candidateHash, () => {
    job.release.final.artifact = "final.pptx";
    job.release.final.status = "released";
    job.release.final.validatedAt = now();
    appendTransition(job, "final-released", ["final.pptx", receiptPath, verification.capturePath], "exact candidate bytes passed real PowerPoint playback and were promoted to final", result.currentHashes);
    (dependencies.writeJobImpl || atomicWriteJson)(jobPath, job);
  }, () => (dependencies.assertSnapshotImpl || assertReleaseInputsUnchanged)(root, inputSnapshot));
  process.stdout.write(`${finalPath}\n`);
  return finalPath;
}

async function commandRelease(positional, options, dependencies = {}) {
  const [jobDir, level] = positional;
  if (!jobDir || !["candidate", "final"].includes(level)) fail("usage: jobctl_v2 release <job-dir> candidate|final", 2);
  const { root, jobPath, job } = loadJob(jobDir);
  const drift = findDrift(root, job);
  if (drift.length) {
    const invalidation = invalidateForDrift(job, drift, root);
    commitInvalidation(jobPath, job, invalidation);
    fail(`upstream drift invalidated the job to ${invalidation.resetStage}; release refused`);
  }
  return level === "candidate"
    ? releaseCandidate(root, jobPath, job, options, dependencies)
    : releaseFinal(root, jobPath, job, options, dependencies);
}

function usage() {
  return [
    "usage:",
    "  jobctl_v2 init <job-dir> [--job-id id]",
    "  jobctl_v2 advance <job-dir> <stage> [--evidence path] [--note text]",
    "  jobctl_v2 refresh <job-dir>",
    "  jobctl_v2 status <job-dir> [--json]",
    `  jobctl_v2 release <job-dir> candidate [--artifact ${EXPECTED_STAGING}] [--package-qa ${EXPECTED_PACKAGE_REPORT}] [--render-qa ${EXPECTED_RENDER_QA}]`,
    `  jobctl_v2 release <job-dir> final [--artifact candidate.pptx] [--powerpoint-verification ${EXPECTED_POWERPOINT_RECEIPT}]`,
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (!command || ["-h", "--help", "help"].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const parsed = parseOptions(args);
  if (command === "init") commandInit(parsed.positional, parsed.options);
  else if (command === "advance") commandAdvance(parsed.positional, parsed.options);
  else if (command === "refresh") commandRefresh(parsed.positional);
  else if (command === "status") commandStatus(parsed.positional, parsed.options);
  else if (command === "release") await commandRelease(parsed.positional, parsed.options);
  else fail(`unknown command: ${command}\n${usage()}`, 2);
}

module.exports = {
  archiveReleasedArtifacts,
  assertReleasePreflight,
  atomicWriteJson,
  commandRelease,
  commitInvalidation,
  compareDirectReport,
  defaultJob,
  emptyRelease,
  findDrift,
  invalidateForDrift,
  main,
  promoteExactCopyWithRollback,
  prepareCandidateRelease,
  prepareFinalRelease,
  publishWithRollback,
  releaseCandidate,
  releaseFinal,
  rollbackArchivedArtifacts,
  snapshotReleaseInputs,
  assertReleaseInputsUnchanged,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exit(error.exitCode || 1);
  });
}

#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GALLERY_INDEX_VERSION = "1.0.0";
const RUN_MANIFEST_TYPE = "deckformance-benchmark-run";
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const RELEASE_LABELS = new Set(["candidate", "final-macos"]);
const COMPLETED_STATUSES = new Set(["completed", "passed", "candidate-released", "final-released"]);
const REQUIRED_EVIDENCE = Object.freeze([
  ["brief", ["brief"]],
  ["content", ["content", "contentPlan"]],
  ["visual", ["visual", "visualPlan"]],
  ["design", ["design", "designPlan"]],
  ["render", ["render", "renders", "renderReceipt"]],
  ["pptx", ["pptx", "deck"]],
  ["qa", ["qa", "qaReceipt", "evaluationReceipt"]],
  ["sources", ["sources", "sourceIndex"]],
  ["benchmark", ["benchmark", "benchmarkReport"]],
]);

class GalleryManifestError extends Error {
  constructor(manifestPath, issues) {
    const rendered = issues.map((issue) => `${issue.code} ${issue.pointer}: ${issue.message}`).join("\n");
    super(`gallery manifest rejected${manifestPath ? ` (${manifestPath})` : ""}:\n${rendered}`);
    this.name = "GalleryManifestError";
    this.manifestPath = manifestPath || null;
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

function sha256Buffer(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function manifestSha256(manifest) {
  return sha256Buffer(JSON.stringify(canonicalize(manifest)));
}

function issue(issues, code, pointer, message) {
  issues.push({ code, pointer, message });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstDefined(object, names) {
  for (const name of names) {
    if (Object.hasOwn(object, name)) return object[name];
  }
  return undefined;
}

function releaseLabel(manifest) {
  if (typeof manifest.release === "string") return manifest.release;
  if (isObject(manifest.release)) return manifest.release.label || manifest.release.level || manifest.release.releaseLevel;
  return manifest.releaseLabel || manifest.releaseLevel;
}

function containsPrivateEvidence(value, pointer = "manifest", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}.${key}`;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "private" && child === true) return childPointer;
    if (["visibility", "privacy", "classification"].includes(normalizedKey) && String(child).toLowerCase() === "private") {
      return childPointer;
    }
    const nested = containsPrivateEvidence(child, childPointer, seen);
    if (nested) return nested;
  }
  return null;
}

function descriptorLocation(descriptor) {
  return descriptor.path || descriptor.url || descriptor.href || null;
}

function normalizeDescriptor(value, category, index, issues, options) {
  const pointer = `evidence.${category}${index === null ? "" : `[${index}]`}`;
  if (!isObject(value)) {
    issue(issues, "EVIDENCE_DESCRIPTOR", pointer, "must be an object");
    return null;
  }
  const sha256 = String(value.sha256 || value.artifactSha256 || "").toLowerCase();
  if (!SHA256_RE.test(sha256)) {
    issue(issues, "EVIDENCE_HASH", `${pointer}.sha256`, "must be a sha256:<64 lowercase hex> binding");
  }
  const location = descriptorLocation(value);
  if (typeof location !== "string" || !location.trim()) {
    issue(issues, "EVIDENCE_LOCATION", pointer, "must provide path, url, or href");
  }
  const isRemote = typeof location === "string" && /^https?:\/\//i.test(location);
  if (isRemote) issue(issues, "REMOTE_UNVERIFIED", pointer, "gallery evidence must be a locally hash-verified snapshot; keep source URLs inside the bound source index");
  let resolvedPath = null;
  if (typeof location === "string" && location.trim() && !isRemote) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) {
      issue(issues, "EVIDENCE_SCHEME", pointer, "only http(s) URLs or local file paths are supported");
    } else {
      resolvedPath = path.resolve(options.baseDir, location);
      if (options.verifyFiles !== false) {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
          issue(issues, "EVIDENCE_FILE", pointer, `local evidence file does not exist: ${location}`);
        } else if (SHA256_RE.test(sha256) && sha256File(resolvedPath) !== sha256) {
          issue(issues, "EVIDENCE_DRIFT", `${pointer}.sha256`, `does not match local evidence bytes: ${location}`);
        }
      }
    }
  }
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : `${category}-${index === null ? 1 : index + 1}`,
    label: typeof value.label === "string" && value.label.trim()
      ? value.label.trim()
      : typeof location === "string" ? path.basename(location) || location : category,
    location: typeof location === "string" ? location : "",
    sha256,
    mediaType: typeof value.mediaType === "string" ? value.mediaType : null,
    resolvedPath,
    remote: isRemote,
  };
}

function normalizeEvidence(value, category, issues, options) {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (list.length === 0) {
    issue(issues, "EVIDENCE_REQUIRED", `evidence.${category}`, "must contain at least one hash-bound evidence descriptor");
    return [];
  }
  return list.map((entry, index) => normalizeDescriptor(entry, category, Array.isArray(value) ? index : null, issues, options)).filter(Boolean);
}

function validateGalleryRunManifest(manifest, options = {}) {
  const issues = [];
  const baseDir = path.resolve(options.baseDir || process.cwd());
  if (!isObject(manifest)) {
    return { valid: false, issues: [{ code: "MANIFEST", pointer: "manifest", message: "must be an object" }], normalized: null };
  }
  if (manifest.manifestType !== undefined && manifest.manifestType !== RUN_MANIFEST_TYPE) {
    issue(issues, "MANIFEST_TYPE", "manifest.manifestType", `must be ${RUN_MANIFEST_TYPE}`);
  }
  for (const field of ["runId", "benchmarkId"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) issue(issues, "IDENTITY", `manifest.${field}`, "is required");
  }
  if (!COMPLETED_STATUSES.has(manifest.status)) {
    issue(issues, "RUN_INCOMPLETE", "manifest.status", `must be one of: ${[...COMPLETED_STATUSES].join(", ")}`);
  }
  const outcome = manifest.outcome || manifest.result || (isObject(manifest.gates) && manifest.gates.passed === true ? "passed" : null);
  if (manifest.status === "completed" && outcome !== "passed") {
    issue(issues, "RUN_NOT_PASSED", "manifest.outcome", "a completed run must explicitly record a passed outcome/result/gates.passed");
  }
  const eligible = manifest.galleryEligible === true || (
    isObject(manifest.releasePolicy) && manifest.releasePolicy.galleryEligible === true
  );
  if (!eligible) issue(issues, "NOT_GALLERY_ELIGIBLE", "manifest.galleryEligible", "must be explicitly true");
  const classification = String(manifest.classification || "").toLowerCase();
  const tags = Array.isArray(manifest.tags) ? manifest.tags.map((tag) => String(tag).toLowerCase()) : [];
  if (classification === "legacy-negative" || tags.includes("legacy-negative")) {
    issue(issues, "LEGACY_NEGATIVE", "manifest.classification", "legacy-negative evidence can never be published");
  }
  const privatePointer = containsPrivateEvidence(manifest);
  if (privatePointer) issue(issues, "PRIVATE_EVIDENCE", privatePointer, "private evidence can never enter the public gallery");
  if (manifest.publicEligible !== true || manifest.visibility !== "public") {
    issue(issues, "NOT_PUBLIC", "manifest.visibility", "gallery evidence must explicitly set visibility=public and publicEligible=true");
  }
  const release = releaseLabel(manifest);
  if (!RELEASE_LABELS.has(release)) {
    issue(issues, "RELEASE_LABEL", "manifest.release", "must be candidate or final-macos");
  }

  const evidenceRoot = isObject(manifest.evidence) ? manifest.evidence : isObject(manifest.artifacts) ? manifest.artifacts : {};
  const evidence = {};
  for (const [category, aliases] of REQUIRED_EVIDENCE) {
    evidence[category] = normalizeEvidence(firstDefined(evidenceRoot, aliases), category, issues, {
      baseDir,
      verifyFiles: options.verifyFiles,
    });
  }
  const benchmarkDescriptor = evidence.benchmark && evidence.benchmark[0];
  if (benchmarkDescriptor && benchmarkDescriptor.resolvedPath) {
    try {
      const report = JSON.parse(fs.readFileSync(benchmarkDescriptor.resolvedPath, "utf8"));
      const { reportSha256, ...unsigned } = report;
      const expectedReportHash = sha256Buffer(JSON.stringify(canonicalize(unsigned)));
      const run = Array.isArray(report.runs) && report.runs.find((entry) => entry.runId === manifest.runId && entry.benchmarkId === manifest.benchmarkId);
      if (
        report.reportType !== "deckformance-benchmark-report" || report.passed !== true ||
        reportSha256 !== expectedReportHash || !run || run.passedWithinBudget !== true
      ) {
        issue(issues, "BENCHMARK_GATE", "evidence.benchmark", "must be a self-hashed passing benchmark report containing this successful run");
      }
    } catch (error) {
      issue(issues, "BENCHMARK_GATE", "evidence.benchmark", `cannot verify benchmark report: ${error.message}`);
    }
  }

  let releaseArtifactSha256 = null;
  if (
    typeof manifest.jobDir !== "string" || !manifest.jobDir.trim() || path.isAbsolute(manifest.jobDir) ||
    manifest.jobDir.includes("\\") || manifest.jobDir.split("/").some((part) => !part || part === "..")
  ) {
    issue(issues, "JOB_VALIDATION", "manifest.jobDir", "must be a safe manifest-relative job directory");
  } else {
    try {
      const lexicalJob = path.resolve(baseDir, ...manifest.jobDir.split("/"));
      const realBase = fs.realpathSync(baseDir);
      const realJob = fs.realpathSync(lexicalJob);
      const relative = path.relative(realBase, realJob);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(realJob).isDirectory()) {
        throw new Error("jobDir leaves the manifest tree");
      }
      const level = release === "final-macos" ? "final" : "candidate";
      const validator = options.releaseValidator || ((jobDir, releaseLevel) => {
        const { validateJobV2 } = require("./validate_job_v2");
        return validateJobV2(jobDir, { releaseLevel });
      });
      const validation = validator(realJob, level);
      if (!validation || validation.ok !== true) {
        issue(issues, "JOB_VALIDATION", "manifest.jobDir", "current v2 release validation did not pass for this job");
      } else {
        releaseArtifactSha256 = validation.artifactSha256 ||
          validation.job && validation.job.release && validation.job.release[level] && validation.job.release[level].sha256 || null;
      }
    } catch (error) {
      issue(issues, "JOB_VALIDATION", "manifest.jobDir", error.message);
    }
  }
  const pptxDescriptor = evidence.pptx && evidence.pptx[0];
  if (releaseArtifactSha256 && (!pptxDescriptor || pptxDescriptor.sha256 !== releaseArtifactSha256)) {
    issue(issues, "JOB_VALIDATION", "evidence.pptx", "PPTX evidence hash differs from the currently validated released artifact");
  }
  const knownLimits = manifest.knownLimits === undefined ? manifest.knownLimitations : manifest.knownLimits;
  if (knownLimits !== undefined && (!Array.isArray(knownLimits) || knownLimits.some((item) => typeof item !== "string" || !item.trim()))) {
    issue(issues, "KNOWN_LIMITS", "manifest.knownLimits", "must be an array of non-empty strings");
  }

  const normalized = {
    schemaVersion: GALLERY_INDEX_VERSION,
    runId: typeof manifest.runId === "string" ? manifest.runId.trim() : "",
    benchmarkId: typeof manifest.benchmarkId === "string" ? manifest.benchmarkId.trim() : "",
    title: typeof manifest.title === "string" && manifest.title.trim()
      ? manifest.title.trim()
      : typeof manifest.benchmarkId === "string" ? manifest.benchmarkId.trim() : "Untitled benchmark",
    track: typeof manifest.track === "string" ? manifest.track : null,
    completedAt: typeof manifest.completedAt === "string" ? manifest.completedAt : null,
    status: manifest.status || null,
    outcome: outcome || (manifest.status === "passed" ? "passed" : null),
    release,
    knownLimits: Array.isArray(knownLimits) ? knownLimits.map((item) => item.trim()) : [],
    evidence,
    manifestSha256: manifestSha256(manifest),
  };
  return { valid: issues.length === 0, issues, normalized };
}

function readRunManifest(manifestPath, options = {}) {
  const absolutePath = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new GalleryManifestError(absolutePath, [{ code: "MANIFEST_READ", pointer: "manifest", message: error.message }]);
  }
  const result = validateGalleryRunManifest(manifest, {
    baseDir: options.baseDir || path.dirname(absolutePath),
    verifyFiles: options.verifyFiles,
    releaseValidator: options.releaseValidator,
  });
  if (!result.valid) throw new GalleryManifestError(absolutePath, result.issues);
  return { ...result.normalized, manifestPath: absolutePath };
}

function safeSlug(value) {
  const slug = String(value).normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "run";
}

function copyEvidence(run, outputDir) {
  const publicEvidence = {};
  for (const [category, descriptors] of Object.entries(run.evidence)) {
    publicEvidence[category] = descriptors.map((descriptor, index) => {
      let href = descriptor.location;
      if (!descriptor.remote && descriptor.resolvedPath) {
        const extension = path.extname(descriptor.resolvedPath);
        const base = safeSlug(path.basename(descriptor.resolvedPath, extension));
        const filename = `${String(index + 1).padStart(2, "0")}-${base}-${descriptor.sha256.slice(7, 15)}${extension}`;
        const relative = path.posix.join("assets", safeSlug(run.runId), safeSlug(category), filename);
        const destination = path.join(outputDir, ...relative.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(descriptor.resolvedPath, destination, fs.constants.COPYFILE_EXCL);
        if (sha256File(destination) !== descriptor.sha256) throw new Error(`gallery copy hash drift: ${relative}`);
        href = relative;
      }
      return {
        id: descriptor.id,
        label: descriptor.label,
        href,
        sha256: descriptor.sha256,
        mediaType: descriptor.mediaType,
      };
    });
  }
  return publicEvidence;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderEvidenceSection(category, descriptors) {
  const title = {
    brief: "Brief",
    content: "Content",
    visual: "Visual",
    design: "Design",
    render: "Render",
    pptx: "PPTX",
    qa: "QA",
    sources: "Sources",
    benchmark: "Benchmark gate",
  }[category] || category;
  const rows = descriptors.map((descriptor) => `
          <li><a href="${escapeHtml(descriptor.href)}">${escapeHtml(descriptor.label)}</a><code>${escapeHtml(descriptor.sha256)}</code></li>`).join("");
  return `<section class="evidence"><h3>${title}</h3><ul>${rows}\n        </ul></section>`;
}

function renderGalleryHtml(index) {
  const cards = index.runs.map((run) => {
    const evidence = Object.entries(run.evidence).map(([category, descriptors]) => renderEvidenceSection(category, descriptors)).join("\n        ");
    const limits = run.knownLimits.length
      ? `<ul>${run.knownLimits.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ul>`
      : "<p>None recorded.</p>";
    return `<article id="${escapeHtml(safeSlug(run.runId))}" class="run-card">
      <header><div><p class="eyebrow">${escapeHtml(run.benchmarkId)}</p><h2>${escapeHtml(run.title)}</h2></div><span class="release ${escapeHtml(run.release)}">${escapeHtml(run.release)}</span></header>
      <p class="status"><strong>Status</strong> ${escapeHtml(run.status)} · ${escapeHtml(run.outcome || "passed")} · <code>${escapeHtml(run.manifestSha256)}</code></p>
      <div class="evidence-grid">
        ${evidence}
      </div>
      <section class="limits"><h3>Known limits</h3>${limits}</section>
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deckformance evidence gallery</title>
  <style>
    :root { color-scheme: light; --ink:#171815; --muted:#66675f; --paper:#f4f0e7; --card:#fffdf8; --line:#d9d3c6; --accent:#315a48; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
    main { width:min(1180px,calc(100% - 32px)); margin:48px auto 80px; }
    h1 { margin:0; font:700 clamp(2.3rem,6vw,5.2rem)/.95 ui-serif,Georgia,serif; letter-spacing:-.045em; }
    .lede { max-width:760px; color:var(--muted); font-size:1.05rem; }
    .run-card { margin-top:32px; padding:clamp(20px,4vw,44px); background:var(--card); border:1px solid var(--line); border-radius:22px; box-shadow:0 18px 45px rgba(50,43,28,.08); }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; }
    h2 { margin:.1rem 0 0; font:700 clamp(1.65rem,3vw,2.6rem)/1.05 ui-serif,Georgia,serif; }
    h3 { margin:0 0 10px; font-size:.75rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
    .eyebrow { margin:0; color:var(--accent); font-size:.78rem; font-weight:800; letter-spacing:.13em; text-transform:uppercase; }
    .release { flex:none; padding:6px 10px; border-radius:999px; color:white; background:var(--accent); font-size:.74rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .release.final-macos { background:#7a442e; }
    .status { color:var(--muted); overflow-wrap:anywhere; }
    .evidence-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:26px; }
    .evidence { padding:16px; border:1px solid var(--line); border-radius:14px; background:#faf7f0; }
    ul { margin:0; padding-left:18px; }
    .evidence li + li { margin-top:10px; }
    a { color:var(--accent); font-weight:700; text-underline-offset:3px; }
    code { display:block; margin-top:3px; color:var(--muted); font-size:.69rem; overflow-wrap:anywhere; }
    .limits { margin-top:24px; padding-top:20px; border-top:1px solid var(--line); }
    @media (max-width:620px) { main { margin-top:28px; } header { display:block; } .release { display:inline-block; margin-top:14px; } }
  </style>
</head>
<body><main>
  <p class="eyebrow">Hash-bound public evidence</p>
  <h1>Deckformance gallery</h1>
  <p class="lede">Only completed, gallery-eligible benchmark runs are shown. Candidate and final-macos are distinct release claims.</p>
  ${cards || "<p>No eligible runs.</p>"}
</main></body>
</html>
`;
}

function buildGallery(options = {}) {
  const manifestPaths = Array.isArray(options.manifests) ? options.manifests : [];
  if (manifestPaths.length === 0) throw new Error("at least one benchmark run manifest is required");
  if (!options.outputDir) throw new Error("outputDir is required");
  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) throw new Error(`gallery output already exists: ${outputDir}`);

  const runs = manifestPaths.map((manifestPath) => readRunManifest(manifestPath, {
    verifyFiles: options.verifyFiles,
    releaseValidator: options.releaseValidator,
  }));
  const identities = new Set();
  for (const run of runs) {
    const identity = `${run.benchmarkId}\u0000${run.runId}`;
    if (identities.has(identity)) throw new Error(`duplicate gallery run: ${run.benchmarkId}/${run.runId}`);
    identities.add(identity);
  }
  runs.sort((left, right) => left.benchmarkId.localeCompare(right.benchmarkId) || left.runId.localeCompare(right.runId));

  fs.mkdirSync(outputDir, { recursive: false });
  try {
    const publicRuns = runs.map((run) => ({
      runId: run.runId,
      benchmarkId: run.benchmarkId,
      title: run.title,
      track: run.track,
      completedAt: run.completedAt,
      status: run.status,
      outcome: run.outcome || "passed",
      release: run.release,
      manifestSha256: run.manifestSha256,
      knownLimits: run.knownLimits,
      evidence: copyEvidence(run, outputDir),
    }));
    const index = {
      schemaVersion: GALLERY_INDEX_VERSION,
      indexType: "deckformance-public-gallery",
      generatedAt: options.generatedAt || new Date().toISOString(),
      runCount: publicRuns.length,
      runs: publicRuns,
    };
    fs.writeFileSync(path.join(outputDir, "gallery-index.json"), `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
    fs.writeFileSync(path.join(outputDir, "index.html"), renderGalleryHtml(index), { flag: "wx" });
    return { outputDir, index, indexPath: path.join(outputDir, "gallery-index.json"), htmlPath: path.join(outputDir, "index.html") };
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const options = { manifests: [], outputDir: null, generatedAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output" || arg.startsWith("--output=")) {
      options.outputDir = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
    } else if (arg === "--generated-at" || arg.startsWith("--generated-at=")) {
      options.generatedAt = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.manifests.push(arg);
    }
  }
  if (!options.outputDir || options.manifests.length === 0) {
    throw new Error("usage: build_gallery.js --output <directory> <benchmark-run.json> [...]");
  }
  return options;
}

function main() {
  try {
    const result = buildGallery(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ outputDir: result.outputDir, runCount: result.index.runCount }, null, 2));
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  COMPLETED_STATUSES,
  GALLERY_INDEX_VERSION,
  GalleryManifestError,
  RELEASE_LABELS,
  REQUIRED_EVIDENCE,
  RUN_MANIFEST_TYPE,
  buildGallery,
  manifestSha256,
  parseArgs,
  readRunManifest,
  renderGalleryHtml,
  validateGalleryRunManifest,
};

if (require.main === module) main();

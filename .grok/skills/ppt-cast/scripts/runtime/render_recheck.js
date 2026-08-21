#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { safeRelativePath, sha256File, stableJson } = require("./hash_bound_receipt");

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required for release-time render reproduction`);
  return normalized;
}

function renderConfiguration(index, options = {}) {
  const env = options.env || process.env;
  const runtime = index.runtime || {};
  return {
    python: required(options.python || env.DECKFORMANCE_PYTHON, "DECKFORMANCE_PYTHON"),
    renderer: required(options.renderer || env.DECKFORMANCE_RENDERER, "DECKFORMANCE_RENDERER"),
    rendererVersion: required(options.rendererVersion || env.DECKFORMANCE_RENDERER_VERSION || (index.renderer && index.renderer.version), "DECKFORMANCE_RENDERER_VERSION"),
    slidesTest: required(options.slidesTest || env.DECKFORMANCE_SLIDES_TEST, "DECKFORMANCE_SLIDES_TEST"),
    slidesTestVersion: required(options.slidesTestVersion || env.DECKFORMANCE_SLIDES_TEST_VERSION || (index.slidesTest && index.slidesTest.version), "DECKFORMANCE_SLIDES_TEST_VERSION"),
    runtimeNode: runtime.node ? required(options.runtimeNode || env.DECKFORMANCE_NODE, "DECKFORMANCE_NODE") : null,
    runtimeBinDir: runtime.binDir ? required(options.runtimeBinDir || env.DECKFORMANCE_RUNTIME_BIN_DIR, "DECKFORMANCE_RUNTIME_BIN_DIR") : null,
    runtimeNodeModules: runtime.nodeModules ? required(options.runtimeNodeModules || env.DECKFORMANCE_NODE_MODULES, "DECKFORMANCE_NODE_MODULES") : null,
  };
}

function compareRenderIndexes(expected, reproduced) {
  if (stableJson(expected) !== stableJson(reproduced)) {
    const expectedSlides = new Map((expected.renderedSlides || []).map((slide) => [slide.slideNumber, slide.sha256]));
    const reproducedSlides = new Map((reproduced.renderedSlides || []).map((slide) => [slide.slideNumber, slide.sha256]));
    const changedSlide = [...new Set([...expectedSlides.keys(), ...reproducedSlides.keys()])]
      .sort((left, right) => left - right)
      .find((number) => expectedSlides.get(number) !== reproducedSlides.get(number));
    throw new Error(`release-time render reproduction differs from canonical evidence${changedSlide ? ` at slide ${changedSlide}` : ""}`);
  }
  return true;
}

function recheckRenderEvidence(jobDirValue, record, options = {}) {
  const jobDir = fs.realpathSync(path.resolve(jobDirValue));
  if (!record || typeof record.renderIndexPath !== "string") throw new Error("candidate render record is required");
  const indexPath = safeRelativePath(jobDir, record.renderIndexPath, { mustExist: true });
  const expected = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (record.renderIndexSha256 !== sha256File(indexPath)) throw new Error("candidate render-index bytes drifted before release-time reproduction");
  const sourceArtifact = options.sourceArtifactPath || expected.artifactPath;
  const artifactPath = safeRelativePath(jobDir, sourceArtifact, { mustExist: true });
  if (sha256File(artifactPath) !== expected.artifactSha256) throw new Error("release-time render reproduction source is not the canonical candidate bytes");
  const config = renderConfiguration(expected, options);
  const producer = path.resolve(options.producerPath || path.join(__dirname, "..", "render_pptx_qa.py"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-render-recheck-"));
  try {
    const artifactCopy = path.join(tempRoot, ...expected.artifactPath.split("/"));
    fs.mkdirSync(path.dirname(artifactCopy), { recursive: true });
    fs.copyFileSync(artifactPath, artifactCopy, fs.constants.COPYFILE_EXCL);
    const args = [
      producer,
      tempRoot,
      expected.artifactPath,
      "qa/rendered-candidate",
      "--renderer", config.renderer,
      "--renderer-version", config.rendererVersion,
      "--slides-test", config.slidesTest,
      "--slides-test-version", config.slidesTestVersion,
      "--python", config.python,
    ];
    if (config.runtimeNode) args.push("--runtime-node", config.runtimeNode);
    if (config.runtimeBinDir) args.push("--runtime-bin-dir", config.runtimeBinDir);
    if (config.runtimeNodeModules) args.push("--runtime-node-modules", config.runtimeNodeModules);
    const run = spawnSync(config.python, args, {
      cwd: tempRoot,
      encoding: "utf8",
      env: options.env || process.env,
      timeout: options.timeoutMs || 180000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.status !== 0) throw new Error(`release-time render reproduction failed: ${(run.stderr || run.stdout || "unknown error").trim()}`);
    const reproducedPath = path.join(tempRoot, "qa", "rendered-candidate", "render-index.json");
    const reproduced = JSON.parse(fs.readFileSync(reproducedPath, "utf8"));
    compareRenderIndexes(expected, reproduced);
    return {
      passed: true,
      artifactSha256: expected.artifactSha256,
      renderIndexSha256: sha256File(indexPath),
      reproducedIndexSha256: sha256File(reproducedPath),
      slideCount: expected.slideCount,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = {
  compareRenderIndexes,
  recheckRenderEvidence,
  renderConfiguration,
};

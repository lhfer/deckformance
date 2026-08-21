#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PptxGenJS = require("pptxgenjs");

const { renderLayers } = require("./layer_renderer_v2");
const { schemaValidators } = require("./compile_design");
const { speakerNotes } = require("./build_deck_v2");
const { assertSafeOutputParent } = require("./compile_deck_v2");

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} cannot be read as JSON: ${error.message}`);
  }
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function isSafeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return !parts.some((part) => !part || part === "." || part === "..") && path.posix.normalize(value) === value;
}

function parseArgs(argv) {
  const positional = [];
  let output = "qa/design-preview.pptx";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (arg === "--output") {
      output = argv[++index];
      if (!output || output.startsWith("--")) fail("--output requires a value");
    } else if (arg.startsWith("--output=")) output = arg.slice("--output=".length);
    else fail(`unknown option: ${arg}`);
  }
  if (positional.length !== 1) fail("usage: preview_design_v2.js <job-dir> [--output qa/design-preview.pptx]");
  if (!isSafeRelative(output) || path.extname(output).toLowerCase() !== ".pptx") fail("--output must be a job-relative .pptx path");
  return { jobDir: path.resolve(positional[0]), output };
}

function assertSchema(validator, value, label) {
  if (validator(value)) return;
  const details = (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  fail(`${label} schema validation failed: ${details}`);
}

async function preview(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!fs.existsSync(args.jobDir) || !fs.statSync(args.jobDir).isDirectory()) fail(`job directory not found: ${args.jobDir}`);
  const jobDir = fs.realpathSync(args.jobDir);
  const designPath = path.join(jobDir, "design-plan.json");
  const visualPath = path.join(jobDir, "visual-plan.json");
  if (!fs.existsSync(designPath) || !fs.existsSync(visualPath)) fail("preview requires design-plan.json and visual-plan.json");
  const design = readJson(designPath, "design-plan.json");
  const visual = readJson(visualPath, "visual-plan.json");
  const validators = schemaValidators();
  assertSchema(validators["design-plan"], design, "design-plan.json");
  assertSchema(validators["visual-plan"], visual, "visual-plan.json");
  if (design.releaseEligibility !== "candidate-ready") fail("draft-only design plans cannot produce a v2 design preview");
  if (design.compiledFrom.visualPlan !== hashFile(visualPath)) fail("design-plan.json does not bind the current visual-plan.json");
  if (design.jobId !== visual.jobId) fail("design and visual job IDs do not match");
  const palette = visual.brandDirection && visual.brandDirection.deckPalette;
  const typography = visual.brandDirection && visual.brandDirection.typography;
  if (!palette || !typography) fail("visual plan is missing palette or typography");
  const assetById = new Map((design.registeredAssets || []).map((asset) => [asset.id, asset]));

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "DECKFORMANCE_V2_PREVIEW", width: 10, height: 5.625 });
  pptx.layout = "DECKFORMANCE_V2_PREVIEW";
  pptx.title = `${design.title} — design preview`;
  pptx.author = "Deckformance";
  pptx.subject = "NON-RELEASE v2 design preview; media slots are placeholders";
  pptx.comments = "This file previews the resolved design plan before media generation and is never candidate/final evidence.";
  for (let index = 0; index < design.slides.length; index += 1) {
    const spec = design.slides[index];
    const slide = pptx.addSlide();
    slide.background = { color: String(palette.bg).replace(/^#/, "").toUpperCase() };
    renderLayers(slide, pptx, spec.layers, {
      jobDir,
      slideNumber: index + 1,
      theme: { palette, typography },
      assetById,
      mediaByLayer: new Map(),
      videoSlides: [],
      motionPlan: spec.motionPlan,
      textFitByLayer: new Map((spec.textFit || []).map((receipt) => [receipt.layerId, receipt])),
      previewMode: true,
    });
    slide.addNotes(`${speakerNotes(spec)}\n\n[Design Preview]\n- Video rectangles are unresolved placeholders; this PPTX is not releasable.`);
  }
  const output = path.resolve(jobDir, ...args.output.split("/"));
  const relative = path.relative(jobDir, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("preview output leaves the job directory");
  assertSafeOutputParent(jobDir, output);
  if (fs.existsSync(output)) fail(`refusing to overwrite preview: ${args.output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp.pptx`);
  try {
    await pptx.writeFile({ fileName: temporary });
    fs.renameSync(temporary, output);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  process.stdout.write(`${args.output}\n`);
  return output;
}

if (require.main === module) {
  preview().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, preview };

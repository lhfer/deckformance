#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  inspectPoster,
  inspectVideo,
  parseAspect,
  resolveSafeRelative,
  validateLayoutContract,
} = require("./media_contract");
const { sha256, validatePackageBuffer } = require("./pptx_package");

function usage() {
  return "usage: node validate_pptx.js <file.pptx> [--deck deck.json] [--release draft|candidate|final] [--report|--evidence qa.json]";
}

function parseArgs(argv) {
  const positional = [];
  const options = { deckPath: null, release: null, reportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal >= 0 ? arg.slice(0, equal) : arg;
    let value = equal >= 0 ? arg.slice(equal + 1) : null;
    if (!["--deck", "--release", "--report", "--evidence"].includes(name)) throw new Error(`unknown option: ${arg}`);
    if (value === null) {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      index += 1;
    }
    if (name === "--deck") options.deckPath = value;
    else if (name === "--release") options.release = value;
    else options.reportPath = value;
  }
  if (positional.length !== 1) throw new Error(usage());
  return { pptxPath: positional[0], ...options };
}

function atomicWrite(filePath, data) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, absolute);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function deckExpectations(deckPath, releaseOverride) {
  const absolute = path.resolve(deckPath);
  const deckBytes = fs.readFileSync(absolute);
  const deck = JSON.parse(deckBytes.toString("utf8"));
  const deckDir = path.dirname(absolute);
  const layoutsPath = path.resolve(__dirname, "..", "references", "layouts.json");
  const layouts = JSON.parse(fs.readFileSync(layoutsPath, "utf8"));
  const errors = validateLayoutContract(layouts);
  const release = releaseOverride || deck.releaseLevel || "candidate";
  const videoSlides = [];
  let expectedContentPages = 0;
  let aspectRatiosValid = true;
  for (let index = 0; index < (deck.slides || []).length; index += 1) {
    const slide = deck.slides[index];
    const layout = layouts.layouts[slide.layoutId];
    if (!layout || !layout.video) continue;
    expectedContentPages += 1;
    const aspect = parseAspect(layout.mediaAspect);
    const prefix = `slide ${index + 1}${slide.id ? ` (${slide.id})` : ""}`;
    let posterPath;
    let videoPath;
    try {
      posterPath = resolveSafeRelative(deckDir, slide.poster, `${prefix} poster`);
      const result = inspectPoster(posterPath, aspect);
      errors.push(...result.errors.map((item) => `${prefix}: ${item}`));
      if (result.errors.some((item) => item.includes("aspect"))) aspectRatiosValid = false;
    } catch (error) {
      errors.push(error.message);
      aspectRatiosValid = false;
    }
    try {
      videoPath = resolveSafeRelative(deckDir, slide.video, `${prefix} video`, { required: release !== "draft" });
      if (videoPath) {
        const result = inspectVideo(videoPath, aspect);
        errors.push(...result.errors.map((item) => `${prefix}: ${item}`));
        if (result.errors.some((item) => item.includes("aspect"))) aspectRatiosValid = false;
      }
    } catch (error) {
      errors.push(error.message);
      aspectRatiosValid = false;
    }
    if (posterPath && videoPath) {
      videoSlides.push({
        slideNumber: index + 1,
        posterSha256: sha256(fs.readFileSync(posterPath)),
        videoSha256: sha256(fs.readFileSync(videoPath)),
      });
    }
  }
  return {
    errors,
    release,
    videoSlides,
    expectedContentPages,
    aspectRatiosValid,
    deckSha256: sha256(deckBytes),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pptxPath = path.resolve(args.pptxPath);
  if (!fs.existsSync(pptxPath) || !fs.statSync(pptxPath).isFile()) throw new Error(`PPTX not found: ${pptxPath}`);
  let expectations = {
    errors: [],
    release: args.release,
    videoSlides: undefined,
    expectedContentPages: undefined,
    aspectRatiosValid: true,
    deckSha256: null,
  };
  if (args.deckPath) expectations = deckExpectations(args.deckPath, args.release);
  const qa = await validatePackageBuffer(fs.readFileSync(pptxPath), {
    release: expectations.release,
    videoSlides: expectations.videoSlides,
    expectedContentPages: expectations.expectedContentPages,
    aspectRatiosValid: expectations.aspectRatiosValid,
  });
  const errors = [...expectations.errors, ...qa.errors];
  const passed = errors.length === 0;
  const artifactSha256 = sha256(fs.readFileSync(pptxPath));
  const report = {
    version: 1,
    valid: passed,
    passed,
    release: expectations.release || qa.release,
    package: path.basename(pptxPath),
    packageSha256: artifactSha256,
    artifactSha256,
    deckSha256: expectations.deckSha256,
    slideCount: qa.slideCount,
    contentMediaCount: qa.mediaCount,
    expectedContentPages: qa.expectedContentPages,
    embeddedVideoCount: qa.embeddedVideoCount,
    posterCount: qa.posterCount,
    timingCount: qa.timingCount,
    relationshipsValid: qa.relationshipsValid,
    mimeTypesValid: qa.mimeTypesValid,
    aspectRatiosValid: qa.aspectRatiosValid,
    checkedAt: new Date().toISOString(),
    errors,
  };
  if (args.reportPath) atomicWrite(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

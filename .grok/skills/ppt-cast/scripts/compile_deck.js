#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INPUT_FILES = Object.freeze({
  contentPlan: "content-plan.json",
  visualPlan: "visual-plan.json",
  assetManifest: "asset-manifest.json",
});
const DEFAULT_DECK = "deck.json";
const DEFAULT_STORYBOARD = "storyboard.md";

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Buffer(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSafeRelative(value) {
  if (!nonEmpty(value) || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return path.posix.normalize(value) === value;
}

function resolveSafeExisting(jobDir, relativePath, label) {
  if (!isSafeRelative(relativePath)) fail(`${label} must be a normalized job-relative path: ${String(relativePath)}`);
  const target = path.resolve(jobDir, ...relativePath.split("/"));
  if (!isInside(jobDir, target)) fail(`${label} leaves the job directory: ${relativePath}`);
  if (!fs.existsSync(target)) fail(`${label} not found: ${relativePath}`);
  const realRoot = fs.realpathSync(jobDir);
  const realTarget = fs.realpathSync(target);
  if (!isInside(realRoot, realTarget)) fail(`${label} escapes the job directory through a symlink: ${relativePath}`);
  if (!fs.statSync(realTarget).isFile()) fail(`${label} must be a regular file: ${relativePath}`);
  return realTarget;
}

function resolveSafeOutput(jobDir, relativePath, label) {
  if (!isSafeRelative(relativePath)) fail(`${label} must be a normalized job-relative path: ${String(relativePath)}`);
  const target = path.resolve(jobDir, ...relativePath.split("/"));
  if (!isInside(jobDir, target)) fail(`${label} leaves the job directory: ${relativePath}`);

  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail(`${label} has no safe parent directory`);
    ancestor = parent;
  }
  const realRoot = fs.realpathSync(jobDir);
  const realAncestor = fs.realpathSync(ancestor);
  if (!isInside(realRoot, realAncestor)) fail(`${label} escapes the job directory through a symlink: ${relativePath}`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    fail(`${label} must not replace a symbolic link: ${relativePath}`);
  }
  return target;
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isObject(parsed)) fail(`${label} must contain a JSON object`);
  return parsed;
}

function parseArgs(argv) {
  const positional = [];
  const options = { deck: DEFAULT_DECK, storyboard: DEFAULT_STORYBOARD };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--deck" || arg === "--storyboard") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--deck=")) {
      options.deck = arg.slice("--deck=".length);
      continue;
    }
    if (arg.startsWith("--storyboard=")) {
      options.storyboard = arg.slice("--storyboard=".length);
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  if (positional.length !== 1) {
    fail("usage: node compile_deck.js <job-dir> [--deck deck.json] [--storyboard storyboard.md]");
  }
  return { jobDir: positional[0], ...options };
}

function parseAspect(value, label) {
  if (isObject(value)) {
    const w = Number(value.w);
    const h = Number(value.h);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
  } else if (typeof value === "string") {
    const match = value.trim().match(/^([1-9][0-9]*):([1-9][0-9]*)$/);
    if (match) return { w: Number(match[1]), h: Number(match[2]) };
  }
  fail(`${label} must be a positive W:H aspect ratio`);
}

function sameAspect(width, height, aspect) {
  const left = Number(width) * aspect.h;
  const right = Number(height) * aspect.w;
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-7 * Math.max(1, Math.abs(left), Math.abs(right));
}

function assertExactIds(actualSlides, expectedIds, label) {
  if (!Array.isArray(actualSlides)) fail(`${label}.slides must be an array`);
  const actualIds = actualSlides.map((slide, index) => {
    if (!isObject(slide) || !nonEmpty(slide.id)) fail(`${label}.slides[${index}].id must be non-empty`);
    return slide.id;
  });
  if (new Set(actualIds).size !== actualIds.length) fail(`${label}.slides contains duplicate slide IDs`);
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    fail(`${label}.slides IDs must exactly match video-required content order: expected [${expectedIds.join(", ")}], got [${actualIds.join(", ")}]`);
  }
}

function validateSourceMap(contentPlan) {
  if (!Array.isArray(contentPlan.sources)) fail("content-plan.json sources must be an array");
  const byId = new Map();
  contentPlan.sources.forEach((source, index) => {
    if (!isObject(source) || !nonEmpty(source.id) || !nonEmpty(source.title)) {
      fail(`content-plan.json sources[${index}] must have non-empty id and title`);
    }
    if (!["user-material", "public-url", "inference"].includes(source.kind)) {
      fail(`content-plan.json sources[${index}].kind is invalid`);
    }
    if (!Array.isArray(source.supports) || source.supports.length === 0 || source.supports.some((id) => !nonEmpty(id))) {
      fail(`content-plan.json sources[${index}].supports must list supported slide IDs`);
    }
    if (source.kind === "public-url" && (!/^https?:\/\//.test(source.url || "") || !nonEmpty(source.retrievedAt))) {
      fail(`content-plan.json sources[${index}] public URL requires url and retrievedAt`);
    }
    if (byId.has(source.id)) fail(`content-plan.json contains duplicate source ID ${source.id}`);
    byId.set(source.id, source);
  });
  return byId;
}

function normalizeSource(source) {
  // Keep the content plan's source object byte-for-byte equivalent at the JSON
  // value level. build_deck.js knows how to turn these records into [Sources]
  // speaker notes, while validate_job.js can prove no citation drift occurred.
  return { ...source };
}

function validateContent(contentPlan) {
  if (!nonEmpty(contentPlan.jobId)) fail("content-plan.json jobId must be non-empty");
  if (!Array.isArray(contentPlan.slides) || contentPlan.slides.length === 0) {
    fail("content-plan.json slides must be a non-empty array");
  }
  const ids = new Set();
  const allowedTypes = new Set(["cover", "section", "content", "closing"]);
  contentPlan.slides.forEach((slide, index) => {
    const label = `content-plan.json slides[${index}]`;
    if (!isObject(slide) || !nonEmpty(slide.id)) fail(`${label}.id must be non-empty`);
    if (ids.has(slide.id)) fail(`content-plan.json contains duplicate slide ID ${slide.id}`);
    ids.add(slide.id);
    if (!allowedTypes.has(slide.type)) fail(`${label}.type is invalid: ${String(slide.type)}`);
    if (!nonEmpty(slide.title)) fail(`${label}.title must be non-empty`);
    if (!Array.isArray(slide.body) || slide.body.length === 0 || slide.body.length > 3 || slide.body.some((line) => !nonEmpty(line))) {
      fail(`${label}.body must contain 1 through 3 non-empty display lines`);
    }
    for (const key of ["role", "claim", "transition", "takeaway"]) {
      if (!nonEmpty(slide[key])) fail(`${label}.${key} must be non-empty`);
    }
    if (!Array.isArray(slide.evidence) || slide.evidence.length === 0 || slide.evidence.some((line) => !nonEmpty(line))) {
      fail(`${label}.evidence must contain non-empty statements`);
    }
    if (!Array.isArray(slide.sourceIds)) fail(`${label}.sourceIds must be an array`);
    const shouldHaveVideo = slide.type === "content" || slide.type === "closing";
    if (slide.videoRequired !== shouldHaveVideo) {
      fail(`${label}.videoRequired must be ${shouldHaveVideo} for ${slide.type} slides`);
    }
    if (shouldHaveVideo && (slide.sourceIds.length === 0 || slide.evidenceBasis === "none")) {
      fail(`${label} dynamic content requires explicit sources and evidenceBasis`);
    }
    if (!shouldHaveVideo && slide.evidenceBasis !== "none") {
      fail(`${label}.evidenceBasis must be none for a static slide`);
    }
  });
}

function validateTypographyAndPalette(visualPlan) {
  const direction = visualPlan.brandDirection;
  if (!isObject(direction)) fail("visual-plan.json brandDirection must be an object");
  const typography = direction.typography;
  if (!isObject(typography) || ["title", "body", "number", "rationale"].some((key) => !nonEmpty(typography[key]))) {
    fail("visual-plan.json brandDirection.typography must define non-empty title, body, number, and rationale");
  }
  const palette = direction.deckPalette;
  const paletteKeys = ["bg", "panel", "title", "body", "muted", "accent", "ink", "inkMuted"];
  if (!isObject(palette) || paletteKeys.some((key) => !/^#[A-Fa-f0-9]{6}$/.test(palette[key] || ""))) {
    fail(`visual-plan.json brandDirection.deckPalette must define ${paletteKeys.join(", ")} as #RRGGBB colors`);
  }
  return {
    fonts: { title: typography.title, body: typography.body, number: typography.number },
    palette: { ...palette },
  };
}

function validateAsset(jobDir, descriptor, label, aspect) {
  if (!isObject(descriptor) || !nonEmpty(descriptor.path)) fail(`${label}.path is required`);
  const assetPath = resolveSafeExisting(jobDir, descriptor.path, `${label}.path`);
  const actualHash = sha256File(assetPath);
  if (descriptor.sha256 !== actualHash) fail(`${label}.sha256 is stale: declared ${String(descriptor.sha256)}, actual ${actualHash}`);
  const size = fs.statSync(assetPath).size;
  if (descriptor.bytes !== undefined && descriptor.bytes !== size) {
    fail(`${label}.bytes is stale: declared ${String(descriptor.bytes)}, actual ${size}`);
  }
  if (!Number.isInteger(descriptor.width) || !Number.isInteger(descriptor.height) || descriptor.width < 1 || descriptor.height < 1) {
    fail(`${label} must declare positive integer width and height`);
  }
  if (!sameAspect(descriptor.width, descriptor.height, aspect)) {
    fail(`${label} dimensions ${descriptor.width}x${descriptor.height} do not match the selected layout aspect ${aspect.w}:${aspect.h}`);
  }
  return descriptor.path;
}

function assertSelectedAsset(manifestSlide, kind, label) {
  const attempts = manifestSlide.attempts && manifestSlide.attempts[kind === "poster" ? "stills" : "videos"];
  if (!Array.isArray(attempts)) fail(`${label} is missing ${kind} generation attempts`);
  const selected = attempts.filter((attempt) => attempt && attempt.status === "selected");
  const canonical = manifestSlide[kind];
  if (selected.length !== 1 || !canonical || selected[0].path !== canonical.path || selected[0].sha256 !== canonical.sha256) {
    fail(`${label} must have exactly one selected attempt matching the canonical ${kind}`);
  }
}

function assertManifestQa(manifestSlide, visualPlanHash, label) {
  const qa = manifestSlide.qa;
  const binding = qa && qa.binding;
  if (!isObject(qa) || qa.passed !== true || !isObject(binding)) {
    fail(`${label} requires passing, hash-bound manifest QA`);
  }
  if (binding.posterSha256 !== manifestSlide.poster.sha256) {
    fail(`${label} manifest QA does not bind the selected poster`);
  }
  if (binding.videoSha256 !== manifestSlide.video.sha256) {
    fail(`${label} manifest QA does not bind the selected video`);
  }
  if (binding.visualPlanSha256 !== visualPlanHash) {
    fail(`${label} manifest QA does not bind the current visual plan`);
  }
}

function slideSources(slide, sourceById, label) {
  const seen = new Set();
  const sources = slide.sourceIds.map((sourceId) => {
    if (seen.has(sourceId)) fail(`${label}.sourceIds contains duplicate ${sourceId}`);
    seen.add(sourceId);
    const source = sourceById.get(sourceId);
    if (!source) fail(`${label}.sourceIds references unknown source ${sourceId}`);
    if (!source.supports.includes(slide.id)) fail(`${label} source ${sourceId} does not declare support for slide ${slide.id}`);
    return normalizeSource(source);
  });
  if (slide.videoRequired) {
    const bases = new Set(sources.map((source) => source.kind === "public-url" ? "public-source" : source.kind));
    const expectedBasis = bases.size > 1 ? "mixed" : [...bases][0];
    if (slide.evidenceBasis !== expectedBasis) {
      fail(`${label}.evidenceBasis must be ${expectedBasis} for the selected sources`);
    }
  }
  return sources;
}

function buildSpeakerNotes(slide) {
  return [
    `Role: ${slide.role.trim()}`,
    `Claim: ${slide.claim.trim()}`,
    "Evidence:",
    ...slide.evidence.map((line) => `- ${line.trim()}`),
    `Transition: ${slide.transition.trim()}`,
    `Takeaway: ${slide.takeaway.trim()}`,
  ].join("\n");
}

function compile(inputs) {
  const { jobDir, contentPlan, visualPlan, assetManifest, layoutsDoc, hashes } = inputs;
  validateContent(contentPlan);
  if (visualPlan.jobId !== contentPlan.jobId) {
    fail(`visual-plan.json jobId ${String(visualPlan.jobId)} does not match content-plan.json jobId ${contentPlan.jobId}`);
  }
  if (assetManifest.jobId !== contentPlan.jobId) {
    fail(`asset-manifest.json jobId ${String(assetManifest.jobId)} does not match content-plan.json jobId ${contentPlan.jobId}`);
  }
  if (!isObject(visualPlan.upstreamHashes) || visualPlan.upstreamHashes.contentPlan !== hashes.contentPlan) {
    fail(`visual-plan.json is stale: upstreamHashes.contentPlan must equal ${hashes.contentPlan}`);
  }
  if (!isObject(assetManifest.upstreamHashes) || assetManifest.upstreamHashes.contentPlan !== hashes.contentPlan) {
    fail(`asset-manifest.json is stale: upstreamHashes.contentPlan must equal ${hashes.contentPlan}`);
  }
  if (assetManifest.upstreamHashes.visualPlan !== hashes.visualPlan) {
    fail(`asset-manifest.json is stale: upstreamHashes.visualPlan must equal ${hashes.visualPlan}`);
  }

  const sourceById = validateSourceMap(contentPlan);
  const videoSlides = contentPlan.slides.filter((slide) => slide.videoRequired === true);
  const videoIds = videoSlides.map((slide) => slide.id);
  assertExactIds(visualPlan.slides, videoIds, "visual-plan.json");
  assertExactIds(assetManifest.slides, videoIds, "asset-manifest.json");
  const visualById = new Map(visualPlan.slides.map((slide) => [slide.id, slide]));
  const manifestById = new Map(assetManifest.slides.map((slide) => [slide.id, slide]));
  const { fonts, palette } = validateTypographyAndPalette(visualPlan);

  if (!isObject(layoutsDoc) || !isObject(layoutsDoc.layouts)) fail("layouts.json must define a layouts object");
  const titleCard = layoutsDoc.layouts["title-card"];
  if (!isObject(titleCard) || titleCard.contentSlide !== false || titleCard.video) {
    fail("layouts.json title-card must be a non-video static layout");
  }

  let dynamicIndex = 0;
  const compiledSlides = contentPlan.slides.map((contentSlide, index) => {
    const label = `slide ${index + 1} (${contentSlide.id})`;
    const sources = slideSources(contentSlide, sourceById, label);
    const base = {
      id: contentSlide.id,
      layoutId: "title-card",
      kicker: contentSlide.role,
      number: "",
      title: contentSlide.title,
      body: [...contentSlide.body],
      speakerNotes: buildSpeakerNotes(contentSlide),
      sources,
    };
    if (!contentSlide.videoRequired) return base;

    dynamicIndex += 1;
    const visual = visualById.get(contentSlide.id);
    const manifest = manifestById.get(contentSlide.id);
    if (!visual || !manifest) fail(`${label} requires both visual and manifest records`);
    if (!nonEmpty(visual.layoutId)) fail(`${label} visual layoutId is required`);
    const layout = layoutsDoc.layouts[visual.layoutId];
    if (!isObject(layout)) fail(`${label} references unknown layoutId ${visual.layoutId}`);
    if (layout.contentSlide !== true || !isObject(layout.video) || !layout.mediaAspect) {
      fail(`${label} layout ${visual.layoutId} is not a dynamic content layout`);
    }
    if (!nonEmpty(visual.layoutFamily) || visual.layoutFamily !== layout.family) {
      fail(`${label} layout family mismatch: visual declares ${String(visual.layoutFamily)}, ${visual.layoutId} belongs to ${String(layout.family)}`);
    }
    if (!isObject(visual.slot)) fail(`${label} visual slot is required`);
    const layoutAspect = parseAspect(layout.mediaAspect, `${label} layout.mediaAspect`);
    const slotAspect = parseAspect(visual.slot.aspect, `${label} visual.slot.aspect`);
    if (visual.slot.aspect !== layout.mediaAspect.label) {
      fail(`${label} visual slot aspect ${visual.slot.aspect} must exactly equal layout ${visual.layoutId} aspect label ${String(layout.mediaAspect.label)}`);
    }
    if (!sameAspect(slotAspect.w, slotAspect.h, layoutAspect)) {
      fail(`${label} visual slot aspect ${visual.slot.aspect} does not match layout ${visual.layoutId} aspect ${layoutAspect.w}:${layoutAspect.h}`);
    }
    if (!Number.isInteger(visual.slot.widthPx) || !Number.isInteger(visual.slot.heightPx) || !sameAspect(visual.slot.widthPx, visual.slot.heightPx, layoutAspect)) {
      fail(`${label} visual slot dimensions ${String(visual.slot.widthPx)}x${String(visual.slot.heightPx)} do not match layout aspect ${layoutAspect.w}:${layoutAspect.h}`);
    }
    if (!sameAspect(layout.video.w, layout.video.h, layoutAspect)) {
      fail(`${label} layout ${visual.layoutId} video box does not match its declared mediaAspect`);
    }
    assertSelectedAsset(manifest, "poster", label);
    assertSelectedAsset(manifest, "video", label);
    assertManifestQa(manifest, hashes.visualPlan, label);
    const poster = validateAsset(jobDir, manifest.poster, `${label} poster`, layoutAspect);
    const video = validateAsset(jobDir, manifest.video, `${label} video`, layoutAspect);
    return {
      ...base,
      layoutId: visual.layoutId,
      number: String(dynamicIndex).padStart(2, "0"),
      poster,
      video,
      videoVolume: 0,
    };
  });

  const firstCover = contentPlan.slides.find((slide) => slide.type === "cover");
  const deck = {
    schemaVersion: "1.0.0",
    jobId: contentPlan.jobId,
    title: firstCover ? firstCover.title : String(contentPlan.thesis || "ppt-cast"),
    releaseLevel: "candidate",
    compiledFrom: {
      contentPlan: hashes.contentPlan,
      visualPlan: hashes.visualPlan,
      assetManifest: hashes.assetManifest,
      layouts: hashes.layouts,
    },
    fonts,
    palette,
    media: { videoVolume: 0 },
    slides: compiledSlides,
  };
  return { deck, storyboard: renderStoryboard(deck, contentPlan, visualById, manifestById) };
}

function mdInline(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function renderStoryboard(deck, contentPlan, visualById, manifestById) {
  const lines = [
    `# ${mdInline(deck.title)}`,
    "",
    `- Job: \`${deck.jobId}\``,
    `- Content plan: \`${deck.compiledFrom.contentPlan}\``,
    `- Visual plan: \`${deck.compiledFrom.visualPlan}\``,
    `- Asset manifest: \`${deck.compiledFrom.assetManifest}\``,
    `- Layout registry: \`${deck.compiledFrom.layouts}\``,
    "",
  ];
  contentPlan.slides.forEach((slide, index) => {
    const compiled = deck.slides[index];
    const visual = visualById.get(slide.id);
    const manifest = manifestById.get(slide.id);
    lines.push(`## ${String(index + 1).padStart(2, "0")} · ${mdInline(slide.id)} · ${mdInline(slide.type)}`, "");
    lines.push(`- Layout: \`${compiled.layoutId}\``);
    lines.push(`- Role: ${mdInline(slide.role)}`);
    lines.push(`- Claim: ${mdInline(slide.claim)}`);
    lines.push(`- Title: ${mdInline(slide.title)}`);
    lines.push("- Body:");
    slide.body.forEach((bodyLine) => lines.push(`  - ${mdInline(bodyLine)}`));
    lines.push("- Evidence:");
    slide.evidence.forEach((evidence) => lines.push(`  - ${mdInline(evidence)}`));
    lines.push(`- Transition: ${mdInline(slide.transition)}`);
    lines.push(`- Takeaway: ${mdInline(slide.takeaway)}`);
    if (visual && manifest) {
      lines.push(`- Visual proposition: ${mdInline(visual.visualProposition)}`);
      lines.push(`- Shot: ${mdInline(visual.shotPlan && visual.shotPlan.shotType)}; ${mdInline(visual.shotPlan && visual.shotPlan.framingRationale)}`);
      lines.push(`- Media: \`${manifest.poster.path}\` + \`${manifest.video.path}\``);
    }
    lines.push("- Sources:");
    if (compiled.sources.length === 0) {
      lines.push("  - No external sources");
    } else {
      compiled.sources.forEach((source) => {
        lines.push(`  - ${[source.title, source.url, source.publisher, source.kind].filter(nonEmpty).map(mdInline).join(" — ")}`);
      });
    }
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function writePreparedTemp(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return temp;
}

function atomicWritePair(outputs) {
  const prepared = [];
  const backups = [];
  const installed = [];
  let committed = false;
  try {
    for (const output of outputs) prepared.push({ ...output, temp: writePreparedTemp(output.target, output.data) });
    for (const output of prepared) {
      if (!fs.existsSync(output.target)) continue;
      const backup = path.join(path.dirname(output.target), `.${path.basename(output.target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.bak`);
      fs.renameSync(output.target, backup);
      backups.push({ target: output.target, backup });
    }
    for (const output of prepared) {
      fs.renameSync(output.temp, output.target);
      installed.push(output.target);
    }
    committed = true;
  } catch (error) {
    for (const target of installed.reverse()) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    for (const item of backups.reverse()) {
      if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
    }
    throw error;
  } finally {
    for (const output of prepared) {
      if (fs.existsSync(output.temp)) fs.unlinkSync(output.temp);
    }
  }
  if (committed) {
    for (const item of backups) {
      try {
        fs.unlinkSync(item.backup);
      } catch (error) {
        // The new pair is already committed.  Retaining a backup is safer than
        // rolling back only one side after a cleanup-only failure.
        console.error(`warning: retained compiler backup ${item.backup}: ${error.message}`);
      }
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const jobDir = path.resolve(args.jobDir);
  if (!fs.existsSync(jobDir) || !fs.statSync(jobDir).isDirectory()) fail(`job directory not found: ${jobDir}`);
  const realJobDir = fs.realpathSync(jobDir);
  const inputPaths = Object.fromEntries(
    Object.entries(INPUT_FILES).map(([key, relativePath]) => [key, resolveSafeExisting(realJobDir, relativePath, relativePath)]),
  );
  const layoutsPath = path.resolve(__dirname, "..", "references", "layouts.json");
  const deckPath = resolveSafeOutput(realJobDir, args.deck, "deck output");
  const storyboardPath = resolveSafeOutput(realJobDir, args.storyboard, "storyboard output");
  if (deckPath === storyboardPath) fail("deck and storyboard outputs must be different files");
  if (Object.values(inputPaths).includes(deckPath) || Object.values(inputPaths).includes(storyboardPath)) {
    fail("outputs must not overwrite structured input contracts");
  }

  const contentPlan = readJson(inputPaths.contentPlan, INPUT_FILES.contentPlan);
  const visualPlan = readJson(inputPaths.visualPlan, INPUT_FILES.visualPlan);
  const assetManifest = readJson(inputPaths.assetManifest, INPUT_FILES.assetManifest);
  const layoutsDoc = readJson(layoutsPath, "layouts.json");
  const hashes = {
    contentPlan: sha256File(inputPaths.contentPlan),
    visualPlan: sha256File(inputPaths.visualPlan),
    assetManifest: sha256File(inputPaths.assetManifest),
    layouts: sha256File(layoutsPath),
  };
  const result = compile({ realJobDir, jobDir: realJobDir, contentPlan, visualPlan, assetManifest, layoutsDoc, hashes });
  const deckJson = `${JSON.stringify(result.deck, null, 2)}\n`;
  atomicWritePair([
    { target: deckPath, data: deckJson },
    { target: storyboardPath, data: result.storyboard },
  ]);
  console.log(deckPath);
  console.log(storyboardPath);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack && !error.isUserError ? error.stack : error.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  compile,
  isSafeRelative,
  renderStoryboard,
  sha256Buffer,
  sha256File,
};

#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_OUTPUT_DIRECTORY = "v2-migration-draft";

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function readJson(filePath, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must contain an object`);
    return value;
  } catch (error) {
    if (error.isUserError) throw error;
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256Bytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function hashFile(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const positional = [];
  let outputDirectory = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--output-dir requires a value");
      outputDirectory = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      outputDirectory = arg.slice("--output-dir=".length);
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  if (positional.length !== 1) fail("usage: node migrate_v1.js <v1-job-dir> [--output-dir directory]");
  const jobDir = path.resolve(positional[0]);
  return {
    jobDir,
    outputDirectory: path.resolve(outputDirectory || path.join(jobDir, DEFAULT_OUTPUT_DIRECTORY)),
  };
}

function fallbackFamilies(family) {
  const candidates = ["Arial", "Helvetica Neue", "Noto Sans CJK SC"].filter((item) => item !== family);
  return candidates.slice(0, 2);
}

function token(family, weight, min, preferred, max, lineHeight, maxLines) {
  return {
    family,
    fallbacks: fallbackFamilies(family),
    weight,
    size: { min, preferred, max },
    lineHeight,
    letterSpacing: 0,
    maxLines,
  };
}

function migrateTypography(v1) {
  const source = v1 && v1.brandDirection && v1.brandDirection.typography || {};
  const title = source.title || "Arial";
  const body = source.body || "Arial";
  const number = source.number || title;
  return {
    schemaVersion: "2.0.0",
    measurementPolicy: "fail-closed",
    tokens: {
      display: token(title, 700, 50, 64, 76, 1.05, 2),
      headline: token(title, 700, 35, 42, 56, 1.1, 3),
      subhead: token(title, 600, 24, 28, 34, 1.18, 4),
      body: token(body, 400, 16, 18, 22, 1.32, 6),
      caption: token(body, 400, 12, 13, 16, 1.25, 5),
      data: token(number, 700, 24, 32, 52, 1.05, 3),
      number: token(number, 700, 35, 48, 72, 1.0, 2)
    },
    cjk: { kinsoku: true, orphanControl: true, mixedScript: "balanced" },
  };
}

function migrateContent(v1) {
  const warning = "pageRole was conservatively mapped from v1 type; every content page requires explicit semantic design review";
  return {
    ...v1,
    schemaVersion: "2.0.0",
    planningStatus: "draft",
    slides: v1.slides.map((slide) => ({
      id: slide.id,
      type: slide.type,
      pageRole: slide.type === "cover" ? "cover" : slide.type === "section" ? "section" : slide.type === "closing" ? "closing" : "evidence",
      kicker: slide.role,
      title: slide.title,
      body: [...slide.body],
      claim: slide.claim,
      evidence: [...slide.evidence],
      evidenceBasis: slide.evidenceBasis,
      transition: slide.transition,
      takeaway: slide.takeaway,
      sourceIds: [...slide.sourceIds],
      videoRequired: slide.videoRequired,
    })),
    migration: { fromVersion: "1.0.0", needsDesignReplan: true, warnings: [warning] },
  };
}

function defaultPalette() {
  return {
    bg: "#F2F3F5", panel: "#0B0D10", title: "#F7F7F7", body: "#B8B8B8",
    muted: "#7A7A7A", accent: "#C8102E", ink: "#0B0D10", inkMuted: "#5A5A5A",
  };
}

function migrateVisual(v1, content, contentHash) {
  const byId = new Map((v1.slides || []).map((slide) => [slide.id, slide]));
  const direction = v1.brandDirection || {};
  return {
    schemaVersion: "2.0.0",
    planningStatus: "draft",
    jobId: content.jobId,
    upstreamHashes: {
      brief: v1.upstreamHashes && v1.upstreamHashes.brief || content.upstreamHashes.brief,
      characterModel: v1.upstreamHashes && v1.upstreamHashes.characterModel || `sha256:${"0".repeat(64)}`,
      contentPlan: contentHash,
    },
    stylePack: "felt-yarn",
    brandDirection: {
      deckPalette: direction.deckPalette || defaultPalette(),
      typography: migrateTypography(v1),
      materials: direction.materials && direction.materials.length ? [...direction.materials] : ["unresolved v1 material"],
      lighting: direction.lighting || "requires v2 design review",
      motionLanguage: direction.motionLanguage || "requires v2 design review",
    },
    registeredAssets: [],
    slides: content.slides.map((slide) => {
      const previous = byId.get(slide.id);
      const dynamic = slide.videoRequired === true;
      const layerIntents = [
        { type: "headline", key: "primary", contentRef: "title", styleToken: slide.type === "cover" ? "display" : "headline" },
        { type: "body", key: "primary", contentRef: "body", styleToken: "body" },
      ];
      if (dynamic) {
        const previousSlot = previous && previous.slot;
        layerIntents.push({
          type: "video",
          key: "performance",
          poster: null,
          video: null,
          slot: previousSlot
            ? { aspect: previousSlot.aspect, widthPx: previousSlot.widthPx, heightPx: previousSlot.heightPx }
            : { aspect: "1:1", widthPx: 1080, heightPx: 1080 },
        });
      }
      return {
        id: slide.id,
        composition: "auto",
        mediaMode: dynamic ? "hybrid-video" : "static-native",
        density: "auto",
        negativeSpace: "auto",
        visualProposition: previous && previous.visualProposition || `Migration placeholder for ${slide.id}; replace during v2 design replan.`,
        actionClass: previous && previous.actionClass || "idle",
        layerIntents,
        motionPlan: dynamic ? {
          durationSeconds: 6,
          loopPolicy: "hold-last-frame",
          finalHoldSeconds: 1,
          beats: [
            { at: 0, action: "enter" },
            { at: 4.5, action: "settle" }
          ],
          camera: { movement: "static" },
        } : null,
        mediaBudget: dynamic ? { fps: 30, codec: "h264", pixelFormat: "yuv420p", muted: true, maxBytes: 12582912 } : null,
      };
    }),
    migration: {
      fromVersion: "1.0.0",
      needsDesignReplan: true,
      warnings: [
        "v1 layoutId and layoutFamily were not promoted to v2 composition decisions",
        "v1 media paths and QA were not copied because they do not bind a design-plan hash",
      ],
    },
  };
}

function migrate(jobDir) {
  const contentPath = path.join(jobDir, "content-plan.json");
  const visualPath = path.join(jobDir, "visual-plan.json");
  if (!fs.existsSync(contentPath) || !fs.existsSync(visualPath)) fail("v1 job must contain content-plan.json and visual-plan.json");
  const contentV1 = readJson(contentPath, "content-plan.json");
  const visualV1 = readJson(visualPath, "visual-plan.json");
  if (contentV1.schemaVersion !== "1.0.0" || visualV1.schemaVersion !== "1.0.0") fail("migrate_v1 accepts only schemaVersion 1.0.0 plans");
  const content = migrateContent(contentV1);
  const contentHash = sha256Bytes(jsonBytes(content));
  const visual = migrateVisual(visualV1, content, contentHash);
  return {
    content,
    visual,
    report: {
      schemaVersion: "2.0.0",
      artifactKind: "v1-migration-report",
      status: "needs-design-replan",
      releaseEligibility: "draft-only",
      jobId: content.jobId,
      sourceHashes: { contentPlan: hashFile(contentPath), visualPlan: hashFile(visualPath) },
      outputs: ["content-plan.json", "visual-plan.json"],
      designPlanProduced: false,
      candidateProduced: false,
      warnings: [...content.migration.warnings, ...visual.migration.warnings],
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!fs.existsSync(options.jobDir) || !fs.statSync(options.jobDir).isDirectory()) fail(`job directory not found: ${options.jobDir}`);
  if (fs.existsSync(options.outputDirectory)) fail(`refusing to overwrite migration output: ${options.outputDirectory}`);
  const result = migrate(options.jobDir);
  fs.mkdirSync(options.outputDirectory, { recursive: false });
  try {
    fs.writeFileSync(path.join(options.outputDirectory, "content-plan.json"), jsonBytes(result.content));
    fs.writeFileSync(path.join(options.outputDirectory, "visual-plan.json"), jsonBytes(result.visual));
    fs.writeFileSync(path.join(options.outputDirectory, "migration-report.json"), jsonBytes(result.report));
  } catch (error) {
    fs.rmSync(options.outputDirectory, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${options.outputDirectory}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`migrate_v1: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, migrate, migrateContent, migrateTypography, migrateVisual, parseArgs };

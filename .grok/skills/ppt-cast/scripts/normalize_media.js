#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  aspectMatches,
  inspectPoster,
  inspectVideo,
  parseAspect,
  probe,
  resolveSafeRelative,
  runTool,
  targetDimensions,
  toPosixRelative,
  validateLayoutContract,
} = require("./media_contract");

function parseArgs(argv) {
  const positional = [];
  let outDeck = null;
  let allowCrop = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--allow-crop") {
      allowCrop = true;
      continue;
    }
    if (arg === "--out-deck" || arg.startsWith("--out-deck=")) {
      outDeck = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      if (!outDeck || outDeck.startsWith("--")) throw new Error("--out-deck requires a path");
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (positional.length !== 2) {
    throw new Error("usage: node normalize_media.js <deck.json> <out-dir> [--out-deck normalized.json] [--allow-crop]");
  }
  return { deckPath: positional[0], outDir: positional[1], outDeck, allowCrop };
}

function mediaDimensions(filePath, label) {
  const info = probe(filePath);
  const streams = (info.streams || []).filter((stream) => stream.codec_type === "video");
  const stream = streams[0];
  const width = Number(stream && stream.width);
  const height = Number(stream && stream.height);
  if (!width || !height) throw new Error(`${label} has no readable visual dimensions`);
  return { width, height };
}

function cleanStem(value, fallback) {
  const stem = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return stem || fallback;
}

function atomicJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, absolute);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function normalizePoster(input, output, dimensions) {
  const filter =
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase,` +
    `crop=${dimensions.width}:${dimensions.height},setsar=1`;
  runTool("ffmpeg", [
    "-v",
    "error",
    "-n",
    "-i",
    input,
    "-map",
    "0:V:0",
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-c:v",
    "png",
    output,
  ]);
}

function normalizeVideo(input, output, dimensions) {
  const filter =
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase,` +
    `crop=${dimensions.width}:${dimensions.height},setsar=1`;
  runTool("ffmpeg", [
    "-v",
    "error",
    "-n",
    "-i",
    input,
    "-map",
    "0:V:0",
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    output,
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deckPath = path.resolve(args.deckPath);
  const outDir = path.resolve(args.outDir);
  if (!fs.existsSync(deckPath) || !fs.statSync(deckPath).isFile()) throw new Error(`deck.json not found: ${deckPath}`);
  const outDeck = path.resolve(args.outDeck || path.join(outDir, "deck.normalized.json"));
  const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
  const layoutsPath = path.resolve(__dirname, "..", "references", "layouts.json");
  const layouts = JSON.parse(fs.readFileSync(layoutsPath, "utf8"));
  const layoutErrors = validateLayoutContract(layouts);
  if (layoutErrors.length) throw new Error(`layout contract failed:\n- ${layoutErrors.join("\n- ")}`);
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) throw new Error("deck.json has no slides");
  const deckDir = path.dirname(deckPath);
  const work = [];
  for (let index = 0; index < deck.slides.length; index += 1) {
    const slide = deck.slides[index];
    const layout = layouts.layouts[slide.layoutId];
    if (!layout) throw new Error(`slide ${index + 1}: unknown layoutId ${slide.layoutId}`);
    if (!layout.video) continue;
    const aspect = parseAspect(layout.mediaAspect);
    const poster = resolveSafeRelative(deckDir, slide.poster, `slide ${index + 1} poster`);
    const video = resolveSafeRelative(deckDir, slide.video, `slide ${index + 1} video`);
    if (!args.allowCrop) {
      for (const [kind, filePath] of [["poster", poster], ["video", video]]) {
        const dimensions = mediaDimensions(filePath, `slide ${index + 1} ${kind}`);
        if (!aspectMatches(dimensions.width, dimensions.height, aspect)) {
          throw new Error(
            `slide ${index + 1} ${kind} is ${dimensions.width}x${dimensions.height}, not ${aspect.label}; ` +
            "refusing an unreviewed crop that could remove hands, feet, or support contact. Regenerate at the slot aspect, or use --allow-crop only before rerunning all frame and slot-composite QA.",
          );
        }
      }
    }
    const stem = `${String(index + 1).padStart(2, "0")}-${cleanStem(slide.id, "slide")}`;
    work.push({ index, aspect, poster, video, stem, dimensions: targetDimensions(aspect) });
  }

  fs.mkdirSync(path.join(outDir, "posters"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "videos"), { recursive: true });
  const created = [];
  const normalized = JSON.parse(JSON.stringify(deck));
  try {
    for (const item of work) {
      const posterOut = path.join(outDir, "posters", `${item.stem}.png`);
      const videoOut = path.join(outDir, "videos", `${item.stem}.mp4`);
      if (fs.existsSync(posterOut) || fs.existsSync(videoOut)) {
        throw new Error(`refusing to overwrite normalized media for ${item.stem}`);
      }
      normalizePoster(item.poster, posterOut, item.dimensions);
      created.push(posterOut);
      normalizeVideo(item.video, videoOut, item.dimensions);
      created.push(videoOut);
      const posterCheck = inspectPoster(posterOut, item.aspect);
      const videoCheck = inspectVideo(videoOut, item.aspect);
      const errors = [...posterCheck.errors, ...videoCheck.errors];
      if (errors.length) throw new Error(`${item.stem} normalization QA failed:\n- ${errors.join("\n- ")}`);
      normalized.slides[item.index].poster = toPosixRelative(path.dirname(outDeck), posterOut);
      normalized.slides[item.index].video = toPosixRelative(path.dirname(outDeck), videoOut);
    }
    normalized.normalization = {
      version: 1,
      sourceDeck: toPosixRelative(path.dirname(outDeck), deckPath),
      generatedAt: new Date().toISOString(),
      policy: "exact-layout-aspect-png-h264-yuv420p-silent",
      cropAuthorized: args.allowCrop,
    };
    if (fs.existsSync(outDeck)) throw new Error(`refusing to overwrite normalized deck: ${outDeck}`);
    atomicJson(outDeck, normalized);
    console.log(outDeck);
  } catch (error) {
    for (const filePath of created.reverse()) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

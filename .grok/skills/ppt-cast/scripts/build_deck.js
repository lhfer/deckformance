#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PptxGenJS = require("pptxgenjs");
const {
  inspectPoster,
  inspectVideo,
  parseAspect,
  resolveSafeRelative,
  validateLayoutContract,
} = require("./media_contract");
const { injectAutoplay, sha256, validatePackageBuffer } = require("./pptx_package");

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    release: null,
    powerpointVerified: false,
    reportPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--powerpoint-verified") {
      options.powerpointVerified = true;
      continue;
    }
    if (arg === "--release" || arg === "--report") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      index += 1;
      if (arg === "--release") options.release = value;
      else options.reportPath = value;
      continue;
    }
    if (arg.startsWith("--release=")) {
      options.release = arg.slice("--release=".length);
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  if (positional.length !== 2) {
    fail(
      "usage: node build_deck.js <deck.json> <out.pptx> [--release draft|candidate|final] [--powerpoint-verified] [--report qa.json]",
    );
  }
  return { deckPath: positional[0], outPath: positional[1], ...options };
}

function hex(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  return value.replace("#", "").toUpperCase();
}

function pngDataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function box(spec) {
  return { x: spec.x, y: spec.y, w: spec.w, h: spec.h };
}

function normalizeSource(source) {
  if (typeof source === "string" && source.trim()) return source.trim();
  if (!source || typeof source !== "object") return null;
  const title = String(source.title || source.label || "Source").trim();
  const url = source.url ? String(source.url).trim() : "";
  const detail = source.detail ? String(source.detail).trim() : "";
  const publisher = source.publisher ? String(source.publisher).trim() : "";
  const kind = source.kind ? String(source.kind).trim() : "";
  if (!url && !detail && !publisher && !kind && title === "Source") return null;
  return [title, url, publisher, detail, kind].filter(Boolean).join(" — ");
}

function speakerNotes(slideSpec) {
  const preface = slideSpec.speakerNotes || slideSpec.notes || "";
  const sources = Array.isArray(slideSpec.sources)
    ? slideSpec.sources.map(normalizeSource).filter(Boolean)
    : [];
  const sourceLines = sources.length
    ? sources.map((source) => `- ${source}`)
    : ["- No external sources declared for this slide."];
  return [String(preface).trim(), "[Sources]", ...sourceLines].filter(Boolean).join("\n");
}

function atomicWrite(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filePath);
  } finally {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function reportPath(baseDir, filePath) {
  const relative = path.relative(baseDir, filePath);
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.basename(filePath);
}

function collectPreflight(deck, deckDir, layoutsDoc, release) {
  const errors = [...validateLayoutContract(layoutsDoc)];
  const mediaBySlide = new Map();
  const videoSlides = [];
  let contentPageCount = 0;
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    errors.push("deck.json has no slides");
    return { errors, mediaBySlide, videoSlides, contentPageCount };
  }

  for (let index = 0; index < deck.slides.length; index += 1) {
    const slideSpec = deck.slides[index];
    const slideNumber = index + 1;
    const prefix = `slide ${slideNumber}${slideSpec.id ? ` (${slideSpec.id})` : ""}`;
    const layout = layoutsDoc.layouts[slideSpec.layoutId];
    if (!layout) {
      errors.push(`${prefix}: unknown layoutId ${slideSpec.layoutId}`);
      continue;
    }
    if (!layout.video) continue;
    contentPageCount += 1;
    const aspect = parseAspect(layout.mediaAspect);
    let posterPath = null;
    let videoPath = null;
    try {
      posterPath = resolveSafeRelative(deckDir, slideSpec.poster, `${prefix} poster`);
    } catch (error) {
      errors.push(error.message);
    }
    if (posterPath && aspect) {
      const result = inspectPoster(posterPath, aspect);
      errors.push(...result.errors.map((message) => `${prefix}: ${message}`));
    }

    const videoRequired = release !== "draft";
    try {
      videoPath = resolveSafeRelative(deckDir, slideSpec.video, `${prefix} video`, {
        required: videoRequired,
      });
    } catch (error) {
      errors.push(error.message);
    }
    let videoInfo = null;
    if (videoPath && aspect) {
      videoInfo = inspectVideo(videoPath, aspect);
      errors.push(...videoInfo.errors.map((message) => `${prefix}: ${message}`));
    }
    const rawVolume =
      slideSpec.videoVolume === undefined
        ? deck.media && deck.media.videoVolume !== undefined
          ? deck.media.videoVolume
          : 0
        : slideSpec.videoVolume;
    const volume = Number(rawVolume);
    if (!Number.isInteger(volume) || volume < 0 || volume > 100000) {
      errors.push(`${prefix}: videoVolume must be an integer from 0 to 100000`);
    }
    const record = { posterPath, videoPath, videoInfo, aspect, volume };
    mediaBySlide.set(slideNumber, record);
    if (videoPath && videoInfo && videoInfo.errors.length === 0 && posterPath) {
      videoSlides.push({
        slideNumber,
        durationMs: videoInfo.duration * 1000,
        volume,
        videoSha256: sha256(fs.readFileSync(videoPath)),
        posterSha256: sha256(fs.readFileSync(posterPath)),
      });
    }
  }
  if (contentPageCount > 8) errors.push(`v1 supports at most 8 video content pages; found ${contentPageCount}`);
  if (release !== "draft" && contentPageCount < 1) {
    errors.push(`${release} release requires at least one video content page`);
  }
  return { errors, mediaBySlide, videoSlides, contentPageCount };
}

function addBasePanel(slide, pres, layout, colors) {
  if (layout.card) {
    const fillKey = layout.card.fill || "panel";
    const fillColor = colors[fillKey] || colors.panel;
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      ...box(layout.card),
      rectRadius: layout.card.radius || 0.12,
      fill: { color: fillColor },
      line: { color: fillColor },
      shadow: {
        type: "outer",
        color: "000000",
        blur: 8,
        offset: 3,
        angle: 135,
        opacity: 0.12,
      },
    });
  } else if (layout.panel) {
    const fillKey = layout.panel.fill || "panel";
    const fillColor = colors[fillKey] || colors.panel;
    slide.addShape(pres.shapes.RECTANGLE, {
      ...box(layout.panel),
      fill: { color: fillColor },
      line: { color: fillColor },
    });
  }
}

function addOverlay(slide, pres, overlay, colors) {
  if (!overlay) return;
  const fillKey = overlay.fill || "panel";
  const fillColor = colors[fillKey] || colors.panel;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    ...box(overlay),
    rectRadius: overlay.radius || 0.12,
    fill: { color: fillColor, transparency: overlay.transparency || 0 },
    line: { color: fillColor, transparency: 100 },
  });
}

async function build() {
  const args = parseArgs(process.argv.slice(2));
  const deckPath = path.resolve(args.deckPath);
  const outAbs = path.resolve(args.outPath);
  if (path.extname(outAbs).toLowerCase() !== ".pptx") fail("output path must end in .pptx");
  if (!fs.existsSync(deckPath) || !fs.statSync(deckPath).isFile()) fail(`deck.json not found: ${deckPath}`);
  const skillDir = path.resolve(__dirname, "..");
  const layoutsPath = path.join(skillDir, "references", "layouts.json");
  const layoutsDoc = JSON.parse(fs.readFileSync(layoutsPath, "utf8"));
  const deckBytes = fs.readFileSync(deckPath);
  const deck = JSON.parse(deckBytes.toString("utf8"));
  const deckDir = path.dirname(deckPath);
  const release = args.release || deck.releaseLevel || "candidate";
  if (!new Set(["draft", "candidate", "final"]).has(release)) {
    fail(`release must be draft, candidate, or final; found ${release}`);
  }
  if (release === "final" && !args.powerpointVerified) {
    fail("final release requires explicit --powerpoint-verified after real PowerPoint playback acceptance");
  }

  const preflight = collectPreflight(deck, deckDir, layoutsDoc, release);
  if (preflight.errors.length) {
    fail(`preflight failed (${preflight.errors.length} issue${preflight.errors.length === 1 ? "" : "s"}):\n- ${preflight.errors.join("\n- ")}`);
  }

  const fonts = layoutsDoc.fonts;
  const deckFonts = deck.fonts || {};
  const fontTitle = deckFonts.title || deck.fontFace || fonts.face;
  const fontBody = deckFonts.body || deck.fontFace || fonts.face;
  const fontNumber = deckFonts.number || "Arial";
  const palette = deck.palette || {};
  const colors = {
    bg: hex(palette.bg, "F4EFE6"),
    panel: hex(palette.panel, "1C1C1C"),
    title: hex(palette.title, "F7F4EF"),
    body: hex(palette.body, "C4BFB6"),
    muted: hex(palette.muted, "8E8A84"),
    accent: hex(palette.accent, "D56B32"),
    ink: hex(palette.ink, "1C1C1C"),
    inkMuted: hex(palette.inkMuted, "6B6560"),
  };

  const pres = new PptxGenJS();
  pres.defineLayout({
    name: "PPT_CAST_16x9",
    width: layoutsDoc.slide.w,
    height: layoutsDoc.slide.h,
  });
  pres.layout = "PPT_CAST_16x9";
  pres.title = deck.title || "ppt-cast";
  pres.author = "ppt-cast";
  pres.subject = `ppt-cast release:${release}; powerpoint-verified:${release === "final" ? "true" : "false"}`;
  pres.comments =
    release === "final"
      ? "PowerPoint playback verification asserted by the caller."
      : "PowerPoint playback has not been verified on a real PowerPoint installation.";

  for (let index = 0; index < deck.slides.length; index += 1) {
    const slideSpec = deck.slides[index];
    const slideNumber = index + 1;
    const layout = layoutsDoc.layouts[slideSpec.layoutId];
    const slide = pres.addSlide();
    slide.background = { color: colors.bg };
    const dark = Boolean(layout.onDarkPanel);
    const titleColor = dark ? colors.title : colors.ink;
    const bodyColor = dark ? colors.body : colors.inkMuted;
    const mutedColor = dark ? colors.muted : colors.inkMuted;

    addBasePanel(slide, pres, layout, colors);
    if (layout.video) {
      const media = preflight.mediaBySlide.get(slideNumber);
      const mediaBox = box(layout.video);
      if (media.videoPath) {
        slide.addMedia({
          ...mediaBox,
          type: "video",
          path: media.videoPath,
          cover: pngDataUrl(media.posterPath),
        });
      } else {
        slide.addImage({ path: media.posterPath, ...mediaBox });
      }
    }
    addOverlay(slide, pres, layout.overlay, colors);

    if (layout.kicker && slideSpec.kicker) {
      slide.addText(String(slideSpec.kicker), {
        ...box(layout.kicker),
        fontFace: fontBody,
        fontSize: Math.max(fonts.kicker, Number(layout.kicker.fontSize || 0)),
        color: mutedColor,
        align: layout.kicker.align || "left",
        valign: "middle",
        margin: 0,
        charSpacing: 1,
      });
    }
    if (layout.number && slideSpec.number) {
      slide.addText(String(slideSpec.number), {
        ...box(layout.number),
        fontFace: fontNumber,
        fontSize: Math.max(fonts.number, Number(layout.number.fontSize || 0)),
        color: mutedColor,
        align: layout.number.align || "right",
        valign: "middle",
        margin: 0,
        charSpacing: 2,
      });
    }
    if (layout.title && slideSpec.title) {
      const defaultSize = slideSpec.layoutId === "title-card" ? fonts.titleCardTitle : fonts.title;
      const size = Math.max(slideSpec.layoutId === "title-card" ? 50 : 35, Number(layout.title.fontSize || defaultSize));
      slide.addText(String(slideSpec.title), {
        ...box(layout.title),
        fontFace: fontTitle,
        fontSize: size,
        color: titleColor,
        bold: true,
        align: layout.title.align || "left",
        valign: "top",
        margin: 0,
        breakLine: false,
      });
    }
    if (layout.body && Array.isArray(slideSpec.body) && slideSpec.body.length) {
      const defaultSize = slideSpec.layoutId === "title-card" ? fonts.titleCardBody : fonts.body;
      const size = Math.max(16, Number(layout.body.fontSize || defaultSize));
      const runs = slideSpec.body.map((line, lineIndex) => ({
        text: String(line),
        options: { breakLine: lineIndex < slideSpec.body.length - 1 },
      }));
      slide.addText(runs, {
        ...box(layout.body),
        fontFace: fontBody,
        fontSize: size,
        color: bodyColor,
        bold: false,
        align: layout.body.align || "left",
        valign: "top",
        margin: 0,
        paraSpaceAfter: 8,
      });
    }
    slide.addNotes(speakerNotes(slideSpec));
  }

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const baseTemp = path.join(
    path.dirname(outAbs),
    `.${path.basename(outAbs)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.base.pptx`,
  );
  try {
    await pres.writeFile({ fileName: baseTemp });
    const authored = fs.readFileSync(baseTemp);
    const packaged = await injectAutoplay(authored, preflight.videoSlides);
    const qa = await validatePackageBuffer(packaged, {
      expectedMediaCount: preflight.videoSlides.length,
      expectedContentPages: preflight.contentPageCount,
      videoSlides: preflight.videoSlides,
      aspectRatiosValid: true,
      release,
    });
    if (!qa.valid) fail(`package QA failed (${qa.errors.length} issues):\n- ${qa.errors.join("\n- ")}`);
    atomicWrite(outAbs, packaged);
    const report = {
      version: 1,
      valid: true,
      release,
      powerpointVerified: release === "final",
      output: reportPath(deckDir, outAbs),
      slideCount: qa.slideCount,
      contentMediaCount: qa.mediaCount,
      expectedContentPages: qa.expectedContentPages,
      embeddedVideoCount: qa.embeddedVideoCount,
      posterCount: qa.posterCount,
      timingCount: qa.timingCount,
      relationshipsValid: qa.relationshipsValid,
      mimeTypesValid: qa.mimeTypesValid,
      aspectRatiosValid: qa.aspectRatiosValid,
      passed: qa.passed,
      deckSha256: sha256(deckBytes),
      artifactSha256: sha256(packaged),
      generatedAt: new Date().toISOString(),
      checks: [
        "safe-relative-media-paths",
        "exact-slot-aspect",
        "true-png-posters",
        "h264-yuv420p-mp4",
        "embedded-media-relations",
        "autoplay-on-entry-once",
        "sources-speaker-notes",
      ],
    };
    if (args.reportPath) atomicWrite(path.resolve(args.reportPath), `${JSON.stringify(report, null, 2)}\n`);
    console.log(outAbs);
    console.log(JSON.stringify(report));
  } finally {
    if (fs.existsSync(baseTemp)) fs.unlinkSync(baseTemp);
  }
}

build().catch((error) => {
  console.error(error && error.stack && !error.isUserError ? error.stack : error.message || String(error));
  process.exit(1);
});

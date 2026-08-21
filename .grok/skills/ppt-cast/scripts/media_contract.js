#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseAspect(value) {
  if (!value) return null;
  if (typeof value === "object") {
    const w = Number(value.w);
    const h = Number(value.h);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { w, h, label: value.label || `${w}:${h}` };
    }
    return null;
  }
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return { w: Number(match[1]), h: Number(match[2]), label: String(value).trim() };
}

function aspectMatches(width, height, aspect, tolerance = 1e-7) {
  if (!aspect || !Number.isFinite(width) || !Number.isFinite(height)) return false;
  const left = width * aspect.h;
  const right = height * aspect.w;
  return Math.abs(left - right) <= tolerance * Math.max(Math.abs(left), Math.abs(right), 1);
}

function validateLayoutContract(layoutsDoc) {
  const errors = [];
  if (!layoutsDoc || !layoutsDoc.slide || !layoutsDoc.layouts) {
    return ["layouts.json must define slide and layouts"];
  }
  const fonts = layoutsDoc.fonts || {};
  if (Number(fonts.titleCardTitle) < 50) errors.push("fonts.titleCardTitle must be at least 50pt");
  if (Number(fonts.title) < 35 || Number(fonts.topTitle) < 35) {
    errors.push("content title fonts must be at least 35pt");
  }
  if (Number(fonts.body) < 16 || Number(fonts.topBody) < 16) {
    errors.push("body fonts must be at least 16pt");
  }
  for (const [layoutId, layout] of Object.entries(layoutsDoc.layouts)) {
    if (!layout.video) continue;
    const aspect = parseAspect(layout.mediaAspect);
    const stillAspect = parseAspect(layout.stillAspect);
    if (!aspect) {
      errors.push(`${layoutId}: mediaAspect is required for video layouts`);
      continue;
    }
    if (!stillAspect || !aspectMatches(stillAspect.w, stillAspect.h, aspect)) {
      errors.push(`${layoutId}: stillAspect must equal mediaAspect ${aspect.label}`);
    }
    if (!aspectMatches(Number(layout.video.w), Number(layout.video.h), aspect)) {
      errors.push(
        `${layoutId}: video slot ${layout.video.w}x${layout.video.h} does not match declared ${aspect.label}`,
      );
    }
    const titleSize = Number(layout.title && layout.title.fontSize ? layout.title.fontSize : fonts.title);
    const bodySize = Number(layout.body && layout.body.fontSize ? layout.body.fontSize : fonts.body);
    if (layout.title && titleSize < 35) errors.push(`${layoutId}: title font must be at least 35pt`);
    if (layout.body && bodySize < 16) errors.push(`${layoutId}: body font must be at least 16pt`);
  }
  return errors;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveSafeRelative(baseDir, rel, label, options = {}) {
  const required = options.required !== false;
  if (rel === undefined || rel === null || rel === "") {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof rel !== "string") throw new Error(`${label} must be a relative path string`);
  const raw = rel.trim();
  if (!raw) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (
    path.isAbsolute(raw) ||
    path.win32.isAbsolute(raw) ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ||
    raw.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`${label} must stay inside the deck directory: ${raw}`);
  }
  const baseReal = fs.realpathSync(baseDir);
  const portableRel = raw.replace(/[\\/]+/g, path.sep);
  const candidate = path.resolve(baseReal, portableRel);
  if (!fs.existsSync(candidate)) throw new Error(`${label} not found: ${raw}`);
  const real = fs.realpathSync(candidate);
  if (!isInside(baseReal, real)) throw new Error(`${label} escapes the deck directory: ${raw}`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${raw}`);
  return real;
}

function toolName(kind) {
  const explicit = process.env[kind.toUpperCase()];
  if (explicit) return explicit;
  return process.platform === "win32" ? `${kind}.exe` : kind;
}

function runTool(kind, args, options = {}) {
  const result = spawnSync(toolName(kind), args, {
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${kind} is required: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${kind} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function probe(filePath) {
  const result = runTool("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=index,codec_type,codec_name,pix_fmt,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate:format=format_name,duration",
    "-of",
    "json",
    filePath,
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON for ${filePath}: ${error.message}`);
  }
}

function parseFrameRate(value) {
  if (typeof value !== "string") return NaN;
  const match = value.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!match) return NaN;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  return denominator > 0 ? numerator / denominator : NaN;
}

function hasPngSignature(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(PNG_SIGNATURE.length);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    return count === header.length && header.equals(PNG_SIGNATURE);
  } finally {
    fs.closeSync(fd);
  }
}

function hasMp4Signature(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    return count >= 12 && header.toString("ascii", 4, 8) === "ftyp";
  } finally {
    fs.closeSync(fd);
  }
}

function inspectPoster(filePath, aspect) {
  const errors = [];
  let info;
  try {
    info = probe(filePath);
  } catch (error) {
    return { errors: [error.message] };
  }
  const streams = (info.streams || []).filter((stream) => stream.codec_type === "video");
  const stream = streams[0];
  if (!stream || !Number(stream.width) || !Number(stream.height)) {
    errors.push("poster has no readable image stream");
  } else if (!aspectMatches(Number(stream.width), Number(stream.height), aspect)) {
    errors.push(
      `poster aspect ${stream.width}x${stream.height} does not match required ${aspect.label}`,
    );
  }
  if (!hasPngSignature(filePath)) errors.push("poster must contain true PNG bytes");
  return {
    errors,
    width: stream ? Number(stream.width) : null,
    height: stream ? Number(stream.height) : null,
  };
}

function inspectVideo(filePath, aspect) {
  const errors = [];
  let info;
  try {
    info = probe(filePath);
  } catch (error) {
    return { errors: [error.message] };
  }
  const streams = (info.streams || []).filter((stream) => stream.codec_type === "video");
  const nonVideoStreams = (info.streams || []).filter((stream) => stream.codec_type !== "video");
  if (streams.length !== 1) errors.push(`video must contain exactly one video stream; found ${streams.length}`);
  if (nonVideoStreams.length !== 0) {
    errors.push(
      `video must be silent and contain no audio, subtitle, or data streams; found ${nonVideoStreams.map((stream) => stream.codec_type || "unknown").join(", ")}`,
    );
  }
  const stream = streams[0];
  const formatName = String((info.format && info.format.format_name) || "");
  const duration = Number(info.format && info.format.duration);
  const rates = stream ? [parseFrameRate(stream.avg_frame_rate), parseFrameRate(stream.r_frame_rate)].filter(Number.isFinite) : [];
  const fps = rates.length ? Math.max(...rates) : NaN;
  if (path.extname(filePath).toLowerCase() !== ".mp4") errors.push("video filename must end in .mp4");
  if (!hasMp4Signature(filePath) || !formatName.split(",").includes("mp4")) {
    errors.push("video must be an MP4 container with an ftyp signature");
  }
  if (!stream) {
    errors.push("video has no readable video stream");
  } else {
    const width = Number(stream.width);
    const height = Number(stream.height);
    if (stream.codec_name !== "h264") errors.push(`video codec must be h264; found ${stream.codec_name || "unknown"}`);
    if (stream.pix_fmt !== "yuv420p") errors.push(`video pixel format must be yuv420p; found ${stream.pix_fmt || "unknown"}`);
    if (stream.sample_aspect_ratio && !["1:1", "N/A"].includes(stream.sample_aspect_ratio)) {
      errors.push(`video sample aspect ratio must be 1:1; found ${stream.sample_aspect_ratio}`);
    }
    if (!aspectMatches(width, height, aspect)) {
      errors.push(`video aspect ${width}x${height} does not match required ${aspect.label}`);
    }
    if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) {
      errors.push(`video exceeds the 1080p class limit: ${width}x${height}`);
    }
    if (width % 2 || height % 2) errors.push(`video dimensions must be even for yuv420p: ${width}x${height}`);
  }
  if (!Number.isFinite(duration) || duration <= 0) errors.push("video duration must be positive");
  if (!Number.isFinite(fps) || fps <= 0) errors.push("video frame rate must be positive and readable");
  try {
    runTool("ffmpeg", [
      "-v", "error",
      "-xerror",
      "-i", filePath,
      "-map", "0:v:0",
      "-f", "null",
      "-",
    ], { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    errors.push(`video must fully decode from first to last frame: ${error.message}`);
  }
  return {
    errors,
    width: stream ? Number(stream.width) : null,
    height: stream ? Number(stream.height) : null,
    duration,
    fps,
    codec: stream ? stream.codec_name : null,
    pixFmt: stream ? stream.pix_fmt : null,
    audioStreamCount: nonVideoStreams.filter((item) => item.codec_type === "audio").length,
  };
}

function targetDimensions(aspect) {
  const short = Math.min(aspect.w, aspect.h);
  const scale = Math.floor(1080 / short);
  if (scale < 1) throw new Error(`unsupported media aspect ${aspect.label}`);
  const width = Math.round(aspect.w * scale);
  const height = Math.round(aspect.h * scale);
  if (width % 2 || height % 2) throw new Error(`media aspect ${aspect.label} cannot produce even 1080p dimensions`);
  return { width, height };
}

function toPosixRelative(fromDir, filePath) {
  return path.relative(fromDir, filePath).split(path.sep).join("/");
}

module.exports = {
  PNG_SIGNATURE,
  aspectMatches,
  hasMp4Signature,
  hasPngSignature,
  inspectPoster,
  inspectVideo,
  parseFrameRate,
  parseAspect,
  probe,
  resolveSafeRelative,
  runTool,
  targetDimensions,
  toPosixRelative,
  validateLayoutContract,
};

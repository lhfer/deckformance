#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const MIB = 1024 * 1024;
const MEDIA_BUDGET_VERSION = "1.0.0";
const DEFAULT_MEDIA_BUDGET = Object.freeze({
  minDurationSeconds: 3,
  maxDurationSeconds: 10,
  allowedFps: Object.freeze([24, 30]),
  codec: "h264",
  pixelFormat: "yuv420p",
  muted: true,
  maxClipBytes: 12 * MIB,
  maxDeckBytes: 100 * MIB,
});

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256Json(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function descriptorId(video, index) {
  for (const key of ["id", "slideId", "layerId"]) {
    if (typeof video[key] === "string" && video[key].trim()) return video[key].trim();
  }
  return `#${index + 1}`;
}

function projectDescriptor(video, index) {
  const source = video && typeof video === "object" && !Array.isArray(video) ? video : {};
  return {
    id: descriptorId(source, index),
    sha256: source.sha256 || null,
    bytes: source.bytes,
    durationSeconds: source.durationSeconds,
    fps: source.fps,
    codec: typeof source.codec === "string" ? source.codec.toLowerCase() : source.codec,
    pixelFormat:
      typeof (source.pixelFormat || source.pixFmt) === "string"
        ? String(source.pixelFormat || source.pixFmt).toLowerCase()
        : source.pixelFormat || source.pixFmt,
    muted: source.muted,
    audioStreamCount: source.audioStreamCount,
  };
}

function mediaDescriptorSetSha256(videoDescriptors) {
  if (!Array.isArray(videoDescriptors)) {
    throw new TypeError("videoDescriptors must be an array");
  }
  return sha256Json(videoDescriptors.map(projectDescriptor));
}

function addIssue(errors, code, pointer, message) {
  errors.push({ code, pointer, message });
}

/**
 * Validate the final, post-transcode video descriptors as one deck-wide set.
 * The returned receipt is intentionally a pre-QA artifact. Five-frame QA must
 * bind this receipt and the same descriptorSetSha256 before it can be trusted.
 */
function validateMediaBudget(videoDescriptors, options = {}) {
  const errors = [];
  if (!Array.isArray(videoDescriptors)) {
    return {
      schemaVersion: MEDIA_BUDGET_VERSION,
      receiptType: "deckformance-media-budget",
      stage: "pre-qa",
      policy: { ...DEFAULT_MEDIA_BUDGET, allowedFps: [...DEFAULT_MEDIA_BUDGET.allowedFps] },
      descriptorSetSha256: null,
      clips: [],
      totals: { clipCount: 0, totalBytes: 0 },
      passed: false,
      errors: [{ code: "VIDEO_SET", pointer: "videos", message: "must be an array" }],
    };
  }

  if (videoDescriptors.length === 0) {
    addIssue(errors, "VIDEO_SET", "videos", "must contain at least one video descriptor");
  }

  const clips = videoDescriptors.map((raw, index) => {
    const pointer = `videos[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      addIssue(errors, "VIDEO_DESCRIPTOR", pointer, "must be an object");
    }
    const video = projectDescriptor(raw, index);
    if (video.id.startsWith("#")) {
      addIssue(errors, "VIDEO_ID", pointer, "must define a stable id, slideId, or layerId");
    }
    if (!SHA256_RE.test(String(video.sha256 || ""))) {
      addIssue(errors, "VIDEO_HASH", `${pointer}.sha256`, "must be a sha256:<64 lowercase hex> binding");
    }
    if (!Number.isInteger(video.bytes) || video.bytes <= 0) {
      addIssue(errors, "VIDEO_BYTES", `${pointer}.bytes`, "must be a positive integer");
    } else if (video.bytes > DEFAULT_MEDIA_BUDGET.maxClipBytes) {
      addIssue(
        errors,
        "CLIP_BUDGET",
        `${pointer}.bytes`,
        `must not exceed ${DEFAULT_MEDIA_BUDGET.maxClipBytes} bytes (12 MiB)`,
      );
    }
    if (
      !Number.isFinite(video.durationSeconds) ||
      video.durationSeconds < DEFAULT_MEDIA_BUDGET.minDurationSeconds ||
      video.durationSeconds > DEFAULT_MEDIA_BUDGET.maxDurationSeconds
    ) {
      addIssue(
        errors,
        "DURATION_BUDGET",
        `${pointer}.durationSeconds`,
        `must be between ${DEFAULT_MEDIA_BUDGET.minDurationSeconds} and ${DEFAULT_MEDIA_BUDGET.maxDurationSeconds} seconds`,
      );
    }
    if (!DEFAULT_MEDIA_BUDGET.allowedFps.includes(video.fps)) {
      addIssue(errors, "FRAME_RATE", `${pointer}.fps`, "must be exactly 24 or 30 fps");
    }
    if (video.codec !== DEFAULT_MEDIA_BUDGET.codec) {
      addIssue(errors, "VIDEO_CODEC", `${pointer}.codec`, "must be h264");
    }
    if (video.pixelFormat !== DEFAULT_MEDIA_BUDGET.pixelFormat) {
      addIssue(errors, "PIXEL_FORMAT", `${pointer}.pixelFormat`, "must be yuv420p");
    }
    if (video.muted !== true) {
      addIssue(errors, "MUTED_MEDIA", `${pointer}.muted`, "must be true");
    }
    if (video.audioStreamCount !== undefined && video.audioStreamCount !== 0) {
      addIssue(errors, "AUDIO_STREAM", `${pointer}.audioStreamCount`, "must be 0");
    }
    return video;
  });

  const totalBytes = clips.reduce(
    (sum, clip) => sum + (Number.isInteger(clip.bytes) && clip.bytes > 0 ? clip.bytes : 0),
    0,
  );
  if (totalBytes > DEFAULT_MEDIA_BUDGET.maxDeckBytes) {
    addIssue(
      errors,
      "DECK_BUDGET",
      "videos",
      `embedded video total must not exceed ${DEFAULT_MEDIA_BUDGET.maxDeckBytes} bytes (100 MiB)`,
    );
  }

  const seenIds = new Set();
  for (const [index, clip] of clips.entries()) {
    if (seenIds.has(clip.id)) {
      addIssue(errors, "VIDEO_ID", `videos[${index}]`, `duplicate stable video id ${clip.id}`);
    }
    seenIds.add(clip.id);
  }

  const createdAt = options.createdAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    addIssue(errors, "CREATED_AT", "createdAt", "must be an ISO-8601 timestamp");
  }

  return {
    schemaVersion: MEDIA_BUDGET_VERSION,
    receiptType: "deckformance-media-budget",
    stage: "pre-qa",
    createdAt,
    policy: { ...DEFAULT_MEDIA_BUDGET, allowedFps: [...DEFAULT_MEDIA_BUDGET.allowedFps] },
    descriptorSetSha256: mediaDescriptorSetSha256(videoDescriptors),
    clips,
    totals: { clipCount: clips.length, totalBytes },
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Fail closed at the QA boundary. This makes any post-QA crop/transcode/hash or
 * descriptor drift invalidate the earlier media-budget decision.
 */
function assertBudgetReceiptForQa(receipt, currentVideoDescriptors, options = {}) {
  if (!receipt || typeof receipt !== "object") throw new Error("media budget receipt is required before QA");
  if (receipt.schemaVersion !== MEDIA_BUDGET_VERSION) {
    throw new Error(`unsupported media budget receipt version ${receipt.schemaVersion || "missing"}`);
  }
  if (receipt.receiptType !== "deckformance-media-budget" || receipt.stage !== "pre-qa") {
    throw new Error("media budget receipt must be a deckformance pre-qa receipt");
  }
  if (receipt.passed !== true || (Array.isArray(receipt.errors) && receipt.errors.length > 0)) {
    throw new Error("media budget receipt did not pass");
  }
  const currentHash = mediaDescriptorSetSha256(currentVideoDescriptors);
  if (receipt.descriptorSetSha256 !== currentHash) {
    throw new Error("video descriptors changed after media budget validation; rerun budget before QA");
  }
  if (options.qaStartedAt !== undefined) {
    const budgetTime = Date.parse(receipt.createdAt);
    const qaTime = Date.parse(options.qaStartedAt);
    if (!Number.isFinite(budgetTime) || !Number.isFinite(qaTime) || budgetTime > qaTime) {
      throw new Error("media budget receipt must predate the QA run");
    }
  }
  return receipt;
}

module.exports = {
  DEFAULT_MEDIA_BUDGET,
  MEDIA_BUDGET_VERSION,
  assertBudgetReceiptForQa,
  mediaDescriptorSetSha256,
  validateMediaBudget,
};

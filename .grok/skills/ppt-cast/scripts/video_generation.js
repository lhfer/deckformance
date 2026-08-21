#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { invokeProvider } = require("./runtime/provider_adapter");
const { sha256Buffer, stableJson } = require("./runtime/hash_bound_receipt");
const { inspectVideo, parseAspect, resolveSafeRelative } = require("./media_contract");

const MAX_CLIP_BYTES = 12 * 1024 * 1024;

function structuredPromptFromMotionPlan(motionPlan, context = {}) {
  if (!motionPlan || typeof motionPlan !== "object" || Array.isArray(motionPlan)) throw new Error("motionPlan must be an object");
  const camera = motionPlan.camera && typeof motionPlan.camera === "object"
    ? motionPlan.camera
    : { movement: motionPlan.cameraMovement || "static" };
  const slot = context.slot && typeof context.slot === "object" ? context.slot : {};
  const request = {
    task: "character-video-slide-performance",
    slideId: context.slideId || null,
    layerId: context.layerId || motionPlan.targetLayerId || null,
    visualIntent: context.visualIntent || null,
    action: context.action || null,
    motion: {
      durationSeconds: motionPlan.durationSeconds,
      segments: motionPlan.segments || motionPlan.beats || [],
      camera,
      gaze: motionPlan.gaze ?? camera.gaze ?? null,
      safeArea: motionPlan.safeArea ?? camera.safeArea ?? null,
      finalHoldSeconds: motionPlan.finalHoldSeconds ?? null,
      targetLayerId: motionPlan.targetLayerId || context.layerId || null,
    },
    output: {
      aspect: slot.aspect || context.aspect || null,
      widthPx: slot.widthPx || context.widthPx || null,
      heightPx: slot.heightPx || context.heightPx || null,
      fps: context.fps || 24,
      codec: "h264",
      pixelFormat: "yuv420p",
      silent: true,
    },
    constraints: ["preserve-character-identity", "keep-action-inside-safe-area", "no-readable-text"],
  };
  return JSON.stringify(request);
}

function buildVideoGenerationRequest(options = {}) {
  const model = String(options.model || "").trim();
  const outputPath = String(options.outputPath || "").trim();
  const slideId = String(options.slideId || "").trim();
  const layerId = String(options.layerId || options.motionPlan && options.motionPlan.targetLayerId || "").trim();
  if (!model) throw new Error("video generation requires an injected model");
  if (!outputPath || path.posix.extname(outputPath).toLowerCase() !== ".mp4") throw new Error("video generation outputPath must end in .mp4");
  if (!slideId || !layerId) throw new Error("video generation requires stable slideId and layerId bindings");
  const prompt = structuredPromptFromMotionPlan(options.motionPlan, { ...options, slideId, layerId });
  const motionPlanSha256 = /^sha256:[a-f0-9]{64}$/.test(String(options.motionPlan && options.motionPlan.planSha256 || ""))
    ? options.motionPlan.planSha256
    : sha256Buffer(stableJson(options.motionPlan));
  const request = {
    prompt,
    model,
    seed: options.seed === undefined ? null : options.seed,
    outputPath,
    motionPlan: options.motionPlan,
    motionPlanSha256,
    slideId,
    layerId,
    slot: options.slot || null,
    aspect: options.aspect || options.slot && options.slot.aspect || null,
    fps: options.fps || 24,
    durationSeconds: Number(options.motionPlan && options.motionPlan.durationSeconds),
    inputs: Array.isArray(options.inputs) ? [...options.inputs] : [],
  };
  request.generationRequestSha256 = sha256Buffer(stableJson({
    slideId: request.slideId,
    layerId: request.layerId,
    model: request.model,
    seed: request.seed,
    outputPath: request.outputPath,
    slot: request.slot,
    aspect: request.aspect,
    fps: request.fps,
    durationSeconds: request.durationSeconds,
    inputs: request.inputs,
    promptSha256: sha256Buffer(request.prompt),
    motionPlanSha256: request.motionPlanSha256,
  }));
  return request;
}

function validateGeneratedVideoMedia({ root, output, request }) {
  const aspect = parseAspect(request && (request.aspect || request.slot && request.slot.aspect));
  if (!aspect) throw new Error("video generation requires a resolved output aspect for media validation");
  const filePath = resolveSafeRelative(root, output.path, "generated video output");
  const info = inspectVideo(filePath, aspect);
  const errors = [...(info.errors || [])];
  const expectedDuration = Number(request.durationSeconds);
  if (!Number.isFinite(expectedDuration) || expectedDuration < 3 || expectedDuration > 10) {
    errors.push("requested video duration must be between 3 and 10 seconds");
  } else if (Math.abs(Number(info.duration) - expectedDuration) > 0.3) {
    errors.push(`generated duration ${info.duration}s does not match requested ${expectedDuration}s`);
  }
  const expectedFps = Number(request.fps);
  if (![24, 30].includes(expectedFps)) errors.push("requested video fps must be 24 or 30");
  else if (Math.abs(Number(info.fps) - expectedFps) > 0.05) errors.push(`generated fps ${info.fps} does not match requested ${expectedFps}`);
  if (output.bytes > MAX_CLIP_BYTES) errors.push("generated video exceeds the 12 MiB per-clip budget");
  if (request.slot && Number.isInteger(request.slot.widthPx) && Number.isInteger(request.slot.heightPx)) {
    if (info.width !== request.slot.widthPx || info.height !== request.slot.heightPx) {
      errors.push(`generated dimensions ${info.width}x${info.height} do not match slot ${request.slot.widthPx}x${request.slot.heightPx}`);
    }
  }
  if (errors.length) throw new Error(`generated video failed the final media contract:\n- ${errors.join("\n- ")}`);
  return {
    passed: true,
    providerStatus: "validated",
    media: {
      width: info.width,
      height: info.height,
      durationSeconds: info.duration,
      fps: info.fps,
      codec: info.codec,
      pixelFormat: info.pixFmt,
      audioStreamCount: info.audioStreamCount,
    },
  };
}

async function generateVideoFromMotionPlan(options = {}) {
  const request = buildVideoGenerationRequest(options);
  const validateOutput = options.testOnly === true && typeof options.testOnlyValidateOutput === "function"
    ? options.testOnlyValidateOutput
    : validateGeneratedVideoMedia;
  return invokeProvider(options.adapter, "generate-video", request, {
    root: options.root,
    inputs: request.inputs,
    implementationFiles: options.implementationFiles,
    receiptPath: options.receiptPath,
    validateOutput,
  });
}

module.exports = {
  buildVideoGenerationRequest,
  generateVideoFromMotionPlan,
  structuredPromptFromMotionPlan,
  validateGeneratedVideoMedia,
};

#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const MOTION_PLAN_VERSION = "2.0.0";
const STABLE_LAYER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAMERA_MOVEMENTS = new Set([
  "static",
  "push-in",
  "pull-out",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "orbit-left",
  "orbit-right",
]);
const NATIVE_LAYER_ACTIONS = new Set(["appear", "fade", "fade-in", "fade-out"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function stableLayerId(value) {
  return typeof value === "string" && STABLE_LAYER_ID_RE.test(value);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function safeAreaErrors(safeArea, pointer) {
  if (safeArea === undefined) return [];
  if (!safeArea || typeof safeArea !== "object" || Array.isArray(safeArea)) {
    return [`${pointer} must be an object`];
  }
  const errors = [];
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(safeArea[key]) || safeArea[key] < 0 || safeArea[key] > 1) {
      errors.push(`${pointer}.${key} must be a number between 0 and 1`);
    }
  }
  if (Number.isFinite(safeArea.x) && Number.isFinite(safeArea.width) && safeArea.x + safeArea.width > 1) {
    errors.push(`${pointer} must fit inside the normalized slide width`);
  }
  if (Number.isFinite(safeArea.y) && Number.isFinite(safeArea.height) && safeArea.y + safeArea.height > 1) {
    errors.push(`${pointer} must fit inside the normalized slide height`);
  }
  return errors;
}

function validateMotionPlan(plan, options = {}) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["motionPlan must be an object"];

  const durationSeconds = Number(plan.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 10) {
    errors.push("motionPlan.durationSeconds must be between 3 and 10 seconds");
  }
  if (plan.loopPolicy !== "hold-last-frame") {
    errors.push("motionPlan.loopPolicy must be hold-last-frame");
  }
  if (Object.hasOwn(plan, "loop") || Object.hasOwn(plan, "repeat") || Object.hasOwn(plan, "repeatCount")) {
    errors.push("motionPlan must not contain loop/repeat fields");
  }
  if (
    plan.autoAdvance === true ||
    Object.hasOwn(plan, "advanceAfterSeconds") ||
    (plan.advanceMode !== undefined && plan.advanceMode !== "manual")
  ) {
    errors.push("motionPlan must use manual slide advance");
  }

  const finalHoldSeconds = Number(plan.finalHoldSeconds);
  if (!Number.isFinite(finalHoldSeconds) || finalHoldSeconds < 0 || finalHoldSeconds >= durationSeconds) {
    errors.push("motionPlan.finalHoldSeconds must be non-negative and shorter than durationSeconds");
  }

  const targetLayerId = plan.targetLayerId || options.videoLayerId;
  if (!stableLayerId(targetLayerId)) {
    errors.push("motionPlan requires a stable targetLayerId or options.videoLayerId");
  }
  const knownLayerIds = Array.isArray(options.layerIds) ? new Set(options.layerIds) : null;
  if (knownLayerIds && targetLayerId && !knownLayerIds.has(targetLayerId)) {
    errors.push(`motionPlan target layer ${targetLayerId} is not present in the design plan`);
  }

  if (!Array.isArray(plan.beats)) {
    errors.push("motionPlan.beats must be an array");
  } else {
    plan.beats.forEach((beat, index) => {
      const pointer = `motionPlan.beats[${index}]`;
      if (!beat || typeof beat !== "object" || Array.isArray(beat)) {
        errors.push(`${pointer} must be an object`);
        return;
      }
      if (!Number.isFinite(beat.at) || beat.at < 0 || beat.at > durationSeconds) {
        errors.push(`${pointer}.at must fall inside the motion duration`);
      }
      if (typeof beat.action !== "string" || !/^[a-z][a-z0-9-]*$/.test(beat.action)) {
        errors.push(`${pointer}.action must be a lower-case action token`);
      }
      const beatLayerId = beat.targetLayerId || targetLayerId;
      if (!stableLayerId(beatLayerId)) errors.push(`${pointer}.targetLayerId must be a stable layer id`);
      if (knownLayerIds && beatLayerId && !knownLayerIds.has(beatLayerId)) {
        errors.push(`${pointer} targets unknown layer ${beatLayerId}`);
      }
      if (
        beatLayerId !== targetLayerId &&
        NATIVE_LAYER_ACTIONS.has(beat.action) &&
        options.experimentalNativeAnimations !== true
      ) {
        errors.push(`${pointer} requires experimentalNativeAnimations for native appear/fade actions`);
      }
    });
  }

  if (plan.camera !== undefined) {
    if (!plan.camera || typeof plan.camera !== "object" || Array.isArray(plan.camera)) {
      errors.push("motionPlan.camera must be an object");
    } else {
      const movement = plan.camera.movement || "static";
      if (!CAMERA_MOVEMENTS.has(movement)) {
        errors.push(`motionPlan.camera.movement is unsupported: ${movement}`);
      }
      if (plan.camera.targetLayerId !== undefined) {
        if (!stableLayerId(plan.camera.targetLayerId)) {
          errors.push("motionPlan.camera.targetLayerId must be a stable layer id");
        } else if (knownLayerIds && !knownLayerIds.has(plan.camera.targetLayerId)) {
          errors.push(`motionPlan.camera targets unknown layer ${plan.camera.targetLayerId}`);
        }
      }
      if (plan.camera.gaze !== undefined && (typeof plan.camera.gaze !== "string" || !plan.camera.gaze.trim())) {
        errors.push("motionPlan.camera.gaze must be a non-empty string");
      }
      errors.push(...safeAreaErrors(plan.camera.safeArea, "motionPlan.camera.safeArea"));
    }
  }
  return errors;
}

function normalizeMotionPlan(plan, options = {}) {
  const errors = validateMotionPlan(plan, options);
  if (errors.length) throw new Error(`invalid motion plan:\n- ${errors.join("\n- ")}`);

  const targetLayerId = plan.targetLayerId || options.videoLayerId;
  const camera = plan.camera || {};
  const normalized = {
    schemaVersion: MOTION_PLAN_VERSION,
    kind: "deckformance-motion-plan",
    targetLayerId,
    durationSeconds: round(Number(plan.durationSeconds)),
    loopPolicy: "hold-last-frame",
    finalHoldSeconds: round(Number(plan.finalHoldSeconds)),
    beats: plan.beats
      .map((beat, sourceIndex) => ({
        at: round(Number(beat.at)),
        action: beat.action,
        targetLayerId: beat.targetLayerId || targetLayerId,
        sourceIndex,
      }))
      .sort((a, b) => a.at - b.at || a.sourceIndex - b.sourceIndex)
      .map(({ sourceIndex, ...beat }) => beat),
    camera: {
      movement: camera.movement || "static",
      targetLayerId: camera.targetLayerId || targetLayerId,
      ...(camera.gaze !== undefined ? { gaze: camera.gaze.trim() } : {}),
      ...(camera.safeArea !== undefined
        ? {
            safeArea: {
              x: round(camera.safeArea.x),
              y: round(camera.safeArea.y),
              width: round(camera.safeArea.width),
              height: round(camera.safeArea.height),
            },
          }
        : {}),
    },
    playback: {
      startTrigger: "on-slide-enter",
      startDelayMs: 0,
      playCount: 1,
      restart: "never",
      endBehavior: "hold-last-frame",
      advanceMode: "manual",
    },
  };
  normalized.planSha256 = sha256Json(normalized);
  return normalized;
}

function buildPowerPointTimingTree(plan, options = {}) {
  const normalized =
    plan && plan.kind === "deckformance-motion-plan" ? plan : normalizeMotionPlan(plan, options);
  const tree = {
    schemaVersion: MOTION_PLAN_VERSION,
    kind: "deckformance-powerpoint-timing-tree",
    sourceMotionPlanSha256: normalized.planSha256 || sha256Json(normalized),
    targetLayerId: normalized.targetLayerId,
    durationMs: Math.round(normalized.durationSeconds * 1000),
    autoplay: {
      trigger: "onBegin",
      delayMs: 0,
      command: "playFrom(0.0)",
      playCount: 1,
      restart: "never",
    },
    mediaNode: {
      targetLayerId: normalized.targetLayerId,
      fill: "hold",
      muted: true,
      finalHoldMs: Math.round(normalized.finalHoldSeconds * 1000),
    },
    beats: normalized.beats,
    camera: normalized.camera,
    loop: false,
    autoAdvance: false,
    advanceMode: "manual",
  };
  const errors = validatePowerPointTimingTree(tree);
  if (errors.length) throw new Error(`invalid PowerPoint timing tree:\n- ${errors.join("\n- ")}`);
  tree.timingTreeSha256 = sha256Json(tree);
  return tree;
}

function validatePowerPointTimingTree(tree) {
  const errors = [];
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return ["timing tree must be an object"];
  if (tree.schemaVersion !== MOTION_PLAN_VERSION) errors.push("timing tree schemaVersion must be 2.0.0");
  if (tree.kind !== "deckformance-powerpoint-timing-tree") errors.push("timing tree kind is invalid");
  if (!stableLayerId(tree.targetLayerId)) errors.push("timing tree targetLayerId must be stable");
  if (!Number.isInteger(tree.durationMs) || tree.durationMs < 3000 || tree.durationMs > 10000) {
    errors.push("timing tree durationMs must be between 3000 and 10000");
  }
  if (
    !tree.autoplay ||
    tree.autoplay.trigger !== "onBegin" ||
    tree.autoplay.delayMs !== 0 ||
    tree.autoplay.command !== "playFrom(0.0)" ||
    tree.autoplay.playCount !== 1 ||
    tree.autoplay.restart !== "never"
  ) {
    errors.push("timing tree must autoplay exactly once on slide begin");
  }
  if (!tree.mediaNode || tree.mediaNode.targetLayerId !== tree.targetLayerId || tree.mediaNode.fill !== "hold") {
    errors.push("timing tree media node must hold and target the stable video layer");
  }
  if (tree.loop !== false) errors.push("timing tree must not loop");
  if (tree.autoAdvance !== false || tree.advanceMode !== "manual") {
    errors.push("timing tree must preserve manual slide advance");
  }
  return errors;
}

module.exports = {
  CAMERA_MOVEMENTS,
  MOTION_PLAN_VERSION,
  STABLE_LAYER_ID_RE,
  buildPowerPointTimingTree,
  normalizeMotionPlan,
  validateMotionPlan,
  validatePowerPointTimingTree,
};

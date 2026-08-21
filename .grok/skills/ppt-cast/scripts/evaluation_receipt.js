#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { safeRelativePath, sha256File } = require("./runtime/hash_bound_receipt");

const EVALUATION_RECEIPT_VERSION = "2.0.0";
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const FRAME_RATIOS = [0, 0.2, 0.5, 0.8, 1];
const HUMAN_REVIEW_STATUSES = new Set(["pending", "approved", "rejected", "not-required"]);
const ISSUE_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const CORE_CRITERIA = Object.freeze({
  video: Object.freeze(["identity", "body-completeness", "crop-safety", "claim-expression", "motion-continuity"]),
  deck: Object.freeze(["identity", "body-completeness", "crop-safety", "claim-expression", "typography-hierarchy", "motion-continuity"]),
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function evaluationReceiptSha256(receipt) {
  const copy = receipt && typeof receipt === "object" ? { ...receipt } : receipt;
  if (copy && typeof copy === "object") delete copy.receiptSha256;
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(copy))).digest("hex")}`;
}

function validateTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function addIssue(errors, code, pointer, message) {
  errors.push({ code, pointer, message });
}

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function validateImplementationFile(errors, root, relativePath, expectedHash, pointer) {
  if (!validRelativePath(relativePath)) {
    addIssue(errors, "IMPLEMENTATION_PATH", pointer, "must be a safe job-relative path");
    return;
  }
  if (!root) return;
  try {
    const filePath = safeRelativePath(root, relativePath, { mustExist: true });
    if (sha256File(filePath) !== expectedHash) addIssue(errors, "IMPLEMENTATION_DRIFT", pointer, "current bytes do not match the declared hash");
  } catch (error) {
    addIssue(errors, "IMPLEMENTATION_DRIFT", pointer, error.message);
  }
}

function validateEvaluationReceipt(receipt, options = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, accepted: false, errors: [{ code: "RECEIPT", pointer: "receipt", message: "must be an object" }] };
  }
  if (receipt.schemaVersion !== EVALUATION_RECEIPT_VERSION) {
    addIssue(errors, "VERSION", "schemaVersion", "must be 2.0.0");
  }
  if (receipt.receiptType !== "deckformance-evaluation") {
    addIssue(errors, "TYPE", "receiptType", "must be deckformance-evaluation");
  }
  if (!validateTimestamp(receipt.createdAt)) {
    addIssue(errors, "CREATED_AT", "createdAt", "must be an ISO-8601 timestamp");
  }
  if (Object.hasOwn(receipt, "checks")) {
    addIssue(errors, "LEGACY_BOOLEAN_CHECKS", "checks", "anonymous boolean check maps are not accepted");
  }

  const subject = receipt.subject;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    addIssue(errors, "SUBJECT", "subject", "must identify the evaluated artifact");
  } else {
    if (!["video", "slide-render", "deck"].includes(subject.kind)) {
      addIssue(errors, "SUBJECT_KIND", "subject.kind", "must be video, slide-render, or deck");
    }
    if (!SHA256_RE.test(String(subject.artifactSha256 || ""))) {
      addIssue(errors, "SUBJECT_HASH", "subject.artifactSha256", "must bind the evaluated bytes");
    }
    if (options.expectedArtifactSha256 && subject.artifactSha256 !== options.expectedArtifactSha256) {
      addIssue(errors, "SUBJECT_DRIFT", "subject.artifactSha256", "does not match the current artifact");
    }
    if (
      options.expectedMediaBudgetReceiptSha256 &&
      subject.mediaBudgetReceiptSha256 !== options.expectedMediaBudgetReceiptSha256
    ) {
      addIssue(
        errors,
        "MEDIA_BUDGET_BINDING",
        "subject.mediaBudgetReceiptSha256",
        "does not match the pre-QA media budget receipt",
      );
    }
  }

  const evaluator = receipt.evaluator;
  if (!evaluator || typeof evaluator !== "object" || Array.isArray(evaluator)) {
    addIssue(errors, "EVALUATOR", "evaluator", "must be a versioned evaluator descriptor");
  } else {
    if (typeof evaluator.id !== "string" || !evaluator.id.trim()) addIssue(errors, "EVALUATOR_ID", "evaluator.id", "is required");
    if (typeof evaluator.version !== "string" || !evaluator.version.trim()) addIssue(errors, "EVALUATOR_VERSION", "evaluator.version", "is required");
    if (!SHA256_RE.test(String(evaluator.implementationSha256 || ""))) {
      addIssue(errors, "EVALUATOR_HASH", "evaluator.implementationSha256", "must bind the evaluator implementation");
    }
    validateImplementationFile(errors, options.evidenceRoot, evaluator.implementationPath, evaluator.implementationSha256, "evaluator.implementationPath");
  }

  const rubric = receipt.rubric;
  if (!rubric || typeof rubric !== "object" || Array.isArray(rubric)) {
    addIssue(errors, "RUBRIC", "rubric", "must be a versioned rubric descriptor");
  } else {
    if (typeof rubric.id !== "string" || !rubric.id.trim()) addIssue(errors, "RUBRIC_ID", "rubric.id", "is required");
    if (typeof rubric.version !== "string" || !rubric.version.trim()) addIssue(errors, "RUBRIC_VERSION", "rubric.version", "is required");
    if (!SHA256_RE.test(String(rubric.sha256 || ""))) addIssue(errors, "RUBRIC_HASH", "rubric.sha256", "must bind the rubric bytes");
    validateImplementationFile(errors, options.evidenceRoot, rubric.path, rubric.sha256, "rubric.path");
    if (
      !rubric.scale ||
      !Number.isFinite(rubric.scale.min) ||
      !Number.isFinite(rubric.scale.max) ||
      !Number.isFinite(rubric.scale.passAt) ||
      rubric.scale.min >= rubric.scale.max ||
      rubric.scale.passAt < rubric.scale.min ||
      rubric.scale.passAt > rubric.scale.max
    ) {
      addIssue(errors, "RUBRIC_SCALE", "rubric.scale", "must define min < max and passAt inside the scale");
    }
  }

  const frameIds = new Set();
  const frameHashes = new Set();
  const evidenceFrames = Array.isArray(receipt.evidenceFrames) ? receipt.evidenceFrames : [];
  if (!Array.isArray(receipt.evidenceFrames) || evidenceFrames.length === 0) {
    addIssue(errors, "EVIDENCE_FRAMES", "evidenceFrames", "must contain evidence frame descriptors");
  }
  evidenceFrames.forEach((frame, index) => {
    const pointer = `evidenceFrames[${index}]`;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      addIssue(errors, "EVIDENCE_FRAME", pointer, "must be an object");
      return;
    }
    if (typeof frame.id !== "string" || !frame.id.trim()) {
      addIssue(errors, "FRAME_ID", `${pointer}.id`, "is required");
    } else if (frameIds.has(frame.id)) {
      addIssue(errors, "FRAME_ID", `${pointer}.id`, `duplicate frame id ${frame.id}`);
    } else {
      frameIds.add(frame.id);
    }
    if (!SHA256_RE.test(String(frame.sha256 || ""))) {
      addIssue(errors, "FRAME_HASH", `${pointer}.sha256`, "must bind the frame bytes");
    } else if (frameHashes.has(frame.sha256)) {
      addIssue(errors, "FRAME_HASH", `${pointer}.sha256`, "duplicate frame hashes are not accepted as motion evidence");
    } else {
      frameHashes.add(frame.sha256);
    }
    if (typeof frame.path !== "string" || !frame.path.trim()) {
      addIssue(errors, "FRAME_PATH", `${pointer}.path`, "is required");
    }
    const sourceHash = frame.sourceArtifactSha256 || frame.mediaSha256 || frame.artifactSha256;
    if (!SHA256_RE.test(String(sourceHash || ""))) {
      addIssue(errors, "FRAME_SOURCE_HASH", `${pointer}.sourceArtifactSha256`, "must bind the source artifact");
    } else if (subject && sourceHash !== subject.artifactSha256) {
      addIssue(errors, "FRAME_SOURCE_DRIFT", `${pointer}.sourceArtifactSha256`, "does not match subject.artifactSha256");
    }
    if (frame.timeRatio !== undefined && (!Number.isFinite(frame.timeRatio) || frame.timeRatio < 0 || frame.timeRatio > 1)) {
      addIssue(errors, "FRAME_TIME", `${pointer}.timeRatio`, "must be between 0 and 1");
    }
  });

  if (subject && subject.kind === "video" && options.requireFiveFrameVideoEvidence !== false) {
    if (evidenceFrames.length !== FRAME_RATIOS.length) {
      addIssue(errors, "VIDEO_FRAME_COUNT", "evidenceFrames", "video evaluation requires exactly five bound frames");
    } else {
      evidenceFrames.forEach((frame, index) => {
        if (Math.abs(Number(frame.timeRatio) - FRAME_RATIOS[index]) > 0.001) {
          addIssue(errors, "VIDEO_FRAME_TIMING", `evidenceFrames[${index}].timeRatio`, `expected ${FRAME_RATIOS[index]}`);
        }
      });
    }
  }

  const scores = Array.isArray(receipt.scores) ? receipt.scores : [];
  const seenCriteria = new Set();
  if (!Array.isArray(receipt.scores) || scores.length === 0) {
    addIssue(errors, "SCORES", "scores", "must contain numeric per-criterion scores");
  }
  const scale = rubric && rubric.scale;
  scores.forEach((score, index) => {
    const pointer = `scores[${index}]`;
    if (!score || typeof score !== "object" || Array.isArray(score)) {
      addIssue(errors, "SCORE", pointer, "must be an object");
      return;
    }
    if (typeof score.criterion !== "string" || !score.criterion.trim()) {
      addIssue(errors, "CRITERION", `${pointer}.criterion`, "is required");
    } else if (seenCriteria.has(score.criterion)) {
      addIssue(errors, "CRITERION", `${pointer}.criterion`, `duplicate criterion ${score.criterion}`);
    } else {
      seenCriteria.add(score.criterion);
    }
    if (
      !Number.isFinite(score.score) ||
      (scale && (score.score < scale.min || score.score > scale.max))
    ) {
      addIssue(errors, "SCORE_VALUE", `${pointer}.score`, "must be numeric and inside the rubric scale");
    }
    if (!Array.isArray(score.evidenceFrameIds) || score.evidenceFrameIds.length === 0) {
      addIssue(errors, "SCORE_EVIDENCE", `${pointer}.evidenceFrameIds`, "must cite at least one evidence frame");
    } else {
      for (const id of score.evidenceFrameIds) {
        if (!frameIds.has(id)) addIssue(errors, "SCORE_EVIDENCE", `${pointer}.evidenceFrameIds`, `references unknown frame ${id}`);
      }
    }
  });
  for (const criterion of CORE_CRITERIA[subject && subject.kind] || []) {
    if (!seenCriteria.has(criterion)) addIssue(errors, "CORE_CRITERION", "scores", `missing required ${subject.kind} criterion ${criterion}`);
  }

  const issues = Array.isArray(receipt.issues) ? receipt.issues : [];
  if (!Array.isArray(receipt.issues)) addIssue(errors, "ISSUES", "issues", "must be an array");
  issues.forEach((issue, index) => {
    const pointer = `issues[${index}]`;
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
      addIssue(errors, "ISSUE", pointer, "must be an object");
      return;
    }
    if (!ISSUE_SEVERITIES.has(issue.severity)) addIssue(errors, "ISSUE_SEVERITY", `${pointer}.severity`, "must be P0, P1, P2, or P3");
    if (typeof issue.code !== "string" || !issue.code.trim()) addIssue(errors, "ISSUE_CODE", `${pointer}.code`, "is required");
    if (typeof issue.message !== "string" || !issue.message.trim()) addIssue(errors, "ISSUE_MESSAGE", `${pointer}.message`, "is required");
  });

  const review = receipt.humanReview;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    addIssue(errors, "HUMAN_REVIEW", "humanReview", "must record the human review state");
  } else {
    if (!HUMAN_REVIEW_STATUSES.has(review.status)) {
      addIssue(errors, "HUMAN_REVIEW_STATUS", "humanReview.status", "is invalid");
    }
    if (["approved", "rejected"].includes(review.status)) {
      if (typeof review.reviewer !== "string" || !review.reviewer.trim()) addIssue(errors, "HUMAN_REVIEWER", "humanReview.reviewer", "is required");
      if (!validateTimestamp(review.reviewedAt)) addIssue(errors, "HUMAN_REVIEWED_AT", "humanReview.reviewedAt", "must be an ISO-8601 timestamp");
    }
    if (options.requireHumanApproval === true && review.status !== "approved") {
      addIssue(errors, "HUMAN_APPROVAL", "humanReview.status", "must be approved for this gate");
    }
  }

  const scorePassed = Boolean(
    scale && scores.length > 0 && scores.every((score) => Number.isFinite(score.score) && score.score >= scale.passAt),
  );
  const blockingIssues = issues.filter((issue) => issue && ["P0", "P1"].includes(issue.severity));
  const reviewBlocks = review && review.status === "rejected";
  const accepted = scorePassed && blockingIssues.length === 0 && !reviewBlocks;
  if (receipt.passed !== undefined && receipt.passed !== accepted) {
    addIssue(errors, "DERIVED_OUTCOME", "passed", `must equal the derived outcome ${accepted}`);
  }
  if (receipt.receiptSha256 !== undefined && receipt.receiptSha256 !== evaluationReceiptSha256(receipt)) {
    addIssue(errors, "RECEIPT_HASH", "receiptSha256", "does not match the receipt contents");
  }

  return {
    valid: errors.length === 0,
    accepted: errors.length === 0 && accepted,
    errors,
    summary: {
      criterionCount: scores.length,
      evidenceFrameCount: evidenceFrames.length,
      blockingIssueCount: blockingIssues.length,
      humanReviewStatus: review && review.status ? review.status : null,
    },
  };
}

module.exports = {
  EVALUATION_RECEIPT_VERSION,
  CORE_CRITERIA,
  FRAME_RATIOS,
  evaluationReceiptSha256,
  validateEvaluationReceipt,
};

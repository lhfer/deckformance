#!/usr/bin/env node
"use strict";

const STATUS_EXIT_CODE = Object.freeze({ ready: 0, blocked: 1, degraded: 2 });
const SUPPORTED_RELEASES = Object.freeze(["candidate", "final"]);

function statusForChecks(checks) {
  if (checks.some((check) => check.required && check.status === "fail")) return "blocked";
  if (checks.some((check) => check.status === "warn" || check.status === "fail")) return "degraded";
  return "ready";
}

function classifyPreflight(doctorResult, validation) {
  if (!doctorResult) return "blocked";
  if (doctorResult.status === "blocked") return "blocked";
  if (!validation) return "blocked";
  if (validation.ok !== true) return "blocked";
  if (doctorResult.status === "degraded") return "degraded";
  if (Array.isArray(validation.warnings) && validation.warnings.length > 0) return "degraded";
  return "ready";
}

function requireRelease(release) {
  if (!SUPPORTED_RELEASES.includes(release)) throw new Error("release must be candidate or final");
  return release;
}

function exitCodeForStatus(status) {
  if (!Object.hasOwn(STATUS_EXIT_CODE, status)) throw new Error(`unknown release status: ${status}`);
  return STATUS_EXIT_CODE[status];
}

module.exports = {
  STATUS_EXIT_CODE,
  SUPPORTED_RELEASES,
  classifyPreflight,
  exitCodeForStatus,
  requireRelease,
  statusForChecks,
};

#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_POWERPOINT_APP = "/Applications/Microsoft PowerPoint.app";
const POWERPOINT_BUNDLE_IDENTIFIER = "com.microsoft.Powerpoint";
const MICROSOFT_TEAM_IDENTIFIER = "UBF8T346G9";
const SIGNATURE_HASH_PATTERN = /^[A-Fa-f0-9]{20,64}$/;

function issue(errors, code, pointer, message, details = {}) {
  const value = { code, path: pointer, message };
  if (Object.hasOwn(details, "expected")) value.expected = details.expected;
  if (Object.hasOwn(details, "actual")) value.actual = details.actual;
  errors.push(value);
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    do {
      count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count) digest.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest("hex")}`;
}

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 10000,
    windowsHide: true,
  });
}

function normalizeCommandResult(result) {
  if (!result || typeof result !== "object") {
    return { status: null, stdout: "", stderr: "", error: new Error("command runner returned no result") };
  }
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error || null,
  };
}

function run(commandRunner, command, args, label) {
  let result;
  try {
    result = normalizeCommandResult(commandRunner(command, args, { timeout: 10000 }));
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || (result.error && result.error.message) || "unknown command failure").trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function plistValue(commandRunner, infoPath, key) {
  const result = run(
    commandRunner,
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", infoPath],
    `PowerPoint Info.plist ${key}`,
  );
  const value = result.stdout.trim();
  if (!value) throw new Error(`PowerPoint Info.plist ${key} is empty`);
  return value;
}

function parseCodeSignature(text) {
  function one(key) {
    const match = String(text).match(new RegExp(`^${key}=(.+)$`, "m"));
    if (!match || !match[1].trim()) throw new Error(`PowerPoint code signature omitted ${key}`);
    return match[1].trim();
  }

  const authorities = [...String(text).matchAll(/^Authority=(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (!authorities.length) throw new Error("PowerPoint code signature omitted signing authorities");
  return {
    valid: true,
    identifier: one("Identifier"),
    teamIdentifier: one("TeamIdentifier"),
    cdHash: one("CDHash"),
    authorities,
  };
}

function regularNonSymbolicFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularNonSymbolicDirectory(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function collectLivePowerPoint(commandRunner, appPath) {
  const resolvedApp = path.resolve(appPath);
  if (!regularNonSymbolicDirectory(resolvedApp)) {
    const error = new Error(`Microsoft PowerPoint app is missing or not a regular bundle: ${resolvedApp}`);
    error.attestationCode = "POWERPOINT_APP_MISSING";
    throw error;
  }

  const infoPath = path.join(resolvedApp, "Contents", "Info.plist");
  if (!regularNonSymbolicFile(infoPath)) {
    const error = new Error(`PowerPoint Info.plist is missing or symbolic: ${infoPath}`);
    error.attestationCode = "POWERPOINT_APP_MISSING";
    throw error;
  }

  const bundleIdentifier = plistValue(commandRunner, infoPath, "CFBundleIdentifier");
  const shortVersion = plistValue(commandRunner, infoPath, "CFBundleShortVersionString");
  const bundleVersion = plistValue(commandRunner, infoPath, "CFBundleVersion");
  const executableName = plistValue(commandRunner, infoPath, "CFBundleExecutable");
  if (path.basename(executableName) !== executableName || executableName === "." || executableName === "..") {
    throw new Error("PowerPoint CFBundleExecutable must be a single safe file name");
  }
  const executablePath = path.join(resolvedApp, "Contents", "MacOS", executableName);
  if (!regularNonSymbolicFile(executablePath)) {
    const error = new Error(`PowerPoint executable is missing or symbolic: ${executablePath}`);
    error.attestationCode = "POWERPOINT_APP_MISSING";
    throw error;
  }
  const executableRealPath = fs.realpathSync(executablePath);
  const appRealPath = fs.realpathSync(resolvedApp);
  const relativeExecutable = path.relative(appRealPath, executableRealPath);
  if (path.isAbsolute(relativeExecutable) || relativeExecutable === ".." || relativeExecutable.startsWith(`..${path.sep}`)) {
    throw new Error("PowerPoint executable resolves outside the selected app bundle");
  }

  run(
    commandRunner,
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", resolvedApp],
    "PowerPoint code-signature verification",
  );
  const inspection = run(
    commandRunner,
    "/usr/bin/codesign",
    ["-dvvv", "--verbose=4", resolvedApp],
    "PowerPoint code-signature inspection",
  );
  const signature = parseCodeSignature(`${inspection.stdout}\n${inspection.stderr}`);

  const osVersion = run(commandRunner, "/usr/bin/sw_vers", ["-productVersion"], "macOS version inspection").stdout.trim();
  const arch = run(commandRunner, "/usr/bin/uname", ["-m"], "macOS architecture inspection").stdout.trim();
  if (!osVersion || !arch) throw new Error("macOS version and architecture must be non-empty");

  return {
    appPath: resolvedApp,
    powerPointVersion: `${shortVersion} (${bundleVersion})`,
    powerPoint: {
      bundleIdentifier,
      shortVersion,
      bundleVersion,
      executableSha256: sha256File(executableRealPath),
      codeSignature: signature,
    },
    system: { platform: "macos", osVersion, arch },
  };
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function compare(errors, pointer, receiptValue, liveValue) {
  const equal = Array.isArray(liveValue) ? sameArray(receiptValue, liveValue) : receiptValue === liveValue;
  if (!equal) {
    issue(errors, "POWERPOINT_LIVE_DRIFT", pointer, "receipt value does not match the live PowerPoint installation", {
      expected: liveValue,
      actual: receiptValue,
    });
  }
}

function resolveContext(options, errors) {
  const forbidden = ["commandRunner", "platform", "appPath"].filter((key) => Object.hasOwn(options, key));
  if (forbidden.length) {
    issue(
      errors,
      "POWERPOINT_TEST_INJECTION_FORBIDDEN",
      "options",
      `test fixtures must be nested under options.testOnly with enabled: true; forbidden production overrides: ${forbidden.join(", ")}`,
    );
    return null;
  }
  if (options.testOnly !== undefined) {
    if (!options.testOnly || options.testOnly.enabled !== true) {
      issue(errors, "POWERPOINT_TEST_INJECTION_FORBIDDEN", "options.testOnly", "test-only injection requires enabled: true");
      return null;
    }
    const injected = options.testOnly;
    if (typeof injected.commandRunner !== "function" || typeof injected.platform !== "string" || typeof injected.appPath !== "string") {
      issue(errors, "POWERPOINT_TEST_INJECTION_INVALID", "options.testOnly", "test-only injection requires commandRunner, platform, and appPath");
      return null;
    }
    return { commandRunner: injected.commandRunner, platform: injected.platform, appPath: injected.appPath };
  }
  return {
    commandRunner: defaultCommandRunner,
    platform: process.platform,
    appPath: DEFAULT_POWERPOINT_APP,
  };
}

/**
 * Re-attest the PowerPoint identity in a final-release receipt against the live
 * macOS installation. Production callers must not provide path/platform/runner
 * overrides. Tests may opt in through options.testOnly.enabled === true.
 */
function validatePowerPointLiveAttestation(receipt, options = {}) {
  const errors = [];
  const context = resolveContext(options, errors);
  if (!context) return { passed: false, errors, live: null };
  if (context.platform !== "darwin") {
    issue(errors, "POWERPOINT_PLATFORM", "system.platform", "formal final PowerPoint attestation requires a live macOS host", {
      expected: "darwin",
      actual: context.platform,
    });
    return { passed: false, errors, live: null };
  }

  let live;
  try {
    live = collectLivePowerPoint(context.commandRunner, context.appPath);
  } catch (error) {
    issue(
      errors,
      error.attestationCode || "POWERPOINT_LIVE_INSPECTION",
      "powerPointReceipt.powerPoint",
      error.message,
    );
    return { passed: false, errors, live: null };
  }

  if (live.powerPoint.bundleIdentifier !== POWERPOINT_BUNDLE_IDENTIFIER) {
    issue(errors, "POWERPOINT_APP_IDENTITY", "live.powerPoint.bundleIdentifier", "the live bundle is not Microsoft PowerPoint", {
      expected: POWERPOINT_BUNDLE_IDENTIFIER,
      actual: live.powerPoint.bundleIdentifier,
    });
  }
  const signature = live.powerPoint.codeSignature;
  if (signature.identifier !== POWERPOINT_BUNDLE_IDENTIFIER) {
    issue(errors, "POWERPOINT_SIGNATURE_IDENTITY", "live.powerPoint.codeSignature.identifier", "the live signature identifier is not Microsoft PowerPoint", {
      expected: POWERPOINT_BUNDLE_IDENTIFIER,
      actual: signature.identifier,
    });
  }
  if (signature.teamIdentifier !== MICROSOFT_TEAM_IDENTIFIER) {
    issue(errors, "POWERPOINT_SIGNATURE_IDENTITY", "live.powerPoint.codeSignature.teamIdentifier", "the live app is not signed by the Microsoft Office team", {
      expected: MICROSOFT_TEAM_IDENTIFIER,
      actual: signature.teamIdentifier,
    });
  }
  if (!SIGNATURE_HASH_PATTERN.test(signature.cdHash)) {
    issue(errors, "POWERPOINT_SIGNATURE_IDENTITY", "live.powerPoint.codeSignature.cdHash", "the live code signature CDHash is invalid", {
      actual: signature.cdHash,
    });
  }

  const receiptPowerPoint = receipt && receipt.powerPoint;
  const receiptSignature = receiptPowerPoint && receiptPowerPoint.codeSignature;
  compare(errors, "powerPointReceipt.powerPoint.bundleIdentifier", receiptPowerPoint && receiptPowerPoint.bundleIdentifier, live.powerPoint.bundleIdentifier);
  compare(errors, "powerPointReceipt.powerPoint.shortVersion", receiptPowerPoint && receiptPowerPoint.shortVersion, live.powerPoint.shortVersion);
  compare(errors, "powerPointReceipt.powerPoint.bundleVersion", receiptPowerPoint && receiptPowerPoint.bundleVersion, live.powerPoint.bundleVersion);
  compare(errors, "powerPointReceipt.powerPoint.executableSha256", receiptPowerPoint && receiptPowerPoint.executableSha256, live.powerPoint.executableSha256);
  compare(errors, "powerPointReceipt.powerPoint.codeSignature.valid", receiptSignature && receiptSignature.valid, signature.valid);
  compare(errors, "powerPointReceipt.powerPoint.codeSignature.identifier", receiptSignature && receiptSignature.identifier, signature.identifier);
  compare(errors, "powerPointReceipt.powerPoint.codeSignature.teamIdentifier", receiptSignature && receiptSignature.teamIdentifier, signature.teamIdentifier);
  compare(errors, "powerPointReceipt.powerPoint.codeSignature.cdHash", receiptSignature && receiptSignature.cdHash, signature.cdHash);
  compare(errors, "powerPointReceipt.powerPoint.codeSignature.authorities", receiptSignature && receiptSignature.authorities, signature.authorities);
  compare(errors, "powerPointReceipt.powerPointVersion", receipt && receipt.powerPointVersion, live.powerPointVersion);
  compare(errors, "powerPointReceipt.system.platform", receipt && receipt.system && receipt.system.platform, live.system.platform);
  compare(errors, "powerPointReceipt.system.osVersion", receipt && receipt.system && receipt.system.osVersion, live.system.osVersion);
  compare(errors, "powerPointReceipt.system.arch", receipt && receipt.system && receipt.system.arch, live.system.arch);

  return { passed: errors.length === 0, errors, live };
}

class PowerPointLiveAttestationError extends Error {
  constructor(result) {
    super(`PowerPoint live attestation failed:\n- ${result.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join("\n- ")}`);
    this.name = "PowerPointLiveAttestationError";
    this.code = "POWERPOINT_LIVE_ATTESTATION_FAILED";
    this.errors = result.errors;
    this.live = result.live;
  }
}

function assertPowerPointLiveAttestation(receipt, options = {}) {
  const result = validatePowerPointLiveAttestation(receipt, options);
  if (!result.passed) throw new PowerPointLiveAttestationError(result);
  return result;
}

module.exports = {
  DEFAULT_POWERPOINT_APP,
  MICROSOFT_TEAM_IDENTIFIER,
  POWERPOINT_BUNDLE_IDENTIFIER,
  PowerPointLiveAttestationError,
  assertPowerPointLiveAttestation,
  parseCodeSignature,
  validatePowerPointLiveAttestation,
};

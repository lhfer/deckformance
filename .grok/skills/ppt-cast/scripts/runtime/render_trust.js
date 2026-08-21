#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const POLICY_SCHEMA = "deckformance.renderer-trust-policy/1";
const DEFAULT_POLICY_ID = "deckformance.renderer-trust.default.v1";
const DEFAULT_POLICY_PATH = path.resolve(__dirname, "..", "..", "references", "renderer-trust-policy.json");
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,126}[A-Za-z0-9])?$/;

class RendererTrustError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RendererTrustError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RendererTrustError(code, message);
}

function parseJsonStrict(sourceText, source = "renderer trust policy") {
  const text = String(sourceText);
  let cursor = 0;

  function syntax(message) {
    fail("POLICY_JSON_INVALID", `${source}: ${message} at byte ${Buffer.byteLength(text.slice(0, cursor), "utf8")}`);
  }

  function whitespace() {
    while (cursor < text.length && /[\u0020\u000a\u000d\u0009]/.test(text[cursor])) cursor += 1;
  }

  function stringValue() {
    if (text[cursor] !== '"') syntax("expected a JSON string");
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(text.slice(start, cursor));
        } catch (error) {
          syntax(`invalid JSON string (${error.message})`);
        }
      }
      if (character === "\\") {
        cursor += 2;
      } else {
        cursor += 1;
      }
    }
    syntax("unterminated JSON string");
  }

  function arrayValue() {
    cursor += 1;
    whitespace();
    const result = [];
    if (text[cursor] === "]") {
      cursor += 1;
      return result;
    }
    while (cursor < text.length) {
      result.push(value());
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return result;
      }
      if (text[cursor] !== ",") syntax("expected ',' or ']' in array");
      cursor += 1;
      whitespace();
    }
    syntax("unterminated JSON array");
  }

  function objectValue() {
    cursor += 1;
    whitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (text[cursor] === "}") {
      cursor += 1;
      return result;
    }
    while (cursor < text.length) {
      const key = stringValue();
      if (keys.has(key)) fail("POLICY_DUPLICATE_KEY", `${source}: duplicate JSON key '${key}'`);
      keys.add(key);
      whitespace();
      if (text[cursor] !== ":") syntax("expected ':' after object key");
      cursor += 1;
      result[key] = value();
      whitespace();
      if (text[cursor] === "}") {
        cursor += 1;
        return result;
      }
      if (text[cursor] !== ",") syntax("expected ',' or '}' in object");
      cursor += 1;
      whitespace();
    }
    syntax("unterminated JSON object");
  }

  function value() {
    whitespace();
    const character = text[cursor];
    if (character === '"') return stringValue();
    if (character === "{") return objectValue();
    if (character === "[") return arrayValue();
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return parsed;
      }
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (number) {
      cursor += number[0].length;
      return Number(number[0]);
    }
    syntax("expected a JSON value");
  }

  const parsed = value();
  whitespace();
  if (cursor !== text.length) syntax("unexpected trailing content");
  return parsed;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, pointer) {
  if (!plainObject(value)) fail("POLICY_SHAPE_INVALID", `${pointer} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("POLICY_SHAPE_INVALID", `${pointer} must contain exactly: ${expected.join(", ")}`);
  }
}

function validateString(value, pattern, pointer) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("POLICY_VALUE_INVALID", `${pointer} is invalid`);
  }
  return value;
}

function normalizeHelper(value, pointer) {
  exactKeys(value, ["name", "version", "sha256"], pointer);
  return {
    name: validateString(value.name, NAME_PATTERN, `${pointer}.name`),
    version: validateString(value.version, VERSION_PATTERN, `${pointer}.version`),
    sha256: validateString(value.sha256, HASH_PATTERN, `${pointer}.sha256`),
  };
}

function helperFingerprint(value) {
  return `${value.name}\u0000${value.version}\u0000${value.sha256}`;
}

function adapterFingerprint(value) {
  return `${helperFingerprint(value.renderer)}\u0001${helperFingerprint(value.slidesTest)}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateRendererTrustPolicy(value) {
  exactKeys(value, ["schema", "policyId", "approvedAdapters"], "policy");
  if (value.schema !== POLICY_SCHEMA) {
    fail("POLICY_SCHEMA_INVALID", `policy.schema must be '${POLICY_SCHEMA}'`);
  }
  validateString(value.policyId, ID_PATTERN, "policy.policyId");
  if (value.policyId !== DEFAULT_POLICY_ID) {
    fail("POLICY_ID_INVALID", `policy.policyId must be '${DEFAULT_POLICY_ID}'`);
  }
  if (!Array.isArray(value.approvedAdapters)) {
    fail("POLICY_SHAPE_INVALID", "policy.approvedAdapters must be an array");
  }

  const ids = new Set();
  const fingerprints = new Set();
  const approvedAdapters = value.approvedAdapters.map((adapter, index) => {
    const pointer = `policy.approvedAdapters[${index}]`;
    exactKeys(adapter, ["id", "renderer", "slidesTest"], pointer);
    const normalized = {
      id: validateString(adapter.id, ID_PATTERN, `${pointer}.id`),
      renderer: normalizeHelper(adapter.renderer, `${pointer}.renderer`),
      slidesTest: normalizeHelper(adapter.slidesTest, `${pointer}.slidesTest`),
    };
    if (ids.has(normalized.id)) fail("POLICY_DUPLICATE_ADAPTER", `${pointer}.id duplicates '${normalized.id}'`);
    ids.add(normalized.id);
    const fingerprint = adapterFingerprint(normalized);
    if (fingerprints.has(fingerprint)) fail("POLICY_DUPLICATE_ADAPTER", `${pointer} duplicates an approved renderer/slides-test pair`);
    fingerprints.add(fingerprint);
    if (helperFingerprint(normalized.renderer) === helperFingerprint(normalized.slidesTest)) {
      fail("POLICY_DUPLICATE_HELPER", `${pointer} must approve two distinct helper implementations`);
    }
    return normalized;
  });

  return deepFreeze({
    schema: POLICY_SCHEMA,
    policyId: value.policyId,
    approvedAdapters,
  });
}

function loadRendererTrustPolicy(policyPath = DEFAULT_POLICY_PATH) {
  if (typeof policyPath !== "string" || !policyPath.trim()) {
    fail("POLICY_PATH_INVALID", "renderer trust policy path must be a non-empty string");
  }
  const absolute = path.resolve(policyPath);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    fail("POLICY_READ_FAILED", `cannot read renderer trust policy ${absolute}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("POLICY_PATH_INVALID", `renderer trust policy must be a regular non-symbolic file: ${absolute}`);
  }
  let parsed;
  try {
    parsed = parseJsonStrict(fs.readFileSync(absolute, "utf8"), absolute);
  } catch (error) {
    if (error instanceof RendererTrustError) throw error;
    fail("POLICY_READ_FAILED", `cannot read renderer trust policy ${absolute}: ${error.message}`);
  }
  return validateRendererTrustPolicy(parsed);
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

function inspectLiveHelper(value, pointer) {
  if (!plainObject(value)) fail("LIVE_HELPER_INVALID", `${pointer} must be an object`);
  const helperPath = value.path;
  if (typeof helperPath !== "string" || !path.isAbsolute(helperPath)) {
    fail("LIVE_PATH_INVALID", `${pointer}.path must be absolute`);
  }
  const name = validateString(value.name, NAME_PATTERN, `${pointer}.name`);
  const version = validateString(value.version, VERSION_PATTERN, `${pointer}.version`);
  let stat;
  try {
    stat = fs.lstatSync(helperPath);
  } catch (error) {
    fail("LIVE_PATH_INVALID", `${pointer}.path cannot be read: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("LIVE_PATH_INVALID", `${pointer}.path must be a regular non-symbolic file`);
  }
  const realPath = fs.realpathSync(helperPath);
  if (path.basename(realPath) !== name || path.basename(helperPath) !== name) {
    fail("LIVE_NAME_DRIFT", `${pointer}.name '${name}' does not match the live path basename`);
  }
  return {
    path: realPath,
    name,
    version,
    sha256: sha256File(realPath),
  };
}

function resolvePolicy(options) {
  if (options.policy !== undefined && options.policyPath !== undefined) {
    fail("POLICY_SOURCE_AMBIGUOUS", "provide policy or policyPath, not both");
  }
  if (options.policy !== undefined) {
    return validateRendererTrustPolicy(options.policy);
  }
  return loadRendererTrustPolicy(options.policyPath || DEFAULT_POLICY_PATH);
}

/**
 * Hashes both live helper files and requires their names, versions, and hashes
 * to match one exact approved adapter in the selected policy.
 */
function verifyTrustedRendererPair(value, options = {}) {
  if (!plainObject(value)) fail("LIVE_PAIR_INVALID", "renderer trust input must be an object");
  const policy = resolvePolicy(options);
  const renderer = inspectLiveHelper(value.renderer, "renderer");
  const slidesTest = inspectLiveHelper(value.slidesTest, "slidesTest");
  const fingerprint = adapterFingerprint({ renderer, slidesTest });
  const adapter = policy.approvedAdapters.find((candidate) => adapterFingerprint(candidate) === fingerprint);
  if (!adapter) {
    fail(
      "RENDERER_NOT_APPROVED",
      `live renderer pair is not approved by policy '${policy.policyId}' (renderer ${renderer.name}@${renderer.version} ${renderer.sha256}; slidesTest ${slidesTest.name}@${slidesTest.version} ${slidesTest.sha256})`,
    );
  }
  return deepFreeze({
    trusted: true,
    policyId: policy.policyId,
    policySha256: `sha256:${crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
    adapterId: adapter.id,
    renderer,
    slidesTest,
  });
}

module.exports = {
  DEFAULT_POLICY_ID,
  DEFAULT_POLICY_PATH,
  HASH_PATTERN,
  POLICY_SCHEMA,
  RendererTrustError,
  loadRendererTrustPolicy,
  parseJsonStrict,
  sha256File,
  validateRendererTrustPolicy,
  verifyTrustedRendererPair,
};

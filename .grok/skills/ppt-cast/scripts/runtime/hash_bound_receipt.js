#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_VERSION = 1;

function sha256Buffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
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

function stableValue(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("receipt values must contain only finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => stableValue(item, stack));
  if (typeof value !== "object") throw new TypeError(`unsupported receipt value: ${typeof value}`);
  if (stack.has(value)) throw new TypeError("receipt values must not contain cycles");
  stack.add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = stableValue(value[key], stack);
  }
  stack.delete(value);
  return normalized;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function safeRelativePath(root, relativePath, options = {}) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("receipt file paths must be non-empty job-relative POSIX paths");
  }
  const value = relativePath.trim();
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe receipt file path: ${relativePath}`);
  }
  const rootPath = path.resolve(root);
  const candidate = path.resolve(rootPath, ...value.split("/"));
  if (!isInside(rootPath, candidate)) throw new Error(`receipt file escapes root: ${relativePath}`);
  if (options.mustExist !== false) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`receipt input must be a regular non-symbolic file: ${relativePath}`);
    }
    const realRoot = fs.realpathSync(rootPath);
    const realFile = fs.realpathSync(candidate);
    if (!isInside(realRoot, realFile)) throw new Error(`receipt file resolves outside root: ${relativePath}`);
    return realFile;
  }
  const realRoot = fs.realpathSync(rootPath);
  let cursor = rootPath;
  for (const segment of value.split("/").slice(0, -1)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`receipt output parent is symbolic: ${relativePath}`);
    const realParent = fs.realpathSync(cursor);
    if (!isInside(realRoot, realParent)) throw new Error(`receipt output parent resolves outside root: ${relativePath}`);
  }
  return candidate;
}

function fileDescriptor(root, relativePath) {
  const filePath = safeRelativePath(root, relativePath);
  const stat = fs.statSync(filePath);
  return {
    path: relativePath,
    sha256: sha256File(filePath),
    bytes: stat.size,
  };
}

function normalizeFiles(root, items) {
  if (!Array.isArray(items)) throw new TypeError("receipt inputs and outputs must be arrays");
  const seen = new Set();
  return items.map((item) => {
    const descriptor = typeof item === "string" ? fileDescriptor(root, item) : { ...item };
    if (!descriptor || typeof descriptor.path !== "string") throw new TypeError("receipt file descriptor needs path");
    const actual = fileDescriptor(root, descriptor.path);
    if (descriptor.sha256 && descriptor.sha256 !== actual.sha256) {
      throw new Error(`declared hash does not match ${descriptor.path}`);
    }
    if (descriptor.bytes !== undefined && Number(descriptor.bytes) !== actual.bytes) {
      throw new Error(`declared byte count does not match ${descriptor.path}`);
    }
    if (seen.has(descriptor.path)) throw new Error(`duplicate receipt file path: ${descriptor.path}`);
    seen.add(descriptor.path);
    return actual;
  });
}

function implementationHash(root, implementationFiles) {
  const files = normalizeFiles(root, implementationFiles);
  return {
    files,
    sha256: sha256Buffer(stableJson(files)),
  };
}

function createHashBoundReceipt(options) {
  const root = path.resolve(options.root);
  const kind = String(options.kind || "").trim();
  if (!kind) throw new Error("receipt kind is required");
  const producer = options.producer || {};
  if (!producer.name || !producer.version) throw new Error("receipt producer name and version are required");
  const implementation = implementationHash(root, options.implementationFiles || []);
  const unsigned = {
    receiptVersion: RECEIPT_VERSION,
    kind,
    producer: {
      name: String(producer.name),
      version: String(producer.version),
      implementationSha256: implementation.sha256,
      implementationFiles: implementation.files,
    },
    runtime: options.runtime || {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    inputs: normalizeFiles(root, options.inputs || []),
    outputs: normalizeFiles(root, options.outputs || []),
    metadata: options.metadata || {},
    createdAt: options.createdAt || new Date().toISOString(),
  };
  return { ...unsigned, receiptSha256: sha256Buffer(stableJson(unsigned)) };
}

function verifyHashBoundReceipt(root, receipt) {
  const errors = [];
  if (!receipt || receipt.receiptVersion !== RECEIPT_VERSION) errors.push("unsupported receiptVersion");
  if (!receipt || !receipt.producer || !HASH_PATTERN.test(String(receipt.producer.implementationSha256 || ""))) {
    errors.push("producer implementation hash is missing or invalid");
  } else {
    try {
      const implementation = implementationHash(root, receipt.producer.implementationFiles || []);
      if (implementation.sha256 !== receipt.producer.implementationSha256) errors.push("producer implementation hash drift");
    } catch (error) {
      errors.push(`producer implementation hash drift: ${error.message}`);
    }
  }
  if (!receipt || !HASH_PATTERN.test(String(receipt.receiptSha256 || ""))) {
    errors.push("receiptSha256 is missing or invalid");
  } else {
    const { receiptSha256, ...unsigned } = receipt;
    if (sha256Buffer(stableJson(unsigned)) !== receiptSha256) errors.push("receiptSha256 does not match receipt contents");
  }
  for (const group of ["inputs", "outputs"]) {
    for (const descriptor of (receipt && receipt[group]) || []) {
      try {
        const actual = fileDescriptor(root, descriptor.path);
        if (actual.sha256 !== descriptor.sha256) errors.push(`${group}.${descriptor.path} hash drift`);
        if (actual.bytes !== descriptor.bytes) errors.push(`${group}.${descriptor.path} byte-count drift`);
      } catch (error) {
        errors.push(`${group}.${descriptor.path}: ${error.message}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function writeReceiptAtomic(root, relativePath, receipt, options = {}) {
  const output = safeRelativePath(root, relativePath, { mustExist: false });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output) && options.overwrite !== true) throw new Error(`refusing to overwrite receipt: ${relativePath}`);
  const temp = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, output);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return output;
}

module.exports = {
  HASH_PATTERN,
  RECEIPT_VERSION,
  createHashBoundReceipt,
  fileDescriptor,
  implementationHash,
  safeRelativePath,
  sha256Buffer,
  sha256File,
  stableJson,
  verifyHashBoundReceipt,
  writeReceiptAtomic,
};

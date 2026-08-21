"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const SCRIPTS = path.resolve(__dirname, "..", ".grok", "skills", "ppt-cast", "scripts");
const {
  createHashBoundReceipt,
  fileDescriptor,
  implementationHash,
  safeRelativePath,
  sha256Buffer,
  sha256File,
  stableJson,
  verifyHashBoundReceipt,
  writeReceiptAtomic,
} = require(path.join(SCRIPTS, "runtime", "hash_bound_receipt"));
const {
  classifyPreflight,
  exitCodeForStatus,
  requireRelease,
  statusForChecks,
} = require(path.join(SCRIPTS, "runtime", "release_gate"));

let tempRoot;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-core-release-"));
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeRoot(name) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function write(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function makeReceiptRoot(name = "receipt") {
  const root = makeRoot(name);
  write(root, "implementation/producer.js", "module.exports = 'producer';\n");
  write(root, "inputs/brief.json", "{\"brief\":true}\n");
  write(root, "outputs/candidate.bin", Buffer.from("candidate bytes"));
  return root;
}

function createFixtureReceipt(root, overrides = {}) {
  return createHashBoundReceipt({
    root,
    kind: "release-evidence",
    producer: { name: "fixture-producer", version: "2.0.0" },
    implementationFiles: ["implementation/producer.js"],
    inputs: ["inputs/brief.json"],
    outputs: ["outputs/candidate.bin"],
    runtime: { node: "v22.0.0", platform: "fixture", arch: "fixture" },
    metadata: { gate: "candidate" },
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  });
}

test("stable hashing is deterministic for buffers, large files, arrays, and sorted objects", () => {
  assert.equal(sha256Buffer(Buffer.from("same")), sha256Buffer("same"));
  assert.equal(stableJson({ z: 1, a: [true, null, "x"], omitted: undefined }), '{"a":[true,null,"x"],"z":1}');
  assert.equal(stableJson(7), "7");

  const root = makeRoot("large-file");
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  const file = write(root, "large.bin", bytes);
  assert.equal(sha256File(file), sha256Buffer(bytes));

  assert.throws(() => stableJson(Number.POSITIVE_INFINITY), /finite numbers/);
  assert.throws(() => stableJson(undefined), /unsupported receipt value/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableJson(cyclic), /must not contain cycles/);
});

test("job-relative artifact paths reject traversal, ambiguous segments, non-files, and symlink escapes", (t) => {
  const root = makeRoot("safe-paths");
  write(root, "inside/file.txt", "inside");
  fs.mkdirSync(path.join(root, "directory"));
  assert.equal(safeRelativePath(root, "inside/file.txt"), fs.realpathSync(path.join(root, "inside", "file.txt")));
  assert.equal(safeRelativePath(root, "new/output.json", { mustExist: false }), path.join(root, "new", "output.json"));

  for (const unsafe of [null, "", "   ", "/absolute", "C:\\absolute", "back\\slash", "a//b", "a/./b", "a/../b"]) {
    assert.throws(() => safeRelativePath(root, unsafe), /non-empty|unsafe/);
  }
  assert.throws(() => safeRelativePath(root, "directory"), /regular non-symbolic file/);

  const outside = makeRoot("outside-paths");
  write(outside, "evidence.txt", "outside");
  const directLink = path.join(root, "direct-link");
  const nestedLink = path.join(root, "linked-directory");
  try {
    fs.symlinkSync(path.join(outside, "evidence.txt"), directLink);
    fs.symlinkSync(outside, nestedLink, "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => safeRelativePath(root, "direct-link"), /regular non-symbolic file/);
  assert.throws(() => safeRelativePath(root, "linked-directory/evidence.txt"), /resolves outside root/);
  assert.throws(() => safeRelativePath(root, "linked-directory/new.json", { mustExist: false }), /output parent is symbolic|outside root/);
});

test("artifact descriptors verify declared hashes and byte counts and reject ambiguous evidence sets", () => {
  const root = makeReceiptRoot("descriptors");
  const descriptor = fileDescriptor(root, "inputs/brief.json");
  assert.equal(descriptor.path, "inputs/brief.json");
  assert.equal(descriptor.bytes, fs.statSync(path.join(root, "inputs", "brief.json")).size);

  const declared = { ...descriptor };
  const result = implementationHash(root, [declared]);
  assert.deepEqual(result.files, [descriptor]);
  assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);

  assert.throws(() => implementationHash(root, null), /must be arrays/);
  assert.throws(() => implementationHash(root, [{}]), /needs path/);
  assert.throws(() => implementationHash(root, [{ ...descriptor, sha256: sha256Buffer("wrong") }]), /declared hash/);
  assert.throws(() => implementationHash(root, [{ ...descriptor, bytes: descriptor.bytes + 1 }]), /declared byte count/);
  assert.throws(() => implementationHash(root, [descriptor.path, descriptor.path]), /duplicate receipt file path/);
});

test("receipt creation enforces producer identity and supports explicit and default runtime metadata", () => {
  const root = makeReceiptRoot("receipt-create");
  const explicit = createFixtureReceipt(root);
  assert.equal(explicit.kind, "release-evidence");
  assert.deepEqual(explicit.runtime, { node: "v22.0.0", platform: "fixture", arch: "fixture" });
  assert.equal(verifyHashBoundReceipt(root, explicit).ok, true);

  const defaults = createHashBoundReceipt({
    root,
    kind: "runtime",
    producer: { name: "fixture", version: "1" },
  });
  assert.equal(defaults.runtime.node, process.version);
  assert.deepEqual(defaults.inputs, []);
  assert.deepEqual(defaults.outputs, []);
  assert.deepEqual(defaults.metadata, {});
  assert.match(defaults.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.throws(() => createHashBoundReceipt({ root, producer: { name: "x", version: "1" } }), /kind is required/);
  assert.throws(() => createHashBoundReceipt({ root, kind: "x" }), /producer name and version/);
  assert.throws(() => createHashBoundReceipt({ root, kind: "x", producer: { name: "x" } }), /producer name and version/);
  assert.throws(() => createHashBoundReceipt({ root, kind: "x", producer: { version: "1" } }), /producer name and version/);
});

test("receipt verification reports identity, signature, implementation, and artifact drift independently", () => {
  const root = makeReceiptRoot("receipt-verify");
  const receipt = createFixtureReceipt(root);
  assert.deepEqual(verifyHashBoundReceipt(root, receipt), { ok: true, errors: [] });

  const missing = verifyHashBoundReceipt(root, null);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /receiptVersion|implementation hash|receiptSha256/);

  const badIdentity = structuredClone(receipt);
  badIdentity.receiptVersion = 9;
  badIdentity.producer.implementationSha256 = "not-a-hash";
  badIdentity.receiptSha256 = "not-a-hash";
  assert.match(verifyHashBoundReceipt(root, badIdentity).errors.join("\n"), /receiptVersion|implementation hash|receiptSha256/);

  const missingImplementation = structuredClone(receipt);
  missingImplementation.producer.implementationFiles[0].path = "implementation/missing.js";
  assert.match(verifyHashBoundReceipt(root, missingImplementation).errors.join("\n"), /implementation hash drift/);

  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.metadata.gate = "final";
  assert.match(verifyHashBoundReceipt(root, tamperedReceipt).errors.join("\n"), /receiptSha256 does not match/);

  fs.writeFileSync(path.join(root, "implementation", "producer.js"), "changed implementation\n");
  assert.match(verifyHashBoundReceipt(root, receipt).errors.join("\n"), /implementation hash drift/);
  fs.writeFileSync(path.join(root, "inputs", "brief.json"), "changed input with different length\n");
  fs.unlinkSync(path.join(root, "outputs", "candidate.bin"));
  const artifactDrift = verifyHashBoundReceipt(root, receipt);
  assert.match(artifactDrift.errors.join("\n"), /inputs\.inputs\/brief\.json hash drift/);
  assert.match(artifactDrift.errors.join("\n"), /byte-count drift/);
  assert.match(artifactDrift.errors.join("\n"), /outputs\.outputs\/candidate\.bin/);
});

test("atomic receipt writes refuse overwrite by default, allow explicit replacement, and clean failed temporaries", (t) => {
  const root = makeReceiptRoot("receipt-write");
  const receipt = createFixtureReceipt(root);
  const relativePath = "qa/release-receipt.json";
  const output = writeReceiptAtomic(root, relativePath, receipt);
  assert.equal(output, path.join(root, "qa", "release-receipt.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), receipt);
  assert.throws(() => writeReceiptAtomic(root, relativePath, receipt), /refusing to overwrite/);
  assert.equal(writeReceiptAtomic(root, relativePath, receipt, { overwrite: true }), output);

  const originalRename = fs.renameSync;
  t.after(() => { fs.renameSync = originalRename; });
  fs.renameSync = () => { throw new Error("fixture rename failure"); };
  assert.throws(() => writeReceiptAtomic(root, "qa/failing-receipt.json", receipt), /fixture rename failure/);
  fs.renameSync = originalRename;
  const leftovers = fs.readdirSync(path.join(root, "qa")).filter((name) => name.includes("failing-receipt"));
  assert.deepEqual(leftovers, []);
});

test("release policy blocks required failures and preserves candidate/final and status exit contracts", () => {
  const pass = { required: true, status: "pass" };
  const requiredFail = { required: true, status: "fail" };
  const optionalFail = { required: false, status: "fail" };
  const warning = { required: false, status: "warn" };
  assert.equal(statusForChecks([]), "ready");
  assert.equal(statusForChecks([pass]), "ready");
  assert.equal(statusForChecks([pass, warning]), "degraded");
  assert.equal(statusForChecks([pass, optionalFail]), "degraded");
  assert.equal(statusForChecks([pass, requiredFail]), "blocked");

  const valid = { ok: true, warnings: [] };
  assert.equal(classifyPreflight({ status: "ready" }, valid), "ready");
  assert.equal(classifyPreflight({ status: "ready" }, { ...valid, warnings: ["review"] }), "degraded");
  assert.equal(classifyPreflight({ status: "degraded" }, valid), "degraded");
  assert.equal(classifyPreflight({ status: "blocked" }, valid), "blocked");
  assert.equal(classifyPreflight(null, valid), "blocked");
  assert.equal(classifyPreflight({ status: "ready" }, null), "blocked");
  assert.equal(classifyPreflight({ status: "ready" }, { ok: false }), "blocked");

  assert.equal(requireRelease("candidate"), "candidate");
  assert.equal(requireRelease("final"), "final");
  assert.throws(() => requireRelease("draft"), /candidate or final/);
  assert.deepEqual(["ready", "blocked", "degraded"].map(exitCodeForStatus), [0, 1, 2]);
  assert.throws(() => exitCodeForStatus("unknown"), /unknown release status/);
});

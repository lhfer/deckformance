"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts", "visual_regression.py");
const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const ONE_HASH = `sha256:${"1".repeat(64)}`;

function sha256(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function expectedReceiptHash(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receiptSha256;
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(stable(unsigned))).digest("hex")}`;
}

function writePng(filePath, color) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const run = spawnSync("python3", [
    "-c",
    "from PIL import Image; import sys; Image.new('RGB',(64,48),tuple(map(int,sys.argv[2].split(',')))).save(sys.argv[1],'PNG')",
    filePath,
    color.join(","),
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

function writeExecutable(filePath) {
  fs.writeFileSync(filePath, `#!/usr/bin/env python3
import os, sys
if "--version" in sys.argv:
    print("fake-tesseract 1.2.3")
else:
    print(os.environ.get("FAKE_OCR_TEXT", "Deckformance"))
`, { mode: 0o700 });
}

function renderIndex(artifactPath, artifactSha256, slidePath, slideSha256, overflowPassed = true) {
  return {
    version: 2,
    producer: "ppt-cast/render-pptx-qa@2",
    producerSha256: ZERO_HASH,
    artifactPath,
    artifactSha256,
    slideCount: 1,
    overflowPassed,
    renderedSlides: [
      {
        slideNumber: 1,
        path: slidePath,
        sha256: slideSha256,
        width: 64,
        height: 48,
        mime: "image/png",
      },
    ],
    renderer: { name: "render_slides.py", version: "fixture-renderer-1", sha256: ONE_HASH },
    slidesTest: { name: "slides_test.py", version: "fixture-checker-1", sha256: ZERO_HASH },
    runtime: { python: { implementation: "cpython", version: "3.12.0", executable: "python3" } },
  };
}

function writeIndex(item, kind, options = {}) {
  const artifactRelative = `${kind}.pptx`;
  const slideRelative = `qa/${kind}/slide-1.png`;
  const indexRelative = `qa/${kind}/render-index.json`;
  const index = renderIndex(
    artifactRelative,
    sha256(path.join(item.root, artifactRelative)),
    slideRelative,
    sha256(path.join(item.root, slideRelative)),
    options.overflowPassed !== false,
  );
  fs.writeFileSync(path.join(item.root, indexRelative), `${JSON.stringify(index, null, 2)}\n`);
  return indexRelative;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-visual-regression-"));
  fs.writeFileSync(path.join(root, "baseline.pptx"), "baseline package");
  fs.writeFileSync(path.join(root, "current.pptx"), "current package");
  writePng(path.join(root, "qa/baseline/slide-1.png"), options.baselineColor || [10, 20, 30]);
  writePng(path.join(root, "qa/current/slide-1.png"), options.currentColor || [10, 20, 30]);
  const item = { root };
  item.baselineIndex = writeIndex(item, "baseline");
  item.currentIndex = writeIndex(item, "current", { overflowPassed: options.overflowPassed });
  item.expectedText = "qa/expected-text.json";
  fs.writeFileSync(path.join(root, item.expectedText), `${JSON.stringify({
    schemaVersion: "1.0.0",
    slides: [{ slideNumber: 1, expectedText: options.expectedText || "Deck formance" }],
  }, null, 2)}\n`);
  item.ocr = path.join(root, "fake-tesseract.py");
  writeExecutable(item.ocr);
  return item;
}

function runGate(item, output, options = {}) {
  const args = [
    SCRIPT,
    item.root,
    "--baseline-index", item.baselineIndex,
    "--current-index", item.currentIndex,
    "--expected-text", item.expectedText,
    "--ocr-command", options.ocrCommand || item.ocr,
    "--ocr-language", "eng",
    "--output", output,
  ];
  if (options.approvedChange) args.push("--approved-change");
  return spawnSync("python3", args, {
    encoding: "utf8",
    env: { ...process.env, FAKE_OCR_TEXT: options.ocrText || "Deckformance" },
  });
}

test("identical fixed renders pass SSIM, exact normalized OCR, and a self-hashed receipt", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const output = "qa/visual-regression-pass.json";
  const run = runGate(item, output);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, output), "utf8"));
  assert.equal(receipt.receiptType, "deckformance-visual-regression");
  assert.equal(receipt.producer.id, "ppt-cast/visual-regression@1");
  assert.match(receipt.producer.implementationSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.policy.ssim.algorithm, "windowed-luma-ssim-16px-population-v1");
  assert.equal(receipt.policy.ssim.threshold, 0.995);
  assert.equal(receipt.ocrEngine.version, "fake-tesseract 1.2.3");
  assert.match(receipt.ocrEngine.executableSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.slides[0].ssim.mean, 1);
  assert.equal(receipt.slides[0].ocr.matches, true);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.receiptSha256, expectedReceiptHash(receipt));
});

test("unapproved pixel drift produces a bound failing receipt", (t) => {
  const item = fixture({ baselineColor: [0, 0, 0], currentColor: [255, 255, 255] });
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const output = "qa/visual-regression-drift.json";
  const run = runGate(item, output);
  assert.equal(run.status, 2, run.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, output), "utf8"));
  assert.equal(receipt.passed, false);
  assert.ok(receipt.slides[0].ssim.mean < 0.995);
  assert.ok(receipt.issues.some((issue) => issue.code === "SSIM_BELOW_THRESHOLD"));
  assert.equal(receipt.receiptSha256, expectedReceiptHash(receipt));
});

test("hash drift and overflow evidence fail closed before publication", async (t) => {
  await t.test("rendered PNG hash drift", (t2) => {
    const item = fixture();
    t2.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    writePng(path.join(item.root, "qa/current/slide-1.png"), [200, 20, 30]);
    const output = "qa/hash-drift.json";
    const run = runGate(item, output);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /image hash drift/);
    assert.equal(fs.existsSync(path.join(item.root, output)), false);
  });

  await t.test("overflow did not pass", (t2) => {
    const item = fixture({ overflowPassed: false });
    t2.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const output = "qa/overflow.json";
    const run = runGate(item, output);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /did not pass overflow checking/);
    assert.equal(fs.existsSync(path.join(item.root, output)), false);
  });
});

test("OCR mismatch and a missing OCR executable both reject", async (t) => {
  await t.test("OCR mismatch is recorded in a failing receipt", (t2) => {
    const item = fixture();
    t2.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const output = "qa/ocr-mismatch.json";
    const run = runGate(item, output, { ocrText: "Deck failure" });
    assert.equal(run.status, 2, run.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(item.root, output), "utf8"));
    assert.equal(receipt.slides[0].ocr.matches, false);
    assert.ok(receipt.issues.some((issue) => issue.code === "OCR_MISMATCH"));
    assert.equal(receipt.passed, false);
  });

  await t.test("missing OCR fails before a receipt can claim evaluation", (t2) => {
    const item = fixture();
    t2.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const output = "qa/missing-ocr.json";
    const run = runGate(item, output, { ocrCommand: path.join(item.root, "missing-tesseract") });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /OCR executable is missing/);
    assert.equal(fs.existsSync(path.join(item.root, output)), false);
  });
});

test("approved change waives only SSIM and still requires exact OCR", (t) => {
  const accepted = fixture({ baselineColor: [0, 0, 0], currentColor: [255, 255, 255] });
  t.after(() => fs.rmSync(accepted.root, { recursive: true, force: true }));
  const acceptedOutput = "qa/approved-change.json";
  const pass = runGate(accepted, acceptedOutput, { approvedChange: true });
  assert.equal(pass.status, 0, pass.stderr);
  const passReceipt = JSON.parse(fs.readFileSync(path.join(accepted.root, acceptedOutput), "utf8"));
  assert.equal(passReceipt.policy.approvedChange, true);
  assert.equal(passReceipt.summary.ssimFailureCount, 1);
  assert.equal(passReceipt.summary.ocrFailureCount, 0);
  assert.equal(passReceipt.passed, true);

  const rejected = fixture({ baselineColor: [0, 0, 0], currentColor: [255, 255, 255] });
  t.after(() => fs.rmSync(rejected.root, { recursive: true, force: true }));
  const rejectedOutput = "qa/approved-change-ocr-fail.json";
  const fail = runGate(rejected, rejectedOutput, { approvedChange: true, ocrText: "Wrong" });
  assert.equal(fail.status, 2, fail.stderr);
  const failReceipt = JSON.parse(fs.readFileSync(path.join(rejected.root, rejectedOutput), "utf8"));
  assert.equal(failReceipt.summary.ssimFailureCount, 1);
  assert.equal(failReceipt.summary.ocrFailureCount, 1);
  assert.equal(failReceipt.passed, false);
});

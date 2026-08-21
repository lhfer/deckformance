"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts", "render_pptx_qa.py");
const JSZip = require(path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts", "node_modules", "jszip"));

function writeTool(filePath, body) {
  fs.writeFileSync(filePath, `#!/usr/bin/env python3\n${body}\n`, { mode: 0o700 });
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-render-"));
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<p:sld/>");
  zip.file("ppt/slides/slide2.xml", "<p:sld/>");
  fs.writeFileSync(path.join(root, "candidate.pptx"), await zip.generateAsync({ type: "nodebuffer" }));
  const renderer = path.join(root, "renderer.py");
  writeTool(renderer, String.raw`
import argparse, os
from PIL import Image
p = argparse.ArgumentParser()
p.add_argument("input")
p.add_argument("--output_dir", required=True)
p.add_argument("--width")
p.add_argument("--height")
a = p.parse_args()
os.makedirs(a.output_dir, exist_ok=True)
for n in (1, 2):
    Image.new("RGB", (1920, 1080), (20 * n, 40, 60)).save(os.path.join(a.output_dir, f"slide-{n}.png"), "PNG")
`);
  const checker = path.join(root, "slides_test.py");
  writeTool(checker, "print('Test passed. No overflow detected.')");
  return { root, renderer, checker };
}

test("actual-PPTX render evidence binds every slide PNG and refuses stale mixing", async (t) => {
  const item = await fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const args = [
    SCRIPT,
    item.root,
    "candidate.pptx",
    "qa/rendered-candidate",
    "--renderer",
    item.renderer,
    "--renderer-version",
    "fixture-renderer-1",
    "--slides-test",
    item.checker,
    "--slides-test-version",
    "fixture-checker-1",
  ];
  const first = spawnSync("python3", args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(item.root, "qa/rendered-candidate/render-index.json"), "utf8"));
  assert.equal(index.producer, "ppt-cast/render-pptx-qa@2");
  assert.equal(index.version, 2);
  assert.match(index.producerSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(index.artifactSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(index.slideCount, 2);
  assert.equal(index.overflowPassed, true);
  assert.deepEqual(index.renderedSlides.map((slide) => slide.slideNumber), [1, 2]);
  assert.ok(index.renderedSlides.every((slide) => slide.mime === "image/png" && slide.width === 1920 && slide.height === 1080));
  assert.equal(path.basename(index.renderer.name), "renderer.py");
  assert.equal(index.renderer.version, "fixture-renderer-1");
  assert.match(index.renderer.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(path.basename(index.slidesTest.name), "slides_test.py");
  assert.equal(index.slidesTest.version, "fixture-checker-1");
  assert.match(index.slidesTest.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(index.runtime && index.runtime.python && index.runtime.python.version);
  assert.match(index.runtime.python.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(index.runtime.python.pillowVersion);

  const second = spawnSync("python3", args, { encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /refusing to mix or overwrite render evidence/);
});

test("overflow output fails closed even when the external checker exits zero", async (t) => {
  const item = await fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  writeTool(item.checker, "print('ERROR: Slides with content overflowing original canvas: 2')");
  const run = spawnSync("python3", [
    SCRIPT,
    item.root,
    "candidate.pptx",
    "qa/rejected-render",
    "--renderer",
    item.renderer,
    "--renderer-version",
    "fixture-renderer-1",
    "--slides-test",
    item.checker,
    "--slides-test-version",
    "fixture-checker-1",
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /overflow checker reported failure/);
  assert.equal(fs.existsSync(path.join(item.root, "qa/rejected-render")), false);
});

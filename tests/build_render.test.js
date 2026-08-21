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
import argparse, os, struct
p = argparse.ArgumentParser()
p.add_argument("input")
p.add_argument("--output_dir", required=True)
p.add_argument("--width")
p.add_argument("--height")
a = p.parse_args()
os.makedirs(a.output_dir, exist_ok=True)
for n in (1, 2):
    head = bytearray(24)
    head[:8] = b"\x89PNG\r\n\x1a\n"
    head[12:16] = b"IHDR"
    head[16:24] = struct.pack(">II", 1920, 1080)
    open(os.path.join(a.output_dir, f"slide-{n}.png"), "wb").write(head)
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
    "--slides-test",
    item.checker,
  ];
  const first = spawnSync("python3", args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(item.root, "qa/rendered-candidate/render-index.json"), "utf8"));
  assert.equal(index.producer, "ppt-cast/render-pptx-qa@1");
  assert.match(index.artifactSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(index.slideCount, 2);
  assert.equal(index.overflowPassed, true);
  assert.deepEqual(index.renderedSlides.map((slide) => slide.slideNumber), [1, 2]);
  assert.ok(index.renderedSlides.every((slide) => slide.mime === "image/png" && slide.width === 1920 && slide.height === 1080));
  assert.equal(path.basename(index.renderer), "renderer.py");
  assert.equal(path.basename(index.slidesTest), "slides_test.py");

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
    "--slides-test",
    item.checker,
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /overflow checker reported failure/);
  assert.equal(fs.existsSync(path.join(item.root, "qa/rejected-render")), false);
});

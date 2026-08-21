"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const JSZip = require(path.resolve(__dirname, "..", ".grok", "skills", "ppt-cast", "scripts", "node_modules", "jszip"));

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts");
const PRODUCER = path.join(SCRIPTS, "render_pptx_qa.py");
const { recheckRenderEvidence } = require(path.join(SCRIPTS, "runtime", "render_recheck"));
const { sha256File } = require(path.join(SCRIPTS, "runtime", "hash_bound_receipt"));

function writeExecutable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o700 });
  return filePath;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-render-recheck-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"urn:test\"/>");
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "candidate.staging.pptx"), await zip.generateAsync({ type: "nodebuffer" }));
  const renderer = writeExecutable(path.join(root, "tools", "render_slides.py"), `#!/usr/bin/env python3
import argparse
from pathlib import Path
from PIL import Image
p=argparse.ArgumentParser(); p.add_argument('pptx'); p.add_argument('--output_dir',required=True); p.add_argument('--width',type=int); p.add_argument('--height',type=int); a=p.parse_args()
o=Path(a.output_dir); o.mkdir(parents=True,exist_ok=True); Image.new('RGB',(a.width,a.height),(20,40,60)).save(o/'slide-1.png')
`);
  const slidesTest = writeExecutable(path.join(root, "tools", "slides_test.py"), "#!/usr/bin/env python3\nprint('PASS')\n");
  const pythonProbe = spawnSync("python3", ["-c", "import os,sys; print(os.path.realpath(sys.executable))"], { encoding: "utf8" });
  assert.equal(pythonProbe.status, 0, pythonProbe.stderr);
  const python = process.env.DECKFORMANCE_PYTHON || pythonProbe.stdout.trim();
  const args = [
    PRODUCER, root, "build/candidate.staging.pptx", "qa/rendered-candidate",
    "--renderer", renderer, "--renderer-version", "fixture-v1",
    "--slides-test", slidesTest, "--slides-test-version", "fixture-v1", "--python", python,
  ];
  const run = spawnSync(python, args, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const indexPath = path.join(root, "qa", "rendered-candidate", "render-index.json");
  return {
    root,
    renderer,
    slidesTest,
    python,
    record: { renderIndexPath: "qa/rendered-candidate/render-index.json", renderIndexSha256: sha256File(indexPath) },
  };
}

test("release-time render reproduction reruns the exact tools and rejects different pixels", async (t) => {
  const item = await fixture(t);
  const options = {
    python: item.python,
    renderer: item.renderer,
    rendererVersion: "fixture-v1",
    slidesTest: item.slidesTest,
    slidesTestVersion: "fixture-v1",
  };
  assert.equal(recheckRenderEvidence(item.root, item.record, options).passed, true);
  fs.writeFileSync(item.renderer, fs.readFileSync(item.renderer, "utf8").replace("(20,40,60)", "(90,20,10)"), { mode: 0o700 });
  assert.throws(() => recheckRenderEvidence(item.root, item.record, options), /differs from canonical evidence/);
});

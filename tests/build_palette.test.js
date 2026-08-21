"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SAMPLE = path.join(ROOT, ".grok/skills/ppt-cast/scripts/sample_palette.py");

function makeColor(filePath, color) {
  const run = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=96x96:d=0.1`,
    "-frames:v", "1", "-update", "1", filePath,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

test("palette sampling fails closed when the reference has no usable chromatic color", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-palette-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gray = path.join(directory, "gray.png");
  const red = path.join(directory, "red.png");
  makeColor(gray, "gray");
  makeColor(red, "red");
  let run = spawnSync("python3", [SAMPLE, gray], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no usable chromatic swatches/);
  run = spawnSync("python3", [SAMPLE, red, "--n", "2"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /[A-F0-9]{6}\s+n=/);
});

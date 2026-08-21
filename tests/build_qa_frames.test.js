"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const EXTRACT = path.join(ROOT, ".grok/skills/ppt-cast/scripts/extract_qa_frames.py");

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("video QA extraction produces five stable bound frames and refuses stale mixing", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-frame-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const video = path.join(directory, "clip.mp4");
  const output = path.join(directory, "qa");
  let run = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video,
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  run = spawnSync("python3", [EXTRACT, video, output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const expected = ["frame_00.png", "frame_20.png", "frame_50.png", "frame_80.png", "frame_100.png"].sort();
  assert.deepEqual(fs.readdirSync(output).sort(), expected);
  const before = Object.fromEntries(expected.map((name) => [name, digest(path.join(output, name))]));
  run = spawnSync("python3", [EXTRACT, video, output], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing to mix/);
  assert.deepEqual(
    Object.fromEntries(expected.map((name) => [name, digest(path.join(output, name))])),
    before,
  );
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const SCRIPTS = path.resolve(__dirname, "..", ".grok", "skills", "ppt-cast", "scripts");
const { inspectVideo, parseAspect, probe } = require(path.join(SCRIPTS, "media_contract"));

test("video inspection decodes every frame and rejects a tail-truncated MP4 that ffprobe can still describe", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-media-decode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const valid = path.join(root, "valid.mp4");
  const generated = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x320:r=30:d=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", valid,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const aspect = parseAspect("1:1");
  assert.deepEqual(inspectVideo(valid, aspect).errors, []);

  const bytes = fs.readFileSync(valid);
  const truncated = path.join(root, "truncated.mp4");
  fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.78)));
  const metadata = probe(truncated);
  assert.ok(metadata.streams.some((stream) => stream.codec_type === "video"), "fixture must remain ffprobe-readable");
  const result = inspectVideo(truncated, aspect);
  assert.ok(result.errors.some((error) => /fully decode/.test(error)), JSON.stringify(result.errors));
});

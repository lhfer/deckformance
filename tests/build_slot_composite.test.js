"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts", "compose_slot_qa.py");

function writeJson(root, name, value) {
  fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
}

function makeJob() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-slot-"));
  fs.mkdirSync(path.join(root, "stills"), { recursive: true });
  writeJson(root, "content-plan.json", {
    slides: [{
      id: "01", type: "content", title: "Body stays visible.",
      body: ["Review the final slot first."], role: "proof", videoRequired: true,
    }],
  });
  writeJson(root, "visual-plan.json", {
    brandDirection: {
      deckPalette: {
        bg: "#F2F3F5", panel: "#0B0D10", title: "#F7F7F7", body: "#B8B8B8",
        muted: "#7A7A7A", accent: "#C8102E", ink: "#0B0D10", inkMuted: "#5A5A5A",
      },
      typography: { title: "Arial", body: "Arial", number: "Arial", rationale: "Fixture" },
    },
    slides: [{ id: "01", layoutId: "split-left-video", slot: { aspect: "1:1" } }],
  });
  return root;
}

function makePng(filePath, size) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=0x335577:s=${size}:d=0.1`,
    "-frames:v", "1", "-c:v", "png", filePath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("slot QA creates a true full-slide PNG from content, visual plan, and exact-aspect poster", (t) => {
  const root = makeJob();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makePng(path.join(root, "stills/01.png"), "256x256");
  const run = spawnSync("python3", [SCRIPT, root, "01", "stills/01.png", "qa/01/slot-composite.png"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const output = path.join(root, "qa/01/slot-composite.png");
  const bytes = fs.readFileSync(output);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 1920);
  assert.equal(bytes.readUInt32BE(20), 1080);
});

test("slot QA refuses implicit aspect cropping and publishes no evidence", (t) => {
  const root = makeJob();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makePng(path.join(root, "stills/01.png"), "320x180");
  const run = spawnSync("python3", [SCRIPT, root, "01", "stills/01.png", "qa/01/slot-composite.png"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /refusing an implicit crop/);
  assert.equal(fs.existsSync(path.join(root, "qa/01/slot-composite.png")), false);
});

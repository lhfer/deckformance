"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW = path.join(ROOT, ".grok/skills/ppt-cast/scripts/preview_deck.py");

function runPreview(deck) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-preview-test-"));
  const deckPath = path.join(directory, "deck.json");
  const output = path.join(directory, "preview");
  fs.writeFileSync(deckPath, `${JSON.stringify(deck, null, 2)}\n`);
  const result = spawnSync("python3", [PREVIEW, deckPath, output], { encoding: "utf8" });
  return { directory, output, result };
}

test("early preview renders at 1920x1080 for a fitting title slide", (t) => {
  const run = runPreview({
    title: "Short deck",
    slides: [{ id: "cover", layoutId: "title-card", title: "Short deck", body: ["One clear promise."] }],
  });
  t.after(() => fs.rmSync(run.directory, { recursive: true, force: true }));
  assert.equal(run.result.status, 0, run.result.stderr);
  const rendered = path.join(run.output, "slide-01.jpg");
  assert.ok(fs.statSync(rendered).size > 1000);
});

test("early preview fails closed when a media layout has no poster", (t) => {
  const run = runPreview({
    title: "Missing poster",
    slides: [{ id: "01", layoutId: "split-left-video", title: "A claim", body: ["Evidence."] }],
  });
  t.after(() => fs.rmSync(run.directory, { recursive: true, force: true }));
  assert.equal(run.result.status, 2);
  assert.match(run.result.stderr, /missing poster/);
});

test("point-scaled preview rejects a title that cannot fit its box", (t) => {
  const run = runPreview({
    title: "Overflow",
    slides: [{
      id: "cover",
      layoutId: "title-card",
      title: "This intentionally overlong presentation title cannot fit inside the reserved title area",
      body: ["The preview must report the overflow instead of shrinking it into a false pass."],
    }],
  });
  t.after(() => fs.rmSync(run.directory, { recursive: true, force: true }));
  assert.equal(run.result.status, 2);
  assert.match(run.result.stderr, /title: text exceeds/);
});

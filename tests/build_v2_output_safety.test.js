"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  build,
  resolveJobOutput,
} = require("../.grok/skills/ppt-cast/scripts/build_deck_v2");

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-output-"));
  const jobDir = path.join(root, "job");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(jobDir);
  fs.mkdirSync(outsideDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, jobDir, outsideDir };
}

test("v2 output resolver accepts job-local PPTX and JSON destinations", (t) => {
  const { jobDir } = makeSandbox(t);
  const realJobDir = fs.realpathSync(jobDir);

  assert.equal(
    resolveJobOutput(jobDir, "build/candidate.pptx", { label: "output", extension: ".pptx" }),
    path.join(realJobDir, "build", "candidate.pptx"),
  );
  assert.equal(
    resolveJobOutput(jobDir, path.join(jobDir, "build", "absolute-inside.pptx"), { label: "output", extension: ".pptx" }),
    path.join(realJobDir, "build", "absolute-inside.pptx"),
  );
  assert.equal(
    resolveJobOutput(jobDir, "qa/build-report.json", { label: "report", extension: ".json" }),
    path.join(realJobDir, "qa", "build-report.json"),
  );
});

test("v2 output resolver rejects extension errors and lexical escape paths", (t) => {
  const { jobDir, outsideDir } = makeSandbox(t);

  assert.throws(
    () => resolveJobOutput(jobDir, "build/candidate.zip", { label: "output", extension: ".pptx" }),
    /output path must end in \.pptx/,
  );
  assert.throws(
    () => resolveJobOutput(jobDir, "qa/build-report.txt", { label: "report", extension: ".json" }),
    /report path must end in \.json/,
  );
  assert.throws(
    () => resolveJobOutput(jobDir, "../outside/victim.pptx", { label: "output", extension: ".pptx" }),
    /outside the job directory/,
  );
  assert.throws(
    () => resolveJobOutput(jobDir, path.join(outsideDir, "victim.pptx"), { label: "output", extension: ".pptx" }),
    /outside the job directory/,
  );
});

test("build rejects an escaping symlink parent before reading job inputs and preserves the outside victim", async (t) => {
  const { jobDir, outsideDir } = makeSandbox(t);
  const victim = path.join(outsideDir, "victim.pptx");
  fs.writeFileSync(victim, "outside-pptx-victim\n");
  fs.symlinkSync(outsideDir, path.join(jobDir, "build"), "dir");

  await assert.rejects(
    build([jobDir, "build/victim.pptx"]),
    /output parent resolves outside the job directory/,
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "outside-pptx-victim\n");
});

test("build resolves and rejects an escaping report parent before media processing", async (t) => {
  const { jobDir, outsideDir } = makeSandbox(t);
  const victim = path.join(outsideDir, "report.json");
  fs.writeFileSync(victim, "outside-json-victim\n");
  fs.symlinkSync(outsideDir, path.join(jobDir, "qa"), "dir");

  await assert.rejects(
    build([jobDir, "build/candidate.pptx", "--report", "qa/report.json"]),
    /report parent resolves outside the job directory/,
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "outside-json-victim\n");
});

test("v2 output resolver rejects an existing output symlink without touching its target", (t) => {
  const { jobDir, outsideDir } = makeSandbox(t);
  const buildDir = path.join(jobDir, "build");
  const victim = path.join(outsideDir, "victim.pptx");
  const output = path.join(buildDir, "candidate.pptx");
  fs.mkdirSync(buildDir);
  fs.writeFileSync(victim, "outside-target\n");
  fs.symlinkSync(victim, output);

  assert.throws(
    () => resolveJobOutput(jobDir, output, { label: "output", extension: ".pptx" }),
    /must not be a symbolic link/,
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "outside-target\n");
});

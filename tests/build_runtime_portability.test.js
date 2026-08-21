"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const JSZip = require(path.resolve(__dirname, "..", ".grok", "skills", "ppt-cast", "scripts", "node_modules", "jszip"));

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, ".grok", "skills", "ppt-cast");
const SCRIPTS = path.join(SKILL, "scripts");
const {
  createHashBoundReceipt,
  safeRelativePath,
  sha256Buffer,
  sha256File,
  verifyHashBoundReceipt,
} = require(path.join(SCRIPTS, "runtime", "hash_bound_receipt"));
const { ProviderAdapter, invokeProvider } = require(path.join(SCRIPTS, "runtime", "provider_adapter"));
const { RendererAdapter, invokeRenderer } = require(path.join(SCRIPTS, "runtime", "renderer_adapter"));
const { HashBoundAssetStore } = require(path.join(SCRIPTS, "runtime", "asset_store"));
const {
  RendererRegistry,
  findExecutable,
  portableRendererRegistry,
} = require(path.join(SCRIPTS, "runtime", "renderer_registry"));
const {
  checkFonts,
  checkNodeDependencies,
  checkProvider,
  detectHost,
  makeCheck,
  runDoctor,
  statusForChecks,
} = require(path.join(SCRIPTS, "doctor"));
const {
  exitCodeForStatus,
  requireRelease,
} = require(path.join(SCRIPTS, "runtime", "release_gate"));
const {
  blockedNextAction,
  classifyPreflight,
  loadValidation,
  parseArgs: parsePreflightArgs,
  runPreflight,
  validatorCheck,
} = require(path.join(SCRIPTS, "preflight"));
const {
  BAILIAN_MAX_BYTES,
  TARGETS,
  generateDistributions,
  parseArgs: parseDistributionArgs,
  validateBailianZip,
} = require(path.join(SCRIPTS, "generate_distributions"));

let tempRoot;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-runtime-"));
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeRoot(name) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function write(root, relative, value) {
  const output = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, value);
  return output;
}

function readyDoctor(status = "ready") {
  return {
    status,
    checks: [makeCheck("runtime", status === "blocked" ? "fail" : status === "degraded" ? "warn" : "pass", status === "blocked", "fixture")],
    runtimeReceipt: { receiptSha256: `sha256:${"a".repeat(64)}` },
  };
}

test("hash-bound receipts detect byte drift and reject unsafe paths", () => {
  const root = makeRoot("receipts");
  write(root, "implementation.js", "module.exports = 1;\n");
  write(root, "inputs/source.txt", "source");
  write(root, "outputs/result.txt", "result");
  const receipt = createHashBoundReceipt({
    root,
    kind: "runtime",
    producer: { name: "fixture", version: "1" },
    implementationFiles: ["implementation.js"],
    inputs: ["inputs/source.txt"],
    outputs: ["outputs/result.txt"],
    metadata: { stable: true },
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(verifyHashBoundReceipt(root, receipt).ok, true);
  fs.writeFileSync(path.join(root, "implementation.js"), "module.exports = 2;\n");
  assert.match(verifyHashBoundReceipt(root, receipt).errors.join("\n"), /implementation hash drift/);
  fs.writeFileSync(path.join(root, "outputs", "result.txt"), "changed");
  const drift = verifyHashBoundReceipt(root, receipt);
  assert.equal(drift.ok, false);
  assert.match(drift.errors.join("\n"), /hash drift|byte-count drift/);
  assert.throws(() => safeRelativePath(root, "../escape"), /unsafe/);
  assert.throws(() => createHashBoundReceipt({ root, kind: "x", producer: { name: "only-name" } }), /version/);
});

test("provider and renderer adapters emit implementation and artifact-bound receipts", async () => {
  const root = makeRoot("adapters");
  write(root, "adapter.js", "fixture implementation\n");
  write(root, "input.txt", "input\n");
  class FixtureProvider extends ProviderAdapter {
    constructor() {
      super({ id: "fixture-provider", version: "1.2.3", model: "model-a", transport: "api", capabilities: { video: true } });
    }
    async generateVideo() {
      write(root, "media/video.mp4", "video bytes");
      return { status: "completed", requestId: "req-1", outputs: ["media/video.mp4"], cost: { currency: "USD", amount: 0.1 } };
    }
  }
  const provider = await invokeProvider(new FixtureProvider(), "generate-video", {
    prompt: "private prompt",
    seed: 7,
    motionPlanSha256: `sha256:${"a".repeat(64)}`,
    generationRequestSha256: `sha256:${"b".repeat(64)}`,
    slideId: "01",
    layerId: "01.video.performance",
  }, {
    root,
    implementationFiles: ["adapter.js"],
    inputs: ["input.txt"],
    receiptPath: "qa/provider-receipt.json",
    validateOutput: async () => ({ passed: true }),
  });
  assert.equal(provider.receipt.kind, "provider");
  assert.equal(provider.receipt.metadata.promptSha256, sha256Buffer("private prompt"));
  assert.doesNotMatch(JSON.stringify(provider.receipt), /private prompt/);
  assert.equal(verifyHashBoundReceipt(root, provider.receipt).ok, true);
  await assert.rejects(
    () => invokeProvider(new FixtureProvider(), "generate-video", {
      prompt: "private prompt",
      motionPlanSha256: `sha256:${"a".repeat(64)}`,
      generationRequestSha256: `sha256:${"b".repeat(64)}`,
      slideId: "01",
      layerId: "01.video.performance",
    }, { root, implementationFiles: [] }),
    /at least one current implementation file/,
  );

  class FixtureRenderer extends RendererAdapter {
    constructor() {
      super({ id: "fixture-renderer", version: "4", capabilities: { pptxToPng: true, overflowCheck: true } });
    }
    async render() {
      write(root, "rendered/slide-1.png", "png bytes");
      return {
        outputs: ["rendered/slide-1.png"],
        slides: [{ slideNumber: 1, path: "rendered/slide-1.png" }],
      };
    }
  }
  const renderer = await invokeRenderer(new FixtureRenderer(), { inputs: ["input.txt"] }, {
    root,
    implementationFiles: ["adapter.js"],
    receiptPath: "qa/renderer-receipt.json",
  });
  assert.equal(renderer.receipt.metadata.slideCount, 1);
  assert.equal(verifyHashBoundReceipt(root, renderer.receipt).ok, true);
});

test("AssetStore retries, recovers, and refuses bytes outside the expected hash", async () => {
  const root = makeRoot("asset-store");
  write(root, "asset-store.js", "fixture\n");
  const bytes = Buffer.from("verified remote asset");
  let attempts = 0;
  const store = new HashBoundAssetStore({
    retries: 1,
    retryDelayMs: 0,
    sleep: async () => {},
    resolvers: {
      task: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return bytes;
      },
    },
  });
  const result = await store.materialize({
    root,
    source: { kind: "task", taskId: "task-secret-id" },
    expectedSha256: sha256Buffer(bytes),
    destination: "media/asset.bin",
    receiptPath: "qa/asset-receipt.json",
    implementationFiles: ["asset-store.js"],
  });
  assert.equal(attempts, 2);
  assert.equal(result.receipt.metadata.attempts, 2);
  assert.doesNotMatch(JSON.stringify(result.receipt), /task-secret-id/);
  assert.equal(verifyHashBoundReceipt(root, result.receipt).ok, true);
  const reused = await store.materialize({
    root,
    source: { kind: "task", taskId: "task-secret-id" },
    expectedSha256: sha256Buffer(bytes),
    destination: "media/asset.bin",
    receiptPath: "qa/asset-receipt.json",
    implementationFiles: ["asset-store.js"],
  });
  assert.equal(reused.receipt.metadata.reused, true);

  const bad = new HashBoundAssetStore({ retries: 0, resolvers: { object: async () => Buffer.from("wrong") } });
  await assert.rejects(() => bad.materialize({
    root,
    source: { kind: "object", objectKey: "bucket/key" },
    expectedSha256: sha256Buffer("expected"),
    destination: "media/wrong.bin",
  }), /hash mismatch/);
  assert.equal(fs.existsSync(path.join(root, "media", "wrong.bin")), false);
});

test("renderer registry selects only a portable implementation with every required capability", async () => {
  const registry = new RendererRegistry();
  registry.register({ id: "unavailable", version: "1", priority: 100, capabilities: { pptxToPng: true, overflowCheck: true }, probe: async () => ({ available: false }) });
  registry.register({ id: "render-only", version: "1", priority: 50, capabilities: { pptxToPng: true, overflowCheck: false }, probe: async () => ({ available: true }) });
  registry.register({ id: "complete", version: "2", priority: 10, capabilities: { pptxToPng: true, overflowCheck: true }, probe: async () => ({ available: true, path: "/portable/renderer" }) });
  const resolved = await registry.resolve({ platform: process.platform, requiredCapabilities: { pptxToPng: true, overflowCheck: true } });
  assert.equal(resolved.selected.id, "complete");
  assert.deepEqual(registry.describe().map((entry) => entry.id), ["complete", "render-only", "unavailable"]);
  assert.throws(() => registry.register({ id: "complete", version: "3" }), /already registered/);
  assert.equal(findExecutable(process.execPath), process.execPath);

  const helpers = makeRoot("renderer-helpers");
  const renderer = write(helpers, "render_slides.py", "# fixture\n");
  const slidesTest = write(helpers, "slides_test.py", "# fixture\n");
  const rendererTrustPolicy = {
    schema: "deckformance.renderer-trust-policy/1",
    policyId: "deckformance.renderer-trust.default.v1",
    approvedAdapters: [{
      id: "fixture-adapter",
      renderer: { name: "render_slides.py", version: "fixture-renderer-1", sha256: sha256File(renderer) },
      slidesTest: { name: "slides_test.py", version: "fixture-checker-1", sha256: sha256File(slidesTest) },
    }],
  };
  const portable = portableRendererRegistry({ rendererTrustPolicy, rendererRuntimeProbe: async () => ({ ok: true, detail: "fixture runtime" }), env: {
    ...process.env,
    DECKFORMANCE_RENDERER: renderer,
    DECKFORMANCE_SLIDES_TEST: slidesTest,
    DECKFORMANCE_RENDERER_VERSION: "fixture-renderer-1",
    DECKFORMANCE_SLIDES_TEST_VERSION: "fixture-checker-1",
  }, platform: process.platform });
  const helper = await portable.resolve({ platform: process.platform, requiredCapabilities: { pptxToPng: true, overflowCheck: true } });
  assert.equal(helper.selected.id, "presentation-skill-python");
  assert.equal(helper.selected.implementation.renderer.version, "fixture-renderer-1");
  assert.match(helper.selected.implementation.slidesTest.sha256, /^sha256:/);
  const incompleteRuntime = portableRendererRegistry({ rendererTrustPolicy, env: {
    DECKFORMANCE_RENDERER: renderer,
    DECKFORMANCE_SLIDES_TEST: slidesTest,
    DECKFORMANCE_RENDERER_VERSION: "fixture-renderer-1",
    DECKFORMANCE_SLIDES_TEST_VERSION: "fixture-checker-1",
  }, platform: process.platform });
  const unavailable = await incompleteRuntime.resolve({ platform: process.platform, requiredCapabilities: { pptxToPng: true, overflowCheck: true } });
  assert.equal(unavailable.selected, null);
  assert.match(unavailable.probes.find((probe) => probe.id === "presentation-skill-python").detail, /complete presentation runtime/);
});

test("doctor exposes ready, degraded, and blocked exit semantics and verifies npm lock state", async () => {
  const dependencyCheck = checkNodeDependencies({ scriptsRoot: SCRIPTS });
  assert.equal(dependencyCheck.status, "pass", dependencyCheck.detail.problems && dependencyCheck.detail.problems.join("\n"));
  if (process.platform === "darwin") {
    const fonts = checkFonts({
      scriptsRoot: SCRIPTS,
      skillRoot: SKILL,
      platform: "darwin",
      env: { PATH: "", DECKFORMANCE_REQUIRED_FONTS: "Arial" },
    });
    assert.equal(fonts.status, "pass", fonts.summary);
    assert.match(fonts.detail.files.Arial.sha256, /^sha256:/);
  }
  const pass = makeCheck("a", "pass", true, "pass");
  const warn = makeCheck("b", "warn", false, "warn");
  const fail = makeCheck("c", "fail", true, "fail");
  assert.equal(statusForChecks([pass]), "ready");
  assert.equal(statusForChecks([pass, warn]), "degraded");
  assert.equal(statusForChecks([pass, fail]), "blocked");
  assert.equal(statusForChecks([pass, makeCheck("optional-fail", "fail", false, "optional")]), "degraded");
  assert.equal(requireRelease("candidate"), "candidate");
  assert.equal(requireRelease("final"), "final");
  assert.throws(() => requireRelease("draft"), /candidate or final/);
  assert.deepEqual([exitCodeForStatus("ready"), exitCodeForStatus("degraded"), exitCodeForStatus("blocked")], [0, 2, 1]);
  assert.throws(() => exitCodeForStatus("unknown"), /unknown release status/);
  const missingProvider = checkProvider({ env: {} });
  assert.equal(missingProvider.status, "warn");
  assert.equal(missingProvider.detail.generationReady, false);
  assert.match(missingProvider.summary, /design\/preview/);
  const declaredProvider = checkProvider({ env: {
    DECKFORMANCE_PROVIDER: "configured-external-provider",
    DECKFORMANCE_PROVIDER_CAPABILITIES: JSON.stringify(["generate-video"]),
  } });
  assert.equal(declaredProvider.status, "pass");
  assert.equal(declaredProvider.detail.generationReady, true);
  assert.match(declaredProvider.summary, /live model invocation is still required/);
  const ready = await runDoctor({ checks: [pass] });
  const degraded = await runDoctor({ checks: [pass, warn] });
  const blocked = await runDoctor({ checks: [fail] });
  assert.deepEqual([ready.status, ready.exitCode], ["ready", 0]);
  assert.equal(ready.schemaVersion, "2.0.0");
  assert.deepEqual([degraded.status, degraded.exitCode], ["degraded", 2]);
  assert.deepEqual([blocked.status, blocked.exitCode], ["blocked", 1]);
  assert.equal(ready.runtimeReceipt.kind, "runtime");
  assert.equal(ready.schemaVersion, "2.0.0");
  assert.deepEqual(ready.system, { platform: process.platform, arch: process.arch });
  assert.deepEqual(detectHost({ skillRoot: path.join(tempRoot, ".qwen", "skills", "ppt-cast"), env: {} }), { id: "qwen", detectedBy: "skill-path" });
  assert.deepEqual(detectHost({ skillRoot: SKILL, env: { DECKFORMANCE_HOST: "codex" } }), { id: "codex", detectedBy: "DECKFORMANCE_HOST" });
});

test("preflight combines runtime capability and strict release-contract truth without substituting final playback", async () => {
  const valid = { ok: true, releaseLevel: "candidate", errors: [], warnings: [], stage: "package-ready" };
  const invalid = { ok: false, releaseLevel: "final", errors: [{ code: "POWERPOINT_VERIFICATION", message: "missing" }], warnings: [] };
  assert.equal(classifyPreflight(readyDoctor(), valid), "ready");
  assert.equal(classifyPreflight(readyDoctor("degraded"), valid), "degraded");
  assert.equal(classifyPreflight(readyDoctor(), { ...valid, warnings: ["warning"] }), "degraded");
  assert.equal(classifyPreflight(readyDoctor("blocked"), valid), "blocked");
  assert.equal(classifyPreflight(null, valid), "blocked");
  assert.equal(classifyPreflight(readyDoctor(), null), "blocked");
  assert.equal(classifyPreflight(readyDoctor(), invalid), "blocked");
  assert.equal(validatorCheck(valid).status, "pass");
  assert.equal(validatorCheck(invalid).status, "fail");
  assert.equal(validatorCheck(null).status, "fail");
  assert.deepEqual(parsePreflightArgs(["/tmp/job", "--release", "candidate", "--json"]), { release: "candidate", json: true, jobDir: "/tmp/job" });
  assert.throws(() => parsePreflightArgs(["--release", "draft"]), /usage/);

  const ready = await runPreflight({ jobDir: tempRoot, release: "candidate", doctorResult: readyDoctor(), validationResult: valid });
  const degraded = await runPreflight({ jobDir: tempRoot, release: "candidate", doctorResult: readyDoctor("degraded"), validationResult: valid });
  const blocked = await runPreflight({ jobDir: tempRoot, release: "final", doctorResult: readyDoctor(), validationResult: invalid });
  assert.deepEqual([ready.status, ready.exitCode], ["ready", 0]);
  assert.deepEqual([degraded.status, degraded.exitCode], ["degraded", 2]);
  assert.deepEqual([blocked.status, blocked.exitCode], ["blocked", 1]);
  assert.match(blocked.nextAction, /Resolve every required/);
  assert.match(blockedNextAction({ errors: [{ code: "MISSING_CONTRACT", path: "brief.json" }] }), /Start with brief\.json/);

  const missing = loadValidation(path.join(tempRoot, "missing"), "candidate");
  assert.equal(missing.ok, false);
  const empty = makeRoot("empty-job");
  assert.equal(loadValidation(empty, "candidate").errors[0].code, "JOB_CONTRACT");
  write(empty, "job.json", "{}\n");
  const injected = loadValidation(empty, "candidate", () => valid);
  assert.equal(injected.ok, true);
});

test("canonical generator emits Grok, Qwen, Codex, Claude, and Bailian packages without node_modules", async () => {
  assert.equal(TARGETS.codex, ".agents/skills/ppt-cast");
  assert.equal(parseDistributionArgs(["--help"]).help, true);
  assert.deepEqual(parseDistributionArgs(["--out", "/tmp/dist", "--targets", "qwen,bailian"]), {
    sourceRoot: null,
    outRoot: "/tmp/dist",
    targets: ["qwen", "bailian"],
    help: false,
  });
  const outRoot = path.join(tempRoot, "distributions");
  const generated = await generateDistributions({ sourceRoot: SKILL, outRoot });
  assert.deepEqual(generated.index.outputs.map((item) => item.target), Object.keys(TARGETS));
  const hashes = new Set(generated.index.outputs.map((item) => item.canonicalTreeSha256));
  assert.equal(hashes.size, 1);
  for (const output of generated.index.outputs) {
    const skillRoot = path.join(outRoot, ...output.skillRoot.split("/"));
    assert.equal(fs.existsSync(path.join(skillRoot, "SKILL.md")), true);
    assert.equal([...fs.readdirSync(skillRoot)].includes("node_modules"), false);
  }
  const bailian = generated.index.outputs.find((item) => item.target === "bailian");
  assert.ok(bailian.zipBytes < BAILIAN_MAX_BYTES);
  const zipBuffer = fs.readFileSync(path.join(outRoot, ...bailian.zip.split("/")));
  assert.deepEqual(await validateBailianZip(zipBuffer), { ok: true, errors: [], bytes: zipBuffer.length });

  const secondRoot = path.join(tempRoot, "distributions-repeat");
  const repeated = await generateDistributions({ sourceRoot: SKILL, outRoot: secondRoot });
  const repeatedBailian = repeated.index.outputs.find((item) => item.target === "bailian");
  assert.equal(repeated.index.canonicalSource, "ppt-cast");
  assert.equal(repeatedBailian.zipSha256, bailian.zipSha256);

  const invalidZip = new JSZip();
  invalidZip.file("nested/SKILL.md", "not at root");
  const invalidBuffer = await invalidZip.generateAsync({ type: "nodebuffer" });
  const invalid = await validateBailianZip(invalidBuffer, 1);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /exceeds|archive root/);
  await assert.rejects(() => generateDistributions({ sourceRoot: SKILL, outRoot }), /refusing to overwrite/);
});

test("doctor and preflight CLIs always return machine-readable blocked results with documented exit code 1", () => {
  const jobDir = makeRoot("cli-empty-job");
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "preflight.js"), jobDir, "--release", "candidate", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DECKFORMANCE_PROVIDER: "fixture-provider" },
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.equal(report.exitCode, 1);
  assert.equal(report.releaseContract.detail.errors[0].code, "JOB_CONTRACT");
});

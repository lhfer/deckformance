"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const SCRIPTS = path.resolve(__dirname, "..", ".grok", "skills", "ppt-cast", "scripts");
const { ProviderAdapter, invokeProvider } = require(path.join(SCRIPTS, "runtime", "provider_adapter"));
const { CommandVideoProviderAdapter, HttpVideoProviderAdapter } = require(path.join(SCRIPTS, "runtime", "video_provider_adapter"));
const { generateVideoFromMotionPlan, structuredPromptFromMotionPlan } = require(path.join(SCRIPTS, "video_generation"));
const { GrokVideoProviderAdapter } = require(path.join(SCRIPTS, "providers", "grok_video_provider"));
const { QwenVideoProviderAdapter } = require(path.join(SCRIPTS, "providers", "qwen_video_provider"));
const { schemaValidators } = require(path.join(SCRIPTS, "validate_job_v2"));

function mp4Bytes(marker = 0) {
  const value = Buffer.alloc(48, marker);
  value.writeUInt32BE(24, 0);
  value.write("ftyp", 4, "ascii");
  value.write("isom", 8, "ascii");
  value.write("isomiso2avc1", 16, "ascii");
  return value;
}

function makeJob(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `deckformance-${name}-`));
  fs.mkdirSync(path.join(root, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(root, "impl"), { recursive: true });
  fs.writeFileSync(path.join(root, "inputs", "performance.png"), "performance-reference");
  fs.writeFileSync(path.join(root, "impl", "adapter.js"), "module.exports = 'provider implementation';\n");
  return root;
}

function mediaValidator({ root, output }) {
  const bytes = fs.readFileSync(path.join(root, ...output.path.split("/")));
  return { passed: bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp", providerStatus: "validated" };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTP video adapter performs submit, poll, download, validation, then writes a bound receipt", async (t) => {
  const root = makeJob("http-video");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let polls = 0;
  let origin;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") });
      if (request.url === "/submit") {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ requestId: "http-request-1", status: "queued", model: "injected-http-model" }));
      } else if (request.url === "/status/http-request-1") {
        polls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(polls < 2
          ? { requestId: "http-request-1", status: "processing" }
          : { requestId: "http-request-1", status: "completed", model: "injected-http-model", downloadUrl: `${origin}/download`, cost: { currency: "USD", amount: 0.01 } }));
      } else if (request.url === "/download") {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end(mp4Bytes(3));
      } else {
        response.writeHead(404).end();
      }
    });
  });
  const address = await listen(server);
  t.after(() => close(server));
  origin = `http://${address.address}:${address.port}`;
  const adapter = new HttpVideoProviderAdapter({
    id: "mock-http-video",
    version: "1.0.0",
    model: "injected-http-model",
    submitEndpoint: `${origin}/submit`,
    statusEndpoint: (requestId) => `${origin}/status/${requestId}`,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  const result = await generateVideoFromMotionPlan({
    adapter,
    root,
    slideId: "slide-2",
    layerId: "slide-2.video",
    action: "raise a marker and point to the metric",
    visualIntent: "confident product reveal",
    motionPlan: {
      durationSeconds: 4,
      targetLayerId: "slide-2.video",
      segments: [{ phase: "perform", start: 0.5, end: 3.2 }],
      camera: {
        movement: "static",
        gaze: "audience",
        safeArea: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
      },
      finalHoldSeconds: 0.8,
    },
    model: "injected-http-model",
    seed: 42,
    outputPath: "videos/slide-2.mp4",
    inputs: ["inputs/performance.png"],
    implementationFiles: ["impl/adapter.js"],
    receiptPath: "qa/providers/slide-2-video.json",
    testOnly: true,
    testOnlyValidateOutput: mediaValidator,
  });
  assert.equal(polls, 2);
  assert.deepEqual(requests.map((item) => `${item.method} ${item.url}`), [
    "POST /submit", "GET /status/http-request-1", "GET /status/http-request-1", "GET /download",
  ]);
  const submitted = JSON.parse(requests[0].body);
  assert.deepEqual(submitted.inputs, ["inputs/performance.png"]);
  const structured = JSON.parse(submitted.prompt);
  assert.equal(structured.motion.durationSeconds, 4);
  assert.equal(structured.action, "raise a marker and point to the metric");
  assert.equal(structured.motion.gaze, "audience");
  assert.deepEqual(structured.motion.safeArea, { x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
  assert.equal(result.receipt.metadata.contractVersion, "deckformance.provider-video/1");
  assert.equal(result.receipt.metadata.providerClass, "external-video-generation-model");
  assert.equal(result.receipt.metadata.adapterClass, "HttpVideoProviderAdapter");
  assert.equal(result.receipt.metadata.transport, "http");
  assert.equal(result.receipt.metadata.model, "injected-http-model");
  assert.equal(result.receipt.metadata.requestId, "http-request-1");
  assert.match(result.receipt.metadata.motionPlanSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.receipt.metadata.generationRequestSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.receipt.metadata.slideId, "slide-2");
  assert.equal(result.receipt.metadata.layerId, "slide-2.video");
  assert.equal(result.receipt.metadata.mediaContractValidated, true);
  assert.deepEqual(result.receipt.metadata.outputMp4, result.receipt.outputs[0]);
  assert.match(result.receipt.metadata.outputMp4.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(root, "qa/providers/slide-2-video.json")), true);
  const validateReceipt = schemaValidators()["provider-receipt"];
  assert.equal(validateReceipt(result.receipt), true, JSON.stringify(validateReceipt.errors));
});

test("Command video adapter uses JSON stdin for submit, poll, and download without a shell", async (t) => {
  const root = makeJob("command-video");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "impl", "mock-provider-cli.js");
  fs.writeFileSync(cli, String.raw`
const fs = require("node:fs");
const phase = process.argv[2];
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  if (phase === "submit") process.stdout.write(JSON.stringify({requestId:"cli-request-1",status:"queued",model:"injected-cli-model"}));
  else if (phase === "poll") process.stdout.write(JSON.stringify({requestId:payload.requestId,status:"completed",model:"injected-cli-model"}));
  else if (phase === "download") {
    const bytes = Buffer.alloc(48, 5); bytes.writeUInt32BE(24,0); bytes.write("ftyp",4,"ascii"); bytes.write("isom",8,"ascii");
    fs.writeFileSync(payload.outputPath, bytes);
    process.stdout.write(JSON.stringify({status:"completed"}));
  } else process.exit(4);
});
`);
  const adapter = new CommandVideoProviderAdapter({
    id: "mock-command-video",
    version: "2.0.0",
    model: "injected-cli-model",
    command: process.execPath,
    argsBuilder: (phase) => [cli, phase],
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  const result = await generateVideoFromMotionPlan({
    adapter,
    root,
    motionPlan: { durationSeconds: 3, targetLayerId: "closing.video", segments: [] },
    slideId: "closing",
    layerId: "closing.video",
    model: "injected-cli-model",
    outputPath: "videos/closing.mp4",
    inputs: ["inputs/performance.png"],
    implementationFiles: ["impl/mock-provider-cli.js"],
    receiptPath: "qa/providers/closing-video.json",
    testOnly: true,
    testOnlyValidateOutput: mediaValidator,
  });
  assert.equal(result.receipt.metadata.transport, "command");
  assert.equal(result.receipt.metadata.providerClass, "external-video-generation-model");
  assert.equal(result.receipt.metadata.adapterClass, "CommandVideoProviderAdapter");
  assert.equal(result.receipt.metadata.requestId, "cli-request-1");
  assert.equal(result.receipt.outputs.length, 1);
  assert.equal(result.receipt.outputs[0].path, "videos/closing.mp4");
});

test("generate-video fails closed before receipt on capability, result, or validation failure", async (t) => {
  const root = makeJob("video-failures");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  class Fixture extends ProviderAdapter {
    constructor(capabilities = { video: true }) { super({ id: "fixture", version: "1", model: "fixture-model", transport: "api", capabilities }); }
    async generateVideo(request) {
      const target = path.join(root, ...request.outputPath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, mp4Bytes(8));
      return { status: "completed", requestId: "fixture-request", model: "fixture-model", outputs: [request.outputPath] };
    }
  }
  const base = {
    root,
    motionPlan: { durationSeconds: 3, targetLayerId: "s.video", segments: [] },
    slideId: "s",
    layerId: "s.video",
    model: "fixture-model",
    inputs: ["inputs/performance.png"],
    implementationFiles: ["impl/adapter.js"],
  };
  await assert.rejects(() => generateVideoFromMotionPlan({ ...base, adapter: new Fixture({}), outputPath: "videos/no-capability.mp4", testOnly: true, testOnlyValidateOutput: mediaValidator }), /does not declare/);
  await assert.rejects(
    () => generateVideoFromMotionPlan({ ...base, inputs: [], adapter: new Fixture(), outputPath: "videos/no-input.mp4", testOnly: true, testOnlyValidateOutput: mediaValidator }),
    /at least one bound input/,
  );
  await assert.rejects(() => generateVideoFromMotionPlan({ ...base, adapter: new Fixture(), outputPath: "videos/rejected.mp4", receiptPath: "qa/rejected.json", testOnly: true, testOnlyValidateOutput: async () => ({ passed: false }) }), /did not pass/);
  assert.equal(fs.existsSync(path.join(root, "qa/rejected.json")), false);
  await assert.rejects(
    () => generateVideoFromMotionPlan({ ...base, adapter: new Fixture(), outputPath: "videos/no-validator.mp4", receiptPath: "qa/no-validator.json" }),
    /resolved output aspect/,
  );
  assert.equal(fs.existsSync(path.join(root, "qa/no-validator.json")), false);
  class NumericCostFixture extends Fixture {
    async generateVideo(request) {
      return { ...(await super.generateVideo(request)), cost: 0.1 };
    }
  }
  await assert.rejects(
    () => generateVideoFromMotionPlan({ ...base, adapter: new NumericCostFixture(), outputPath: "videos/numeric-cost.mp4", testOnly: true, testOnlyValidateOutput: mediaValidator }),
    /cost must be an object or null/,
  );
  assert.throws(() => structuredPromptFromMotionPlan(null), /motionPlan/);
});

test("default video-generation runner validates a fully decoded H.264/yuv420p MP4 before writing its receipt", async (t) => {
  const root = makeJob("default-media-contract");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "inputs", "model-output.mp4");
  const generated = spawnSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=3",
    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
    "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", source,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  class ExternalFixtureAdapter extends ProviderAdapter {
    constructor() {
      super({ id: "external-fixture-model", version: "1", model: "fixture-model", transport: "api", capabilities: { video: true } });
    }
    async generateVideo(request) {
      const target = path.join(root, ...request.outputPath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return { status: "completed", requestId: "external-fixture-request", model: this.model, outputs: [request.outputPath] };
    }
  }
  const result = await generateVideoFromMotionPlan({
    adapter: new ExternalFixtureAdapter(),
    root,
    motionPlan: {
      durationSeconds: 3,
      targetLayerId: "content.video",
      beats: [{ at: 0, action: "enter" }, { at: 2.5, action: "hold" }],
      camera: { movement: "static", gaze: "audience", safeArea: { x: 0, y: 0, width: 1, height: 1 } },
      finalHoldSeconds: 0.5,
    },
    slideId: "content",
    layerId: "content.video",
    slot: { aspect: "16:9", widthPx: 320, heightPx: 180 },
    fps: 24,
    model: "fixture-model",
    outputPath: "videos/content.mp4",
    inputs: ["inputs/performance.png"],
    implementationFiles: ["impl/adapter.js"],
    receiptPath: "qa/providers/content-video.json",
  });
  assert.equal(result.receipt.metadata.mediaContractValidated, true);
  assert.equal(result.receipt.metadata.outputMp4.path, "videos/content.mp4");
  assert.equal(result.receipt.metadata.mediaContract.codec, "h264");
  assert.equal(result.receipt.metadata.mediaContract.pixelFormat, "yuv420p");
  const validateReceipt = schemaValidators()["provider-receipt"];
  assert.equal(validateReceipt(result.receipt), true, JSON.stringify(validateReceipt.errors));
});

test("Grok and Qwen wrappers are independent injected host delegates with no model or endpoint defaults", async (t) => {
  assert.throws(() => new GrokVideoProviderAdapter({}), /delegate/);
  assert.throws(() => new QwenVideoProviderAdapter({ delegate: { generateVideo() {} } }), /model/);
  const delegate = {
    transport: "host",
    async generateVideo(request) { return { status: "completed", requestId: "host-request", model: request.model, outputs: [request.outputPath] }; },
  };
  const grok = new GrokVideoProviderAdapter({ version: "host-adapter-1", model: "injected-grok-model", delegate });
  const qwen = new QwenVideoProviderAdapter({ version: "host-adapter-1", model: "injected-qwen-model", delegate });
  assert.equal(grok.model, "injected-grok-model");
  assert.equal(qwen.model, "injected-qwen-model");
  assert.notEqual(grok.constructor, qwen.constructor);

  const root = makeJob("host-wrapper-success-status");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostDelegate = {
    transport: "host",
    async generateVideo(request) {
      const target = path.join(root, ...request.outputPath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, mp4Bytes(9));
      return { status: "succeeded", requestId: "host-success-request", model: request.model, outputs: [request.outputPath] };
    },
  };
  const hostResult = await generateVideoFromMotionPlan({
    adapter: new GrokVideoProviderAdapter({ version: "host-adapter-1", model: "injected-grok-model", delegate: hostDelegate }),
    root,
    motionPlan: { durationSeconds: 3, targetLayerId: "host.video", beats: [] },
    slideId: "host",
    layerId: "host.video",
    model: "injected-grok-model",
    outputPath: "videos/host.mp4",
    inputs: ["inputs/performance.png"],
    implementationFiles: ["impl/adapter.js"],
    testOnly: true,
    testOnlyValidateOutput: mediaValidator,
  });
  assert.equal(hostResult.receipt.metadata.transport, "host");
  assert.equal(hostResult.receipt.metadata.adapterClass, "GrokVideoProviderAdapter");
  assert.equal(hostResult.receipt.metadata.requestId, "host-success-request");
});

test("the HTTP mock proves only the transport contract, not a real generation model", () => {
  assert.equal(true, true, "local mock bytes are deliberately not model-quality evidence");
});

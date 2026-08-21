#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  createHashBoundReceipt,
  fileDescriptor,
  sha256Buffer,
  writeReceiptAtomic,
} = require("./hash_bound_receipt");

const PROVIDER_OPERATIONS = Object.freeze(["generate-image", "generate-video", "inspect-image", "inspect-video"]);

class ProviderAdapter {
  constructor(options = {}) {
    if (!options.id || !options.version) throw new Error("ProviderAdapter requires id and version");
    this.id = String(options.id);
    this.version = String(options.version);
    this.model = options.model ? String(options.model) : null;
    this.transport = options.transport ? String(options.transport) : "custom";
    this.capabilities = Object.freeze({ ...(options.capabilities || {}) });
  }

  describe() {
    return {
      id: this.id,
      version: this.version,
      model: this.model,
      transport: this.transport,
      capabilities: { ...this.capabilities },
    };
  }

  async probe() {
    return { available: true, detail: `${this.id}@${this.version}` };
  }

  async generateImage() {
    throw new Error(`${this.id} does not implement generateImage`);
  }

  async generateVideo() {
    throw new Error(`${this.id} does not implement generateVideo`);
  }

  async inspectImage() {
    throw new Error(`${this.id} does not implement inspectImage`);
  }

  async inspectVideo() {
    throw new Error(`${this.id} does not implement inspectVideo`);
  }
}

function operationMethod(operation) {
  const methods = {
    "generate-image": "generateImage",
    "generate-video": "generateVideo",
    "inspect-image": "inspectImage",
    "inspect-video": "inspectVideo",
  };
  if (!methods[operation]) throw new Error(`unsupported provider operation: ${operation}`);
  return methods[operation];
}

function supportsOperation(adapter, operation) {
  if (operation === "generate-video") {
    return adapter.capabilities.video === true || adapter.capabilities.generateVideo === true || adapter.capabilities[operation] === true;
  }
  if (operation === "generate-image") {
    return adapter.capabilities.image === true || adapter.capabilities.generateImage === true || adapter.capabilities[operation] === true;
  }
  return adapter.capabilities[operation] === true;
}

function requireProviderResult(result, options = {}) {
  if (!result || typeof result !== "object") throw new Error("provider result must be an object");
  if (!String(result.requestId || "").trim()) throw new Error("provider result must include a non-empty requestId");
  if (!Array.isArray(result.outputs) || result.outputs.length === 0) {
    throw new Error("provider result must declare at least one job-relative output");
  }
  if (options.operation === "generate-video") {
    const status = String(result.status || "").trim().toLowerCase();
    if (!["completed", "succeeded", "success"].includes(status)) throw new Error("generate-video provider result must be completed before receipt creation");
    if (result.outputs.length !== 1) throw new Error("generate-video provider result must declare exactly one output");
    if (path.posix.extname(String(result.outputs[0] || "")).toLowerCase() !== ".mp4") {
      throw new Error("generate-video provider output must be one job-relative .mp4 file");
    }
    if (!(result.cost === undefined || result.cost === null || result.cost && typeof result.cost === "object" && !Array.isArray(result.cost))) {
      throw new Error("generate-video provider cost must be an object or null");
    }
    return { ...result, status: "completed" };
  }
  return result;
}

function publicProviderMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = ["attempts", "finishReason", "providerStatus", "region", "responseCode"];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

async function validateGeneratedVideo(adapter, request, context, result, root) {
  if (typeof context.validateOutput !== "function") {
    throw new Error("generate-video invocation requires an external media-contract validateOutput callback");
  }
  const output = fileDescriptor(root, result.outputs[0]);
  const validation = await context.validateOutput({
    adapter,
    operation: "generate-video",
    output,
    request,
    result,
    root,
  });
  if (!(validation === true || (validation && validation.passed === true))) {
    throw new Error("generate-video output did not pass the external media-contract validation callback");
  }
  return { output, validation: validation === true ? { passed: true } : validation };
}

async function invokeProvider(adapter, operation, request, context) {
  if (!(adapter instanceof ProviderAdapter)) throw new TypeError("adapter must extend ProviderAdapter");
  if (!context || !Array.isArray(context.implementationFiles) || context.implementationFiles.length === 0) {
    throw new Error("provider invocation requires at least one current implementation file");
  }
  if (!supportsOperation(adapter, operation)) throw new Error(`${adapter.id} does not declare the ${operation} capability`);
  if (operation === "generate-video" && !String(request && request.prompt || "").trim()) {
    throw new Error("generate-video request requires a non-empty prompt");
  }
  if (operation === "generate-video" && (
    !/^sha256:[a-f0-9]{64}$/.test(String(request && request.motionPlanSha256 || "")) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(request && request.generationRequestSha256 || "")) ||
    !String(request && request.slideId || "").trim() || !String(request && request.layerId || "").trim()
  )) {
    throw new Error("generate-video request must bind the current motionPlan, slideId, layerId, and generation request hash");
  }
  if (operation === "generate-video" && (!Array.isArray(context.inputs) || context.inputs.length === 0)) {
    throw new Error("generate-video invocation requires at least one bound input descriptor");
  }
  if (operation === "generate-video" && !["host", "http", "command", "api"].includes(adapter.transport)) {
    throw new Error("generate-video adapter transport must be host, http, command, or api");
  }
  const method = operationMethod(operation);
  const root = path.resolve(context.root);
  const started = process.hrtime.bigint();
  const result = requireProviderResult(await adapter[method](request, context), { operation });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const prompt = request && request.prompt !== undefined ? String(request.prompt) : "";
  const model = String(result.model || request.model || adapter.model || "").trim();
  if (operation === "generate-video" && !model) throw new Error("generate-video request/result requires a non-empty model");
  const generatedVideo = operation === "generate-video"
    ? await validateGeneratedVideo(adapter, request, context, result, root)
    : null;
  const metadata = {
    contractVersion: operation === "generate-video" ? "deckformance.provider-video/1" : "deckformance.provider/1",
    provider: adapter.id,
    providerVersion: adapter.version,
    providerClass: operation === "generate-video" ? "external-video-generation-model" : "provider-adapter",
    adapterClass: adapter.constructor && adapter.constructor.name ? adapter.constructor.name : "ProviderAdapter",
    transport: adapter.transport,
    model: model || null,
    operation,
    promptSha256: sha256Buffer(prompt),
    motionPlanSha256: request.motionPlanSha256,
    generationRequestSha256: request.generationRequestSha256,
    slideId: request.slideId,
    layerId: request.layerId,
    seed: request && request.seed !== undefined ? request.seed : null,
    requestId: String(result.requestId),
    durationMs: Number(durationMs.toFixed(3)),
    cost: result.cost || null,
    providerMetadata: publicProviderMetadata(result.publicMetadata),
  };
  if (generatedVideo) {
    metadata.outputMp4 = generatedVideo.output;
    metadata.mediaContractValidated = true;
    if (generatedVideo.validation && generatedVideo.validation.media && typeof generatedVideo.validation.media === "object") {
      metadata.mediaContract = generatedVideo.validation.media;
    }
    metadata.validation = publicProviderMetadata(generatedVideo.validation);
  }
  const receipt = createHashBoundReceipt({
    root,
    kind: "provider",
    producer: { name: adapter.id, version: adapter.version },
    implementationFiles: context.implementationFiles,
    inputs: context.inputs || [],
    outputs: result.outputs,
    metadata,
  });
  if (context.receiptPath) writeReceiptAtomic(root, context.receiptPath, receipt);
  return { result, receipt };
}

module.exports = {
  PROVIDER_OPERATIONS,
  ProviderAdapter,
  invokeProvider,
  operationMethod,
  publicProviderMetadata,
  requireProviderResult,
  supportsOperation,
};

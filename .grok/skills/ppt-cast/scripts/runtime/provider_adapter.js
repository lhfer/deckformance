#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  createHashBoundReceipt,
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
    this.capabilities = Object.freeze({ ...(options.capabilities || {}) });
  }

  describe() {
    return {
      id: this.id,
      version: this.version,
      model: this.model,
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

function requireProviderResult(result) {
  if (!result || typeof result !== "object") throw new Error("provider result must be an object");
  if (!result.requestId) throw new Error("provider result must include requestId");
  if (!Array.isArray(result.outputs) || result.outputs.length === 0) {
    throw new Error("provider result must declare at least one job-relative output");
  }
  return result;
}

async function invokeProvider(adapter, operation, request, context) {
  if (!(adapter instanceof ProviderAdapter)) throw new TypeError("adapter must extend ProviderAdapter");
  if (!context || !Array.isArray(context.implementationFiles) || context.implementationFiles.length === 0) {
    throw new Error("provider invocation requires at least one current implementation file");
  }
  const method = operationMethod(operation);
  const root = path.resolve(context.root);
  const started = process.hrtime.bigint();
  const result = requireProviderResult(await adapter[method](request, context));
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const prompt = request && request.prompt !== undefined ? String(request.prompt) : "";
  const metadata = {
    provider: adapter.id,
    providerVersion: adapter.version,
    model: result.model || request.model || adapter.model || null,
    operation,
    promptSha256: sha256Buffer(prompt),
    seed: request && request.seed !== undefined ? request.seed : null,
    requestId: String(result.requestId),
    durationMs: Number(durationMs.toFixed(3)),
    cost: result.cost || null,
    providerMetadata: result.metadata || {},
  };
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
  requireProviderResult,
};

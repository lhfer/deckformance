#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createHashBoundReceipt, writeReceiptAtomic } = require("./hash_bound_receipt");

class RendererAdapter {
  constructor(options = {}) {
    if (!options.id || !options.version) throw new Error("RendererAdapter requires id and version");
    this.id = String(options.id);
    this.version = String(options.version);
    this.capabilities = Object.freeze({ ...(options.capabilities || {}) });
  }

  describe() {
    return { id: this.id, version: this.version, capabilities: { ...this.capabilities } };
  }

  async probe() {
    return { available: true, detail: `${this.id}@${this.version}` };
  }

  async render() {
    throw new Error(`${this.id} does not implement render`);
  }
}

function validateRenderResult(result) {
  if (!result || typeof result !== "object") throw new Error("renderer result must be an object");
  if (!Array.isArray(result.outputs) || result.outputs.length === 0) {
    throw new Error("renderer result must declare hash-bound job-relative outputs");
  }
  if (!Array.isArray(result.slides)) throw new Error("renderer result must include slides descriptors");
  for (const [index, slide] of result.slides.entries()) {
    if (!Number.isInteger(slide.slideNumber) || slide.slideNumber !== index + 1) {
      throw new Error("renderer slides must be contiguous and one-indexed");
    }
    if (!slide.path) throw new Error(`renderer slide ${index + 1} needs a path`);
  }
  return result;
}

async function invokeRenderer(adapter, request, context) {
  if (!(adapter instanceof RendererAdapter)) throw new TypeError("adapter must extend RendererAdapter");
  const root = path.resolve(context.root);
  const started = process.hrtime.bigint();
  const result = validateRenderResult(await adapter.render(request, context));
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const receipt = createHashBoundReceipt({
    root,
    kind: "renderer",
    producer: { name: adapter.id, version: adapter.version },
    implementationFiles: context.implementationFiles || [],
    inputs: request.inputs || [],
    outputs: result.outputs,
    metadata: {
      renderer: adapter.id,
      rendererVersion: adapter.version,
      capabilities: { ...adapter.capabilities },
      slideCount: result.slides.length,
      slides: result.slides,
      durationMs: Number(durationMs.toFixed(3)),
      rendererMetadata: result.metadata || {},
    },
  });
  if (context.receiptPath) writeReceiptAtomic(root, context.receiptPath, receipt);
  return { result, receipt };
}

module.exports = {
  RendererAdapter,
  invokeRenderer,
  validateRenderResult,
};

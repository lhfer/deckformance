#!/usr/bin/env node
"use strict";

const { ProviderAdapter } = require("../runtime/provider_adapter");

class QwenVideoProviderAdapter extends ProviderAdapter {
  constructor(options = {}) {
    if (!options.delegate || typeof options.delegate.generateVideo !== "function") throw new Error("QwenVideoProviderAdapter requires an injected transport delegate");
    if (!String(options.model || "").trim()) throw new Error("QwenVideoProviderAdapter requires an injected model");
    if (!String(options.version || "").trim()) throw new Error("QwenVideoProviderAdapter requires an injected provider/adapter version");
    super({
      id: options.id || "qwen-host-video",
      version: options.version,
      model: options.model,
      transport: options.delegate.transport || "host",
      capabilities: { video: true },
    });
    this.delegate = options.delegate;
  }

  async probe(context) { return this.delegate.probe ? this.delegate.probe(context) : { available: true, detail: "injected Qwen host bridge" }; }
  async generateVideo(request, context) { return this.delegate.generateVideo({ ...request, model: request.model || this.model }, context); }
}

module.exports = {
  QwenVideoProvider: QwenVideoProviderAdapter,
  QwenVideoProviderAdapter,
};

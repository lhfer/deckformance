#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  HASH_PATTERN,
  createHashBoundReceipt,
  safeRelativePath,
  sha256Buffer,
  sha256File,
  writeReceiptAtomic,
} = require("./hash_bound_receipt");

class AssetStore {
  async materialize() {
    throw new Error("AssetStore.materialize must be implemented");
  }
}

function locatorFor(source) {
  if (!source || typeof source !== "object") throw new Error("asset source descriptor is required");
  if (source.kind === "url") return source.url;
  if (source.kind === "task") return source.taskId;
  if (source.kind === "object") return source.objectKey;
  throw new Error(`unsupported asset source kind: ${source.kind}`);
}

async function defaultUrlResolver(source, context) {
  if (!/^https?:\/\//i.test(String(source.url || ""))) throw new Error("URL assets require http:// or https://");
  const headers = { ...(source.headers || {}) };
  if (context.partialBytes > 0) headers.Range = `bytes=${context.partialBytes}-`;
  const response = await fetch(source.url, { headers, signal: context.signal });
  if (!response.ok || ![200, 206].includes(response.status)) {
    throw new Error(`asset request failed with HTTP ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    append: response.status === 206 && context.partialBytes > 0,
    metadata: {
      status: response.status,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    },
  };
}

function normalizeResolverResult(result) {
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) return { buffer: Buffer.from(result), append: false, metadata: {} };
  if (!result || (!Buffer.isBuffer(result.buffer) && !(result.buffer instanceof Uint8Array))) {
    throw new Error("asset resolver must return a Buffer or {buffer, append?, metadata?}");
  }
  return { buffer: Buffer.from(result.buffer), append: result.append === true, metadata: result.metadata || {} };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

class HashBoundAssetStore extends AssetStore {
  constructor(options = {}) {
    super();
    this.retries = Number.isInteger(options.retries) ? options.retries : 2;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) ? Number(options.retryDelayMs) : 250;
    this.sleep = options.sleep || wait;
    this.resolvers = new Map(Object.entries(options.resolvers || {}));
    if (!this.resolvers.has("url")) this.resolvers.set("url", defaultUrlResolver);
  }

  async materialize(request) {
    const root = path.resolve(request.root);
    const source = request.source;
    const locator = locatorFor(source);
    if (!locator) throw new Error(`asset ${source.kind} source locator is required`);
    if (!HASH_PATTERN.test(String(request.expectedSha256 || ""))) {
      throw new Error("asset materialization requires expectedSha256");
    }
    const destination = safeRelativePath(root, request.destination, { mustExist: false });
    const partial = `${destination}.partial`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
      if (!fs.statSync(destination).isFile() || fs.lstatSync(destination).isSymbolicLink()) {
        throw new Error(`asset destination is not a regular file: ${request.destination}`);
      }
      const actual = sha256File(destination);
      if (actual !== request.expectedSha256) throw new Error(`refusing to overwrite drifted asset: ${request.destination}`);
      return this.#receipt(request, source, locator, { reused: true, attempts: 0, metadata: {} });
    }
    const resolver = this.resolvers.get(source.kind);
    if (!resolver) throw new Error(`no AssetStore resolver registered for ${source.kind}`);
    let lastError = null;
    let providerMetadata = {};
    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      try {
        const partialBytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
        const result = normalizeResolverResult(await resolver(source, {
          attempt,
          partialPath: partial,
          partialBytes,
          signal: request.signal,
        }));
        if (result.append && partialBytes > 0) fs.appendFileSync(partial, result.buffer);
        else fs.writeFileSync(partial, result.buffer, { mode: 0o600 });
        providerMetadata = result.metadata;
        const actual = sha256File(partial);
        if (actual !== request.expectedSha256) {
          throw new Error(`downloaded asset hash mismatch: expected ${request.expectedSha256}, received ${actual}`);
        }
        fs.renameSync(partial, destination);
        return this.#receipt(request, source, locator, { reused: false, attempts: attempt, metadata: providerMetadata });
      } catch (error) {
        lastError = error;
        if (attempt <= this.retries) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError || new Error("asset materialization failed");
  }

  #receipt(request, source, locator, state) {
    const root = path.resolve(request.root);
    const receipt = createHashBoundReceipt({
      root,
      kind: "asset-store",
      producer: { name: "deckformance/hash-bound-asset-store", version: "1" },
      implementationFiles: request.implementationFiles || [],
      inputs: request.inputs || [],
      outputs: [request.destination],
      metadata: {
        sourceKind: source.kind,
        locatorSha256: sha256Buffer(locator),
        expectedSha256: request.expectedSha256,
        reused: state.reused,
        attempts: state.attempts,
        sourceMetadata: state.metadata,
      },
    });
    if (request.receiptPath) writeReceiptAtomic(root, request.receiptPath, receipt, { overwrite: state.reused });
    return { asset: receipt.outputs[0], receipt };
  }
}

module.exports = {
  AssetStore,
  HashBoundAssetStore,
  defaultUrlResolver,
  locatorFor,
  normalizeResolverResult,
};

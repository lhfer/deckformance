#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ProviderAdapter } = require("./provider_adapter");
const { safeRelativePath } = require("./hash_bound_receipt");

const COMPLETE = new Set(["completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(value) {
  return String(value && value.status || "").trim().toLowerCase();
}

function requireOutputPath(root, request) {
  const relative = String(request && request.outputPath || "").trim();
  if (!relative || path.posix.extname(relative).toLowerCase() !== ".mp4") {
    throw new Error("video provider request.outputPath must be one job-relative .mp4 path");
  }
  const target = safeRelativePath(root, relative, { mustExist: false });
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite video provider output: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return { relative, target };
}

function atomicOutput(target, bytes) {
  const temporary = `${target}.${process.pid}.${Date.now()}.partial`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function responseJson(response, label) {
  if (!response || response.ok !== true) throw new Error(`${label} failed with HTTP ${response && response.status}`);
  try { return await response.json(); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

class HttpVideoProviderAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({ ...options, transport: "http", capabilities: { ...(options.capabilities || {}), video: true } });
    if (!options.submitEndpoint) throw new Error("HttpVideoProviderAdapter requires submitEndpoint");
    if (typeof options.statusEndpoint !== "function") throw new Error("HttpVideoProviderAdapter requires statusEndpoint(requestId)");
    this.submitEndpoint = String(options.submitEndpoint);
    this.statusEndpoint = options.statusEndpoint;
    this.fetchImpl = options.fetchImpl || fetch;
    this.headers = Object.freeze({ ...(options.headers || {}) });
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Number(options.pollIntervalMs) : 1000;
    this.maxPolls = Number.isInteger(options.maxPolls) ? options.maxPolls : 120;
    this.sleep = options.sleep || wait;
    this.buildSubmitBody = options.buildSubmitBody || ((request) => ({
      prompt: request.prompt,
      model: request.model,
      seed: request.seed,
      motionPlan: request.motionPlan,
      inputs: request.inputs,
    }));
    this.parseSubmit = options.parseSubmit || ((value) => value);
    this.parsePoll = options.parsePoll || ((value) => value);
  }

  async generateVideo(request, context) {
    const root = path.resolve(context.root);
    const output = requireOutputPath(root, request);
    const submit = this.parseSubmit(await responseJson(await this.fetchImpl(this.submitEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(this.buildSubmitBody(request)),
    }), "video submit"));
    const requestId = String(submit.requestId || "").trim();
    if (!requestId) throw new Error("video submit response omitted requestId");
    let state = submit;
    let polls = 0;
    while (!COMPLETE.has(statusOf(state))) {
      if (FAILED.has(statusOf(state))) throw new Error(`video provider task ${requestId} ended as ${statusOf(state)}`);
      if (polls >= this.maxPolls) throw new Error(`video provider task ${requestId} exceeded ${this.maxPolls} polls`);
      polls += 1;
      await this.sleep(this.pollIntervalMs);
      state = this.parsePoll(await responseJson(await this.fetchImpl(this.statusEndpoint(requestId), {
        method: "GET",
        headers: this.headers,
      }), "video poll"));
    }
    const downloadUrl = String(state.downloadUrl || submit.downloadUrl || "").trim();
    if (!downloadUrl) throw new Error("completed video task omitted downloadUrl");
    const downloaded = await this.fetchImpl(downloadUrl, { method: "GET", headers: this.headers });
    if (!downloaded || downloaded.ok !== true) throw new Error(`video download failed with HTTP ${downloaded && downloaded.status}`);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    if (!bytes.length) throw new Error("video download returned empty bytes");
    atomicOutput(output.target, bytes);
    return {
      status: "completed",
      requestId,
      model: state.model || submit.model || request.model || this.model,
      outputs: [output.relative],
      cost: state.cost || submit.cost || null,
      publicMetadata: { attempts: polls + 1, providerStatus: statusOf(state), finishReason: state.finishReason },
    };
  }
}

function runJsonCommand(command, args, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawnImpl || spawn)(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBuffer = options.maxBuffer || 4 * 1024 * 1024;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`video provider command timed out after ${options.timeoutMs || 120000}ms`));
    }, options.timeoutMs || 120000);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) child.kill("SIGKILL");
      else stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) return reject(new Error("video provider command exceeded maxBuffer"));
      if (code !== 0) return reject(new Error(`video provider command exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch (error) { reject(new Error(`video provider command returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

class CommandVideoProviderAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super({ ...options, transport: "command", capabilities: { ...(options.capabilities || {}), video: true } });
    if (!path.isAbsolute(String(options.command || ""))) throw new Error("CommandVideoProviderAdapter requires an absolute command path");
    this.command = path.resolve(options.command);
    this.argsBuilder = options.argsBuilder || ((phase) => [phase]);
    this.spawnImpl = options.spawnImpl;
    this.env = options.env || process.env;
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Number(options.pollIntervalMs) : 1000;
    this.maxPolls = Number.isInteger(options.maxPolls) ? options.maxPolls : 120;
    this.sleep = options.sleep || wait;
    this.timeoutMs = options.timeoutMs || 120000;
    this.maxBuffer = options.maxBuffer || 4 * 1024 * 1024;
  }

  async call(phase, payload, context) {
    return runJsonCommand(this.command, this.argsBuilder(phase), payload, {
      cwd: path.resolve(context.root), env: this.env, spawnImpl: this.spawnImpl,
      timeoutMs: this.timeoutMs, maxBuffer: this.maxBuffer,
    });
  }

  async generateVideo(request, context) {
    const root = path.resolve(context.root);
    const output = requireOutputPath(root, request);
    let state = await this.call("submit", { request: { ...request, outputPath: undefined } }, context);
    const requestId = String(state.requestId || "").trim();
    if (!requestId) throw new Error("video command submit omitted requestId");
    let polls = 0;
    while (!COMPLETE.has(statusOf(state))) {
      if (FAILED.has(statusOf(state))) throw new Error(`video command task ${requestId} ended as ${statusOf(state)}`);
      if (polls >= this.maxPolls) throw new Error(`video command task ${requestId} exceeded ${this.maxPolls} polls`);
      polls += 1;
      await this.sleep(this.pollIntervalMs);
      state = await this.call("poll", { requestId }, context);
    }
    const temporary = `${output.target}.${process.pid}.${Date.now()}.partial`;
    try {
      const download = await this.call("download", { requestId, outputPath: temporary }, context);
      if (statusOf(download) && !COMPLETE.has(statusOf(download))) throw new Error("video command download did not complete");
      if (!fs.existsSync(temporary) || !fs.statSync(temporary).isFile() || fs.statSync(temporary).size === 0) {
        throw new Error("video command download did not create non-empty output bytes");
      }
      fs.renameSync(temporary, output.target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return {
      status: "completed",
      requestId,
      model: state.model || request.model || this.model,
      outputs: [output.relative],
      cost: state.cost || null,
      publicMetadata: { attempts: polls + 1, providerStatus: statusOf(state), finishReason: state.finishReason },
    };
  }
}

module.exports = {
  CommandVideoProviderAdapter,
  HttpVideoProviderAdapter,
  runJsonCommand,
  statusOf,
};

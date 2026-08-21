#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyTrustedRendererPair } = require("./render_trust");

function executableExtensions(platform, env) {
  if (platform !== "win32") return [""];
  return String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

function isExecutable(filePath, platform = process.platform) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(command, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (!command) return null;
  if (path.isAbsolute(command) || command.includes(path.sep) || (platform === "win32" && command.includes("/"))) {
    return isExecutable(command, platform) ? path.resolve(command) : null;
  }
  const extensions = executableExtensions(platform, env);
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? `${command}${extension}` : command);
      if (isExecutable(candidate, platform)) return path.resolve(candidate);
    }
  }
  return null;
}

function supportsCapabilities(candidate, required) {
  return Object.entries(required || {}).every(([key, value]) => {
    if (value === false || value === undefined || value === null) return true;
    return candidate.capabilities && candidate.capabilities[key] === value;
  });
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function regularFile(filePath) {
  try {
    const resolved = fs.realpathSync(filePath);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function regularDirectory(directoryPath) {
  try {
    const resolved = fs.realpathSync(directoryPath);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function probePresentationRuntime(env = process.env) {
  const python = regularFile(env.DECKFORMANCE_PYTHON);
  const node = regularFile(env.DECKFORMANCE_NODE);
  const binDir = regularDirectory(env.DECKFORMANCE_RUNTIME_BIN_DIR);
  const nodeModules = regularDirectory(env.DECKFORMANCE_NODE_MODULES);
  if (!python || !node || !binDir || !nodeModules) {
    return { ok: false, detail: "set DECKFORMANCE_PYTHON/NODE/RUNTIME_BIN_DIR/NODE_MODULES to the complete presentation runtime" };
  }
  const imports = spawnSync(python, ["-c", "import json,PIL,pdf2image,numpy,pptx; print(json.dumps({'pillow':PIL.__version__}))"], {
    encoding: "utf8",
    timeout: 10000,
    env,
  });
  if (imports.status !== 0) return { ok: false, detail: `presentation Python dependencies are incomplete: ${(imports.stderr || imports.stdout || "unknown error").trim()}` };
  const nodeVersion = commandVersion(node);
  if (!nodeVersion) return { ok: false, detail: "presentation Node runtime could not be executed" };
  return { ok: true, python, node, binDir, nodeModules, nodeVersion, detail: "presentation Python/Node/module/bin runtime is complete" };
}

class RendererRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(entry) {
    if (!entry || !entry.id || !entry.version) throw new Error("renderer registration requires id and version");
    if (this.entries.has(entry.id)) throw new Error(`renderer is already registered: ${entry.id}`);
    const platforms = entry.platforms || ["*"];
    this.entries.set(entry.id, {
      id: String(entry.id),
      version: String(entry.version),
      priority: Number(entry.priority || 0),
      platforms: [...platforms],
      capabilities: Object.freeze({ ...(entry.capabilities || {}) }),
      probe: entry.probe || (async () => ({ available: true })),
      create: entry.create || null,
    });
    return this;
  }

  describe() {
    return [...this.entries.values()]
      .map(({ probe, create, ...entry }) => ({ ...entry, capabilities: { ...entry.capabilities } }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async probe(options = {}) {
    const platform = options.platform || process.platform;
    const results = [];
    for (const entry of this.entries.values()) {
      const platformSupported = entry.platforms.includes("*") || entry.platforms.includes(platform);
      if (!platformSupported) {
        results.push({ ...entry, available: false, detail: `unsupported platform ${platform}` });
        continue;
      }
      try {
        const result = await entry.probe(options);
        results.push({ ...entry, ...result, available: result.available === true, detail: result.detail || null, path: result.path || null });
      } catch (error) {
        results.push({ ...entry, available: false, detail: error.message });
      }
    }
    return results.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  async resolve(options = {}) {
    const results = await this.probe(options);
    const probes = results.map(({ probe, create, ...entry }) => entry);
    const selected = results.find((entry) => entry.available && supportsCapabilities(entry, options.requiredCapabilities || {}));
    if (!selected) return { selected: null, probes };
    const adapter = selected.create ? await selected.create(options) : null;
    return {
      selected: {
        id: selected.id,
        version: selected.version,
        capabilities: { ...selected.capabilities },
        path: selected.path,
        implementation: selected.implementation || null,
        adapter,
      },
      probes,
    };
  }
}

function commandVersion(executable, args = ["--version"]) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").split(/\r?\n/, 1)[0].trim() || "unknown";
}

function portableRendererRegistry(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const registry = new RendererRegistry();
  registry.register({
    id: "presentation-skill-python",
    version: "1",
    priority: 100,
    platforms: ["*"],
    capabilities: { pptxToPng: true, overflowCheck: true, hashBoundReceipt: true },
    probe: async () => {
      const renderer = regularFile(env.DECKFORMANCE_RENDERER || env.RENDER_SLIDES_PY);
      const slidesTest = regularFile(env.DECKFORMANCE_SLIDES_TEST || env.SLIDES_TEST_PY);
      const rendererVersion = String(env.DECKFORMANCE_RENDERER_VERSION || "").trim();
      const slidesTestVersion = String(env.DECKFORMANCE_SLIDES_TEST_VERSION || "").trim();
      let trust = null;
      let trustError = null;
      const runtime = options.rendererRuntimeProbe ? await options.rendererRuntimeProbe(env) : probePresentationRuntime(env);
      if (renderer && slidesTest && rendererVersion && slidesTestVersion) {
        try {
          trust = verifyTrustedRendererPair({
            renderer: { path: renderer, name: path.basename(renderer), version: rendererVersion },
            slidesTest: { path: slidesTest, name: path.basename(slidesTest), version: slidesTestVersion },
          }, options.rendererTrustPolicy ? { policy: options.rendererTrustPolicy } : {});
        } catch (error) {
          trustError = `${error.code || "RENDERER_NOT_APPROVED"}: ${error.message}`;
        }
      }
      const ok = Boolean(trust && runtime && runtime.ok === true);
      return {
        available: ok,
        detail: ok ? `renderer pair is approved by ${trust.policyId}/${trust.adapterId}; ${runtime.detail}` : trustError || (runtime && runtime.detail) || "set approved renderer/checker paths and explicit DECKFORMANCE_RENDERER_VERSION/DECKFORMANCE_SLIDES_TEST_VERSION",
        path: ok ? renderer : null,
        implementation: ok ? {
          policyId: trust.policyId,
          policySha256: trust.policySha256,
          adapterId: trust.adapterId,
          runtime: {
            python: runtime.python || null,
            node: runtime.node || null,
            binDir: runtime.binDir || null,
            nodeModules: runtime.nodeModules || null,
            nodeVersion: runtime.nodeVersion || null,
          },
          renderer: { path: renderer, version: rendererVersion, sha256: trust.renderer.sha256 },
          slidesTest: { path: slidesTest, version: slidesTestVersion, sha256: trust.slidesTest.sha256 },
        } : null,
      };
    },
  });
  registry.register({
    id: "libreoffice",
    version: "portable",
    priority: 50,
    platforms: ["*"],
    capabilities: { pptxToPng: true, overflowCheck: false, hashBoundReceipt: true },
    probe: async () => {
      const executable = findExecutable(env.DECKFORMANCE_SOFFICE || "soffice", { env, platform });
      const version = executable ? commandVersion(executable) : null;
      return { available: Boolean(executable), detail: version || "soffice not found", path: executable };
    },
  });
  registry.register({
    id: "powerpoint-macos",
    version: "native",
    priority: 80,
    platforms: ["darwin"],
    capabilities: { pptxToPng: true, overflowCheck: false, powerPointPlayback: true, hashBoundReceipt: true },
    probe: async () => {
      const app = env.DECKFORMANCE_POWERPOINT_APP || "/Applications/Microsoft PowerPoint.app";
      const executable = path.join(app, "Contents", "MacOS", "Microsoft PowerPoint");
      const available = fs.existsSync(app) && fs.statSync(app).isDirectory() && isExecutable(executable, "darwin");
      return { available, detail: available ? "native Microsoft PowerPoint is installed" : "Microsoft PowerPoint.app not found", path: available ? app : null };
    },
  });
  return registry;
}

module.exports = {
  RendererRegistry,
  findExecutable,
  isExecutable,
  portableRendererRegistry,
  probePresentationRuntime,
  regularDirectory,
  supportsCapabilities,
  regularFile,
  sha256File,
};

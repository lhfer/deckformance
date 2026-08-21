#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const { sha256Buffer, sha256File, stableJson } = require("./runtime/hash_bound_receipt");

const BAILIAN_MAX_BYTES = 10 * 1024 * 1024;
const USAGE = "usage: generate_distributions --out <new-or-empty-dir> [--source <canonical-skill>] [--targets all|grok,qwen,codex,claude,bailian]";
const TARGETS = Object.freeze({
  grok: ".grok/skills/ppt-cast",
  qwen: ".qwen/skills/ppt-cast",
  codex: ".agents/skills/ppt-cast",
  claude: ".claude/skills/ppt-cast",
  bailian: "ppt-cast",
});
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "coverage", ".nyc_output", "__pycache__", "build", "dist"]);

function isExcluded(relativePath) {
  const segments = relativePath.split("/");
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)) || /(?:\.pyc|\.pyo|\.pptx|\.ppsx|\.mp4|\.mov|\.webm|\.DS_Store)$/i.test(relativePath);
}

function collectCanonicalFiles(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (isExcluded(relative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`canonical distributions refuse symbolic links: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({
        path: relative,
        absolute,
        bytes: fs.statSync(absolute).size,
        sha256: sha256File(absolute),
        mode: fs.statSync(absolute).mode & 0o777,
      });
    }
  }
  visit(root);
  if (!files.some((item) => item.path === "SKILL.md")) throw new Error("canonical skill root must contain SKILL.md");
  if (files.some((item) => item.path.split("/").includes("node_modules"))) throw new Error("node_modules must not enter a distribution");
  return files;
}

function treeManifest(target, files) {
  const items = files.map(({ path: relativePath, bytes, sha256 }) => ({ path: relativePath, bytes, sha256 }));
  return {
    formatVersion: 1,
    target,
    canonicalTreeSha256: sha256Buffer(stableJson(items)),
    files: items,
  };
}

function copySkill(targetRoot, files, manifest) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const file of files) {
    const output = path.join(targetRoot, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(file.absolute, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, file.mode);
  }
  fs.writeFileSync(path.join(targetRoot, "distribution-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

async function createBailianZip(files, manifest) {
  const zip = new JSZip();
  const date = new Date("1980-01-01T00:00:00.000Z");
  for (const file of files) {
    zip.file(file.path, fs.readFileSync(file.absolute), {
      date,
      createFolders: false,
      unixPermissions: file.mode,
    });
  }
  zip.file("distribution-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, { date, unixPermissions: 0o644 });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
}

async function validateBailianZip(buffer, maxBytes = BAILIAN_MAX_BYTES) {
  const errors = [];
  if (!Buffer.isBuffer(buffer)) errors.push("Bailian package must be a ZIP Buffer");
  if (Buffer.isBuffer(buffer) && buffer.length > maxBytes) errors.push(`Bailian ZIP exceeds ${maxBytes} bytes`);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    errors.push(`Bailian package is not a readable ZIP: ${error.message}`);
  }
  if (zip) {
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    if (!names.includes("SKILL.md")) errors.push("Bailian ZIP must contain SKILL.md at the archive root");
    if (names.some((name) => name.startsWith("/") || name.includes("../") || name.split("/").includes("node_modules"))) {
      errors.push("Bailian ZIP contains an unsafe or forbidden path");
    }
  }
  return { ok: errors.length === 0, errors, bytes: Buffer.isBuffer(buffer) ? buffer.length : null };
}

async function generateDistributions(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || path.join(__dirname, ".."));
  const outRoot = path.resolve(options.outRoot || path.join(sourceRoot, "..", "..", "..", "dist", "skills"));
  const targets = options.targets || Object.keys(TARGETS);
  for (const target of targets) if (!TARGETS[target]) throw new Error(`unknown distribution target: ${target}`);
  if (fs.existsSync(outRoot) && fs.readdirSync(outRoot).length > 0) throw new Error(`refusing to overwrite non-empty distribution root: ${outRoot}`);
  fs.mkdirSync(outRoot, { recursive: true });
  const files = collectCanonicalFiles(sourceRoot);
  const outputs = [];
  for (const target of targets) {
    const manifest = treeManifest(target, files);
    const targetBase = path.join(outRoot, target);
    const skillRoot = path.join(targetBase, ...TARGETS[target].split("/"));
    copySkill(skillRoot, files, manifest);
    const output = {
      target,
      skillRoot: path.relative(outRoot, skillRoot).split(path.sep).join("/"),
      canonicalTreeSha256: manifest.canonicalTreeSha256,
      fileCount: files.length,
    };
    if (target === "bailian") {
      const zipBuffer = await createBailianZip(files, manifest);
      const validation = await validateBailianZip(zipBuffer, options.bailianMaxBytes || BAILIAN_MAX_BYTES);
      if (!validation.ok) throw new Error(`Bailian distribution failed:\n- ${validation.errors.join("\n- ")}`);
      const zipPath = path.join(targetBase, "ppt-cast.zip");
      fs.writeFileSync(zipPath, zipBuffer, { flag: "wx", mode: 0o644 });
      output.zip = path.relative(outRoot, zipPath).split(path.sep).join("/");
      output.zipBytes = zipBuffer.length;
      output.zipSha256 = sha256Buffer(zipBuffer);
    }
    outputs.push(output);
  }
  const index = {
    formatVersion: 1,
    canonicalSource: path.basename(sourceRoot),
    canonicalTreeSha256: treeManifest("canonical", files).canonicalTreeSha256,
    outputs,
  };
  const indexPath = path.join(outRoot, "distribution-index.json");
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return { outRoot, indexPath, index };
}

function parseArgs(argv) {
  const options = { sourceRoot: null, outRoot: null, targets: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const equal = arg.indexOf("=");
    const name = equal >= 0 ? arg.slice(0, equal) : arg;
    const value = equal >= 0 ? arg.slice(equal + 1) : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--source") options.sourceRoot = value;
    else if (name === "--out") options.outRoot = value;
    else if (name === "--targets") options.targets = value === "all" ? Object.keys(TARGETS) : value.split(",").map((item) => item.trim()).filter(Boolean);
    else throw new Error(`unknown option: ${name}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${USAGE}\n${error.message}`);
    process.exit(64);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const result = await generateDistributions(options);
  console.log(result.indexPath);
}

module.exports = {
  BAILIAN_MAX_BYTES,
  TARGETS,
  USAGE,
  collectCanonicalFiles,
  createBailianZip,
  generateDistributions,
  isExcluded,
  parseArgs,
  treeManifest,
  validateBailianZip,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

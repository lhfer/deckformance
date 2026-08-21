"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MEASUREMENT_METHOD = "conservative-unicode-estimate-v1";
const FONTKIT_MEASUREMENT_METHOD = "fontkit-xadvance-v1";
const RESOLVER = "font-file-index-v1";
const TOKEN_FLOORS = Object.freeze({
  display: 50,
  headline: 35,
  subhead: 24,
  body: 16,
  caption: 12,
  data: 24,
  number: 35,
});
const REQUIRED_TOKENS = Object.freeze(Object.keys(TOKEN_FLOORS));
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc"]);
const OPENING_PUNCTUATION = new Set(Array.from("（［｛〔〈《「『【〘〖〝‘“"));
const CLOSING_PUNCTUATION = new Set(Array.from("、。，．！？；：）］｝〕〉》」』】〙〗〟’”％,.!?;:%)]}"));

function fail(message) {
  const error = new Error(message);
  error.isTypographyError = true;
  throw error;
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function normalizeFamily(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\p{Letter}\p{Number}]+/gu, "")
    .replace(/(regular|roman|book|medium|semibold|demibold|bold|light|thin|black|heavy|italic|oblique)$/u, "");
}

function familyVariants(value) {
  const normalized = normalizeFamily(value);
  const variants = new Set([normalized]);
  for (const suffix of ["display", "text", "sans", "serif", "sc", "tc", "pro", "std", "mt"]) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length + 2) {
      variants.add(normalized.slice(0, -suffix.length));
    }
  }
  return [...variants].filter(Boolean);
}

function defaultFontDirectories() {
  const directories = [];
  if (process.platform === "darwin") {
    directories.push(
      "/System/Library/Fonts",
      "/Library/Fonts",
      path.join(os.homedir(), "Library", "Fonts"),
    );
  } else if (process.platform === "win32") {
    directories.push(path.join(process.env.WINDIR || "C:\\Windows", "Fonts"));
  } else {
    directories.push(
      "/usr/share/fonts",
      "/usr/local/share/fonts",
      path.join(os.homedir(), ".fonts"),
      path.join(os.homedir(), ".local", "share", "fonts"),
    );
  }
  return directories;
}

function walkFontFiles(directory, output) {
  if (!directory || !fs.existsSync(directory)) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFontFiles(target, output);
    } else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(path.resolve(target));
    }
  }
}

function discoverFontFiles(extraDirectories = []) {
  const fromEnvironment = String(process.env.PPT_CAST_FONT_DIRS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const directories = [...extraDirectories, ...fromEnvironment, ...defaultFontDirectories()]
    .map((item) => path.resolve(item));
  const uniqueDirectories = [...new Set(directories)];
  const files = [];
  uniqueDirectories.forEach((directory) => walkFontFiles(directory, files));
  return [...new Set(files)];
}

function fontFileIsSupported(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    const signature = header.toString("ascii");
    return signature === "OTTO" || signature === "ttcf" || header.readUInt32BE(0) === 0x00010000;
  } finally {
    fs.closeSync(descriptor);
  }
}

function weightHintScore(filePath, weight) {
  const name = path.basename(filePath).toLowerCase();
  if (weight >= 700) return /(bold|heavy|black)/.test(name) ? 8 : 0;
  if (weight >= 500) return /(medium|semibold|demibold)/.test(name) ? 8 : 0;
  if (weight <= 300) return /(light|thin)/.test(name) ? 8 : 0;
  return /(regular|roman|book)/.test(name) ? 8 : 2;
}

function matchScore(filePath, family, weight) {
  const basename = path.basename(filePath, path.extname(filePath));
  const rawCandidate = String(basename).normalize("NFKD").toLowerCase().replace(/[^a-z0-9\p{Letter}\p{Number}]+/gu, "");
  const rawRequested = String(family).normalize("NFKD").toLowerCase().replace(/[^a-z0-9\p{Letter}\p{Number}]+/gu, "");
  const fileVariants = familyVariants(basename);
  const requestedVariants = familyVariants(family);
  let score = -1;
  for (const requested of requestedVariants) {
    for (const candidate of fileVariants) {
      if (candidate === requested) score = Math.max(score, 100);
      else if (candidate.startsWith(requested) || requested.startsWith(candidate)) score = Math.max(score, 80);
      else if (candidate.includes(requested) || requested.includes(candidate)) score = Math.max(score, 60);
    }
  }
  if (rawCandidate === rawRequested) score = Math.max(score, 120);
  return score < 0 ? score : score + weightHintScore(filePath, weight);
}

function resolveFontFile(families, weight, fontFiles) {
  for (const family of families) {
    const ranked = fontFiles
      .map((filePath) => ({ filePath, score: matchScore(filePath, family, weight) }))
      .filter((item) => item.score >= 60)
      .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath, "en"));
    for (const candidate of ranked) {
      if (fontFileIsSupported(candidate.filePath)) {
        return { family, filePath: candidate.filePath };
      }
    }
  }
  return null;
}

function loadFontkit() {
  try {
    return require("fontkit");
  } catch (error) {
    fail(`fontkit is required for candidate-ready typography measurement: ${error.message}`);
  }
}

function fontFaceScore(font, families, weight) {
  const names = [font.familyName, font.fullName, font.postscriptName, font.subfamilyName].filter(Boolean);
  let score = -1;
  for (const family of families) {
    for (const name of names) {
      const requested = familyVariants(family);
      const available = familyVariants(name);
      for (const left of requested) {
        for (const right of available) {
          if (left === right) score = Math.max(score, 100);
          else if (left.startsWith(right) || right.startsWith(left)) score = Math.max(score, 80);
          else if (left.includes(right) || right.includes(left)) score = Math.max(score, 60);
        }
      }
    }
  }
  const actualWeight = Number(font["OS/2"] && font["OS/2"].usWeightClass);
  if (Number.isFinite(actualWeight)) score -= Math.min(20, Math.abs(actualWeight - weight) / 50);
  return score;
}

function openFontFace(filePath, families, weight) {
  const fontkit = loadFontkit();
  const container = fontkit.openSync(filePath);
  const fonts = Array.isArray(container.fonts) ? container.fonts : [container];
  const ranked = fonts
    .map((font) => ({ font, score: fontFaceScore(font, families, weight) }))
    .sort((left, right) => right.score - left.score || String(left.font.postscriptName || "").localeCompare(String(right.font.postscriptName || ""), "en"));
  if (!ranked.length || ranked[0].score < 40) {
    fail(`fontkit could not identify a matching face in ${path.basename(filePath)} for [${families.join(", ")}]`);
  }
  return ranked[0].font;
}

function validateTypographyContract(typography) {
  if (!typography || typography.schemaVersion !== "2.0.0" || typography.measurementPolicy !== "fail-closed") {
    fail("typography must be a v2 fail-closed typography contract");
  }
  if (!typography.tokens || typeof typography.tokens !== "object") fail("typography.tokens is required");
  for (const name of REQUIRED_TOKENS) {
    const token = typography.tokens[name];
    if (!token || typeof token !== "object") fail(`typography token ${name} is required`);
    if (typeof token.family !== "string" || !token.family.trim()) fail(`typography token ${name}.family is required`);
    if (!Array.isArray(token.fallbacks) || token.fallbacks.length === 0 || token.fallbacks.some((value) => typeof value !== "string" || !value.trim())) {
      fail(`typography token ${name}.fallbacks must contain at least one family`);
    }
    const size = token.size;
    if (!size || ![size.min, size.preferred, size.max].every(Number.isFinite)) {
      fail(`typography token ${name}.size must define finite min, preferred, and max values`);
    }
    if (size.min < TOKEN_FLOORS[name]) {
      fail(`typography token ${name}.size.min ${size.min} is below the ${TOKEN_FLOORS[name]}pt floor`);
    }
    if (!(size.min <= size.preferred && size.preferred <= size.max)) {
      fail(`typography token ${name}.size must satisfy min <= preferred <= max`);
    }
    if (!Number.isFinite(token.lineHeight) || token.lineHeight < 1 || token.lineHeight > 1.8) {
      fail(`typography token ${name}.lineHeight must be between 1 and 1.8`);
    }
    if (!Number.isFinite(token.letterSpacing) || token.letterSpacing < -1 || token.letterSpacing > 4) {
      fail(`typography token ${name}.letterSpacing must be between -1 and 4`);
    }
    if (!Number.isInteger(token.maxLines) || token.maxLines < 1) fail(`typography token ${name}.maxLines must be a positive integer`);
  }
  const cjk = typography.cjk;
  if (!cjk || cjk.kinsoku !== true || cjk.orphanControl !== true) {
    fail("typography.cjk must enable kinsoku and orphanControl");
  }
}

function resolveTypography(typography, options = {}) {
  validateTypographyContract(typography);
  const fontFiles = discoverFontFiles(options.fontDirectories || []);
  if (fontFiles.length === 0) fail("no usable font files were found; provide --font-dir or set PPT_CAST_FONT_DIRS");
  const hashCache = new Map();
  const tokens = {};
  const runtimePaths = {};
  const fontObjects = {};
  let conservative = false;
  for (const name of REQUIRED_TOKENS) {
    const token = typography.tokens[name];
    const candidates = [token.family, ...token.fallbacks].map((value) => value.trim());
    const resolved = resolveFontFile(candidates, token.weight, fontFiles);
    if (!resolved) {
      fail(`font resolution failed for ${name}: none of [${candidates.join(", ")}] matched an installed font file`);
    }
    if (!hashCache.has(resolved.filePath)) hashCache.set(resolved.filePath, sha256File(resolved.filePath));
    runtimePaths[name] = resolved.filePath;
    let font = null;
    try {
      font = openFontFace(resolved.filePath, candidates, token.weight);
    } catch (error) {
      if (options.allowConservative !== true) throw error;
      conservative = true;
    }
    fontObjects[name] = font;
    tokens[name] = {
      requestedFamily: token.family,
      resolvedFamily: font && font.familyName || resolved.family,
      fileName: path.basename(resolved.filePath),
      postscriptName: font && font.postscriptName || null,
      sha256: hashCache.get(resolved.filePath),
      bytes: fs.statSync(resolved.filePath).size,
      resolver: RESOLVER,
      precision: font ? "fontkit" : "conservative",
    };
  }
  const receipt = {
    policy: "fail-closed",
    measurementMethod: conservative ? MEASUREMENT_METHOD : FONTKIT_MEASUREMENT_METHOD,
    tokens,
  };
  Object.defineProperty(receipt, "runtimePaths", {
    value: Object.freeze(runtimePaths),
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(receipt, "fontObjects", {
    value: Object.freeze(fontObjects),
    enumerable: false,
    writable: false,
  });
  return receipt;
}

function isCjk(character) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}

function characterWidthEm(character) {
  if (character === "\t") return 1.36;
  if (/\s/u.test(character)) return 0.36;
  if (isCjk(character)) return 1.05;
  if (/\p{Extended_Pictographic}/u.test(character)) return 1.15;
  if (/[MW@#%&]/u.test(character)) return 0.92;
  if (/[A-Z]/u.test(character)) return 0.78;
  if (/[a-z0-9]/u.test(character)) return 0.68;
  if (/[-–—_+=/\\|]/u.test(character)) return 0.62;
  if (/\p{Punctuation}/u.test(character)) return 0.5;
  return 0.78;
}

function graphemes(value) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((item) => item.segment);
  }
  return Array.from(value);
}

function lineWidthPt(value, fontSize, letterSpacing) {
  const items = graphemes(value);
  if (items.length === 0) return 0;
  const glyphWidth = items.reduce((sum, character) => sum + characterWidthEm(character) * fontSize, 0);
  return glyphWidth + Math.max(0, items.length - 1) * letterSpacing;
}

function textTokens(value) {
  const tokens = [];
  let buffer = "";
  let bufferKind = null;
  const flush = () => {
    if (buffer) tokens.push(buffer);
    buffer = "";
    bufferKind = null;
  };
  for (const character of graphemes(value)) {
    const kind = isCjk(character) || OPENING_PUNCTUATION.has(character) || CLOSING_PUNCTUATION.has(character)
      ? "atomic"
      : /\s/u.test(character)
        ? "space"
        : "word";
    if (kind === "atomic") {
      flush();
      tokens.push(character);
    } else if (bufferKind === null || bufferKind === kind) {
      buffer += character;
      bufferKind = kind;
    } else {
      flush();
      buffer = character;
      bufferKind = kind;
    }
  }
  flush();
  return tokens;
}

function splitOversizeToken(token, maxWidthPt, measureLine) {
  const output = [];
  let current = "";
  for (const character of graphemes(token)) {
    const candidate = current + character;
    if (current && measureLine(candidate) > maxWidthPt) {
      output.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) output.push(current);
  return output;
}

function wrapParagraph(value, maxWidthPt, measureLine) {
  const lines = [];
  let current = "";
  const pushCurrent = () => {
    const trimmed = current.trimEnd();
    if (trimmed) lines.push(trimmed);
    current = "";
  };
  const tokens = textTokens(value);
  for (const originalToken of tokens) {
    const pieces = measureLine(originalToken) > maxWidthPt
      ? splitOversizeToken(originalToken, maxWidthPt, measureLine)
      : [originalToken];
    for (const token of pieces) {
      if (!current && /^\s+$/u.test(token)) continue;
      const candidate = current + token;
      if (!current || measureLine(candidate) <= maxWidthPt) {
        current = candidate;
        continue;
      }
      if (CLOSING_PUNCTUATION.has(token)) {
        current += token;
        continue;
      }
      if (OPENING_PUNCTUATION.has(graphemes(current).at(-1))) {
        const currentItems = graphemes(current);
        const opening = currentItems.pop();
        current = currentItems.join("");
        pushCurrent();
        current = opening + token;
        continue;
      }
      pushCurrent();
      current = token.replace(/^\s+/u, "");
    }
  }
  pushCurrent();
  return lines;
}

function applyOrphanControl(lines, maxWidthPt, measureLine) {
  if (lines.length < 2 || graphemes(lines.at(-1)).length !== 1) return lines;
  const previous = graphemes(lines.at(-2));
  if (previous.length < 3) return lines;
  const moved = previous.pop();
  const next = moved + lines.at(-1);
  if (measureLine(next) > maxWidthPt) return lines;
  return [...lines.slice(0, -2), previous.join("").trimEnd(), next];
}

function wrapText(value, maxWidthPt, fontSize, letterSpacing, cjkPolicy, measureLineOverride) {
  const measureLine = measureLineOverride || ((line) => lineWidthPt(line, fontSize, letterSpacing));
  const paragraphs = String(value).replace(/\r\n?/g, "\n").split("\n");
  const lines = [];
  paragraphs.forEach((paragraph, index) => {
    const wrapped = wrapParagraph(paragraph, maxWidthPt, measureLine);
    if (wrapped.length === 0) lines.push("");
    else lines.push(...wrapped);
    if (index < paragraphs.length - 1 && paragraph === "") lines.push("");
  });
  return cjkPolicy && cjkPolicy.orphanControl
    ? applyOrphanControl(lines, maxWidthPt, measureLine)
    : lines;
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function fontkitWidthPt(font, value, fontSize, letterSpacing) {
  const run = font.layout(value);
  const advance = run.positions.reduce((sum, position) => sum + Number(position.xAdvance || 0), 0);
  const glyphCount = run.glyphs.length;
  return advance * fontSize / font.unitsPerEm + Math.max(0, glyphCount - 1) * letterSpacing;
}

function fitText({ text, box, styleToken, typography, fontResolution, layerId, allowConservative = false }) {
  const token = typography.tokens[styleToken];
  if (!token) fail(`layer ${layerId} references unknown typography token ${styleToken}`);
  if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) {
    fail(`layer ${layerId} has an invalid text box`);
  }
  if (typeof text !== "string" || !text.trim()) fail(`layer ${layerId} has no measurable text`);
  const maxWidthPt = box.w * 72;
  const maxHeightPt = box.h * 72;
  const font = fontResolution && fontResolution.fontObjects && fontResolution.fontObjects[styleToken];
  if (!font && !allowConservative) {
    fail(`layer ${layerId} requires fontkit precision for candidate-ready text fitting`);
  }
  const measurementMethod = font ? FONTKIT_MEASUREMENT_METHOD : MEASUREMENT_METHOD;
  const start = Math.min(token.size.preferred, token.size.max);
  for (let fontSize = start; fontSize >= token.size.min - 1e-9; fontSize -= 0.5) {
    const size = round(fontSize, 1);
    const measureLine = font
      ? (line) => fontkitWidthPt(font, line, size, token.letterSpacing)
      : (line) => lineWidthPt(line, size, token.letterSpacing);
    const lines = wrapText(text, maxWidthPt, size, token.letterSpacing, typography.cjk, measureLine);
    const estimatedWidthPt = Math.max(...lines.map(measureLine));
    const estimatedHeightPt = lines.length * size * token.lineHeight;
    if (lines.length <= token.maxLines && estimatedWidthPt <= maxWidthPt + 1e-6 && estimatedHeightPt <= maxHeightPt + 1e-6) {
      return {
        layerId,
        styleToken,
        fontSize: size,
        lineHeight: token.lineHeight,
        letterSpacing: token.letterSpacing,
        lines,
        estimatedWidthPt: round(estimatedWidthPt),
        estimatedHeightPt: round(estimatedHeightPt),
        box: { ...box },
        fit: true,
        measurementMethod,
      };
    }
  }
  fail(
    `text fit failed for layer ${layerId}: content cannot fit ${round(maxWidthPt)}x${round(maxHeightPt)}pt `
    + `without going below ${token.size.min}pt or exceeding ${token.maxLines} lines`,
  );
}

module.exports = {
  FONTKIT_MEASUREMENT_METHOD,
  MEASUREMENT_METHOD,
  REQUIRED_TOKENS,
  RESOLVER,
  TOKEN_FLOORS,
  discoverFontFiles,
  fitText,
  fontkitWidthPt,
  lineWidthPt,
  normalizeFamily,
  resolveTypography,
  sha256File,
  validateTypographyContract,
  wrapText,
};

"use strict";

const { lineWidthPt } = require("./typography");

const TEMPLATE_ID = "felt_editorial_split_master";
const MEDIA_SIDES = Object.freeze(["media-left", "media-right"]);
const ALLOWED_INPUT_KEYS = Object.freeze([
  "mediaSide",
  "eyebrowOrIcon",
  "pageNumber",
  "headline",
  "body",
  "closingLine",
  "videoPoster",
  "videoSlot",
  "characterSet",
]);
const DEFAULT_PROTECTED_PHRASES = Object.freeze([
  "一句话",
  "千问办公",
  "AI 办公",
  "工作流",
  "企业协作",
  "协作链路",
  "你的工作",
  "同一入口",
  "同一套能力",
  "交付闭环",
  "下一次交付",
]);
const CANDIDATE_RATIOS = Object.freeze([
  Object.freeze({ id: "A", media: 0.54, panel: 0.46, note: "reference-near, copy-comfort" }),
  Object.freeze({ id: "B", media: 0.57, panel: 0.43, note: "selected, balanced, near-6:5-media" }),
  Object.freeze({ id: "C", media: 0.60, panel: 0.40, note: "visual-first, narrow-copy-measure" }),
]);

function graphemeCount(value) {
  return graphemeRecords(value).length;
}

function detectProtectedPhrases(value, options = {}) {
  const text = String(value || "").normalize("NFC");
  const phrases = [...new Set((options.protectedPhrases || [])
    .filter((item) => typeof item === "string")
    .map((item) => item.normalize("NFC").trim())
    .filter(Boolean))]
    .sort((left, right) => graphemeCount(right) - graphemeCount(left) || left.localeCompare(right, "zh-CN"));
  const spans = [];
  for (const phrase of phrases) {
    let start = 0;
    while (start <= text.length - phrase.length) {
      const index = text.indexOf(phrase, start);
      if (index < 0) break;
      spans.push({ text: phrase, start: index, end: index + phrase.length, protected: true });
      start = index + phrase.length;
    }
  }
  return spans.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
}

function fail(message) {
  throw new Error(`${TEMPLATE_ID}: ${message}`);
}

function round(value, digits = 4) {
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function normalizeString(value, label, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return "";
    fail(`${label} is required`);
  }
  const text = String(value).normalize("NFC").trim();
  if (!text && !allowEmpty) fail(`${label} must be non-empty`);
  return text;
}

function normalizeBody(value) {
  const values = Array.isArray(value) ? value : [value];
  const body = values
    .filter((item) => item !== undefined && item !== null)
    .map((item) => String(item).normalize("NFC").trim())
    .filter(Boolean);
  if (!body.length) fail("body must contain at least one non-empty unit");
  return body;
}

function safeJobRelativePath(value, label) {
  const normalized = normalizeString(value, label).replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) fail(`${label} must be job-relative`);
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} contains an unsafe path segment`);
  return normalized;
}

function normalizeCharacterSet(value) {
  if (value === undefined || value === null) return null;
  const input = Array.isArray(value) ? { referenceImages: value } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("characterSet must be an object or an array of uploaded image paths");
  const allowed = ["referenceImages", "description", "preserveIdentity"];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`characterSet contains unsupported keys: ${unknown.join(", ")}`);
  const references = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  if (references.length < 1 || references.length > 2) fail("characterSet.referenceImages must contain one or two uploaded images");
  return {
    referenceImages: references.map((item, index) => safeJobRelativePath(item, `characterSet.referenceImages[${index}]`)),
    description: normalizeString(input.description, "characterSet.description", { allowEmpty: true }),
    preserveIdentity: input.preserveIdentity !== false,
  };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("input must be an object");
  const unknown = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.includes(key));
  if (unknown.length) fail(`unsupported input keys: ${unknown.join(", ")}`);
  const mediaSide = input.mediaSide || "media-left";
  if (!MEDIA_SIDES.includes(mediaSide)) fail(`mediaSide must be one of ${MEDIA_SIDES.join(", ")}`);
  return {
    mediaSide,
    eyebrowOrIcon: input.eyebrowOrIcon !== false,
    pageNumber: normalizeString(input.pageNumber, "pageNumber", { allowEmpty: true }),
    headline: normalizeString(input.headline, "headline"),
    body: normalizeBody(input.body),
    closingLine: normalizeString(input.closingLine, "closingLine"),
    videoPoster: normalizeString(input.videoPoster, "videoPoster"),
    videoSlot: input.videoSlot || null,
    characterSet: normalizeCharacterSet(input.characterSet),
  };
}

function ratioRecord(value) {
  if (value === undefined || value === null) return CANDIDATE_RATIOS[1];
  if (typeof value === "string") {
    const byId = CANDIDATE_RATIOS.find((candidate) => candidate.id === value.toUpperCase());
    if (byId) return byId;
  }
  const numeric = Number(value);
  const byNumber = CANDIDATE_RATIOS.find((candidate) => Math.abs(candidate.media - numeric) < 1e-9);
  if (!byNumber) fail("ratio must be candidate A/0.54, B/0.57, or C/0.60");
  return byNumber;
}

function geometryForFeltMaster({ slideWidth, slideHeight, mediaSide = "media-left", ratio = "B" }) {
  if (!(Number(slideWidth) > 0) || !(Number(slideHeight) > 0)) fail("slideWidth and slideHeight must be positive");
  if (!MEDIA_SIDES.includes(mediaSide)) fail(`mediaSide must be one of ${MEDIA_SIDES.join(", ")}`);
  const selectedRatio = ratioRecord(ratio);
  const cardWidth = Number(slideWidth) * 0.9;
  const cardHeight = cardWidth / 2.08;
  if (cardHeight > Number(slideHeight) * 0.86) fail("slide is too narrow for the 2.08:1 centered card contract");
  const card = {
    left: (Number(slideWidth) - cardWidth) / 2,
    top: (Number(slideHeight) - cardHeight) / 2,
    width: cardWidth,
    height: cardHeight,
  };
  const mediaWidth = cardWidth * selectedRatio.media;
  const panelWidth = cardWidth - mediaWidth;
  const media = mediaSide === "media-left"
    ? { left: card.left, top: card.top, width: mediaWidth, height: cardHeight }
    : { left: card.left + panelWidth, top: card.top, width: mediaWidth, height: cardHeight };
  const panel = mediaSide === "media-left"
    ? { left: card.left + mediaWidth, top: card.top, width: panelWidth, height: cardHeight }
    : { left: card.left, top: card.top, width: panelWidth, height: cardHeight };
  const padding = panelWidth * 0.095;
  const contentWidth = panelWidth - padding * 2;
  const textLeft = panel.left + padding;
  const zones = {
    header: { left: textLeft, top: card.top + cardHeight * 0.085, width: contentWidth, height: cardHeight * 0.065 },
    headline: { left: textLeft, bottom: card.top + cardHeight * 0.54, width: contentWidth, maxHeight: cardHeight * 0.285 },
    body: { left: textLeft, top: card.top + cardHeight * 0.61, width: contentWidth, height: cardHeight * 0.155 },
    closing: { left: textLeft, top: card.top + cardHeight * 0.82, width: contentWidth, height: cardHeight * 0.075 },
  };
  return {
    templateId: TEMPLATE_ID,
    family: "editorial-split",
    variant: mediaSide,
    ratio: { ...selectedRatio },
    card: Object.fromEntries(Object.entries(card).map(([key, value]) => [key, round(value)])),
    media: Object.fromEntries(Object.entries(media).map(([key, value]) => [key, round(value)])),
    panel: Object.fromEntries(Object.entries(panel).map(([key, value]) => [key, round(value)])),
    padding: round(padding),
    cornerRadius: round(Number(slideWidth) * 0.011),
    seamOverlap: round(cardWidth * 0.0156),
    zones: Object.fromEntries(Object.entries(zones).map(([name, zone]) => [name, Object.fromEntries(Object.entries(zone).map(([key, value]) => [key, round(value)]))])),
    mediaContract: {
      preferredAspect: "6:5",
      renderedAspect: round(mediaWidth / cardHeight, 3),
      fit: "cover",
      centralSafeArea: 0.72,
      sourceTextBurnedIn: false,
      environment: {
        required: true,
        depthLayers: ["foreground", "midground", "background"],
        rule: "Use a story-specific felt miniature environment; clean hierarchy must not collapse into a plain studio wall or empty tabletop.",
      },
    },
    edgeTreatment: {
      type: "source-derived-alpha-mask",
      fill: "#F3EAE1",
      asset: "assets/felt-edge-negative-mask.png",
      packagedAsset: ".grok/skills/ppt-cast/assets/felt-edge-negative-mask.png",
      provenance: "source-derived from the user-supplied felt-card reference; reference image is not a runtime dependency",
      sourceBox: [23, 6, 631, 300],
      sourceSize: [608, 294],
      sourceAspect: 2.06803,
      targetSize: [round(cardWidth), round(cardHeight)],
      inheritsUnderlyingColor: true,
    },
  };
}

function characterPromptContextForFeltMaster(characterSet) {
  const normalized = normalizeCharacterSet(characterSet);
  if (!normalized) {
    return {
      fixedCharacterIdentity: false,
      referenceImages: [],
      instruction: "No default character is defined by the template. Use the scene brief without inventing a locked template mascot.",
    };
  }
  return {
    fixedCharacterIdentity: true,
    referenceImages: normalized.referenceImages.map((image, index) => ({
      image,
      role: `user-uploaded-character-reference-${index + 1}`,
    })),
    description: normalized.description,
    preserveIdentity: normalized.preserveIdentity,
    instruction: "Use the uploaded images only as character identity references. Preserve recognizable silhouette, face, colors, costume, and material cues while recomposing the scene for the near-6:5 safe area. Do not copy the reference crop or background.",
  };
}

function graphemeRecords(value) {
  const text = String(value || "");
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
    return [...segmenter.segment(text)].map((item) => ({ text: item.segment, start: item.index, end: item.index + item.segment.length }));
  }
  const records = [];
  let index = 0;
  for (const character of Array.from(text)) {
    records.push({ text: character, start: index, end: index + character.length });
    index += character.length;
  }
  return records;
}

function phraseBreakIsSafe(index, protectedSpans) {
  return !protectedSpans.some((span) => index > span.start && index < span.end);
}

function titleCandidates(text, options) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const flat = normalized.replace(/\s*\n\s*/g, "");
  const phrases = [...DEFAULT_PROTECTED_PHRASES, ...(options.protectedPhrases || [])];
  const spans = detectProtectedPhrases(flat, { protectedPhrases: phrases });
  const records = graphemeRecords(flat);
  const candidates = new Map();
  const add = (lines, source) => {
    const clean = lines.map((line) => line.trim()).filter(Boolean);
    if (!clean.length || clean.length > 3 || clean.join("") !== flat) return;
    const key = clean.join("\n");
    const existing = candidates.get(key);
    if (!existing || source === "explicit-editorial-break") candidates.set(key, { lines: clean, source });
  };
  add([flat], "complete-one-line");
  if (normalized.includes("\n")) add(normalized.split("\n"), "explicit-editorial-break");
  for (let first = 1; first < records.length; first += 1) {
    const index = records[first].start;
    if (!phraseBreakIsSafe(index, spans)) continue;
    add([flat.slice(0, index), flat.slice(index)], "semantic-two-line");
  }
  if (records.length >= 9) {
    for (let first = 1; first < records.length - 1; first += 1) {
      const firstIndex = records[first].start;
      if (!phraseBreakIsSafe(firstIndex, spans)) continue;
      for (let second = first + 1; second < records.length; second += 1) {
        const secondIndex = records[second].start;
        if (!phraseBreakIsSafe(secondIndex, spans)) continue;
        add([flat.slice(0, firstIndex), flat.slice(firstIndex, secondIndex), flat.slice(secondIndex)], "semantic-three-line");
      }
    }
  }
  return { flat, spans, candidates: [...candidates.values()] };
}

function headline_shaping_for_felt_master(headline, options = {}) {
  const text = normalizeString(headline, "headline");
  const fontSizePt = Number(options.fontSizePt || 36);
  const panelWidthPt = Number(options.panelWidthPt || 222);
  const measureLine = typeof options.measureLine === "function"
    ? options.measureLine
    : (line) => lineWidthPt(line, fontSizePt, Number(options.letterSpacing || 0));
  const generated = titleCandidates(text, options);
  const totalCount = Math.max(1, graphemeCount(generated.flat));
  const preferredPhraseBreaks = DEFAULT_PROTECTED_PHRASES
    .filter((phrase) => generated.flat.startsWith(phrase) && phrase.length < generated.flat.length)
    .map((phrase) => phrase.length);
  const ranked = generated.candidates.map((candidate) => {
    const widths = candidate.lines.map((line) => measureLine(line));
    const maxWidth = Math.max(...widths);
    const minWidth = Math.min(...widths);
    const counts = candidate.lines.map((line) => graphemeCount(line));
    const imbalance = candidate.lines.length === 1 ? 0 : (Math.max(...counts) - Math.min(...counts)) / totalCount;
    const oneCharacterLine = counts.some((count) => count === 1 && totalCount > 3);
    const fitTolerance = Number(options.fitTolerance || 1.03);
    const eligible = maxWidth <= panelWidthPt * fitTolerance && !oneCharacterLine;
    const explicitBonus = candidate.source === "explicit-editorial-break" ? 36 : 0;
    const balancedBonus = candidate.lines.length === 2 && imbalance <= 0.18 ? 18 : 0;
    const phraseBonus = candidate.lines.length === 2 && preferredPhraseBreaks.includes(candidate.lines[0].length) ? 16 : 0;
    const confidentOneLine = candidate.lines.length === 1 && maxWidth <= panelWidthPt * 0.9 ? 15 : 0;
    const shortTitleOneLineBonus = candidate.lines.length === 1 && totalCount <= 6 ? 24 : 0;
    const densityPenalty = candidate.lines.length === 1 && maxWidth > panelWidthPt * 0.94 ? 22 : 0;
    const linePenalty = Math.max(0, candidate.lines.length - 2) * 10;
    const score = (eligible ? 100 : 0) + explicitBonus + balancedBonus + phraseBonus + confidentOneLine + shortTitleOneLineBonus
      - imbalance * 45 - densityPenalty - linePenalty - (oneCharacterLine ? 100 : 0);
    return {
      ...candidate,
      text: candidate.lines.join("\n"),
      widthsPt: widths.map((value) => round(value, 2)),
      maxWidthPt: round(maxWidth, 2),
      imbalance: round(imbalance, 3),
      oneCharacterLine,
      protectedPhraseSplit: false,
      eligible,
      score: round(score, 2),
    };
  }).sort((left, right) => Number(right.eligible) - Number(left.eligible)
    || right.score - left.score
    || left.lines.length - right.lines.length
    || left.text.localeCompare(right.text, "zh-CN"));
  const selected = ranked.find((candidate) => candidate.eligible) || ranked[0] || null;
  return {
    templateId: TEMPLATE_ID,
    original: text,
    selected,
    candidates: ranked.slice(0, Math.max(3, Number(options.maxCandidates || 6))),
    protectedPhrases: generated.spans,
  };
}

function sentenceUnits(value) {
  return normalizeBody(value).flatMap((paragraph) => {
    const parts = paragraph.match(/[^。！？!?；;]+[。！？!?；;]?/gu) || [];
    return parts.map((part) => part.trim()).filter(Boolean);
  });
}

function editorialPunctuation(unit) {
  return unit
    .replace(/文档表格PPT网页/gu, "文档、表格、PPT、网页")
    .replace(/数据视频网页/gu, "数据、视频、网页")
    .replace(/桌面网页钉钉/gu, "桌面、网页、钉钉")
    .replace(/消息日程文档/gu, "消息、日程、文档")
    .replace(/，{2,}/gu, "，");
}

function body_shaping_for_felt_master(body, closingLine, options = {}) {
  const original = normalizeBody(body);
  const closing = normalizeString(closingLine, "closingLine");
  const candidates = [];
  const add = (id, units, reason) => {
    const clean = units.map((unit) => unit.normalize("NFC").trim()).filter(Boolean);
    const key = clean.join("\n");
    if (!key || candidates.some((candidate) => candidate.key === key)) return;
    const counts = clean.map((unit) => graphemeCount(unit.replace(/[\p{Punctuation}\s]/gu, "")));
    const validCount = clean.length >= 2 && clean.length <= 4;
    const shortOrphan = counts.some((count) => count <= 1);
    const maxUnit = Math.max(...counts);
    const score = (validCount ? 100 : 0) - (shortOrphan ? 100 : 0) - Math.max(0, maxUnit - Number(options.preferredMaxGraphemes || 18)) * 2;
    candidates.push({ id, key, units: clean, closingLine: closing, reason, counts, validCount, shortOrphan, score });
  };
  add("original-units", original, "Preserve the approved body units as authored.");
  const sentences = sentenceUnits(original);
  add("sentence-units", sentences, "Expose source sentence boundaries as short editorial units.");
  add("editorial-punctuation", sentences.map(editorialPunctuation), "Clarify existing enumerations with punctuation without adding factual words.");
  const ranked = candidates.sort((left, right) => right.score - left.score || left.units.length - right.units.length || left.id.localeCompare(right.id, "en"));
  const selected = ranked.find((candidate) => candidate.validCount && !candidate.shortOrphan) || ranked[0];
  return {
    templateId: TEMPLATE_ID,
    original,
    closingLine: closing,
    selected,
    candidates: ranked,
  };
}

function createFeltMasterModel(input, options = {}) {
  const normalized = validateInput(input);
  const geometry = geometryForFeltMaster({
    slideWidth: options.slideWidth || 1280,
    slideHeight: options.slideHeight || 720,
    mediaSide: normalized.mediaSide,
    ratio: options.ratio || "B",
  });
  const panelWidthPt = Number(options.panelWidthPt || geometry.zones.headline.width * 72 / (options.unitsPerInch || 96));
  return {
    templateId: TEMPLATE_ID,
    variables: normalized,
    geometry,
    headlineShaping: headline_shaping_for_felt_master(normalized.headline, {
      ...options.headline,
      panelWidthPt,
    }),
    bodyShaping: body_shaping_for_felt_master(normalized.body, normalized.closingLine, options.body),
    characterPromptContext: characterPromptContextForFeltMaster(normalized.characterSet),
  };
}

const felt_editorial_split_master = Object.freeze({
  id: TEMPLATE_ID,
  family: "editorial-split",
  selectedRatio: "B",
  candidateRatios: CANDIDATE_RATIOS,
  variants: MEDIA_SIDES,
  variables: ALLOWED_INPUT_KEYS,
  palette: Object.freeze({ canvas: "#F3EAE1", panel: "#232424", title: "#F6F2EC", body: "#C8C4BD", closing: "#F2EEE8" }),
  geometry: geometryForFeltMaster,
  createModel: createFeltMasterModel,
});

module.exports = {
  ALLOWED_INPUT_KEYS,
  CANDIDATE_RATIOS,
  DEFAULT_PROTECTED_PHRASES,
  MEDIA_SIDES,
  TEMPLATE_ID,
  body_shaping_for_felt_master,
  createFeltMasterModel,
  characterPromptContextForFeltMaster,
  felt_editorial_split_master,
  geometryForFeltMaster,
  headline_shaping_for_felt_master,
};

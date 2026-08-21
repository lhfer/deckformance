#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  const error = new Error(message);
  error.isUserError = true;
  throw error;
}

function hex(value, fallback = "000000") {
  const normalized = String(value || fallback).replace(/^#/, "").toUpperCase();
  if (!/^[A-F0-9]{6}$/.test(normalized)) fail(`invalid color: ${String(value)}`);
  return normalized;
}

function box(value, label = "layer.box") {
  if (!value || !["x", "y", "w", "h"].every((key) => Number.isFinite(Number(value[key])))) {
    fail(`${label} must define finite x, y, w, and h`);
  }
  const result = { x: Number(value.x), y: Number(value.y), w: Number(value.w), h: Number(value.h) };
  if (result.x < 0 || result.y < 0 || result.w <= 0 || result.h <= 0 || result.x + result.w > 10.0001 || result.y + result.h > 5.6251) {
    fail(`${label} leaves the 10 x 5.625 slide canvas`);
  }
  return result;
}

function safeAsset(jobDir, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim()) fail(`${label} is required`);
  const value = relativePath.trim();
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${label} must be a safe job-relative POSIX path`);
  }
  const root = fs.realpathSync(jobDir);
  const candidate = path.resolve(root, ...value.split("/"));
  const lexical = path.relative(root, candidate);
  if (lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) fail(`${label} leaves the job directory`);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) fail(`${label} not found: ${value}`);
  const real = fs.realpathSync(candidate);
  const resolved = path.relative(root, real);
  if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) fail(`${label} resolves outside the job directory`);
  return real;
}

function pngDataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function objectMetadata(layer) {
  return {
    objectName: layer.id,
    altText: layer.altText || `${layer.type} layer ${layer.id}`,
  };
}

function palette(theme) {
  const values = theme && theme.palette || {};
  return {
    bg: hex(values.bg, "F4EFE6"),
    panel: hex(values.panel, "1C1C1C"),
    title: hex(values.title, "F7F4EF"),
    body: hex(values.body, "C4BFB6"),
    muted: hex(values.muted, "8E8A84"),
    accent: hex(values.accent, "D56B32"),
    ink: hex(values.ink, "1C1C1C"),
    inkMuted: hex(values.inkMuted, "6B6560"),
  };
}

function tokenFor(theme, layer, fallbackToken) {
  const tokenName = layer.styleToken || fallbackToken;
  const tokens = theme && theme.typography && theme.typography.tokens || {};
  const token = tokens[tokenName] || {};
  const resolved = layer.resolvedStyle || {};
  const size = resolved.fontSize || resolved.sizePt || token.size && token.size.preferred;
  const family = resolved.fontFace || resolved.family || token.family;
  if (!family || !Number.isFinite(Number(size))) fail(`${layer.id} is missing resolved typography for ${tokenName}`);
  return {
    tokenName,
    fontFace: String(family),
    fontSize: Number(size),
    bold: Number(resolved.weight || token.weight || 400) >= 600,
    charSpacing: Number(resolved.letterSpacing ?? token.letterSpacing ?? 0),
    lineSpacingMultiple: Number(resolved.lineHeight ?? token.lineHeight ?? 1.15),
  };
}

function textOptions(layer, theme, fallbackToken, color, extra = {}) {
  const style = tokenFor(theme, layer, fallbackToken);
  return {
    ...box(layer.box, `${layer.id}.box`),
    ...objectMetadata(layer),
    fontFace: style.fontFace,
    fontSize: style.fontSize,
    bold: style.bold,
    charSpacing: style.charSpacing,
    lineSpacingMultiple: style.lineSpacingMultiple,
    color,
    margin: 0,
    breakLine: false,
    valign: layer.valign || "top",
    align: layer.align || "left",
    ...extra,
  };
}

function addTextLayer(slide, layer, context, colors) {
  const fallback = layer.type === "headline" ? "headline" : layer.type === "annotation" ? "caption" : "body";
  const fit = context.textFitByLayer && context.textFitByLayer.get(layer.id);
  const text = fit && Array.isArray(fit.lines) && fit.lines.length
    ? fit.lines.join("\n")
    : Array.isArray(layer.text) ? layer.text.join("\n") : String(layer.text || "");
  if (!text) fail(`${layer.id}.text is required`);
  const color = hex(layer.color, layer.type === "headline" ? colors.ink : colors.inkMuted);
  slide.addText(text, textOptions(layer, context.theme, fallback, color));
}

function addMetric(slide, layer, theme, colors) {
  const region = box(layer.box, `${layer.id}.box`);
  const data = layer.data || {};
  const value = String(layer.value ?? data.value ?? layer.text ?? "");
  if (!value) fail(`${layer.id}.value is required`);
  const label = String(layer.label ?? data.label ?? "");
  const valueBox = { x: region.x, y: region.y, w: region.w, h: Math.max(0.45, region.h * 0.62) };
  const labelBox = { x: region.x, y: region.y + valueBox.h, w: region.w, h: Math.max(0.25, region.h - valueBox.h) };
  slide.addText(value, textOptions({ ...layer, box: valueBox, styleToken: layer.styleToken || "data" }, theme, "data", hex(layer.color, colors.accent), { valign: "bottom" }));
  if (label) slide.addText(label, textOptions({ ...layer, id: `${layer.id}-label`, box: labelBox, styleToken: "caption" }, theme, "caption", hex(layer.labelColor, colors.inkMuted), { valign: "top" }));
}

function addQuote(slide, pres, layer, theme, colors) {
  const region = box(layer.box, `${layer.id}.box`);
  const data = layer.data || {};
  const quote = String(layer.text ?? data.text ?? data.quote ?? "");
  if (!quote) fail(`${layer.id} quote text is required`);
  const attribution = String(data.attribution || "");
  slide.addShape(pres.shapes.LINE, {
    x: region.x,
    y: region.y,
    w: 0,
    h: region.h,
    line: { color: hex(layer.accentColor, colors.accent), width: 3 },
    objectName: `${layer.id}-accent`,
  });
  const quoteHeight = attribution ? region.h * 0.76 : region.h;
  slide.addText(quote, textOptions({ ...layer, box: { x: region.x + 0.22, y: region.y, w: region.w - 0.22, h: quoteHeight } }, theme, "subhead", hex(layer.color, colors.ink), { italic: true }));
  if (attribution) {
    slide.addText(attribution, textOptions({
      ...layer,
      id: `${layer.id}-attribution`,
      box: { x: region.x + 0.22, y: region.y + quoteHeight, w: region.w - 0.22, h: region.h - quoteHeight },
      styleToken: "caption",
    }, theme, "caption", hex(layer.attributionColor, colors.inkMuted), { valign: "bottom" }));
  }
}

function addImage(slide, layer, context) {
  const registered = layer.assetId && context.assetById && context.assetById.get(layer.assetId);
  const relativePath = layer.path || registered && registered.path;
  const filePath = safeAsset(context.jobDir, relativePath, `${layer.id}.path`);
  slide.addImage({ path: filePath, ...box(layer.box, `${layer.id}.box`), ...objectMetadata(layer) });
}

function addVideo(slide, layer, context) {
  if (context.previewMode === true) {
    const region = box(layer.box, `${layer.id}.box`);
    const colors = palette(context.theme);
    slide.addShape(context.pres.shapes.RECTANGLE, {
      ...region,
      ...objectMetadata(layer),
      fill: { color: colors.panel, transparency: 88 },
      line: { color: colors.accent, width: 1.4, dash: "dash" },
    });
    const slot = layer.slot || {};
    slide.addText(`VIDEO SLOT\n${slot.aspect || "unresolved"} · ${slot.widthPx || "?"}×${slot.heightPx || "?"}`, {
      x: region.x + 0.15,
      y: region.y + Math.max(0.15, region.h / 2 - 0.28),
      w: Math.max(0.2, region.w - 0.3),
      h: 0.56,
      objectName: `${layer.id}-preview-label`,
      fontFace: "Arial",
      fontSize: 12,
      bold: true,
      color: colors.accent,
      align: "center",
      valign: "mid",
      margin: 0,
    });
    return;
  }
  const media = context.mediaByLayer && context.mediaByLayer.get(layer.id);
  if (!media) fail(`${layer.id} has no validated media binding`);
  if (media.externalGenerationVerified !== true) fail(`${layer.id} has no verified external video generation binding`);
  slide.addMedia({
    ...box(layer.box, `${layer.id}.box`),
    ...objectMetadata(layer),
    type: "video",
    path: media.videoPath,
    cover: pngDataUrl(media.posterPath),
  });
  context.videoSlides.push({
    slideNumber: context.slideNumber,
    layerId: layer.id,
    durationMs: media.durationMs,
    volume: 0,
    videoSha256: media.videoSha256,
    posterSha256: media.posterSha256,
    motionPlan: context.motionPlan || null,
  });
}

function addChart(slide, pres, layer, colors) {
  const data = layer.data || {};
  const kind = data.kind === "donut" ? "doughnut" : data.kind;
  if (!pres.ChartType[kind]) fail(`${layer.id} has unsupported chart kind ${String(data.kind)}`);
  const categories = data.categories || [];
  const series = (data.series || []).map((item) => ({ name: String(item.name), labels: categories.map(String), values: item.values.map(Number) }));
  if (!series.length || !categories.length || series.some((item) => item.values.length !== categories.length || item.values.some((value) => !Number.isFinite(value)))) {
    fail(`${layer.id} chart data is incomplete or mismatched`);
  }
  slide.addChart(pres.ChartType[kind], series, {
    ...box(layer.box, `${layer.id}.box`),
    ...objectMetadata(layer),
    showLegend: series.length > 1,
    showTitle: false,
    showValue: true,
    showCategoryName: false,
    chartColors: [colors.accent, colors.ink, colors.muted, colors.inkMuted],
    catAxisLabelColor: colors.inkMuted,
    valAxisLabelColor: colors.inkMuted,
    showCatName: false,
    showValAxisTitle: false,
    showCatAxisTitle: false,
    border: { color: colors.bg, transparency: 100 },
  });
}

function addTable(slide, layer, theme, colors) {
  const data = layer.data || {};
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (columns.length < 2 || rows.length < 1 || rows.some((row) => !Array.isArray(row) || row.length !== columns.length)) {
    fail(`${layer.id} table rows must match its columns`);
  }
  const style = tokenFor(theme, { ...layer, styleToken: layer.styleToken || "caption" }, "caption");
  slide.addTable([columns, ...rows].map((row) => row.map((value) => value === null ? "" : String(value))), {
    ...box(layer.box, `${layer.id}.box`),
    ...objectMetadata(layer),
    fontFace: style.fontFace,
    fontSize: Math.max(12, style.fontSize),
    color: colors.ink,
    border: { type: "solid", color: colors.muted, pt: 0.5 },
    fill: { color: colors.bg },
    margin: 0.06,
    bold: false,
    autoFit: false,
    rowH: 0.34,
  });
}

function addTimeline(slide, pres, layer, theme, colors) {
  const region = box(layer.box, `${layer.id}.box`);
  const items = layer.data && layer.data.items || [];
  if (items.length < 2) fail(`${layer.id} timeline needs at least two items`);
  const y = region.y + region.h * 0.33;
  const start = region.x + 0.18;
  const end = region.x + region.w - 0.18;
  slide.addShape(pres.shapes.LINE, { x: start, y, w: end - start, h: 0, line: { color: colors.muted, width: 1.4 }, objectName: `${layer.id}-connector` });
  const gap = (end - start) / (items.length - 1);
  items.forEach((item, index) => {
    const x = start + gap * index;
    slide.addShape(pres.shapes.OVAL, { x: x - 0.08, y: y - 0.08, w: 0.16, h: 0.16, fill: { color: colors.accent }, line: { color: colors.accent }, objectName: `${layer.id}-node-${index + 1}` });
    slide.addText(String(item.label), textOptions({ id: `${layer.id}-label-${index + 1}`, type: "annotation", styleToken: "caption", box: { x: Math.max(region.x, x - gap * 0.42), y: y + 0.18, w: Math.min(gap * 0.84, region.x + region.w - Math.max(region.x, x - gap * 0.42)), h: region.h * 0.24 }, align: "center", text: item.label }, theme, "caption", colors.ink));
    if (item.detail) slide.addText(String(item.detail), textOptions({ id: `${layer.id}-detail-${index + 1}`, type: "annotation", styleToken: "caption", box: { x: Math.max(region.x, x - gap * 0.42), y: y + region.h * 0.44, w: Math.min(gap * 0.84, region.x + region.w - Math.max(region.x, x - gap * 0.42)), h: region.h * 0.3 }, align: "center", text: item.detail }, theme, "caption", colors.inkMuted));
  });
}

function addProcess(slide, pres, layer, theme, colors) {
  const region = box(layer.box, `${layer.id}.box`);
  const steps = layer.data && layer.data.steps || [];
  if (steps.length < 2) fail(`${layer.id} process needs at least two steps`);
  const gap = 0.12;
  const width = (region.w - gap * (steps.length - 1)) / steps.length;
  for (let index = 0; index < steps.length - 1; index += 1) {
    const x = region.x + (width + gap) * index + width;
    slide.addShape(pres.shapes.LINE, { x, y: region.y + region.h / 2, w: gap, h: 0, line: { color: colors.muted, width: 1.2, endArrowType: "triangle" }, objectName: `${layer.id}-edge-${index + 1}` });
  }
  steps.forEach((step, index) => {
    const x = region.x + (width + gap) * index;
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: region.y, w: width, h: region.h, rectRadius: 0.08, fill: { color: colors.panel, transparency: 4 }, line: { color: colors.muted, transparency: 45 }, objectName: `${layer.id}-step-${index + 1}` });
    slide.addText(String(step.label), textOptions({ id: `${layer.id}-label-${index + 1}`, type: "annotation", styleToken: "subhead", box: { x: x + 0.12, y: region.y + 0.14, w: width - 0.24, h: Math.max(0.32, region.h * 0.32) }, text: step.label }, theme, "subhead", colors.title));
    if (step.detail) slide.addText(String(step.detail), textOptions({ id: `${layer.id}-detail-${index + 1}`, type: "annotation", styleToken: "caption", box: { x: x + 0.12, y: region.y + region.h * 0.5, w: width - 0.24, h: Math.max(0.32, region.h * 0.38) }, text: step.detail }, theme, "caption", colors.body));
  });
}

function addAnnotation(slide, pres, layer, context, colors) {
  const targetLayer = layer.targetLayerId && context.layerById && context.layerById.get(layer.targetLayerId);
  const targetBox = layer.targetBox || targetLayer && targetLayer.box;
  if (targetBox) {
    const source = box(layer.box, `${layer.id}.box`);
    const target = box(targetBox, `${layer.id}.targetBox`);
    slide.addShape(pres.shapes.LINE, {
      x: source.x + source.w / 2,
      y: source.y + source.h / 2,
      w: target.x + target.w / 2 - (source.x + source.w / 2),
      h: target.y + target.h / 2 - (source.y + source.h / 2),
      line: { color: hex(layer.lineColor, colors.accent), width: 1, endArrowType: "triangle" },
      objectName: `${layer.id}-leader`,
    });
  }
  addTextLayer(slide, layer, context, colors);
}

function renderLayer(slide, pres, layer, context) {
  if (!layer || !layer.id || !layer.type) fail("each v2 layer requires stable id and type");
  const colors = palette(context.theme);
  switch (layer.type) {
    case "headline":
    case "body": addTextLayer(slide, layer, context, colors); break;
    case "metric": addMetric(slide, layer, context.theme, colors); break;
    case "quote": addQuote(slide, pres, layer, context.theme, colors); break;
    case "image":
    case "logo":
    case "uiScreenshot": addImage(slide, layer, context); break;
    case "video": addVideo(slide, layer, context); break;
    case "chart": addChart(slide, pres, layer, colors); break;
    case "table": addTable(slide, layer, context.theme, colors); break;
    case "timeline": addTimeline(slide, pres, layer, context.theme, colors); break;
    case "process": addProcess(slide, pres, layer, context.theme, colors); break;
    case "annotation": addAnnotation(slide, pres, layer, context, colors); break;
    default: fail(`unsupported v2 layer type: ${layer.type}`);
  }
}

function renderLayers(slide, pres, layers, context) {
  const ordered = [...layers].sort((left, right) => Number(left.z) - Number(right.z) || left.id.localeCompare(right.id));
  const ids = new Set();
  context.theme = context.theme || {};
  context.pres = pres;
  context.layerById = new Map(ordered.map((layer) => [layer.id, layer]));
  for (const layer of ordered) {
    if (ids.has(layer.id)) fail(`duplicate v2 layer id: ${layer.id}`);
    ids.add(layer.id);
    renderLayer(slide, pres, layer, context);
  }
}

module.exports = {
  box,
  hex,
  palette,
  renderLayer,
  renderLayers,
  safeAsset,
  tokenFor,
};

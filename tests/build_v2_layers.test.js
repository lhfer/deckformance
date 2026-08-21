"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts");
const PptxGenJS = require(path.join(SCRIPTS, "node_modules", "pptxgenjs"));
const JSZip = require(path.join(SCRIPTS, "node_modules", "jszip"));
const { renderLayers } = require(path.join(SCRIPTS, "layer_renderer_v2"));

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function theme() {
  const token = (family, preferred, weight = 400) => ({
    family,
    fallbacks: ["Arial"],
    weight,
    size: { min: preferred, preferred, max: preferred },
    lineHeight: 1.15,
    letterSpacing: 0,
    maxLines: 5,
  });
  return {
    palette: {
      bg: "#F5F1E8", panel: "#1B1C1E", title: "#F7F4EF", body: "#D0CCC4",
      muted: "#8E8A84", accent: "#D56B32", ink: "#1B1C1E", inkMuted: "#625E58",
    },
    typography: {
      tokens: {
        display: token("Arial", 50, 700),
        headline: token("Arial", 35, 700),
        subhead: token("Arial", 24, 600),
        body: token("Arial", 16),
        caption: token("Arial", 12),
        data: token("Arial", 30, 700),
        number: token("Arial", 35, 700),
      },
    },
  };
}

async function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-v2-layers-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "pixel.png"), PNG_1X1);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "DECKFORMANCE_V2", width: 10, height: 5.625 });
  pptx.layout = "DECKFORMANCE_V2";
  const common = { jobDir: root, theme: theme(), videoSlides: [], mediaByLayer: new Map(), assetById: new Map([["pixel", { path: "assets/pixel.png" }]]) };

  let slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  renderLayers(slide, pptx, [
    { id: "headline", type: "headline", z: 10, box: { x: 0.5, y: 0.4, w: 5.7, h: 0.8 }, text: "One claim per slide", styleToken: "headline", resolvedStyle: { family: "Arial", fontSize: 35, weight: 700, lineHeight: 1.1, letterSpacing: 0 } },
    { id: "body", type: "body", z: 11, box: { x: 0.5, y: 1.4, w: 5.2, h: 0.8 }, text: "Native text remains editable.", styleToken: "body", resolvedStyle: { family: "Arial", fontSize: 16, weight: 400, lineHeight: 1.2, letterSpacing: 0 } },
    { id: "metric", type: "metric", z: 12, box: { x: 6.4, y: 0.65, w: 2.8, h: 1.4 }, data: { value: "42%", label: "measured lift" }, styleToken: "data", resolvedStyle: { family: "Arial", fontSize: 30, weight: 700, lineHeight: 1.1, letterSpacing: 0 } },
    { id: "quote", type: "quote", z: 13, box: { x: 0.5, y: 3.2, w: 8.7, h: 1.2 }, data: { quote: "Video carries motion; native layers carry truth.", attribution: "Deckformance contract" }, sourceIds: ["source-1"], styleToken: "subhead", resolvedStyle: { family: "Arial", fontSize: 24, weight: 600, lineHeight: 1.15, letterSpacing: 0 } },
  ], { ...common, slideNumber: 1, motionPlan: null });

  slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  renderLayers(slide, pptx, [
    { id: "chart", type: "chart", z: 10, box: { x: 0.45, y: 0.55, w: 5.6, h: 4.4 }, data: { kind: "bar", categories: ["A", "B", "C"], series: [{ name: "Score", values: [4, 7, 6] }] }, sourceIds: ["source-1"], styleToken: "caption", resolvedStyle: { family: "Arial", fontSize: 12, weight: 400, lineHeight: 1.1, letterSpacing: 0 } },
    { id: "table", type: "table", z: 11, box: { x: 6.25, y: 0.75, w: 3.25, h: 3.8 }, data: { columns: ["Item", "Value"], rows: [["A", 4], ["B", 7], ["C", 6]] }, sourceIds: ["source-1"], styleToken: "caption", resolvedStyle: { family: "Arial", fontSize: 12, weight: 400, lineHeight: 1.1, letterSpacing: 0 } },
  ], { ...common, slideNumber: 2, motionPlan: null });

  slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  renderLayers(slide, pptx, [
    { id: "timeline", type: "timeline", z: 10, box: { x: 0.45, y: 0.45, w: 9.1, h: 2.0 }, data: { items: [{ label: "Plan", detail: "Choose" }, { label: "Build", detail: "Compile" }, { label: "Prove", detail: "Verify" }] }, sourceIds: ["source-1"], styleToken: "caption", resolvedStyle: { family: "Arial", fontSize: 12, weight: 400, lineHeight: 1.1, letterSpacing: 0 } },
    { id: "process", type: "process", z: 11, box: { x: 0.45, y: 3.0, w: 9.1, h: 1.65 }, data: { steps: [{ label: "Brief", detail: "Intent" }, { label: "Design", detail: "Layers" }, { label: "Candidate", detail: "Evidence" }] }, sourceIds: ["source-1"], styleToken: "caption", resolvedStyle: { family: "Arial", fontSize: 12, weight: 400, lineHeight: 1.1, letterSpacing: 0 } },
  ], { ...common, slideNumber: 3, motionPlan: null });

  slide = pptx.addSlide();
  slide.background = { color: "F5F1E8" };
  renderLayers(slide, pptx, [
    { id: "image", type: "image", z: 10, box: { x: 0.6, y: 0.8, w: 2.2, h: 2.2 }, assetId: "pixel" },
    { id: "logo", type: "logo", z: 11, box: { x: 8.4, y: 0.4, w: 0.7, h: 0.7 }, assetId: "pixel" },
    { id: "ui", type: "uiScreenshot", z: 12, box: { x: 3.2, y: 0.8, w: 4.5, h: 3.2 }, assetId: "pixel" },
    { id: "annotation", type: "annotation", z: 13, box: { x: 0.7, y: 4.45, w: 2.5, h: 0.45 }, text: "Bound annotation", styleToken: "caption", resolvedStyle: { family: "Arial", fontSize: 12, weight: 400, lineHeight: 1.1, letterSpacing: 0 }, targetLayerId: "ui" },
  ], { ...common, slideNumber: 4, motionPlan: null });

  const output = path.join(root, "layers.pptx");
  await pptx.writeFile({ fileName: output });
  return { root, output };
}

test("v2 Hybrid layer renderer emits editable text, chart, table, process, timeline, images, and annotations", async (t) => {
  const fixture = await buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const zip = await JSZip.loadAsync(fs.readFileSync(fixture.output));
  assert.equal(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 4);
  assert.equal(Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)).length, 1);
  const slide1 = await zip.file("ppt/slides/slide1.xml").async("string");
  const slide2 = await zip.file("ppt/slides/slide2.xml").async("string");
  const slide4 = await zip.file("ppt/slides/slide4.xml").async("string");
  assert.match(slide1, /One claim per slide/);
  assert.match(slide1, /42%/);
  assert.match(slide1, /Deckformance contract/);
  assert.match(slide2, /<a:tbl>/);
  assert.match(slide4, /name="ui"/);
  assert.match(slide4, /name="annotation-leader"/);
});

test("v2 layer renderer fails closed on duplicate IDs and boxes outside the slide", () => {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "DECKFORMANCE_V2", width: 10, height: 5.625 });
  pptx.layout = "DECKFORMANCE_V2";
  const slide = pptx.addSlide();
  const context = { jobDir: os.tmpdir(), theme: theme(), videoSlides: [], mediaByLayer: new Map(), assetById: new Map(), slideNumber: 1 };
  const base = { id: "same", type: "headline", z: 1, box: { x: 0.5, y: 0.5, w: 3, h: 0.8 }, text: "A", styleToken: "headline", resolvedStyle: { family: "Arial", fontSize: 35, weight: 700, lineHeight: 1.1, letterSpacing: 0 } };
  assert.throws(() => renderLayers(slide, pptx, [base, { ...base, text: "B", z: 2 }], context), /duplicate v2 layer id/);
  assert.throws(() => renderLayers(slide, pptx, [{ ...base, id: "outside", box: { x: 9.5, y: 0.5, w: 1, h: 0.8 } }], context), /leaves the 10 x 5.625 slide canvas/);
});

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  body_shaping_for_felt_master,
  characterPromptContextForFeltMaster,
  createFeltMasterModel,
  felt_editorial_split_master,
  geometryForFeltMaster,
  headline_shaping_for_felt_master,
} = require("../.grok/skills/ppt-cast/scripts/felt_editorial_split_master");

test("defines one master with two strict mirror variants and three ratio candidates", () => {
  assert.equal(felt_editorial_split_master.id, "felt_editorial_split_master");
  assert.equal(felt_editorial_split_master.family, "editorial-split");
  assert.deepEqual(felt_editorial_split_master.variants, ["media-left", "media-right"]);
  assert.deepEqual(felt_editorial_split_master.candidateRatios.map((candidate) => candidate.media), [0.54, 0.57, 0.60]);
  assert.equal(felt_editorial_split_master.selectedRatio, "B");
});

test("packages the exact source-derived RGBA felt edge mask", () => {
  const assetPath = path.resolve(__dirname, "../.grok/skills/ppt-cast/assets/felt-edge-negative-mask.png");
  const data = fs.readFileSync(assetPath);
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(data.readUInt32BE(16), 1152);
  assert.equal(data.readUInt32BE(20), 554);
  assert.equal(data[25], 6, "PNG color type must be RGBA");
  assert.equal(crypto.createHash("sha256").update(data).digest("hex"), "6888489ac30e7802258136c1cf1b9e747a17fac2e06c55da1dde2e3ebb5407ef");
});

test("media-left and media-right are exact geometry mirrors", () => {
  const left = geometryForFeltMaster({ slideWidth: 1280, slideHeight: 720, mediaSide: "media-left", ratio: "B" });
  const right = geometryForFeltMaster({ slideWidth: 1280, slideHeight: 720, mediaSide: "media-right", ratio: "B" });
  assert.deepEqual(left.card, right.card);
  assert.equal(left.media.width, right.media.width);
  assert.equal(left.panel.width, right.panel.width);
  assert.equal(left.media.left, left.card.left);
  assert.equal(right.panel.left, right.card.left);
  assert.equal(left.panel.left + right.media.left, left.card.left * 2 + left.card.width);
  assert.equal(left.media.left + right.media.left + right.media.width, left.card.left * 2 + left.card.width);
  assert.equal(left.mediaContract.preferredAspect, "6:5");
  assert.ok(left.mediaContract.renderedAspect > 1.17 && left.mediaContract.renderedAspect < 1.20);
});

test("headline shaping preserves semantic phrases and produces multiple eligible candidates", () => {
  const shaped = headline_shaping_for_felt_master("钉在工作流里", { panelWidthPt: 220, fontSizePt: 36 });
  assert.ok(shaped.candidates.length >= 3);
  assert.ok(shaped.candidates.every((candidate) => !candidate.text.includes("工作\n流")));
  assert.ok(shaped.selected.eligible);
  assert.match(shaped.selected.text, /工作流/u);
});

test("explicit balanced editorial breaks outrank accidental auto-wrap", () => {
  const shaped = headline_shaping_for_felt_master("一句话\n交成品", { panelWidthPt: 220, fontSizePt: 36 });
  assert.equal(shaped.selected.text, "一句话\n交成品");
  assert.equal(shaped.selected.lines.length, 2);
  assert.equal(shaped.selected.imbalance, 0);
});

test("headline shaping keeps grammatical possessive phrases together", () => {
  const shaped = headline_shaping_for_felt_master("更懂你的工作", { panelWidthPt: 224, fontSizePt: 36 });
  assert.equal(shaped.selected.text, "更懂你的工作");
  assert.ok(shaped.candidates.every((candidate) => !candidate.text.includes("你的\n工作")));
  assert.ok(shaped.candidates.every((candidate) => !candidate.text.includes("更懂你\n的工作")));
});

test("body shaping returns two to four short units and a separate closing line", () => {
  const shaped = body_shaping_for_felt_master(
    ["文档表格PPT网页都能直接用。", "从指令到交付一次闭环。"],
    "交的是成品，不是一段话。",
  );
  assert.ok(shaped.selected.units.length >= 2 && shaped.selected.units.length <= 4);
  assert.equal(shaped.closingLine, "交的是成品，不是一段话。");
  assert.ok(shaped.candidates.some((candidate) => candidate.units[0].includes("文档、表格、PPT、网页")));
});

test("model exposes only the focused template inputs and stable vertical zones", () => {
  const model = createFeltMasterModel({
    mediaSide: "media-right",
    eyebrowOrIcon: true,
    pageNumber: "03",
    headline: "钉在\n工作流里",
    body: ["桌面、网页、钉钉，", "同一套能力。"],
    closingLine: "随时把活交出去。",
    videoPoster: "assets/felt-scene-03-workflow.png",
    videoSlot: { aspect: "6:5" },
    characterSet: {
      referenceImages: ["inputs/character-primary.png", "inputs/character-secondary.png"],
      description: "User-uploaded recurring characters",
    },
  });
  assert.equal(model.templateId, "felt_editorial_split_master");
  assert.equal(model.geometry.variant, "media-right");
  assert.ok(model.geometry.zones.header.top < model.geometry.zones.body.top);
  assert.ok(model.geometry.zones.body.top < model.geometry.zones.closing.top);
  assert.equal(model.geometry.edgeTreatment.type, "source-derived-alpha-mask");
  assert.equal(model.geometry.edgeTreatment.inheritsUnderlyingColor, true);
  assert.deepEqual(model.geometry.edgeTreatment.sourceSize, [608, 294]);
  assert.equal(model.geometry.edgeTreatment.asset, "assets/felt-edge-negative-mask.png");
  assert.equal(model.geometry.edgeTreatment.packagedAsset, ".grok/skills/ppt-cast/assets/felt-edge-negative-mask.png");
  assert.equal(model.characterPromptContext.referenceImages.length, 2);
  assert.throws(() => createFeltMasterModel({ ...model.variables, extraLayoutKnob: true }), /unsupported input keys/u);
});

test("character uploads are optional and never fall back to a fixed template mascot", () => {
  assert.equal(characterPromptContextForFeltMaster(null).fixedCharacterIdentity, false);
  const custom = characterPromptContextForFeltMaster({
    referenceImages: ["inputs/my-character.png"],
    description: "A user-owned felt cat",
  });
  assert.equal(custom.fixedCharacterIdentity, true);
  assert.deepEqual(custom.referenceImages.map((item) => item.image), ["inputs/my-character.png"]);
  assert.match(custom.instruction, /uploaded images only as character identity references/u);
  assert.throws(() => characterPromptContextForFeltMaster({ referenceImages: ["/tmp/character.png"] }), /job-relative/u);
  assert.throws(() => characterPromptContextForFeltMaster({ referenceImages: [] }), /one or two/u);
});

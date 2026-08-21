"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts");
const LAYOUTS = path.join(ROOT, ".grok", "skills", "ppt-cast", "references", "layouts.json");
const JSZip = require(path.join(SCRIPTS, "node_modules", "jszip"));
const { aspectMatches, parseAspect, validateLayoutContract } = require(path.join(SCRIPTS, "media_contract"));

let tempRoot;
let normalizedDeck;
let candidatePptx;
let packageEvidence;
let legacyPortraitDeck;

function run(script, args) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-cast-build-tests-"));
  const legacyDir = path.join(tempRoot, "legacy-portrait");
  fs.mkdirSync(legacyDir);
  const jpegPoster = path.join(legacyDir, "poster.jpg");
  let media = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x334455:s=880x1168:d=0.1",
    "-frames:v", "1", "-update", "1", jpegPoster,
  ], { encoding: "utf8" });
  assert.equal(media.status, 0, media.stderr);
  fs.copyFileSync(jpegPoster, path.join(legacyDir, "poster.png"));
  media = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x334455:s=832x1104:d=0.3",
    "-t", "0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
    path.join(legacyDir, "video.mp4"),
  ], { encoding: "utf8" });
  assert.equal(media.status, 0, media.stderr);
  legacyPortraitDeck = path.join(legacyDir, "deck.json");
  writeJson(legacyPortraitDeck, {
    title: "Synthetic legacy portrait fixture",
    slides: [
      { id: "cover", layoutId: "title-card", title: "Legacy framing regression", body: ["Synthetic test data only."] },
      ...["01", "02", "03", "04"].map((id, index) => ({
        id,
        layoutId: index % 2 ? "split-right-video" : "split-left-video",
        kicker: "Regression",
        number: id,
        title: `Portrait media must not silently fit ${id}.`,
        body: ["Aspect and byte signatures are hard gates."],
        poster: "poster.png",
        video: "video.mp4",
        sources: ["Synthetic test fixture"],
      })),
    ],
  });
  const normalizedDir = path.join(tempRoot, "normalized");
  const normalize = run("normalize_media.js", [legacyPortraitDeck, normalizedDir, "--allow-crop"]);
  assert.equal(normalize.status, 0, normalize.stderr || normalize.stdout);
  normalizedDeck = path.join(normalizedDir, "deck.normalized.json");
  candidatePptx = path.join(tempRoot, "candidate.pptx");
  packageEvidence = path.join(tempRoot, "package-qa.json");
  const build = run("build_deck.js", [
    normalizedDeck,
    candidatePptx,
    "--release",
    "candidate",
  ]);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const validate = run("validate_pptx.js", [
    candidatePptx,
    "--deck",
    normalizedDeck,
    "--release",
    "candidate",
    "--evidence",
    packageEvidence,
  ]);
  assert.equal(validate.status, 0, validate.stderr || validate.stdout);
});

after(() => {
  if (tempRoot && fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("layout registry exposes varied exact-aspect families and accessible type sizes", () => {
  const layouts = JSON.parse(fs.readFileSync(LAYOUTS, "utf8"));
  assert.equal(validateLayoutContract(layouts).length, 0);
  const mediaLayouts = Object.values(layouts.layouts).filter((layout) => layout.video);
  assert.ok(mediaLayouts.length >= 9, `expected at least 9 media layout families, found ${mediaLayouts.length}`);
  assert.ok(Number(layouts.fonts.titleCardTitle) >= 50);
  assert.ok(Number(layouts.fonts.title) >= 35);
  assert.ok(Number(layouts.fonts.body) >= 16);
  for (const layout of mediaLayouts) {
    const aspect = parseAspect(layout.mediaAspect);
    assert.ok(aspectMatches(layout.video.w, layout.video.h, aspect), layout.family);
    assert.ok(aspectMatches(parseAspect(layout.stillAspect).w, parseAspect(layout.stillAspect).h, aspect));
  }
});

test("candidate build fails closed when a content video is missing and publishes no file", () => {
  const fixtureDir = path.join(tempRoot, "missing-video");
  fs.mkdirSync(fixtureDir);
  const sourceDeck = JSON.parse(fs.readFileSync(normalizedDeck, "utf8"));
  const sourcePoster = path.resolve(path.dirname(normalizedDeck), sourceDeck.slides[1].poster);
  fs.copyFileSync(sourcePoster, path.join(fixtureDir, "poster.png"));
  const deckPath = path.join(fixtureDir, "deck.json");
  writeJson(deckPath, {
    title: "Missing media gate",
    slides: [
      { layoutId: "title-card", title: "Gate", body: ["No blank candidates."] },
      {
        id: "01",
        layoutId: "split-left-video",
        title: "Video is mandatory.",
        body: ["Poster-only content is a draft, not a candidate."],
        poster: "poster.png",
      },
    ],
  });
  const output = path.join(fixtureDir, "candidate.pptx");
  const result = run("build_deck.js", [deckPath, output, "--release", "candidate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /video is required/);
  assert.equal(fs.existsSync(output), false);
});

test("media paths cannot escape the deck directory", () => {
  const fixtureDir = path.join(tempRoot, "unsafe-path");
  fs.mkdirSync(fixtureDir);
  const normalized = JSON.parse(fs.readFileSync(normalizedDeck, "utf8"));
  const poster = path.relative(fixtureDir, path.resolve(path.dirname(normalizedDeck), normalized.slides[1].poster));
  const video = path.relative(fixtureDir, path.resolve(path.dirname(normalizedDeck), normalized.slides[1].video));
  const deckPath = path.join(fixtureDir, "deck.json");
  writeJson(deckPath, {
    title: "Unsafe paths",
    slides: [
      {
        id: "01",
        layoutId: "split-left-video",
        title: "Stay in scope.",
        body: ["Media must be job-local."],
        poster,
        video,
      },
    ],
  });
  const output = path.join(fixtureDir, "candidate.pptx");
  const result = run("build_deck.js", [deckPath, output, "--release", "candidate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must stay inside the deck directory/);
  assert.equal(fs.existsSync(output), false);
});

test("candidate rejects an MP4 that contains an audio stream", () => {
  const fixtureDir = path.join(tempRoot, "audio-stream");
  fs.mkdirSync(fixtureDir);
  const normalized = JSON.parse(fs.readFileSync(normalizedDeck, "utf8"));
  const sourcePoster = path.resolve(path.dirname(normalizedDeck), normalized.slides[1].poster);
  fs.copyFileSync(sourcePoster, path.join(fixtureDir, "poster.png"));
  const videoPath = path.join(fixtureDir, "with-audio.mp4");
  const ffmpeg = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=1080x1080:d=0.25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    videoPath,
  ], { encoding: "utf8" });
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const deckPath = path.join(fixtureDir, "deck.json");
  writeJson(deckPath, {
    title: "Silent contract",
    slides: [{
      id: "01",
      layoutId: "split-left-video",
      title: "The final media is silent.",
      body: ["Audio is not allowed in v1."],
      poster: "poster.png",
      video: "with-audio.mp4",
    }],
  });
  const output = path.join(fixtureDir, "candidate.pptx");
  const result = run("build_deck.js", [deckPath, output, "--release", "candidate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be silent and contain no audio/);
  assert.equal(fs.existsSync(output), false);
});

test("poster-only media is allowed only for draft and final requires explicit PowerPoint acceptance", () => {
  const fixtureDir = path.join(tempRoot, "release-levels");
  fs.mkdirSync(fixtureDir);
  const sourceDeck = JSON.parse(fs.readFileSync(normalizedDeck, "utf8"));
  const sourcePoster = path.resolve(path.dirname(normalizedDeck), sourceDeck.slides[1].poster);
  fs.copyFileSync(sourcePoster, path.join(fixtureDir, "poster.png"));
  const deckPath = path.join(fixtureDir, "deck.json");
  writeJson(deckPath, {
    title: "Draft",
    slides: [
      {
        id: "01",
        layoutId: "split-left-video",
        title: "Draft poster.",
        body: ["This file is not a candidate."],
        poster: "poster.png",
      },
    ],
  });
  const draft = path.join(fixtureDir, "draft.pptx");
  const draftResult = run("build_deck.js", [deckPath, draft, "--release", "draft"]);
  assert.equal(draftResult.status, 0, draftResult.stderr || draftResult.stdout);
  assert.equal(fs.existsSync(draft), true);

  const final = path.join(fixtureDir, "final.pptx");
  const finalResult = run("build_deck.js", [normalizedDeck, final, "--release", "final"]);
  assert.notEqual(finalResult.status, 0);
  assert.match(finalResult.stderr, /--powerpoint-verified/);
  assert.equal(fs.existsSync(final), false);
});

test("legacy portrait assets fail closed; crop repair is explicit and must be re-QA'd", () => {
  const rawOutput = path.join(tempRoot, "raw-legacy-portrait.pptx");
  const raw = run("build_deck.js", [legacyPortraitDeck, rawOutput, "--release", "candidate"]);
  assert.notEqual(raw.status, 0);
  assert.match(raw.stderr, /poster aspect 880x1168 does not match required 1:1/);
  assert.match(raw.stderr, /video aspect 832x1104 does not match required 1:1/);
  assert.equal(fs.existsSync(rawOutput), false);

  const refusedDir = path.join(tempRoot, "refused-unreviewed-crop");
  const refused = run("normalize_media.js", [legacyPortraitDeck, refusedDir]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing an unreviewed crop that could remove hands, feet, or support contact/);
  assert.equal(fs.existsSync(path.join(refusedDir, "deck.normalized.json")), false);

  const normalized = JSON.parse(fs.readFileSync(normalizedDeck, "utf8"));
  for (const slide of normalized.slides.filter((item) => item.video)) {
    const poster = path.resolve(path.dirname(normalizedDeck), slide.poster);
    const video = path.resolve(path.dirname(normalizedDeck), slide.video);
    assert.equal(fs.readFileSync(poster).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(fs.readFileSync(video).subarray(4, 8).toString("ascii"), "ftyp");
  }
  assert.equal(fs.existsSync(candidatePptx), true);
});

test("candidate package has true PNG covers, H264 media relationships, autoplay timing, and source notes", async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(candidatePptx));
  const media = Object.keys(zip.files).filter((name) => /^ppt\/media\/.*\.mp4$/i.test(name));
  assert.equal(media.length, 4);
  const contentTypes = await zip.file("[Content_Types].xml").async("string");
  assert.match(contentTypes, /Extension="png" ContentType="image\/png"/);
  assert.match(contentTypes, /Extension="mp4" ContentType="video\/mp4"/);

  for (let slideNumber = 2; slideNumber <= 5; slideNumber += 1) {
    const slideXml = await zip.file(`ppt/slides/slide${slideNumber}.xml`).async("string");
    const relsXml = await zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`).async("string");
    assert.match(relsXml, /relationships\/video/);
    assert.match(relsXml, /relationships\/media/);
    assert.match(relsXml, /relationships\/image/);
    assert.match(slideXml, /evt="onBegin" delay="0"><p:tn val="2"\/>/);
    assert.match(slideXml, /presetClass="mediacall"[^>]*nodeType="afterEffect"/);
    assert.match(slideXml, /cmd="playFrom\(0\.0\)"/);
    assert.match(slideXml, /<p:video><p:cMediaNode vol="0">/);
    assert.doesNotMatch(slideXml, /repeatCount=/);
    assert.doesNotMatch(slideXml, /<p:transition\b[^>]*advTm=/);
  }

  for (const name of Object.keys(zip.files).filter((item) => /^ppt\/media\/.*\.png$/i.test(item))) {
    const bytes = await zip.file(name).async("nodebuffer");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  for (let slideNumber = 1; slideNumber <= 5; slideNumber += 1) {
    const notesXml = await zip.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`).async("string");
    assert.match(notesXml, /\[Sources\]/);
  }
});

test("standalone package evidence is directly consumable by candidate release state", () => {
  const evidence = JSON.parse(fs.readFileSync(packageEvidence, "utf8"));
  assert.equal(evidence.passed, true);
  assert.equal(evidence.expectedContentPages, 4);
  assert.equal(evidence.embeddedVideoCount, 4);
  assert.equal(evidence.posterCount, 4);
  assert.equal(evidence.timingCount, 4);
  assert.equal(evidence.relationshipsValid, true);
  assert.equal(evidence.mimeTypesValid, true);
  assert.equal(evidence.aspectRatiosValid, true);
  assert.match(evidence.deckSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(evidence.artifactSha256, /^sha256:[a-f0-9]{64}$/);
});

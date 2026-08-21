#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const path = require("path");
const JSZip = require("jszip");
const { PNG_SIGNATURE } = require("./media_contract");

const REL_VIDEO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video";
const REL_MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media";
const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_NOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

function sha256(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function xmlAttr(text, name) {
  const match = text.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function parseRelationships(xml) {
  const items = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    items.push({
      id: xmlAttr(match[0], "Id"),
      type: xmlAttr(match[0], "Type"),
      target: xmlAttr(match[0], "Target"),
    });
  }
  return items;
}

function resolveRelationshipPart(sourcePart, target) {
  if (!target || target.startsWith("/") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target)) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target));
  if (resolved === ".." || resolved.startsWith("../")) return null;
  return resolved;
}

function findVideoPictureBlocks(slideXml) {
  return (slideXml.match(/<p:pic\b[\s\S]*?<\/p:pic>/g) || []).filter((picture) =>
    /<a:videoFile\b/.test(picture),
  );
}

function findVideoShapes(slideXml) {
  const shapes = [];
  for (const picture of findVideoPictureBlocks(slideXml)) {
    const match = picture.match(/<p:cNvPr\b[^>]*\bid="(\d+)"[^>]*\bname="([^"]+)"/);
    if (match) shapes.push({ id: Number(match[1]), name: match[2] });
  }
  return shapes;
}

function findVideoShapeIds(slideXml) {
  return findVideoShapes(slideXml).map((shape) => shape.id);
}

function timingXml(shapeId, durationMs, volume) {
  const duration = Math.max(1, Math.round(durationMs));
  const vol = Math.max(0, Math.min(100000, Math.round(volume)));
  return (
    '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">' +
    '<p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">' +
    '<p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>' +
    '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>' +
    '<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
    '<p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="afterEffect">' +
    '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="playFrom(0.0)">' +
    `<p:cBhvr><p:cTn id="6" dur="${duration}" fill="hold"/><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>` +
    '</p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>' +
    '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn>' +
    '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
    '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>' +
    `</p:seq><p:video><p:cMediaNode vol="${vol}"><p:cTn id="7" fill="hold" display="0">` +
    '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>' +
    `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl></p:cMediaNode></p:video>` +
    '<p:seq concurrent="1" nextAc="seek"><p:cTn id="8" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">' +
    `<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl></p:cond></p:stCondLst>` +
    '<p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst><p:par><p:cTn id="9" fill="hold">' +
    '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="10" fill="hold">' +
    '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par>' +
    '<p:cTn id="11" presetID="2" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="clickEffect">' +
    '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="togglePause">' +
    `<p:cBhvr><p:cTn id="12" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl></p:cBhvr>` +
    '</p:cmd></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst>' +
    '</p:cTn></p:par></p:childTnLst></p:cTn>' +
    `<p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl></p:cond>` +
    '</p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
  );
}

function injectTimingIntoSlide(slideXml, options) {
  if (/<p:timing\b/.test(slideXml)) throw new Error(`slide ${options.slideNumber} already contains timing`);
  const shapes = findVideoShapes(slideXml);
  const selected = options.layerId ? shapes.filter((shape) => shape.name === options.layerId) : shapes;
  if (selected.length !== 1 || shapes.length !== 1) {
    const qualifier = options.layerId ? ` named ${options.layerId}` : "";
    throw new Error(`slide ${options.slideNumber} must contain exactly one embedded video shape${qualifier}; found ${selected.length} matching of ${shapes.length}`);
  }
  const xml = timingXml(selected[0].id, options.durationMs, options.volume);
  const closing = slideXml.lastIndexOf("</p:sld>");
  if (closing < 0) throw new Error(`slide ${options.slideNumber} is missing </p:sld>`);
  const afterCommonSlide = slideXml.indexOf("</p:cSld>");
  if (afterCommonSlide < 0) throw new Error(`slide ${options.slideNumber} is missing </p:cSld>`);
  const rootTailStart = afterCommonSlide + "</p:cSld>".length;
  const rootTail = slideXml.slice(rootTailStart, closing);
  const rootExtOffset = rootTail.indexOf("<p:extLst");
  const insertion = rootExtOffset >= 0 ? rootTailStart + rootExtOffset : closing;
  return slideXml.slice(0, insertion) + xml + slideXml.slice(insertion);
}

async function injectAutoplay(buffer, videoSlides) {
  const zip = await JSZip.loadAsync(buffer);
  for (const video of videoSlides) {
    const part = `ppt/slides/slide${video.slideNumber}.xml`;
    const entry = zip.file(part);
    if (!entry) throw new Error(`missing slide part ${part}`);
    const slideXml = await entry.async("string");
    zip.file(part, injectTimingIntoSlide(slideXml, video));
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

async function validatePackageBuffer(buffer, options = {}) {
  const zip = await JSZip.loadAsync(buffer);
  const errors = [];
  const maxEmbeddedMediaBytes = options.maxEmbeddedMediaBytes === undefined ? 100 * 1024 * 1024 : Number(options.maxEmbeddedMediaBytes);
  const slideParts = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  let expectedVideoSlides = options.videoSlides;
  if (!Array.isArray(expectedVideoSlides)) {
    expectedVideoSlides = [];
    for (const slidePart of slideParts) {
      const slideXml = await zip.file(slidePart).async("string");
      if (findVideoShapeIds(slideXml).length) {
        expectedVideoSlides.push({ slideNumber: Number(slidePart.match(/slide(\d+)\.xml$/)[1]) });
      }
    }
  }
  const expectedMediaCount =
    options.expectedMediaCount === undefined ? expectedVideoSlides.length : options.expectedMediaCount;
  const expectedContentPages =
    options.expectedContentPages === undefined ? expectedVideoSlides.length : options.expectedContentPages;
  let relationshipsValid = true;
  let posterCount = 0;
  let timingCount = 0;
  const contentTypesEntry = zip.file("[Content_Types].xml");
  if (!contentTypesEntry) {
    errors.push("package is missing [Content_Types].xml");
  }
  const contentTypes = contentTypesEntry ? await contentTypesEntry.async("string") : "";
  const pngMimeValid = /<Default\b[^>]*Extension="png"[^>]*ContentType="image\/png"/.test(contentTypes);
  const mp4MimeValid = /<Default\b[^>]*Extension="mp4"[^>]*ContentType="video\/mp4"/.test(contentTypes);
  if (!pngMimeValid) {
    errors.push("package does not declare PNG as image/png");
  }
  if (!mp4MimeValid) {
    errors.push("package does not declare MP4 as video/mp4");
  }
  const mimeTypesValid = pngMimeValid && mp4MimeValid;

  const mediaParts = Object.keys(zip.files).filter((name) => /^ppt\/media\/[^/]+\.mp4$/i.test(name));
  const embeddedParts = Object.keys(zip.files).filter((name) => /^ppt\/media\/[^/]+$/i.test(name) && !zip.files[name].dir);
  let embeddedMediaBytes = 0;
  for (const mediaPart of embeddedParts) embeddedMediaBytes += (await zip.file(mediaPart).async("nodebuffer")).length;
  if (!Number.isFinite(maxEmbeddedMediaBytes) || maxEmbeddedMediaBytes <= 0) errors.push("embedded media budget must be a positive byte count");
  else if (embeddedMediaBytes > maxEmbeddedMediaBytes) errors.push(`package embedded media total ${embeddedMediaBytes} exceeds ${maxEmbeddedMediaBytes} bytes`);
  if (mediaParts.length !== expectedMediaCount) {
    errors.push(`package media count ${mediaParts.length} does not match expected ${expectedMediaCount}`);
  }
  for (const mediaPart of mediaParts) {
    const media = await zip.file(mediaPart).async("nodebuffer");
    if (media.length < 12 || media.toString("ascii", 4, 8) !== "ftyp") {
      errors.push(`${mediaPart} does not contain an MP4 ftyp signature`);
    }
  }

  for (const expected of expectedVideoSlides) {
    const slidePart = `ppt/slides/slide${expected.slideNumber}.xml`;
    const relsPart = `ppt/slides/_rels/slide${expected.slideNumber}.xml.rels`;
    const slideEntry = zip.file(slidePart);
    const relsEntry = zip.file(relsPart);
    if (!slideEntry || !relsEntry) {
      errors.push(`slide ${expected.slideNumber} is missing its XML or relationships part`);
      relationshipsValid = false;
      continue;
    }
    const slideXml = await slideEntry.async("string");
    const relsXml = await relsEntry.async("string");
    const rels = parseRelationships(relsXml);
    const videoRels = rels.filter((rel) => rel.type === REL_VIDEO);
    const mediaRels = rels.filter((rel) => rel.type === REL_MEDIA);
    const imageRels = rels.filter((rel) => rel.type === REL_IMAGE);
    let slideRelationshipsValid = true;
    if (videoRels.length !== 1) {
      errors.push(`slide ${expected.slideNumber} must have one video relationship`);
      slideRelationshipsValid = false;
    }
    if (mediaRels.length !== 1) {
      errors.push(`slide ${expected.slideNumber} must have one media relationship`);
      slideRelationshipsValid = false;
    }
    if (imageRels.length < 1) {
      errors.push(`slide ${expected.slideNumber} must have a poster image relationship`);
      slideRelationshipsValid = false;
    }
    if (videoRels[0] && mediaRels[0] && videoRels[0].target !== mediaRels[0].target) {
      errors.push(`slide ${expected.slideNumber} video/media relationships target different files`);
      slideRelationshipsValid = false;
    }

    const videoTarget = videoRels[0] ? resolveRelationshipPart(slidePart, videoRels[0].target) : null;
    const videoPictures = findVideoPictureBlocks(slideXml);
    const videoLinkMatch = videoPictures[0] ? videoPictures[0].match(/<a:videoFile\b[^>]*\br:link="([^"]+)"/) : null;
    const mediaEmbedMatch = videoPictures[0] ? videoPictures[0].match(/<p14:media\b[^>]*\br:embed="([^"]+)"/) : null;
    const posterIdMatch = videoPictures[0]
      ? videoPictures[0].match(/<p:blipFill>[\s\S]*?<a:blip\b[^>]*\br:embed="([^"]+)"/)
      : null;
    if (!videoLinkMatch || !videoRels.some((rel) => rel.id === videoLinkMatch[1])) {
      errors.push(`slide ${expected.slideNumber} video shape does not reference its video relationship`);
      slideRelationshipsValid = false;
    }
    if (!mediaEmbedMatch || !mediaRels.some((rel) => rel.id === mediaEmbedMatch[1])) {
      errors.push(`slide ${expected.slideNumber} video shape does not reference its media relationship`);
      slideRelationshipsValid = false;
    }
    const posterRel = posterIdMatch ? imageRels.find((rel) => rel.id === posterIdMatch[1]) : null;
    const posterTarget = posterRel ? resolveRelationshipPart(slidePart, posterRel.target) : null;
    if (!videoTarget || !zip.file(videoTarget)) {
      errors.push(`slide ${expected.slideNumber} has a missing or unsafe video target`);
      slideRelationshipsValid = false;
    } else if (expected.videoSha256) {
      const packagedVideo = await zip.file(videoTarget).async("nodebuffer");
      if (sha256(packagedVideo) !== expected.videoSha256) {
        errors.push(`slide ${expected.slideNumber} packaged video differs from validated source`);
      }
    }
    if (!posterTarget || !zip.file(posterTarget)) {
      errors.push(`slide ${expected.slideNumber} has a missing or unsafe poster target`);
      slideRelationshipsValid = false;
    } else {
      const poster = await zip.file(posterTarget).async("nodebuffer");
      if (poster.length < PNG_SIGNATURE.length || !poster.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        errors.push(`slide ${expected.slideNumber} poster in package is not true PNG data`);
      } else {
        posterCount += 1;
      }
      if (expected.posterSha256 && sha256(poster) !== expected.posterSha256) {
        errors.push(`slide ${expected.slideNumber} packaged poster differs from validated source`);
      }
    }
    relationshipsValid = relationshipsValid && slideRelationshipsValid;

    const shapeIds = findVideoShapeIds(slideXml);
    const shapeId = shapeIds[0];
    let timingValid = true;
    if (shapeIds.length !== 1) {
      errors.push(`slide ${expected.slideNumber} must have exactly one video shape`);
      timingValid = false;
    }
    if (countMatches(slideXml, /<p:timing\b/g) !== 1) {
      errors.push(`slide ${expected.slideNumber} must have one timing tree`);
      timingValid = false;
    }
    if (!/<p:cond\b[^>]*evt="onBegin"[^>]*delay="0"[^>]*>\s*<p:tn val="2"\/>/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} timing is missing its onBegin trigger`);
      timingValid = false;
    }
    if (!/<p:cTn\b[^>]*presetClass="mediacall"[^>]*nodeType="afterEffect"/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} timing is not an afterEffect media call`);
      timingValid = false;
    }
    if (!/<p:cmd\b[^>]*type="call"[^>]*cmd="playFrom\(0\.0\)"/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} timing is missing playFrom(0.0)`);
      timingValid = false;
    }
    if (!/<p:cTn\b[^>]*id="1"[^>]*dur="indefinite"[^>]*restart="never"[^>]*nodeType="tmRoot"/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} timing root must use restart=never`);
      timingValid = false;
    }
    if (Number.isFinite(expected.durationMs)) {
      const expectedDuration = Math.max(1, Math.round(expected.durationMs));
      const mediaDuration = slideXml.match(/<p:cmd\b[^>]*cmd="playFrom\(0\.0\)"[\s\S]*?<p:cBhvr>[\s\S]*?<p:cTn\b[^>]*\bdur="(\d+)"[^>]*\bfill="hold"/);
      if (!mediaDuration || Number(mediaDuration[1]) !== expectedDuration) {
        errors.push(`slide ${expected.slideNumber} timing duration must equal validated media duration ${expectedDuration}ms`);
        timingValid = false;
      }
    }
    if (!/<p:video>\s*<p:cMediaNode\b/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} timing is missing the associated p:video node`);
      timingValid = false;
    }
    if (Number.isFinite(expected.volume)) {
      const expectedVolume = Math.max(0, Math.min(100000, Math.round(expected.volume)));
      const volume = slideXml.match(/<p:video>\s*<p:cMediaNode\b[^>]*\bvol="(\d+)"/);
      if (!volume || Number(volume[1]) !== expectedVolume) {
        errors.push(`slide ${expected.slideNumber} media volume must equal ${expectedVolume}`);
        timingValid = false;
      }
    }
    if (shapeId && countMatches(slideXml, new RegExp(`<p:spTgt spid="${shapeId}"\\/>`, "g")) < 3) {
      errors.push(`slide ${expected.slideNumber} timing does not consistently target media shape ${shapeId}`);
      timingValid = false;
    }
    if (/repeatCount=/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} media timing must not loop`);
      timingValid = false;
    }
    if (/<p:transition\b[^>]*advTm=/.test(slideXml)) {
      errors.push(`slide ${expected.slideNumber} must not auto-advance`);
      timingValid = false;
    }
    if (timingValid) timingCount += 1;
  }

  for (const slidePart of slideParts) {
    const slideNumber = Number(slidePart.match(/slide(\d+)\.xml$/)[1]);
    const relsPart = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const relsEntry = zip.file(relsPart);
    if (!relsEntry) {
      errors.push(`slide ${slideNumber} is missing relationships`);
      continue;
    }
    const rels = parseRelationships(await relsEntry.async("string"));
    const notesRel = rels.find((rel) => rel.type === REL_NOTES);
    const notesTarget = notesRel ? resolveRelationshipPart(slidePart, notesRel.target) : null;
    if (!notesTarget || !zip.file(notesTarget)) {
      errors.push(`slide ${slideNumber} is missing speaker notes`);
      continue;
    }
    const notesXml = await zip.file(notesTarget).async("string");
    if (!notesXml.includes("[Sources]")) errors.push(`slide ${slideNumber} notes are missing [Sources]`);
  }

  const coreEntry = zip.file("docProps/core.xml");
  const coreXml = coreEntry ? await coreEntry.async("string") : "";
  if (options.release && !coreXml.includes(`ppt-cast release:${options.release}`)) {
    errors.push(`package metadata does not identify release ${options.release}`);
  }
  if (options.release === "final" && !coreXml.includes("powerpoint-verified:true")) {
    errors.push("final package metadata is missing powerpoint-verified:true");
  }

  return {
    valid: errors.length === 0,
    passed: errors.length === 0,
    errors,
    slideCount: slideParts.length,
    mediaCount: mediaParts.length,
    expectedContentPages,
    embeddedVideoCount: mediaParts.length,
    posterCount,
    timingCount,
    embeddedMediaBytes,
    maxEmbeddedMediaBytes,
    relationshipsValid,
    mimeTypesValid,
    aspectRatiosValid: options.aspectRatiosValid !== false,
    release: options.release || null,
  };
}

module.exports = {
  REL_IMAGE,
  REL_MEDIA,
  REL_NOTES,
  REL_VIDEO,
  findVideoShapes,
  findVideoShapeIds,
  injectAutoplay,
  injectTimingIntoSlide,
  parseRelationships,
  resolveRelationshipPart,
  sha256,
  timingXml,
  validatePackageBuffer,
};

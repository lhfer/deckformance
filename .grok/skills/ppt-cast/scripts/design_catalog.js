"use strict";

const FAMILY_FOR_ROLE = Object.freeze({
  cover: "cover-hero",
  section: "section-break",
  hero: "hero-performance",
  evidence: "evidence-split",
  metric: "metric-focus",
  comparison: "comparison",
  timeline: "timeline",
  process: "process",
  quote: "quote-stage",
  "product-ui": "product-ui",
  chart: "data-stage",
  table: "data-stage",
  decision: "decision-close",
  closing: "decision-close",
});

function box(x, y, w, h) {
  return Object.freeze({ x, y, w, h });
}

const COMPOSITIONS = Object.freeze({
  "cover-hero.center": Object.freeze({
    family: "cover-hero",
    mediaMode: "static-native",
    boxes: Object.freeze({
      headline: box(0.75, 1.5, 8.5, 1.55),
      body: box(1.2, 3.35, 7.6, 0.82),
      annotation: box(0.75, 0.55, 3.2, 0.34),
      logo: box(8.25, 0.45, 1.0, 0.55),
      data: box(1.2, 4.35, 7.6, 0.72),
    }),
  }),
  "section-break.left": Object.freeze({
    family: "section-break",
    mediaMode: "static-native",
    boxes: Object.freeze({
      headline: box(0.75, 1.55, 7.6, 1.4),
      body: box(0.78, 3.25, 6.8, 0.85),
      annotation: box(0.78, 0.65, 3.0, 0.32),
      logo: box(8.35, 0.5, 0.9, 0.5),
      data: box(0.78, 4.35, 8.45, 0.7),
    }),
  }),
  "hero-performance.media-left": Object.freeze({
    family: "hero-performance",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(0.45, 0.45, 5.05, 4.725),
      headline: box(5.88, 1.0, 3.55, 1.45),
      body: box(5.9, 2.82, 3.4, 1.25),
      annotation: box(5.9, 0.52, 2.75, 0.32),
      logo: box(8.5, 0.45, 0.85, 0.48),
      data: box(5.9, 4.28, 3.35, 0.72),
    }),
  }),
  "hero-performance.media-right": Object.freeze({
    family: "hero-performance",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(4.5, 0.45, 5.05, 4.725),
      headline: box(0.58, 1.0, 3.55, 1.45),
      body: box(0.6, 2.82, 3.4, 1.25),
      annotation: box(0.6, 0.52, 2.75, 0.32),
      logo: box(3.2, 0.45, 0.85, 0.48),
      data: box(0.6, 4.28, 3.35, 0.72),
    }),
  }),
  "evidence-split.media-left": Object.freeze({
    family: "evidence-split",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(0.45, 1.05, 4.25, 4.0),
      headline: box(5.05, 0.62, 4.35, 1.2),
      body: box(5.08, 2.0, 4.15, 1.0),
      data: box(5.08, 3.25, 4.15, 1.55),
      annotation: box(0.48, 0.5, 3.2, 0.32),
      logo: box(8.55, 0.45, 0.8, 0.45),
    }),
  }),
  "evidence-split.media-right": Object.freeze({
    family: "evidence-split",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(5.3, 1.05, 4.25, 4.0),
      headline: box(0.58, 0.62, 4.35, 1.2),
      body: box(0.6, 2.0, 4.15, 1.0),
      data: box(0.6, 3.25, 4.15, 1.55),
      annotation: box(0.6, 0.5, 3.2, 0.32),
      logo: box(4.0, 0.45, 0.8, 0.45),
    }),
  }),
  "metric-focus.media-right": Object.freeze({
    family: "metric-focus",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(5.45, 0.75, 4.05, 4.1),
      headline: box(0.55, 0.62, 4.45, 1.05),
      body: box(0.58, 3.85, 4.25, 0.9),
      data: box(0.58, 1.85, 4.2, 1.65),
      annotation: box(0.58, 0.25, 3.0, 0.3),
      logo: box(8.55, 0.27, 0.85, 0.45),
    }),
  }),
  "comparison.media-center": Object.freeze({
    family: "comparison",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(3.25, 1.35, 3.5, 3.28),
      headline: box(1.15, 0.45, 7.7, 0.72),
      body: box(1.35, 4.78, 7.3, 0.48),
      data: box(0.45, 1.4, 2.45, 3.15),
      annotation: box(7.1, 1.4, 2.45, 3.15),
      logo: box(8.75, 0.45, 0.7, 0.4),
    }),
  }),
  "timeline.media-right": Object.freeze({
    family: "timeline",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(6.55, 1.3, 2.95, 3.7),
      headline: box(0.55, 0.5, 5.65, 0.9),
      body: box(0.58, 4.7, 5.6, 0.46),
      data: box(0.58, 1.62, 5.6, 2.8),
      annotation: box(6.55, 0.62, 2.3, 0.3),
      logo: box(8.7, 0.52, 0.7, 0.4),
    }),
  }),
  "process.media-left": Object.freeze({
    family: "process",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(0.5, 1.25, 3.0, 3.75),
      headline: box(3.95, 0.5, 5.45, 0.9),
      body: box(3.98, 4.7, 5.4, 0.46),
      data: box(3.98, 1.62, 5.4, 2.8),
      annotation: box(0.52, 0.62, 2.3, 0.3),
      logo: box(8.7, 0.52, 0.7, 0.4),
    }),
  }),
  "quote-stage.media-right": Object.freeze({
    family: "quote-stage",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(6.15, 0.6, 3.35, 4.48),
      headline: box(0.65, 0.65, 5.05, 0.72),
      body: box(0.68, 4.3, 4.95, 0.72),
      data: box(0.68, 1.65, 4.95, 2.35),
      annotation: box(0.68, 0.25, 2.8, 0.28),
      logo: box(8.7, 0.24, 0.7, 0.4),
    }),
  }),
  "product-ui.media-left": Object.freeze({
    family: "product-ui",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(0.45, 1.35, 2.75, 3.7),
      headline: box(3.6, 0.48, 5.85, 0.9),
      body: box(3.62, 4.68, 5.65, 0.48),
      data: box(3.62, 1.6, 5.65, 2.8),
      annotation: box(0.48, 0.55, 2.4, 0.3),
      logo: box(8.7, 0.42, 0.7, 0.4),
    }),
  }),
  "data-stage.media-right": Object.freeze({
    family: "data-stage",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(7.0, 1.35, 2.5, 3.65),
      headline: box(0.55, 0.5, 6.05, 0.86),
      body: box(0.58, 4.72, 6.05, 0.44),
      data: box(0.58, 1.62, 6.05, 2.8),
      annotation: box(7.0, 0.62, 2.0, 0.28),
      logo: box(8.72, 0.48, 0.68, 0.38),
    }),
  }),
  "decision-close.media-left": Object.freeze({
    family: "decision-close",
    mediaMode: "hybrid-video",
    boxes: Object.freeze({
      video: box(0.45, 0.5, 4.55, 4.62),
      headline: box(5.4, 0.9, 4.0, 1.3),
      body: box(5.42, 2.62, 3.8, 1.0),
      data: box(5.42, 3.85, 3.75, 0.86),
      annotation: box(5.42, 0.45, 2.8, 0.3),
      logo: box(8.55, 0.4, 0.8, 0.45),
    }),
  }),
});

const COMPOSITION_IDS_BY_FAMILY = Object.freeze(Object.keys(COMPOSITIONS).reduce((result, id) => {
  const family = COMPOSITIONS[id].family;
  if (!result[family]) result[family] = [];
  result[family].push(id);
  return result;
}, {}));

module.exports = {
  COMPOSITIONS,
  COMPOSITION_IDS_BY_FAMILY,
  FAMILY_FOR_ROLE,
};

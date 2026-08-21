# Benchmarks, evaluation, gallery, and blind tests

Read this reference when running regressions, comparing v1/v2, evaluating generated media, or publishing examples.

## Keep two evidence tracks separate

Fixed-media benchmarks use immutable local fixtures to test compiler decisions, typography, native layers, PPTX packaging, timing, render regression, and failure rejection. They should be deterministic on the pinned OS, fonts, renderer, evaluator/rubric, and runtime. They are test-only and cannot satisfy a v2 dynamic-slide candidate or public release.

Real-generation benchmarks test provider variability, character identity, body completeness, crop, action continuity, expressive relevance, and art direction. Every dynamic-slide attempt must bind a concrete external model invocation with `operation: generate-video`, provider/model/prompt hash/seed when supported/request or task ID/version/latency/cost, adapter implementation, inputs, and exact final MP4 output. Fixture/synthetic media, `import-video`, local clips, static/native/CSS/programmatic motion, and fixed-media results cannot be counted as real-generation evidence or candidate media.

The benchmark catalog under `references/benchmarks/` includes layout census, bust-to-full-body, Chinese mascot, occlusion/multiple-character selection, failure injection, and legacy-negative cases. The manifests are benchmark definitions, not evidence that a run passed.

Formal acceptance also requires three new real decks: a fictional brand launch, a public-domain science explainer, and an open-data product analysis. Re-run one fixed content plan through all four Style Packs to prove the change is structural rather than a palette swap. Do not reuse historical SpaceX/Qwen files to satisfy these runs.

## Acceptance dimensions

For generated work, score identity, full-body integrity, crop, idea expression, typography hierarchy, and motion continuity on a 1–5 scale. The target is median at least 4/5 on every dimension, with zero P0/P1 issues. Stability targets are at least 80% first-pass and 95% within the declared retry budget.

Aggregate actual run records with the executable gate:

```bash
node <SKILL_DIR>/scripts/benchmark_report.js runs.json --output benchmark-report.json
```

The command verifies retry-budget shape, derives first-pass/within-budget rates, computes the six medians from selected real-generation attempt records, rejects selected P0/P1, and emits a hash-bound report. The run manifest must already bind the external provider receipts and final media; aggregate mathematics or a `track: real-generation` label alone does not prove a model invocation. It exits non-zero when a gate fails.

Fixed visual regression requires OCR text equivalence and zero overflow/unintended occlusion. For unapproved pixel changes, use SSIM at least 0.995 under the pinned environment. These are release criteria only after an actual run produces receipts; do not cite the thresholds as achieved results.

Run the immutable render-index gate with an explicit OCR implementation/language:

```bash
python3 <SKILL_DIR>/scripts/visual_regression.py jobs/<slug> \
  --baseline-index qa/baseline/render-index.json \
  --current-index qa/current/render-index.json \
  --expected-text qa/expected-text.json \
  --ocr-command tesseract --ocr-language chi_sim+eng \
  --output qa/visual-regression.json
```

The gate re-hashes both render-index v2 evidence sets and every page, requires both overflow checks to have passed, computes full-frame windowed-luma SSIM, and compares NFKC/whitespace-normalized OCR exactly with the expected per-slide text. `--approved-change` may waive only the SSIM threshold; it never waives OCR, overflow, or byte integrity.

Keep the original 61-case v1 suite as a permanent regression baseline. The M0 coverage gate must retain at least 90% line and 85% branch coverage over the printed core-release trust kernel (`runtime/hash_bound_receipt.js` and `runtime/release_gate.js`), with `--all` enabled. That kernel is where every provider/renderer receipt and every candidate/final preflight crosses; broader compiler/render/job-controller behavior stays in integration suites and must not be misrepresented as having the same percentage.

## Public gallery gate

The gallery is generated only from completed, passed, explicitly public and `galleryEligible` real-generation benchmark-run manifests. Fixed-media runs remain internal regression evidence and cannot publish a v2 dynamic-slide candidate/gallery success. Each manifest must set a safe manifest-relative `jobDir`; the builder re-runs current v2 candidate/final validation and compares its released artifact hash with the declared PPTX. Each accepted entry must expose hash-bound brief, content, visual/design decision trace, external `generate-video` provider receipts, page renders, PPTX, QA/evaluation, a self-hashed passing benchmark report containing the run, sources, release label, and known limitations. Put remote source URLs inside a locally hash-bound source index; bare remote descriptors are not accepted as verified gallery evidence.

```bash
node <SKILL_DIR>/scripts/build_gallery.js \
  --output <new-gallery-directory> \
  <benchmark-run.json> [...]
```

The builder rejects private evidence, incomplete or failed runs, unbound artifacts, unsupported release labels, and anything classified/tagged `legacy-negative`. Historical Qwen, SpaceX, layout-check, and other pre-v2 files remain internal negative/regression material unless they independently pass the current full gate. SpaceX may remain an internal bust/framing regression; it is not a public success case.

Never hand-curate a failed or legacy item into the gallery.

## Blind comparison

Use at least five unique reviewers. Randomize and hide v1/v2 labels with a deterministic seed, keep the answer key separate, and collect all six rubric dimensions: `identity`, `body-completeness`, `crop-safety`, `claim-expression`, `typography-hierarchy`, and `motion-continuity`.

Create assignments:

```bash
node <SKILL_DIR>/scripts/blind_test.js assign \
  --input study.json \
  --ballots ballots.json \
  --key answer-key.json
```

After independent ratings, aggregate:

```bash
node <SKILL_DIR>/scripts/blind_test.js aggregate \
  --ballots ballots.json \
  --key answer-key.json \
  --ratings ratings.json \
  --output report.json
```

The target is v2 preference at least 70% overall and at least 60% for every benchmark, with no v2 P0/P1. A generated ballot, empty gallery, or passing unit test is not a completed blind study. Publish only the actual aggregate report and bound artifacts.

## Current-evidence wording

Use precise status labels:

- `implemented`: code/contracts exist and automated tests pass;
- `render-verified`: the exact artifact has a trusted render receipt;
- `candidate-released`: every automatic gate passed for the exact candidate bytes;
- `final-macos`: exact bytes passed real macOS PowerPoint playback;
- `human-accepted`: named reviewers completed the applicable visual/blind review.

Do not collapse these labels into “done.” Until real benchmark runs, a five-person review, and PowerPoint playback have occurred, describe the benchmark/gallery/blind/final capabilities as implemented but unexecuted.

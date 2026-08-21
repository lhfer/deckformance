# Deckformance

> Turn every slide into a scene.

Deckformance is an agent skill and deterministic build pipeline for editable, character-video PowerPoint decks. One consistent protagonist performs the idea on every content and closing slide; native PowerPoint layers carry the text, evidence, charts, tables, UI, logos, annotations, and sources.

Version 2 turns the original reliable media assembler into a design compiler: it resolves typography, semantic composition, native Hybrid layers, executable motion, media budgets, provider/renderer receipts, cross-agent packaging, release evidence, benchmarks, gallery eligibility, and blind-review gates without weakening the original fail-closed contract.

The installed command remains `/ppt-cast`.

## Product boundary

- Cover and true section pages may be `static-native`. Content and closing pages must be `hybrid-video` with exactly one same-protagonist video layer.
- Video expresses action, emotion, and metaphor. It must not burn in readable copy, precise data, fake logos, or fake UI.
- PowerPoint objects remain editable and source-backed. Registered logo/UI/image assets are hash-bound local bytes.
- A failed video page never becomes a still-image fallback or an empty “successful” deck.
- Automatic gates may publish only `candidate.pptx`. `final.pptx` requires exact-byte playback evidence from real Microsoft PowerPoint.

This is not a general static-slide factory and not a full-page AI-video generator.

## v2 pipeline

```text
brief + sources + character references
  -> approved content-plan.json
  -> approved visual-plan.json
  -> design-plan.json
       typography resolution + text fit
       semantic composition + stable layers
       final video slot + motion plan
       decision trace + rejected alternatives
  -> exact final poster/video bytes
  -> provider + media-budget + five-frame + evaluation receipts
  -> asset-manifest.json
  -> deterministic deck.json
  -> candidate.staging.pptx
  -> package QA + trusted true-render QA
  -> candidate.pptx
  -> exact-byte PowerPoint playback + bound capture
  -> final.pptx
```

Every arrow is hash-bound. Content, visual intent, font, Style Pack, provider output, slot, or motion drift invalidates media and downstream evidence. Renderer drift invalidates render QA. Evaluator/rubric drift invalidates visual QA.

## Design system

The v2 compiler separates the machine-facing `pageRole` from the visible `kicker`, then chooses a composition from page task, evidence shape, density, character action, negative space, and Style Pack preference.

The catalog covers 13 controlled task roles plus the closing alias, resolved into 12 semantic families and 14 concrete `compositionId` values: cover, section, hero, evidence, metric, comparison, timeline, process, quote, product UI, chart/table, and decision/closing. Agents declare intent; the compiler owns final coordinates and records its decision trace.

The native Hybrid renderer supports:

```text
video headline body metric quote chart table timeline process
image logo uiScreenshot annotation
```

Typography uses shared `display`, `headline`, `subhead`, `body`, `caption`, `data`, and `number` tokens across compiler, preview, and builder. Font family/fallback, file hash, weight, measurements, CJK punctuation, mixed CJK/Latin/number text, line count, orphan control, and the 50/35/24/16 pt semantic floors are resolved before media generation. Unresolvable fonts or text fit block the build.

Four executable Style Packs define more than color or prompts:

- felt yarn (`felt-yarn`)
- clay (`clay`)
- paper cut (`paper-cut`)
- cinematic miniature (`cinematic-miniature`)

Each pack declares material, palette, typography, composition preference, camera, motion, and a visual baseline.

## Install

```bash
git clone https://github.com/lhfer/deckformance.git
cd deckformance
npm ci --prefix .grok/skills/ppt-cast/scripts
```

The canonical skill lives at `.grok/skills/ppt-cast`. Copying it manually is supported for Grok, but host distributions should normally be generated from the canonical tree; see [Cross-agent distribution](#cross-agent-distribution).

## Runtime diagnosis

Run the runtime capability check before a formal job, then initialize a new/empty v2 job:

```bash
node .grok/skills/ppt-cast/scripts/doctor.js --release candidate --json
node .grok/skills/ppt-cast/scripts/jobctl_v2.js \
  init jobs/<slug> --job-id <slug>
```

At the release boundary, run `preflight.js jobs/<slug> --release candidate|final --json`. `doctor` and `preflight` return `ready`, `degraded`, or `blocked` with a hash-bound runtime receipt. Checks cover the supported Node range, locked dependencies, font availability/hashes, FFmpeg/FFprobe, renderer capability, AssetStore, job contract, and—only for final—PowerPoint.

`jobctl_v2 release` repeats preflight at the publication boundary. A `blocked` result cannot publish; a `degraded` result is restricted to an otherwise fully validated fixed-media path and never authorizes capability substitution.

Renderer paths are not self-declared trust. They must match an implementation pair in `references/renderer-trust-policy.json`, including names, versions, and SHA-256. At candidate and final publication, `jobctl_v2` reruns that approved renderer and overflow checker in an isolated temporary job and requires the reproduced render index and every page hash to match the canonical evidence exactly.

Candidate does not require PowerPoint. Final does. On a Mac without Microsoft PowerPoint, the highest honest deliverable is `candidate.pptx`.

## Build a v2 candidate

After authoring valid, approved `content-plan.json` and `visual-plan.json`:

```bash
node .grok/skills/ppt-cast/scripts/compile_design.js jobs/<slug>
node .grok/skills/ppt-cast/scripts/preview_design_v2.js jobs/<slug>
```

The optional preview emits `qa/design-preview.pptx` from the exact resolved typography and layer plan, with clearly marked non-media video-slot placeholders. It is an early design artifact only and can never satisfy candidate package/render gates.

Generate the exact final media for the compiler-resolved video slots. Store provider receipts, media-budget evidence, final five frames, slot composites, and structured evaluation receipts in `asset-manifest.json`. Then:

```bash
node .grok/skills/ppt-cast/scripts/compile_deck_v2.js jobs/<slug>

node .grok/skills/ppt-cast/scripts/build_deck_v2.js \
  jobs/<slug> jobs/<slug>/build/candidate.staging.pptx \
  --release candidate \
  --report jobs/<slug>/qa/build-report.json

node .grok/skills/ppt-cast/scripts/validate_pptx_v2.js \
  jobs/<slug> build/candidate.staging.pptx \
  --release candidate \
  --report qa/package-qa.json
```

The independent validator, not the builder diagnostic report, creates canonical `qa/package-qa.json`. True-render and inspect the exact staging artifact. The render receipt binds renderer/slides-test implementation hashes, versions, input SHA-256, page descriptors, PNG hashes, and overflow results. Only after those gates pass may the v2 release controller atomically publish the candidate:

```bash
node .grok/skills/ppt-cast/scripts/preflight.js \
  jobs/<slug> --release candidate --json

node .grok/skills/ppt-cast/scripts/jobctl_v2.js release jobs/<slug> candidate \
  --artifact build/candidate.staging.pptx \
  --package-qa qa/package-qa.json \
  --render-qa qa/render-qa.json

node .grok/skills/ppt-cast/scripts/validate_job_v2.js \
  jobs/<slug> --release candidate --json
```

See [.grok/skills/ppt-cast/references/v2-production.md](.grok/skills/ppt-cast/references/v2-production.md) for the full contract and true-render command.

## Candidate, final, and acceptance

Deckformance keeps four truth states independent:

| State | What it proves |
|---|---|
| Tests passed | Code/contracts passed their automated suite. |
| Trusted render passed | The exact PPTX produced valid full-page renders with no declared overflow failure. |
| Candidate released | Every automatic package, render, media, and evaluation gate passed for exact bytes. |
| Final/accepted | The exact same bytes passed real PowerPoint playback; human visual/blind acceptance is reported separately. |

The v2 builder intentionally creates candidate bytes only. Final is an exact-byte promotion after an external PowerPoint receipt binds the artifact SHA-256, OS, PowerPoint version, all dynamic slide IDs, playback behavior, test log, and a real 1080p/30fps-or-better MP4 capture.

Formal final validation also re-reads the live PowerPoint bundle, executable hash, Microsoft code signature, version, and macOS identity at the release boundary. The capture and event log remain human-observation evidence: the producer validates their structure and byte bindings but does not drive the UI or cryptographically prove their semantic origin. The named tester is responsible for confirming that they came from the exact candidate playback; Deckformance does not represent that human assertion as an automatic proof.

Expected playback: autoplay within one second of entering a slide, play once, no loop, no automatic slide advance, and correct forward/back/re-entry behavior.

## Motion and media budgets

`motionPlan` is an executable timeline with duration, enter/perform/hold phases, camera movement, gaze, safe area, final hold, and target layer. Clips are content-dependent, normally 3–10 seconds, H.264/yuv420p, silent, and 24/30 fps. Default limits are 12 MB per clip and a 100 MB embedded-media target per deck.

All crop, compression, and transcode operations happen before five-frame QA. Any media-byte change after QA revokes candidate eligibility. The motion schema can describe controlled native appear/fade beats, but candidate builds currently block them until their PowerPoint XML authoring and player behavior are independently proven. Complex transitions, audio, and multi-video pages remain outside v2.

## Portable runtime interfaces

- `ProviderAdapter` records provider, model, prompt hash, seed, request ID, version, duration, cost, and bound outputs.
- `RendererAdapter` declares capabilities and emits implementation/version/page receipts.
- `AssetStore` converts URLs, task IDs, and object-store results into retryable, job-local, hash-bound bytes.

Missing capabilities fail closed; an agent does not guess a substitute. Details are in [.grok/skills/ppt-cast/references/runtime-and-release.md](.grok/skills/ppt-cast/references/runtime-and-release.md).

## Cross-agent distribution

Generate Grok, Qwen, Codex, Claude, and Bailian packages from the one canonical core:

```bash
node .grok/skills/ppt-cast/scripts/generate_distributions.js \
  --out dist/skills \
  --targets grok,qwen,codex,claude,bailian
```

The generator produces canonical-tree manifests and refuses to overwrite a non-empty output root. Bailian receives a root-level `SKILL.md` ZIP without `node_modules` or generated media and enforces the 10 MB ceiling. Packaging proves the skill tree is portable; it does not prove provider quality, visual acceptance, or PowerPoint playback.

Generated project roots are `.grok/skills/ppt-cast`, `.qwen/skills/ppt-cast`, `.agents/skills/ppt-cast` for Codex, and `.claude/skills/ppt-cast`; Bailian receives the root ZIP form.

## Benchmarks, gallery, and blind review

Deckformance separates:

- fixed-media benchmarks for compiler, typography, layer, package, timing, and visual regressions;
- real-generation benchmarks for provider variability, identity, body integrity, crop, expressive relevance, motion continuity, and art quality.

The benchmark catalog includes layout census, bust-to-full-body, Chinese mascot, occlusion/multiple-character selection, failure injection, and legacy-negative cases. Definitions are not completed benchmark runs.

Aggregate real run records through the executable stability/quality gate:

```bash
node .grok/skills/ppt-cast/scripts/benchmark_report.js \
  runs.json --output benchmark-report.json
```

The report derives the 80% first-pass and 95% within-retry-budget gates, the six required medians at 4/5 or better, and zero selected P0/P1; it does not accept hand-entered aggregate claims.

Run fixed render regression from two immutable render-index v2 evidence sets:

```bash
python3 .grok/skills/ppt-cast/scripts/visual_regression.py jobs/<slug> \
  --baseline-index qa/baseline/render-index.json \
  --current-index qa/current/render-index.json \
  --expected-text qa/expected-text.json \
  --ocr-command tesseract --ocr-language chi_sim+eng \
  --output qa/visual-regression.json
```

It enforces bound page bytes, prior overflow success, exact normalized OCR, and SSIM at least 0.995 unless the pixel change is explicitly approved. Approval never waives OCR, overflow, or hash integrity.

The gallery builder accepts only completed, passed, explicitly public and gallery-eligible run manifests with bound brief, plans, decision trace, renders, PPTX, QA, sources, a self-hashed passing benchmark report, release label, hashes, and known limitations. It re-runs the current v2 release validator against the manifest-relative job and requires the published PPTX hash to match. Remote URLs are recorded inside the bound local source index rather than trusted as unhashed gallery evidence. Private, failed, incomplete, unbound, and `legacy-negative` material is rejected. Historical SpaceX/Qwen/layout-check files are internal regression/negative evidence, not public successes.

Blind comparison requires at least five reviewers, randomized hidden versions, no v2 P0/P1, at least 70% overall v2 preference, and at least 60% for every benchmark. Tooling and thresholds do not imply that a real gallery or blind study has already run.

See [.grok/skills/ppt-cast/references/benchmarks-and-gallery.md](.grok/skills/ppt-cast/references/benchmarks-and-gallery.md).

## v1 compatibility and migration

v1 remains readable and buildable through `jobctl.js`, `compile_deck.js`, `build_deck.js`, `validate_pptx.js`, and `validate_job.js`. Existing jobs are preserved as-is.

```bash
node .grok/skills/ppt-cast/scripts/migrate_v1.js \
  jobs/<v1-slug> --output-dir jobs/<v2-draft>
```

Migration creates a blocked draft marked for explicit v2 redesign. It cannot compile, release a candidate, or enter the gallery merely because migration succeeded.

## Requirements

- Node.js 20.x or 22.x and npm
- Python 3.10+
- FFmpeg and FFprobe
- locked Pillow runtime for image inspection/render helpers
- resolvable declared fonts
- a trusted presentation renderer for true-slide QA
- Microsoft PowerPoint on the target macOS environment only for `final-macos`

Provider credentials are never bundled. Job inputs, generated media, and private evidence remain outside the repository.

Provider receipts and EvaluationReceipts are not accepted on metadata shape alone: formal validation re-hashes the current provider/evaluator implementation files, rubric bytes, inputs, outputs, and evidence. Release also snapshots the complete job tree and checks it again at the rename/copy boundary so concurrent contract or evidence drift cannot publish.

## Test and coverage

```bash
npm test --prefix .grok/skills/ppt-cast/scripts
npm run coverage --prefix .grok/skills/ppt-cast/scripts
```

The suite creates synthetic media at runtime and covers v1 regression contracts, v2 schema/design/typography/layers/motion/media/receipts, runtime portability, package validation, release states, failure injection, gallery filtering, and blind-test aggregation. The 90% line/85% branch CI threshold is measured over the explicitly printed core-release trust kernel: hash-bound receipt creation/verification/atomic writes plus candidate/final preflight policy. Compiler, renderer, and orchestration integration remain covered by the broader test suite but are not blended into that kernel percentage. A green suite is engineering evidence, not a substitute for true rendering, real PowerPoint playback, or human visual acceptance.

Dependency note: `pptxgenjs@4` currently brings an upstream `image-size` advisory affecting ICNS/JXL/HEIF parsing. Deckformance's release path admits verified PNG posters and MP4 video, so the affected formats remain outside its media contract. The advisory is tracked rather than hidden through an incompatible downgrade.

## Repository layout

```text
.grok/skills/ppt-cast/
  SKILL.md              concise workflow router
  references/           focused production, runtime, QA, and benchmark guidance
  schemas/              preserved v1 schemas and schemaVersion 2.0.0 contracts
  scripts/              compilers, builder, adapters, QA, release, and distribution tools
  tests/                state and failure-injection tests
tests/                  build, media, render, portability, gallery, and blind tests
```

## License

[MIT](LICENSE)

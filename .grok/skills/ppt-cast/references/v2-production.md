# v2 production contract

Read this reference for every new Deckformance job. It defines the authoring order and the boundary between native PowerPoint layers and generated media.

## Artifact chain

All authored JSON uses `schemaVersion: "2.0.0"`. A new job progresses through this hash-bound chain:

```text
content-plan.json
  -> visual-plan.json
  -> design-plan.json                 deterministic compiler output
  -> final poster/video bytes
  -> provider + media-budget + evaluation receipts
  -> asset-manifest.json
  -> deck.json                        deterministic compiler output
  -> build/candidate.staging.pptx
  -> package QA + true-render QA
  -> candidate.pptx
```

Do not hand-edit `design-plan.json` or `deck.json`. Any change to content, visual intent, typography, Style Pack, registered assets, composition, video slot, provider output, or motion invalidates the affected downstream hashes and evidence. Renderer changes invalidate render QA; evaluator or rubric changes invalidate evaluation QA.

Initialize a new/empty job first:

```bash
node <SKILL_DIR>/scripts/jobctl_v2.js init jobs/<slug> --job-id <slug>
```

`pageRole` is machine-facing. `kicker` is visible copy. Keep them separate.

`mediaMode` is fixed by page type:

- `cover` and `section`: `static-native`.
- `content` and `closing`: `hybrid-video`, with exactly one main-character video layer.

There is no candidate/final static fallback for a failed dynamic page.

## 1. Author content and visual intent

Validate authored documents against `schemas/v2/content-plan.schema.json` and `schemas/v2/visual-plan.schema.json`.

Content owns claims, evidence, source IDs, visible copy, coverage, and notes. Visual intent owns `composition: auto|family`, `density`, `layerIntents`, `motionPlan`, media budget, registered assets, and the selected Style Pack. Structured chart/table values must come from source-backed evidence; never invent data to fill a layout.

Advance the v2 state machine in order as each contract becomes valid; do not edit `job.json` directly:

```bash
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> briefed --evidence brief.json
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> researched --evidence research/source-log.json
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> content-planned --evidence content-plan.json
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> character-ready --evidence character-model.json
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> visual-planned --evidence visual-plan.json
```

The four executable Style Packs are:

- `felt-yarn`
- `clay`
- `paper-cut`
- `cinematic-miniature`

Their JSON definitions specify material, palette, typography, composition, camera, motion, and visual baseline. A Style Pack is not a color swap or prompt suffix.

## 2. Compile the design before media generation

Run:

```bash
node <SKILL_DIR>/scripts/compile_design.js jobs/<slug>
node <SKILL_DIR>/scripts/preview_design_v2.js jobs/<slug>
```

`preview_design_v2.js` writes `qa/design-preview.pptx` with the compiler-resolved fonts, text fit, stable native layers, and labeled video-slot placeholders. It shares the builder's layer renderer but embeds no media, is not package QA evidence, and can never be promoted to candidate/final.

The compiler validates approved content/visual plans, resolves fonts and text fit, selects a semantic composition, assigns stable layer IDs and z-order, fixes the video slot, normalizes motion, records rejected choices, and writes `design-plan.json`.

After compilation, advance `design-planned` with `design-plan.json` as evidence:

```bash
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> design-planned --evidence design-plan.json
```

The catalog currently exposes 12 semantic families and 14 concrete `compositionId` values. They cover cover, section, hero, evidence, metric, comparison, timeline, process, quote, product UI, chart/table, decision, and closing tasks. Agents choose intent; the compiler owns final coordinates.

Typography uses the semantic tokens `display`, `headline`, `subhead`, `body`, `caption`, `data`, and `number`. The shared measurement layer resolves family/fallback, font file hash, weight, size, line height, letter spacing, line count, mixed CJK/Latin/number text, punctuation rules, and orphan handling. Respect the 50/35/24/16 pt semantic floors. If the declared fonts cannot be resolved or text cannot fit reliably, compilation stops; first shorten copy or change composition/density.

Supported declarative layers are:

```text
video headline body metric quote chart table timeline process
image logo uiScreenshot annotation
```

Text, data, charts, tables, UI annotations, logos, and sources remain native/editable. `image`, `logo`, and `uiScreenshot` must reference hash-bound registered assets. Video carries action, emotion, and metaphor only.

## 3. Produce final media bytes and receipts

Generate media only after `design-plan.json` fixes the slot, action envelope, negative space, timing, and safe crop. The chosen poster must already be a real PNG at the exact slot aspect. The chosen video must be the exact final H.264/yuv420p, silent, 24/30 fps bytes.

The executable motion plan carries duration, enter/perform/hold segments, camera movement, gaze, safe area, final hold, and target layer. Default duration is content-dependent from 3–10 seconds. A segment must stay at or below 12 MB; the deck target is at or below 100 MB. All crop, compression, and transcode operations happen before five-frame QA.

For imported or remote outputs, use the runtime adapters described in [runtime-and-release.md](runtime-and-release.md). Each canonical poster/video needs a hash-bound provider receipt. The manifest also binds:

- the selected still/video attempts;
- the media budget receipt;
- the final five frames and slot composite;
- an `EvaluationReceipt` with evaluator/rubric identity, scores, evidence frames, issues, and human review state;
- all current upstream artifact hashes.

Anonymous `all true` JSON is not evidence. Any post-QA media-byte change invalidates the manifest and deck.

After the complete bound manifest exists, advance `media-ready` with `asset-manifest.json` as evidence:

```bash
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> media-ready --evidence asset-manifest.json
```

## 4. Compile and build candidate bytes

Run the deterministic media binding, then build the staging file:

```bash
node <SKILL_DIR>/scripts/compile_deck_v2.js jobs/<slug>
node <SKILL_DIR>/scripts/build_deck_v2.js \
  jobs/<slug> jobs/<slug>/build/candidate.staging.pptx \
  --release candidate --report jobs/<slug>/qa/build-report.json
node <SKILL_DIR>/scripts/validate_pptx_v2.js \
  jobs/<slug> build/candidate.staging.pptx \
  --release candidate --report qa/package-qa.json
```

`compile_deck_v2.js` resolves manifest paths into `deck.json` and proves the deck is a deterministic function of the current design and media. `build_deck_v2.js` emits only candidate bytes. It renders the declared layers, embeds exactly one video on every dynamic page, generates the PowerPoint timing tree, and rechecks every bound receipt and package relationship.

`validate_pptx_v2.js`, not the builder's diagnostic report, creates the canonical `qa/package-qa.json` receipt. Advance the job to `packaged` with `deck.json` and `build/candidate.staging.pptx` as evidence before candidate release.

```bash
node <SKILL_DIR>/scripts/jobctl_v2.js advance jobs/<slug> packaged \
  --evidence deck.json --evidence build/candidate.staging.pptx
```

The timing contract is: play automatically within one second of entering the slide, play once, never loop, never auto-advance, and preserve manual forward/back/re-entry behavior. The schema reserves controlled native appear/fade beats, but candidate builds reject them until actual PowerPoint XML authoring and player behavior are proven; they are not silently recorded as if executed.

## 5. True render and candidate publication

Load the host presentation runtime, then render the same staging artifact with a declared `RendererAdapter` implementation:

```bash
python3 <SKILL_DIR>/scripts/render_pptx_qa.py \
  jobs/<slug> build/candidate.staging.pptx qa/rendered-candidate \
  --renderer <PPTX_SKILL>/container_tools/render_slides.py \
  --renderer-version <RENDERER_IMPLEMENTATION_VERSION> \
  --slides-test <PPTX_SKILL>/container_tools/slides_test.py \
  --slides-test-version <SLIDES_TEST_IMPLEMENTATION_VERSION> \
  --python <RUNTIME_PYTHON> \
  --runtime-node <RUNTIME_NODE> \
  --runtime-bin-dir <RUNTIME_OVERRIDE_BIN> \
  --runtime-node-modules <RUNTIME_NODE_MODULES>
```

Inspect every rendered page. Both implementation-version flags are mandatory declarations and are recorded alongside hashes; use the actual bundle/tool versions, never a placeholder or guessed label. The render receipt must bind renderer/slides-test implementation hashes, declared versions, artifact hash, page descriptors, image hashes, and overflow results. Package success, true-render success, PowerPoint playback, and human visual acceptance are four independent states.

The declared helper pair must also be approved by `references/renderer-trust-policy.json`. `jobctl_v2 release` independently rerenders the exact bytes with that approved pair and requires a byte-identical render index before publication; a hand-authored index or alternate pixel output cannot pass.

Use `jobctl_v2` only after its required v2 QA receipts are complete:

```bash
node <SKILL_DIR>/scripts/preflight.js jobs/<slug> --release candidate --json
node <SKILL_DIR>/scripts/jobctl_v2.js release jobs/<slug> candidate \
  --artifact build/candidate.staging.pptx \
  --package-qa qa/package-qa.json \
  --render-qa qa/render-qa.json

node <SKILL_DIR>/scripts/validate_job_v2.js jobs/<slug> --release candidate --json
```

Only that release step may atomically publish `candidate.pptx`. If any validator fails, stop and repair the upstream source; do not rename staging output by hand.

## v1 migration boundary

Existing v1 jobs remain buildable with `jobctl.js`, `compile_deck.js`, `build_deck.js`, `validate_pptx.js`, and `validate_job.js`. Do not rewrite them in place.

```bash
node <SKILL_DIR>/scripts/migrate_v1.js jobs/<v1-slug> --output-dir jobs/<v2-draft>
```

Migration creates a blocked v2 draft with `needsDesignReplan`; it cannot compile or become a candidate until an explicit v2 redesign removes the migration marker and passes the full v2 chain.

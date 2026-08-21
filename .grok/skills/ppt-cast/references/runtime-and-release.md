# Runtime portability and release

Read this reference when starting a job, integrating a provider/renderer, moving Deckformance across agents, or attempting a release.

## Diagnose capabilities before production

Run `doctor` before a formal workflow. Run `preflight` again at the release boundary, after the job and its canonical evidence exist:

```bash
node <SKILL_DIR>/scripts/doctor.js --release candidate --json
node <SKILL_DIR>/scripts/preflight.js jobs/<slug> --release candidate --json
```

`jobctl_v2 init` is deliberately safe scaffolding: it may create an empty `job.json` even when `doctor` is blocked, but that does not mean the runtime is ready or that any production stage has passed. An absent provider is only a warning because an already supplied, receipt-bound fixed-media set can be built; it does not authorize inventing media when neither a provider nor fixed assets exist.

`doctor` checks the supported Node/runtime range, locked dependencies, fonts and font hashes, FFmpeg/FFprobe, renderer capability, AssetStore, and—only for final—PowerPoint. `preflight` combines that runtime receipt with the job contract and returns one of:

- `ready`: all required capabilities and release inputs are present;
- `degraded`: the run may be inspectable, but is not fully reproducible; do not invent a replacement;
- `blocked`: a required capability or contract is missing.

Candidate preflight does not require Microsoft PowerPoint. Final preflight does. A machine without PowerPoint can deliver no higher than `candidate.pptx`.

The explicit `preflight` command is the inspectable receipt boundary. `jobctl_v2 release` also runs it internally immediately before either publication: `blocked` refuses publication, while `degraded` is limited to an otherwise fully validated fixed-media path and emits a warning. It never substitutes a missing capability.

Use the emitted receipt as evidence. Never replace a missing renderer, font, provider, or player with a hand-written boolean claim.

For the presentation-skill renderer, declare the exact trusted tools used by both render and release validation (values shown are placeholders for real resolved paths/versions, never literal production values):

```bash
export DECKFORMANCE_RENDERER=<absolute-render_slides.py>
export DECKFORMANCE_RENDERER_VERSION=<actual-bundle-or-tool-version>
export DECKFORMANCE_SLIDES_TEST=<absolute-slides_test.py>
export DECKFORMANCE_SLIDES_TEST_VERSION=<actual-bundle-or-tool-version>
export DECKFORMANCE_PYTHON=<absolute-render-python>
export DECKFORMANCE_NODE=<absolute-render-node>
export DECKFORMANCE_RUNTIME_BIN_DIR=<absolute-runtime-bin-dir>
export DECKFORMANCE_NODE_MODULES=<absolute-runtime-node-modules>
```

Candidate validation re-hashes those current files/executables and compares their live Python/Pillow and Node versions with the render index. It also probes the renderer's required Python packages and complete Node/module/bin runtime. A file merely named `render_slides.py`, an arbitrary hash, or a changed runtime is not trusted evidence.

Environment paths cannot approve themselves. The renderer/checker name, version, and exact SHA-256 pair must appear in `references/renderer-trust-policy.json`. Adding a new host renderer is a reviewed policy change. At candidate and final publication, `jobctl_v2` reruns the approved pair against the exact candidate bytes in an isolated temporary job and requires the entire reproduced render index—including every PNG hash—to equal the canonical evidence.

## Stable adapter boundaries

`ProviderAdapter` records the actual image/video generation or import operation: provider, model, prompt hash, seed when available, request ID, implementation/version, timing, cost, and hash-bound output bytes. A local import is still a provider operation and needs a receipt.

`RendererAdapter` declares its capabilities and emits a receipt containing implementation hash, version, input artifact hash, and a descriptor/hash for every rendered page. Renderer drift invalidates render QA.

`AssetStore` resolves a URL, provider task ID, or object-store object into job-local bytes. It owns retry/resume and verifies declared hashes. Downstream artifacts reference local, normalized, hash-bound paths—not transient remote URLs.

Adapters must fail closed when a capability is unavailable. The agent cannot silently substitute an unregistered renderer, static image, approximate font, or different provider output.

## Final is an external exact-byte promotion

The v2 builder creates candidate bytes only. `final.pptx` is a promotion of the exact already-validated PPTX bytes, not a rebuild after playback. The external PowerPoint receipt must bind:

- the candidate artifact SHA-256;
- OS and PowerPoint version;
- every dynamic slide ID;
- autoplay within one second, play once, no loop, no automatic page advance, forward/back/re-entry observations;
- a real MP4 capture at 1080p or higher and 30 fps or higher, with its SHA-256;
- tester and test-log identity.

Use final preflight and the v2 release controller:

```bash
node <SKILL_DIR>/scripts/doctor.js --release final --json
node <SKILL_DIR>/scripts/preflight.js jobs/<slug> --release final --json

python3 <SKILL_DIR>/scripts/powerpoint_verify_macos.py \
  jobs/<slug> <job-id> \
  qa/powerpoint-capture.mp4 \
  qa/powerpoint-test-log.json \
  qa/powerpoint-verification.json \
  --artifact candidate.pptx

node <SKILL_DIR>/scripts/jobctl_v2.js release jobs/<slug> final \
  --artifact candidate.pptx \
  --powerpoint-verification qa/powerpoint-verification.json

node <SKILL_DIR>/scripts/validate_job_v2.js jobs/<slug> --release final --json
```

The producer accepts only a real macOS capture and a structured log bound to the exact candidate, installed signed PowerPoint version, all dynamic slide IDs, and the required enter/play/end/forward/back/re-entry event sequence. Final validation independently re-runs `plutil` and `codesign`, re-hashes the current PowerPoint executable, and compares the live Microsoft team/bundle/version/system identity with the receipt.

The producer does not drive PowerPoint or synthesize observations. Capture content and the event log are therefore an explicit human trust boundary, not an automatic or cryptographic proof: the named tester must confirm that both came from the exact candidate run. The receipt and release controller re-hash the artifact and capture immediately before promotion. A different SHA-256, any repair/re-save prompt, missing-media warning, invalid capture, incomplete slide coverage, or live app drift blocks final.

## Canonical cross-agent distribution

`.grok/skills/ppt-cast` is the canonical core. Generate host-specific copies instead of editing multiple script trees:

```bash
node <SKILL_DIR>/scripts/generate_distributions.js \
  --out <new-or-empty-output-dir> \
  --targets grok,qwen,codex,claude,bailian
```

Each distribution includes a manifest bound to the canonical tree. The Bailian package places `SKILL.md` at ZIP root, excludes `node_modules` and generated media, and must stay within 10 MB. Long generation/render tasks belong behind provider, renderer, AssetStore, MCP, or service boundaries; credentials never belong in the distribution.

Qwen is the first non-Grok local candidate target. Cross-agent packaging proves portability of the skill and contracts; it does not prove provider quality, visual acceptance, or PowerPoint playback.

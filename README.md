# Deckformance

> **Turn every slide into a scene.**

Deckformance is an open agent skill for producing cinematic, video-powered PowerPoint decks in which one consistent character performs the idea of every content slide.

It turns a brief, character reference, brand direction, and source material into an editable `.pptx` with full-body continuity, varied layouts, embedded video, deterministic packaging, and fail-closed quality gates.

The installed skill command remains **`/ppt-cast`**.

## Why Deckformance

- **Content before decoration** — audience, purpose, thesis, evidence, coverage, and citations are planned before visual generation.
- **Identity is not framing** — a headshot or bust can define who the character is, but never freezes crop, pose, background, scale, or camera distance.
- **Full-body continuity** — cropped references must first produce a complete performance model with stable clothing, hands, feet, proportions, and support contact.
- **Layout grammar, not one rigid template** — ten parameterized media layouts adapt to copy density, shot type, action direction, and negative space.
- **Exact media contracts** — posters and videos must match the final slot aspect; true PNG, H.264, `yuv420p`, silent MP4, and 1080p-class limits are verified.
- **Hash-bound delivery** — manifest → compiled deck → PPTX package → rendered slides → release evidence is one traceable chain.
- **No false success** — a deck is published as `candidate.pptx` only after automatic gates pass; `final.pptx` additionally requires real PowerPoint playback evidence.

## Pipeline

```text
input
  → brief
  → research
  → content architecture
  → identity + full-body performance model
  → visual direction + shot-safe layout plan
  → still candidates
  → final video candidates
  → frame + slot QA
  → deterministic deck compilation
  → PPTX package validation
  → true-slide rendering
  → candidate release
  → PowerPoint playback verification
  → final release
```

## Install

Clone the repository and install the script dependencies:

```bash
git clone https://github.com/lhfer/deckformance.git
cd deckformance
npm ci --prefix .grok/skills/ppt-cast/scripts
```

Copy the skill into a project's Grok skill directory:

```bash
mkdir -p /path/to/project/.grok/skills
cp -R .grok/skills/ppt-cast /path/to/project/.grok/skills/
```

Then invoke `/ppt-cast`, or ask your agent to create a character-driven video PowerPoint.

## Requirements

- Node.js 20+ and npm
- Python 3.10+
- FFmpeg and FFprobe
- Pillow for preview and slot-composite scripts
- A compatible presentation renderer for true-slide QA
- Microsoft PowerPoint on macOS or Windows only when certifying `final.pptx`

Image and video generation providers are intentionally not hard-coded. The skill uses the generation capabilities available in the host agent environment and never bundles API keys or model credentials.

Dependency note: `pptxgenjs@4` currently brings an upstream `image-size` advisory for ICNS/JXL/HEIF parsing. Deckformance's release path accepts verified PNG posters and MP4 videos only, so those affected formats are outside its media contract. The advisory is tracked rather than hidden or “fixed” through an incompatible downgrade.

## Test

```bash
npm test --prefix .grok/skills/ppt-cast/scripts
```

The suite is self-contained: it generates synthetic media fixtures at runtime and does not require private examples, downloaded assets, or generated decks.

## Repository layout

```text
.grok/skills/ppt-cast/
  SKILL.md            # workflow entry point
  references/         # content, character, layout, QA, and release guidance
  schemas/            # Draft 2020-12 state and artifact contracts
  scripts/            # compiler, builder, media, render, and release tools
  tests/              # state and failure-injection tests
tests/                # build, media, preview, and render tests
```

## Privacy and release safety

- Job inputs and generated assets stay outside this repository.
- Job-local paths, hashes, MIME signatures, layout ratios, package relationships, and render evidence are validated before release.
- Published artifacts are promoted atomically from staging; failed releases remain quarantined.
- Invalidated releases are archived rather than silently overwritten or deleted.

## Candidate vs. final

- `candidate.pptx`: automatic content, character, media, package, and true-render gates passed; PowerPoint playback is not yet certified.
- `final.pptx`: the exact final bytes were tested in PowerPoint for autoplay-once, no loop, and manual slide advance, with a bound MP4 capture.

## 中文简介

Deckformance 是一个“角色出演式动态 PPTX”技能：用户提供主题、内容、品牌与角色参考后，它先完成研究和内容架构，再建立身份圣经与完整身体表演圣经，为每页选择合适景别和版式，生成并嵌入视频，最后通过严格的媒体、渲染和发布证据门交付。

它特别解决了半身参考被错误继承成“无腿角色”、视频被错误拉伸裁切、旧素材串用、空媒体成品以及手写 QA 假成功等问题。

## License

[MIT](LICENSE)

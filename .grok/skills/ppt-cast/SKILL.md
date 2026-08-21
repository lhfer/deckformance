---
name: ppt-cast
description: >
  Create a quality-first dynamic PowerPoint in which the same consistent
  character performs each content slide's idea inside an embedded video,
  while text remains editable in PPT. Use for 角色出演PPT, 每页视频PPT,
  mascot/character video decks, or /ppt-cast. Do not use for ordinary
  static decks or full-page AI videos with burned-in text.
---

# Deckformance (`ppt-cast`)

**Turn every slide into a scene.**

制作动态 PPTX：同一主角在每个内容页的视频槽里演绎该页观点；封面与真正的章节页可静态。配角只能服务内容，不能取代主角。

## 不可破的边界

- 全自动、质量优先：brief、研究、内容、角色与布局合同完成前不生成页面素材，也不设置人工“圣经确认”停点。
- 参考图锁身份，不锁裁切、姿势、背景、人物尺度或镜头距离；头像/半身来源必须先建立完整身体表演圣经。
- 每个动态页必须有主角参与 claim，并有通过 QA 的真实 PNG poster 与静音 H.264/yuv420p 视频；禁止空槽、静图降级或旧文件假成功。
- 视频不生成可读文字、假 logo、假 UI 或精确数据；可编辑文字、品牌资产与来源留在 PPT 图层和 speaker notes。
- 正常生产直接按最终 `layoutId` 槽位画幅生成并编码媒体。严禁在五帧/槽位 QA 或 manifest 之后 normalize、裁切或转码。
- 景别、镜头和时长按页面决定；不全局锁机位、不固定六秒、不使用 `Change only the scene`。
- 外部事实必须可追溯，并编译进对应 notes 的 `[Sources]`。
- `candidate.pptx` 仅代表自动门通过；只有最终文件的包、真实渲染和 PowerPoint 实机证据全部通过，才发布 `final.pptx`。

## 状态与真相源

先读 [contracts.md](references/contracts.md)。作者维护 `brief.json`、`character-model.json`、`content-plan.json`、`visual-plan.json` 与 `asset-manifest.json`，`jobctl` 维护 `job.json`；`deck.json` 和 `storyboard.md` 由编译器确定性生成。`deck.json` 虽是派生产物，仍受 `deck.schema.json`、`compiledFrom` hash 与 `packaged` 阶段追踪。

新 job 目录只能不存在、为空，或顶层仅有 `inputs/`（系统可能忽略 `.DS_Store`）：

```bash
node <SKILL_DIR>/scripts/jobctl.js init jobs/<slug> --job-id <slug>
node <SKILL_DIR>/scripts/jobctl.js status jobs/<slug> --json
node <SKILL_DIR>/scripts/jobctl.js refresh jobs/<slug>
```

任何上游漂移先 `refresh`，再重做被失效的下游；已发布文件会移入 `archive/invalidated/`，不删除旧证据来伪造连续性。

## 工作流

### 1. Brief、研究与内容

新任务读 [intake.md](references/intake.md) 与 [content-planning.md](references/content-planning.md)。`brief.creativeDirection` 必须记录语言、目标风格、mood、能量与禁用方向。

`content-plan.json` 每页写 `title / body / role / claim / evidence / evidenceBasis / transition / takeaway / sourceIds`。`coverageMatrix` 恰好覆盖每个 `mustCover`；每个 source 的 `supports` 列出其支持的 slide ID。用户未指定页数时推导 6–10 页，动态页最多八个。

```bash
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> briefed
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> researched --evidence research/source-log.json
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> content-planned
```

### 2. 身份圣经与表演圣经

读 [character-model.md](references/character-model.md)。自动诊断来源覆盖范围；身份圣经锁脸与识别特征，表演圣经锁 `bodyDesign`、完整身体、鞋/底座、比例和轮廓。

至少生成两个完整身体候选。只有身份一致、身体完整、比例稳定、可动画性四项均不低于 0.85 的候选才可通过，并自动选择加权最高者；再生成通过 QA 的 `sideActionReference`。均失败则停止。羊毛毡/针织任务才读 [presets/felt-yarn.md](references/presets/felt-yarn.md)。

```bash
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> character-ready
```

### 3. 视觉导演与布局合同

读 [style-lock.md](references/style-lock.md)、[palette.md](references/palette.md)、[visual-direction.md](references/visual-direction.md) 与 [storyboard.md](references/storyboard.md)。抽象关系无法视觉化时才查 [metaphor-table.md](references/metaphor-table.md)。

每个动态页必须声明 `characterPerformance`、准确的 `layoutId / layoutFamily / slot`，以及 `shotType / bodyVisibility / actionEnvelope / safeCrop / groundContact / framingBoundary / bodyContinuation`。实际 layout、family、画幅和坐标只信 [layouts.json](references/layouts.json)，选择规则读 [layouts.md](references/layouts.md)。

```bash
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> visual-planned
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> layout-ready --evidence visual-plan.json
```

### 4. 直接生成最终媒体并完成逐页 QA

开始生成前读 [qa.md](references/qa.md)。普通页先做两个静帧候选；关键页或定向补生成时总预算最多三个。选中的 poster 必须已经是槽位精确画幅的最终 PNG 字节：

```bash
python3 <SKILL_DIR>/scripts/compose_slot_qa.py jobs/<slug> <slide-id> stills/<id>.png qa/<id>/slot-composite.png
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> stills-ready --evidence qa/<id>/slot-composite.png
```

随后从合格 poster 生成最多三次视频尝试。先得到最终尺寸、最终编码、默认静音的 MP4，再从这个最终文件抽五帧：

```bash
python3 <SKILL_DIR>/scripts/extract_qa_frames.py jobs/<slug>/videos/<id>.mp4 jobs/<slug>/qa/<id>/frames
```

把最终 poster/video、候选、五帧、槽位合成图、文件 hash 与九项检查写入 `asset-manifest.json`，然后推进：

```bash
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> videos-ready --evidence asset-manifest.json
```

若导入素材必须修复格式或画幅，`normalize_media.js` 只能在上述 QA 之前使用；画幅不一致默认拒绝。显式 `--allow-crop` 后，输出视为全新素材，必须重做五帧、槽位合成、manifest 和 deck 编译，绝不能沿用旧 QA。

### 5. 编译、构建与发布 Candidate

只有 `videos-ready` 后才编译 deck；不要手写或修补 `deck.json`：

```bash
node <SKILL_DIR>/scripts/compile_deck.js jobs/<slug>
python3 <SKILL_DIR>/scripts/preview_deck.py jobs/<slug>/deck.json jobs/<slug>/preview
node <SKILL_DIR>/scripts/build_deck.js jobs/<slug>/deck.json jobs/<slug>/build/candidate.staging.pptx --release candidate
node <SKILL_DIR>/scripts/validate_pptx.js jobs/<slug>/build/candidate.staging.pptx --deck jobs/<slug>/deck.json --release candidate --report jobs/<slug>/qa/package-qa.json
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> packaged --evidence deck.json --evidence build/candidate.staging.pptx
```

`qa/package-qa.json` 必须由 validator 生成并同时包含当前 artifact 与 `deckSha256`；发布命令还会现场重跑包校验，不能手写全 true 报告。`preview_deck.py` 只是编译后预览，不是最终 PPTX QA。调用工作区依赖加载器取得 Python、Node、override bin 与 node_modules 路径，再真实渲染 staging PPTX：

```bash
python3 <SKILL_DIR>/scripts/render_pptx_qa.py jobs/<slug> build/candidate.staging.pptx qa/rendered-candidate \
  --renderer <PPTX_SKILL>/container_tools/render_slides.py \
  --slides-test <PPTX_SKILL>/container_tools/slides_test.py \
  --python <RUNTIME_PYTHON> \
  --runtime-node <RUNTIME_NODE> \
  --runtime-bin-dir <RUNTIME_OVERRIDE_BIN> \
  --runtime-node-modules <RUNTIME_NODE_MODULES>
```

逐页查看 `qa/rendered-candidate/render-index.json` 列出的真实 PNG，再复制其 artifact hash、页数、`renderedSlides` 与 overflow 结果，并把该 index 自身的 job-relative path/hash 写成 `renderIndexPath / renderIndexSha256`，补齐视觉门生成 `qa/render-qa.json`。发布校验会重新读取并逐字段核对这个绑定 index。随后发布：

```bash
node <SKILL_DIR>/scripts/jobctl.js release jobs/<slug> candidate --artifact build/candidate.staging.pptx --package-qa qa/package-qa.json --render-qa qa/render-qa.json
node <SKILL_DIR>/scripts/validate_job.js jobs/<slug> --release candidate --json
```

全部门通过后，`jobctl` 才把 staging 原子改名为根目录 `candidate.pptx`。

### 6. Final 实机门

没有 PowerPoint 实机环境时停在 candidate。Final 必须重新构建、校验、真实渲染，并在目标 PowerPoint 中测试**同一个 staging 文件字节**：

```bash
node <SKILL_DIR>/scripts/build_deck.js jobs/<slug>/deck.json jobs/<slug>/build/final.staging.pptx --release final --powerpoint-verified
node <SKILL_DIR>/scripts/validate_pptx.js jobs/<slug>/build/final.staging.pptx --deck jobs/<slug>/deck.json --release final --report jobs/<slug>/qa/final-package-qa.json
python3 <SKILL_DIR>/scripts/render_pptx_qa.py jobs/<slug> build/final.staging.pptx qa/rendered-final \
  --renderer <PPTX_SKILL>/container_tools/render_slides.py \
  --slides-test <PPTX_SKILL>/container_tools/slides_test.py \
  --python <RUNTIME_PYTHON> \
  --runtime-node <RUNTIME_NODE> \
  --runtime-bin-dir <RUNTIME_OVERRIDE_BIN> \
  --runtime-node-modules <RUNTIME_NODE_MODULES>
```

检查全部 final 渲染 PNG 后生成 `qa/final-render-qa.json`。PowerPoint 验收需生成带有效 `ftyp` 的真实 MP4 capture，并让 `qa/powerpoint-verification.json` 绑定 final staging hash、capture hash，且 `testedSlideIds` 恰好覆盖所有动态页。`--powerpoint-verified` 只解锁 staging 构建，不替代这份实机证据。

```bash
node <SKILL_DIR>/scripts/jobctl.js release jobs/<slug> final --artifact build/final.staging.pptx --package-qa qa/final-package-qa.json --render-qa qa/final-render-qa.json --powerpoint-verification qa/powerpoint-verification.json
node <SKILL_DIR>/scripts/validate_job.js jobs/<slug> --release final --json
```

全部门通过后才原子发布根目录 `final.pptx`。任一命令或证据失败都不得继续发布。

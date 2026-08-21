# ppt-cast 状态与数据契约

这套契约把“生成过文件”与“可以发布”分开。六个权威状态 JSON 都使用 `schemaVersion: "1.0.0"`，schema 位于 `schemas/`：

| 文件 | 负责的唯一事实 |
|---|---|
| `brief.json` | 主题、受众、目的、核心主旨、必讲内容、品牌、资料边界 |
| `character-model.json` | 输入图诊断、身份冻结、身份圣经、完整身体表演圣经、裁切规则 |
| `content-plan.json` | 论证闭环、来源、逐页 `role / claim / evidence / transition / takeaway` |
| `visual-plan.json` | 品牌导演系统、可编译配色、逐页视觉命题、版式和景别安全计划 |
| `asset-manifest.json` | 所有候选、最终 poster/video、实际文件 hash、逐页绑定 QA |
| `job.json` | 阶段、已完成/失效阶段、追踪 hash、candidate/final 发布状态 |

`deck.json` 从 content、visual、manifest 与固定 layout registry 确定性编译，受独立 `deck.schema.json` 约束并在 `packaged` 阶段追踪；它不是第七份人工维护的真相源。storyboard、PPTX 和预览同样不能反过来覆盖权威状态契约。

## 路径与 hash

- 契约内所有本地路径必须相对 job 根目录，使用 `/`；绝对路径、反斜杠、空段、`.`、`..` 和逃出 job 的符号链接均拒绝。
- hash 写成 `sha256:<64 个小写十六进制字符>`，针对文件原始字节计算。
- `content-plan` 和 `character-model` 绑定当前 `brief`；`visual-plan` 绑定当前 brief、character model、content plan；`asset-manifest` 绑定当前 character model、content plan、visual plan。
- `deck.compiledFrom` 必须绑定当前 content plan、visual plan、asset manifest 和 skill 内固定 `references/layouts.json` 的原始字节 hash；四者任一变化都必须重新编译。
- `job.trackedArtifacts` 是阶段完成时的快照。上游文件变化后，`jobctl refresh` 将变更点及全部下游阶段失效、清空发布状态；已发布 PPTX 原子移入 `archive/invalidated/`，不删除，因此同一 job 可以安全重做。
- 不能用更新下游 hash 的方式“续命”旧素材。上游改变后必须重新产出、重新 QA，再由阶段推进记录新 hash。
- `validate_job.js` 在运行时完整执行七个 Draft 2020-12 schema，再执行跨文件、实际字节与发布语义硬门；未知枚举或额外字段不能绕过手写校验逻辑。

## 关键字段与硬门

### Brief 与内容

- `brief.coreMessage` 是全套唯一主旨；`mustCover` 至少一项。`creativeDirection` 必须结构化记录语言、目标风格、mood、能量和禁用方向。
- `brand.assetPaths` 中每个路径都必须在 `sourceMaterials` 找到同路径、同 SHA-256 的记录，不能引用未登记品牌资产。
- `requestedPageCount` 可为 2–10 的明确页数；为 `null` 时内容计划必须自动推导 6–10 页。
- `content-plan` 总页数最多 10，动态页最多 8。`cover`、`section` 的 `videoRequired` 必须为 `false`；`content`、`closing` 必须为 `true`。
- 每页必须有可直接显示的 `title` 和 1–3 条 `body`；它们是 deck 文案的唯一来源。
- `coverageMatrix` 必须让每个 `brief.mustCover` 恰好出现一次，并绑定至少一个存在的 slide ID 和非空 support。
- 动态页不得空 `sourceIds`，并用 `evidenceBasis` 精确标明 `user-material / public-source / inference / mixed`。每个 source 都完整声明 url、publisher、retrievedAt 与 `supports`（不适用值写 `null`）；`supports` 必须含被其支撑的 slide ID，公开来源还必须有 http(s) URL 和 retrievedAt。

### 角色模型

- `referenceDiagnostic.coverage` 描述原图是头像、半身、全身、遮挡、多人物或非人形；它不是后续构图指令。
- `identityBible` 锁身份；`performanceBible` 至少有两个完整身体候选，并另外绑定一个通过 QA 的 `sideActionReference`。候选的 id、path、hash 必须分别唯一，不能复制一张图冒充多候选。
- human/humanoid 的低清脸、纯背面或任何低于 0.75 的主体选择置信度直接失败；`not-applicable` 只用于非人形。
- passed 候选四项分数均须至少 0.85；选择项必须是按 identity 35%、body 30%、proportion 20%、animatability 15% 计算的最高分候选。
- `bodyDesign` 必须记录 stature、比例说明、完整衣着、鞋/底座、手或肢端、轮廓和由裁切输入补出的设计，避免后续页面重新猜裤装与鞋。
- 选中的表演圣经必须为 `full-body`、无缺失部位、肢端可见、支撑接触可见且稳定。人类/人形角色必须声明并显示头、躯干、双臂、双手、双腿和双脚。
- `promptPolicy.doNotCopyFromSource` 必须明确包含 `crop / pose / background / subject-scale / camera-distance`。
- `cropPolicy.forbiddenJoints` 至少覆盖颈、肩、肘、腕、腰、膝和踝。

### 视觉计划

- `brandDirection.deckPalette` 是编译 `deck.json` 的命名色源：`bg / panel / title / body / muted / accent / ink / inkMuted`；`sourceSwatches` 保留颜色推导依据。
- `brandDirection.typography` 必须明确 `title / body / number / rationale`；前三项精确编译到 `deck.fonts`，不得回落到 Arial。
- 每个动态页必须有一句 `visualProposition`，并将画面约束分成 `required / optional / forbidden`；`forbidden` 必须含 `readable-text`。
- 每个动态页必须声明 `characterPerformance.present: true`、角色在 claim 中的作用和实际动作。
- `layoutId` 只能取 `layouts.json` 当前十个动态布局之一；`layoutFamily` 必须等于 registry 中该 layout 的 family，slot 比例也必须一致。
- `shotPlan` 还必须用 `framingBoundary` 和 `bodyContinuation` 解释身体去向：全身为 `full-body-contained`，非全身只能自然出框、合理遮挡或主动 close-up；合理遮挡必须给出原因。
- 走动、跳跃、着陆、推拉和大型道具动作强制 `full-body`。动作包络必须完全落在最终视频槽的安全裁切区内。
- `slot.aspect` 必须与目标像素宽高一致；poster 和视频实际宽高也必须保持同一画幅。1080p class 按方向无关方式判断：长边不超过 1920，短边不超过 1080，所以 1080×1920 竖片合法。

### 确定性 deck 编译

- 静态 cover/section 使用 `title-card`；动态页 layoutId 来自 visual plan，poster/video 来自 manifest。
- slide ID、总数、title/body/kicker、sources、layoutId 和 canonical media 必须与三份上游契约逐项一致。
- `deck.palette` 精确复制命名色，`deck.fonts` 精确复制 typography，视频音量为 0。
- deck 在 `packaged` 阶段追踪；deck 字节或 layout registry 漂移会回退到 `videos-ready`，保留已验素材但强制重新编译、打包和 QA。

### 素材与 QA

- 正常生产直接按 visual slot 的最终比例和像素生成；选中 poster/video 必须先成为最终 PNG/H.264 静音字节，再抽五帧、生成槽位合成图并写 manifest。QA 后 normalize、裁切或转码一律使全部下游证据失效。
- 每个动态页必须同时存在真实 PNG poster 和 H.264/yuv420p/静音 MP4；缺任何一个都失败，不能降级成静图发布。
- 每页记录 2–3 个静帧候选和 1–3 次视频尝试；同类尝试的 id、path、hash 必须唯一且 reason 非空，恰好一个候选分别匹配最终 poster/video。
- QA 必须绑定最终 poster hash、video hash、表演圣经 hash 和 visual-plan hash。
- 五帧抽检固定为 `0 / 0.2 / 0.5 / 0.8 / 1`，另有最终槽位合成图。身份、身体、肢体数、支撑、动作安全区、遮挡连续、主动景别、无字和槽位裁切九项全部为真才通过。
- PPTX 打包后还必须真实渲染全部页面；逐页检查溢出、标点孤行/异常换行、裁切、媒体 poster、版式节奏。render QA 必须列出每页真实 PNG 的安全路径、hash、尺寸和连续页码，不能只靠 JSON 自证。
- 校验器会读实际文件：核对大小和 SHA-256，验证 PNG/IHDR、MP4 `ftyp`、PPTX ZIP 签名，并拒绝符号链接逃逸。

`normalize_media.js` 只用于 QA 前修复导入素材。画幅不一致默认拒绝；显式 `--allow-crop` 后必须把输出当作全新素材，重做五帧、槽位合成、manifest 和 deck 编译。它生成的 `deck.normalized.json` 不能作为发布主路径输入。

## 阶段状态机

阶段只能按顺序推进：

```text
initialized → briefed → researched → content-planned → character-ready
→ visual-planned → layout-ready → stills-ready → videos-ready
→ packaged → qa-passed → candidate-released → final-released
```

- `advance` 只能进入下一个阶段；`qa-passed`、`candidate-released`、`final-released` 由发布命令完成，不能手动跳过。
- `briefed`、`content-planned`、`character-ready`、`visual-planned`、`videos-ready` 分别记录对应正式契约的 hash；`packaged` 记录最终编译的 deck hash。
- `layout-ready` 由 visual plan 的精确 layoutId/slot 合同代表；asset manifest 尚未存在，因此不提前追踪一个不可能完整的 deck。`packaged` 前按 compile → build 执行。
- 任何 `advance` 或 `release` 都先检查追踪 hash；发现漂移时自动回退并拒绝继续。

```bash
node <SKILL_DIR>/scripts/jobctl.js init jobs/<slug> --job-id <slug>
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> briefed
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> researched --evidence research/source-log.json
node <SKILL_DIR>/scripts/jobctl.js advance jobs/<slug> content-planned
# 按状态机继续，直到 packaged
node <SKILL_DIR>/scripts/jobctl.js status jobs/<slug> --json
node <SKILL_DIR>/scripts/jobctl.js refresh jobs/<slug>
```

`init` 只接受不存在/空目录，或顶层仅有 `inputs/` 原始输入与 `.DS_Store` 的目录；发现旧 deck、PPTX、stills、videos、qa 等产物立即拒绝，不提供自动 adopt。`--evidence` 可重复；证据文件也必须在 job 内。`status` 和 `validate_job` 只读；`refresh` 更新状态/hash，并把已发布件归档到 `archive/invalidated/`，不删除证据。

生产顺序固定为：`visual-planned → layout-ready → stills-ready → 最终媒体与逐页 QA → asset-manifest → videos-ready → compile_deck → preview → build staging → validate_pptx → packaged → true render → release`。`deck.json` 只能在 manifest 完成后编译；preview 不能提前充当布局或发布证据。

## Candidate 与 Final

Candidate 表示所有自动门已通过，但明确 `playbackVerified: false`。构建器先只写隔离文件 `build/candidate.staging.pptx`；打包检查器针对该字节生成 `qa/package-qa.json`：

```json
{
  "artifactSha256": "sha256:<build/candidate.staging.pptx 的 64 位小写十六进制 hash>",
  "deckSha256": "sha256:<当前 tracked deck.json hash>",
  "expectedContentPages": 3,
  "embeddedVideoCount": 3,
  "posterCount": 3,
  "timingCount": 3,
  "relationshipsValid": true,
  "mimeTypesValid": true,
  "aspectRatiosValid": true,
  "passed": true
}
```

再从同一 staging PPTX 的真实渲染结果生成独立的 `qa/render-qa.json`：

```bash
python3 <SKILL_DIR>/scripts/render_pptx_qa.py jobs/<slug> build/candidate.staging.pptx qa/rendered-candidate \
  --renderer <PPTX_SKILL>/container_tools/render_slides.py \
  --slides-test <PPTX_SKILL>/container_tools/slides_test.py \
  --python <RUNTIME_PYTHON> \
  --runtime-node <RUNTIME_NODE> \
  --runtime-bin-dir <RUNTIME_OVERRIDE_BIN> \
  --runtime-node-modules <RUNTIME_NODE_MODULES>
```

脚本写出 `qa/rendered-candidate/render-index.json`。逐页检查 index 列出的 PNG 后，复制它的 artifact hash、页数、`renderedSlides` 与 overflow 结果，并将 index 自身 path/hash 写入报告；不能手写不存在的像素证据，也不能换用未出现在绑定 index 中的 PNG。

```json
{
  "artifactSha256": "sha256:<build/candidate.staging.pptx 的 64 位小写十六进制 hash>",
  "slideCount": 2,
  "renderIndexPath": "qa/rendered-candidate/render-index.json",
  "renderIndexSha256": "sha256:<render-index.json hash>",
  "renderedSlides": [
    {"slideNumber": 1, "path": "qa/rendered-candidate/slide-01.png", "sha256": "sha256:<...>", "width": 1920, "height": 1080, "mime": "image/png"},
    {"slideNumber": 2, "path": "qa/rendered-candidate/slide-02.png", "sha256": "sha256:<...>", "width": 1920, "height": 1080, "mime": "image/png"}
  ],
  "allSlidesInspected": true,
  "overflowPassed": true,
  "textWrapPassed": true,
  "cropPassed": true,
  "mediaPosterPassed": true,
  "layoutRhythmPassed": true,
  "passed": true
}
```

然后发布；`jobctl` 会绑定 PPTX 与证据 hash、再次执行全部严格门，全部通过后才将 staging 原子 rename 为根目录 `candidate.pptx`，并依次记录 `qa-passed` 和 `candidate-released`。状态写入失败时文件自动回滚到 staging：

```bash
node <SKILL_DIR>/scripts/jobctl.js release jobs/<slug> candidate \
  --artifact build/candidate.staging.pptx \
  --package-qa qa/package-qa.json \
  --render-qa qa/render-qa.json
```

`jobctl` 不会因 PPTX“看起来存在”而自行声称 timing、关系、MIME 或真实渲染已通过；两份证据都必须存在、绑定同一个 staging hash，并分别通过。发布前 jobctl 还会对 staging PPTX 和当前 tracked deck 直接重跑 `validate_pptx.js`，逐字段比对新报告；手写一份全 true JSON 无法绕过实际包检查。根目录 `candidate.pptx` 的存在本身即表示 release transaction 已完成。

Final 以 `build/final.staging.pptx` 开始，需要三份彼此独立的证据：重新执行的打包 QA、真实渲染 QA、真实 PowerPoint 播放验收。不能沿用 candidate 的报告；`qa/final-package-qa.json` 必须直接声明 staging final 的 hash：

```json
{
  "artifactSha256": "sha256:<build/final.staging.pptx 的 64 位小写十六进制 hash>",
  "deckSha256": "sha256:<当前 tracked deck.json hash>",
  "expectedContentPages": 3,
  "embeddedVideoCount": 3,
  "posterCount": 3,
  "timingCount": 3,
  "relationshipsValid": true,
  "mimeTypesValid": true,
  "aspectRatiosValid": true,
  "passed": true
}
```

`qa/powerpoint-verification.json` 的最小形态为：

```json
{
  "artifactSha256": "sha256:<实际测试的 build/final.staging.pptx hash>",
  "platform": "macos",
  "appVersion": "PowerPoint 16.x",
  "testedAt": "2026-08-20T12:00:00.000Z",
  "capturePath": "qa/powerpoint-capture.mp4",
  "captureSha256": "sha256:<真实 MP4 录屏 hash>",
  "testedSlideIds": ["01", "02", "03"],
  "autoPlayOnce": true,
  "noLoop": true,
  "manualAdvance": true,
  "passed": true
}
```

staging final 还必须用相同 renderer/runtime 参数输出到新的 `qa/rendered-final`，逐页检查后生成 `qa/final-render-qa.json`；字段与 candidate render QA 相同，但 `artifactSha256` 与每个 `renderedSlides` descriptor 必须绑定 staging final，不能沿用 candidate 的报告。PowerPoint capture 必须为实际 `.mp4`/`ftyp` 文件，JSON 或任意占位文件不算证据。

```bash
node <SKILL_DIR>/scripts/jobctl.js release jobs/<slug> final \
  --artifact build/final.staging.pptx \
  --package-qa qa/final-package-qa.json \
  --render-qa qa/final-render-qa.json \
  --powerpoint-verification qa/powerpoint-verification.json
```

package QA 必须绑定当前 tracked deck。final package QA、final render QA 或 PowerPoint 实机证据任一缺失/过期，均拒绝发布；全部通过后 jobctl 才原子生成根目录 `final.pptx`。PowerPoint 证据必须绑定相同 final 字节、真实 MP4 capture 文件，并恰好覆盖所有动态 slide ID。

只检查或给 CI 使用：

```bash
node <SKILL_DIR>/scripts/validate_job.js jobs/<slug> --release candidate --json
node <SKILL_DIR>/scripts/validate_job.js jobs/<slug> --release final --json
```

成功返回 0，契约或发布门失败返回 1，CLI 用法错误返回 2。

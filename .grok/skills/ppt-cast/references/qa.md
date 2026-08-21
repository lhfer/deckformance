# 候选、媒体与发布 QA

逐页选择与证据最终写入 `asset-manifest.json`；状态、hash 和发布证据形态见 [contracts.md](contracts.md)。QA 绑定的是最终字节，不是“看起来相同”的旧尝试。

## 静帧与槽位证据

- 普通动态页先生成两个候选；关键页或普通页的定向补生成总预算最多三个。
- 候选从一开始就按 `visual-plan.slot` 的精确画幅生成。选中的 canonical poster 必须已是最终 PNG 字节，不能在 QA 后转格式或裁切。
- 自动检查切题性、身份一致、`bodyDesign`、品牌、层级、伪文字和构图安全；预算用尽仍失败则整套停止。
- 用选中 poster、content plan 与 visual plan 生成真实 1920×1080 槽位合成图；脚本拒绝隐式裁切：

```bash
python3 <SKILL_DIR>/scripts/compose_slot_qa.py jobs/<slug> <slide-id> stills/<id>.png qa/<id>/slot-composite.png
```

静帧硬门：`required` 全覆盖；`forbidden` 未触发；主角参与 claim；身份与双圣经一致；`bodyVisibility`、`framingBoundary`、`bodyContinuation`、遮挡和支撑合理；没有可读生成文字或假品牌资产。

## 最终视频与五帧

每页最多三次视频尝试。先取得与槽位完全一致、H.264、`yuv420p`、默认静音、1080p class 的最终 MP4，再从该文件抽首帧、20%、50%、80%、尾帧：

```bash
python3 <SKILL_DIR>/scripts/extract_qa_frames.py jobs/<slug>/videos/<id>.mp4 jobs/<slug>/qa/<id>/frames
```

五帧共同检查：身份、服装和比例无漂移；肢体数稳定；所需身体部位存在；支撑和遮挡连续；动作落在 `actionEnvelope ⊆ safeCrop`；`framingBoundary` 始终成立；没有伪文字、假 UI、水印、严重变形或闪烁。

## Manifest 的写入时点

只有最终 poster/video、五帧和槽位合成图都存在后才写 `asset-manifest.json`。每个动态页必须：

- 记录 2–3 个 still attempts、1–3 个 video attempts；同类 attempt 的 id、path、hash 各自唯一且 reason 非空，并分别恰好一个 `selected` 与 canonical poster/video 的 path、hash 相同。
- 记录实际 bytes、像素、MIME、codec、pixel format、静音和时长；校验真实 PNG/IHDR 与 MP4/`ftyp`。
- 让 QA binding 同时匹配 poster、video、选中表演圣经和当前 visual-plan hash。
- 记录五个带 `timeRatio` 的真实 PNG descriptor 与最终 `slotComposite` descriptor，并让九项 checks 全部为真。

`manifest → deck → PPTX package` 是逐媒体 hash 链：`compile_deck.js` 只引用 manifest 中已选且通过 QA 的媒体；builder/validator 再核对实际源文件和包内 poster/video 字节。任一环漂移都必须回退，不能只改 JSON hash。

## Normalize 只是一条 QA 前修复支路

正常生产不得运行 normalize。导入素材需要统一格式时，`normalize_media.js` 只能在任何五帧、槽位合成或 manifest 之前使用；画幅不一致默认拒绝。`--allow-crop` 会产生全新字节，必须重做全部逐页 QA、manifest 与 deck 编译。

禁止把 `deck.normalized.json` 直接交给 build/release，也禁止在 `videos-ready` 后 normalize、转码或裁切。

## 编译、包 QA 与 staging

`videos-ready` 后运行 `compile_deck.js`。它生成受 `deck.schema.json` 约束的 `deck.json` 和 storyboard，并绑定 content、visual、manifest 与 layout registry hash。`preview_deck.py` 只是编译后预览，不能证明最终 PPTX 正确。

Candidate 构建到 `build/candidate.staging.pptx`。`validate_pptx.js --deck deck.json --report qa/package-qa.json` 必须同时绑定 `artifactSha256` 和当前 `deckSha256`，并核对媒体数量、poster、MIME、关系、精确画幅、自动播放 timing 与 `[Sources]`。`packaged` 阶段追踪 deck；deck 或 layouts 漂移会回退到 `videos-ready`。

发布时 `jobctl` 会直接重跑 `validate_pptx.js` 并逐字段核对报告；手写全 true 的 package JSON 不能绕过实际包检查。

## 真实 PPTX 渲染

对 staging PPTX 运行 `render_pptx_qa.py`。脚本调用目标 presentation/PPTX skill 的 `container_tools/render_slides.py` 与 `slides_test.py`，固定全部页面的真实 PNG、hash、尺寸和连续页码到 `render-index.json`；输出目录必须是新的，不能混入旧证据。

逐页目检 index 中**每一张** PNG 后，生成 release 用 render QA，原样复制 `artifactSha256 / slideCount / renderedSlides / overflowPassed`，并写入该 index 的 `renderIndexPath / renderIndexSha256`。发布器会校验 index 的 producer、staging artifact、renderer、overflow 结果和逐页 descriptors，不能换成另一批任意 PNG。只在实际通过时把以下项设为 true：

- `allSlidesInspected`
- `textWrapPassed`
- `cropPassed`
- `mediaPosterPassed`
- `layoutRhythmPassed`
- `passed`

包检查不能替代视觉检查，`preview_deck.py` 也不能替代真实渲染。Final 使用独立的 `qa/rendered-final` 与 `qa/final-render-qa.json`，不得复用 candidate PNG 或报告。

## Candidate 与 Final

- Candidate 的 package/render QA 都绑定 `build/candidate.staging.pptx`。全部自动门通过后，`jobctl release` 才原子改名为根目录 `candidate.pptx`；此前不得出现或覆盖正式名。
- Final 重新构建为 `build/final.staging.pptx`，重新做 package QA 与真实渲染，并在 PowerPoint 中测试这份精确字节。
- `qa/powerpoint-verification.json` 必须绑定 final staging 的 `artifactSha256`、带有效 `ftyp` 的真实 `.mp4` capture path/hash、平台/版本/时间，并让 `testedSlideIds` 恰好覆盖所有 `videoRequired: true` 页面；同时验证自动播放一次、无循环、手动翻页。
- Final 的 package/render/PowerPoint 三份证据全部通过后，`jobctl release` 才原子发布根目录 `final.pptx`。单平台通过不代表另一平台已认证。

没有实机证据时最多发布 candidate。任何动态页缺媒体、证据过期或门失败时，candidate/final 都不得产生或更新。

## 回归与故障注入

角色覆盖至少包括头像、胸像/半身、坐姿遮挡、全身、多人物、边缘切手脚、非人形、低清或强侧脸。历史“胸像落地”问题按 [character-model.md](character-model.md) 的边界回归，不把所有近景一概判错。

另外验证缺 poster/video、损坏媒体、错误画幅、过期 hash、QA 后媒体变化、deck/layout 漂移、staging 构建中断、正式文件已存在、越界路径与假 capture 均不能发布。

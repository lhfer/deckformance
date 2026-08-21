# 版式语法与媒体画幅

英寸坐标、字号、family 和媒体画幅的唯一数据源是 `layouts.json`。`visual-plan.json` 必须同时保存准确的 `layoutId`、对应 `layoutFamily` 与槽位合同；编译器逐项核对。

幻灯片固定为 10" × 5.625"（16:9）。版式按叙事任务、文案密度、角色景别、动作方向与负空间选择，不做机械轮换。

## 精确 layout 映射

| layoutId | layoutFamily | 媒体画幅 | 适用场景 |
|---|---|---:|---|
| `title-card` | `title` | — | 静态 cover/section；不进入 visual plan 的动态页数组。 |
| `cinematic-full` | `full-bleed-cinema` | 16:9 | 全幅电影镜头＋信息板。 |
| `split-left-video` | `asymmetric-split-left` | 1:1 | 主体在左、解释在右。 |
| `split-right-video` | `asymmetric-split-right` | 1:1 | 主体在右、解释在左。 |
| `character-stage-left` | `character-stage-left` | 9:16 | 看清全身动作，角色向右表演。 |
| `character-stage-right` | `character-stage-right` | 9:16 | 看清全身动作，角色向左表演。 |
| `top-video` | `top-widescreen` | 16:9 | 宽镜头为主、左侧短文案。 |
| `bottom-video` | `bottom-widescreen` | 16:9 | 先读观点，再落到宽镜头。 |
| `center-cinema` | `centered-cinema-window` | 16:9 | 居中电影窗口、关键演示或转场。 |
| `comparison-stage` | `dual-character-comparison` | 16:9 | 双角色、前后对照或对抗。 |
| `metric-video` | `large-metric-with-video` | 4:3 | 大数字、短引语或单结论＋动态插画。 |

连续两页不应无理由复用相同轮廓。全身动作优先 `character-stage-*`；横向运动、双角色与环境叙事优先 16:9；只有动作能完整留在方形安全区时才用 `split-*`。

## 正常生产的媒体合同

- `stillAspect` 是生成器标签，`mediaAspect` 是实际比例；两者与 `visual-plan.slot.aspect` 必须一致。
- 从候选静帧开始就按目标比例生成。常用满质量尺寸为 16:9 的 1920×1080、1:1 的 1080×1080、4:3 的 1440×1080、9:16 的 1080×1920。
- poster 是真实 PNG 字节；MP4 是 H.264、`yuv420p`、默认静音。长边 ≤1920、短边 ≤1080。
- 选中 poster、最终视频、五帧和槽位合成图都针对同一批最终字节；QA 后不得裁切、拉伸、转码或 normalize。
- 媒体路径必须是 job 内的安全相对路径，不接受绝对路径、`..`、目录或逃逸符号链接。

## 仅限 QA 前的修复工具

`normalize_media.js` 不属于正常生产主路径。只有导入/遗留素材需要在 QA **之前**统一 PNG/H.264 编码时才使用；画幅不一致默认拒绝。确实需要裁切时必须显式授权：

```bash
node <SKILL_DIR>/scripts/normalize_media.js <repair-deck.json> <new-repair-dir> --allow-crop
```

该命令生成的媒体是全新字节。它同时产生的 `deck.normalized.json` 只用于修复检查，禁止直接拿去 build/release。应把修复后的媒体作为新输入，重新抽五帧、生成槽位合成图、更新 `asset-manifest.json`，再运行 `compile_deck.js` 生成正式 `deck.json`。

## 编译后的 deck

`deck.json` 只由 `compile_deck.js` 生成并受 `deck.schema.json` 约束：静态页使用 `title-card`；动态页精确复制 content 的 title/body/sources、visual 的 layout、manifest 的 canonical media、命名配色与字体。视频音量固定为 0。

编译后可运行 `preview_deck.py` 做结构预览，但最终视觉验收必须渲染实际 staging PPTX；预览图不能生成发布证据。

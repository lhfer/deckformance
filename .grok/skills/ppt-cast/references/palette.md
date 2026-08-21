# 自适应配色

每套 PPT 根据品牌、角色和内容生成自己的配色；字段写入 `visual-plan.json`，再编译到 `deck.json`。禁止把毡艺预设的奶油底＋炭黑卡当全局默认。

同阶段还要填写 `brandDirection.typography: { title, body, number, rationale }`。前三项会精确编译到 `deck.fonts`，不得依赖构建器回落到 Arial；`rationale` 说明字体如何服务品牌、语言和内容密度。

## 什么时候收

角色模型自动通过之后、typeset 之前。优先从用户品牌规范取色；无明确品牌色时再从选中的表演圣经抽取。

```bash
python3 <SKILL_DIR>/scripts/sample_palette.py jobs/<slug>/<selected-performance-bible.png>
```

打印若干 hex。将至少三个原始颜色写入 `brandDirection.sourceSwatches`，再和用户指令、内容气质一起推导 `brandDirection.deckPalette` 的八个具名颜色。

## 三路来源

| 来源 | 落到哪 |
|---|---|
| 品牌规范/真实资产 | 优先决定 accent、禁用色和对比关系 |
| 角色主色 | 与 accent 协调；静帧环境能呼应但不必同色 |
| 用户指令（商务/可爱/暗色） | 面板深浅、底的冷暖 |
| 内容气质（办公/儿童/医疗） | 饱和度、明度和信息密度 |

## `deckPalette` 八个键

`visual-plan.json` 按契约使用 `#RRGGBB`；编译 `deck.json` 时沿用同一组值，不再重新选色。

| 键 | 规则 |
|---|---|
| `accent` | 角色主色 |
| `panel` | accent 的深色同类，给对切卡 |
| `bg` | accent 的极浅色，给幻灯片纸 |
| `title` | 在 panel 上够对比的浅色 |
| `body` | 比 title 弱一档 |
| `muted` | kicker / 序号 |
| `ink` | 浅底上的标题（封面） |
| `inkMuted` | 浅底上的正文 |

对比不够就加深 panel 或提高 title，不要描边。

## 检查

- 换一个角色主色，这套卡还应像「另一个产品」。现在还像千问绿 → 没抽到角色。
- 三页静帧墙/地色相落在同一套里，明度和物件可以不同。一页陶土、一页苔藓、一页冷蓝且和角色无关 → 失败。
- 静帧和 PPT 的 bg/panel 摆在一起不打架。
- 环境仍要服务这一页 `required`，只是换场景，不是随机换色系。

毡艺预设的奶油+炭黑只在用户明确要复刻那条毛毡帖时用。

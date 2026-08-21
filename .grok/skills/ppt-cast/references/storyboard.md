# 从观点到可拍画面

入口是已通过内容门的 `content-plan.json`，产物写进 `visual-plan.json`。`storyboard.md` 只作为便于检查的编译视图，不能成为第二份手工真相源。

## 每页翻译顺序

1. 抄入终稿 `title`、`body` 和内容计划中的 `claim`，不要在画面阶段偷偷改论点。
2. 写一句 `visualProposition`：遮住 PPT 文字，只看画面仍应读出的关系或动作。
3. 把关键名词、动词和环境拆成 `required`；每一项都要落到具体角色、道具、空间关系、动作或真实合成素材。
4. 写 `optional` 氛围细节与 `forbidden` 偏题/伪造风险。
5. 写 `characterPerformance.present: true`、`roleInClaim` 和 `action`，保证主角实际承担表达，而不是贴纸。
6. 从 registry 选择准确 `layoutId / layoutFamily / slot`，再填写景别、身体可见范围、动作包络、遮挡、裁切安全区、支撑、`framingBoundary` 与 `bodyContinuation`，详见 [visual-direction.md](visual-direction.md)。
7. 选择一项主运动策略和一个主动作；辅助运动只用于材质反馈或环境生命力。

简化示例：

```text
claim: 一条输入同时产出四类办公成品。
visualProposition: 角色把一个发光输入块送入装置，四种不同形态的成品同时展开。
required:
  - 输入 → 一个无文字的发光语音/指令块
  - 四类成品 → 纸页、网格板、演示卡片、浏览器窗框，形态互不混淆
  - 同时产出 → 四件物体从同一装置同步展开
optional: 品牌色流光连接四件物体
forbidden: 可读文字、伪 UI、四件物体长得完全一样
```

## Prompt audit

提示词必须能逐项指出：

- 哪些短语锁身份，哪些锁完整身体。
- 哪些短语重建本页景别、动作和环境。
- 每个 `required` 是由生成画面表达，还是由真实资产/PPT 图层合成。
- 如何避免复制来源图的裁切、姿势、背景、人物尺度和镜头距离。

缺少任何 `required`，或某项只能靠生成模型写出可读文字时，先重做表达方式，不开画。不要使用 `Change only the scene` 作为 prompt audit 的替代品。

## 切题检查

- **换页测试：** 把 A 页画面配到 B 页标题；若仍然同样成立，A 的画面过于通用。三页中至少两组相邻交换应明显失败。
- **证据测试：** 图像是否在支持 claim，而不仅是重复名词或制造气氛。
- **品牌测试：** 去掉 logo 后，配色、材质、镜头和道具语言是否仍属于这套作品。
- **身体测试：** 景别是本页主动选择，还是无意继承参考图裁切。

[metaphor-table.md](metaphor-table.md) 只在某个抽象 `required` 无法视觉化时查阅；它提供发散方向，不是模板库。

最终 `storyboard.md` 不手写：`asset-manifest.json` 完成后由 `compile_deck.js` 与 `deck.json` 一起事务式生成。若编译视图与 visual/content 不一致，应修上游后重编译，不能直接编辑 storyboard。

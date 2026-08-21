# 研究与内容规划

只有 `brief.json` 完整后才进入本阶段。产物是 `content-plan.json`；不要同时设计构图。结构见 [contracts.md](contracts.md)。

## 先研究，再拆页

1. 从用户材料提取主张、数据、必讲点和品牌事实，保留材料出处。
2. 对允许联网补充的公开主题，优先查官方、一手和时间上仍有效的资料。
3. 建 `coverageMatrix`：每个 `brief.mustCover` 恰好出现一次，并写入至少一个有效 `slideIds` 与非空 `support`。必讲点不能只留在研究笔记里，也不能用重复矩阵项制造“已覆盖”。
4. 标出事实、用户观点和推断。核心结论若依赖无法核验的事实，内容门失败；不要用漂亮画面掩盖证据缺口。

## 叙事闭环

整套内容要能回答：为什么现在讲、问题/机会是什么、证据是什么、观众应得出什么结论。根据主题选择合适论证路径，不套固定章节模板。

每页至少记录：

- `title` 与 `body`：最终可显示文案；`body` 为 1–3 条。这两项会被编译器原样写进 deck，不能在后续视觉或构建阶段另写一版。
- `role`：该页在论证中的职责，而不是视觉类型。
- `claim`：这一页唯一要成立的观点。
- `evidence`：支持该观点的用户材料、事实、例子或明确标注的推断。
- `evidenceBasis`：`none / user-material / public-source / inference / mixed`。动态页不可为 `none`；cover/section 必须为 `none`。
- `transition`：它如何承接上一页并引出下一页。
- `takeaway`：观众离开这一页时应记住的一句话。

先做 ghost deck：只读所有标题和 takeaway，仍应能完整复述论证，且相邻页不能只是同义反复。再检查覆盖矩阵；缺项时回到研究或内容结构，不进入视觉阶段。

## 页数与页面类型

- 用户未指定页数时，按内容推导 6–10 页；v1 最多八个需要视频的内容页。
- 封面与真正承担分章作用的章节页可静态。任何表达观点、证据或结论的内容页都必须规划视频，不能为绕过媒体硬门而伪装成章节页。
- 页面内容以一个主视觉命题为中心，默认最多两个辅助信息。超出时拆页或删减，不把完整报告压成三行小字。

## 来源进入 speaker notes

顶层每个 source 都完整写 `id / title / kind / url / publisher / retrievedAt / isPrimary / supports`；不适用的 url/publisher/retrievedAt 明确为 `null`。`supports` 列出它实际支撑的页面，页面的 `sourceIds` 必须反向引用同一来源。动态页至少有一个 source，且 `evidenceBasis` 必须与所选 source kind 一致；`public-url` 另需 http(s) URL 与非空 `retrievedAt`。

编译器会把来源写入 speaker notes：

```text
[Sources]
- <source title> — <direct URL> — <what it supports>
```

用户材料可标为 `User-provided: <filename or section>`，不要伪造公网链接。没有外部事实的页在 `[Sources]` 下明确写 `No external sources`，不要留下来源状态歧义。`deck.json` 只是编译产物，来源以结构化内容计划为准并由构建流程写入备注。

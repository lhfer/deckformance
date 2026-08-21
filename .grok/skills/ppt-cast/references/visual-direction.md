# 视觉导演与逐页景别

仅在内容门和角色门通过后制定 `visual-plan.json`。它把品牌导演规则、版式、构图和运动连起来，不是一套固定模板。结构见 [contracts.md](contracts.md)。

## 整套导演系统

从 brief、角色和内容共同确定：配色、字体、材质、光质、画面密度、镜头语言和运动气质。读 [style-lock.md](style-lock.md) 固定角色与媒介的一致项，读 [palette.md](palette.md) 生成品牌相容配色。不要因为角色来自某张参考图就复制那张图的背景或景别。

每页只保留一个主视觉命题，默认最多两个辅助信息，并将画面要求分为：

- `required`：缺少即不切题或不合规。
- `optional`：有助于气氛，但可为构图让路。
- `forbidden`：伪文字、错误品牌资产、错误身体结构、主题偏离等。

每个动态页都写 `characterPerformance: { present: true, roleInClaim, action }`，说明主角怎样参与 claim；不能只把角色缩成角落装饰。封面与章节页不受此条限制。

官方 logo、产品截图、UI 和需要精确读取的数据使用真实素材或 PPT 原生图层合成；不要让生成模型临摹品牌文字或界面。

## 版式语法

版式族包括：全幅电影画面、左右 60/40 对切、右左 60/40 对切、人物舞台＋超大标题、顶部宽银幕、底部宽银幕、居中电影窗口、双角色/对比舞台、大数字或引语＋动态窗口。

实际坐标、槽位比例和可用 `layoutId` 只读 [layouts.json](layouts.json)，选择逻辑读 [layouts.md](layouts.md)。每页同时保存精确 `layoutId` 与 registry 中对应的 `layoutFamily`；family、slot aspect 或像素比例不一致时 `layout-ready` 失败。选择时考虑文案密度、人物景别、动作方向、文字负空间与相邻页节奏；连续两页不得无理由重复同一视觉轮廓，也不要为了“多样”让每页风格失联。

正常生产从第一张候选开始就按 `slot.aspect / widthPx / heightPx` 生成；选中的 PNG poster 与最终 MP4 必须使用相同画幅和像素尺寸。禁止先做别的画幅，再在 QA 或编译后 cover/crop。视频为方向无关的 1080p class：长边不超过 1920、短边不超过 1080，因此人物舞台可合法使用 1080×1920 的 9:16 媒体。

## 逐页构图字段

每个内容页都必须显式填写：

- `shotType`：`full-body`、`three-quarter`、`waist-up` 或 `close-up`。
- `bodyVisibility`：该镜头从开始到结束必须看见的身体部位。
- `actionEnvelope`：动作中手脚、道具和主体允许到达的范围。
- `occlusionReason`：桌子、载具、画框等合理遮挡；无遮挡则明确为 none。
- `safeCrop`：进入最终视频槽后仍需保留的安全区。
- `groundContact`：站立、坐下、漂浮、依附及其可见支撑关系。
- `framingBoundary`：`full-body-contained / natural-edge-exit / explained-occlusion / close-up`。
- `bodyContinuation`：身体完整包含、自然出框或被何物遮挡的明确说明。

选择规则：

- 走路、起跳、着陆、推拉或操作大型道具默认全身。
- 上半身手势可用四分之三身；腰部近景应裁在关节之间，并从外框自然出画，不能在场景中央突然断掉。
- 脸部近景必须服务情绪、身份或细节表达，不能只因为来源图是头像。
- 合理遮挡必须真的解释身体去向，并在视频全程连续。
- 全身镜头的 `framingBoundary` 只能是 `full-body-contained`；非全身镜头必须用自然出框、合理遮挡或主动 close-up 解释身体延续。
- 禁止把画面边缘落在颈部、肩关节、肘、腕、腰线、膝或脚踝上。
- 全身镜头必须看到脚/等价末端、支撑面和动作留白。

`safeCrop` 与 `actionEnvelope` 冲突时，先改构图、镜头或布局，不要寄希望于最后一遍裁切。

## 运动策略

按页面选择 `stable`、`cinematic`、`diagrammatic` 或 `ambient`。保留一个主动作，允许少量服务材质或环境的辅助运动。镜头是否移动、持续多久由观点、动作完成度、素材稳定性和生成工具能力决定；不再全局锁机位，也不固定为六秒。

- `stable`：身份或精密动作优先，镜头稳定，但并非禁止所有轻微视差。
- `cinematic`：主题需要推进、揭示或尺度感时使用受控镜头运动。
- `diagrammatic`：道具关系和因果必须清楚，运动少而可读。
- `ambient`：观点是持续状态，主体与环境都有克制微动，不能只剩呼吸。

任何镜头运动都不能破坏 `safeCrop`、角色一致性或文字负空间。

# 角色诊断与双圣经

角色一致性拆成三层：`identity`（是谁）、`performance body`（完整身体如何成立）、`page framing`（这一页拍多近）。参考图只定义前两层可见的事实，绝不默认继承它的裁切和镜头。

结果写入 `character-model.json`，字段见 [contracts.md](contracts.md)。本阶段全自动选择候选，不设置人工“圣经确认”硬停。

## 1. 自动诊断参考图

逐张检查并记录：

- 覆盖范围：`headshot`、`bust`、`half-body`、`three-quarter`、`full-body`、`occluded`、`multi-subject`、`non-human`。
- 主体类型：人、类人吉祥物、动物、其他非人形；logo 仅在用户要求角色化时进入此流程。
- 质量：脸部或识别特征清晰度、视角、遮挡、可见服装、缺失肢体、背景粘连与判断置信度。

路由规则：

- 全身图可为身体设计提供证据，但仍不锁原姿势、背景、人物尺度或镜头距离。
- 头像、胸像、半身或被遮挡的图只作 `identity reference`；缺失身体必须先补成完整表演模型。
- 多主体时，仅在一个主体明显更清晰且符合用户描述时自动选主角；无法可靠判断就失败，不猜身份。
- 非人形角色按其自身解剖定义“完整”：所有足、轮、尾、底座或支撑结构应明确。logo 只有在用户把它当角色时才进行角色化。

## 2. 建立身份圣经

身份圣经是清楚的脸部/识别特征近景，用来冻结五官、发型、肤色或角色材质、标志性服装细节和轮廓。它不定义下半身，不定义每页景别。

human/humanoid 的低清脸、纯背面或任何低于 0.75 的主体选择置信度直接失败；`not-applicable` 只用于非人形。不能用生成结果反过来宣称来源身份一致。

## 3. 建立完整表演圣经

先生成至少两个独立的完整身体候选。`identityConsistency / bodyCompleteness / proportionStability / animatability` 四项都必须达到 0.85，才可标为 passed。对 passed 候选计算：

```text
weightedScore = identityConsistency × 0.35
              + bodyCompleteness × 0.30
              + proportionStability × 0.20
              + animatability × 0.15
```

自动选择最高加权分候选；不能为了主观偏好绕过分数。选中后补一张通过 QA 的 `sideActionReference`，用于验证轮廓和关节。没有 passed 候选时停止整套任务。

合格的表演圣经应包含：

- 正面或正 3/4 全身中性站姿，以及侧向动作姿势。
- 完整躯干、双手、双脚/等价末端和鞋或支撑结构。
- 稳定重心与清楚的脚底接触面。
- 一致的身高、头身比、服装、材质和轮廓。
- 四周留白足够，后续动作不会立即撞到画面边缘。

把完整身体写入 `performanceBible.bodyDesign`：`stature / proportionNotes / clothing / footwearOrBase / handsOrExtremities / silhouette / designedCompletions`。来源没有展示的裤装、鞋或身体结构属于设计补全，必须列在 `designedCompletions` 并在后续页面固定；不要把推测写成来源事实。

## 提示词契约

提示词使用字段化约束，不再写 `Keep same scale/background` 或 `Change only the scene`：

```text
PRESERVE_IDENTITY: <脸、发型、材质、标志性服装特征>
PRESERVE_BODY_MODEL: <身高、头身比、四肢、鞋、轮廓>
REFRAME_FOR_PAGE: <本页 shotType、动作、镜头与留白>
REPLACE_ENVIRONMENT: <本页环境和品牌色关系>
DO_NOT_COPY_SOURCE: crop, pose, background, subject scale, camera distance
```

逐页生成时同时提供身份圣经与表演圣经；前者防换脸，后者防身体被源图裁切牵着走。

## 半身参考回归例，不是全局模板

旧回归样例把人物胸像继续风格化成无腿半身，又把它摆在地面场景中央，导致躯干在画面内部中断、没有脚和支撑关系。新门必须将其判为失败：胸像只能锁身份；站立或行走页面先依赖完整表演圣经，再按页面动作选全身景别。

这不代表胸像输入的每一页都必须拍全身。由内容主动选择、从画面边缘自然出框的近景仍然合格；失败的是把来源裁切误当身体结构，或让半身角色无解释地“长在地里”。

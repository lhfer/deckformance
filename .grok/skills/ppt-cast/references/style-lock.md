# Style lock

`style-lock.txt` 是便于粘贴提示词的编译片段，固定“同一套作品”的视觉语言，不固定每页场景、姿势、裁切或镜头距离。其值先来自 `brief.creativeDirection` 的 language、desiredStyle、mood、energy、avoid 与品牌字段，视觉计划建立后以 `visual-plan.json` 的品牌导演字段为准；不要把它手工维护成另一份真相源。身份与身体由 `character-model.json` 单独控制。

## 建议字段

```text
MEDIUM: <材质、工艺、边缘与表面细节>
MATERIAL_BEHAVIOR: <这种材质如何变形、反光、运动>
PALETTE_LOGIC: <角色主色与品牌色关系，不是每页背景色>
LIGHTING: <光质、方向与对比范围>
CAMERA_LANGUAGE: <允许的景别、透视和运动气质>
MOTION_LANGUAGE: <动作节奏与材质反馈>
BRAND_ASSETS: <必须用真实素材合成的 logo/UI/产品>
SET: per-slide; derive place and props from the page claim
FORBIDDEN: readable generated text, fake logos/UI, watermarks, identity drift, unexplained body truncation
```

冻结材质、角色配色关系、光质和整套镜头气质；不冻结房间、墙、地面、天空、角色姿势、人物尺度或镜头距离。`CAMERA_LANGUAGE` 是允许范围，不是所有页统一 `locked camera`。

若用户只给了风格名，补成肉眼可判断的材质与运动描述：

| 用户词 | 可用起点 |
|---|---|
| 羊毛毡 / felt / 针织 | 读 [presets/felt-yarn.md](presets/felt-yarn.md) |
| 黏土 / clay | plasticine claymation, visible fingerprints, matte surface |
| 剪纸 / paper | layered construction paper, visible cut edges, stop-motion |
| 手办 / toy | painted figure, crafted set, controlled studio light |
| 像素 | chunky pixel art, limited palette, no anti-alias |

未命中时沿用用户原词，并补齐表面、光和运动行为；不要退回“高级、酷炫、电影感”一类不可验证的空话。

## 使用方式

每次生成把 style lock 与两类约束合并：

1. `character-model.json` 的身份和完整身体冻结项。
2. `visual-plan.json` 当前页的 `required/optional/forbidden`、景别和运动。

逐页提示词必须重建本页构图，明确 `DO_NOT_COPY_SOURCE: crop, pose, background, subject scale, camera distance`。不得使用 `Keep same scale/background` 或 `Change only the scene` 这类会把来源构图一并锁死的笼统指令。

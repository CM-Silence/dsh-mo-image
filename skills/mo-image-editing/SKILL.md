---
name: mo-image-editing
description: 局部修改、参考图融合和版本迭代时加载，包含编辑公式、五大约束词和按模型写法。
whenToUse: 需要保留当前图、只改细节、换背景/换装、多图融合或把生成图作为参考时。
---

# 图片编辑与版本迭代

## 硬性约束（先读）

- 只负责把编辑提示词和参考图交给生图模型，不替用户判断图片好坏。
- **图片返回即交付**：最终回复只输出工具给的图片链接；不评价画质、不描述画面、不打开或读取图片文件、不用任何工具检查这张图。
- **只用用户在选择器里选中的提供商和模型**：不要自行切换，也不要用其他工具（本地生图、建模/Blender、脚本绘图）替代。
- **失败时原样报错**：可以问用户是否要更换模型或服务商，但不要自己更换，也不要换别的模型重试。

编辑和文生图是两种任务：编辑的提示词不是重新描述整张图，而是**说清改什么、别动什么**。

> 如果 `mo-image-prompt` 显示「提示词优化：Off」，不要套用下面的编辑公式：prompt 只用用户原话或最小必要修改说明，不补用户没说的细节；images 按用户指定传。模型、尺寸、质量由生图选择器控制，工具不接受这些参数。

## 一、编辑公式

`动作动词 + 目标元素 + 期望的变化 + 风格细节`

五类高权重约束词：

| 约束 | 用法 | 示例 |
|---|---|---|
| 保持 | 锁定不想被改的部分 | 保持人物脸型、发型、姿势和背景不变 |
| 修改 | 改变指定元素的属性 | 把发色改成银白色，保持画风和设计特征不变 |
| 添加 | 向画面新增元素 | 给手持相机上添加一只小黄猫，画风保持一致 |
| 删除 | 移除指定内容 | 去掉长筒袜、翅膀和地上的布料 |
| 替换 | 用另一张图的元素替换 | 参考图2的轮子设计，把图1摩托后轮替换成图2的轮子，画风保持一致 |

补充：`使...` 用于整体氛围（“使整张图具有温暖舒适的傍晚氛围”），`风格` 用于整体转绘（“转成 UE5 写实风”）。

## 二、按模型编辑

| 模型族 | 编辑写法 | 注意 |
|---|---|---|
| GPT-Image | 只改 X，其余保持不变；每轮重复保留清单 | 多图按图1/图2编号；文字用引号；无 negative |
| Nano Banana / Gemini Image | 强动词开头，明确保留项，可描述蒙版区域 | 正向描述，不用否定句；支持多图融合 |
| Seedream | 增加/删除/替换/修改 + 对象 + 变化 | 避免“它/那个”；强调其余不变；支持图1/图2 |
| Qwen-Image | 按图1/图2说明关系，只改指定区域 | 支持 negative prompt；文字和版式要保留 |
| FLUX Kontext | 改什么 + 保持什么 | 不支持的排除项写成正面描述 |
| Stable Diffusion / Stability | 说明保留区域和修改区域 | 支持 negative；局部重绘优先用蒙版 |
| DALL·E 3 / 通义万相 | 不建议做参考图编辑 | 换 GPT-Image、Seedream、Nano Banana 等 |

### GPT-Image

```text
Use Image 1 as the base. Replace only the background with a soft light-gray seamless studio backdrop. Keep the product, its position, scale, label text, reflections, and the original lighting completely unchanged. Match the new background's shadow direction to the product, no extra objects, no text, no watermark.
```

### Nano Banana / Gemini Image

```text
Remove the man standing on the left from the photo. Keep the woman, her pose, the cafe interior, the table, and the window light exactly as they are. Fill the removed area with the same wall texture and perspective; do not add new people or objects.
```

### Seedream

```text
把图1中人物的外套替换成图2的米色风衣，保持人物脸型、发型、姿势、内搭和背景不变，风衣的材质和褶皱要自然，光影与图1一致。
```

### Qwen-Image

```text
参考图1的版式，把主标题改成“SUMMER SALE”，使用粗体白色无衬线字体，保持位置、字号层级和背景不变；产品图和副标题不要改动。
```

### FLUX Kontext

```text
Change only the jacket color to deep navy. Keep the model's face, hair, pose, body shape, background, and lighting identical. Preserve the fabric texture and natural folds.
```

## 三、常用模板

### 局部修改

```text
图1是<原图说明>。只把<目标元素>改成<变化>，保持<主体/脸/发型/姿势/构图/背景/文字/光线>不变。不要新增其他元素，不要改变画风。
```

### 区域放大 / 重绘

```text
把图1红框/涂鸦标记的区域单独重绘成<目标>，保持区域外的内容、构图、光影和文字不变；区域内的新内容要与原图透视、材质、光线一致。
```

### 换背景

```text
图1是<主体>。只把背景换成<新背景>，保持主体位置、比例、边缘、投影和原图光线方向一致；主体颜色和材质不受新背景影响。
```

### 换装 / 换材质

```text
图1是人物，图2是服装/材质参考。让人物穿上图2的<服装>，只替换<部位>，保持脸型、发型、姿势、身材比例和背景不变；服装材质、褶皱和光影要自然，不要像贴上去的。
```

### 多图融合

```text
图1：人物；图2：服装；图3：场景；图4：风格参考。
用图1的人物、图2的服装、图3的场景，按图4的风格和色彩重绘。保持人物身份和姿势，三张参考图的元素要自然融合，光影统一。
```

### 风格迁移

```text
保持图1的<主体/构图/视角/内容>不变，用图2的<风格/色彩/笔触/材质>重绘。只改变画风，不改变人物、物体、文字和版式。
```

### 文字 / Logo 修改

```text
只把图1中的文字“<原文>”改成“<新文字>”，保持字体、字号、颜色、位置、倾斜和背景不变。文字拼写必须准确，不新增其他文字，不改动图形和排版。
```

## 四、自检清单

调用 `mo_image_edit` 前逐条检查：

1. 每张参考图是什么，是否按图1/图2写清？
2. 是否只改一个具体点，而不是同时改五件事？
3. 保留项是否列全（身份、脸、发型、姿势、构图、文字、光线、背景）？
4. 是否用了“它/那个”这类模糊指代？
5. 新元素的光影、透视、材质是否与原图一致？
6. 文字是否加了引号，拼写是否准确？
7. 当前模型支持参考图编辑吗？不支持就换模型。
8. 是否需要 negative prompt？当前模型支持吗？

## 五、调用

- `images`：1–16 张本地绝对路径或 http(s) URL；顺序对应图1/图2，不能错。
- `prompt`：按当前模型写好的最终编辑提示词。
- `negative_prompt`：只在当前模型支持时传。
- 工具只接收 `prompt` / `images` / `negative_prompt`；模型、尺寸、质量由用户在生图选择器里控制，不要尝试传 `provider` / `model` / `size` / `quality`。
- 编辑可能较慢，工具超时 360s；不要重复提交同一请求。
- 工具返回 Markdown 图片行；原样复制到最终回复。

## 六、失败

- 400 提到 image：工具会自动换字段重试一次。
- 400 提到 model：换一个支持编辑的模型，例如 `gpt-image-2.5-sunburst`。
- 401：检查设置里的 API Key。
- 413：减少参考图或压缩到 15MB 以下。

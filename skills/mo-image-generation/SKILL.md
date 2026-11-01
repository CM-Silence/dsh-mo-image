---
name: mo-image-generation
description: 生成或重做图片时加载，包含按模型区分的提示词公式、模板和自检清单。
whenToUse: 用户要求画图、生成图片、出海报/主图/角色图/分镜，或需要重做一版时。
---

# 生图提示词

先看系统提示词里的 `mo-image-prompt` 节，确认当前模型和它的写法。模型切换后，提示词写法要跟着切换；不要拿一套模板套所有模型。

> 如果 `mo-image-prompt` 显示「提示词优化：Off」，不要套用下面的公式、模板和自检清单：直接把用户原话作为 prompt，只做最低限度的文本整理；只有用户明确要求优化时才改写。模型、尺寸、质量由生图选择器控制，工具不接受这些参数。

## 一、通用公式

`主体 + 动作 + 环境 + 艺术风格 + 光影 + 构图 + 限制条件`

| 元素 | 写什么 | 差 → 好 |
|---|---|---|
| 主体 | 谁/什么，具体到年龄、发型、服装、材质 | 一个女孩 → 17 岁高中女生，披肩金发，JK 制服，白丝皮鞋 |
| 动作 | 正在做什么，制造故事感 | 站着 → 在雨水打湿的小巷里奔跑 |
| 环境 | 地点、时间、天气、周围细节 | 日本街道 → 两侧日式一户建和商店，路灯整齐排列的干净街道 |
| 艺术风格 | 摄影/插画/3D/游戏/电影风格，可给参考 | 好看 → 佳能 5D Mark IV 拍摄，日系胶片，轻微颗粒 |
| 光影 | 光线方向、软硬、色温、情绪 | 亮一点 → 暖色夕阳侧逆光，柔和阴影 |
| 构图 | 景别、机位、视角、留白 | 全身 → 中景，平视，主体居中，右侧留白 |
| 限制条件 | 人数、UI、文字、水印、不能变的部分 | 单人，无 UI，无文字，8K 细节 |

三条原则：

1. **具体**：能画出来的细节才有用；“氛围感”“高级感”要翻译成材质、光线、镜头。
2. **叙事**：主体 + 动作 + 环境构成一个瞬间，比关键词列表更容易出好图。
3. **公式**：垃圾进垃圾出，公式进杰作出；先写完整公式，再按模型调整。

## 二、按模型写

| 模型族 | 写法 | 语言 | negative prompt | 文字渲染 |
|---|---|---|---|---|
| GPT-Image | 结构化自然语言：场景 → 主体 → 细节 → 约束 | 英文优先 | 不支持 | 强 |
| DALL·E 3 | 完整自然语言段落 | 英文优先 | 不支持 | 弱 |
| FLUX / Kontext | 自然语言散文，30–80 词 | 英文优先 | 不支持 | 弱 |
| Seedream | 简洁中文叙事，主体 + 行为 + 环境 | 中文优先 | 不支持 | 强 |
| Qwen-Image | 中文/英文自然语言，可长可细 | 中文优先 | 支持 | 强 |
| Nano Banana / Gemini Image | 自然语言叙事 + 参考图关系指令 | 中英皆可 | 不支持 | 强 |
| Stable Diffusion / Stability | SD3.5 自然语言；SDXL/1.5 短语标签 | 英文优先 | 支持 | 弱 |
| 通义万相 | 中文自然语言，简洁具体 | 中文 | 支持 | 一般 |
| Kolors | 中文自然语言，写实/插画均可 | 中文 | 支持 | 一般 |
| 通用兼容 | 自然语言，覆盖七要素 | 跟随用户 | 不确定就不发 | 一般 |

### GPT-Image

- 顺序：**场景/背景 → 主体 → 关键细节 → 明确约束**；复杂需求用短标签或换行分段。
- 先写用途与画幅（电商主图、海报、UI、信息图、摄影），再用位置词安排布局和留白。
- 图中文字用引号原样写出，指定字体、颜色、大小、位置；小字或密集排版时，提醒用户把质量挡位调高。
- 没有 negative prompt：把排除项写成硬约束（`no watermark`, `no extra text`, `no logo`）。
- 编辑时只改 X，其余保持不变；每轮重复身份、构图、文字、光线的保留清单。
- 英文优先；具体到材质、镜头、光线；避免 `masterpiece, 8k, best quality` 这类空话。

示例：

```text
A clean e-commerce hero image for a minimalist skincare serum bottle, centered on a warm beige seamless background with soft shadow and generous negative space on the right. The frosted glass bottle has a matte cream cap; the label reads "AQUA" exactly in a thin black sans-serif font. Soft diffused studio lighting from the upper left, subtle rim light, photorealistic product photography, 85mm lens, shallow depth of field. No extra text, no watermark, no logo, no hands.
```

### DALL·E 3

- 用完整自然语言段落（2–5 句），不要关键词列表或标签堆叠。
- 写清主体、动作、场景、媒介/风格、光线、氛围；模型会自动改写扩展，细节要明确。
- 文字渲染弱：避免长文字和 logo；文字需求改用 GPT-Image 等模型。
- 不支持透明背景：需要纯色背景时直接写“纯白背景”，不要写 `transparent`。
- 不要用 `no / without` 否定句；把不要的东西改写成正面描述。

示例：

```text
A cozy reading corner in a sunlit attic, with a linen armchair, a small wooden side table holding a ceramic mug, and tall stacks of well-worn books. Warm afternoon light streams through a dusty window, casting long soft shadows across the floorboards. The mood is quiet, lived-in, and inviting, rendered as a natural editorial photograph.
```

### FLUX / Kontext

- 自然语言散文，前置主体和动作；30–80 词最佳，最多约 512 tokens。
- 顺序：主体 + 动作 + 风格/媒介 + 环境 + 光线 + 镜头/技术细节。
- 只写你想要的：FLUX 不支持 negative prompt，用正面描述替代排除项。
- 文字渲染弱：不要依赖长文字；需要文字用 GPT-Image/Qwen/Seedream。
- Kontext 编辑：明确“改什么 + 保持什么”，参考图按图1/图2指代。

示例：

```text
A knight in weathered silver armor stands in a misty pine forest at dawn, one hand resting on a moss-covered sword, the other holding a lantern. Soft volumetric light filters through the canopy, cool blue shadows with a warm rim light. Cinematic medium shot, shallow depth of field, shot on 35mm film, muted natural color grading.
```

### Seedream

- 简洁连贯的中文自然语言：主体 + 行为 + 环境，再补风格、色彩、光影、构图。
- 不要关键词堆砌；说明用途/类型（海报、电商、角色设定、分镜）和画幅。
- 文字放双引号中；需要多张时写“一组/四张/分镜”等，可生成统一风格的组图。
- 编辑：用“增加/删除/替换/修改”明确对象和变化，避免代词；强调其余保持不变。
- 支持图1/图2参考和多图输入；按顺序说明每张图的作用。

示例：

```text
电商主图，3:4 竖版。一瓶磨砂玻璃精华液放在暖米色无缝背景中央，哑光奶油色瓶盖，瓶身标签写着“AQUA”，细黑无衬线字体。左上方柔光，右下方淡阴影，右侧留白，极简产品摄影，85mm 镜头，浅景深。不要多余文字、水印、手和 logo。
```

### Qwen-Image

- 中文或英文自然语言，主体、场景、风格、构图写具体；支持长提示词和复杂版面。
- 文字渲染强：把文字放引号中，指定字体、颜色、位置和层级。
- 支持 negative prompt：把畸变、水印、多余文字、低质量等放进 `negative_prompt`。
- 编辑：按图1/图2说明参考关系，只改指定元素，保持其余不变。
- 需要精确控制时，把“必须出现/必须保留”的内容写成清单。

示例：

```text
一张极简风格的咖啡海报，竖版 2:3。背景是温暖的米白色，画面中央是一只俯视视角的白色陶瓷咖啡杯，杯口有细腻的拉花。上方用粗体黑色无衬线字体写着“MORNING”，下方用小号灰色字体写着“Slow coffee, slow living”。整体留白充足，柔和自然光，编辑级排版。
```

### Nano Banana / Gemini Image

- 自然语言叙事，先写主体/动作/场景，再写构图、风格、镜头；不要只列关键词。
- 正向描述：说“空荡的街道”而不是“没有车”；不要用否定句。
- 参考图公式：`参考图 + 关系指令 + 新场景`；按图1/图2说明用途。
- 文字放引号中并指定字体/位置；支持多语言文字和 1K/2K/4K。
- 文字多的图，先用对话把文案定下来，再让模型出图；文字仍放引号中。
- 编辑：用强动词开头（添加/移除/替换/改成），明确保留项；可用文字描述蒙版区域。

示例：

```text
Using the attached jacket photo as the exact garment reference and the attached model photo as the pose and identity reference, dress the model in the jacket. Keep her face, hair, body shape, pose, and the studio background unchanged. Match the jacket's fabric texture and lighting to the original photo so it looks naturally worn, not pasted on. Editorial fashion photography, softbox lighting, 85mm lens.
```

### Stable Diffusion / Stability

- SD3.5 用自然语言段落；SDXL/1.5 用逗号分隔的短语标签（媒介、主体、构图、光线、细节）。
- 支持 negative prompt：把低质量、畸变、多余肢体、水印等放进 `negative_prompt`。
- 写清风格/媒介、主体、构图、光线、色彩；避免互相冲突的风格词。
- 文字渲染弱：不要依赖长文字；需要文字用 GPT-Image/Qwen/Seedream。
- 编辑：说明保留区域和修改区域；参考图按图1/图2指代。

示例：

```text
editorial portrait of a woman in a red wool coat, standing in a snowy city street at dusk, soft overcast light, medium shot, shallow depth of field, muted cinematic color grading, 85mm lens, fine film grain
```

```text
negative_prompt: low quality, blurry, oversaturated, deformed hands, extra fingers, watermark, text, logo, plastic skin
```

### 通义万相 / Kolors

- 中文自然语言：主体 + 场景 + 风格 + 光影 + 构图，简洁具体。
- 支持 negative prompt：把低质量、畸变、水印、多余文字放入 `negative_prompt`。
- 写清画幅和用途；避免长文字渲染。
- 编辑能力有限：需要局部修改时优先换支持编辑的模型。
- 写清人物年龄、发型、服装、材质等可画细节。

## 三、常见场景模板

### 电商主图

```text
用途：电商主图；画幅：1:1。
主体：<产品>，<材质/颜色/卖点>，居中。
背景：<纯色/场景>，干净，右/左侧留白。
光影：柔光箱 + 淡阴影，真实材质高光。
约束：产品不变形，标签文字“<文字>”准确，无水印，无多余文字，无手。
```

### 海报 / 文字

```text
用途：<海报/信息图/封面>；画幅：<比例>。
背景：<颜色/场景>；主体：<画面>。
文字：主标题“<文字>”用<字体/颜色/大小>放在<位置>；副标题“<文字>”用<字体/颜色>放在<位置>。
层级：标题 > 副标题 > 辅助信息；留白充足，排版对齐。
约束：文字拼写准确，不新增无关文字，无水印。
```

### 角色三视图

```text
参考图角色，制作三视图：正视图、侧视图、背视图，三个视图平行排开，比例一致，白色背景，全身，站姿 A-pose。保持发型、服装、配色和设计细节一致，线条干净，角色设定图风格。
```

### 分镜 / 故事板

```text
16:9 六格分镜，顺序为：<镜头1>、<镜头2>、<镜头3>、<镜头4>、<镜头5>、<镜头6>。统一角色、服装、场景和光影；每格有独立构图和景别；不要文字和对白框。
```

### 多角度 / 机位

```text
以图1的角色和场景为参考，生成同一场景的 8 个不同机位：正面特写、过肩镜头、低角度、俯视、广角全景、侧面、背面、远景。保持角色、服装、场景、光线和画风一致，不要改变设计。
```

### 风格迁移 / 多图融合

```text
图1：<内容/构图参考>；图2：<风格/材质参考>；图3：<元素参考>。
保持图1的<主体/构图/视角>，用图2的<风格/色彩/笔触>重绘，把图3的<元素>融合到<位置>，保持光影一致，不改变其他部分。
```

### 局部修改

见 `mo-image-editing` 技能。核心是：只改一个点，列全保留项，重复约束。

## 四、自检清单

调用 `mo_image_generate` 前逐条检查：

1. 主体是否具体到可画（年龄、发型、服装、材质）？
2. 动作/环境是否构成一个瞬间，而不是静态标签？
3. 风格、光影、构图是否明确？
4. 图中文字是否加了引号，并指定字体/位置？
5. 限制条件是否正面表述，或写成硬约束？
6. 提示词语言和长度是否符合当前模型？
7. 是否需要 negative prompt？当前模型支持吗？
8. 有没有互相冲突的风格词、光线或视角？

## 五、调用

- `prompt`：按当前模型写好的最终提示词。
- `negative_prompt`：只在当前模型支持时传；不确定就省略。
- 工具只接收 `prompt` / `negative_prompt`；模型、尺寸、质量由用户在生图选择器里控制，不要尝试传 `provider` / `model` / `size` / `quality`。
- 工具返回 Markdown 图片行；原样复制到最终回复。

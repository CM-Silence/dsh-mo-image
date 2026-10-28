---
name: mo-image-generation
description: Generate, edit or redo an image with the configured DSH image model. Use when the user asks to draw, generate, create, redo, adjust, or use reference images.
---

# 生图与图片编辑

图片能力由 dsh-mo-image 插件提供。先确认模型可用，不要凭空编造模型名。

## 文生图：mo_image_generate

用于从零生成一张新图，或完全不参考当前图的「重做」。

- prompt：完整的最终提示词（主体、场景、构图、光线、材质、文字、限制）
- size：可选，如 1024x1024。模型对尺寸有最小/最大限制时会自动取最近的合法尺寸生成，再缩回你要的尺寸，无需自己试错
- 默认使用设置里的当前模型

## 图片编辑：mo_image_edit

用于保留当前图只改几处、参考实拍细节、多图融合，或把上一版生成图作为参考。

- prompt：写清「图1/图2 是什么」+「只改什么」+「其他不要动」
- images：1–16 张本地绝对路径或 http(s) URL，顺序对应图1/图2
- quality：默认 high；可选 off / low / high / max（off = 不发这个参数）
- 不传 model 时优先选含 sunburst/edit 的编辑模型
- 细节修改务必强调保持主体、构图、文字不变

## 输出

- 工具返回 Markdown 图片行；原样复制到最终回复，大图会显示在对话里。
- host 会附加文件卡片；不要重复贴本地路径。
- 不要写 C:\... 这类本地路径，也不要把附件名当 URL。

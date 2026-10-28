---
name: mo-image-editing
description: 用 dsh-mo-image 的 mo_image_edit 做局部修改、参考图融合和版本迭代。需要保留当前图、只改细节或把生成图作为参考时加载。
---

# 图片编辑与版本迭代

## 选择

- 只改细节 / 保留当前图：mo_image_edit
- 整体重做 / 不参考当前图：mo_image_generate
- 有实拍细节或需求表参考图：mo_image_edit，按图1/图2顺序传

## Prompt

1. 说明每张参考图是什么。
2. 说明保留什么：主体、颜色、构图、文案位置、尺寸。
3. 说明只改什么：一个具体点。
4. 强调除上述外不要改动其他部分。
5. 不照抄参考图的构图、人物和光影。

## 调用

- images 最多 16 张，顺序不能错。
- quality 默认 medium，不传 auto。
- 编辑可能较慢，工具超时 360s；不要重复提交同一请求。
- 生成结果返回本地路径；工作台项目里用 mo_workbench_add_version 登记。

## 失败

- 400 提到 image：工具会自动换字段重试一次。
- 400 提到 model：换 gpt-image-2.5-sunburst。
- 401：检查设置里的 Key。
- 413：减少参考图或压缩到 15MB 以下。

# dsh-mo-image

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的生图插件。

配置一个 OpenAI Images 兼容的模型后，可以直接在对话里让模型生成图片，或用参考图做局部修改、融合和版本迭代。

## 功能

- 文生图：生成新图、重做
- 图片编辑：保留原图，只改指定部分
- 参考图：支持 1–16 张本地图片或 URL
- 多模型：不同提供商、不同模型可随时切换
- 对话内直接显示生成结果

## 安装

要求：

- DSH >= 0.2.1-rc.2
- Node.js / pnpm（DSH 已自带）

从 GitHub 安装：

~~~bash
git clone https://github.com/YOUR_GITHUB_NAME/dsh-mo-image.git
dsh plugin --profile desktop add link:./dsh-mo-image
~~~

也可以直接使用仓库地址：

~~~bash
dsh plugin --profile desktop add github:YOUR_GITHUB_NAME/dsh-mo-image
~~~

把 YOUR_GITHUB_NAME 换成实际的 GitHub 用户名。

安装后确认 profile 的 dsh.profile.bundles 中包含：

~~~json
"dsh-mo-image"
~~~

然后重启 DSH。

## 配置

打开：

**设置 → 生图模型**

添加一个提供商：

| 项目 | 填写内容 |
|---|---|
| API 地址 | OpenAI Images 兼容地址，通常以 /v1 结尾 |
| API 密钥 | 对应平台的 Key |
| 模型 ID | 例如 gpt-image-2.5-flare |

保存后，在对话输入框右侧选择当前生图模型。

内置了几家官方或大型模型平台：OpenAI、火山方舟、阿里云百炼、硅基流动、智谱 BigModel。也可以选择“自定义模型 API”，填写自部署或其他兼容接口。

## 使用

直接对模型说：

> 画一张 1024x1024 的电商主图，白色背景，产品居中。

或者：

> 以这张图为基础，只把背景换成浅灰色，产品和文字不要动。

模型会在需要时调用：

- mo_image_generate：文生图 / 重做
- mo_image_edit：参考图编辑 / 局部修改

## 数据

生成的图片保存在：

~~~text
$DSH_HOME/mo-image/out/
~~~

配置保存在：

~~~text
$DSH_HOME/mo-image/config.json
~~~

API Key 只保存在本机，不会写入生成的图片。

## 常见问题

**设置里没有“生图模型”**

确认插件已安装、profile 的 dsh.profile.bundles 包含 dsh-mo-image，并重启过 DSH。

**401 / 403**

检查 API Key 是否有效，以及 Key 和 API 地址是否属于同一平台。

**400 model**

模型 ID 不在该平台的支持列表里，替换成平台提供的模型 ID。

**图片编辑超时**

图片编辑比文生图慢，不要连续重复提交同一个请求。

## License

MIT

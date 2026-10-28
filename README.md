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

## 模型适配层

不同平台的生图接口「长得不一样」：字段名不同（`size` / `width,height` / `image_size` / `aspect_ratio`）、取值范围不同（有的只认固定几个尺寸，有的有最小像素预算）、回应形状不同（`b64_json` / `url` / 直接二进制）。

插件把这些差异收进 `lib/adapters.js` 的适配器描述符里，调用方只认一套规范参数：

| 字段 | 作用 |
|---|---|
| `send[]` | 白名单：只有列出来的字段才会写进请求体，没列的一律不发 |
| `size` | 尺寸怎么编码、该模型接受哪些尺寸（`allowed` 白名单，或用 `minPixels` / `maxPixels` / `multiple` 约束） |
| `quality` | 规范 quality 如何映射成该平台的值（例如 DALL·E 3 的 `high → hd`） |
| `transport` | `json` 或 `multipart` |
| `response` | 从任意形状的回应里挖出图片（b64 / data-url / 外链 / 二进制都认） |
| `async` + `poll` | 异步入队型：提交拿 `task_id`，轮询到成功再下载 |
| `compose` | body 需要嵌套（如 `{input, parameters}`）时把白名单字段折叠进去 |

内置适配器：`openai-images`（通用兜底）、`gpt-image`、`dall-e-3`、`siliconflow`、`volcengine-ark`、`stability`、`dashscope-wanx`。

两种交互形态都覆盖：

- **同步**：一次请求直接返回图片
- **异步入队**：提交返回 `task_id`，按 `poll.intervalMs` 轮询 `GET /tasks/{taskId}`，`SUCCEEDED` 后下载结果；`FAILED` / 超时会带回上游原因

选择规则：`provider.adapter` 显式指定 → 按 API 域名匹配 → 按模型 ID 匹配 → 落到 `openai-images`。设置页不需要新增选项。

**尺寸自动适配**：你写 `256x256` 而模型最小只能出 `1024x1024` 时，插件会按最近的合法尺寸生成，再把结果缩回 `256x256`（内置零依赖 PNG 缩放）。缩放发生过会写进 `$DSH_HOME/mo-image/host.log`。

**错误自愈**：上游报「不认识某某参数」时摘掉该字段重试；报尺寸超限时往上抬一档重试；429 / 5xx 退避重试。降级过程都会写日志，方便回头把描述符改准。

新增一家平台：在 `lib/adapters.js` 里加一条描述符即可，不用动工具层和前端。

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

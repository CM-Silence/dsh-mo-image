# dsh-mo-image

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的生图插件。

配置一个 OpenAI Images 兼容的模型后，可以直接在对话里让模型生成图片，或用参考图做局部修改、融合和版本迭代。

## 功能

- 文生图：生成新图、重做
- 图片编辑：保留原图，只改指定部分
- 参考图：支持 1–16 张本地图片或 URL
- 多模型：不同提供商、不同模型可随时切换
- 模型感知提示词：按当前模型注入对应的写法、公式和约束
- 对话内直接显示生成结果

## 安装

要求：

- DSH >= 0.2.1-rc.2
- Node.js / pnpm（DSH 已自带）

从 GitHub 安装：

~~~bash
git clone https://github.com/CM-Silence/dsh-mo-image.git
dsh plugin --profile desktop add link:./dsh-mo-image
~~~

也可以直接使用仓库地址：

~~~bash
dsh plugin --profile desktop add github:CM-Silence/dsh-mo-image
~~~

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

内置了几家官方或大型模型平台，也可以选择“自定义模型 API”，填写自部署或其他兼容接口。

## 使用

直接对模型说：

> 画一张 1024x1024 的电商主图，白色背景，产品居中。

或者：

> 以这张图为基础，只把背景换成浅灰色，产品和文字不要动。

模型会在需要时调用：

- mo_image_generate：文生图 / 重做
- mo_image_edit：参考图编辑 / 局部修改

工具只接收 prompt、negative_prompt 和 images。**模型、尺寸、质量都由生图选择器控制**，工具不再接收 `model` / `size` / `quality`，避免对话模型把不稳定参数带进请求。

## 质量档位

质量档位由「当前模型」决定，宿主通过 `/api/mo-image/config` 的 `capabilities` 下发；没有官方质量参数的模型直接隐藏这一行。

| 模型族 | 质量行 | 选项 |
|---|---|---|
| OpenAI GPT-Image | 显示 | Off / Low / Medium / High / Auto |
| OpenAI DALL·E 3 | 显示 | Off / Standard / HD |
| Ideogram 3 | 显示 | Off / Turbo / Default / Quality |
| Google Gemini / Nano Banana | 隐藏 | 只有尺寸/比例，没有 quality |
| xAI Grok Imagine | 隐藏 | 只有 resolution，没有 quality |
| Recraft | 隐藏 | 没有 quality |
| Stability AI | 隐藏 | 没有 quality |
| Together AI | 隐藏 | 没有 quality |
| Fireworks / Novita | 隐藏 | 取决于网关；默认不显示 |
| SiliconFlow / 火山方舟 / 百炼 / BigModel | 隐藏 | 没有统一的 quality 参数 |
| A1111 / ComfyUI / SwarmUI / 本地 OpenAI 兼容 | 隐藏 | 没有统一 quality；用各自的 steps/cfg |

切换模型时，选择器会从目标模型的档位里选一个合法默认值；旧配置里的 `max`、`high` 等值会收敛到目标模型支持的最近档位（例如 GPT-Image 的 `max` → `High`），不会再由对话模型填 `Max`。

依据：[OpenAI Images API](https://platform.openai.com/docs/api-reference/images/create)（GPT-Image 的 `low/medium/high/auto`、DALL·E 3 的 `standard/hd`）、[Ideogram 3 API](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3)（`rendering_speed`）。Gemini、xAI、Recraft、Stability、Together、本地后端没有统一的官方 quality 字段，所以隐藏质量行。

## 提示词优化

生图模型选择器的首页新增「提示词优化」一栏，默认 **On**：

- **On**：保持现在的行为，按当前模型的提示词方言扩写/整理 prompt。
- **Off**：要求模型尽量把用户原话直接传给生图工具，不扩写、不补风格/光线/构图，也不自动补 negative prompt；只有用户明确说“优化/改写提示词”时才优化。
- 提示词优化只影响 `prompt` 文本；模型、尺寸、质量始终由选择器控制，工具不接受这些参数。
- 设置会写进 `config.json` 的 `defaults.promptOptimization`，默认 true；旧配置没有这个字段时按 On 处理。
- 工具描述和系统提示词会同时提示 Off 语义；编辑时同样使用用户原话或最小必要的修改说明。

## 数据

新生成的图片保存在当前会话工作区：

~~~text
<cwd>/generated-images/
~~~

`<cwd>` 来自 DSH 会话的 `session.header.cwd`。找得到 cwd 时不再写入插件状态目录，因此在「工作区可修改」权限下可以直接写项目；只有拿不到 cwd（例如非会话调用）时才回退到：

~~~text
$DSH_HOME/mo-image/out/
~~~

旧版本已经生成在 `$DSH_HOME/mo-image/out/` 的图片不会被迁移，旧的 `/api/mo-image/preview/<basename>` 链接仍然能打开。

预览 URL 使用 HMAC 签名，不暴露任意文件读取：签名 key 固定保存在 `$DSH_HOME/mo-image/preview.key`，图片本体留在项目目录。新图片的 `/api/mo-image/preview/<token>` 链接在宿主重启后仍然有效。

建议把 `generated-images/` 加进项目的 `.gitignore`，避免把生成图误提交。

配置保存在：

~~~text
$DSH_HOME/mo-image/config.json
~~~

API Key 不写进 `config.json`。旧版配置里的明文 key 会在第一次读取时迁到 DSH 凭据库：

~~~text
$DSH_HOME/.credentials.yaml
~~~

配置文件只保留 `apiKeyEnv: MO_IMAGE_<provider>_API_KEY` 这样的引用；同名环境变量也可以直接生效。Web 客户端只拿到 `hasKey` / `keySource`，不会收到明文；宿主在每次请求前通过 `ctx.credentials.resolve(ref)` 解析一次，密钥轮换后下一请求自动生效。凭据库按 DSH 的规则只允许当前 OS 用户读取（POSIX 0600；Windows 由 ACL 决定），但同一用户的 agent 进程仍可能读到，它是“不把密钥放进配置和浏览器”的隔离，不是对抗同 UID 进程的边界；DSH 也还没有 OS keychain provider。

配置接口只接受同源 `application/json` 请求，Host 必须是回环地址、IP 字面量或 `DSH_WEB_URL` 公布的域名，用来挡跨站写入和 DNS rebinding。

配置写入使用临时文件 + 原子替换，避免中断时把配置截断。

参考图支持本地路径和 http(s) URL；URL 默认拒绝本机/内网地址（含重定向逐跳检查）。如果确实要访问本地图片服务，可以设置环境变量 `MO_IMAGE_ALLOW_PRIVATE_REFS=1`。

## 内置云端提供商

设置页的「第三方模型提供商」会从宿主下发当前内置列表；选择后会带出默认地址、适配器和常用模型 ID，仍可手动修改。

| 提供商 | 适配器 | 默认模型 | 说明 |
|---|---|---|---|
| **Google Gemini / Nano Banana** | `google-gemini` | `gemini-2.5-flash-image`、`gemini-3-pro-image-preview` | 原生 `generateContent`；生成 + 参考图编辑，最多 14 张参考图 |
| OpenAI | `dall-e-3` / `gpt-image` / `openai-images` | 按模型 ID 自动匹配 | 生成 + 编辑 |
| **xAI Grok Imagine** | `xai-imagine` | `grok-imagine-image` | 生成；原生编辑暂未支持 |
| **Recraft** | `recraft` | `recraftv4_1`、`recraftv4`、`recraftv3`、`recraftv2` | 生成；原生编辑暂未支持 |
| **Ideogram** | `ideogram` | `ideogram-3` | 生成；原生编辑暂未支持 |
| **Stability AI** | `stability` | `core` | 生成 + 编辑（multipart） |
| **Together AI** | `together` | `black-forest-labs/FLUX.1-schnell`、`FLUX.1-dev` | 原生 width/height 请求；生成 |
| **Fireworks AI** | `openai-images` | `accounts/fireworks/models/flux-1-schnell` | OpenAI Images 兼容网关 |
| **Novita AI** | `openai-images` | `flux-1-schnell` | OpenAI Images 兼容网关 |
| 火山方舟 | `volcengine-ark` | 手动/获取 | 生成；模型列表可用 |
| 阿里云百炼 | `dashscope-wanx` | 手动/获取 | 通义万相异步任务 |
| 硅基流动 | `siliconflow` | 手动/获取 | 生成 + 单图编辑 |
| 智谱 BigModel | `openai-images` | 手动/获取 | 生成 |

说明：

- Google Gemini 使用 `x-goog-api-key` 头；Nano Banana Pro 在模型名包含 `pro-image` 时会按尺寸发送 `1K/2K/4K`。
- xAI 使用 `aspect_ratio` + `resolution`，不是 OpenAI 的 `size`。
- Recraft / Ideogram / Together / Stability 的默认模型 ID 只是建议值，服务端模型更新后可以在「模型目录」里改，或用「获取可用模型」重新拉取。
- 这些云端提供商的密钥仍只写入 DSH 凭据库，不写进 `config.json`。
- 内置列表来自宿主 manifest，客户端不单独维护一份；新增提供商会同时影响设置页和模型列表能力判断。

文档：

- [Nano Banana / Gemini image generation](https://ai.google.dev/gemini-api/docs/nanobanana)
- [xAI image generation](https://docs.x.ai/developers/model-capabilities/images/generation)
- [Recraft API](https://www.recraft.ai/docs/api-reference/introduction)
- [Ideogram API](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3)
- [Stability AI API](https://platform.stability.ai/docs/api-reference)
- [Together AI image generation](https://docs.together.ai/docs/inference/images/overview)
- [Fireworks AI](https://docs.fireworks.ai/)
- [Novita AI](https://novita.ai/docs/api-reference/api-reference-overview)

## 本地模型

设置页的「添加模型提供商」有三类入口：第三方模型提供商、自定义模型 API、**本地模型**。本地模型入口内置这些部署方式：

> 表里的「默认地址」是 **服务根地址**，不是完整 endpoint。插件会自动拼接协议路径：
> A1111 填 `http://127.0.0.1:7860`（插件拼 `/sdapi/v1/txt2img`、`/sdapi/v1/sd-models`）；LocalAI/sd-server 填 `http://127.0.0.1:8080/v1`（插件拼 `/images/generations`、`/models`）；ComfyUI 填 `http://127.0.0.1:8188`（插件拼 `/prompt`）；SwarmUI 填 `http://127.0.0.1:7801`（插件拼 `/API/...`）。

| 部署方式 | 适配器 | 默认地址（服务根地址） | 获取模型 | 生成 / 编辑 |
|---|---|---|---|---|
| stable-diffusion.cpp `sd-server` | `openai-images` | `http://127.0.0.1:8080/v1` | `/v1/models` | 生成 + `/images/edits` |
| LocalAI | `openai-images` | `http://127.0.0.1:8080/v1` | `/v1/models` | 生成；编辑取决于后端 |
| AUTOMATIC1111 / Forge / SD.Next / Draw Things | `a1111` | `http://127.0.0.1:7860` | `/sdapi/v1/sd-models` | 生成 + `/sdapi/v1/img2img` |
| ComfyUI | `comfyui` | `http://127.0.0.1:8188` | `/object_info`（CheckpointLoaderSimple） | 生成；原生编辑暂不支持 |
| SwarmUI | `swarmui` | `http://127.0.0.1:7801` | `/API/ListModels` | 生成；原生编辑暂不支持 |
| 其他 OpenAI 兼容网关 | `openai-images` | `http://127.0.0.1:3000/v1` | `/v1/models` | 取决于网关 |

说明：

- 本地服务没有鉴权时，**API 密钥可以留空**；`optionalKey` 会让宿主不发送 `Authorization`。需要 Bearer token 的服务再填密钥。
- 「模型目录」右侧的 **获取可用模型** 只对支持模型列表 API 的适配器显示；ComfyUI 列出的是 checkpoint 名称，A1111 列出的是 `sd-models` 的 title。
- A1111 / Forge / SD.Next 启动时需要加 `--api`。A1111 的 Basic Auth 目前不走密钥输入框，建议本地无鉴权或放到反向代理后面。A1111 的 img2img 只带第一张参考图。
- ComfyUI 的默认工作流是 **CheckpointLoaderSimple + KSampler**，适合 SD1.5/SDXL checkpoint；Flux、Qwen-Image、任意自定义工作流请用 OpenAI 兼容网关（或改用 sd-server/LocalAI 的后端）。
- SwarmUI 使用 `/API/GetNewSession` + `/API/GenerateText2Image`，原生编辑暂未实现。
- InvokeAI、Fooocus、复杂 ComfyUI 工作流：先套一层 OpenAI Images 网关，再选「其他 OpenAI 兼容网关」。
- 本地服务通常要自己启动、管理显存和模型；插件不负责下载/加载模型。工具超时是 360 秒，CPU 跑 1024×1024 可能超时。
- 参考图限制：multipart 编辑总大小 48MB、单张 15MB；JSON `image` 编辑为了控制 base64 峰值，总大小限制 10MB。生成图响应上限 32MB，超大图请降低尺寸。
- 参考图编辑优先用本地文件路径；参考图 URL 指向 `127.0.0.1` 会被 SSRF 防护拦住，需要 `MO_IMAGE_ALLOW_PRIVATE_REFS=1`。

文档：

- [stable-diffusion.cpp server API](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md)
- [LocalAI Image Generation](https://localai.io/docs/features/image-generation/)
- [AUTOMATIC1111 API](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API)
- [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [SwarmUI API](https://github.com/mcmonkeyprojects/SwarmUI/blob/master/docs/API.md)
- [stable-diffusion-api-to-openai](https://github.com/shulinbao/stable-diffusion-api-to-openai)（A1111 → OpenAI 网关示例）

## 提示词

插件不会拿一套模板套所有模型。每次组装系统提示词时，会读取设置里当前选中的模型，把对应的写法注入 `mo-image-prompt` 节；模型切换后，下一次生成自动换写法。

通用生成公式（参考 [Krene 提示词教程](https://www.krene.com/blog/ai-game-art-prompt-tutorial)）：

~~~text
主体 + 动作 + 环境 + 艺术风格 + 光影 + 构图 + 限制条件
~~~

编辑公式：

~~~text
动作动词 + 目标元素 + 期望的变化 + 风格细节
~~~

常用约束词：保持 / 修改 / 添加 / 删除 / 替换。编辑时只改一个点，列全保留项，并重复“其余不变”。

不同模型族的写法差异：

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

完整的模型模板、场景模板和自检清单在 `skills/mo-image-generation/SKILL.md` 与 `skills/mo-image-editing/SKILL.md`。插件会把这两个技能注册成运行时技能，模型按需加载；提示词写法表在 `lib/prompt-profiles.js`。

`negative_prompt` 只在支持它的适配器白名单里发送（Stability、硅基流动、通义万相、通用兼容）；GPT-Image、DALL·E 3、FLUX、Seedream、Nano Banana 不支持，传了会被白名单过滤或触发上游报错后自动摘掉。

参考的模型侧提示词指南：

- [OpenAI GPT-Image prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide)
- [Google Nano Banana prompting guide](https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana)
- [Black Forest Labs FLUX core principles](https://github.com/black-forest-labs/skills)
- [火山方舟 Seedream 提示词指南](https://console.volcengine.com/ark/region:cn-beijing/docs/seedream-4-0-5-0-prompt-guide)
- [阿里云 Qwen-Image API](https://www.alibabacloud.com/help/en/model-studio/qwen-image-api)

## 模型适配层

不同平台的生图接口「长得不一样」：字段名不同（`size` / `width,height` / `image_size` / `aspect_ratio`）、取值范围不同（有的只认固定几个尺寸，有的有最小像素预算）、回应形状不同（`b64_json` / `url` / 直接二进制）。

插件把这些差异收进 `lib/adapters.js` 的适配器描述符里，调用方只认一套规范参数：

| 字段 | 作用 |
|---|---|
| `send[]` | 白名单：只有列出来的字段才会写进请求体，没列的一律不发 |
| `size` | 尺寸怎么编码、该模型接受哪些尺寸（`allowed` 白名单，或用 `minPixels` / `maxPixels` / `multiple` 约束） |
| `quality` | 该模型是否有质量档位、档位名称/数量，以及如何映射成平台参数（如 DALL·E 的 `standard/hd`、Ideogram 的 `rendering_speed`）；没有就不下发，选择器也不显示质量行 |
| `transport` | `json` 或 `multipart` |
| `response` | 从任意形状的回应里挖出图片（b64 / data-url / 外链 / 二进制都认） |
| `async` + `poll` | 异步入队型：提交拿 `task_id`，轮询到成功再下载 |
| `compose` | body 需要嵌套（如 `{input, parameters}`）时把白名单字段折叠进去 |

内置适配器：`openai-images`（通用兜底）、`gpt-image`、`dall-e-3`、`google-gemini`、`xai-imagine`、`recraft`、`ideogram`、`stability`、`together`、`siliconflow`、`volcengine-ark`、`dashscope-wanx`、`a1111`、`comfyui`、`swarmui`。

两种交互形态都覆盖：

- **同步**：一次请求直接返回图片
- **异步入队**：提交返回 `task_id`，按 `poll.intervalMs` 轮询 `GET /tasks/{taskId}`，`SUCCEEDED` 后下载结果；`FAILED` / 超时会带回上游原因

选择规则：`provider.adapter` 显式指定 → 按 API 域名匹配 → 按模型 ID 匹配 → 落到 `openai-images`。设置页不需要新增选项。

**尺寸自动适配**：你写 `256x256` 而模型最小只能出 `1024x1024` 时，插件会按最近的合法尺寸生成，再把结果缩回 `256x256`（内置零依赖 PNG 缩放）。反过来，请求尺寸大于模型上限时按上限生成并附注说明，不会把小图放大冒充目标尺寸。缩放和上限调整都会写进 `$DSH_HOME/mo-image/host.log`。

**错误自愈**：上游报「不认识某某参数」时摘掉该字段重试；报尺寸超限时往上抬一档重试；429 / 5xx 退避重试。降级过程都会写日志，方便回头把描述符改准。

新增一家平台：在 `lib/adapters.js` 里加一条描述符即可，不用动工具层和前端。

## 网络与代理

插件在宿主进程里发请求，而 Node 自带的 `fetch` **不会读 Windows 系统代理**（也不读注册表）。所以插件自己解析，按优先级决定走不走代理：

1. `MO_IMAGE_PROXY`：显式覆盖。填代理地址（如 `http://127.0.0.1:7897`），或填 `off` 强制直连；
2. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写都认，`NO_PROXY` 生效）；
3. Windows「系统代理」：Clash 等加速器开的系统代理会被自动读取，**规则模式和全局模式都适用**；
4. 都没有就直连。

边界与注意事项：

- **本机地址永远直连**：`localhost`、`127.*`、`::1` 不会进代理，本地适配器（A1111 / ComfyUI / SwarmUI / sd-server / LocalAI）不受影响。
- **系统绕过列表生效**：`ProxyOverride` 里的 `192.168.*`、`10.*` 等内网段同样直连。
- 系统代理的开关有 30 秒缓存，切换后不用重启宿主。
- TUN 模式没有「系统代理」可读，插件会安静地退回直连——此时由虚拟网卡接管，请求照样能通。
- 只支持 `http://` 形式的 HTTP 代理（走 CONNECT 隧道）；SOCKS 请在加速器里开混合端口。
- 规则模式下**域名必须被判为走代理**：如果加速器规则把它判成 DIRECT，插件这边也无能为力。
- 走代理、以及失败原因都会写进 `$DSH_HOME/mo-image/host.log`。

## 常见问题

**设置里没有“生图模型”**

确认插件已安装、profile 的 dsh.profile.bundles 包含 dsh-mo-image，并重启过 DSH。

**请求报 `fetch failed`，或 `网络请求失败：xxx（UND_ERR_CONNECT_TIMEOUT，直连）`**

目标域名在当前网络下连不通（DNS 污染或 TCP 被拦），不是 Key 或模型的问题。开加速器的系统代理即可，插件会自动使用；也可以显式指定 `MO_IMAGE_PROXY=http://127.0.0.1:7897`。已经开了代理还失败，先确认加速器处于规则模式时有没有把这个域名误判成 DIRECT。

**401 / 403**

检查 API Key 是否有效，以及 Key 和 API 地址是否属于同一平台。

**400 model**

模型 ID 不在该平台的支持列表里，替换成平台提供的模型 ID。

**图片编辑超时**

图片编辑比文生图慢，不要连续重复提交同一个请求。

## License

MIT

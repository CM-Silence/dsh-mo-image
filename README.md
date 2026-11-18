# dsh-mo-image

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的生图插件。

配置一个生图模型后，可以直接在对话里让模型生成图片，或用参考图做局部修改、融合和版本迭代。

## 功能

- 文生图：生成新图、重做
- 图片编辑：保留原图，只改指定部分
- 参考图：支持 1–16 张本地图片或 URL
- 多模型：不同提供商、不同模型可随时切换
- 选择器皮肤：默认跟随原版对话模型选择器；检测到 Codex 风格美化插件时自动切换同款弹层
- 模型感知提示词：按当前模型注入对应的写法、公式和约束
- 对话内直接显示生成结果

## 安装

要求：

- DSH >= 0.2.1-rc.2
- Node.js / pnpm（DSH 已自带）

从 npm 安装（推荐）：

~~~bash
dsh plugin --profile desktop add dsh-mo-image
~~~

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

## 更新

DSH 每次启动会查一次 npm 上的最新版本（`registry.npmjs.org`，不通时退 `registry.npmmirror.com`）。有新版时，设置 → 生图模型 页顶部会出现「有可用更新」：点开能看到版本号和这次改了什么，点「更新」后插件在后台换成新版本，重启 DSH 后生效。

更新说明来自包里的 `CHANGELOG.md`（按版本从 jsDelivr / unpkg / npmmirror 读取）；那个版本没写说明时，对话框显示「暂无更新说明」。

- 用 `link:` 方式安装的开发环境不会自动改文件，点更新只会提示你自己 `git pull`。
- 检测和安装都走 npm：点更新时按 `dsh-mo-image@x.y.z` 的版本规格安装，不依赖 GitHub。从 npm 安装的走 DSH 原生的 `updateBundle`（先卸旧版再装新版，装失败会自动装回旧版）；早期用 `github:` 装的会被换成 npm 版——这条「先卸载再装」的路径没有 DSH 的自动回滚，所以 npm 安装失败时会按原来的规格装回去，并明确提示「更新安装失败，已装回原来的版本」；万一连装回也失败，会提示你去插件管理里重装，不会静默失败。
- 没有桌面版的插件管理器时，手动更新：

~~~bash
dsh plugin --profile desktop add dsh-mo-image
~~~

维护者发版：

~~~bash
npm run release -- minor                  # 改版本号、写 CHANGELOG、跑测试、打 tag、推送、建 Release
npm run release -- 0.4.1-rc1 --publish    # 指定版本并同时发到 npm（rc 走 next 标签）
npm run release -- minor --dry-run        # 只看会做什么
~~~

发布到 npm 时，`-rc / -b / -a` 版本会自动用 `--tag next`，只有正式版才顶掉 `latest`。

## 配置

打开：

**设置 → 生图模型**

添加一个提供商：

| 项目 | 填写内容 |
|---|---|
| API 地址 | OpenAI Images 兼容地址，通常以 /v1 结尾 |
| API 密钥 | 对应平台的 Key |
| 模型 ID | 例如 gpt-image-2.5-flare |
| 显示名称 | 可选；对话里的模型名，留空就用模型 ID |

保存后，在对话输入框右侧选择当前生图模型。

「模型目录」沿用 DSH 对话模型设置页的模型行：拖动手柄（或聚焦手柄后按上下方向键）调整顺序，顺序就是选择器里的顺序；「获取可用模型」会把上游列出的模型连同显示名一起带回来，已加入列表的模型默认勾选，勾选结果就是新的模型列表。

编辑已有提供商时，表单分三段：**密钥 / 显示名称 / API 地址**常显；**协议设置**（默认收起）里是 API 协议（含右侧的「识别协议」按钮）、鉴权方式、图生图端点和两个返回格式——这一组回答的是同一件事「这个地址按哪套协议说话、这套协议怎么认证、返回怎么读」；**自定义设置**（默认收起）里是模型目录、自定义协议的三条路由与调度模型这些接入细节。

内置了几家官方或大型模型平台，也可以选择“自定义模型 API”，填写自部署或其他兼容接口。

## 多语言

插件接入 DSH 的 locale 服务，设置页和右下角生图模型选择器会跟随 **设置 → 通用 → 语言** 立即切换，支持 DSH 内置的 8 种语言：中文、English、日本語、Español、Français、Deutsch、Русский、Português。

- 文案源是 [`locale/messages.csv`](locale/messages.csv)：一行一个 key，一列一种语言，UTF-8 无 BOM。改文案只改这个表；用 Excel 编辑时请走「数据 → 从文本/CSV」并选择 UTF-8。
- 改完运行 `npm run build:locales`，把字典写进 `lib/client.js` 的生成块；`npm run check:locales` 在测试里校验生成块没有过期。
- 新增一种语言：在 CSV 增加一列（小写 BCP 47 id），同步更新 `scripts/build-locales.mjs` 的 `BUILTIN_LOCALES`，再生成一次即可；测试会按这个常量校验列顺序。DSH 端还要能提供这个 locale，插件才会注册出可选语言。
- 覆盖范围：设置页、模型选择器、用户可见的报错和 aria-label。工具描述、系统提示词和技能文案不参与翻译。
- 宿主设置接口的报错会附带稳定的 `code`/`params`（见 [`lib/localized-error.js`](lib/localized-error.js)），前端按当前语言重写整句；工具调用和宿主日志仍保留原始中文，模型看到的提示词不受影响。新增宿主错误时，在 `SERVER_ERROR_CODES` 里加 code，并在 CSV 加 `serverError.<code>`。
- 缺 key 时按 DSH 的 locale 回退链回退到英文，再回退到 key；没有 locale 服务的环境（例如纯单测）回退到中文。

## 选择器皮肤

生图席挂在输入框右侧（`conversation.input.right`），默认沿用 DSH 原版对话模型选择器的类名与结构：类名从当前样式表解析，菜单、搜索、分组、键盘行为和原版对齐；只改 CSS 的主题会自动覆盖到它。

如果对话席被 [dsh-codex-model-effort-selector](https://github.com/ABING1111/dsh-codex-model-effort-selector) 这类接管型美化插件替换，插件会检测 `.cmes-*` DOM 并切换成同一套 Codex 皮肤：

- **质量**占据「推理等级」的位置：滑条按当前模型实际公布的档位排列（Auto 紧挨着 Off，不会被当成最高档），每档一色；拖动/键盘/Home/End 都可改档，最高档触发紫罗兰、星尘动画和「更快消耗使用额度」提示。
- 点弹层中间的档位标题进入 **provider → 模型**两级下钻，带搜索、当前勾选和「N 档」徽标。
- **★ 提示词优化** 是左侧工具（真正写进 `defaults.promptOptimization`，不是 Codex 的纯视觉 Fast；悬停显示 Codex 两行卡片「提示词优化 / 用量更多」，开启时滑条走 fast-mode 星尘动画），**齿轮**是右侧「其他设置」工具，只放尺寸设置，内容超高时可滚动。
- 弹层通过 portal 挂到 `document.body`，不赌输入区祖先没有 transform/filter/backdrop-filter，避免定位偏移和被裁剪。

未知的接管型插件没有公共协议，插件只采样它触发器的尺寸/字号/颜色做通用降级，弹层仍用宿主 token 自绘；这样并排不违和，但不承诺逐像素一致。想做到 1:1，需要和对方约定皮肤标记或 CSS 变量。

## 使用

直接对模型说：

> 画一张 1024x1024 的电商主图，白色背景，产品居中。

或者：

> 以这张图为基础，只把背景换成浅灰色，产品和文字不要动。

模型会在需要时调用：

- mo_image_settings：读当前配置（模型、提示词优化开关、该模型的写法）；本会话读过且配置没变时可以不调
- mo_image_generate：文生图 / 重做
- mo_image_edit：参考图编辑 / 局部修改

工具接收 prompt、negative_prompt、images；`model` 可选，尺寸和质量仍由生图选择器控制（工具不接收 `size` / `quality`）。

**一步确认配置**：`mo_image_settings` 返回一个很小的 JSON——当前提供商和模型的唯一 id、提示词优化开关、一句该模型的写法提示（Auto 模式下再加可选模型 id）：

```json
{"provider":"comfyui","model":"flux-2-klein-4b.safetensors","promptOptimization":true,"hint":"自然语言散文，主体+动作前置，30–80 词；英文优先；无 negative prompt；完整写法没读过时先加载对应 skill，读过就不用再加载"}
```

提示词优化开启时，`hint` 末尾会带这半句：完整写法（skill 里的模板与示例）只在当前模型的还没读过时才要加载，读过就不用重复加载；优化关闭时没有这半句，因为那时直接照用户原话写。

系统提示词的 `mo-image-prompt` 节里有一行「配置状态」，由每个会话自己的快照决定：新会话还没读过时提示先调 `mo_image_settings`；读过之后只要配置没变就一直显示「一致」，模型可以直接生图，不必每轮重读。用户在设置里换了模型、切了提示词优化开关或改了尺寸/工作流参数后，这一行会变回「改过」（改回原值、中间没有对话则不算变化）。读取或交接会把这刻的配置锁成快照：之后配置再变只会产生新快照、让下一次调用重新判断，不会反过来影响已经发出去或已经锁定的那次生成。同一个会话里重复读一次配置，返回的是 `{"unchanged":true,"hint":"…"}`，不会再把整份配置重复一遍；上下文被压缩、已经看不到那份配置时，传 `refresh:true` 重读一次即可。

**漏读不会报错**：没读过（或读了之后配置又变了）就调用生图/改图工具，不会发请求、也不会红字报错，而是返回 `{"path":"","needsSettings":true,"settings":{…}}`——把当前配置直接交回给对话模型，让它按新写法重写提示词再调用一次。这样既不会用旧模型的口径生成图片，也不会因为一次手快的调用在界面上留下一条失败记录。

**`model` 是可选的核对项**：不传就用用户选中的那一项（提供商 + 模型 id 一起核对，不同提供商的同名模型不算同一个），传了不一致的值直接拒绝；Auto 模式下必须从当前提供商的模型列表里挑一个。传了 `provider` 也会核对，不一致同样拒绝——工具永远不会替用户切换提供商或模型。

**Auto 行**：模型选择器第一行是“自动”（英文界面为 `Auto`）。只有选中它，对话模型才享有模型选择权；选中后系统提示词会列出可选模型。没有配置任何模型时（所有提供商的模型目录都为空）不显示自动行，直接显示“还没有模型，去设置 → 生图模型添加”。

**配置是权限级锁定**：插件用 `ctx.tools.guard()` 注册了全局工具守卫，任何工具调用只要目标是 `mo-image/config.json` 或 `/api/mo-image/config`（写文件、shell 命令、HTTP 请求都算），都会在执行前被拒绝，而不是靠提示词"请求"模型别改。守卫只看目标字段，不会误伤正文里出现同样字符串的插件源码编辑。它挡不住刻意混淆的 shell 命令（base64、字符串拼接），真正的硬边界仍然是宿主是否给该 Agent 开 shell。

**图片读取**：默认不读生成图，也不描述画面；只有用户明确要求"看看这张图"时才允许读。

## 质量档位

质量档位由「当前模型」决定，宿主通过 `/api/mo-image/config` 的 `capabilities` 下发。原版皮肤里，没有官方质量参数的模型隐藏这一行；Codex 皮肤里显示「此模型未提供质量档位」，尺寸仍从齿轮进入，提示词优化用左上角星标切换。GPT-Image 的 `Auto` 是模式而不是画质档，滑条里紧挨着 `Off` 放，不排到最高档。

| 模型族 | 质量行 | 选项 |
|---|---|---|
| OpenAI GPT-Image | 显示 | Off / Auto / Low / Medium / High |
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

模型选项的「质量」方框可以覆盖这张表的判断：勾上 / 取消「支持质量参数」、改参数名（支持 `a.b.c` 嵌套路径）或自定义档位表，都能让一个模型从「隐藏」变成可选，或反过来明确「这个模型不发质量参数」。一键配置不会重新打开你明确关掉的质量开关。

依据：[OpenAI Images API](https://platform.openai.com/docs/api-reference/images/create)（GPT-Image 的 `low/medium/high/auto`、DALL·E 3 的 `standard/hd`）、[Ideogram 3 API](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3)（`rendering_speed`）。Gemini、xAI、Recraft、Stability、Together、本地后端没有统一的官方 quality 字段，所以隐藏质量行。

## 提示词优化

生图模型选择器里新增「提示词优化」，默认 **On**（原版皮肤在首页一栏；Codex 皮肤是弹层左上角由三颗四角星组成的 AI 星标，悬停显示 Codex 两行卡片「提示词优化 / 用量更多」）：

- **On**：保持现在的行为，按当前模型的提示词方言扩写/整理 prompt。
- **Off**：要求模型尽量把用户原话直接传给生图工具，不扩写、不补风格/光线/构图，也不自动补 negative prompt；只有用户明确说“优化/改写提示词”时才优化。
- 提示词优化只影响 `prompt` 文本；模型、尺寸、质量始终由选择器控制，工具不接受这些参数。
- 设置会写进 `config.json` 的 `defaults.promptOptimization`，默认 true；旧配置没有这个字段时按 On 处理。
- 提示词优化和生图技能是分开的：生图/改图时仍会加载 `mo-image-generation` / `mo-image-editing` 技能获取调用与输出规则；Off 只跳过技能里的公式和模板。
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

## 给其它插件读状态（moImageStatus）

0.7.0 起，插件在宿主注册只读服务 `moImageStatus`。同一个宿主里的插件可以：

~~~js
const service = ctx.get('moImageStatus')
if (service?.contract >= 1) {
  const status = await service.describe()
}
~~~

`describe()` 返回一份快照，不写配置，也不依赖浏览器状态：

| 字段 | 含义 |
|---|---|
| `contract` | 契约版本，当前 `1` |
| `version` | 插件版本号 |
| `ready` / `configured` / `missing` | 是否可用，以及缺哪一项（`provider` / `baseUrl` / `key` / `model`） |
| `provider` | `{ id, name, baseUrl, optionalKey, protocol, adapter }` 或 `null` |
| `model` / `auto` / `models` | 当前模型；Auto 时 `model='auto'` 并带候选列表 |
| `key` | `{ ok, source, ref }`，`source` 为 `optional` / `credentials` / `env` / `config` |
| `capabilities` | `{ generate, edit, editModels, maxRefs, size }`；`edit` 按适配器 / ComfyUI 工作流判断，`editModels` 是 Auto 下可改图的模型，`maxRefs` 为 16 |
| `defaults` / `promptOptimization` | 选择器里的尺寸、质量与提示词优化开关 |

调用方必须自己处理服务不存在的情况：0.6 及更早版本没有这个服务，按旧的文件格式回退即可（工作台就是这么做的，并会标注 `source: 'legacy'`）。

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
| **Google Gemini / Nano Banana** | `google-gemini` | `gemini-nano-banana-2.1`、`gemini-3.1-flash-image`、`gemini-3-pro-image`、`gemini-2.5-flash-image` | 原生 `generateContent`；生成 + 参考图编辑，新模型最多 14 张、2.5 只有 3 张 |
| OpenAI | `openai-images` | 按模型 ID 自动匹配 | 生成 + 编辑 |
| **OpenAI Responses** | `openai-responses` | 手动/获取 | 官方新版 `image_generation` 工具；需要在「自定义设置」里填「调度模型」 |
| **OpenRouter** | `openrouter-images` | `google/gemini-3.1-flash-image`、`openai/gpt-image-2.5-flare` | 专用 `/api/v1/images`；生成 + `input_references` 参考图 |
| **Azure OpenAI** | `openai-images`（`auth.mode: 'api-key'`） | 你的部署名 | `api-key` 鉴权；`model` 填部署名 |
| **Black Forest Labs** | `bfl` | `flux-2-pro`、`flux-2-max`、`flux-3-image`、`flux-kontext-pro` | 异步队列；生成 + FLUX.2/FLUX 3 参考图 |
| **fal.ai** | `fal` | `fal-ai/flux-2-pro`、`fal-ai/flux-pro/kontext` | 异步队列；`COMPLETED` 后还要取一次 `response_url` |
| **Replicate** | `replicate` | `black-forest-labs/flux-2-pro` | 异步队列；按模型 schema 决定输入字段 |
| **魔搭 ModelScope** | `modelscope` | `Qwen/Qwen-Image-2.1`、`Qwen/Qwen-Image-Edit` | 异步任务；提交带 `X-ModelScope-Async-Mode`，轮询 `/v1/tasks/{id}` |
| **xAI Grok Imagine** | `openai-images`（`edit:'none'`） | `grok-imagine-image` | 生成；`aspect_ratio` + `resolution`（由主机规则给），原生编辑暂未支持 |
| **Recraft** | `recraft` | `recraftv4_1`、`recraftv4`、`recraftv3`、`recraftv2` | 生成 + `imageToImage` 编辑 |
| **Ideogram** | `ideogram` | `ideogram-3`、`ideogram-4`、`ideogram-4-5`、`ideogram-4-transparent` | 生成；模型写在路径里，4 收 JSON+像素枚举，4-5 只收 `size`，3/transparent 收字母 `x` 的比例 |
| **Stability AI** | `stability` | `core` | 生成 + 编辑（multipart） |
| **Together AI** | `openai-images`（`edit:'none'`） | `black-forest-labs/FLUX.1-schnell`、`FLUX.1-dev` | 原生 width/height 请求；生成 |
| **Fireworks AI** | `openai-images` | `accounts/fireworks/models/flux-1-schnell` | OpenAI Images 兼容网关 |
| **Novita AI** | `openai-images` | `flux-1-schnell` | OpenAI Images 兼容网关 |
| 自定义 / 新网关 | `openai-images` | 手动/获取 | 同步或异步自动识别（见下文） |
| 火山方舟 | `openai-images`（`edit:'same'`） | 手动/获取 | 生成；档位按模型分（5.x 是 `1K/1.5K/2K`，lite 是 `2K/3K/4K`，4.5 是 `2K/4K`），也收任意宽高 |
| 火山方舟 Agent Plan | `openai-images`（`edit:'same'`） | 手动/获取 | 与火山方舟同协议，基础地址换成 `/api/plan/v3` |
| 阿里云百炼 · Qwen-Image | `dashscope-qwen-image` | `qwen-image-3.0-pro`、`qwen-image-3.0` | 原生多模态同步接口 |
| 阿里云百炼 · 通义万相 | `dashscope-wanx` | `wan2.6-t2i`、`wan2.7-image-pro`、`wan2.7-image`、`wanx2.1-t2i-turbo` | 异步入队任务；只有 wan2.7 认 `1K/2K/4K` 档位 |
| 硅基流动 | `openai-images`（`edit:'same'`） | 手动/获取 | 生成 + 单图编辑 |
| 智谱 BigModel | `openai-images`（`edit:'none'`） | `cogview-4`、`glm-image` | 生成；一次只回一张 |
| **MiniMax**（国际站 `api.minimax.io`） | `openai-images` | `MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed` | H3-Image 就是 OpenAI Images 形状（生成 + `/images/edits` 收 1–16 张参考图）；`aspect_ratio` + `area`（`1K/2K/4K`），不发 `size` |
| MiniMax 中国 | `openai-images` | `MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed` | 同一套接口，基础地址换成 `api.minimax.cn`（现行官方域名） |

说明：

- Google Gemini 使用 `x-goog-api-key` 头；`imageSize` 按模型分级（3.1-flash 支持 `512/1K/2K/4K`，2.5 不发），`aspectRatio` 新模型 14 档。
- xAI 使用 `aspect_ratio` + `resolution`，不是 OpenAI 的 `size`。
- MiniMax H3-Image 的 `size` 与 `aspect_ratio`/`area` 是互斥的（同时给会 400），插件只发后者，让服务端按档位算宽高；它没有 `negative_prompt`（负面词拼进提示词），也没有质量档位枚举（只有 `output_compression` 0–100 的压缩率）。旧模型 `image-01` / `image-01-live` 走的是另一条旧接口 `POST /v1/image_generation`（`aspect_ratio` + `base_resp` 响应），不是 OpenAI Images 形状，所以没有放进这两个预设。
- Recraft / Ideogram / Together / Stability 的默认模型 ID 只是建议值，服务端模型更新后可以在「模型目录」里改，或用「获取可用模型」重新拉取。
- 这些云端提供商的密钥仍只写入 DSH 凭据库，不写进 `config.json`。
- 内置列表来自宿主 manifest，客户端不单独维护一份；新增提供商会同时影响设置页和模型列表能力判断。
- Replicate 的输入字段由模型 schema 决定；schema 拉不到时只发 prompt 并在结果里注明，不会猜字段名。
- 魔搭是**异步任务**：提交 `POST /v1/images/generations`（带 `X-ModelScope-Async-Mode: true`）拿 `task_id`，再轮询 `GET /v1/tasks/{task_id}`（带 `X-ModelScope-Task-Type: image_generation`），图片在 `output_images`。`size` 是 `1024x1024` 这样的字符串，网关按每边 64–2048 校验（插件会提前把超界尺寸按比例收进区间）；参考图走 `image_url`，一张发字符串、多张发数组，data URI 可直接用。提交响应可能提前回 `SUCCEED` 但还没有图，插件一律以轮询结果为准。
- 自定义模型 API 和不认识的域名走 `openai-images`：响应里有图就同步返回，有任务信号就自动轮询，新厂商大多不用再写适配器。识别不了的异步形状（需要专用请求头/轮询头）仍走专用适配器。

文档：

- [Nano Banana / Gemini image generation](https://ai.google.dev/gemini-api/docs/nanobanana)
- [xAI image generation](https://docs.x.ai/developers/model-capabilities/images/generation)
- [Recraft API](https://www.recraft.ai/docs/api-reference/introduction)
- [Ideogram API](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3)
- [Stability AI API](https://platform.stability.ai/docs/api-reference)
- [Together AI image generation](https://docs.together.ai/docs/inference/images/overview)
- [Fireworks AI](https://docs.fireworks.ai/)
- [Novita AI](https://novita.ai/docs/api-reference/api-reference-overview)
- [ModelScope API-Inference](https://www.modelscope.cn/docs/model-service/API-Inference/intro)

## 本地模型

设置页的「添加模型提供商」有三类入口：第三方模型提供商、自定义模型 API、**本地模型**。本地模型入口内置这些部署方式：

> 表里的「默认地址」是 **服务根地址**，不是完整 endpoint。插件会自动拼接协议路径：
> A1111 填 `http://127.0.0.1:7860`（插件拼 `/sdapi/v1/txt2img`、`/sdapi/v1/sd-models`）；LocalAI/sd-server 填 `http://127.0.0.1:8080/v1`（插件拼 `/images/generations`、`/models`）；ComfyUI 填 `http://127.0.0.1:8188`（插件拼 `/prompt`）；SwarmUI 填 `http://127.0.0.1:7801`（插件拼 `/API/...`）。

| 部署方式 | 适配器 | 默认地址（服务根地址） | 获取模型 | 生成 / 编辑 |
|---|---|---|---|---|
| stable-diffusion.cpp `sd-server` | `openai-images` | `http://127.0.0.1:8080/v1` | `/v1/models` | 生成 + `/images/edits` |
| LocalAI | `openai-images`（`edit:'none'`） | `http://127.0.0.1:8080/v1` | `/v1/models` | 生成；没有 `/images/edits` |
| AUTOMATIC1111 / Forge / SD.Next / Draw Things | `a1111` | `http://127.0.0.1:7860` | `/sdapi/v1/sd-models` | 生成 + `/sdapi/v1/img2img` |
| ComfyUI | `comfyui` | `http://127.0.0.1:8188` | `/object_info`（CheckpointLoaderSimple + UNETLoader） | 生成 + 编辑；内置工作流按模型自动选，也可粘自定义工作流 |
| SwarmUI | `swarmui` | `http://127.0.0.1:7801` | `/API/ListModels` | 生成；原生编辑暂不支持 |
| 其他 OpenAI 兼容网关 | `openai-images` | `http://127.0.0.1:3000/v1` | `/v1/models` | 取决于网关；异步任务自动轮询 |

说明：

- 本地服务没有鉴权时，**API 密钥可以留空**；`optionalKey` 会让宿主不发送 `Authorization`。需要 Bearer token 的服务再填密钥。
- 「模型目录」右侧的 **获取可用模型** 对第三方提供商、自定义模型 API 和本地部署器都可用：点击后先向端点探测模型，再弹出可搜索、可全选/取消全选的候选列表，只有点「添加所选」才写入当前表单。OpenAI 兼容接口返回的结果会先筛掉可能不是用于生图的模型，也可以勾选「显示全部模型」；没有模型列表 API 的适配器不显示这个按钮。ComfyUI 列出的是 checkpoint 与 `UNETLoader` 里的 diffusion 模型名，A1111 列出的是 `sd-models` 的 title。
- 选择第三方提供商后，「提供商」标签右侧会出现 **前往提供商官网**，按当前选择打开官方 API Key / 控制台页面；本地和自定义模式不显示这个链接。
- A1111 / Forge / SD.Next 启动时需要加 `--api`。A1111 的 Basic Auth 目前不走密钥输入框，建议仅在可信网络中使用，或加一层访问控制。A1111 的 img2img 只带第一张参考图。
- ComfyUI 的**内置工作流按模型自动选**：模型在 `UNETLoader` 列表里就按 diffusion 模型走（FLUX.2 用 `UNETLoader` + `CLIPLoader` + `VAELoader` + `SamplerCustomAdvanced`，MOSS-Image 用 MOSS 的编码器与编辑 LoRA），否则按 checkpoint 用 `CheckpointLoaderSimple + KSampler`（SD1.5/SDXL）。编辑也有内置路径：checkpoint 走 `VAEEncode` + img2img（`denoise 0.6`），FLUX.2 走 `ReferenceLatent`，MOSS 走 `TextEncodeMOSSImageEdit`。
- 想换工作流就把 ComfyUI「导出（API）」的 JSON 粘进模型选项；UI 格式的 JSON 也认（插件用 `/object_info` 转成 API 格式，缺节点会点名报错）。工作流与参数表的配合见下面的「ComfyUI 工作流与参数表」。
- SwarmUI 使用 `/API/GetNewSession` + `/API/GenerateText2Image`，原生编辑暂未实现。
- InvokeAI、Fooocus、复杂 ComfyUI 工作流：先套一层 OpenAI Images 网关，再选「其他 OpenAI 兼容网关」。
- 本地服务通常要自己启动、管理显存和模型；插件不负责下载/加载模型。工具超时是 360 秒，CPU 跑 1024×1024 可能超时。
- 参考图限制：multipart 编辑总大小 48MB、单张 15MB；JSON `image` 编辑为了控制 base64 峰值，总大小限制 10MB。生成图响应上限 32MB，超大图请降低尺寸。
- 参考图编辑优先用本地文件路径；参考图 URL 指向 `127.0.0.1` 会被 SSRF 防护拦住，需要 `MO_IMAGE_ALLOW_PRIVATE_REFS=1`。

**ComfyUI 工作流与参数表**

- 工作流优先级：模型选项里的自定义工作流 > 内置模板（按模型自动选，见上）。自定义工作流支持 `{{prompt}}` / `{{negative_prompt}}` / `{{width}}` / `{{height}}` / `{{seed}}` / `{{model}}` / `{{image}}` 七个占位符，占位符之外的部分原样发送。
- 不写占位符也能用：「解析工作流」会从图里找出采样器、正/负 `CLIPTextEncode`、尺寸、seed、模型、参考图的落点并自动填好映射；映射面板只把手动可能要改的**宽 / 高 / 参考图**列出来（提示词与负面词由工具参数直接写入，seed 与模型是参数表里的普通行）。
- 「解析参数」把工作流里所有原始值输入（例如 `steps`、`cfg`、`sampler_name`、`denoise`）列成候选，勾中即写入「常规」参数表：默认值取当前值、类型按值推断、参数名只是给对话模型看的键。
- 参数表才是运行时真正写工作流的东西：默认值非空的行随请求写入；清空默认值 = 不碰工作流里的原值；勾了「暴露」的行才出现在给对话模型的参数清单里。行级锁只挡一键配置与自动检测，不挡手改。
- 提示词与负面词不在参数表里；要手控落点就在工作流里写 `{{prompt}}` / `{{negative_prompt}}` 占位符。

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
| `size` | 尺寸怎么编码、该模型接受哪些尺寸。`control` 决定选择器给什么控件（`wh` 宽高 / `aspect` 比例+档位 / `preset` 档位下拉+自定义 / `prompt` 宽高写进提示词），`wire` 说明上游真实吃什么，`tiers` 是档位名与像素，`allowed` 是白名单（`allowCustom: true` 时白名单外的宽高也照发），`sizeByModel` 按模型覆盖整套策略 |
| `quality` | 该模型是否有质量档位、档位名称/数量，以及如何映射成平台参数（如 DALL·E 的 `standard/hd`、Ideogram 的 `rendering_speed`）；没有就不下发，选择器也不显示质量行 |
| `transport` | `json` 或 `multipart` |
| `response` | 从任意形状的回应里挖出图片（b64 / data-url / 外链 / 二进制都认） |
| `authHeader` | 该协议的**默认**鉴权形态：`bearer`（默认）/ `api-key`（Azure）/ `x-key`（BFL）/ `fal-key`（fal）；提供商设了 `provider.auth` 就以它为准 |
| `endpoints` | 可以是字符串，也可以是按模型拼路径的函数（Ideogram、fal、Replicate） |
| `async` + `output` | 异步入队型：`async` 只剩请求侧（`edit / build / submitPath`）；轮询地址、状态词、结果图读 `output:{kind:'task'}`（`lib/output-profiles.js`），轮询头在适配器侧（`taskPollHeaders`）；老写法的 `poll` 仍兼容 |
| `autoAsync` | 通用兜底自己识别：响应里有图就同步返回，有任务 id / 轮询地址就跟着轮询（自定义 API 不需要选它） |
| `compose` | body 需要嵌套（如 `{input, parameters}`）时把白名单字段折叠进去 |

内置协议 17 条。协议只负责「三个地址 + 组装 + 响应解码」：字段名、尺寸与质量、常量参数由预设与模型规则决定，同一条地址下真正的差异（编辑端点往哪走）做成**协议级选项**；**鉴权方式是提供商字段**（`provider.auth`），回答的是「这个地址怎么认证」，与协议无关，所以切到任何协议都能设，不再各占一条协议 id。

| 分组 | 协议 id | 用途 | 三条地址（生成 / 编辑 / 模型列表） |
|---|---|---|---|
| 通用 | `openai-images` | 通用兜底：OpenAI Images 及一切兼容网关；自动识别同步 / 异步 | `/images/generations` / `/images/edits`（`edit` 选项可改） / `/models` |
| 通用 | `openai-responses` | 官方 Responses API 的 `image_generation` 工具 | `/responses` / `/responses` / `/models` |
| 兼容网关 | `openai-chat` | chat/completions 中转站 | `/chat/completions` / `/chat/completions` / `/models` |
| 兼容网关 | `openrouter-images` | OpenRouter 专用 Images | `/images` / `/images` / `/models` |
| 厂商原生 | `google-gemini` | Gemini / Nano Banana 的 `generateContent` | `/models/{model}:generateContent` / 同左 / `/models` |
| 厂商原生 | `recraft` | Recraft | `/images/generations` / `/images/imageToImage` / — |
| 厂商原生 | `ideogram` | Ideogram（模型写在路径里） | `/generate` / — / — |
| 厂商原生 | `stability` | Stability AI（multipart） | `/v2beta/stable-image/generate/core` / `/v2beta/stable-image/generate/sd3` / — |
| 厂商原生 | `dashscope-qwen-image` | 百炼 Qwen-Image 原生多模态 | `/services/aigc/multimodal-generation/generation` / 同左 / — |
| 厂商原生 | `dashscope-wanx` | 百炼通义万相（异步入队） | `/services/aigc/text2image/image-synthesis` / — / — |
| 本地部署 | `a1111` | A1111 / Forge / SD.Next / Draw Things | `/sdapi/v1/txt2img` / `/sdapi/v1/img2img` / `/sdapi/v1/sd-models` |
| 本地部署 | `comfyui` | ComfyUI（工作流） | `/prompt` / `/prompt` / `/object_info` |
| 本地部署 | `swarmui` | SwarmUI | `/API/GenerateText2Image` / — / `/API/ListModels` |
| 异步任务 | `bfl` | Black Forest Labs | 按模型拼 `/v1/{model}`（编辑同址） / — |
| 异步任务 | `fal` | fal.ai | 按模型拼（编辑同址） / — |
| 异步任务 | `replicate` | Replicate | 按模型拼（编辑同址） / — |
| 异步任务 | `modelscope` | 魔搭 ModelScope | `/v1/images/generations` / 同左 / — |

`openai-images` 唯一剩下的协议级选项存在 `provider.protocolOptions` 里，**没写 = 默认**：

| 选项 | 取值 | 含义 |
|---|---|---|
| `edit` | `edits`（默认）/ `same` / `none` | 编辑走 `/images/edits`、走同一个 generations、或没有编辑端点 |

鉴权方式是**提供商自己的字段** `provider.auth`（客户端下拉在任何协议下都显示），**没写 = 回落到该协议的默认值**。下拉的第一项「跟随协议」就是「没写」：选它等于不落 `provider.auth`，请求时按协议自己的默认形态走：

| `mode` | 请求头 | 说明 |
|---|---|---|
| `bearer` | `Authorization: Bearer <key>` | 多数服务；协议没声明默认形态时的兜底 |
| `api-key` | `api-key: <key>` | Azure 一类 |
| `x-key` | `x-key: <key>` | BFL 一类 |
| `fal-key` | `Authorization: Key <key>` | fal |
| `custom` | `<header>: <prefix><key>` | 自定义，填 `header`（如 `X-API-Key`）与 `prefix`（可空） |
| `none` | 无 | 无需密钥的本地或云端接口 |
| `basic` | `Authorization: Basic <base64>` | 在凭据框输入 `username:password` |
| `query` | `?<name>=<key>` | 填查询参数名 `name`，值仍由凭据服务提供 |

协议收敛前的 9 个旧 id 在读取配置时自动改写（`presetId`、`modelOptions`、模型规则、尺寸/质量与锁原样保留），落盘一律是新写法：

| 旧 id | 合并为 | 协议级选项 / 鉴权方式 |
|---|---|---|
| `dall-e-3` | `openai-images` | 全默认 |
| `gpt-image` | `openai-images` | 全默认 |
| `together` | `openai-images` | `edit: none` |
| `localai` | `openai-images` | `edit: none` |
| `siliconflow` | `openai-images` | `edit: same` |
| `volcengine-ark` | `openai-images` | `edit: same` |
| `azure-openai` | `openai-images` | `auth.mode: api-key` |
| `xai-imagine` | `openai-images` | `edit: none` |
| `zhipu` | `openai-images` | `edit: none` |

老配置里协议级的 `protocolOptions.auth`（只有 `bearer` / `api-key` 两个值）在读入时迁到 `provider.auth.mode`，写回只写 `provider.auth`，同层的 `edit` 原样保留。

协议下拉默认只列常用四条（`openai-images` / `openai-chat` / `openai-responses` / `google-gemini`），其余收在「更多协议…」里，按通用 / 兼容网关 / 厂商原生 / 本地部署 / 异步任务分组展开。

交互形态都覆盖：

- **同步**：一次请求直接返回图片
- **异步入队**：提交后拿到 `task_id` / `polling_url` / `status_url`，轮询到成功再下载；百炼万相、BFL、fal、Replicate、魔搭五家的提交与状态词都收在适配器的 `async` 描述符里
- **通用兜底自动识别**：自定义 API 和不认识的域名走 `openai-images`，它会自己判断——响应里直接有图就同步返回；有 `task_id`、`poll_url`、`status_url`、`urls.get`、`Location` 之类的任务信号就转轮询。轮询地址优先用响应给的，没给就按常见约定推 `/v1/tasks/{id}`、`/tasks/{id}`、提交地址`/{id}`，前一个 404/405 自动换下一个；状态词认 `SUCCEEDED` / `SUCCESS` / `COMPLETED` / `READY` 和 `FAILED` / `ERROR` / `CANCELED` 等，图出现在 `output_images`、`images`、`data`、`output`、`result` 里都能取到。所以接入新的异步厂商时，通常只要在「自定义模型 API」里填地址、Key 和模型 ID，不用再加适配器。

**识别协议**：设置页「API 协议」下拉右侧的按钮。判定分三步，能不发请求就不发：

1. **静态判定（0 请求）**：地址或模型名能静态匹配到某条协议（例如百炼 Qwen-Image 的主机）就直接给结论；地址命中已知的 OpenAI 兼容主机表（OpenAI 官方、Azure、Together、硅基流动、火山方舟含 `/api/plan/v3`、xAI、智谱、Fireworks、Novita、DeepSeek、MiniMax 两个域名）时直接判 `openai-images`，并按主机带回协议选项与鉴权方式（如方舟的 `edit:'same'`、Azure 的 `auth.mode:'api-key'`）。ComfyUI / A1111 / SwarmUI 没有可静态识别的主机名，只能靠下面的探测表。
2. **客户端逐条探测**：其余地址只返回一份**探测顺序**，设置页按顺序一条条问宿主；每发一条之前就把「正在尝试访问 /xxx…」写进提示——进度是真的，不是假轮播。
3. **命中即停**：哪条路径回来的形状能证明某个协议就停；全都不中才落到「自定义」，并预填三条相对地址，提示里带上最后试过的路径。

探测表一条协议一行，路径直接取自协议的 `routes.models`（不在探测逻辑里另抄一份）：

| 探针（只发 GET） | 期望返回 | 命中 |
|---|---|---|
| `/object_info` | 200 + JSON 对象 | `comfyui` |
| `/sdapi/v1/sd-models` | 200 + 数组 | `a1111` |
| `/API/ListModels` | 200 + JSON 对象 | `swarmui` |
| `/models` | `{ data: […] }` | `openai-images`（同形状还可能是 `openai-chat` / `openai-responses` / `openrouter-images`，通用那条优先） |
| `/models` | `{ models: […] }` | `google-gemini` |

顺序按地址决定：内网地址（回环 / `10.*` / `192.168.*` / `172.16-31.*` / `.local` / 单标签主机名）先试本地三条、最后才试 `/models`；公网地址反过来，先 `/models`、再试本地三条——所以 `https://comfy.example.com` 这种公网自托管的 ComfyUI 也认得出。公网最坏 4 个请求。

探测**只发 GET、绝不触发生成**；单个探针 15 秒超时（浏览器那次请求 20 秒），没有整轮预算；认证失败、超时、非 JSON 都只当「不是它」，不会打断识别。

如果用户已经在下拉里**手选了某条协议**，这个按钮改成**只校验不改写**：宿主只回答「这个地址像不像它」（`verified`），通过了提示「已确认」，没通过就说「地址不像 X；看起来像 Y」（`suggested`，采纳与否由用户自己点下拉决定）——协议与协议级选项一律保持原样，绝不会因为一次误判把能用的本地配置改成别的协议。没有模型端点的协议（Recraft / Ideogram / Stability / BFL / fal / Replicate）没法用只读探针验证，静态没认出来时只报告「不像」。

**尺寸控件跟着模型变**：选择器的「尺寸」面板按当前模型能接受什么渲染——收宽高就给两个输入框（`wh`）、只收宽高比就给比例下拉加档位下拉（`aspect`）、只认档位/固定像素表就给尺寸下拉加「自定义」（`preset`）、完全不收尺寸参数就给宽高输入框并把尺寸写进提示词（`prompt`）。自动尺寸复选框仍在上方；**严格**复选框始终可用，自动尺寸下模型自己填了 `size` 时同样生效。

**严格模式**：开启后成品尺寸一定等于请求尺寸——上游出大了就缩、出小了就放大（会注明画质有损），比例不符时先按居中裁切再缩，绝不拉伸。工具结果同时给 `size`（成品）和 `generated`（上游原始尺寸）；缩过图时上游那张原图会留在同一目录（文件名加 `-original`），结果的 `original` 指向它，缩放失败也会明说并保留原图。档位型模型（如方舟的 `2K`）的档位只是参考值，官方并不保证像素，这种情况下严格模式不缩，只回报真实尺寸。

**尺寸被拒不再自动改大**：上游报「尺寸超限/非法」时直接失败，并把该模型的合法范围写进错误（白名单、档位名，或像素/单边/倍数约束）。白名单吸附与像素夹取仍然保留——它们是把你的尺寸落成该模型真正接受的尺寸，和「偷偷换一个更大尺寸再试」不是一回事。

**选择器里的尺寸页**：比例、档位、预设都和选模型一样是「点开一页、选完回来」的二级页，不再用原生下拉；预设里选「自定义」后宽高才可改。

### 模型选项面板

每个模型行末尾的折叠箭头打开该模型的选项。方框按协议分两组：

- **ComfyUI / A1111**：只有「常规」参数表（外加各自的 `enum` 方框）。ComfyUI 在表前多一块自定义工作流（JSON 文本框 + 「插入示例模板」+「解析工作流」/「解析参数」），参数行由解析产生、不显示「添加参数」；A1111 第一次展开时按内置六行 sdapi 参数预置。尺寸与质量写在 workflow / sdapi 参数里，所以没有尺寸 / 质量 / 参考图块。
- **其它协议（非 ComfyUI / A1111，含云端、中转、自定义、SwarmUI）**：`常规`、`模型`、各 `enum` 方框，再加 `尺寸`、`质量`、`参考图`。从预设创建的提供商默认全锁，展开看到的是锁而不是一排空输入；「自动检测」与「全部解锁」在这一行的右端。

| 方框 | 里面有什么 | 作用 |
|---|---|---|
| **常规** | 一张五列参数表（参数名 / 类型 / 默认值 / 描述 / 操作）；ComfyUI 另带自定义工作流块 | 一行一个参数；操作列是暴露、行级锁、删除；「+ 添加参数」在表尾（ComfyUI 由解析产生行，没有这个按钮） |
| **模型** | 只有参数名与行级锁（仅「其它协议」这一组） | 模型名的落点；**不存 `expose`**（是否暴露只由选择器是不是「自动」推导），也没有删除按钮 |
| **enum 方框** | 每个 `enum` 参数单独一个框：显示名 / 值 / 默认（单选）/ 删除 | 选项表，行序就是下拉顺序；「+ 添加选项」在表尾 |
| **尺寸** | 编码方式 / 参数名 / 分隔符 / 第二个字段 | 覆盖适配器与模型族表的默认判断 |
| **质量** | 支持质量参数（总闸）、参数名、档位表 | 不勾时整块不渲染、也不发；档位表可自定义显示名与值 |
| **参考图** | 支持参考图（总闸）、字段名、传法、多图策略 | 不勾时字段模板写 `null`（显式不发）；勾上时若三层都没有模板，会补一条默认的 `image` 模板 |

**尺寸**的编码方式：`跟随默认` / `size = 宽x高` / `width + height` 两个字段 / 宽高比（可再带一个分辨率或档位字段）/ 档位名（1K、2K）/ 写进提示词。

- 参数名留空即跟随适配器与模型族表的判断；支持 `generationConfig.imageConfig.imageSize` 这种嵌套路径。
- `width + height` 的两个键名可以分别改（留空用 `width` / `height`）；`写进提示词` 形态不摆参数名（没有字段可填）。
- 分隔符只在「一个字段写宽x高」时有意义：`x`、`*`（百炼）或自定义 1–4 个可见字符。
- 第二个字段可选：把**比例**或**档位**另写一处（Gemini 的 `aspectRatio` + `imageSize` 就是这种），留空不发。

典型场景：某个中转站的 nano-banana 只认 `width`/`height`，或者把尺寸藏在 `image_size` 里——不必改代码，在模型选项里点两下就行。非官方网关也会按**模型名**给一套默认形态（名字里有 `banana` / `gemini-…image` 就按比例+档位，`seedream-5.5` 就按 1K/1.5K/2K，认不出来才是宽高；只按官方模型家族匹配，中转站自造的产品名不认），猜不准或猜错就在模型选项里覆盖——和质量档位按模型 id 模糊定位是同一套思路。

**一键配置与锁**：「模型目录」右侧的「一键配置」按规则表把**尺寸 / 质量 / 字段模板**写进每个模型（认不出的模型不写，只计入「未命中」；ComfyUI / A1111 / SwarmUI 的规则表里没有尺寸与质量，不显示这个按钮）；「高级」里的「自动检测」只重算当前这一个模型（ComfyUI / A1111 没有这一项，它们的参数来自工作流解析）。七个键（尺寸、质量、提示词、负面词、模型、张数、参考图）可以单独上锁，**锁住的键不会被一键配置与自动检测改动**，解锁后才能手填；行级锁（表格操作列里的锁）语义相同，只挡自动写入、不挡手动编辑。从预设创建的提供商默认全锁；自配网关与老配置默认不锁。一键配置写过的键会顺手锁上，避免下一次再被规则改掉；你在「质量」/「参考图」里明确取消过的，也不会被重新打开。

**常规参数表：一张表，三种落点**。对每个协议都是同一张表（参数名 / 类型 / 默认值 / 描述 / 操作），区别只在「参数名」指向哪儿：

| 协议 | 行的形状 | 参数名指向 | 怎么来 |
|---|---|---|---|
| 云端 / 中转 / 自定义 | `{ name, type, default, description, expose, options?, locked? }` | 请求体里的路径，支持 `a.b.c` 嵌套 | 手填「+ 添加参数」 |
| A1111 / Forge / SD.Next | 同上 | sdapi 字段名（`steps`、`cfg_scale`、`sampler_name`…） | 第一次展开时按内置清单摆好六行 |
| ComfyUI | 加 `node` / `input`（落在工作流节点的某个输入），`name` 只是给对话模型看的键 | 工作流里某个节点的某个输入 | 「解析工作流」自动补落点；「解析参数」把所有原始值输入列成候选，勾中即变成表行（默认值 = 当前值、类型按值推断） |

类型只有四个：`text` / `number` / `boolean` / `enum`。`enum` 行不留在主表里——它搬进自己的方框，选项表（显示名 / 值 / 默认 / 删除）就是下拉的数据源。

规则对所有落点一致：**默认值非空就随请求发送**（清空 = 不碰工作流 / WebUI 里的原值），**勾了「暴露」的对话模型才能用 `params` 覆盖**；行级锁只挡一键配置与自动检测。提示词与负面词不在这张表里——它们由工具参数 `prompt` / `negative_prompt` 直接写入，落点按解析结果自动填；要在工作流里手控落点就写 `{{prompt}}` / `{{negative_prompt}}` 占位符。给模型看的 `params` 与系统提示词也不会列它们，`note` 只回报真的用不上的键。

**错误自愈**：上游报「不认识某某参数」时摘掉该字段重试；429 / 5xx 退避重试。降级过程都会写日志，方便回头把描述符改准。

## 自定义 HTTP 接入

常规接入从「第三方模型提供商」或「本地部署」选预设，再填凭据和模型 ID。上游提供模型列表时可以直接拉取。不同模型共享同一个提供商地址和鉴权，模型自己的尺寸、质量、参数及返回格式可以单独覆盖。

自定义 API 支持配置文生图、图生图和模型列表三个端点。相对端点追加在 API 地址的路径之后，例如 Base URL 为 `https://gateway.example/api/v2` 时，`render` 指向 `/api/v2/render`。也可填写完整的 HTTP(S) 地址。生成和编辑的端点支持 `{model}` 占位符。图生图端点留空可关闭该操作。

在「请求与返回格式」中选择返回预设，或填入 JSON 配置（自定义协议）。内置协议只需要**按操作选择返回预设**——预设已覆盖这些响应形态，不再提供手写 JSON；以前手写的值会原样保留，面板里显示为「自定义（来自旧配置）」，重新选一个预设即可覆盖。模型覆盖未填写的选项会继承提供商设置。

```json
{
  "version": 1,
  "generate": {
    "method": "POST",
    "transport": "json",
    "input": "explicit",
    "fields": {
      "prompt": { "path": "input.text" },
      "model": { "path": "input.model_id" },
      "width": { "path": "input.width" },
      "height": { "path": "input.height" }
    },
    "output": {
      "kind": "task",
      "idPath": "job.id",
      "path": "/jobs/{taskId}",
      "statusPath": "phase",
      "success": ["READY"],
      "failure": ["FAILED", "CANCELLED"],
      "resultPath": "assets.0.url",
      "intervalMs": 1500
    }
  },
  "edit": {
    "transport": "multipart",
    "input": "explicit",
    "fields": { "prompt": { "multipart": "text" }, "image": { "multipart": "files[]" } },
    "output": "binary"
  },
  "models": {
    "path": "catalog",
    "method": "POST",
    "body": { "type": "image" },
    "output": { "path": "items", "idPath": "slug", "namePath": "title" }
  }
}
```

| 设置 | 含义 |
|---|---|
| `generate`、`edit` | 可选 `path` 覆盖端点，`method` 支持 GET、POST、PUT、PATCH，`transport` 支持 JSON、multipart、URL 编码表单和查询参数 |
| `input: "explicit"` | 只写入配置的字段映射与参数表中的自定义行。省略时继承现有提示词、尺寸、模型和参考图配置 |
| `fields` | 可绑定 `prompt`、`negative`、`model`、`image`、`n`、`quality`、`size`、`width`、`height`、`aspect`、`tier`。参考图映射可选择 multipart、Base64、data URL 或已有 URL |
| `headers`、`pollHeaders` | 请求和轮询需要的普通协议头。鉴权凭据通过提供商的鉴权设置传入 |
| `models` | 可选 `path` 覆盖端点。GET 使用端点的查询参数，其他方法可配 JSON `body`。自定义 `output.path` 指向列表，`idPath` 和 `namePath` 相对于列表项 |
| `pollOrigins`、`resultOrigins` | 允许携带提供商鉴权的额外 HTTP(S) 源，填写完整协议、主机和端口 |

“常规”参数表可加入可选参数，也可用 `json` 类型传数组或对象。暴露开关允许对话模型覆盖默认值。保存时请核对字段路径，避免与提示词、参考图和尺寸等已映射字段重叠。

### 返回格式预设

- `auto` 使用当前协议的默认解析。通用网关会依次查找直接图片、任务包络、Location 和常见响应字段。
- `openai`、`binary`、`image-url`、`image-base64` 分别适配 OpenAI Images 结构、二进制、顶层图片链接和顶层 Base64。
- `task-location` 从 Location 读取状态 URL。相对值以提交响应的 URL 为基准。 `task-json` 从 JSON 读任务 ID，再查询 `/tasks/{taskId}`。
- 自定义 `json` 描述符可声明字段路径、候选顺序、筛选和内容类型。自定义 `task` 描述符可声明任务 ID、状态词、轮询地址、成功后读取的路径和额外结果请求。设 `resultAs: "relative"` 可按最终响应 URL 解析图片路径。设 `pollOutput: "binary"` 可在轮询接口直接接收图片。

提供商预设由 `lib/adapters.js` 的目录下发。新的返回格式预设可加到 `lib/provider-operations.js` 中，继续使用 `lib/output-profiles.js` 的描述符校验和解析。配置支持这套声明式能力之外的协议使用专用适配器，例如需要获取会话、上传文件、刷新 OAuth 凭据或编排本地工作流的接口。

### 异常恢复

提交超时、连接中断或上游 5xx 时，若受理状态未知，工具会提示先查询原任务。已取得轮询信息的任务可以将错误中的本地任务 ID 传给 `resume_job_id`，继续原任务的查询和下载。同步接口只有在上游提供查询入口时才具备远程恢复条件。


## 已知限制

- **专用交互**：连续对话、WebSocket、动态签名和令牌自动刷新需要专用适配器。常见的 HTTP 提交、JSON 或二进制结果及异步轮询可用返回预设和操作配置接入。
- **新协议只做了 mock 验证**：`openai-responses`、`openrouter-images`、`openai-chat`、`bfl`、`fal`、`replicate`、`modelscope` 的协议形状来自 2026-11 官方文档/官方示例代码，但本机没有对应账号，未做真实连通验证。真实调用若报字段错误，请带上 `$DSH_HOME/mo-image/host.log` 反馈。
- **扩展参数**：供应商新增的请求字段可以按该接口接受的类型加入模型的参数表。预设会优先管理已映射的核心字段。
- **C 级协议未实现**：Krea、Luma Photon、Runway、腾讯混元、百度文心一格、Adobe Firefly、Gemini Interactions API 留在后续版本。
- **Google Imagen 已停用**：Gemini API 下线、Vertex 侧 2026-06-30 停服，插件不再支持；请改用 `gemini-3.1-flash-image` 等 Nano Banana 模型。
- **Vertex AI 未支持**：需要 OAuth access token（1 小时过期）且没有模型列表端点。

## 网络

请求由宿主进程发出，插件不会修改系统的网络设置。本机地址（`localhost`、`127.*`、`::1`）永远直连，本地适配器（A1111 / ComfyUI / SwarmUI / sd-server / LocalAI）不受影响。网络失败的原因会写进 `$DSH_HOME/mo-image/host.log`。

## 常见问题

**设置里没有“生图模型”**

确认插件已安装、profile 的 dsh.profile.bundles 包含 dsh-mo-image，并重启过 DSH。

**请求报 `fetch failed`，或 `网络请求失败：xxx UND_ERR_CONNECT_TIMEOUT，直连。TCP 连接超时。`**

目标域名在当前网络下连不通，不是 Key 或模型的问题。先检查本机网络、DNS 和目标服务是否可达；插件不会修改系统的网络设置。

**401 / 403**

检查 API Key 是否有效，以及 Key 和 API 地址是否属于同一平台。

**400 model**

模型 ID 不在该平台的支持列表里，替换成平台提供的模型 ID。

**图片编辑超时**

图片编辑比文生图慢，不要连续重复提交同一个请求。

## License

MIT。Codex 皮肤的几何、色板与粒子分布改编自 [dsh-codex-model-effort-selector](https://github.com/ABING1111/dsh-codex-model-effort-selector)（MIT），完整许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

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

插件启动后会从 `registry.npmmirror.com` 检查最新版本。有新版时，设置页的「生图模型」标题旁会显示「有可用更新」。点开可以查看版本号和更新说明，确认后交给 DSH 安装。镜像同步到新版本后才会显示更新提示。

更新说明来自包里的 `CHANGELOG.md`（按版本从 jsDelivr / unpkg / npmmirror 读取）；那个版本没写说明时，对话框显示「暂无更新说明」。

- 用 `link:` 方式安装的开发环境不会自动改文件，点更新只会提示你自己 `git pull`。
- 安装时会把 `registry.npmmirror.com` 作为首选源传给 DSH，并按 `dsh-mo-image@x.y.z` 安装。DSH 仍会按宿主配置处理备用源和回滚。从 npm 安装的插件由 DSH 原生更新。早期从 `github:` 安装的插件会迁移到 npm 版，迁移失败时会尝试恢复原安装。
- 使用 `dsh web` 时也可以手动更新，把 `web` 换成实际使用的 profile。

~~~bash
dsh plugin --profile web add dsh-mo-image --registry=https://registry.npmmirror.com
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
删除提供商（行右侧的红色「删除」）会先弹确认：用的是设置页那套共用的弹窗原语，标题「删除 X？」、说明里写明会移除配置并清掉已保存的 API 密钥，取消在左、红色删除在右。显示名太长时，标题与按钮里的名字会按显示宽度截断并补省略号（说明那一段仍是全名，方便确认删的是哪一个）。

「模型目录」沿用 DSH 对话模型设置页的模型行：拖动手柄（或聚焦手柄后按上下方向键）调整顺序，顺序就是选择器里的顺序；「获取可用模型」会把上游列出的模型连同显示名一起带回来，已加入列表的模型默认勾选，勾选结果就是新的模型列表。

**编辑已有提供商**与**新建**用的是同一套表单布局（同一段代码，差异用参数表达）。新建的三条入口保持各自的样子：「第三方模型提供商」是预设选择器 + API 密钥常显；「本地模型」是部署器 + 显示名称 + API 密钥常显；「自定义模型 API」把全部字段一次平铺（显示名称 → API 地址 → 密钥 → 协议设置 → 模型目录与调度模型）。**编辑已有提供商**只常显 **API 密钥**，其余字段收进默认关闭的「自定义设置」折叠区。API 协议选择「自定义」时，文生图、图生图和获取模型列表的端点紧跟在协议下方。

**从内置预设建的提供商不显示协议相关字段**：协议、鉴权与返回格式预设里已经写好了，零配置就能用，不需要人去改一个已经正确的配置。自己填地址的（「自定义模型 API」、中转站、老配置）形状未知，这一块照旧出现。判据只看来源（`presetId`），不看地址；手改 API 地址不动它——同一家提供商换个地址（反向代理、私有化部署）仍是那份预设。老配置没记来源时先按协议分组：组内只有一份就是它（本地部署器就是这样，换端口、换机器仍认得出），共用协议的那一组（`openai-images` 那 14 份）再按地址、按名称消歧；没记协议（`adapter` 为空）的则在全部预设里按地址认，地址认不出再按名称认，都唯一不了就不补。补不上时，只有「地址是预设的、协议却不是预设里的那一条」这种本该有来源的配置会在表单顶部看到红字；「自定义模型 API」入口、自定义端点和自定义协议都不提醒——它们本来就没有预设来源。以前手动改过的协议 / 鉴权 / 返回格式只是不显示，保存时原样带回。

**想改预设的字段？展开「自定义设置」，点底部的「切换为自定义API」**（按钮与「添加模型」同款、左侧带一个方向图标，排在模型目录等接入细节之后；这一块只在展开时才看得到）。点它只是翻出二次确认——提示换成黄色那句「注意：切换为自定义API为单向操作，要回到预设需要重新从目录添加。」，旁边多出「确认切换」与「取消」；第一下不碰任何字段。确认后来源才被撇掉（presetId 变空串），协议那一组、鉴权方式与模型选项随即出现；地址、协议、鉴权、模型、字段模板一律留着，动的只是「这份配置归谁管」。单向：预设选择器只在新建页有，要回到预设就重新从目录添加一份。保存之前取消，什么都没发生。切换之后表单顶部会挂一枚与列表同款的「自定义」标签（「已切换为自定义 API，保存后生效」）——列表上那一枚读的是已落盘的配置，要保存之后才变，这一枚是当场看得见的回执。

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

启用 [dsh-codex-selector](https://github.com/CM-Silence/dsh-codex-selector) 后，生图席根据 DSH 的插件状态切换为同款 Codex 皮肤：

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

工具按操作接收提示词和参考图。模型 Auto 时可从当前提供商的目录传 `model`。尺寸或质量设为 Auto 时可传 `size` 或 `quality`，固定项以选择器为准。严格尺寸模式尝试匹配明确的像素宽高。尺寸只有比例或档位，或者图片无法安全缩放时，结果会说明实际情况。

**一步确认配置**：`mo_image_settings` 返回当前模型、尺寸与质量模式、提示词优化开关和写法提示。模型设为 Auto 时，目录只在工具结果中发送一次，每个 ID 只列一次。`editModelIndexes` 是可改图模型在 `models` 中从 0 开始的位置，`all` 表示全部。传 `model` 可查询候选的实际尺寸、质量档、编辑能力和暴露参数：

```json
{"provider":"comfyui","model":"flux-2-klein-4b.safetensors","promptOptimization":true,"hint":"自然语言散文，主体+动作前置，30–80 词；英文优先；无 negative prompt"}
```

提示词优化开启时，对话模型按生图模型的写法补足粗略需求，保留主体、限制、指定语言和逐字文本。上下文已有适用的成稿或用户要求原样时直接沿用。只有缺少所需模板、示例或调参指引时才加载对应技能。关闭时沿用用户原话。插件把最终提示词随生图请求发送。

「配置状态」按会话维护。首次返回完整配置和 `revision`。后续只返回 `changes` 中有变化的字段和 `removed` 中需要清除的字段。以 `baseRevision` 对应的配置为基线，列表按字段整组替换。配置没变时返回 `unchanged:true`。如果基线已经不在上下文里，传 `refresh:true` 获取完整配置。

**配置交接**：会话首次生图或改图前读取设置。之后直接调用生图或改图工具，由 `needsSettings` 交接配置，应用后用新调用提交。距上次完整读取满 8 个宿主对话轮次，或宿主报告上下文替换或裁剪时，下一次生图或改图调用会先返回完整配置。缺少轮次接口的宿主按生图相关工具的使用次数计数。同一个调用 ID 的重放复用原交接结果。同一步内的其他调用等待交接。候选详情按提供商和模型独立记录，复用相同的增量与刷新规则。

**纠正入参**：插件在提交前发现模型、提供商或可选档位填错时，会报告「生图配置不匹配（未提交）」。对话模型收到后用 `mo_image_settings({"refresh":true})` 取回完整配置，修正参数并发起一次新调用。其他错误直接报告，已有异步任务走恢复入口。

**`model` 是可选的核对项**：不传就用用户选中的那一项（提供商 + 模型 id 一起核对，不同提供商的同名模型不算同一个），传了不一致的值直接拒绝；Auto 模式下必须从当前提供商的模型列表里挑一个。传了 `provider` 也会核对，不一致同样拒绝——工具永远不会替用户切换提供商或模型。

**Auto 行**：模型选择器第一行是“自动”（英文界面为 `Auto`）。选中后，对话模型可从工具返回的当前提供商目录中选模型。所有提供商的模型目录都为空时，选择器显示“还没有模型，去设置 → 生图模型添加”。

**配置是权限级锁定**：插件用 `ctx.tools.guard()` 注册了全局工具守卫，任何工具调用只要目标是 `mo-image/config.json` 或 `/api/mo-image/config`（写文件、shell 命令、HTTP 请求都算），都会在执行前被拒绝，而不是靠提示词"请求"模型别改。守卫只看目标字段，不会误伤正文里出现同样字符串的插件源码编辑。它挡不住刻意混淆的 shell 命令（base64、字符串拼接），真正的硬边界仍然是宿主是否给该 Agent 开 shell。

**图片读取**：默认不读生成图，也不描述画面；只有用户明确要求"看看这张图"时才允许读。

## 质量档位

质量档位由「当前模型」决定，宿主通过 `/api/mo-image/config` 的 `capabilities` 下发。模型不支持质量参数时，原版皮肤隐藏质量行，Codex 皮肤固定显示满格 Ultra，滑块不可调。这个 Ultra 只影响显示。模型选为「自动」时，只要当前提供商有支持质量的候选，仍可选择质量档位。Codex 皮肤的尺寸从齿轮进入，提示词优化用左上角星标切换。GPT-Image 的 `Auto` 是模式而不是画质档，滑条里紧挨着 `Off` 放，不排到最高档。

| 模型族 | 质量行 | 选项 |
|---|---|---|
| OpenAI GPT-Image | 显示 | Off / Auto / Low / Medium / High |
| OpenAI DALL·E 3 | 显示 | Off / Standard / HD |
| Ideogram 3 | 显示 | Off / Turbo / Default / Quality |
| Ideogram 4.5 / 4.6 | 显示 | 4.5 提供 Low / Medium / High，4.6 另有 Very Low |
| Google Gemini / Nano Banana | 隐藏 | 只有尺寸/比例，没有 quality |
| xAI Grok Imagine | 隐藏 | 当前预设使用上游默认质量，可选择分辨率 |
| Recraft | 隐藏 | 没有 quality |
| Stability AI | 隐藏 | 没有 quality |
| Together AI | 隐藏 | 没有 quality |
| Fireworks / Novita | 隐藏 | 取决于网关；默认不显示 |
| 智谱 BigModel | 显示 | GLM-Image 只支持 HD。CogView-4、CogView-4-250304 和 CogView-3-Flash 提供 Standard / HD |
| SiliconFlow / 火山方舟 / 百炼 | 隐藏 | 没有统一的 quality 参数 |
| A1111 / ComfyUI / SwarmUI / 本地 OpenAI 兼容 | 隐藏 | 没有统一 quality；用各自的 steps/cfg |

切换模型时，选择器会从目标模型的档位里选一个合法默认值；旧配置里的 `max`、`high` 等值会收敛到目标模型支持的最近档位（例如 GPT-Image 的 `max` → `High`），不会再由对话模型填 `Max`。

模型选项的「质量」方框可以覆盖这张表的判断：勾上 / 取消「支持质量参数」、改参数名（支持 `a.b.c` 嵌套路径）或自定义档位表，都能让一个模型从「隐藏」变成可选，或反过来明确「这个模型不发质量参数」。一键配置不会重新打开你明确关掉的质量开关。

依据：[OpenAI Images API](https://platform.openai.com/docs/api-reference/images/create)（GPT-Image 的 `low/medium/high/auto`、DALL·E 3 的 `standard/hd`）、[Ideogram 3 API](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3)（`rendering_speed`）和[智谱图像生成 API](https://docs.bigmodel.cn/api-reference/模型-api/图像生成)（`quality`）。Gemini、xAI、Recraft、Stability、Together、本地后端没有统一的官方 quality 字段，所以隐藏质量行。

## 提示词优化

生图模型选择器里新增「提示词优化」，默认 **On**（原版皮肤在首页一栏；Codex 皮肤是弹层左上角由三颗四角星组成的 AI 星标，悬停显示 Codex 两行卡片「提示词优化 / 用量更多」）：

- **On**：保持现在的行为，按当前模型的提示词方言扩写/整理 prompt。
- **Off**：要求模型尽量把用户原话直接传给生图工具，不扩写、不补风格/光线/构图，也不自动补 negative prompt；只有用户明确说“优化/改写提示词”时才优化。
- 提示词优化影响 `prompt` 的写法。是否允许对话模型调整模型、尺寸或质量，分别由选择器对应的 Auto 开关决定。
- 设置会写进 `config.json` 的 `defaults.promptOptimization`，默认 true；旧配置没有这个字段时按 On 处理。
- 提示词优化和生图技能是分开的：生图/改图时仍会加载 `mo-image-generation` / `mo-image-editing` 技能获取调用与输出规则；Off 只跳过技能里的公式和模板。
- 工具描述和系统提示词会同时提示 Off 语义；编辑时同样使用用户原话或最小必要的修改说明。

## 数据

新生成的图片保存在当前会话工作区：

~~~text
<cwd>/generated-images/
~~~

`<cwd>` 优先使用 DSH 会话的当前工作目录，也适用于切换过目录或使用 worktree 的会话。宿主未提供当前目录时使用会话的初始目录。只有拿不到会话目录（例如非会话调用）时才回退到：

~~~text
$DSH_HOME/mo-image/out/
~~~

聊天里新生成的图片使用本地文件绝对路径，支持本地图片菜单的 DSH 客户端可以通过宿主读取原图、复制图片并在桌面文件夹中定位。找不到会话目录，或图片超过宿主的本地预览上限时，使用签名预览。

登录 DSH 后，旧聊天中的 `/api/mo-image/preview/<basename>` 和签名预览链接都可用。HMAC 签名 key 保存在 `$DSH_HOME/mo-image/preview.key`，因此签名链接在宿主重启后仍然有效。

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
| **OpenAI Responses** | `openai-responses` | 手动/获取 | 官方新版 `image_generation` 工具；需要填「调度模型」 |
| **OpenRouter** | `openrouter-images` | `google/gemini-3.1-flash-image`、`openai/gpt-image-2.5-flare`、`black-forest-labs/flux.2-pro` | 专用 `/api/v1/images`；生成 + `input_references` 参考图 |
| **Azure OpenAI** | `openai-images`（`auth.mode: 'api-key'`） | 你的部署名 | `api-key` 鉴权；`model` 填部署名 |
| **Microsoft Foundry (MAI-Image)** | 声明式 HTTP | 你的 MAI-Image 部署名 | 使用 `/mai/v1` 和 `api-key`。生成使用宽高像素，编辑通过 multipart 上传最多五张 JPEG / PNG 参考图 |
| **Black Forest Labs** | `bfl` | `flux-2-pro`、`flux-2-max`、`flux-3-image`、`flux-kontext-pro` | 异步队列；生成 + FLUX.2/FLUX 3 参考图 |
| **fal.ai** | `fal` | `fal-ai/flux-2-pro`、`fal-ai/flux-pro/kontext` | 按生成、单图编辑和多图编辑选择端点，队列完成后读取 `response_url` |
| **Replicate** | `replicate` | `black-forest-labs/flux-2-pro` | 异步队列；按模型 schema 决定输入字段 |
| **魔搭 ModelScope** | `modelscope` | `Qwen/Qwen-Image-2.1`、`Qwen/Qwen-Image-Edit` | 异步任务；提交带 `X-ModelScope-Async-Mode`，轮询 `/v1/tasks/{id}` |
| **xAI Grok Imagine** | `openai-images`（`edit:'none'`） | `grok-imagine-image-2.0` | 预设提供文生图，使用 `aspect_ratio` 和 `resolution` |
| **Recraft** | `recraft` | `recraftv4_1`、`recraftv4`、`recraftv3`、`recraftv2` | 文生图。V3、V4、V4.1 的兼容模型支持单张参考图编辑 |
| **Ideogram** | `ideogram` | `ideogram-3`、`ideogram-4`、`ideogram-4-5`、`ideogram-4-6`、`ideogram-4-transparent` | 4.5/4.6 使用 `size` 和 `quality`，支持文生图和 1–5 张参考图编辑。旧模型按各自协议文生图 |
| **Stability AI** | `stability` | `core`、`sd3.5-large` | Core 支持文生图，SD3.5 支持文生图和单图编辑（multipart） |
| **Together AI** | `openai-images`（`edit:'none'`） | `black-forest-labs/FLUX.1-schnell`、`FLUX.1-dev` | 原生 width/height 请求；生成 |
| **Fireworks AI** | 声明式 HTTP | `flux-1-schnell-fp8` | FLUX.1 Schnell FP8 专用端点，读取二进制图片 |
| **Novita AI** | 声明式 HTTP | `flux-1-schnell` | FLUX.1 Schnell 专用端点，下载响应中的图片链接 |
| 自定义 / 新网关 | `openai-images` | 手动/获取 | 同步或异步自动识别（见下文） |
| 火山方舟 | `openai-images`（`edit:'same'`） | 手动/获取 | 生成；档位按模型分（5.x 是 `1K/1.5K/2K`，lite 是 `2K/3K/4K`，4.5 是 `2K/4K`），也收任意宽高 |
| 火山方舟 Agent Plan | `openai-images`（`edit:'same'`） | 手动/获取 | 与火山方舟同协议，基础地址换成 `/api/plan/v3` |
| 阿里云百炼 · Qwen-Image | `dashscope-qwen-image` | `qwen-image-3.0-pro`、`qwen-image-3.0` | 原生多模态同步接口 |
| 阿里云百炼 · 通义万相 | `dashscope-wanx` | `wan2.6-t2i`、`wan2.7-image-pro`、`wan2.7-image`、`wanx2.1-t2i-turbo` | 按模型选择异步接口，Wan 2.7 支持参考图 |
| 硅基流动 | `openai-images`（`edit:'same'`） | 手动/获取 | 生成 + 单图编辑 |
| 智谱 BigModel | `openai-images`（`edit:'none'`） | `glm-image`、`cogview-4`、`cogview-4-250304`、`cogview-3-flash` | 只支持文生图。拉取列表找不到时可手动填写模型 ID |
| **MiniMax**（国际站 `api.minimax.io`） | `openai-images` | `MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed` | H3-Image 就是 OpenAI Images 形状（生成 + `/images/edits` 收 1–16 张参考图）；`aspect_ratio` + `area`（`1K/2K/4K`），不发 `size` |
| MiniMax 中国 | `openai-images` | `MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed` | 同一套接口，基础地址换成 `api.minimax.cn`（现行官方域名） |

说明：

- 原生 Google Gemini 使用 `x-goog-api-key` 头，尺寸写入 `generationConfig.imageConfig`。3.1 Flash Image 支持 `512/1K/2K/4K` 档位。自定义网关按实际选用的协议和输入设置组装请求。
- 型号规则允许模型 ID 带厂商前缀、日期或发布后缀。实际请求使用原样 ID，尺寸和字段仍以所选协议为准。
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
| LocalAI | `openai-images`（`edit:'none'`） | `http://127.0.0.1:8080/v1` | `/v1/models` | 预设提供生成。LocalAI 的局部编辑接口需要蒙版 |
| AUTOMATIC1111 / Forge / SD.Next / Draw Things | `a1111` | `http://127.0.0.1:7860` | `/sdapi/v1/sd-models` | 生成 + `/sdapi/v1/img2img` |
| ComfyUI | `comfyui` | `http://127.0.0.1:8188` | `/object_info`（CheckpointLoaderSimple + UNETLoader） | 生成 + 编辑；内置工作流按模型自动选，也可粘自定义工作流 |
| SwarmUI | `swarmui` | `http://127.0.0.1:7801` | `/API/ListModels` | 生成；原生编辑暂不支持 |
| 其他 OpenAI 兼容网关 | `openai-images` | `http://127.0.0.1:3000/v1` | `/v1/models` | 取决于网关；异步任务自动轮询 |

说明：

- 本地服务没有鉴权时，**API 密钥可以留空**；`optionalKey` 会让宿主不发送 `Authorization`。需要 Bearer token 的服务再填密钥。
- 本地模型表单的字段顺序是 **本地部署器 → 显示名称 → API 密钥 →（「自定义设置」里的）API 地址 → 模型目录**：地址与模型目录都跟着部署器来（选完就填好了，模型目录是「这台机器装了哪些 checkpoint」），常显只会让人以为还得核对一遍；真要改（反向代理、换端口、换模型清单）展开那个折叠区就行。
- 「模型目录」右侧的 **获取可用模型** 对第三方提供商、自定义模型 API 和本地部署器都可用：点击后先向端点探测模型，再弹出可搜索、可全选/取消全选的候选列表，只有点「添加所选」才写入当前表单。OpenAI 兼容接口返回的结果会先筛掉可能不是用于生图的模型，也可以勾选「显示全部模型」；没有模型列表 API 的适配器不显示这个按钮。ComfyUI 列出的是 checkpoint 与 `UNETLoader` 里的 diffusion 模型名，A1111 列出的是 `sd-models` 的 title。
- 选择第三方提供商后，「提供商」标签右侧会出现 **前往提供商官网**，按当前选择打开官方 API Key / 控制台页面；本地和自定义模式不显示这个链接。
- A1111 / Forge / SD.Next 启动时需要加 `--api`。启用了 `--api-auth` 时，在 A1111 预设填 `用户名:密码`。新建预设默认用 HTTP Basic，未启用鉴权时可留空。已有配置可在高级设置里选 HTTP Basic，或继续使用反向代理所需的鉴权方式。A1111 的 img2img 使用第一张参考图。
- ComfyUI 的**内置工作流按模型自动选**：模型在 `UNETLoader` 列表里就按 diffusion 模型走（FLUX.2 用 `UNETLoader` + `CLIPLoader` + `VAELoader` + `SamplerCustomAdvanced`，MOSS-Image 用 MOSS 的编码器与编辑 LoRA），否则按 checkpoint 用 `CheckpointLoaderSimple + KSampler`（SD1.5/SDXL）。编辑也有内置路径：checkpoint 走 `VAEEncode` + img2img（`denoise 0.6`），FLUX.2 走 `ReferenceLatent`，MOSS 走 `TextEncodeMOSSImageEdit`。
- 想换工作流就把 ComfyUI「导出（API）」的 JSON 粘进模型选项；UI 格式的 JSON 也认（插件用 `/object_info` 转成 API 格式，缺节点会点名报错）。工作流与参数表的配合见下面的「ComfyUI 工作流与参数表」。
- SwarmUI 使用 `/API/GetNewSession` + `/API/GenerateText2Image`，原生编辑暂未实现。
- InvokeAI、Fooocus、复杂 ComfyUI 工作流：先套一层 OpenAI Images 网关，再选「其他 OpenAI 兼容网关」。
- 本地服务通常要自己启动、管理显存和模型；插件不负责下载/加载模型。工具超时是 360 秒，CPU 跑 1024×1024 可能超时。
- 参考图限制：multipart 编辑总大小 48MB、单张 15MB；JSON `image` 编辑为了控制 base64 峰值，总大小限制 10MB。生成图响应上限 32MB，超大图请降低尺寸。
- 参考图编辑优先用本地文件路径；参考图 URL 指向 `127.0.0.1` 会被 SSRF 防护拦住，需要 `MO_IMAGE_ALLOW_PRIVATE_REFS=1`。

**ComfyUI 工作流与参数表**

- 工作流优先级：模型选项里的自定义工作流 > 内置模板（按模型自动选，见上）。自定义工作流支持 `{{prompt}}` / `{{negative_prompt}}` / `{{width}}` / `{{height}}` / `{{seed}}` / `{{model}}` / `{{image}}` 七个占位符，占位符之外的部分原样发送。
- 「解析工作流」自动映射提示词、宽高、可识别的质量档位和唯一的参考图输入。尺寸和质量统一在模型选择器里调整，设为「自动」后可由对话模型选择。未指定时保留工作流已有的值。
- 多参考图工作流可把图像输入设为 `{{image_1}}`、`{{image_2}}` 等，从 1 连续编号，最多 16 张。把对应节点命名为「主体图」「风格图」等，插件会把用途交给对话模型，按编号顺序传图。同一编号可在多个节点复用，`{{image}}` 仍代表第一张。未标记的图片保留原值。
- API 格式中接入输出链路的标准 `LoadImage` 可直接用于图生图。自定义节点的上传控件由「解析工作流」根据 ComfyUI 节点定义识别。没有可用参考图入口时，插件会在上传和提交前拒绝图生图。
- `steps`、`cfg`、`sampler_name`、`denoise`、种子等工作流参数保留在「常规」参数表里，默认沿用工作流原值。
- 参数表才是运行时真正写工作流的东西：默认值非空的行随请求写入；清空默认值 = 不碰工作流里的原值；勾了「暴露」的行才出现在给对话模型的参数清单里。行级锁只挡一键配置，不挡手改。
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

是否发送独立的 `negative_prompt` 由协议和模型决定。稳定扩散、硅基流动和万相 2.6 等模型支持独立字段，万相 2.7 把要避免的内容合并进提示词。

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
| `quality` | 该模型是否有质量档位、档位名称和数量，以及如何映射成平台参数（如 DALL·E 的 `standard/hd`、Ideogram 的 `rendering_speed`）。仅支持质量的模型可调档 |
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
| 厂商原生 | `dashscope-wanx` | 百炼通义万相（异步入队） | 旧版走 `/services/aigc/text2image/image-synthesis`，Wan 2.6/2.7 走 `/services/aigc/image-generation/generation` |
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

鉴权方式是提供商字段 `provider.auth`，未保存时使用协议默认值。自定义协议、未识别的协议和 A1111 部署提供鉴权选择。换协议时，旧协议的鉴权与响应覆盖会一并清除。

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

**没选协议 = 不发请求**。下拉最上面的「未选择」只是当前状态（一个不可选的占位项，不叫「自动」）：协议决定路径、字段名和响应解析，空着的时候宿主不猜也不发。以前它会拿协议表最后一条 `openai-images` 兜底，所以一个 Gemini 或百炼原生地址也能「成功」发出一个全错的请求。现在这种配置在设置页保存会被拦下（并说明原因），工具调用则直接报「还没有选择 API 协议」；要做的只是选一条，或点右侧的「识别协议」。

**自愈**：协议只要说得出来，就不会停在「未选择」。读取配置时，老配置里 `protocol` 写着具体协议 id 的迁到 `adapter`；有预设来源（`presetId`）的按预设取——协议级选项一起来了（火山方舟 Agent Plan 的 `edit: 'same'` 就是这种），用户自己写过的选项优先。补完立刻写回 `config.json`，一次修好，之后读它不再重写。地址和名称都对不上任何预设、又没有 `presetId` 的（真正自己填的网关），才保持「未选择」。

交互形态都覆盖：

- **同步**：一次请求直接返回图片
- **异步入队**：提交后拿到 `task_id` / `polling_url` / `status_url`，轮询到成功再下载；百炼万相、BFL、fal、Replicate、魔搭五家的提交与状态词都收在适配器的 `async` 描述符里
- **通用兜底自动识别**：选了 `openai-images` 的提供商（兼容网关大多选它）会自己判断——响应里直接有图就同步返回；有 `task_id`、`poll_url`、`status_url`、`urls.get`、`Location` 之类的任务信号就转轮询。轮询地址优先用响应给的，没给就按常见约定推 `/v1/tasks/{id}`、`/tasks/{id}`、提交地址`/{id}`，前一个 404/405 自动换下一个；状态词认 `SUCCEEDED` / `SUCCESS` / `COMPLETED` / `READY` 和 `FAILED` / `ERROR` / `CANCELED` 等，图出现在 `output_images`、`images`、`data`、`output`、`result` 里都能取到。所以接入新的异步厂商时，通常只要在「自定义模型 API」里填地址、Key 和模型 ID，不用再加适配器。

**识别协议**：设置页「API 协议」下拉右侧的按钮（只在自己填地址的提供商上出现——预设提供商的协议是已知的，那一块整块不显示）。判定分三步，能不发请求就不发：

1. **静态判定（0 请求）**。已知地址或模型名可以匹配协议，例如百炼 Qwen-Image。已知 OpenAI Images 主机可带回协议与鉴权默认值，例如方舟的 `edit:'same'` 和 Azure 的 `auth.mode:'api-key'`。ComfyUI、A1111 和 SwarmUI 走下面的读取探测。
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

**严格模式**：有明确像素宽高时，插件会在支持的格式和像素范围内将成品缩放到目标。比例不符时先居中裁切，再缩放或放大。结果分别给出 `size`（成品）和 `generated`（上游原始尺寸），缩放成功后 `original` 指向另存的上游原图。只有比例或档位时会保留实际像素。缩放失败或超时时也会保留原图，并注明实际尺寸。

**尺寸被拒不再自动改大**：上游报「尺寸超限/非法」时直接失败，并把该模型的合法范围写进错误（白名单、档位名，或像素/单边/倍数约束）。白名单吸附与像素夹取仍然保留——它们是把你的尺寸落成该模型真正接受的尺寸，和「偷偷换一个更大尺寸再试」不是一回事。

**选择器里的尺寸页**：比例、档位、预设都和选模型一样是「点开一页、选完回来」的二级页，不再用原生下拉；预设里选「自定义」后宽高才可改。

### 模型选项面板

每个模型行末尾的折叠箭头打开该模型的选项。**预设来源的提供商箭头照旧在，只是禁用**（云端预设，以及走 OpenAI 兼容字段的本地预设 sd-server / localai / openai-gateway）：预设定死了输入与返回，箭头禁用表示「这里本来有东西，只是这份配置不由你改」——删掉它反而会让列表里有的行有箭头、有的没有，看着像漏渲染。剩下两类才真能展开：

- **ComfyUI / A1111 / SwarmUI**：参数归部署端（装了哪个 sampler、模型目录里有哪几个 checkpoint、工作流里有哪些节点），所以留「输入设置」。ComfyUI / A1111 使用「常规」参数表和枚举方框。ComfyUI 的参数行由工作流解析产生，尺寸和支持的质量档位通过模型选择器写入工作流。A1111 第一次展开时显示六行预置的 sdapi 参数。
- **自配的（没有预设来源：自定义 API、中转站、老配置）**：`常规`、`模型`、各 `enum` 方框，再加 `尺寸`、`质量`、`参考图`——请求形状未知，只能用户自己定。

**两块折叠区的标题行**：「输入设置」与「输出设置」是同一行结构（两块 details 直接挂在模型行上、同一份内联样式，中间不套容器；标题在左、操作区在右），左边一条基线、右边一条基线，右端的控件落同一条竖线。自配来源和相应的本地部署可同时显示两块。云端预设使用内置请求与返回格式。右端各只放一个控件或一对控件：输入那行是「一键配置」（按钮样式与模型目录的「获取可用模型」是同一个 `linkButton`）加一把整块锁（与输出那行的锁同一个图标按钮），输出那行是锁图标。展开「输入设置」后第一眼就是参数表——原来那条「说明 + 全部解锁」的工具条整行删掉了。

**锁**：预设来源已经没有面板，所以锁现在只剩「用户自己按上去」这一种用法——按了就不让「一键配置」改写这个键。老配置里早就写下的覆盖不会因为看不见被丢掉，保存时原样带回。

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

兼容网关按所选协议和已知的接口规则发尺寸。Gemini / Nano Banana 的原生比例与档位配置只用于 `google-gemini` 协议。网关要求 `width` / `height`、`image_size` 或其他字段时，可以在模型的「输入设置」中覆盖。

从 Gemini 原生协议切换到 OpenAI Images 后，插件会识别并清理旧版一键配置留下的原生提示词和尺寸组合。单独设置的 `aspect_ratio` 等网关映射仍然生效。如需恢复默认尺寸字段，在「输入设置 → 尺寸」解锁，选择「跟随默认」并清空尺寸参数名，再保存。

**一键配置与锁**：三条入口共用同一个动作——「输入设置」标题行那颗只配这一个模型，「模型目录」右侧的「一键配置所有模型」对列表每一项各跑一次，从「获取可用模型」采纳新模型之后也会对刚加进来的那些自动跑一次。它按规则表把**尺寸 / 质量 / 字段模板**写进模型。**「认得出」= 规则表里有这个模型的专门规则**：质量规则、字段模板规则，或者一条**不是兜底**的尺寸规则——只知道尺寸怎么发的模型（`doubao-seedream-5-5`、`flux-2-flex` 这类）也算认得出，否则它连自己认识的尺寸都写不进去。兜底那条 `.*`（OpenAI 兼容发 `size`）匹配一切，所以**不算**认得出，否则每个模型都会被算成命中。没有专门规则的模型不写、也不锁，提示里会说明「按协议默认发送」；ComfyUI / A1111 / SwarmUI 的规则表里没有尺寸与质量，不给这个按钮）。八个键（尺寸、质量、提示词、负面词、模型、张数、参考图、返回格式）可以单独上锁，**锁住的键不会被一键配置改动**，解锁后才能手填；「输入设置」标题行那把整块锁一次锁上 / 解开全部输入键，行级锁（表格操作列里的锁）语义相同，只挡自动写入、不挡手动编辑。从预设创建的提供商默认全锁；自配网关与老配置默认不锁；**ComfyUI / A1111 / SwarmUI 的输入键默认不锁**（参数清单由部署端决定：装了哪个 sampler、模型目录里有哪几个 checkpoint，预设给不了映射），返回格式仍按预设来源锁——sd-server / localai / openai-gateway 走 OpenAI 兼容字段，和云端预设一样全锁。一键配置配好一个模型后会把它的**整块输入设置锁上**（七个输入键一次到位，返回格式那个键不动）——配好了就定了，要手改先解锁，否则下一次一键配置又按规则盖回去；没命中规则的模型不锁，下次还会重试；你在「质量」/「参考图」里明确取消过的，也不会被重新打开。

**常规参数表：一张表，三种落点**。对每个协议都是同一张表（参数名 / 类型 / 默认值 / 描述 / 操作），区别只在「参数名」指向哪儿：

| 协议 | 行的形状 | 参数名指向 | 怎么来 |
|---|---|---|---|
| 云端 / 中转 / 自定义 | `{ name, type, default, description, expose, options?, locked? }` | 请求体里的路径，支持 `a.b.c` 嵌套 | 手填「+ 添加参数」 |
| A1111 / Forge / SD.Next | 同上 | sdapi 字段名（`steps`、`cfg_scale`、`sampler_name`…） | 第一次展开时按内置清单摆好六行 |
| ComfyUI | 加 `node` / `input`（落在工作流节点的某个输入），`name` 只是给对话模型看的键 | 工作流里某个节点的某个输入 | 「解析工作流」自动补齐映射和可选工作流参数 |

类型只有四个：`text` / `number` / `boolean` / `enum`。`enum` 行不留在主表里——它搬进自己的方框，选项表（显示名 / 值 / 默认 / 删除）就是下拉的数据源。

规则对所有落点一致：**默认值非空就随请求发送**（清空 = 不碰工作流 / WebUI 里的原值），**勾了「暴露」的对话模型才能用 `params` 覆盖**；行级锁只挡一键配置。提示词与负面词不在这张表里——它们由工具参数 `prompt` / `negative_prompt` 直接写入，落点按解析结果自动填；要在工作流里手控落点就写 `{{prompt}}` / `{{negative_prompt}}` 占位符。给模型看的 `params` 与系统提示词也不会列它们，`note` 只回报真的用不上的键。

**错误自愈**：上游报「不认识某某参数」时摘掉该字段重试；429 / 5xx 退避重试。降级过程都会写日志，方便回头把描述符改准。

## 自定义 HTTP 接入

常规接入从「第三方模型提供商」或「本地部署」选预设，再填凭据和模型 ID。上游提供模型列表时可以直接拉取。不同模型共享同一个提供商地址和鉴权，模型自己的尺寸、质量、参数及返回格式可以单独覆盖。

自定义 API 支持配置文生图、图生图和模型列表三个端点。相对端点追加在 API 地址的路径之后，例如 Base URL 为 `https://gateway.example/api/v2` 时，`render` 指向 `/api/v2/render`。也可填写完整的 HTTP(S) 地址。生成和编辑的端点支持 `{model}` 占位符。图生图端点留空可关闭该操作。

云端预设由协议解析返回值。本地预设沿用部署器的解析方式，模型级「输出设置」默认锁定，可解锁为自定义工作流或部署修改返回格式。「输入设置」仍用于自配来源及 ComfyUI、A1111、SwarmUI 等由部署端决定的输入参数。

「自定义模型 API」提供协议和返回格式控件。API 协议为「自定义」时，填写了端点的文生图或图生图操作须选择返回预设，或选「自定义 JSON」并参考 OpenAI Images 示例填写输出描述符。模型默认继承提供商的返回格式，也可单独覆盖。请求体里的 `output_format` 一类字段控制上游图片编码，操作的 `output` 描述插件如何从响应里取图。

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
| `input: "explicit"` | 使用固定 `body`、已配置的字段映射与参数表自定义行。省略时继承现有提示词、尺寸、模型和参考图配置 |
| `body` | 该操作固定发送的 JSON 字段，例如 `output_format` 或嵌套的选项对象。运行时映射可填入同一对象。模型填写 `body` 时替换对应操作的提供商默认值 |
| `fields` | 可绑定 `prompt`、`negative`、`model`、`image`、`n`、`quality`、`size`、`width`、`height`、`aspect`、`tier`。参考图映射可选择 multipart、Base64、data URL 或已有 URL |
| `headers`、`pollHeaders` | 请求和轮询需要的普通协议头。鉴权凭据通过提供商的鉴权设置传入 |
| `models` | 可选 `path` 覆盖端点。GET 使用端点的查询参数，其他方法可配 JSON `body`。自定义 `output.path` 指向列表，`idPath` 和 `namePath` 相对于列表项 |
| `pollOrigins`、`resultOrigins` | 允许携带提供商鉴权的额外 HTTP(S) 源，填写完整协议、主机和端口 |

“常规”参数表可加入可选参数，也可用 `json` 类型传数组或对象。暴露开关允许对话模型覆盖默认值。保存时请核对字段路径，避免与提示词、参考图和尺寸等已映射字段重叠。

### 返回格式预设

- 不写（或写 `auto`）就是当前协议的默认解析：通用网关会依次查找直接图片、任务包络、Location 和常见响应字段。下拉里不再有这一项——没选过时显示的就是协议默认那一档。
- `openai`、`binary`、`image-url`、`image-base64` 分别适配 OpenAI Images 结构、二进制、顶层图片链接和顶层 Base64。
- `task-location` 从 Location 读取状态 URL。相对值以提交响应的 URL 为基准。 `task-json` 从 JSON 读任务 ID，再查询 `/tasks/{taskId}`。
- 自定义 `json` 描述符可声明字段路径、候选顺序、筛选和内容类型。自定义 `task` 描述符可声明任务 ID、状态词、轮询地址、成功后读取的路径和额外结果请求。设 `resultAs: "relative"` 可按最终响应 URL 解析图片路径。设 `pollOutput: "binary"` 可在轮询接口直接接收图片。

### 新增预设

复用已有协议时，在 `lib/adapters.js` 的 `PROVIDER_PRESETS` 或 `LOCAL_PRESETS` 增加一条记录。常规 OpenAI Images 接口可以使用 `{ id, name, baseUrl, adapter: 'openai-images' }`。按需加入默认模型、鉴权和字段覆盖。宿主会自动发布该记录并根据适配器计算模型列表能力，目录测试也会自动检查它。

请求路径或响应有差异的 HTTP 接口可在同一条预设记录里声明 `operations`，Fireworks 和 Novita 是两个实例。已有解析器能表达的新返回值，可在 `lib/provider-operations.js` 的 `OUTPUT_PRESETS` 增加描述符。会话握手、令牌自动刷新等新协议行为仍需要相应适配器。

Fireworks 和 Novita 的旧配置可以重新从目录添加新版预设以采用新端点。 [Fireworks 官方接口](https://docs.fireworks.ai/api-reference/generate-a-new-image-from-a-text-prompt) · [Novita 官方接口](https://novita.ai/docs/api-reference/model-apis-flux-1-schnell)

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

MIT。Codex 皮肤的几何、色板与粒子分布改编自 [dsh-codex-model-effort-selector](https://github.com/ABING1111/dsh-codex-model-effort-selector)（MIT）。项目和第三方许可见 [LICENSE](LICENSE)。

# dsh-mo-image 版本自检与自助更新

日期：2026-11-08
状态：待实现

## 意图

插件装上之后就不再被想起了。用户不知道上游有没有新版本，作者也不知道自己修的问题有没有真正到达用户手里。这个设计要让两件事同时发生：DSH 启动时顺手问一下 npm 和 GitHub，有新版就在设置页里亮一个按钮；用户点进去能看到这次改了什么，再点一下就装好，重启生效。

同时补上发版这一环：一个脚本负责版本号、tag、GitHub Release 和（可选的）npm 发布，让"新版本"这件事在仓库里成为一条可以被机器读取的事实。

## 目标

- 宿主每次启动自动检查一次新版本，失败静默，不打扰用户。
- 设置 → 生图模型页的标题行右侧出现"有可用更新"按钮（仅在有新版时出现）。
- 点开是一个居中对话框：版本号、固定高度可滚动的更新说明、取消 / 更新。
- 点"更新"后后台安装，底部气泡提示开始与完成；完成后按钮消失，提示重启生效。
- 发版脚本一条命令完成 bump / 测试 / tag / push / GitHub Release，可选用 `--publish` 同时发布 npm。

## 非目标

- 不做聊天界面里的更新提示（只在设置页）。
- 不做自动下载、自动重启；重启永远由用户决定。
- 不为 `link:` / `github:` 安装做自动更新或自动迁移（只给提示）。
- 不改 DSH 自身的插件市场或插件管理器行为。
- 不做"检查失败后自动重试"或后台定时轮询；一次启动一次检查，外加 12 小时的会话内刷新。

## 约束

- 更新检查只在宿主侧发起。浏览器不直连 GitHub 或 npm，避免 CORS、避免把任何令牌暴露给页面。
- 出站请求必须走现有的 `lib/net.js`（它会自动识别系统代理），失败只写宿主日志，不冒泡到 UI。
- 客户端只读宿主下发的状态，不自己判断版本高低。
- 插件现有的样式复用方式（运行时解析 CSS Modules 前缀）保持不变。
- **所有新文案都要走 i18n**：字符串进 `locale/messages.csv`（`zh/en/ja/es/fr/de/ru/pt` 八列，任何一列不能为空），再 `npm run build:locales` 重新生成 `lib/client.js` 里的字典块。`test/client-i18n.test.mjs` 会拒绝字典块之外的 CJK 字面量，`test/locales.test.mjs` 会拒绝 CSV 里没有的 `t()` key。发版脚本的预检就是 `npm test`，所以这条不是建议。已有 `locale/` 与 `scripts/build-locales.mjs`，本次只是追加 key。
- 带 profile 的宿主（desktop 与 web）默认启用 HMR，更新流程必须按“插件会在中途被卸载”来设计。

## 版本与更新内容从哪来

- **当前版本**：宿主读取自己的 `package.json`。
- **最新版本**：`GET https://registry.npmjs.org/dsh-mo-image/latest`，只取 `version`。npm registry 体积小、可镜像（npmmirror），比 GitHub API 稳。**这意味着发布到 npm 是更新检测的前提**。
- **更新内容**：`GET https://api.github.com/repos/CM-Silence/dsh-mo-image/releases/latest`，取 `tag_name`（须等于 `v<latest>`）、`body`（markdown）与 `html_url`。tag 对不上时再试 `/releases/tags/v<latest>`；两者都取不到（被墙、限流、没写 Release）时，对话框只显示版本号与"在 GitHub 查看更新说明"链接，不阻断更新动作。
- 版本比较实现一个最小的 semver 比较（不需要引入依赖）：只有 `latest > current` 才认为有更新；预发布版本按 semver 的预发布规则排序；当前版本比 latest 还新（本地 link 开发）时视为无更新。

## 检查时机

- 宿主 `apply()` 时异步检查一次，不阻塞启动。
- 结果在内存中缓存，含 `checkedAt`。
- 设置页每次挂载时向宿主读状态；若缓存超过 12 小时则触发一次后台刷新。
- 检查结果只留在内存里，不落盘；DSH 重启即有新结果。（更新过程另有标记文件，见“自我更新带来的新问题”。）

## 交互设计

### 1. 标题行按钮

设置 → 生图模型 页顶部那行标题（当前是 `<h2>` 标题 + 说明文字）改成一行 flex：左侧标题，右侧按钮。
按钮仅在 `state === 'available'` 时渲染，文案为"有可用更新"（走 `t()`），样式对齐 DSH 自己的更新胶囊（小号、圆角、品牌蓝文字与描边，28px 高）。

### 2. 对话框

- 左上角标题"有可用更新"，右上角关闭按钮（×）。
- 标题下一行版本号：`0.3.1 → 0.4.0`。
- 正文：Release 的 markdown，渲染在一个固定高度（约 320px）的滚动区里，窗口不随内容变高。
- 底部右侧两个按钮："取消"（次要）、"更新"（主要）。
- 关闭方式：×、取消、Esc、点击遮罩。
- markdown 用最小实现即可：标题、无序/有序列表、粗体、行内代码、链接、段落。不引入依赖，不执行 HTML。

### 3. 更新过程

- 点"更新"→ 对话框立即关闭 → 立刻弹一条底部气泡"正在更新 dsh-mo-image…"。宿主收到请求后先在本地做好一切准备（写标记文件），**约 0.8 秒后才真正调用 `updateBundle`**，让这条气泡有时间被看见——随后插件就会被卸载，气泡也会一起消失，这是正常的。
- 更新落定后的那条气泡由“标记文件 + 当前版本号”判断得出，而不是等某次调用返回（见下一节）：
  - 成功：本次进程里插件被重新加载 → "更新已完成，重启 DSH 后生效"；如果是重启之后才首次加载（标记里的 `startedAt` 早于本次进程启动）→ 只说"已更新到 0.4.0"。
  - 失败：`current` 仍是旧版本且标记超过 90 秒 → "更新未完成，请重试"。
  - 成功时按钮消失；失败时按钮恢复可点，原因写宿主日志。
- 气泡复用 DSH 的 `Toast` 组件（`@deepseek-ai/dsh-client-ui-primitives` 导出，props 为 `text`/`tone`/`icon`/`onDone`），挂在客户端插件的 `shell.overlay` 贡献上，因此离开设置页也仍能看到结果。
- 失败时对话框不自动重开；用户再点按钮可以重试。

## 更新怎么执行

宿主侧调用 DSH 的 `pluginManager` 服务（`ctx.get('pluginManager')`，本轮已在运行中的宿主上确认存在）：

```
listBundles(): BundleInfo[]                    // installed、source、updatable
async updateBundle(name, version, options?)    // → { from, to, step, result, restore? }
```

1. **能不能自动更新**：`listBundles()` 里该包 `updatable === true` 才走 `updateBundle`。这个标志由 DSH 判定——第三方、以 registry spec 安装、manifest 里有 semver、且不带插件管理。发布到 npm 并用 `dsh plugin add dsh-mo-image` 装过之后才是 true；`link:` 和 `github:` 安装都不是。
2. **不能更新时**：“更新”按钮照常可点，点完弹一条气泡把该敲的命令告诉用户（本地开发 → `git pull`；git 安装 → README 里"迁到 npm 安装"那条命令），并保持对话框关闭。
3. **执行**：`updateBundle('dsh-mo-image', latest, { requestId })`。HMR 下它会先卸载旧版本再装新版本，装失败会把旧版本装回去。
4. **结果**：`result.result.application` 为 `applied` / `restart-required` 算成功；`failed` / `cancelled` 算失败，错误码翻成中文。
5. 非桌面版没有 `pluginManager` 服务：检查照做、按钮照显示，点“更新”提示用命令行安装。

**为什么不顺手把 `github:` 安装迁到 npm**：已核实，HMR 打开时 `installBundle` 只解析 spec 里的包名，只要有同名依赖就抛 `already-installed`，与版本号、spec 形式无关。所以 git 安装的用户这一版拿不到一键更新，只能按提示重装一次（README 里补一条命令）。人工迁移不在本次范围内。

### 自我更新带来的新问题

HMR 开着的时候，`updateBundle` 的第一步就是把我们这个包卸掉——发起更新的插件实例会在更新中途被停掉，它的 HTTP 路由消失，`await` 的结果多半回不来。所以完成状态不能靠这次调用的返回值，只能事后重新判断：

- 点“更新”时宿主先写 `$DSH_HOME/mo-image/update.json`：`{ requestId, from, to, startedAt }`，再发起 `updateBundle`，并立刻向客户端回 `{ ok: true }`。
- 更新结束后（HMR 重组装上新版本，或用户重启），客户端插件一加载就主动查一次状态，不必等用户打开设置页；宿主把版本号与标记一比即得出结论。
  - `current === to` → 成功，弹“更新已完成，重启 DSH 后生效”，删标记。
  - `current === from` 且标记超过 90 秒 → 视为失败，弹“更新未完成，请重试”，删标记，宿主日志留一条。
- 没有 HMR 时调用会正常返回，宿主把真实结果写进标记，客户端下一次轮询即可读到。

**已核实**：带 profile 的宿主默认开 HMR，`updateBundle` 的第一步就是 `removeBundle` + 重载，所以上面这条不是理论风险；`~/.dsh/mo-image/` 已经在写 `out/` 与 `host.log`，可写性没有问题。

## 宿主接口

单一路由 `/api/mo-image/update`，复用现有的 `assertLocalRequest` 与 `sendJson`。

`GET` 返回：

```json
{
  "ok": true,
  "state": "idle|checking|available|updating|done|failed|unsupported",
  "current": "0.3.1",
  "latest": "0.4.0",
  "notes": "markdown 或空串",
  "url": "https://github.com/CM-Silence/dsh-mo-image/releases/tag/v0.4.0",
  "checkedAt": "2026-11-08T09:00:00.000Z",
  "updatable": true,
  "source": "^0.3.1",
  "message": "失败时的中文说明"
}
```

- `state`：`idle | checking | available | updating | done | failed | unsupported`
- `updatable` / `source`：直接来自 `listBundles()`，客户端据此决定点“更新”后是执行还是提示
- `notes`：markdown，取不到时为空串，客户端只显示版本号与链接

`POST` body `{ "action": "apply", "version": "0.4.0" }`：立即返回 `{ ok: true }`，安装在后台继续；客户端每 1.5 秒轮询 `GET`，直到状态落定。轮询期间要容忍连接失败与 404——插件自己正在被替换，路由会短暂消失。

## 发版流程

新增 `scripts/release.mjs`，由 `npm run release -- <minor|patch|major|x.y.z>` 调用。

步骤：

1. 预检：工作树干净、当前分支是 `master`、测试通过（`node --test`）。
2. 按参数推高 `package.json` 版本。
3. `git commit -m "chore(release): v<version>"`。
4. 打 annotated tag `v<version>`。
5. `git push` 与 `git push --tags`。
6. 带 `--publish` 时 `npm publish`；失败就停在这里，不建 Release（tag 已推，修好后单独补发即可）。
7. 创建 GitHub Release：正文默认取自上次 tag 以来的提交（按 `feat`/`fix`/`docs`/`chore` 分组，中文小标题），也可用 `--notes "..."` 或 `--notes-file <path>` 覆盖。

**没有发到 npm 的版本不会提示任何用户**——更新检查读的是 npm，这是有意的：只有真正发布出去的版本才值得打扰用户。所以“先打 tag 观察、稳定了再 `npm publish --otp`”也是可行的用法，只是中间这段时间更新按钮不会亮。

其他开关：`--dry-run`（只打印将要做的事）。

凭据：本机 `gh` CLI 已登录则用 `gh release create`；否则读环境变量 `GITHUB_TOKEN` 调 REST API。`npm publish` 用本机 npm 登录态或 `NPM_TOKEN`。

硬约束：tag 名必须等于 `v` + `package.json` 版本；脚本拒绝重复的 tag 与已发布的版本。

## 发布到 npm 需要的清单改动

- `peerDependencies` 里的 `@deepseek-ai/cordis` 改为 `peerDependenciesMeta` 标记 `optional: true`（参照 `dsh-bili-scroll`），避免 pnpm 装出第二份 cordis。
- 补 `repository` / `homepage` / `bugs` / `keywords`（`dsh`、`dsh-plugin`、`deepseek-harness`）与 `publishConfig: { access: "public", registry: "https://registry.npmjs.org/" }`。
- `files` 已包含 `lib`、`skills`、`cordis.patch.yml`、`README.md`，无需改动。
- 包名 `dsh-mo-image` 目前未被占用。

## 边界与降级

| 情况 | 行为 |
|---|---|
| 没网 / npm 不可达 | 静默，无按钮；只写宿主日志 |
| npm 通、GitHub 不通 | 按钮照显示，对话框只有版本号与链接 |
| `updatable === false`（`link:`、`github:` 安装） | 按钮照显示；点更新弹气泡给出对应命令，不动文件 |
| 非桌面版（无 pluginManager 服务） | 点更新提示用命令行安装 |
| 更新中插件被卸载（HMR 打开） | 页面轮询容忍断连；新实例读标记后决定成功/失败气泡 |
| 重复点击更新 | 客户端禁用按钮；宿主侧用 requestId 去重 |
| 已更新但未重启 | 标记已删，本次会话不再提示；重启后按新版本号判断 |
| 当前版本高于 npm 最新 | 视为无更新 |

## 验收标准

1. 本地把 `package.json` 版本改低、npm 上有更高版本时，启动 DSH 后设置页出现按钮。
2. 断网启动不报错、不出现按钮、宿主日志有一条可读的失败原因。
3. 按钮点开可见版本号与可滚动的更新说明；Esc、遮罩、×、取消都能关闭。
4. 在 npm 安装的 profile 上点“更新”，能看到开始气泡；更新落定后（HMR 重组或重启）看到完成气泡，版本号确实变了。
5. 在 `link:` 安装的 profile 上点“更新”，只得到“请自行 git pull”的提示，仓库文件未被改动。
6. `node scripts/release.mjs --dry-run patch` 打印出的步骤与实际执行一致；`--publish` 缺省时不碰 npm。
7. `npm test` 全绿（含 i18n 的两条：字典块与 CSV 一致、没有字典块外的中文字面量）。

### 没有已发布版本时怎么验收

1、4 需要 npm 上真有一个更高版本。在拿到之前，检查逻辑通过“可注入的 registry / GitHub 基址”来验证：`lib/update.js` 的检查函数接受 `{ registryBase, githubBase }`，测试里起一个本地 HTTP 服务模拟 `…/latest` 与 `…/releases/latest` 的响应，覆盖“有新版 / 无新版 / 404 / 超时 / 非法 JSON”五种情况。真实发布与真机更新由作者在发第一版后走一遍。

## 留给建造者的决定

- 对话框用 DSH primitives 的 `Modal` 还是自绘浮层（以视觉效果贴近 DSH、代码量小为准）。
- 气泡的具体放置与动画，跟随 `Toast` 组件自身行为。
- 版本比较与 markdown 渲染放在哪个文件（建议 `lib/update.js`，host 侧，便于单测）。
- 更新过程中的轮询间隔与超时上限。
- 多个浏览器标签页同时开着时，完成气泡是否要在每个标签页都弹一次（还是用 localStorage 去重）。

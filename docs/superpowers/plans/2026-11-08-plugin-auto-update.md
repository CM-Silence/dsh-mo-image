# dsh-mo-image 自动检测更新与发版脚本 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 插件启动时检查 GitHub 上是否有新 Release，有就在设置页标题行右侧亮一个按钮；点开能看到版本号与更新说明，点"更新"后用 pnpm 换成新 tag，重启生效；另加一个发版脚本负责 bump / tag / Release。

**架构：** 宿主侧的 `lib/update.js` 只做纯函数（版本比较、来源分类、标记判定、拉 Release），`lib/update-service.js` 持有状态并调用 `pluginManager.installBundle`，`lib/index.js` 只负责挂一条 `/api/mo-image/update` 路由和启动时的预热检查。客户端在设置页标题行渲染按钮与对话框，并在 `shell.overlay` 上挂一个气泡宿主；更新时插件会被 HMR 卸载，所以完成状态靠 `~/.dsh/mo-image/update.json` 标记 + 当前版本号事后判定。

**技术栈：** 原生 ESM、Node 22 `node:test`、React（DSH 提供的模块加载器）、DSH Host Service（`webServer`、`pluginManager`）、`@deepseek-ai/dsh-client-ui-primitives`（`Modal`、`Toast`）、`locale/messages.csv` + `scripts/build-locales.mjs`。

**规格：** `docs/superpowers/specs/2026-11-08-plugin-auto-update-design.md`（执行者两份都读）

## 全局约束

- 仓库根目录：`F:\FastPath\project\agent\plugin\dsh-mo-image`；所有命令在此目录运行。
- 不引入任何运行时依赖，`package.json` 的 `dependencies` 保持为空。
- 所有用户可见文案必须进 `locale/messages.csv`（`key,zh,en,ja,es,fr,de,ru,pt` 九列，八种语言都不许空），改完跑 `npm run build:locales`；`test/client-i18n.test.mjs` 会拒绝生成块之外的 CJK 字面量。
- 宿主侧新增代码用中文注释，与 `lib/index.js` 现有风格一致；缩进 2 空格；ESM。
- 网络请求一律走 `lib/net.js` 的 `request(url, init)`，不要直接用 `fetch`（它负责系统代理）；测试里通过参数注入假实现，不要在模块里写死。
- 新增的宿主文案（错误/提示）用 `localizedError(error, code, params)` + `errorBody(error)` 传 `code`，让客户端按当前语言翻译；不要新增只有中文的接口字段。
- 每个任务结束时 `node --test` 必须全绿；提交用英文 conventional commit。
- 不要改动 `lib/adapters.js`、`lib/prompt-profiles.js` 与 `skills/**`。

## 审查重点（Review Focus）

| 输入/条件 | 人期待的行为 | 钉住它的测试 |
|---|---|---|
| api.github.com 与 github.com 都不可达（断网/被墙） | 启动不报错、设置页安静、日志里有一条可读原因 | 任务 2 `refresh` 失败用例 |
| `update.json` 被写坏或只写了一半（更新中进程被杀） | 当作没有标记，正常显示"有可用更新" | 任务 1 `readMarker` 坏 JSON 用例 |
| 用户连点两次"更新"，或开了两个标签页 | 只执行一次安装；第二次看到"更新中" | 任务 2 `apply` 去重用例 |
| 用户已经手动更新到更高版本，磁盘上还留着旧标记 | 不弹"已更新到 0.4.0"，标记要被清掉 | 任务 1 `judgeMarker` 的 `current` 既非 from 也非 to 用例 |
| Release 正文含花括号、超长、只有一行 | 对话框正常渲染、`t()` 插值不炸、不执行 HTML | 任务 1 `fetchLatestRelease` 原样保留正文 + 任务 4 渲染用例 |

---

### 任务 1：`lib/update.js` 纯函数

**文件：**
- 创建：`lib/update.js`
- 测试：`test/update.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/update.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  compareVersions, tagToVersion, classifySource, judgeMarker,
  readMarker, clearMarker, fetchLatestRelease
} from '../lib/update.js';

test('compareVersions orders releases, prereleases and junk', () => {
  assert.equal(compareVersions('0.3.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('0.4.0', '0.3.9'), 1);
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0'), -1);
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0-rc.2'), -1);
  assert.equal(compareVersions('nope', '0.4.0'), null);
});

test('tagToVersion strips the v prefix and rejects non versions', () => {
  assert.equal(tagToVersion('v0.4.0'), '0.4.0');
  assert.equal(tagToVersion('0.4.0'), '0.4.0');
  assert.equal(tagToVersion('v0.4.0-rc.1'), '0.4.0-rc.1');
  assert.equal(tagToVersion('nightly'), '');
  assert.equal(tagToVersion(''), '');
});

test('classifySource separates local links from installable specs', () => {
  assert.equal(classifySource('link:F:/repo/dsh-mo-image'), 'link');
  assert.equal(classifySource('file:C:\\repo'), 'link');
  assert.equal(classifySource('github:CM-Silence/dsh-mo-image'), 'git');
  assert.equal(classifySource('git+https://github.com/CM-Silence/dsh-mo-image.git'), 'git');
  assert.equal(classifySource('https://github.com/CM-Silence/dsh-mo-image/archive/refs/tags/v0.4.0.tar.gz'), 'tarball');
  assert.equal(classifySource(undefined), 'unknown');
  assert.equal(classifySource(''), 'unknown');
});

test('judgeMarker decides done, updating and failed from the current version', () => {
  assert.deepEqual(judgeMarker(null, '0.3.1', 1000), { state: 'none' });
  const marker = { from: '0.3.1', to: '0.4.0', startedAt: 1000 };
  assert.deepEqual(judgeMarker(marker, '0.4.0', 2000), { state: 'done', to: '0.4.0' });
  assert.deepEqual(judgeMarker(marker, '0.3.1', 2000), { state: 'updating', to: '0.4.0' });
  assert.deepEqual(judgeMarker(marker, '0.3.1', 1000 + 90_001), { state: 'failed', to: '0.4.0' });
  assert.deepEqual(judgeMarker(marker, '0.5.0', 2000), { state: 'done', to: '0.4.0' });
});

test('readMarker treats broken json as absent and clearMarker removes the file', (t) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'mo-update-')), 'update.json');
  t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
  assert.equal(readMarker(file), null);
  writeFileSync(file, '{', 'utf8');
  assert.equal(readMarker(file), null);
  writeFileSync(file, JSON.stringify({ from: '0.3.1', to: '0.4.0', startedAt: 1 }), 'utf8');
  assert.equal(readMarker(file).to, '0.4.0');
  clearMarker(file);
  assert.equal(readMarker(file), null);
});

test('fetchLatestRelease reads the api, falls back to the redirect, else null', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/repos/CM-Silence/dsh-mo-image/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v0.4.0', body: '- 修复：{braces}\n- 新增', html_url: 'u1' }));
      return;
    }
    if (req.url === '/CM-Silence/dsh-mo-image/releases/latest') {
      res.writeHead(302, { location: '/CM-Silence/dsh-mo-image/releases/tag/v0.4.0' });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const viaApi = await fetchLatestRelease({ apiBase: base, releasesBase: base, request: fetch });
  assert.equal(viaApi.version, '0.4.0');
  assert.equal(viaApi.notes, '- 修复：{braces}\n- 新增');
  assert.equal(viaApi.via, 'api');

  const viaRedirect = await fetchLatestRelease({ apiBase: `${base}/missing`, releasesBase: base, request: fetch });
  assert.deepEqual(viaRedirect, { version: '0.4.0', notes: '', url: `${base}/CM-Silence/dsh-mo-image/releases/tag/v0.4.0`, via: 'redirect' });

  const none = await fetchLatestRelease({ apiBase: `${base}/x`, releasesBase: `${base}/y`, request: fetch });
  assert.equal(none, null);
});
```

补齐 import：`node:fs`（`mkdtempSync`、`writeFileSync`、`rmSync`）、`node:os`、`node:path`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/update.test.mjs`
预期：FAIL，`Cannot find module '../lib/update.js'`

- [ ] **步骤 3：实现 `lib/update.js`**

导出（签名固定）：

```js
export function compareVersions(a, b)                     // -1 | 0 | 1 | null
export function tagToVersion(tag)                         // 'v0.4.0' -> '0.4.0'，无效返回 ''
export function classifySource(source)                    // 'link' | 'git' | 'tarball' | 'unknown'
export function judgeMarker(marker, currentVersion, now, ttlMs = 90_000)  // { state, to? }
export function readMarker(file)                          // object | null
export function writeMarker(file, marker)                 // 原子写：先写 .tmp 再 rename
export function clearMarker(file)                         // 文件不存在也不抛
export async function fetchLatestRelease(options)         // { version, notes, url, via } | null
export const REPO = 'CM-Silence/dsh-mo-image';
```

`fetchLatestRelease` 的 `options`：`{ apiBase = 'https://api.github.com', releasesBase = 'https://github.com', request, timeoutMs = 8000 }`。先请求 `${apiBase}/repos/${REPO}/releases/latest`，取 `tag_name`/`body`/`html_url`；失败或 `tagToVersion` 为空时，再请求 `${releasesBase}/${REPO}/releases/latest` 且 `redirect: 'manual'`，从 3xx 的 `location` 里用 `/(?:^|\/)tag\/(v[^/?#]+)/` 抠出 tag；两条都失败返回 `null`。任何异常都吞掉并返回 `null`。`via` 标记来源。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/update.test.mjs`
预期：PASS（6 个用例）

- [ ] **步骤 5：Commit**

```bash
git add lib/update.js test/update.test.mjs
git commit -m "feat: add release comparison helpers for auto-update"
```

---

### 任务 2：`lib/update-service.js` 状态服务

**文件：**
- 创建：`lib/update-service.js`
- 测试：`test/update-service.test.mjs`

- [ ] **步骤 1：编写失败的测试**

覆盖五件事，用假的 `request` / `pluginManager` / 临时目录：

```js
function makeService(overrides = {}) // 组装 createUpdateService
test('refresh turns a newer release into available', ...)
```

断言写成：

```js
const service = makeService({ currentVersion: '0.3.1', request: async () => releaseResponse('v0.4.0', '- 新') });
await service.refresh();
assert.deepEqual(
  (({ state, current, latest, notes, url, installable }) => ({ state, current, latest, notes, url, installable }))(service.status()),
  { state: 'available', current: '0.3.1', latest: '0.4.0', notes: '- 新', url: 'https://github.com/CM-Silence/dsh-mo-image/releases/tag/v0.4.0', installable: true }
);
```

其余用例的断言：

```js
// refresh failure stays idle and logs
await service.refresh();                     // request 抛错
assert.equal(service.status().state, 'idle');
assert.ok(logs.some((line) => line.includes('update check failed')));

// apply installs the tagged git spec and writes a marker
const out = await service.apply('0.4.0');
assert.deepEqual(out, { ok: true });
assert.equal(calls.length, 1);
assert.equal(calls[0].spec, 'github:CM-Silence/dsh-mo-image#v0.4.0');
assert.equal(typeof calls[0].options.requestId, 'string');
assert.equal(readMarker(file).to, '0.4.0');
assert.equal(readMarker(file).from, '0.3.1');

// apply refuses local link installs
const local = makeService({ listBundles: async () => [{ name: 'dsh-mo-image', source: 'link:F:/repo/dsh-mo-image' }] });
assert.deepEqual(await local.apply('0.4.0'), { ok: false, code: 'update.localDev' });
assert.equal(calls.length, 0);

// apply falls back to removeBundle on already-installed
installBundle.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'already-installed' }));
await service.apply('0.4.0');
assert.deepEqual(removed, ['dsh-mo-image']);
assert.equal(calls.length, 2);

// hydrate reports done once and clears the marker
writeMarker(file, { from: '0.3.1', to: '0.4.0', startedAt: 1 });
const done = makeService({ currentVersion: '0.4.0' });
await done.hydrate();
assert.equal(done.status().state, 'done');
assert.equal(done.status().updatedBeforeRestart, true);   // startedAt 早于进程启动
assert.equal(readMarker(file), null);
await done.hydrate();
assert.equal(done.status().state, 'idle');

// apply is idempotent while an install is in flight
const slow = makeService({ installDelayMs: 20 });
const first = slow.apply('0.4.0');
const second = slow.apply('0.4.0');
await Promise.all([first, second]);
assert.equal(calls.length, 1);
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/update-service.test.mjs`
预期：FAIL，`Cannot find module '../lib/update-service.js'`

- [ ] **步骤 3：实现 `lib/update-service.js`**

```js
export const UPDATE_SPEC = (version) => `github:CM-Silence/dsh-mo-image#v${version}`;
export function createUpdateService(options) // -> { status, refresh, apply, hydrate, ack, dispose }
```

`options`：`{ currentVersion, markerFile, request, pluginManager, log, now = Date.now, sleep, installDelayMs = 800, apiBase, releasesBase }`。

状态机：`idle | checking | available | updating | done | failed`。`status()` 返回 `{ state, current, latest, notes, url, checkedAt, installable, source, updatedBeforeRestart, error }`；`updatedBeforeRestart` 只在 `done` 时有意义，等于"标记的 `startedAt` 早于本进程启动时刻"（进程启动时刻用模块加载时的 `Date.now()` 记下）。`installable` 由 `pluginManager.listBundles()` 里本包的 `source` 经 `classifySource` 得出（`link` → false，其余 true；拿不到 bundle 时按 true）。`refresh()` 做单飞去重，写 `checkedAt`，失败只 `log('update check failed: ...')`。`apply(version)`：忙时直接返回 `{ ok: true }`；先 `writeMarker({ from, to, startedAt, requestId })`，把状态置 `updating`，`await sleep(installDelayMs)` 后调 `pluginManager.installBundle(UPDATE_SPEC(to), { requestId, enabled: true })`；`already-installed` 时先 `removeBundle('dsh-mo-image')` 再试一次；成功时把 `result.result.application` 写进状态（`applied`/`restart-required` → `done`），失败置 `failed` 并保留 `error`。`hydrate()`：读标记 → `judgeMarker` → `done` 时置状态并删标记，`failed` 时置状态并删标记，`updating` 时置 `updating`。`ack()`：把 `done`/`failed` 收回 `available` 或 `idle`，避免下一次拉取重复弹气泡。`dispose()` 清掉进行中的定时器与状态。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/update-service.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add lib/update-service.js test/update-service.test.mjs
git commit -m "feat: add update service with marker-based completion"
```

---

### 任务 3：宿主路由与启动预热

**文件：**
- 修改：`lib/index.js`（`apply()` 内新增 service 与路由；`apply` 增加可选第二参数 `options`）
- 修改：`test/plugin-apply.test.mjs:85-86`（路由数从 3 变 4）
- 创建：`test/update-route.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// test/update-route.test.mjs：复用 config-route 的 fake ctx 写法
test('the update route reports status and starts an install', async (t) => {
  // fake webServer 收集 routes；fake pluginManager.listBundles 返回 [{ name:'dsh-mo-image', source:'github:CM-Silence/dsh-mo-image' }]
  // 传 apply 的第二参数：{ update: { fetch: fakeFetch, installDelayMs: 0 } }
  const mod = await import('../lib/index.js?update-route-test');
  mod.apply(fake, { update: { fetch: fakeFetch, installDelayMs: 0 } });
  const route = routes.find((item) => item.path === '/api/mo-image/update');
  assert.ok(route);
  // GET：先返回 ok:true 且带 current；等待预热检查完成后再次 GET → state 'available'
  // POST { action:'apply', version:'0.4.0' } → 200 { ok:true }，随后 installBundle 被调用一次
});
```

同时把 `test/plugin-apply.test.mjs` 的断言改成 4 条路由，路径集合加入 `/api/mo-image/update`，并给该文件的 `apply` 调用加 `{ update: { skipCheck: true } }`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/update-route.test.mjs test/plugin-apply.test.mjs`
预期：FAIL，`route` 为 undefined / 路由数量 3

- [ ] **步骤 3：实现路由与预热**

在 `apply(ctx, options = {})` 里：

1. 用 `options.update` 覆盖项组装 `createUpdateService({ currentVersion: <读 package.json>, markerFile: path.join(stateDir(), 'update.json'), request, pluginManager: ctx.get && ctx.get('pluginManager'), log: logHost, ...options.update })`。
2. `ctx.effect(() => { const timer = setTimeout(() => { service.hydrate().then(() => service.refresh()); }, options.update?.startupDelayMs ?? 5000); timer.unref?.(); return () => { clearTimeout(timer); service.dispose(); }; }, 'mo-image: update check')`；`options.update?.skipCheck` 时只建服务不排定时器。
3. 挂 `kind: 'exact', path: '/api/mo-image/update'`：
   - `GET`：`assertLocalRequest(store, req, false)`，返回 `sendJson(res, 200, { ok: true, ...service.status() })`；若 `checkedAt` 为空或距今超过 12 小时，顺带调一次 `service.refresh()`（不 `await`，失败由服务自己记日志）。
   - `POST`：`assertLocalRequest(store, req, true)`，`readBody(req)`，`action === 'apply'` 且 `version` 是字符串时调 `service.apply(version)`，返回 `sendJson(res, 200, { ok: true })`；其他 action 返回 400。

当前版本读取：`JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version`，放在 try/catch 里，失败时用 `'0.0.0'` 并记日志。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/update-route.test.mjs test/plugin-apply.test.mjs`
预期：PASS

- [ ] **步骤 5：运行全量测试**

运行：`npm test`
预期：全部通过（注意观察是否有测试因为预热检查而变慢；如有，确认那些测试的 `apply` 调用都带了 `{ update: { skipCheck: true } }`）

- [ ] **步骤 6：Commit**

```bash
git add lib/index.js test/update-route.test.mjs test/plugin-apply.test.mjs
git commit -m "feat: serve auto-update status from the host"
```

---

### 任务 4：文案与客户端状态层

**文件：**
- 修改：`locale/messages.csv`（追加 key）
- 修改：`lib/client.js`（生成块由脚本重写；新增状态拉取与 `__test` 纯函数）
- 修改：`test/client-i18n.test.mjs`（若新增的 key 需要补动态 key 断言，按现有样式追加）
- 创建：`test/client-update.test.mjs`

- [ ] **步骤 1：在 `locale/messages.csv` 末尾追加以下 key（八种语言都要填，`{...}` 占位符各语言保持一致）**

| key | zh |
|---|---|
| `update.available` | 有可用更新 |
| `update.title` | 有可用更新 |
| `update.version` | `{from} → {to}` |
| `update.cancel` | 取消 |
| `update.apply` | 更新 |
| `update.close` | 关闭 |
| `update.starting` | 正在更新 dsh-mo-image… |
| `update.doneRestart` | 更新已完成，重启 DSH 后生效 |
| `update.done` | 已更新到 `{version}` |
| `update.failed` | 更新未完成，请重试 |
| `update.unsupported` | 当前环境不支持自助更新，请运行 `{command}` |
| `update.localDev` | 本地开发安装，请自行 `git pull` |
| `update.command` | `dsh plugin add github:CM-Silence/dsh-mo-image#{tag}` |
| `update.viewRelease` | 在 GitHub 查看更新说明 |
| `update.noNotes` | 这次发布没有写更新说明。 |

其他七列写对应语言的等义文案（技术名词 API / GitHub / DSH / pnpm 保留原文）。

- [ ] **步骤 2：重新生成字典块**

运行：`npm run build:locales && npm run check:locales`
预期：`lib/client.js` 里的 `BEGIN/END GENERATED LOCALES` 块被重写，`check:locales` 退出码 0

- [ ] **步骤 3：编写失败的测试**

```js
// test/client-update.test.mjs：复用 client-i18n-render.test.mjs 的 createHarness
test('renderUpdateNotes turns release markdown into readable blocks', ...)  // __test.renderUpdateNotes('- a\n- b') → 两个 li；'## 标题' → h；'<img onerror>' 原样当文本
test('updateToastFor picks the right message per state', ...)               // done + updatedBeforeRestart false → t('update.doneRestart')；done + true → t('update.done', {version})；failed → t('update.failed')；updating → t('update.starting')；available → null
```

- [ ] **步骤 4：运行测试验证失败**

运行：`node --test test/client-update.test.mjs`
预期：FAIL，`__test.renderUpdateNotes` 未定义

- [ ] **步骤 5：实现客户端状态层**

- 新增 `async function fetchUpdateStatus()`：`fetch('/api/mo-image/update', { cache: 'no-store', signal: AbortSignal.timeout(5000) })`，返回 JSON 或抛错。
- 新增 `function renderUpdateNotes(markdown)`：按行解析，返回 `[]` of `{ kind: 'h' | 'li' | 'p', text }`；`h` 对应 `#`/`##`/`###`，`li` 对应 `- `/`* `/`1. `，其余非空行是 `p`；`**粗体**` 与 `` `代码` `` 保留原始字符（不做富文本），HTML 标签原样当文本。
- 新增 `function updateToastFor(status, t)`：`done` → `t('update.doneRestart')`（若 `status.updatedBeforeRestart` 为真则 `t('update.done', { version })`），`failed` → `t('update.failed')`，`updating` → `t('update.starting')`，其余 `null`。
- 在 `__test` 里导出这三个函数。

- [ ] **步骤 6：运行测试验证通过**

运行：`node --test test/client-update.test.mjs test/client-i18n.test.mjs test/locales.test.mjs`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add locale/messages.csv lib/client.js test/client-update.test.mjs
git commit -m "feat: add update copy and client status helpers"
```

---

### 任务 5：设置页标题行按钮与对话框

**文件：**
- 修改：`lib/client.js`（`ImageModelSettings` 头部；新增 `UpdateDialog` 组件）
- 修改：`test/client-update.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
test('the settings header shows the update button only when one is available', ...)
// harness 的 fake fetch 返回 { ok:true, state:'available', current:'0.3.1', latest:'0.4.0', installable:true }
// 渲染 settings.section 组件 → textOf 包含 '有可用更新'（locale zh）
// 再把 fake fetch 换成 { state:'idle' } 重开 harness → 不包含

test('the client fetches update status once the settings section mounts', ...)
// fake fetch 记录 url；渲染一次后 assert.ok(urls.includes('/api/mo-image/update'))

test('the dialog lays out title, version, notes and the two actions', ...)
// React.createElement(__test.UpdateDialog, { status, t, onClose(){}, onApply(){} })
// 文本含 '有可用更新'、'0.3.1 → 0.4.0'、'取消'、'更新'，且 status.notes 的每个列表项都出现在树里
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/client-update.test.mjs`
预期：FAIL，找不到按钮文案 / `__test.UpdateDialog` 未定义

- [ ] **步骤 3：实现**

- `ImageModelSettings` 顶部从 `<h2>` + `<p>` 改成一行 flex（`display:flex; align-items:center; justify-content:space-between; gap:12px`）：左侧仍是标题，右侧在 `status.state === 'available'` 时渲染按钮 `<button type="button" className={MC.linkButton}>{t('update.available')}</button>`；按钮样式用 `MC.linkButton` 与内联的胶囊样式（`padding: 2px 10px; border-radius: 999px; font-size: 12px;`）。
- 组件挂载时 `useEffect` 拉一次状态；`state === 'checking'` 或首帧没有 `checkedAt` 时 1.5 秒后再拉一次，最多 3 次。
- 点击按钮 → `setDialogOpen(true)`。
- `UpdateDialog({ status, notes, t, onClose, onApply, sending })`：居中遮罩 + 卡片；标题行左 `t('update.title')`、右关闭按钮；下一行 `t('update.version', { from: status.current, to: status.latest })`；正文是固定 `maxHeight: 320` 的滚动区，用 `renderUpdateNotes` 渲染，没有 notes 时显示 `t('update.noNotes')` 与一个指向 `status.url` 的链接（`t('update.viewRelease')`）；底部右对齐 `t('update.cancel')` 与 `t('update.apply')`。Esc / 遮罩点击都调 `onClose`。
- 模块级 `createToastQueue()`（只保留最新一条，4 秒后自动清除，带 `push(text, tone)` / `subscribe(fn)`）与 `pushToast(text, tone)`；本任务只负责往里 push，渲染留给任务 6。
- `onApply`：先关对话框。`status.installable === false` 时只 push 一条气泡（`source` 是 `link` → `t('update.localDev')`，否则 → `t('update.unsupported', { command: t('update.command', { tag: 'v' + status.latest }) })`），不发请求；否则 POST `/api/mo-image/update` `{ action:'apply', version: status.latest }`，并立刻 push `t('update.starting')`。
- `__test.UpdateDialog = UpdateDialog`；`__test.toastQueue = toastQueue`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/client-update.test.mjs test/client-i18n.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add lib/client.js test/client-update.test.mjs
git commit -m "feat: show update badge and dialog in image model settings"
```

---

### 任务 6：底部气泡

**文件：**
- 修改：`lib/client.js`（新增 `UpdateToastHost` 与 `shell.overlay` 注册）
- 修改：`lib/index.js`（路由接受 `{ action: 'ack' }`）
- 修改：`test/client-update.test.mjs`、`test/update-route.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
test('the overlay host renders a toast for a finished update', ...)
// __test.renderUpdateNotes 之外的纯函数 updateToastFor 已覆盖文案；
// 这里断言 apply 后注册表里多了 name === 'shell.overlay' 的注册
test('starting an update pushes the "starting" toast', ...)
// 调 __test.toastQueue.push(t('update.starting'), 'info') 后，队列长度 1、内容匹配
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/client-update.test.mjs`
预期：FAIL，没有 `shell.overlay` 注册

- [ ] **步骤 3：实现**

- `UpdateToastHost`：订阅任务 5 建好的 `toastQueue`，用 `primitives.Toast` 渲染（拿不到 `Toast` 时退化成普通 div）；组件挂载时拉一次 `/api/mo-image/update`，`state === 'done'` 时 push `updateToastFor(status, t)` 并 POST `{ action: 'ack' }`；`state === 'failed'` 时同样 push 并 ack。
- `apply(ctx)` 里注册：`ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'mo-image-update-toast', order: 90, inject: () => ({ t }) }, UpdateToastHost))`。
- 宿主路由补 `POST { action: 'ack' }`：清掉内存里的 `done`/`failed` 状态，返回 `{ ok: true }`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/client-update.test.mjs test/update-route.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add lib/client.js lib/index.js test/client-update.test.mjs test/update-route.test.mjs
git commit -m "feat: toast update progress in the page overlay"
```

---

### 任务 7：发版脚本

**文件：**
- 创建：`scripts/release.mjs`
- 修改：`package.json`（`scripts.release`）
- 测试：`test/release-script.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
import { parseArgs, nextVersion, renderNotes } from '../scripts/release.mjs';

test('parseArgs reads the bump kind, notes and flags', ...)
// parseArgs(['minor']) → { kind:'minor', publish:false, dryRun:false }
// parseArgs(['0.4.0','--notes','- 修复']) → { kind:'0.4.0', notes:'- 修复' }
// parseArgs(['--dry-run','patch']) → dryRun true

test('nextVersion bumps the right segment', ...)
// nextVersion('0.3.1','patch') === '0.3.2'; ('0.3.1','minor') === '0.4.0'; ('0.3.1','major') === '1.0.0'
// nextVersion('0.3.1','0.4.0') === '0.4.0'；非法参数抛错

test('renderNotes groups commits by type', ...)
// renderNotes([{type:'feat',text:'add x'},{type:'fix',text:'fix y'}]) → 含 '### 新功能' 与 '### 修复'
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/release-script.test.mjs`
预期：FAIL，`Cannot find module '../scripts/release.mjs'`

- [ ] **步骤 3：实现**

`scripts/release.mjs` 导出 `parseArgs`、`nextVersion`、`renderNotes`，并只在 `import.meta.url === pathToFileURL(process.argv[1]).href` 时执行 `main()`。

`main()` 顺序：检查工作树干净（`git status --porcelain` 为空）→ `npm test` → 改 `package.json` 版本 → `git commit -m "chore(release): v<version>"` → `git tag -a v<version> -m v<version>` → `git push && git push --tags` → 建 Release。`--dry-run` 时每一步只打印命令，不执行任何一条。

建 Release：有 `gh` 就用 `gh release create v<version> --title v<version> --notes-file <tmp>`；否则用 `GITHUB_TOKEN` 调 `POST https://api.github.com/repos/CM-Silence/dsh-mo-image/releases`；两者都没有时打印 tag 已推送、以及"去网页新建 Release，正文如下"和生成好的正文。

提交分组：从 `git log <lastTag>..HEAD --pretty=%s` 取标题，按 `feat`/`fix`/`docs`/`chore` 归到「新功能 / 修复 / 文档 / 其他」四节；没有 lastTag 时取最近 30 条。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/release-script.test.mjs`
预期：PASS

- [ ] **步骤 5：手动冒烟**

运行：`node scripts/release.mjs --dry-run patch`
预期：打印将执行的步骤，且不修改任何文件、不建 tag、不推送

- [ ] **步骤 6：Commit**

```bash
git add scripts/release.mjs package.json test/release-script.test.mjs
git commit -m "feat: add release script for tags and GitHub releases"
```

---

### 任务 8：README 与收尾验证

**文件：**
- 修改：`README.md`（安装小节补自助更新说明；新增"更新"一小节）

- [ ] **步骤 1：README 补两段**

- 安装小节：说明正常安装后设置页会在有新版本时出现"有可用更新"。
- 新增"更新"小节：点按钮的流程；`link:` 安装请自己 `git pull`；没有桌面插件管理器时用 `dsh plugin add github:CM-Silence/dsh-mo-image#v<版本>`；以及"发版"给维护者看的三行命令（`npm run release -- minor`，想先看效果加 `--dry-run`）。

- [ ] **步骤 2：全量验证**

运行：`npm test && npm run check:locales`
预期：全部 PASS，`check:locales` 退出码 0

- [ ] **步骤 3：按验收标准手动过一遍**

对照规格的验收标准 1–3、5–7（第 4 条需要仓库上真有一个更高版本的 Release，留给作者发版后验）。检查项：断网启动无按钮且日志有原因；按钮/对话框/关闭方式；`link:` 安装点更新只得到提示；`--dry-run` 不写文件。

- [ ] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: describe auto-update for users and maintainers"
```

/**
 * 协议下拉的「别一长串」改造 + 请求体里的「识别协议」按钮。
 *
 * - 默认只列常用几条（未选择 / OpenAI 家族 / Gemini / 自定义 / 更多协议…），
 *   点「更多协议…」才分组展开全部 17 条；展开状态只是 UI，重开面板就收起，
 *   「更多协议…」也绝不会变成配置里的值。
 * - 「识别协议」先问宿主（本地匹配不发请求），兜底到自定义时三条地址预填相对路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseMessages } from '../scripts/build-locales.mjs';
import { adapterManifest } from '../lib/adapters.js';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const parsed = parseMessages(readFileSync(new URL('../locale/messages.csv', import.meta.url), 'utf8'));
const zh = parsed.messages.zh;

/** 与浏览器同一份文案：缺键时退回键名（和 client 的 t 行为一致）。 */
function t(key, params) {
  const template = Object.hasOwn(zh, key) ? zh[key] : key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const MORE = '__more__';

/** 状态化的 React 替身：setState 之后重渲染，和设置页里的行为一致。 */
function createHarness({ adapters = adapterManifest(), detect = null } = {}) {
  let loaded = null;
  let dirty = false;
  const stores = new Map();
  let current = null;
  let index = 0;
  const fetchCalls = [];

  const React = {
    createElement(type, props, ...children) { return { type: type, props: props || {}, children: children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const slot = index++;
      const store = current;
      if (!(slot in store)) store[slot] = typeof initial === 'function' ? initial() : initial;
      return [store[slot], (next) => {
        store[slot] = typeof next === 'function' ? next(store[slot]) : next;
        dirty = true;
      }];
    },
    useEffect() { index += 1; },
    useLayoutEffect() { index += 1; },
    useMemo(fn) { index += 1; return fn(); },
    useCallback(fn) { index += 1; return fn; },
    useRef(value) {
      const slot = index++;
      if (!(slot in current)) current[slot] = { current: value };
      return current[slot];
    }
  };
  const window = {
    __ModuleLoader__: { load(definition) { loaded = definition; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
  };
  const document = {
    querySelectorAll() { return []; }, querySelector() { return null; }, getElementById() { return null; },
    createElement() { return { id: '', textContent: '', parentNode: null }; },
    head: { appendChild() {} }, body: {}, styleSheets: [], adoptedStyleSheets: []
  };
  const context = {
    window, document, React, console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal,
    Response: globalThis.Response,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
      if (String(url).endsWith('/api/mo-image/detect-protocol')) {
        const asked = JSON.parse(String((init && init.body) || '{}'));
        const answer = typeof detect === 'function'
          ? await detect(asked)
          : (detect || { status: 500, body: { error: 'no stub' } });
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true, config: { providers: [], active: {} }, adapters: adapters,
        providerPresets: [], localPresets: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    setTimeout: () => 0,
    clearTimeout() {},
    URL
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  const api = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal(node) { return node; } };
    return {};
  });
  api.apply({
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    slots: { inject(_key, callback) { callback(); }, register() { return () => {}; } },
    locale: null
  });

  function renderNode(node) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      if (!stores.has(node.type)) stores.set(node.type, []);
      const previous = current;
      current = stores.get(node.type);
      index = 0;
      const props = Object.assign({}, node.props || {});
      if (node.children && node.children.length) {
        props.children = node.children.length === 1 ? node.children[0] : node.children;
      }
      const output = node.type(props);
      current = previous;
      return renderNode(output);
    }
    return { type: node.type, props: node.props || {}, children: (node.children || []).map(renderNode) };
  }

  /** 渲染到稳定：setState 会再跑一轮。 */
  function renderForm(props) {
    for (let round = 0; round < 20; round += 1) {
      dirty = false;
      const tree = renderNode(React.createElement(api.__test.ImageProviderForm, props));
      if (!dirty) return tree;
    }
    throw new Error('render did not settle');
  }

  return {
    fetchCalls,
    renderForm,
    setCatalog() {
      api.__test.applyCatalog({ adapters: adapters, providerPresets: [], localPresets: [], capabilities: [] });
    },
    /** 模拟关掉面板再打开：hook 状态丢掉，组件从头挂载。 */
    remount(props) {
      stores.clear();
      return renderForm(props);
    }
  };
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (item) => { if (predicate(item)) out.push(item); });
  return out;
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) textOf(item, out); return out; }
  for (const child of node.children || []) textOf(child, out);
  return out;
}

const protocolSelect = (tree) => findAll(tree, (node) => node.type === 'select'
  && node.props && node.props['data-mo-image-protocol'] !== undefined)[0] || null;
const optionNodes = (node) => findAll(node, (child) => child.type === 'option');
const optionValues = (node) => optionNodes(node).map((option) => option.props.value);
const optionTexts = (node) => optionNodes(node).map((option) => textOf(option).join(''));
const optgroupLabels = (node) => findAll(node, (child) => child.type === 'optgroup').map((group) => group.props.label);
const detectButton = (tree) => findAll(tree, (node) => node.type === 'button'
  && node.props && node.props['data-mo-image-detect-protocol'] !== undefined)[0] || null;
const noteOf = (tree) => findAll(tree, (node) => node.props && node.props['data-mo-image-protocol-note'] !== undefined)[0] || null;
const routeInputs = (tree) => {
  const inputs = findAll(tree, (node) => node.type === 'input' && /^route-/.test(String(node.props.name || '')));
  const by = {};
  for (const input of inputs) by[String(input.props.name).replace(/^route-/, '')] = input;
  return by;
};

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'p1',
    name: 'Relay',
    baseUrl: 'https://relay.example/v1',
    key: 'sk-test',
    adapter: '',
    protocol: 'openai-images',
    customEndpoints: {},
    models: ['Qwen/Qwen-Image'],
    names: {},
    modelOptions: {}
  }, overrides);
}

function formProps(provider) {
  // 编辑已存在的提供商：协议块在「高级」里（新建时走目录/自定义/本地的添加流程）。
  return { provider: provider, isNew: false, onSave() {}, onClose() {}, t: t };
}

test('默认只列常用协议：加上「未选择」「自定义」「更多协议…」一共 7 项', () => {
  const client = createHarness();
  client.setCatalog();
  const tree = client.renderForm(formProps(providerFixture()));
  const select = protocolSelect(tree);
  assert.ok(select, '找不到协议下拉');
  assert.deepEqual(optionValues(select), [
    '', 'openai-images', 'openai-chat', 'openai-responses', 'google-gemini', 'custom', MORE
  ]);
  assert.ok(optionValues(select).length <= 9, '默认渲染的 option 不能超过 9 条');
  assert.deepEqual(optionTexts(select), [
    '未选择', 'OpenAI Images', 'OpenAI Chat Completions', 'OpenAI Responses',
    'Google Gemini', '自定义', '更多协议…'
  ]);
  // 「未选择」只是没选协议时的当前状态，不是可选项；没选协议就不发请求（见 protocol-required）。
  assert.equal(optionNodes(select)[0].props.disabled, true);
});

test('自定义协议在下拉里只有一项：标签走 i18n，不出现裸值 custom', () => {
  const client = createHarness();
  client.setCatalog();
  // 选的是「自定义」的提供商：draft.adapter 就是 'custom'，而它并不在宿主的协议清单里。
  const props = formProps(providerFixture({ adapter: 'custom' }));
  const customOptions = (select) => optionNodes(select).filter((option) => option.props.value === 'custom');

  const collapsed = protocolSelect(client.renderForm(props));
  assert.equal(customOptions(collapsed).length, 1, '收起时「自定义」只出现一次');
  assert.deepEqual(customOptions(collapsed).map((option) => textOf(option).join('')), ['自定义'],
    '标签是 i18n 文案，不是裸 id，也不带括号');

  // 展开态同样只有一条：清单里没有 custom 这条协议，别把它当成「清单里已经没有的协议」再列一遍。
  collapsed.props.onChange({ target: { value: MORE } });
  const expanded = protocolSelect(client.renderForm(props));
  assert.equal(customOptions(expanded).length, 1, '展开后「自定义」也只出现一次');
  assert.deepEqual(customOptions(expanded).map((option) => textOf(option).join('')), ['自定义']);
});

test('点「更多协议…」展开全部 17 条并按组分段，且它不会变成选中的值', () => {
  const client = createHarness();
  client.setCatalog();
  const props = formProps(providerFixture());
  const collapsed = protocolSelect(client.renderForm(props));
  collapsed.props.onChange({ target: { value: MORE } });

  const expanded = protocolSelect(client.renderForm(props));
  const values = optionValues(expanded);
  const ids = adapterManifest().map((adapter) => adapter.id);
  for (const id of ids) assert.ok(values.includes(id), '展开后要能看到 ' + id);
  assert.equal(values.filter((value) => value === '').length, 1, '只有一条「未选择」占位');
  assert.ok(!values.includes(MORE), '展开后不再给「更多协议…」入口');
  assert.equal(values.length, 19, '17 条协议 + 未选择 + 自定义');
  assert.ok(values.includes('stability'), '长尾协议 stability 也在展开列表里');
  assert.equal(expanded.props.value, '', '「更多协议…」不能写进 draft');
  assert.deepEqual(optgroupLabels(expanded), ['通用', '兼容网关', '各家原生', '本地部署', '异步任务']);
  assert.ok(optionTexts(expanded).includes('Stability AI'), '长尾协议的短名字');
});

test('展开后选中长尾协议：下拉回到收起状态并显示它自己的名字', () => {
  const client = createHarness();
  client.setCatalog();
  const props = formProps(providerFixture());
  protocolSelect(client.renderForm(props)).props.onChange({ target: { value: MORE } });
  const expanded = protocolSelect(client.renderForm(props));
  expanded.props.onChange({ target: { value: 'stability' } });

  const picked = protocolSelect(client.renderForm(props));
  assert.equal(picked.props.value, 'stability');
  assert.equal(optgroupLabels(picked).length, 0, '选完不该停在展开态');
  assert.ok(optionValues(picked).length <= 9);
  assert.ok(optionTexts(picked).includes('Stability AI'));
  assert.ok(optionValues(picked).includes(MORE), '还能再展开');
});

test('重开面板回到收起状态：展开只是个 UI 状态，不进配置', () => {
  const client = createHarness();
  client.setCatalog();
  const props = formProps(providerFixture());
  protocolSelect(client.renderForm(props)).props.onChange({ target: { value: MORE } });
  assert.ok(optgroupLabels(protocolSelect(client.renderForm(props))).length > 0, '先展开');

  const reopened = protocolSelect(client.remount(props));
  assert.deepEqual(optgroupLabels(reopened), [], '重开面板应该是收起的');
  assert.ok(optionValues(reopened).length <= 9);
});

test('识别协议：地址不认识 → 逐条试完，切到自定义并预填相对路径', async () => {
  const client = createHarness({
    detect: (body) => (body.probe
      ? { status: 200, body: { ok: true, done: false, probe: body.probe, hit: false, shape: '', protocols: [] } }
      : {
        status: 200,
        body: { ok: true, done: false, probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels'] }
      })
  });
  client.setCatalog();
  const props = formProps(providerFixture());
  const button = detectButton(client.renderForm(props));
  assert.ok(button, '协议下拉右侧要有「识别协议」按钮');
  assert.equal(textOf(button).join(''), '识别协议');
  await button.props.onClick();
  const tree = client.renderForm(props);

  assert.equal(protocolSelect(tree).props.value, 'custom');
  const routes = routeInputs(tree);
  assert.equal(routes.generate.props.value, '/images/generations');
  assert.equal(routes.edit.props.value, '/images/edits');
  assert.equal(routes.models.props.value, '/models');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'warn');
  assert.equal(textOf(noteOf(tree)).join(''), '没认出协议，已切到自定义并预填地址；最后尝试 /API/ListModels');

  // 一次问计划 + 四条探针：探测是客户端按顺序逐条驱动的。
  const asked = client.fetchCalls.filter((call) => call.url.endsWith('/api/mo-image/detect-protocol'));
  assert.equal(asked.length, 5, '问一次计划，再一条一个请求');
  const body = JSON.parse(asked[0].body);
  assert.equal(body.baseUrl, 'https://relay.example/v1');
  assert.equal(body.model, 'Qwen/Qwen-Image', '协议匹配也带模型名（百炼那类按模型判）');
});

test('识别协议：认得出具体协议 → 直接切过去，提示具体名字', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: { ok: true, done: true, protocol: 'google-gemini', matched: true, probed: false }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture());
  await detectButton(client.renderForm(props)).props.onClick();
  const tree = client.renderForm(props);
  assert.equal(protocolSelect(tree).props.value, 'google-gemini');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'ok');
  assert.equal(textOf(noteOf(tree)).join(''), '已识别为 Google Gemini');
  assert.deepEqual(routeInputs(tree), {}, '不是自定义协议，就不该出现三条地址');
});

test('识别协议：已知主机连同协议级选项一起带回，面板直接显示那个取值', async () => {
  // 宿主对已知的 OpenAI 兼容主机不再探测，直接判定 openai-images + 该主机的选项。
  const client = createHarness({
    detect: {
      status: 200,
      body: {
        ok: true, done: true, protocol: 'openai-images', matched: true, probed: false,
        protocolOptions: { edit: 'same' }
      }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3' }));
  await detectButton(client.renderForm(props)).props.onClick();
  const tree = client.renderForm(props);

  assert.equal(protocolSelect(tree).props.value, 'openai-images');
  const editOption = findAll(tree, (node) => node.type === 'select'
    && node.props && node.props['data-mo-image-protocol-option'] === 'edit')[0];
  assert.ok(editOption, 'openai-images 的协议级选项要出现在面板里');
  assert.equal(editOption.props.value, 'same', '识别结论里的 edit 选项要写进 draft，不能重置成默认');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'ok');
  assert.equal(textOf(noteOf(tree)).join(''), '已识别为 OpenAI Images');
});

test('识别协议：没有 API 地址时不发请求，直接提示', async () => {
  const client = createHarness();
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: '' }));
  await detectButton(client.renderForm(props)).props.onClick();
  const tree = client.renderForm(props);
  assert.equal(textOf(noteOf(tree)).join(''), '先填写 API 地址');
  assert.equal(
    client.fetchCalls.filter((call) => call.url.endsWith('/api/mo-image/detect-protocol')).length,
    0,
    '地址都没有，别打识别路由'
  );
});

test('识别协议：宿主报错时把错误当成提示显示', async () => {
  const client = createHarness({
    detect: { status: 500, body: { ok: false, error: '路由炸了', code: 'serverError.detectProtocol' } }
  });
  client.setCatalog();
  const props = formProps(providerFixture());
  await detectButton(client.renderForm(props)).props.onClick();
  const tree = client.renderForm(props);
  assert.match(textOf(noteOf(tree)).join(''), /自动识别协议失败|路由炸了/);
  assert.equal(protocolSelect(tree).props.value, '', '失败不动当前选择');
});

test('配置里存着清单里已经没有的协议时原样列出，不静默改名', () => {
  const client = createHarness();
  client.setCatalog();
  const select = protocolSelect(client.renderForm(formProps(providerFixture({ adapter: 'removed-protocol' }))));
  assert.equal(select.props.value, 'removed-protocol');
  assert.deepEqual(optionValues(select).slice(-3), ['removed-protocol', 'custom', MORE]);
});

test('自定义协议的三条地址示例是相对路径（与 baseUrl 拼，别让人两栏填重）', () => {
  const client = createHarness();
  client.setCatalog();
  const tree = client.renderForm(formProps(providerFixture({ adapter: 'custom' })));
  const routes = routeInputs(tree);
  assert.equal(routes.generate.props.placeholder, '/images/generations');
  assert.equal(routes.edit.props.placeholder, '/images/edits');
  assert.equal(routes.models.props.placeholder, '/models');
});

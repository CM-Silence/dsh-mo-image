/**
 * 设置页「识别协议」按钮：客户端驱动的探测循环、真实进度与校验模式。
 *
 * 三条规矩（宿主那一半在 test/detect-protocol-local.test.mjs）：
 *   1. 客户端按宿主给的顺序**逐条**发探针，每发一条就把「正在尝试访问 {path}…」写进
 *      提示——进度是真的，不是一次请求换个「识别中…」；
 *   2. 用户**手选过**具体协议时，按钮只做校验：请求里带 `expectedProtocol`，回答里的
 *      `protocols` 只用来出提示，**协议与协议级选项一个字都不改**；
 *   3. 没手选（「自动」/「自定义」）时照旧识别，探针认出来的协议把命中路径写进提示，
 *      例如「已识别为 ComfyUI（/object_info 返回 JSON 对象）」；全都不中时提示里带上
 *      最后试过的路径。
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

function t(key, params) {
  const template = Object.hasOwn(zh, key) ? zh[key] : key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

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
        // detect 可以是固定答案，也可以按请求（静态结论 / 探测顺序 / 单条探针）回答；
        // 返回 Promise 就能把某一条探针挂在 pending 上，测试在那一刻看真实进度。
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
    if (name === 'react-dom') { return { createPortal(node) { return node; } }; }
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
const detectButton = (tree) => findAll(tree, (node) => node.type === 'button'
  && node.props && node.props['data-mo-image-detect-protocol'] !== undefined)[0] || null;
const spinnerIn = (tree) => findAll(tree, (node) => node.props && node.props['data-mo-image-spinner'] !== undefined);
const noteOf = (tree) => findAll(tree, (node) => node.props && node.props['data-mo-image-protocol-note'] !== undefined)[0] || null;
const noteTextOf = (tree) => textOf(noteOf(tree)).join('');
const routeInputs = (tree) => {
  const inputs = findAll(tree, (node) => node.type === 'input' && /^route-/.test(String(node.props.name || '')));
  const by = {};
  for (const input of inputs) by[String(input.props.name).replace(/^route-/, '')] = input;
  return by;
};

function providerFixture(overrides = {}) {
  return Object.assign({
    id: 'p1',
    name: 'Local',
    baseUrl: 'http://127.0.0.1:8188',
    key: '',
    adapter: '',
    protocol: 'openai-images',
    customEndpoints: {},
    models: [],
    names: {},
    modelOptions: {}
  }, overrides);
}

function formProps(provider) {
  return { provider: provider, isNew: false, onSave() {}, onClose() {}, t: t };
}

async function clickDetect(client, props) {
  const button = detectButton(client.renderForm(props));
  assert.ok(button, '协议 label 右侧要有「识别协议」按钮');
  await button.props.onClick();
  return client.renderForm(props);
}

/** 识别路由的请求体，按发出顺序。 */
const askedBodiesOf = (client) => client.fetchCalls
  .filter((call) => call.url.endsWith('/api/mo-image/detect-protocol'))
  .map((call) => JSON.parse(call.body));

/**
 * 「计划 + 单条探针」的桩：`hits` 里没写的路径一律当没命中。
 * 宿主真正的形状→协议翻译在 test/detect-protocol-local.test.mjs 钉，这里只模拟回答。
 */
const detectStub = (probes, hits = {}) => (asked) => {
  if (!asked.probe) return { status: 200, body: { ok: true, done: false, probes: probes } };
  const hit = hits[asked.probe];
  return {
    status: 200,
    body: {
      ok: true, done: false, probe: asked.probe, hit: Boolean(hit),
      shape: hit ? hit.shape : '', protocols: hit ? hit.protocols : []
    }
  };
};

/**
 * 带「失败原因」的探针桩：计划回复可以带 `credential`，单条探针按 `steps` 回 status / reason。
 * 宿主的形状→协议翻译在 test/detect-protocol-local.test.mjs 钉；HTTP 状态怎么进回答在
 * test/detect-protocol-route.test.mjs 钉。这里只模拟回答，验客户端的提示。
 */
const detectFailureStub = (probes, steps = {}, options = {}) => (asked) => {
  if (!asked.probe) {
    const body = { ok: true, done: false, probes: probes };
    if (options.credential) body.credential = options.credential;
    return { status: 200, body: body };
  }
  const step = steps[asked.probe] || {};
  return {
    status: 200,
    body: Object.assign(
      { ok: true, done: false, probe: asked.probe, hit: false, shape: '', protocols: [] },
      step
    )
  };
};

test('无 Key + 401：提示「没有可用的 API Key」，不是笼统的「没认出协议」', async () => {
  const client = createHarness({
    detect: detectFailureStub(['/models'], { '/models': { status: 401 } }, { credential: 'missing' })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'custom', '没命中照样落自定义');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'warn');
  assert.equal(
    noteTextOf(tree),
    '没有可用的 API Key（未填写或凭据解析失败），/models 无法鉴权；已切到自定义并预填地址'
  );
});

test('有 Key 但 401：提示鉴权失败，指针指向 Key 而不是地址', async () => {
  const client = createHarness({
    detect: detectFailureStub(['/models'], { '/models': { status: 401 } })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(
    noteTextOf(tree),
    '鉴权失败（/models 返回 401）：Key 无效、未填写或没有权限；已切到自定义并预填地址'
  );
});

test('404：提示「这个地址没有该接口」，而不是 Key 问题', async () => {
  const client = createHarness({
    detect: detectFailureStub(['/models'], { '/models': { status: 404 } })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(noteTextOf(tree), '这个地址没有该接口（/models 返回 404）；已切到自定义并预填地址');
});

test('超时：只说连接超时并给出完整 URL（status 0 + reason timeout，不是 404）', async () => {
  const client = createHarness({
    detect: detectFailureStub(['/models'], { '/models': { status: 0, reason: 'timeout' } })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(noteTextOf(tree), '连接 https://relay.example/v1/models 超时，请检查网络或代理后重试；已切到自定义并预填地址');
});

test('连不上：只说连不上并给出完整 URL（status 0 + reason network）', async () => {
  const client = createHarness({
    detect: detectFailureStub(['/models'], { '/models': { status: 0, reason: 'network' } })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(noteTextOf(tree), '无法连接到 https://relay.example/v1/models，请确保服务已经启动后再重试；已切到自定义并预填地址');
});

test('手选 ComfyUI 连不上：只说连不上，报该协议自己的 /object_info 完整地址', async () => {
  const client = createHarness({
    detect: detectFailureStub(
      // 故意把 A1111 的探针排在第一条（复现用户遇到的那次顺序）：仍然该报 ComfyUI 自己的。
      ['/sdapi/v1/sd-models', '/object_info', '/API/ListModels', '/models'],
      {
        '/sdapi/v1/sd-models': { status: 0, reason: 'network' },
        '/object_info': { status: 0, reason: 'unreadable' },
        '/API/ListModels': { status: 0, reason: 'network' },
        '/models': { status: 0, reason: 'network' }
      }
    )
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188' }));
  const tree = await clickDetect(client, props);
  const note = noteTextOf(tree);
  assert.equal(note, '无法连接到 http://127.0.0.1:8188/object_info，请确保服务已经启动后再重试。');
  assert.equal(note.includes('不像'), false, '连不上就不该评价像不像');
  assert.equal(note.includes('/sdapi'), false, '该报用户所选协议的探针，不是 A1111 的');
  assert.equal(protocolSelect(tree).props.value, 'comfyui', '校验失败不改写用户选择');
});

test('校验模式遇到 401：协议与选项不动，在「不像」后面写明鉴权失败', async () => {
  const client = createHarness({
    detect: detectFailureStub(['/models', '/object_info'], {
      '/models': { status: 401 },
      '/object_info': { status: 401 }
    })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'openai-images', baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'openai-images', '校验模式不许改写用户选择');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'warn');
  assert.equal(
    noteTextOf(tree),
    '地址不像 OpenAI Images，未改动当前选择；鉴权失败（/models 返回 401）：Key 无效、未填写或没有权限'
  );
});

test('自动：先要计划，再按顺序逐条探；命中后切协议并写清路径与形状', async () => {
  const client = createHarness({
    detect: detectStub(['/models', '/object_info'], {
      '/object_info': { shape: 'object', protocols: ['comfyui'] }
    })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://comfy.example.com' }));
  const tree = await clickDetect(client, props);

  const asked = askedBodiesOf(client);
  assert.deepEqual(asked.map((body) => body.probe), [undefined, '/models', '/object_info'], '第一条要计划，之后一条一个请求');
  assert.equal(asked[0].expectedProtocol, '', '没手选协议就不进校验模式');
  assert.equal(protocolSelect(tree).props.value, 'comfyui', '认出来就切过去');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'ok');
  assert.equal(noteTextOf(tree), '已识别为 ComfyUI（/object_info 返回 JSON 对象）');
});

test('自动：Gemini 的 models 列表也写清楚（同一个 /models，形状不同）', async () => {
  const client = createHarness({
    detect: detectStub(['/models', '/object_info'], {
      '/models': { shape: 'gemini-models', protocols: ['google-gemini'] }
    })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'google-gemini');
  assert.equal(noteTextOf(tree), '已识别为 Google Gemini（/models 返回 models 列表）');
  assert.deepEqual(askedBodiesOf(client).map((body) => body.probe), [undefined, '/models'], '第一条就命中，不必再问');
});

test('自动：openai 的 {data:[…]} 是通用兜底，提示保持「地址可用」的老形状', async () => {
  const client = createHarness({
    detect: detectStub(['/models'], { '/models': { shape: 'openai-data', protocols: ['openai-images'] } })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'openai-images');
  assert.equal(noteTextOf(tree), '地址可用，已设为 OpenAI Images', '兜底协议不带探针细节');
});

test('手选了 ComfyUI 后提示模型列表可访问', async () => {
  const client = createHarness({
    detect: detectStub(['/object_info', '/models'], {
      '/object_info': { shape: 'object', protocols: ['comfyui'] }
    })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'comfyui' }));
  const tree = await clickDetect(client, props);

  assert.equal(askedBodiesOf(client)[0].expectedProtocol, 'comfyui', '手选的协议要送给宿主校验');
  assert.equal(protocolSelect(tree).props.value, 'comfyui', '协议不能被改写');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'ok');
  assert.equal(noteTextOf(tree), '模型列表可访问（/object_info 返回 JSON 对象）');
});

test('手选的协议没通过：协议与选项都不动，提示「不像」+ 看起来像谁 + 最后试过哪条', async () => {
  const client = createHarness({
    detect: detectStub(['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels'], {
      '/object_info': { shape: 'object', protocols: ['comfyui'] }
    })
  });
  client.setCatalog();
  // 用户选了 OpenAI Images 并且手动改过协议级选项：这些都不该被按钮动。
  const props = formProps(providerFixture({
    adapter: 'openai-images', baseUrl: 'https://relay.example/v1', protocolOptions: { edit: 'none' }
  }));
  const tree = await clickDetect(client, props);

  assert.equal(protocolSelect(tree).props.value, 'openai-images', '不许把用户选的协议改掉');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'warn');
  assert.equal(
    noteTextOf(tree),
    '地址不像 OpenAI Images；看起来像 ComfyUI，未改动当前选择；最后尝试 /API/ListModels'
  );
  const editOption = findAll(tree, (node) => node.type === 'select'
    && node.props && node.props['data-mo-image-protocol-option'] === 'edit')[0];
  assert.ok(editOption, '协议级选项照常显示');
  assert.equal(editOption.props.value, 'none', '校验没通过也不该动协议级选项');
});

test('手选的协议没通过、也没更像的：只提示「不像」，并说清最后试到哪', async () => {
  const client = createHarness({
    detect: detectStub(['/API/ListModels', '/models', '/object_info', '/sdapi/v1/sd-models'])
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'swarmui', baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'swarmui');
  assert.equal(noteTextOf(tree), '地址不像 SwarmUI，未改动当前选择；最后尝试 /sdapi/v1/sd-models');
});

test('手选「自定义」不算手选了协议：仍然做完整识别', async () => {
  const client = createHarness({
    detect: detectStub(['/object_info'], { '/object_info': { shape: 'object', protocols: ['comfyui'] } })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'custom' }));
  const tree = await clickDetect(client, props);
  assert.equal(askedBodiesOf(client)[0].expectedProtocol, '', '自定义没有可校验的协议');
  assert.equal(protocolSelect(tree).props.value, 'comfyui');
});

test('自定义兜底：预填三条相对地址，并说清最后试到哪', async () => {
  const client = createHarness({
    detect: detectStub(['/object_info', '/sdapi/v1/sd-models', '/API/ListModels', '/models'])
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'http://127.0.0.1:9999' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'custom');
  const routes = routeInputs(tree);
  assert.equal(routes.generate.props.value, '/images/generations');
  assert.equal(routes.edit.props.value, '/images/edits');
  assert.equal(routes.models.props.value, '/models');
  assert.equal(noteTextOf(tree), '没认出协议，已切到自定义并预填地址；最后尝试 /models');
});

test('进度是真的：探针没回来之前就显示「正在尝试访问 xxx」，按钮禁用 + 转圈', async () => {
  // 第一条探针挂在 pending 上：测试就在它没回来的时候渲染一次。
  let releaseFirst;
  const firstProbe = new Promise((resolve) => { releaseFirst = resolve; });
  const client = createHarness({
    detect: async (asked) => {
      if (!asked.probe) {
        return { status: 200, body: { ok: true, done: false, probes: ['/models', '/object_info'] } };
      }
      if (asked.probe === '/models') {
        await firstProbe;
        return { status: 200, body: { ok: true, done: false, probe: '/models', hit: false, shape: '', protocols: [] } };
      }
      return {
        status: 200,
        body: { ok: true, done: false, probe: '/object_info', hit: true, shape: 'object', protocols: ['comfyui'] }
      };
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://comfy.example.com' }));
  const running = detectButton(client.renderForm(props)).props.onClick();
  // 让「要计划」那一步跑完，停在第一条探针的 pending 上。
  await new Promise((resolve) => setTimeout(resolve, 0));

  const pending = client.renderForm(props);
  assert.equal(detectButton(pending).props.disabled, true, '识别期间按钮禁用');
  assert.equal(spinnerIn(pending).length, 1, '识别期间按钮里要有转圈');
  assert.equal(noteTextOf(pending), '正在尝试访问 /models…', '进度写的是真实正在试的路径');

  releaseFirst();
  await running;
  const done = client.renderForm(props);
  assert.equal(protocolSelect(done).props.value, 'comfyui');
  assert.equal(noteTextOf(done), '已识别为 ComfyUI（/object_info 返回 JSON 对象）');
  assert.deepEqual(askedBodiesOf(client).map((body) => body.probe), [undefined, '/models', '/object_info']);
});

test('静态结论（一次请求都不发探测）：直接落结果，不走循环', async () => {
  const client = createHarness({
    detect: () => ({
      status: 200,
      body: { ok: true, done: true, protocol: 'google-gemini', matched: true, probed: false }
    })
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'google-gemini');
  assert.equal(noteTextOf(tree), '已识别为 Google Gemini');
  assert.equal(askedBodiesOf(client).length, 1, '静态判定只问一次宿主');
});

/**
 * 设置页「识别协议」按钮：校验模式与探针提示。
 *
 * 两条规矩（宿主那一半在 test/detect-protocol-local.test.mjs）：
 *   1. 用户**手选过**具体协议时，按钮只做校验：请求里带 `expectedProtocol`，回答里的
 *      `verified` / `suggested` 只用来出提示，**协议与协议级选项一个字都不改**；
 *   2. 没手选（「自动」/「自定义」）时照旧识别，探针认出来的协议把命中路径写进提示，
 *      例如「已识别为 ComfyUI（/object_info 返回 JSON 对象）」。
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
        const answer = detect || { status: 500, body: { error: 'no stub' } };
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

const askedBodyOf = (client) => {
  const asked = client.fetchCalls.filter((call) => call.url.endsWith('/api/mo-image/detect-protocol'));
  assert.equal(asked.length, 1, '只问宿主一次');
  return JSON.parse(asked[0].body);
};

test('自动：请求不带 expectedProtocol，探针命中后切协议并写清命中路径与形状', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: { ok: true, protocol: 'comfyui', matched: false, probed: true, probe: '/object_info', shape: 'object' }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture());
  const tree = await clickDetect(client, props);

  assert.equal(askedBodyOf(client).expectedProtocol, '', '没手选协议就不进校验模式');
  assert.equal(protocolSelect(tree).props.value, 'comfyui', '认出来就切过去');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'ok');
  assert.equal(noteTextOf(tree), '已识别为 ComfyUI（/object_info 返回 JSON 对象）');
});

test('自动：Gemini 的 models 列表也写清楚（同一个 /models，形状不同）', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: { ok: true, protocol: 'google-gemini', matched: false, probed: true, probe: '/models', shape: 'gemini-models' }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'google-gemini');
  assert.equal(noteTextOf(tree), '已识别为 Google Gemini（/models 返回 models 列表）');
});

test('手选了 ComfyUI：只校验，不改写；通过时提示「已确认」', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: {
        ok: true, protocol: 'comfyui', matched: true, probed: true, verified: true,
        probe: '/object_info', shape: 'object'
      }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'comfyui' }));
  const tree = await clickDetect(client, props);

  assert.equal(askedBodyOf(client).expectedProtocol, 'comfyui', '手选的协议要送给宿主校验');
  assert.equal(protocolSelect(tree).props.value, 'comfyui', '协议不能被改写');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'ok');
  assert.equal(noteTextOf(tree), '已确认：ComfyUI（/object_info 返回 JSON 对象）');
});

test('手选的协议没通过：协议与选项都不动，提示「不像」并说出看起来像谁', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: {
        ok: true, protocol: 'openai-images', matched: false, probed: true, verified: false,
        probe: '/models', suggested: 'comfyui', suggestedProbe: '/object_info'
      }
    }
  });
  client.setCatalog();
  // 用户选了 OpenAI Images 并且手动改过协议级选项：这些都不该被按钮动。
  const props = formProps(providerFixture({
    adapter: 'openai-images', baseUrl: 'https://relay.example/v1', protocolOptions: { edit: 'none' }
  }));
  const tree = await clickDetect(client, props);

  assert.equal(protocolSelect(tree).props.value, 'openai-images', '不许把用户选的协议改掉');
  assert.equal(noteOf(tree).props['data-mo-image-protocol-note'], 'warn');
  assert.equal(noteTextOf(tree), '地址不像 OpenAI Images；看起来像 ComfyUI，未改动当前选择');
  const editOption = findAll(tree, (node) => node.type === 'select'
    && node.props && node.props['data-mo-image-protocol-option'] === 'edit')[0];
  assert.ok(editOption, '协议级选项照常显示');
  assert.equal(editOption.props.value, 'none', '校验没通过也不该动协议级选项');
});

test('手选的协议没通过、也没更像的：只提示「不像」', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: { ok: true, protocol: 'swarmui', matched: false, probed: true, verified: false, probe: '/API/ListModels' }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'swarmui', baseUrl: 'https://relay.example/v1' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'swarmui');
  assert.equal(noteTextOf(tree), '地址不像 SwarmUI，未改动当前选择');
});

test('手选「自定义」不算手选了协议：仍然做完整识别', async () => {
  const client = createHarness({
    detect: {
      status: 200,
      body: { ok: true, protocol: 'comfyui', matched: false, probed: true, probe: '/object_info', shape: 'object' }
    }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ adapter: 'custom' }));
  const tree = await clickDetect(client, props);
  assert.equal(askedBodyOf(client).expectedProtocol, '', '自定义没有可校验的协议');
  assert.equal(protocolSelect(tree).props.value, 'comfyui');
});

test('自定义兜底：预填三条相对地址（行为没变）', async () => {
  const client = createHarness({
    detect: { status: 200, body: { ok: true, protocol: 'custom', matched: false, probed: true } }
  });
  client.setCatalog();
  const props = formProps(providerFixture({ baseUrl: 'http://127.0.0.1:9999' }));
  const tree = await clickDetect(client, props);
  assert.equal(protocolSelect(tree).props.value, 'custom');
  const routes = routeInputs(tree);
  assert.equal(routes.generate.props.value, '/images/generations');
  assert.equal(routes.edit.props.value, '/images/edits');
  assert.equal(routes.models.props.value, '/models');
  assert.equal(noteTextOf(tree), '没认出协议，已切到自定义并预填地址');
});

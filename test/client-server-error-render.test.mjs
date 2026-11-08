import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * A stateful-enough React stand-in for slot components: useState setters
 * persist per component type and mark the tree dirty, so a click can be
 * followed by a re-render just like the real renderer's locale/outlet cycle.
 */
function createHarness() {
  let loaded = null;
  let dirty = false;
  const hookStores = new Map();
  let currentHooks = null;
  let hookIndex = 0;

  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      const hooks = currentHooks;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
        dirty = true;
      }];
    },
    useEffect() { hookIndex += 1; },
    useLayoutEffect() { hookIndex += 1; },
    useMemo(fn) { hookIndex += 1; return fn(); },
    useCallback(fn) { hookIndex += 1; return fn; },
    useRef(value) {
      const index = hookIndex++;
      if (!(index in currentHooks)) currentHooks[index] = { current: value };
      return currentHooks[index];
    }
  };
  const window = {
    __ModuleLoader__: { load(definition) { loaded = definition; } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {}
  };
  const document = {
    querySelectorAll() { return []; }, querySelector() { return null; }, getElementById() { return null; },
    createElement() { return { id: '', textContent: '', parentNode: null }; },
    head: { appendChild() {} }, body: {}, styleSheets: [], adoptedStyleSheets: []
  };
  const config = {
    providers: [{
      id: 'p1', name: 'OpenAI production', baseUrl: 'https://api.openai.com/v1',
      key: '', hasKey: true, adapter: '', protocol: 'openai-images',
      models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: {}
  };
  const networkError = {
    ok: false,
    error: '网络请求失败：api.openai.com（UND_ERR_CONNECT_TIMEOUT，直连）：TCP 连接超时：网络可能被拦截，或该域名需要代理；如果该域名需要代理才能访问，请开启系统代理或设置 HTTPS_PROXY（插件会自动使用）',
    code: 'network.failed',
    params: {
      host: 'api.openai.com', cause: 'UND_ERR_CONNECT_TIMEOUT',
      via: 'direct', hint: 'timeout'
    }
  };
  const fetchCalls = [];
  const context = {
    window, document, React, console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal, Response: globalThis.Response,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET' });
      if (String(url).endsWith('/api/mo-image/models')) {
        return new Response(JSON.stringify(networkError), { status: 502, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true, config, adapters: [],
        providerPresets: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '', models: [], website: 'https://platform.openai.com/api-keys' }],
        localPresets: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    setTimeout: () => 0, clearTimeout() {}, URL
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  const api = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal(node) { return node; } };
    return {};
  });

  const dictionaries = new Map();
  const locale = {
    active: 'en',
    register(ns, dicts) { dictionaries.set(ns, dicts); return () => {}; },
    bind(ns) { return (key, params) => {
      const dicts = dictionaries.get(ns) || {};
      let template = key;
      for (const lang of [locale.active, 'en']) { const hit = dicts[lang] && dicts[lang][key]; if (typeof hit === 'string') { template = hit; break; } }
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }; },
    getSnapshot() { return { active: locale.active, revision: 0, locales: [] }; },
    subscribe() { return () => {}; }
  };
  const registrations = [];
  api.apply({
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: { inject(_key, callback) { callback(); }, register(definition, component) { registrations.push({ definition, component }); return () => {}; } },
    locale
  });

  function render(node) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(render);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      if (!hookStores.has(node.type)) hookStores.set(node.type, []);
      const previous = currentHooks;
      currentHooks = hookStores.get(node.type);
      hookIndex = 0;
      const output = node.type(node.props || {});
      currentHooks = previous;
      return render(output);
    }
    return { type: node.type, props: node.props || {}, children: (node.children || []).map(render) };
  }

  function renderRoot() {
    const settings = registrations.find(({ definition }) => definition.name === 'settings.section');
    for (let i = 0; i < 10; i += 1) {
      dirty = false;
      const tree = render({ type: settings.component, props: settings.definition.inject(), children: [] });
      if (!dirty) return tree;
    }
    throw new Error('render did not settle');
  }

  return { fetchCalls, renderRoot };
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) textOf(item, out); return out; }
  for (const child of node.children || []) textOf(child, out);
  return out;
}

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findButton(item, label); if (hit) return hit; }
    return null;
  }
  if (node.type === 'button' && textOf(node).join('').includes(label)) return node;
  for (const child of node.children || []) { const hit = findButton(child, label); if (hit) return hit; }
  return null;
}

test('model-list network failures render the localized host error, not the Chinese payload', async () => {
  const harness = createHarness();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  let tree = harness.renderRoot();
  const edit = findButton(tree, 'Edit');
  assert.ok(edit, 'expected the provider Edit button');
  edit.props.onClick();
  tree = harness.renderRoot();

  const fetchModels = findButton(tree, 'Fetch available models');
  assert.ok(fetchModels, 'expected the fetch-models button');
  await fetchModels.props.onClick();
  tree = harness.renderRoot();

  const text = textOf(tree).join(' ');
  assert.match(text, /Network request failed: api\.openai\.com UND_ERR_CONNECT_TIMEOUT \(direct\)\. TCP connection timed out\./);
  assert.doesNotMatch(text, /网络请求失败/);
  assert.doesNotMatch(text, /代理|proxy|HTTPS_PROXY/i);
  assert.doesNotMatch(text, /Could not fetch the model list: 网络请求失败/);
  assert.ok(harness.fetchCalls.some((call) => call.url.endsWith('/api/mo-image/models')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function createHarness({ locale = 'en' } = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  let hooks = [];
  let hookIndex = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], () => {}];
    },
    useEffect(fn) { hookIndex += 1; },
    useLayoutEffect(fn) { hookIndex += 1; },
    useMemo(fn) { hookIndex += 1; return fn(); },
    useCallback(fn) { hookIndex += 1; return fn; },
    useRef(value) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = { current: value };
      return hooks[index];
    }
  };
  const window = {
    __ModuleLoader__: { load(definition) { loaded = definition; } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {}
  };
  const document = {
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getElementById() { return null; },
    createElement() { return { id: '', textContent: '', parentNode: null }; },
    head: { appendChild() {} },
    body: {},
    styleSheets: [],
    adoptedStyleSheets: []
  };
  const config = {
    providers: [{
      id: 'p1', name: 'Test provider', baseUrl: 'https://api.test/v1', key: '', hasKey: true,
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: {}
  };
  const context = {
    window,
    document,
    React,
    console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal,
    Response: globalThis.Response,
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      config,
      adapters: [],
      providerPresets: [{
        id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '',
        protocol: 'openai-images', models: [], website: 'https://platform.openai.com/api-keys'
      }],
      localPresets: [{
        id: 'sd-server', name: 'stable-diffusion.cpp (sd-server)', adapter: 'openai-images',
        baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
        urlHint: 'URL hint', hint: 'Local hint'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeout: () => 0,
    clearTimeout() {},
    URL
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  assert.ok(loaded && typeof loaded.factory === 'function');
  const api = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal(node) { return node; } };
    return {};
  });

  const dictionaries = new Map();
  const localeService = {
    active: locale,
    register(ns, dicts) { dictionaries.set(ns, dicts); return () => {}; },
    bind(ns) {
      return (key, params) => {
        const dicts = dictionaries.get(ns) || {};
        let template = key;
        for (const lang of [localeService.active, 'en']) {
          const hit = dicts[lang] && dicts[lang][key];
          if (typeof hit === 'string') { template = hit; break; }
        }
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
      };
    },
    getSnapshot() { return { active: localeService.active, revision: 0, locales: [] }; },
    subscribe() { return () => {}; }
  };

  const registrations = [];
  const slots = {
    inject(_key, callback) { callback(); },
    register(definition, component) {
      registrations.push({ definition, component });
      return () => {};
    }
  };
  api.apply({
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    slots,
    locale: localeService
  });

  function render(node) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(render);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      hooks = [];
      hookIndex = 0;
      return render(node.type(node.props || {}));
    }
    return {
      type: node.type,
      props: node.props || {},
      children: (node.children || []).map(render)
    };
  }

  return { registrations, localeService, render, React };
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) textOf(item, out); return out; }
  for (const child of node.children || []) textOf(child, out);
  return out;
}

function settingsComponent(registrations) {
  const entry = registrations.find(({ definition }) => definition.name === 'settings.section');
  assert.ok(entry, 'missing settings.section registration');
  return entry;
}

test('settings section renders English chrome and follows a locale switch', async () => {
  const harness = createHarness({ locale: 'en' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const settings = settingsComponent(harness.registrations);

  const english = textOf(harness.render(harness.React.createElement(settings.component, settings.definition.inject()))).join(' ');
  assert.match(english, /Image models/);
  assert.match(english, /Add provider/);
  assert.match(english, /Test provider/);
  assert.match(english, /Custom/);

  harness.localeService.active = 'ja';
  const japanese = textOf(harness.render(harness.React.createElement(settings.component, settings.definition.inject()))).join(' ');
  assert.match(japanese, /画像生成モデル/);
  assert.match(japanese, /モデルプロバイダーを追加/);
  assert.doesNotMatch(japanese, /Add provider/);
});


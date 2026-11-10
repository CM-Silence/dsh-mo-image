import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function loadClientSeat(config = { providers: [], active: { providerId: '', model: '' }, defaults: {} }) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  let hooks = [];
  let hookIndex = 0;
  let overrides = new Map();

  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) {
        const value = overrides.has(index)
          ? overrides.get(index)
          : (typeof initial === 'function' ? initial() : initial);
        hooks[index] = value;
      }
      return [hooks[index], () => {}];
    },
    useEffect(fn) { hooks[hookIndex++] = fn; },
    useLayoutEffect(fn) { hooks[hookIndex++] = fn; },
    useMemo(fn) { hookIndex++; return fn(); },
    useCallback(fn) { hookIndex++; return fn; },
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
      localPresets: []
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
  let seat = null;
  const slots = {
    inject(_key, callback) { callback(); },
    register(definition, component) {
      if (definition && definition.id === 'mo-image-model-seat') seat = component;
      return () => {};
    }
  };
  api.apply({ effect() { return () => {}; }, slots });
  assert.equal(typeof seat, 'function');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  function renderElement(node) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(renderElement);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      hooks = [];
      hookIndex = 0;
      const output = node.type(node.props || {});
      return renderElement(output);
    }
    return {
      type: node.type,
      props: node.props || {},
      children: (node.children || []).map(renderElement)
    };
  }

  function openPanel(panel) {
    // OfficialImageSeat's hook order starts at open, then panel.
    overrides = new Map([[0, true], [1, panel]]);
    const seatElement = seat({});
    return renderElement(seatElement);
  }

  function openModelPanel() {
    return openPanel('model');
  }

  return { openModelPanel, openPanel };
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  for (const child of node.children || []) collectText(child, out);
  return out;
}

test('no configured models hides the Auto row and shows the empty hint', async () => {
  const seat = await loadClientSeat();
  const text = collectText(seat.openModelPanel()).join(' ');
  assert.doesNotMatch(text, /(^|\s)Auto(\s|$)/);
  assert.match(text, /还没有模型，去“设置 → 生图模型”添加/);
});

test('the home panel names the active model instead of showing its id', async () => {
  const seat = await loadClientSeat({
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'],
      names: { 'gpt-image-2.5-flare': 'Flare Image' }
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: {}
  });
  const text = collectText(seat.openPanel('home')).join(' ');
  assert.match(text, /Flare Image/);
  assert.doesNotMatch(text, /gpt-image-2\.5-flare/, 'the model id is only for parameters, never for display');
});

test('the home panel falls back to the id when a model has no display name', async () => {
  const seat = await loadClientSeat({
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'],
      names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: {}
  });
  const text = collectText(seat.openPanel('home')).join(' ');
  assert.match(text, /gpt-image-2\.5-flare/);
});

test('the Auto row stays available once a model is configured', async () => {
  const seat = await loadClientSeat({
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: {}
  });
  const text = collectText(seat.openModelPanel()).join(' ');
  assert.match(text, /(^|\s)自动(\s|$)/);
  assert.match(text, /gpt-image-2\.5-flare/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClientSeat() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  const React = {
    createElement(type, props, ...children) { return { type: type, props: props || {}, children: children }; },
    Fragment: 'Fragment',
    useState(value) { return [value, () => {}]; },
    useEffect() {},
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; }
  };
  const ReactDOM = { createPortal(node) { return node; } };
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
      config: { providers: [], active: { providerId: '', model: '' }, defaults: {} },
      adapters: [],
      localPresets: []
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeout,
    clearTimeout,
    URL
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  assert.ok(loaded && typeof loaded.factory === 'function');
  const api = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
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
  api.apply({
    effect() { return () => {}; },
    slots
  });
  assert.equal(typeof seat, 'function');
  return seat;
}

function renderSeat(seat, props) {
  const outer = seat(props);
  if (!outer) return outer;
  if (outer.type && typeof outer.type === 'function' && outer.type.name === 'ImageModelSeatScoped') {
    return outer.type(props);
  }
  return outer;
}

test('image model seat is not rendered for subagent sessions', () => {
  const seat = loadClientSeat();
  const subagent = renderSeat(seat, {
    sessionId: 'child',
    useSessions: (selector) => selector({ byId: { child: { origin: 'subagent' } } })
  });
  assert.equal(subagent, null);
});

test('image model seat remains rendered for the main conversation', () => {
  const seat = loadClientSeat();
  const main = renderSeat(seat, {
    sessionId: 'root',
    useSessions: (selector) => selector({ byId: { root: { origin: 'main' } } })
  });
  assert.ok(main);
  assert.equal(main.type && main.type.name, 'ImageModelSeatInner');
});

test('image model seat falls back to the inner component without session hooks', () => {
  const seat = loadClientSeat();
  const fallback = renderSeat(seat, {});
  assert.ok(fallback);
  assert.equal(fallback.type && fallback.type.name, 'ImageModelSeatInner');
});

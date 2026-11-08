import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  const registrations = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(value) { return [value, () => {}]; },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; }
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
      config: { providers: [], active: { providerId: '', model: '' }, defaults: {} },
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
  const slots = {
    inject(_key, callback) { callback(); },
    register(definition, component) {
      registrations.push({ definition, component });
      return () => {};
    }
  };
  api.apply({ effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; }, slots });
  return { registrations, source };
}

test('settings section icon uses the host icon slot and its size prop', () => {
  const { registrations } = loadClient();
  const icon = registrations.find(({ definition }) => definition.name === 'settings.section.icon');
  assert.ok(icon, 'expected a settings.section.icon registration');
  assert.equal(icon.definition.id, 'mo-image-models');
  const element = icon.component({ size: 16, active: true });
  assert.equal(element.type, 'svg');
  assert.equal(element.props.width, 16);
  assert.equal(element.props.height, 16);
  assert.equal(element.props.viewBox, '0 0 16 16');
  assert.equal(element.props.stroke, 'currentColor');
});

test('client no longer injects custom settings nav CSS or marks host buttons', () => {
  const { source } = loadClient();
  assert.doesNotMatch(source, /NAV_ICON_CSS/);
  assert.doesNotMatch(source, /data-mo-image-nav/);
  assert.doesNotMatch(source, /mo-image-nav-icon-style/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function createHarness(options = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  let hooks = [];
  let hookIndex = 0;
  const effects = [];
  const urls = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], () => {}];
    },
    useEffect(fn) { effects.push(fn); hookIndex += 1; },
    useLayoutEffect(fn) { effects.push(fn); hookIndex += 1; },
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
  const updateStatus = options.status || { ok: true, state: 'idle', current: '0.3.1' };
  const context = {
    window,
    document,
    React,
    console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal,
    Response,
    fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes('/api/mo-image/update')) {
        if (init && init.method === 'POST') return jsonResponse(options.postResult || { ok: true });
        return jsonResponse(updateStatus);
      }
      return jsonResponse({
        ok: true,
        config: {
          providers: [{
            id: 'p1', name: 'Test provider', baseUrl: 'https://api.test/v1', key: '', hasKey: true,
            protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'], names: {}
          }],
          active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
          defaults: {}
        },
        adapters: [],
        providerPresets: [],
        localPresets: []
      });
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
    slots
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
    return { type: node.type, props: node.props || {}, children: (node.children || []).map(render) };
  }

  return { api, React, urls, registrations, render, effects };
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

test('renderUpdateNotes turns release markdown into readable blocks', () => {
  const { api } = createHarness();
  const notes = api.__test.renderUpdateNotes('- 修复 A\n- 新增 B');
  assert.deepEqual([...notes.map((block) => block.kind)], ['li', 'li']);
  assert.equal(notes[0].text, '修复 A');

  const heading = api.__test.renderUpdateNotes('## 新功能\n正文');
  assert.deepEqual([...heading.map((block) => block.kind)], ['h', 'p']);

  const html = api.__test.renderUpdateNotes('<img src=x onerror=alert(1)>');
  assert.equal(html[0].kind, 'p');
  assert.equal(html[0].text, '<img src=x onerror=alert(1)>');
});

test('updateToastFor picks the right message per state', () => {
  const { api } = createHarness();
  const calls = [];
  const t = (key, params) => { calls.push({ key, params }); return key; };

  assert.equal(api.__test.updateToastFor({ state: 'available' }, t), null);
  assert.equal(calls.length, 0);

  assert.equal(api.__test.updateToastFor({ state: 'updating' }, t), 'update.starting');
  assert.equal(api.__test.updateToastFor({ state: 'failed' }, t), 'update.failed');
  assert.equal(api.__test.updateToastFor({ state: 'failed', error: 'update.failedRestored' }, t), 'update.failedRestored');
  assert.equal(api.__test.updateToastFor({ state: 'failed', error: 'update.failedBroken' }, t), 'update.failedBroken');
  assert.equal(api.__test.updateToastFor({ state: 'done', updatedBeforeRestart: false, latest: '0.4.0' }, t), 'update.doneRestart');
  assert.equal(api.__test.updateToastFor({ state: 'done', updatedBeforeRestart: true, latest: '0.4.0' }, t), 'update.done');
  assert.equal(calls.at(-1).key, 'update.done');
  assert.equal(calls.at(-1).params.version, '0.4.0');
});

test('fetchUpdateStatus reads the host route without caching', async () => {
  const { api, urls } = createHarness({ status: { ok: true, state: 'available', current: '0.3.1', latest: '0.4.0' } });
  const status = await api.__test.fetchUpdateStatus();
  assert.equal(status.latest, '0.4.0');
  assert.ok(urls.includes('/api/mo-image/update'));
});

test('the settings header shows the update button only when one is available', () => {
  const { api, React, render } = createHarness();
  const t = (key) => key;
  const busy = textOf(render(React.createElement(api.__test.UpdateHeader, {
    status: { state: 'available', current: '0.3.1', latest: '0.4.0' }, t, onOpen() {}
  }))).join(' ');
  assert.match(busy, /update\.available/);

  const idle = textOf(render(React.createElement(api.__test.UpdateHeader, {
    status: { state: 'idle', current: '0.3.1' }, t, onOpen() {}
  }))).join(' ');
  assert.doesNotMatch(idle, /update\.available/);
});

test('the dialog lays out title, version, notes and the two actions', () => {
  const { api, React, render } = createHarness();
  const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);
  const text = textOf(render(React.createElement(api.__test.UpdateDialog, {
    status: {
      state: 'available', current: '0.3.1', latest: '0.4.0',
      notes: '- 修复 A\n- 新增 B', url: 'https://github.com/CM-Silence/dsh-mo-image/releases/tag/v0.4.0'
    },
    t,
    onClose() {},
    onApply() {}
  }))).join(' ');
  assert.match(text, /update\.title/);
  assert.match(text, /0\.3\.1/);
  assert.match(text, /0\.4\.0/);
  assert.match(text, /修复 A/);
  assert.match(text, /新增 B/);
  assert.match(text, /update\.cancel/);
  assert.match(text, /update\.apply/);
});

test('apply registers the overlay toast host', () => {
  const { registrations } = createHarness();
  const overlay = registrations.find(({ definition }) => definition.name === 'shell.overlay');
  assert.ok(overlay, 'missing shell.overlay registration');
  assert.equal(overlay.definition.id, 'mo-image-update-toast');
});

test('pushing a toast keeps only the newest message', () => {
  const { api } = createHarness();
  api.__test.toastQueue.push('update.starting', 'info');
  assert.equal(api.__test.toastQueue.current().text, 'update.starting');
  api.__test.toastQueue.push('update.doneRestart', 'success');
  assert.equal(api.__test.toastQueue.current().text, 'update.doneRestart');
  api.__test.toastQueue.clear();
  assert.equal(api.__test.toastQueue.current(), null);
});

test('a rejected apply surfaces the host error code', async () => {
  const rejected = createHarness({ postResult: { ok: false, code: 'update.localDev' } });
  assert.equal(await rejected.api.__test.postUpdateAction({ action: 'apply' }), 'update.localDev');
  const accepted = createHarness({ postResult: { ok: true } });
  assert.equal(await accepted.api.__test.postUpdateAction({ action: 'apply' }), '');
});

test('the header shows a disabled badge while the update runs', () => {
  const { api, React, render } = createHarness();
  const t = (key) => key;
  const tree = render(React.createElement(api.__test.UpdateHeader, {
    status: { state: 'updating', current: '0.3.1', latest: '0.4.0' }, t, onOpen() {}
  }));
  assert.match(textOf(tree).join(' '), /update\.starting/);
  const buttons = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node.props && node.props.type === 'button') buttons.push(node);
    (node.children || []).forEach(collect);
  };
  collect(tree);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true);
});

test('the dialog closes on Escape', () => {
  const { api, React, render } = createHarness();
  const t = (key) => key;
  let closed = 0;
  const tree = render(React.createElement(api.__test.UpdateDialog, {
    status: { state: 'available', current: '0.3.1', latest: '0.4.0', notes: '' },
    t,
    onClose() { closed += 1; },
    onApply() {}
  }));
  assert.equal(typeof tree.props.onKeyDown, 'function');
  tree.props.onKeyDown({ key: 'Escape' });
  assert.equal(closed, 1);
});

test('the notes area wraps long lines instead of overflowing', () => {
  const { api, React, render } = createHarness();
  const t = (key) => key;
  const long = 'x'.repeat(400);
  const tree = render(React.createElement(api.__test.UpdateDialog, {
    status: { state: 'available', current: '0.3.1', latest: '0.4.0', notes: long },
    t, onClose() {}, onApply() {}
  }));
  const scrollable = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node.props && node.props.style && node.props.style.maxHeight === 320) scrollable.push(node);
    (node.children || []).forEach(collect);
  };
  collect(tree);
  assert.equal(scrollable.length, 1);
  assert.equal(scrollable[0].props.style.overflowWrap, 'anywhere');
  assert.match(textOf(scrollable[0]).join(''), /^x{400}$/);
});

test('the settings section asks the host for update status when it mounts', async () => {
  const harness = createHarness({ status: { ok: true, state: 'available', current: '0.3.1', latest: '0.4.0' } });
  await new Promise((resolve) => setImmediate(resolve));
  const settings = settingsComponent(harness.registrations);
  harness.render(harness.React.createElement(settings.component, settings.definition.inject()));
  for (const effect of harness.effects) {
    try { effect(); } catch (_error) { /* 渲染器里的副作用不参与断言 */ }
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.urls.includes('/api/mo-image/update'), 'settings did not request update status');
});

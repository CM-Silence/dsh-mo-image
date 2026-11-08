import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load(options = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
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
  const urls = [];
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
    fetch: async (url) => {
      urls.push(String(url));
      const payload = options.status || { ok: true, state: 'idle', current: '0.3.1' };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
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
  return { api, urls, React };
}

test('renderUpdateNotes turns release markdown into readable blocks', () => {
  const { api } = load();
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
  const { api } = load();
  const calls = [];
  const t = (key, params) => { calls.push({ key, params }); return key; };

  assert.equal(api.__test.updateToastFor({ state: 'available' }, t), null);
  assert.equal(calls.length, 0);

  assert.equal(api.__test.updateToastFor({ state: 'updating' }, t), 'update.starting');
  assert.equal(api.__test.updateToastFor({ state: 'failed' }, t), 'update.failed');
  assert.equal(api.__test.updateToastFor({ state: 'done', updatedBeforeRestart: false, latest: '0.4.0' }, t), 'update.doneRestart');
  assert.equal(api.__test.updateToastFor({ state: 'done', updatedBeforeRestart: true, latest: '0.4.0' }, t), 'update.done');
  assert.equal(calls.at(-1).key, 'update.done');
  assert.equal(calls.at(-1).params.version, '0.4.0');
});

test('fetchUpdateStatus reads the host route without caching', async () => {
  const { api, urls } = load({ status: { ok: true, state: 'available', current: '0.3.1', latest: '0.4.0' } });
  const status = await api.__test.fetchUpdateStatus();
  assert.equal(status.latest, '0.4.0');
  assert.ok(urls.includes('/api/mo-image/update'));
});

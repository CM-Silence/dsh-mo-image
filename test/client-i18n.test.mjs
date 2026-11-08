import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BUILTIN_LOCALES, BEGIN_MARKER, END_MARKER } from '../scripts/build-locales.mjs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const NS = 'dsh-mo-image';

function loadClient(ctxExtras = {}) {
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
  const registrations = [];
  const slots = {
    inject(_key, callback) { callback(); },
    register(definition, component) {
      registrations.push({ definition, component });
      return () => {};
    }
  };
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    slots,
    ...ctxExtras
  };
  api.apply(ctx);
  return { api, registrations };
}

function fakeLocale(initial = 'zh') {
  const dictionaries = new Map();
  const listeners = new Set();
  const locale = {
    active: initial,
    revision: 0,
    dictionaries,
    register(ns, dicts) {
      dictionaries.set(ns, dicts);
      return () => dictionaries.delete(ns);
    },
    bind(ns) {
      return (key, params) => {
        const dicts = dictionaries.get(ns) || {};
        const chain = [locale.active, ...(locale.active === 'en' ? [] : ['en'])];
        let template = key;
        for (const lang of chain) {
          const hit = dicts[lang] && dicts[lang][key];
          if (typeof hit === 'string') { template = hit; break; }
        }
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
      };
    },
    getSnapshot() { return { active: locale.active, revision: locale.revision, locales: [] }; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setActive(next) {
      locale.active = next;
      locale.revision += 1;
      for (const fn of [...listeners]) fn();
    }
  };
  return locale;
}

test('apply registers all DSH dictionaries under the plugin namespace', () => {
  const locale = fakeLocale();
  const { registrations } = loadClient({ locale });
  assert.equal(registrations.length >= 3, true);
  const section = registrations.find(({ definition }) => definition.name === 'settings.section');
  assert.ok(section);
  // The dictionary registration happens in apply, before any slot registration.
  const injected = section.definition.inject();
  assert.equal(typeof injected.t, 'function');
  assert.equal(injected.t('nav'), '生图模型');
});

test('settings nav label and slot copy follow locale switches', () => {
  const locale = fakeLocale('zh');
  const { registrations } = loadClient({ locale });
  const section = registrations.find(({ definition }) => definition.name === 'settings.section');
  assert.equal(section.definition.label(), '生图模型');
  locale.setActive('en');
  assert.equal(section.definition.label(), 'Image models');
  assert.equal(section.definition.inject().t('section.title'), 'Image models');
  locale.setActive('ja');
  assert.equal(section.definition.label(), '画像生成モデル');
  locale.setActive('ru');
  assert.equal(section.definition.inject().t('seat.menuQuality'), 'Качество');
});

test('the seat receives a translator from the same namespace', () => {
  const locale = fakeLocale('fr');
  const { registrations } = loadClient({ locale });
  const seat = registrations.find(({ definition }) => definition.name === 'conversation.input.right');
  assert.ok(seat);
  const injected = seat.definition.inject();
  assert.equal(injected.t('seat.choose'), "Choisir un modèle d'image");
});

test('apply falls back to Chinese when no locale service is installed', () => {
  const { registrations } = loadClient();
  const section = registrations.find(({ definition }) => definition.name === 'settings.section');
  assert.equal(section.definition.label(), '生图模型');
  assert.equal(section.definition.inject().t('nav'), '生图模型');
});

test('the client keeps no hard-coded CJK string literals outside the generated block', () => {
  const start = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  assert.ok(start >= 0 && end > start, 'locale block markers are missing');
  const outside = source.slice(0, start) + source.slice(source.indexOf('\n', end));
  const cjkLiteral = /(['"`])(?:(?!\1)[^\\\n]|\\.)*?[\u4e00-\u9fff](?:(?!\1)[^\\\n]|\\.)*?\1/g;
  const hits = [...outside.matchAll(cjkLiteral)].map((match) => match[0]);
  assert.deepEqual(hits, []);
});

test('registered dictionaries cover exactly the DSH locales', () => {
  const locale = fakeLocale();
  const seen = [];
  const original = locale.register;
  locale.register = (ns, dicts) => { seen.push({ ns, locales: Object.keys(dicts) }); return original(ns, dicts); };
  loadClient({ locale });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ns, NS);
  assert.deepEqual(seen[0].locales, BUILTIN_LOCALES);
});

test('every key resolves in every DSH locale, and placeholders interpolate', () => {
  const locale = fakeLocale();
  const { registrations } = loadClient({ locale });
  const section = registrations.find(({ definition }) => definition.name === 'settings.section');
  const t = section.definition.inject().t;
  const zhKeys = Object.keys(locale.dictionaries.get(NS).zh);
  for (const active of BUILTIN_LOCALES) {
    locale.setActive(active);
    for (const key of zhKeys) {
      const value = t(key);
      assert.notEqual(value, key, `${active}:${key} did not resolve`);
      assert.ok(value.length > 0, `${active}:${key} is empty`);
    }
    assert.match(t('picker.filtered', { count: 3 }), /3/);
  }
});

test('server network errors are composed in the active language without proxy advice', () => {
  const locale = fakeLocale('en');
  const { api, registrations } = loadClient({ locale });
  const t = registrations.find(({ definition }) => definition.name === 'settings.section').definition.inject().t;
  const error = {
    code: 'network.failed',
    params: {
      host: 'api.openai.com', cause: 'UND_ERR_CONNECT_TIMEOUT',
      via: 'direct', hint: 'timeout'
    }
  };
  const english = api.__test.serverErrorText(t, error);
  assert.equal(english, 'Network request failed: api.openai.com UND_ERR_CONNECT_TIMEOUT (direct). TCP connection timed out.');
  assert.doesNotMatch(english, /proxy|HTTPS_PROXY/i);

  locale.setActive('zh');
  const chinese = api.__test.serverErrorText(t, error);
  assert.equal(chinese, '网络请求失败：api.openai.com UND_ERR_CONNECT_TIMEOUT，直连。TCP 连接超时。');
  assert.doesNotMatch(chinese, /代理|HTTPS_PROXY/);
});

test('indirect failures only say the system network configuration was used', () => {
  const locale = fakeLocale('fr');
  const { api, registrations } = loadClient({ locale });
  const t = registrations.find(({ definition }) => definition.name === 'settings.section').definition.inject().t;
  const text = api.__test.serverErrorText(t, {
    code: 'network.failed',
    params: { host: 'api.example.com', cause: 'ECONNRESET', via: 'proxy', hint: 'connection' }
  });
  assert.match(text, /via la configuration réseau du système/);
  assert.match(text, /Connexion refusée ou réinitialisée/);
  assert.doesNotMatch(text, /proxy|代理|127\.0\.0\.1|HTTPS_PROXY/i);
});

test('upstream HTTP, provider and config codes use their localized templates', () => {
  const locale = fakeLocale('de');
  const { api, registrations } = loadClient({ locale });
  const t = registrations.find(({ definition }) => definition.name === 'settings.section').definition.inject().t;
  assert.match(api.__test.serverErrorText(t, {
    code: 'upstream.http',
    params: { status: 502, detail: 'upstream exploded' }
  }), /HTTP 502.*upstream exploded/);
  assert.match(api.__test.serverErrorText(t, {
    code: 'provider.missingKeyWithRef',
    params: { provider: 'Test', ref: 'MO_IMAGE_TEST_API_KEY' }
  }), /„Test“.*MO_IMAGE_TEST_API_KEY/);
  assert.match(api.__test.serverErrorText(t, {
    code: 'config.credentialSaveFailed',
    params: { message: 'vault offline' }
  }), /vault offline/);
});

test('unknown server codes fall back to the raw message', () => {
  const locale = fakeLocale('en');
  const { api, registrations } = loadClient({ locale });
  const t = registrations.find(({ definition }) => definition.name === 'settings.section').definition.inject().t;
  assert.equal(api.__test.serverErrorText(t, { code: 'not.declared', params: {}, message: '原始报错' }), '原始报错');
});

test('browser fetch failures and timeouts get localized fallbacks', () => {
  const locale = fakeLocale('en');
  const { api, registrations } = loadClient({ locale });
  const t = registrations.find(({ definition }) => definition.name === 'settings.section').definition.inject().t;
  assert.match(api.__test.serverErrorText(t, new TypeError('Failed to fetch')), /Could not reach the plugin's local service/);
  assert.match(api.__test.serverErrorText(t, Object.assign(new Error('aborted'), { name: 'AbortError' })), /local service timed out/);
  locale.setActive('zh');
  assert.match(api.__test.serverErrorText(t, new TypeError('Failed to fetch')), /无法连接插件的本地服务/);
});

test('responseError preserves the route code and params', () => {
  const locale = fakeLocale('en');
  const { api, registrations } = loadClient({ locale });
  const t = registrations.find(({ definition }) => definition.name === 'settings.section').definition.inject().t;
  const error = api.__test.responseError({
    error: 'raw host message',
    code: 'network.failed',
    params: { host: 'api.openai.com' }
  }, 502, 'errors.fetchModels', t);
  assert.equal(error.message, 'raw host message');
  assert.equal(error.code, 'network.failed');
  assert.deepEqual(error.params, { host: 'api.openai.com' });
});

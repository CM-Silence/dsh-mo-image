import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Hook positions are centralized here; tests seed state by name so a hook
// insertion only changes this table.
const HOOK = { open: 2, pane: 3, view: 4, subProvider: 5, message: 10, menuPos: 14, fast: 17 };
function seed(values) {
  return new Map(Object.entries(values).map(([key, value]) => [HOOK[key], value]));
}

function loadClient(markers = {}) {
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
        hooks[index] = overrides.has(index)
          ? overrides.get(index)
          : (typeof initial === 'function' ? initial() : initial);
      }
      return [hooks[index], () => {}];
    },
    useEffect(fn) { hooks[hookIndex++] = fn; },
    useLayoutEffect(fn) { hooks[hookIndex++] = fn; },
    useMemo(fn) { hookIndex++; return fn(); },
    useCallback(fn) { hookIndex++; return fn(); },
    useRef(value) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = { current: value };
      return hooks[index];
    }
  };

  const document = {
    querySelectorAll(selector) {
      if (selector === 'style' && (markers.codex || markers.codexPartial || markers.codexCssBlocked)) return [{ textContent: '.cmes-popover{color:red}', getAttribute() { return ''; } }];
      if (selector === '.cmes-trigger' && markers.codex) return [{ closest() { return null; } }];
      if (selector === '.cmes-trigger' && markers.codexPartial) return [{
        closest(selectorName) {
          if (selectorName === '[data-mo-image-seat]') return null;
          if (selectorName === '.cmes-root') {
            return {
              querySelector(child) {
                if (child === '.cmes-popover') return { nodeName: 'SECTION', style: { position: 'fixed' } };
                return null;
              }
            };
          }
          return null;
        }
      }];
      if (selector === '.cmes-trigger' && markers.codexCssBlocked) return [{
        closest(selectorName) {
          if (selectorName === '[data-mo-image-seat]') return null;
          if (selectorName === '.cmes-root') {
            return {
              querySelector(child) {
                if (child === '.cmes-popover' || child === '.cmes-page') return { nodeName: 'DIV' };
                return null;
              }
            };
          }
          return null;
        }
      }];
      if (selector === '.cmes-trigger' && markers.selfCodex) return [{ closest() { return {}; } }];
      return [];
    },
    querySelector(selector) {
      if (selector === '.cmes-trigger' && markers.codex) return { nodeName: 'BUTTON' };
      if (selector === '[data-model-id]' && markers.official) return { nodeName: 'SPAN', closest() { return null; } };
      return null;
    },
    getElementById() { return null; },
    createElement() { return { id: '', textContent: '', parentNode: null }; },
    head: { appendChild() {} },
    body: {},
    styleSheets: [],
    adoptedStyleSheets: []
  };
  const window = {
    __ModuleLoader__: { load(definition) { loaded = definition; } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle() { return { position: markers.codexCssBlocked ? 'static' : 'fixed' }; }
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
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
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

  function renderElement(node) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(renderElement);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      hooks = [];
      hookIndex = 0;
      return renderElement(node.type(node.props || {}));
    }
    return {
      type: node.type,
      props: node.props || {},
      children: (node.children || []).map(renderElement)
    };
  }

  return {
    __test: api.__test,
    render(node, overrideMap) {
      overrides = overrideMap || new Map();
      return renderElement(node);
    },
    renderSeat(overrideMap) {
      let seat = null;
      const slots = {
        inject(_key, callback) { callback(); },
        register(definition, component) {
          if (definition && definition.id === 'mo-image-model-seat') seat = component;
          return () => {};
        }
      };
      api.apply({
        locale: undefined,
        effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
        slots
      });
      assert.equal(typeof seat, 'function');
      overrides = overrideMap || new Map();
      hooks = [];
      hookIndex = 0;
      return renderElement(seat({ t: ct }));
    },
    h: React.createElement
  };
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) collectText(item, out); return out; }
  for (const child of node.children || []) collectText(child, out);
  return out;
}

function collectClass(node, className, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const item of node) collectClass(item, className, out); return out; }
  if (typeof node !== 'object') return out;
  if (node.props && typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).includes(className)) out.push(node);
  for (const child of node.children || []) collectClass(child, className, out);
  return out;
}

const messages = {
  'seat.auto': '自动',
  'seat.fallback': '生图模型',
  'seat.menuModel': '模型',
  'seat.menuQuality': '质量',
  'seat.menuSize': '尺寸',
  'seat.settingsAria': '生图设置',
  'seat.moreSettings': '其他设置',
  'seat.promptSection': '提示词',
  'seat.menuPromptOptimization': '提示词优化',
  'seat.fast': '快速预览',
  'seat.notSelected': '未选择',
  'seat.on': '开',
  'seat.off': '关',
  'seat.sizeAutoValue': '自动',
  'seat.sizeAutoHint': '自动尺寸，交给模型决定',
  'seat.width': '宽',
  'seat.height': '高',
  'seat.searchPlaceholder': '搜索模型',
  'seat.noMatches': '没有匹配的模型',
  'seat.empty': '还没有模型，去“设置 → 生图模型”添加',
  'seat.qualityUnsupported': '此模型未提供质量档位',
  'seat.qualityWarning': '更快消耗使用额度',
  'seat.levelsCount': '{count} 档',
  'seat.levelsNone': '不支持',
  'seat.sizeTitle': '尺寸',
  'seat.back': '返回',
  'seat.modelAutoHint': '让模型自己挑一个',
  'quality.off': '关闭',
  'quality.low': '低',
  'quality.medium': '中',
  'quality.high': '高',
  'quality.max': '最高',
  'quality.standard': '标准',
  'quality.hd': '高清',
  'quality.default': '默认',
  'quality.quality': '高质量',
  'quality.turbo': '极速',
  'quality.auto': '自动'
};

function ct(key, params) {
  const template = messages[key] || key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name]));
}

function storeFixture(overrides = {}) {
  return {
    providers: [{
      id: 'p1', name: 'OpenAI', baseUrl: 'https://api.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'],
      names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true },
    ...overrides
  };
}

const railSpec = {
  label: '质量',
  default: 'high',
  options: [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' }
  ]
};

test('quality rail levels preserve the adapter order and never invent stops', () => {
  const { __test } = loadClient();
  assert.deepEqual(
    Array.from(__test.qualityRailLevels(railSpec), (level) => level.value),
    ['off', 'low', 'medium', 'high', 'max']
  );
  assert.equal(__test.qualityRailLevels(null).length, 0);
  assert.equal(__test.qualityRailLevels({ options: [] }).length, 0);
});

test('quality rail levels keep Auto next to Off instead of at the top end', () => {
  const { __test } = loadClient();
  const ordered = Array.from(__test.qualityRailLevels({
    options: [
      { value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'auto' }
    ]
  }), (level) => level.value);
  assert.deepEqual(ordered, ['off', 'auto', 'low', 'medium', 'high']);
});

test('quality values map onto the codex effort palette', () => {
  const { __test } = loadClient();
  assert.equal(__test.qualityBucketOf('off'), 'off');
  assert.equal(__test.qualityBucketOf('turbo'), 'minimal');
  assert.equal(__test.qualityBucketOf('hd'), 'xhigh');
  assert.equal(__test.qualityBucketOf('quality'), 'xhigh');
  assert.equal(__test.qualityBucketOf('max'), 'max');
  assert.equal(__test.qualityBucketOf('auto'), null);
});

test('both skins agree on the no-model trigger label', () => {
  const { __test } = loadClient();
  const view = __test.deriveSeatView({
    providers: [],
    active: { providerId: '', model: 'auto' },
    defaults: {}
  }, ct);
  assert.equal(view.hasAnyModel, false);
  assert.equal(view.activeModelName, '');
  assert.equal(view.triggerLabel, '生图模型');
});

test('the empty provider page reserves the upstream 48px empty row', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: { providers: [], active: { providerId: '', model: '' }, defaults: {} },
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', menuPos: { left: 100, bottom: 50 } })
  );
  const popover = collectClass(tree, 'cmes-popover')[0];
  assert.equal(popover.props.style.height, '98px');
});

test('skin markers pick codex over official over generic', () => {
  const { __test } = loadClient();
  assert.equal(__test.detectSeatSkinFromMarkers({ codex: true, official: true, generic: true }), 'codex');
  assert.equal(__test.detectSeatSkinFromMarkers({ official: true, generic: true }), 'official');
  assert.equal(__test.detectSeatSkinFromMarkers({ generic: true }), 'generic');
  assert.equal(__test.detectSeatSkinFromMarkers({}), 'official');
});

test('detectSeatSkin reads the live codex and official DOM markers', () => {
  assert.equal(loadClient({ codex: true }).__test.detectSeatSkin(), 'codex');
  assert.equal(loadClient({ official: true }).__test.detectSeatSkin(), 'official');
  assert.equal(loadClient({}).__test.detectSeatSkin(), 'official');
  assert.equal(loadClient({ selfCodex: true }).__test.detectSeatSkin(), 'official');
});

test('a codex trigger with an incomplete DOM contract falls back to official', () => {
  const client = loadClient({ codexPartial: true });
  assert.equal(client.__test.codexSkinProbe().present, true);
  assert.equal(client.__test.codexSkinProbe().ready, false);
  assert.equal(client.__test.detectSeatSkin(), 'official');
});

test('a codex trigger whose CSS is not actually fixed falls back to official', () => {
  const client = loadClient({ codexCssBlocked: true });
  assert.equal(client.__test.codexSkinProbe().present, true);
  assert.equal(client.__test.codexSkinProbe().ready, false);
  assert.equal(client.__test.detectSeatSkin(), 'official');
});

test('the seat switches to the codex renderer when the chat seat is codex', () => {
  const codexTree = loadClient({ codex: true }).renderSeat();
  assert.equal(collectClass(codexTree, 'cmes-trigger').length, 1);
  assert.equal(collectClass(codexTree, 'cmes-root').length >= 1, true);
  const officialTree = loadClient({ official: true }).renderSeat();
  assert.equal(collectClass(officialTree, 'cmes-root').length, 0);
});

test('generic skin only copies paint and layout keys from the host trigger', () => {
  const { __test } = loadClient();
  const style = __test.pickTriggerStyle({
    height: '26px', paddingLeft: '6px', color: 'rgb(1, 2, 3)',
    fontSize: '12px', outline: 'none', border: '1px solid red'
  });
  assert.equal(style.height, '26px');
  assert.equal(style.paddingLeft, '6px');
  assert.equal(style.color, 'rgb(1, 2, 3)');
  assert.equal(style.fontSize, '12px');
  assert.equal(style.outline, undefined);
  assert.equal(style.border, undefined);
  assert.equal(__test.pickTriggerStyle(null), null);
});

test('codex placement aligns to the trigger right edge and stacks above it', () => {
  const { __test } = loadClient();
  const right = __test.codexPlacement(
    { left: 1000, top: 700, width: 30, height: 28 },
    { width: 1200, height: 800 },
    272,
    12
  );
  assert.equal(right.left, 758);
  assert.equal(right.bottom, 108);

  const left = __test.codexPlacement(
    { left: 100, top: 700, width: 30, height: 28 },
    { width: 1200, height: 800 },
    272,
    12
  );
  assert.equal(left.left, 12);
});

test('codex sparkle dust is deterministic and stays inside the rail', () => {
  const { __test } = loadClient();
  const first = __test.buildCodexSparkles(6);
  const second = __test.buildCodexSparkles(6);
  assert.deepEqual(first, second);
  assert.equal(first.length, 6);
  for (const mote of first) {
    const top = Number.parseFloat(mote.top);
    assert.ok(top >= 8 && top <= 92, `top ${mote.top}`);
    assert.ok(Number.parseFloat(mote.b) >= 0.5 && Number.parseFloat(mote.b) <= 1, `b ${mote.b}`);
  }
});

test('the codex trigger shows the image model and the quality label', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: false, pane: 'quality' })
  );
  assert.equal(collectClass(tree, 'cmes-trigger').length, 1);
  const text = collectText(tree).join(' ');
  assert.match(text, /gpt-image-2\.5-flare/);
  assert.match(text, /高/);
});

test('the open codex quality pane renders one tick per quality level', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'quality' })
  );
  assert.equal(collectClass(tree, 'cmes-rail').length, 1);
  assert.equal(collectClass(tree, 'cmes-dot').length, 5);
  const text = collectText(tree).join(' ');
  assert.match(text, /更快消耗/);
});

test('the codex model pane starts on the provider list and offers Auto', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models' })
  );
  const text = collectText(tree).join(' ');
  assert.match(text, /OpenAI/);
  assert.match(text, /自动/);
  assert.equal(collectClass(tree, 'cmes-row').length >= 2, true);
});

test('a model without a quality spec says so instead of drawing a fake rail', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: null
    }),
    seed({ open: true, pane: 'quality' })
  );
  const text = collectText(tree).join(' ');
  assert.match(text, /此模型未提供质量档位/);
  assert.equal(collectClass(tree, 'cmes-rail').length, 0);
});

test('the codex provider list hides Auto when nothing is configured', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: {
        providers: [],
        active: { providerId: '', model: '' },
        defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
      },
      setStore() {},
      qualitySpec: null
    }),
    seed({ open: true, pane: 'models' })
  );
  const text = collectText(tree).join(' ');
  assert.doesNotMatch(text, /(^|\s)自动(\s|$)/);
  assert.match(text, /还没有模型/);
});

test('the peak quality lights the codex violet treatment and its dust', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture({
        defaults: { quality: 'max', auto: true, width: 1024, height: 1024, promptOptimization: true }
      }),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'quality' })
  );
  const popovers = collectClass(tree, 'cmes-popover');
  assert.equal(popovers.length, 1);
  assert.match(popovers[0].props.className, /peak/);
  assert.equal(collectClass(tree, 'cmes-sp').length, 22);
});

test('the highest stop animates even when its id is not a quota peak', () => {
  const client = loadClient();
  const four = {
    options: [
      { value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }
    ]
  };
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture({
        defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
      }),
      setStore() {},
      qualitySpec: four
    }),
    seed({ open: true, pane: 'quality' })
  );
  const popovers = collectClass(tree, 'cmes-popover');
  assert.match(popovers[0].props.className, /peak/);
  assert.doesNotMatch(popovers[0].props.className, /message/);
});

test('opening a provider flips the viewport into the slide state', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: 'p1' })
  );
  const viewport = collectClass(tree, 'cmes-viewport')[0];
  assert.match(viewport.props.className, /view2/);
  const pages = collectClass(tree, 'cmes-page');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].props.style.transition, 'transform .3s ease');
  const text = collectText(tree).join(' ');
  assert.match(text, /OpenAI/);
  assert.match(text, /gpt-image-2\.5-flare/);
});

test('the size tool opens a second page with auto and both sides', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: '__size' })
  );
  const text = collectText(tree).join(' ');
  assert.match(text, /其他设置/);
  assert.doesNotMatch(text, /自动尺寸，交给模型决定/);
  assert.match(text, /提示词优化/);
  assert.match(text, /宽/);
  assert.match(text, /高/);
});

test('other settings groups size and prompt and scrolls', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: '__size' })
  );
  const text = collectText(tree).join(' ');
  assert.match(text, /其他设置/);
  assert.match(text, /尺寸/);
  assert.match(text, /提示词/);
  assert.match(text, /提示词优化/);
  assert.equal(collectClass(tree, 'cmes-rows').length >= 2, true);
  const reset = collectClass(tree, 'cmes-reset')[0];
  assert.equal(reset.props.title, '其他设置');
});

test('the Fast bolt has no hover tooltip', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec,
      sessionId: 's1'
    }),
    seed({ open: true, pane: 'quality', fast: true })
  );
  assert.equal(collectClass(tree, 'cmes-tip').length, 0);
});

test('the codex portal is above the composer and keeps its last position when closed', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: false, pane: 'quality', menuPos: { left: 900, bottom: 50 } })
  );
  const roots = collectClass(tree, 'cmes-root');
  const portal = roots.find((node) => node.props && node.props.style && node.props.style.position === 'fixed');
  assert.ok(portal);
  assert.equal(portal.props.style.zIndex, 2147482000);
  const popover = collectClass(tree, 'cmes-popover')[0];
  assert.equal(popover.props.style.left, '900px');
  assert.equal(popover.props.style.bottom, '50px');
});

test('Fast adds the codex fast-mode class and the trigger bolt', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec,
      sessionId: 's1'
    }),
    seed({ open: true, pane: 'quality', fast: true })
  );
  const popovers = collectClass(tree, 'cmes-popover');
  assert.equal(popovers.length, 1);
  assert.match(popovers[0].props.className, /fast-mode/);
  assert.equal(collectClass(tree, 'cmes-bolt').length, 1);
});

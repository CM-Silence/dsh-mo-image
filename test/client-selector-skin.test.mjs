import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Hook positions are centralized here; tests seed state by name so a hook
// insertion only changes this table.
const HOOK = { open: 2, pane: 3, view: 4, subProvider: 5, message: 10, menuPos: 14, tip: 17 };
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
      if (selector === '.cmes-popover' && (markers.codex || markers.codexPartial || markers.codexCssBlocked)) return [{
        id: 'cmes-popover',
        nodeName: 'SECTION',
        closest() { return null; },
        querySelector(child) {
          if (child === '.cmes-page' && !markers.codexPartial) return { nodeName: 'DIV' };
          return null;
        }
      }];
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

function collectType(node, type, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const item of node) collectType(item, type, out); return out; }
  if (typeof node !== 'object') return out;
  if (node.type === type) out.push(node);
  for (const child of node.children || []) collectType(child, type, out);
  return out;
}

const messages = {
  'seat.auto': '自动',
  'seat.fallback': '生图模型',
  'seat.menuModel': '模型',
  'seat.chooseModel': '切换模型',
  'seat.menuQuality': '质量',
  'seat.menuSize': '尺寸',
  'seat.sizeAspect': '比例',
  'seat.sizeTier': '档位',
  'seat.sizePreset': '预设',
  'seat.sizeCustom': '自定义',
  'seat.width': '宽',
  'seat.height': '高',
  'seat.sizeAutoValue': '自动尺寸',
  'seat.sizeStrict': '严格',
  'seat.back': '返回',
  'seat.settingsAria': '生图设置',
  'seat.moreSettings': '其他设置',
  'seat.menuPromptOptimization': '提示词优化',
  'seat.promptOptimizationUsage': '用量更多',
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
  assert.equal(popover.props.style['--cmes-height'], '98px');
});

test('entering a provider page does not steal focus mid-slide', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /view !== 2 \|\| isSettingsPage/,
    'no delayed search focus tied to the page transition');
  assert.doesNotMatch(source, /searchRef\.current\.focus\(\)/,
    'focus calls opt out of scrolling');
});

test('the provider page header says 切换模型', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', menuPos: { left: 100, bottom: 50 } })
  );
  const section = collectClass(tree, 'cmes-sec')[0];
  assert.equal(section.children[0], '切换模型');
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
  assert.equal(collectClass(tree, 'cmes-dot').length, 10);
  assert.equal(collectClass(tree, 'cmes-tickOverlay').length, 1);
  assert.equal(collectClass(tree, 'cmes-tickMotion').length, 1);
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
  assert.equal(collectClass(tree, 'cmes-sp').length, 22, 'one dust field carries 22 sparkles');
  assert.equal(collectClass(tree, 'cmes-sp-path').length, 22, 'each sparkle travels on its own path');
  const phases = collectClass(tree, 'cmes-sp-path').map((node) => Number(node.props.style['--phase']));
  assert.ok(phases.every((phase) => phase > 0 && phase < 1), 'paths start at deterministic phases');
  const dust = collectClass(tree, 'cmes-sp')[0];
  assert.match(dust.props.style['--sp-top'], /%$/, 'the dust carries its rail inset');
  assert.match(dust.props.style['--dur'], /s$/, 'the dust carries its float duration');
  assert.equal(dust.props.style.left, undefined, 'horizontal travel comes from the path, not the mote');
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

test('the highest quality stop reads Ultra even when its backend id is high', () => {
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
  const text = collectText(tree).join(' ');
  assert.match(text, /Ultra/);
  assert.doesNotMatch(text, /最高/);
});

test('the codex rail hue climbs toward violet with the quality stop', () => {
  const client = loadClient();
  const expected = {
    off: '#8a8a8f',
    low: '#3a83f7',
    medium: '#4a72f2',
    high: '#5f5ce8',
    max: '#914ef6'
  };
  for (const [quality, fill] of Object.entries(expected)) {
    const tree = client.render(
      client.h(client.__test.CodexImageSeat, {
        t: ct,
        store: storeFixture({
          defaults: { quality, auto: true, width: 1024, height: 1024, promptOptimization: true }
        }),
        setStore() {},
        qualitySpec: railSpec
      }),
      seed({ open: true, pane: 'quality' })
    );
    const rail = collectClass(tree, 'cmes-rail')[0];
    assert.equal(rail.props.style['--cmes-fill'], fill, `${quality} uses the codex fill`);
  }
});

test('a lower ultra keeps the highest stop name', () => {
  const client = loadClient();
  const withLowerUltra = {
    options: [
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra' },
      { value: 'max', label: 'Max Ultra' }
    ]
  };
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture({
        defaults: { quality: 'max', auto: true, width: 1024, height: 1024, promptOptimization: true }
      }),
      setStore() {},
      qualitySpec: withLowerUltra
    }),
    seed({ open: true, pane: 'quality' })
  );
  const text = collectText(tree).join(' ');
  assert.match(text, /Max Ultra/);
});

test('the highest quality stop reads Ultra in the codex peak ink', () => {
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
  const text = collectText(tree).join(' ');
  assert.match(text, /Ultra/);
  assert.doesNotMatch(text, /最高/);
  const popover = collectClass(tree, 'cmes-popover')[0];
  assert.equal(popover.props.style['--cmes-ink'], '#8b46ee', 'the heading inherits the violet Ultra ink');
  const trigger = collectClass(tree, 'cmes-trigger')[0];
  assert.equal(trigger.props.style['--cmes-ink'], '#8b46ee', 'the collapsed trigger uses the same violet ink');
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
  assert.equal(viewport.props.style.transition, 'height .3s cubic-bezier(.32,.72,.28,1)');
  const pages = collectClass(tree, 'cmes-page');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].props.style.transition, 'transform .3s cubic-bezier(.32,.72,.28,1)');
  assert.equal(pages[0].props.style.transform, 'translateX(-100%)');
  assert.equal(pages[1].props.style.transition, 'transform .3s cubic-bezier(.32,.72,.28,1)');
  assert.equal(pages[1].props.style.transform, 'translateX(0)');
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
  assert.match(text, /宽/);
  assert.match(text, /高/);
  assert.equal(
    collectType(tree, 'input').filter((input) => input.props['aria-label'] === ct('seat.menuPromptOptimization')).length,
    0,
    'the settings page has no prompt optimization checkbox'
  );
});

test('the settings page follows the active model shape even without a provider submenu', () => {
  const client = loadClient();
  // 设置页没有 provider 上下文（subProvider === '__size'），能力必须回到当前生效的提供商；
  // 模型是 auto 时取该提供商的第一张模型，否则面板会退化成只剩宽高。
  client.__test.applyCatalog({
    capabilities: [{
      providerId: 'p1',
      models: [{
        model: 'gemini-nano-banana-2.1',
        size: { control: 'aspect', aspects: ['1:1', '16:9'], tiers: [{ value: '1K' }, { value: '2K' }], custom: false, wire: ['aspect'], stitch: false, hint: '' }
      }]
    }]
  });
  const store = storeFixture({
    providers: [{
      id: 'p1', name: 'APIYI', baseUrl: 'https://api.apiyi.com/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gemini-nano-banana-2.1'], names: {}
    }],
    active: { providerId: 'p1', model: 'gemini-nano-banana-2.1' }
  });
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: store,
      setStore() {},
      qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: '__size' })
  );
  const text = collectText(tree).join(' ');
  assert.match(text, /比例/, 'the ratio row must appear for a ratio model');
  assert.match(text, /档位/, 'the tier row must appear when the model has tiers');
  assert.equal(
    collectType(tree, 'input').filter((input) => input.props['aria-label'] === ct('seat.width')).length,
    0,
    'a ratio model has no width input'
  );
});

test('the size rows carry an instant help marker', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct, store: storeFixture(), setStore() {}, qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: '__size' })
  );
  const marks = collectClass(tree, 'cmes-rowName')
    .flatMap((node) => node.children || [])
    .filter((child) => child && child.props && child.props.role === 'img');
  assert.ok(marks.length >= 2, 'auto and strict each get a help marker');
  const hover = { getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 24 }), };
  // 悬停立刻出现，没有任何定时器
  marks[0].props.onPointerEnter({ currentTarget: hover });
  const after = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct, store: storeFixture(), setStore() {}, qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: '__size' })
  );
  assert.ok(after, 'render survives the hover handler');
});
test('the codex size rows open a menu page instead of a select', () => {
  const client = loadClient();
  client.__test.applyCatalog({
    capabilities: [{
      providerId: 'p1',
      models: [{
        model: 'gemini-nano-banana-2.1',
        size: { control: 'aspect', aspects: ['1:1', '16:9'], tiers: [{ value: '1K' }, { value: '2K' }], custom: false, wire: ['aspect'], stitch: false, hint: '' }
      }]
    }]
  });
  const store = storeFixture({
    providers: [{
      id: 'p1', name: 'APIYI', baseUrl: 'https://api.apiyi.com/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gemini-nano-banana-2.1'], names: {}
    }],
    active: { providerId: 'p1', model: 'gemini-nano-banana-2.1' },
    defaults: { quality: 'high', auto: false, width: 1024, height: 1024, aspect: '16:9', tier: '1K', promptOptimization: true }
  });
  const renderSettings = (subProvider) => client.render(
    client.h(client.__test.CodexImageSeat, { t: ct, store: store, setStore() {}, qualitySpec: railSpec }),
    seed({ open: true, pane: 'models', view: 2, subProvider: subProvider })
  );
  const settings = renderSettings('__size');
  assert.equal(collectType(settings, 'select').length, 0, 'no native select anywhere in the size page');
  const ratioRow = collectType(settings, 'button').find((node) => collectText(node).join(' ').includes(ct('seat.sizeAspect')));
  assert.ok(ratioRow, 'the ratio row is a menu button');
  ratioRow.props.onClick({ currentTarget: { focus() {} }, preventDefault() {}, stopPropagation() {} });

  const list = renderSettings('__size-aspect');
  assert.match(collectText(list).join(' '), /16:9/, 'the second level lists the ratios');
  assert.equal(collectType(list, 'select').length, 0);
});
test('the preset page labels the custom entry in both skins', () => {
  const client = loadClient();
  // 预设类模型的档位列表后面会追加一条「自定义」，它和档位值的类型不同；
  // 这里锁住渲染结果：行上必须显示本地化文案，不能把对象拼成字符串。
  client.__test.applyCatalog({
    capabilities: [{
      providerId: 'p1',
      models: [{
        model: 'doubao-seedream-4.5',
        size: { control: 'preset', tiers: [{ value: '2K' }, { value: '4K' }], custom: true, wire: ['size'], stitch: false, hint: '' }
      }]
    }]
  });
  let saved = null;
  const store = storeFixture({
    providers: [{
      id: 'p1', name: 'Ark', baseUrl: 'https://ark.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['doubao-seedream-4.5'], names: {}
    }],
    active: { providerId: 'p1', model: 'doubao-seedream-4.5' },
    defaults: { quality: 'high', auto: false, width: 1024, height: 1024, preset: '2K', promptOptimization: true }
  });
  const renderPage = (subProvider) => client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct, store: store, setStore(next) { saved = next; }, qualitySpec: railSpec
    }),
    seed({ open: true, pane: 'models', view: 2, subProvider: subProvider })
  );
  const list = renderPage('__size-preset');
  const text = collectText(list).join(' ');
  assert.match(text, /2K/);
  assert.match(text, /4K/);
  assert.match(text, new RegExp(ct('seat.sizeCustom')), 'the custom entry keeps its localized label');
  assert.doesNotMatch(text, /\[object Object\]/);
  const customRow = collectType(list, 'button')
    .find((node) => collectText(node).join(' ').includes(ct('seat.sizeCustom')));
  assert.ok(customRow, 'the custom entry is a selectable row');
  // 原生皮肤走的是另一套面板（OfficialImageSeat），同一条「自定义」也要有标签。
  const native = client.render(
    client.h(client.__test.OfficialImageSeat, { t: ct, store: store, setStore(next) { saved = next; } }),
    new Map([[0, true], [1, 'size-preset']])
  );
  const nativeText = collectText(native).join(' ');
  assert.match(nativeText, /4K/, 'the native panel lists the model tiers');
  assert.match(nativeText, new RegExp(ct('seat.sizeCustom')), 'the native panel keeps the same label');
  assert.doesNotMatch(nativeText, /\[object Object\]/);
  customRow.props.onClick();
  assert.equal(saved.defaults.preset, '__custom', 'picking the custom entry stores its sentinel');
});

test('the preset rows hide the width and height unless custom is selected', () => {
  const client = loadClient();
  client.__test.applyCatalog({
    capabilities: [{
      providerId: 'p1',
      models: [{
        model: 'doubao-seedream-4.5',
        size: { control: 'preset', tiers: [{ value: '2K' }, { value: '4K' }], custom: true, wire: ['size'], stitch: false, hint: '' }
      }]
    }]
  });
  const storeFor = (preset) => storeFixture({
    providers: [{
      id: 'p1', name: 'Ark', baseUrl: 'https://ark.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['doubao-seedream-4.5'], names: {}
    }],
    active: { providerId: 'p1', model: 'doubao-seedream-4.5' },
    defaults: { quality: 'high', auto: false, width: 1024, height: 1024, preset: preset, promptOptimization: true }
  });
  const sides = (tree) => collectType(tree, 'input')
    .filter((input) => input.props['aria-label'] === ct('seat.width') || input.props['aria-label'] === ct('seat.height'));
  const codexPage = (preset) => client.render(
    client.h(client.__test.CodexImageSeat, { t: ct, store: storeFor(preset), setStore() {}, qualitySpec: railSpec }),
    seed({ open: true, pane: 'models', view: 2, subProvider: '__size' })
  );
  const nativePage = (preset) => client.render(
    client.h(client.__test.OfficialImageSeat, { t: ct, store: storeFor(preset), setStore() {} }),
    new Map([[0, true], [1, 'size']])
  );
  // 档位就是最终尺寸，宽高在这时没有输入的意义，不该占两行。
  assert.equal(sides(codexPage('2K')).length, 0, 'a tier preset hides both sides in the codex panel');
  assert.equal(sides(nativePage('2K')).length, 0, 'a tier preset hides both sides in the native panel');
  assert.equal(sides(codexPage('__custom')).length, 2, 'the custom preset brings both sides back in the codex panel');
  assert.equal(sides(nativePage('__custom')).length, 2, 'the custom preset brings both sides back in the native panel');
});

test('other settings keeps only size controls', () => {
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
  assert.equal(
    collectType(tree, 'input').filter((input) => input.props['aria-label'] === ct('seat.menuPromptOptimization')).length,
    0,
    'the settings page has no prompt optimization checkbox'
  );
  assert.equal(collectClass(tree, 'cmes-rows').length >= 1, true);
  const reset = collectClass(tree, 'cmes-reset')[0];
  assert.equal(reset.props.title, undefined, 'the native title is replaced by the instant tip');
  assert.equal(typeof reset.props.onPointerEnter, 'function', 'hover shows the instant tip');
});

test('the prompt optimization star shows the quota hint and toggles the real default', () => {
  const client = loadClient();
  let saved = null;
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore(next) { saved = next; },
      qualitySpec: railSpec,
      sessionId: 's1'
    }),
    seed({ open: true, pane: 'quality' })
  );
  const star = collectClass(tree, 'cmes-star');
  assert.ok(star.length >= 1, 'the prompt optimization star is rendered');
  const starButton = collectClass(tree, 'cmes-fast')[0];
  assert.ok(starButton, 'the star is the fast-slot button');
  assert.equal(starButton.props.title, undefined, 'the native title is replaced by the codex tooltip');
  assert.equal(starButton.props['aria-label'], '提示词优化');
  assert.equal(starButton.props['aria-describedby'], 'mo-image-prompt-tip');
  assert.equal(starButton.props['aria-pressed'], true);
  const tip = collectClass(tree, 'cmes-tip')[0];
  assert.ok(tip, 'the codex tooltip is rendered next to the popover');
  assert.match(tip.props.className, /cmes-tip/);
  assert.doesNotMatch(tip.props.className, /show/);
  assert.equal(collectClass(tree, 'cmes-tipTitle').length, 1);
  const text = collectText(tree).join(' ');
  assert.match(text, /提示词优化/);
  assert.match(text, /用量更多/);
  const starPath = star[0].children[0].props.d;
  assert.match(starPath, /^M12 3\.5/, 'the icon uses the three-sparkle AI cluster');
  assert.equal(star[0].children.length, 3, 'large sparkle plus two small ones');
  assert.equal(star[0].props.style.display, 'block');
  assert.equal(starButton.props.style.justifyContent, 'center', 'the icon is centered in its button');
  assert.equal(starButton.props.style.alignItems, 'center');
  starButton.props.onClick();
  assert.equal(saved.defaults.promptOptimization, false, 'clicking the star writes the real default');
});

test('hover shows the two-line codex tooltip card', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec,
      sessionId: 's1'
    }),
    seed({ open: true, pane: 'quality', tip: true })
  );
  const tip = collectClass(tree, 'cmes-tip')[0];
  assert.match(tip.props.className, /cmes-tip show/);
  assert.equal(tip.props.role, 'tooltip');
  assert.equal(tip.props.id, 'mo-image-prompt-tip');
  const lines = collectText(tip);
  assert.deepEqual(lines, ['提示词优化', '用量更多']);
});

test('disabling prompt optimization removes the star from the trigger', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture({ defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: false } }),
      setStore() {},
      qualitySpec: railSpec,
      sessionId: 's1'
    }),
    seed({ open: true, pane: 'quality' })
  );
  assert.equal(collectClass(tree, 'cmes-trigger')[0].props.className.includes('fast'), false);
  assert.equal(collectClass(tree, 'cmes-fast')[0].props['aria-pressed'], false);
  assert.equal(collectClass(tree, 'cmes-star').length, 1, 'only the popover button keeps the outline star');
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
  const portal = roots.find((node) => node.props && node.props.style && node.props.style.display === 'contents');
  assert.ok(portal);
  const popover = collectClass(tree, 'cmes-popover')[0];
  assert.equal(popover.props.style.zIndex, 1100);
  assert.equal(popover.props.style.left, '900px');
  assert.equal(popover.props.style.bottom, '50px');
});

test('prompt optimization adds the star to the trigger and fast-mode to the popover', () => {
  const client = loadClient();
  const tree = client.render(
    client.h(client.__test.CodexImageSeat, {
      t: ct,
      store: storeFixture(),
      setStore() {},
      qualitySpec: railSpec,
      sessionId: 's1'
    }),
    seed({ open: true, pane: 'quality' })
  );
  const popovers = collectClass(tree, 'cmes-popover');
  assert.equal(popovers.length, 1);
  assert.match(popovers[0].props.className, /fast-mode/);
  const trigger = collectClass(tree, 'cmes-trigger')[0];
  assert.match(trigger.props.className, /\bfast\b/);
  assert.equal(collectClass(tree, 'cmes-star').length, 2, 'popover toggle and trigger both use the star');
});

test('the codex rail slides to the released stop instead of teleporting', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /const settleTo = \(index\) =>[\s\S]{0,600}classList\.remove\('dragging'\)[\s\S]{0,300}requestAnimationFrame\(write\)/,
    'the deferred snap runs after the dragging class is gone');
  assert.match(source, /settleTo\(index\)/, 'the release path uses it');
  assert.match(source, /dragRef\.current = \{ pointerId: pointerId, startX: event \? event\.clientX : 0, moved: false \}/,
    'a press starts in click mode');
  const down = source.match(/const pointerDown = \(event\) => \{([\s\S]*?)\n      \};/);
  assert.ok(down, 'pointerDown found');
  assert.doesNotMatch(down[1], /move\(event\)/, 'pointerdown does not paint the knob immediately');
  assert.match(source, /node\.animate\(\[[\s\S]{0,240}translateX\(-108%\)/,
    'the shared dust engine moves each path across the rail');
  assert.match(source, /animation\.currentTime = phase \* travel;/,
    'the path starts at its deterministic phase');
  assert.match(source, /animation\.updatePlaybackRate\(speed\)/,
    'the speed is driven by playback rate');
  assert.match(source, /data-fast-ticks-hidden/,
    'Fast started from Ultra keeps the ticks hidden for the whole activation');
  assert.match(source, /present \? ' present'/, 'the popover keeps its presented state during close');
  assert.doesNotMatch(source, /playbackRate = 0\.15/, 'the dust does not ramp from a low rate');
  assert.match(source, /document\.querySelectorAll\('\.cmes-popover'\)/, 'the probe follows the portaled codex popover');
  assert.doesNotMatch(source, /root\.querySelector\('\.cmes-popover'\)/, 'it does not look only inside .cmes-root');
});

test('the seat size value follows the control the model accepts', () => {
  const { __test } = loadClient();
  assert.equal(__test.sizeValueLabel({ control: 'aspect' }, { auto: false, aspect: '3:4', tier: '2K' }), '3:4 · 2K');
  assert.equal(__test.sizeValueLabel({ control: 'preset' }, { auto: false, preset: '2K' }), '2K');
  assert.equal(__test.sizeValueLabel({ control: 'preset' }, { auto: false, preset: '1024x1024' }), '1024 × 1024');
  assert.equal(__test.sizeValueLabel({ control: 'wh' }, { auto: false, width: 1024, height: 768 }), '1024 × 768');
  assert.equal(__test.sizeValueLabel({ control: 'aspect' }, { auto: true }), ct('seat.sizeAutoValue'));
});

test('an unknown control falls back to width/height and a missing spec is null', () => {
  const { __test } = loadClient();
  assert.equal(__test.sizeControlOf({ control: 'nonsense' }), 'wh');
  assert.equal(__test.sizeControlOf(null), 'wh');
  assert.equal(__test.sizeSpecFor('missing-provider', 'missing-model'), null);
});

test('the size settings survive the client store round-trip', () => {
  const { __test } = loadClient();
  const next = __test.normalizeImageStore({ defaults: { width: 1024, height: 1536, strict: true, aspect: '2:3', tier: '2K', preset: '2K' } });
  assert.equal(next.defaults.strict, true, 'strict must not be dropped by the client normaliser');
  assert.equal(next.defaults.aspect, '2:3');
  assert.equal(next.defaults.tier, '2K');
  assert.equal(next.defaults.preset, '2K');
  assert.equal(next.defaults.width, 1024);
});

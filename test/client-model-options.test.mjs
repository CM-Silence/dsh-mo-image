import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { normalizeConfig } from '../lib/config-store.js';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Stateful React stand-in, so clicking the chevron re-renders the settings section. */
function createHarness({ config, primitives = null, analyze = null, detect = null, models = null } = {}) {
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
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
  };
  const document = {
    querySelectorAll() { return []; }, querySelector() { return null; }, getElementById() { return null; },
    createElement() { return { id: '', textContent: '', parentNode: null }; },
    head: { appendChild() {} }, body: {}, styleSheets: [], adoptedStyleSheets: []
  };
  const fetchCalls = [];
  const context = {
    window, document, React, console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal, Response: globalThis.Response,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
      if (analyze && String(url).includes('/comfy/analyze')) {
        return new Response(JSON.stringify(analyze), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (detect && String(url).includes('/detect-model-rule')) {
        const answer = typeof detect === 'function' ? detect(JSON.parse((init && init.body) || '{}')) : detect;
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (models && String(url).includes('/api/mo-image/models')) {
        return new Response(JSON.stringify({ ok: true, ...models }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true, config, adapters: [],
        providerPresets: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '', models: [] }],
        localPresets: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    setTimeout: () => 0, clearTimeout() {}, URL
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  const api = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal(node) { return node; } };
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives) return primitives;
    return {};
  });

  const dictionaries = new Map();
  const locale = {
    active: 'en',
    register(ns, dicts) { dictionaries.set(ns, dicts); return () => {}; },
    bind(ns) {
      return (key, params) => {
        const dicts = dictionaries.get(ns) || {};
        let template = key;
        for (const lang of [locale.active, 'en']) {
          const hit = dicts[lang] && dicts[lang][key];
          if (typeof hit === 'string') { template = hit; break; }
        }
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      };
    },
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
      const props = Object.assign({}, node.props || {});
      if (node.children && node.children.length) props.children = node.children.length === 1 ? node.children[0] : node.children;
      const output = node.type(props);
      currentHooks = previous;
      return render(output);
    }
    return { type: node.type, props: node.props || {}, children: (node.children || []).map(render) };
  }

  function renderRoot() {
    const settings = registrations.find(({ definition }) => definition.name === 'settings.section');
    for (let i = 0; i < 12; i += 1) {
      dirty = false;
      const tree = render({ type: settings.component, props: settings.definition.inject(), children: [] });
      if (!dirty) return tree;
    }
    throw new Error('render did not settle');
  }

  return { fetchCalls, renderRoot, api };
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (item) => { if (predicate(item)) out.push(item); });
  return out;
}

function classTokens(node) {
  const value = node && node.props && node.props.className;
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function hasClass(node, local) {
  return classTokens(node).some((token) => token === local || token.endsWith('_' + local));
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) textOf(item, out); return out; }
  for (const child of node.children || []) textOf(child, out);
  return out;
}

function findButton(node, predicate) {
  return findAll(node, (item) => item.type === 'button' && predicate(item))[0] || null;
}

const CONFIG = {
  providers: [{
    id: 'p1', name: 'Local ComfyUI', baseUrl: 'http://127.0.0.1:8188',
    key: '', hasKey: false, adapter: 'comfyui', protocol: 'openai-images', optionalKey: true,
    models: ['flux.safetensors'], names: {}
  }],
  active: { providerId: 'p1', model: 'flux.safetensors' },
  defaults: {}
};

function fakeEvent() {
  return {
    preventDefault() {}, stopPropagation() {},
    currentTarget: { focus() {}, getBoundingClientRect: () => ({ top: 0, height: 40, left: 0, width: 300 }) }
  };
}

// 真实 DSH 运行时由 primitives 提供这些图标；这里用同名占位元素模拟。
const PRIMITIVES = {
  IconChevronRightOutlineRegular: 'IconChevronRight',
  IconChevronDownOutlineRegular: 'IconChevronDown',
  IconTrashOutlineRegular: 'IconTrash',
  IconPlusOutlineRegular: 'IconPlus',
  IconDragHandleOutlineRegular: 'IconDragHandle'
};

async function openEditor(config = CONFIG, options = {}) {
  const harness = createHarness(Object.assign({ config, primitives: PRIMITIVES }, options));
  await new Promise((resolve) => setImmediate(resolve));
  let tree = harness.renderRoot();
  const edit = findButton(tree, (node) => textOf(node).join('').includes('Edit'));
  assert.ok(edit, 'expected the provider Edit button');
  edit.props.onClick();
  tree = harness.renderRoot();
  return { harness, tree };
}

function optionsToggle(tree) {
  return findAll(tree, (node) => node.type === 'button' && hasClass(node, 'iconButton')
    && typeof node.props['aria-expanded'] === 'boolean')[0] || null;
}

/** 本地 A1111：有自己的 sdapi 参数模型，用不上 ComfyUI 工作流。 */
const A1111_CONFIG = {
  providers: [{
    id: 'p3', name: 'Local A1111', baseUrl: 'http://127.0.0.1:7860',
    key: '', hasKey: false, adapter: 'a1111', protocol: 'openai-images', optionalKey: true,
    models: ['sdxl.safetensors'], names: {}
  }],
  active: { providerId: 'p3', model: 'sdxl.safetensors' },
  defaults: {}
};

/** 云端提供商：不是本地部署，没有自定义工作流这回事。 */
const CLOUD_CONFIG = {
  providers: [{
    id: 'p2', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    key: '', hasKey: true, adapter: 'openai-images', protocol: 'openai-images', optionalKey: false,
    models: ['gpt-image-2.5-flare'], names: {}
  }],
  active: { providerId: 'p2', model: 'gpt-image-2.5-flare' },
  defaults: {}
};

test('the model options toggle is enabled for the local ComfyUI deployment', async () => {
  const { tree } = await openEditor();
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'expected the chevron toggle');
  assert.notEqual(toggle.props.disabled, true, 'local ComfyUI must allow model options');
});

test('the model options toggle opens the size panel for a cloud provider', async () => {
  const { harness, tree } = await openEditor(CLOUD_CONFIG);
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'chevron stays rendered for every model');
  assert.notEqual(toggle.props.disabled, true, 'cloud providers can override how the size is sent');
  toggle.props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  assert.ok(panel, 'the panel opens');
  assert.equal(findAll(panel, (node) => node.type === 'textarea').length, 0,
    'a cloud provider has no workflow to edit');
  const select = findAll(panel, (node) => node.type === 'select')[0];
  assert.ok(select, 'the encoding select is there');
  assert.deepEqual(findAll(select, (node) => node.type === 'option').map((node) => String(node.props.value)),
    ['', 'wh-string', 'wh-fields', 'aspect', 'tier', 'prompt']);
  const input = findAll(panel, (node) => node.type === 'input' && node.props.type === 'text')[0];
  assert.ok(input, 'the parameter name is editable');
});

test('the workflow textarea is compact but still usable', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  assert.ok(Number(textarea.props.rows) >= 8, 'textarea should default to at least 8 rows');
  assert.ok(Number(textarea.props.style.minHeight) >= 160, 'textarea should keep a usable minimum height');
});

test('a local provider without a parameter table still opens the size panel', async () => {
  const { harness, tree } = await openEditor({
    providers: [{
      id: 'p5', name: 'Local SwarmUI', baseUrl: 'http://127.0.0.1:7801',
      key: '', hasKey: false, adapter: 'swarmui', protocol: 'openai-images', optionalKey: true,
      models: ['sdxl.safetensors'], names: {}
    }],
    active: { providerId: 'p5', model: 'sdxl.safetensors' },
    defaults: {}
  });
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'chevron stays rendered so the row layout is stable');
  assert.notEqual(toggle.props.disabled, true, 'SwarmUI can still override its size parameter');
  toggle.props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  assert.ok(panel, 'the size panel opens');
  assert.ok(findAll(panel, (node) => node.type === 'select').length >= 1);
});

test('clicking the toggle again closes the panel', async () => {
  const { harness, tree } = await openEditor(CLOUD_CONFIG);
  const toggle = optionsToggle(tree);
  toggle.props.onClick(fakeEvent());
  assert.equal(findAll(harness.renderRoot(), (node) => hasClass(node, 'modelAdvanced')).length, 1);
  optionsToggle(harness.renderRoot()).props.onClick(fakeEvent());
  assert.equal(findAll(harness.renderRoot(), (node) => hasClass(node, 'modelAdvanced')).length, 0);
});

test('the model row exposes model options as a chevron icon button, not a text button', async () => {
  const { tree } = await openEditor();
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'expected an aria-expanded icon button on the model row');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.match(String(toggle.props['aria-label']), /Model options/);
  assert.equal(toggle.props.title, 'Model options');
  // 图标按钮的可见内容是图标组件，不是文字
  const label = textOf(toggle).join('').trim();
  assert.equal(label, '', 'the toggle must not render a text label');
});

test('the chevron sits between the model id field and the delete button', async () => {
  const { tree } = await openEditor();
  const toggle = optionsToggle(tree);
  const row = findAll(tree, (node) => node.type === 'button' && hasClass(node, 'iconButton'))
    .map((node) => node).indexOf(toggle);
  const buttons = findAll(tree, (node) => node.type === 'button' && hasClass(node, 'iconButton'));
  const deleteAt = buttons.findIndex((node) => hasClass(node, 'iconButtonDanger'));
  assert.ok(row >= 0 && deleteAt > row, 'delete button must come after the chevron');
});

test('clicking the chevron reveals the workflow panel inside the row', async () => {
  const { harness, tree } = await openEditor();
  assert.equal(findAll(tree, (node) => hasClass(node, 'modelAdvanced')).length, 0,
    'panel stays collapsed until toggled');
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  assert.ok(panel, 'expected the expanded modelAdvanced panel');
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  assert.ok(textarea, 'expected a workflow textarea');
});

test('editing the workflow and saving sends modelOptions for that model', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  textarea.props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  const save = findButton(opened, (node) => /save/i.test(textOf(node).join('')));
  const labels = findAll(opened, (node) => node.type === 'button').map((node) => textOf(node).join(''));
  assert.ok(save, 'expected a save button, found: ' + JSON.stringify(labels));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/config'));
  assert.ok(posted.length > 0, 'expected a config POST');
  const body = JSON.parse(posted[posted.length - 1].body);
  const provider = body.config.providers.find((item) => item.id === 'p1');
  assert.ok(provider.modelOptions, 'modelOptions must be persisted');
  assert.equal(provider.modelOptions['flux.safetensors'].workflow, '{"1":{"class_type":"KSampler"}}');
});

test('the workflow panel can send the pasted graph to the analyze route', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  textarea.props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  const buttons = findAll(opened, (node) => node.type === 'button').map((node) => textOf(node).join('').trim());
  const parse = findButton(opened, (node) => /parse workflow/i.test(textOf(node).join('')));
  assert.ok(parse, 'expected a parse-workflow button, found: ' + JSON.stringify(buttons));
  await parse.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/comfy/analyze'));
  assert.equal(posted.length, 1, 'expected one analyze POST');
  const body = JSON.parse(posted[0].body);
  assert.equal(body.workflow, '{"1":{"class_type":"KSampler"}}');
});

test('parsing keeps the mapping when the same analyze response also carries params', async () => {
  const analysis = {
    ok: true,
    format: 'api',
    mapping: { prompt: { node: '18:17', input: 'value' }, image: null },
    candidates: { prompt: [{ node: '18:17', input: 'value', classType: 'PrimitiveStringMultiline' }] },
    params: [
      { name: 'prompt', node: '18:17', input: 'value', type: 'STRING', role: true },
      { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25 }
    ],
    warnings: []
  };
  const { harness, tree } = await openEditor(CONFIG, { analyze: analysis });
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  textarea.props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  const parse = findButton(opened, (node) => /parse workflow/i.test(textOf(node).join('')));
  await parse.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  opened = harness.renderRoot();
  const save = findButton(opened, (node) => /save/i.test(textOf(node).join('')));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/config'));
  const body = JSON.parse(posted[posted.length - 1].body);
  const provider = body.config.providers.find((item) => item.id === 'p1');
  const entry = provider.modelOptions['flux.safetensors'];
  assert.deepEqual(entry.mapping.prompt, { node: '18:17', input: 'value' },
    'the mapping must survive the params write');
  assert.ok(Array.isArray(entry.params) && entry.params.length === 2, 'params must be stored too');
});

const A1111_SAMPLING_CONFIG = {
  providers: [{
    id: 'p4', name: 'Local A1111', baseUrl: 'http://127.0.0.1:7860',
    key: '', hasKey: false, adapter: 'a1111', protocol: 'openai-images', optionalKey: true,
    models: ['sd15.safetensors'], names: {}
  }],
  active: { providerId: 'p4', model: 'sd15.safetensors' },
  defaults: {}
};

test('the model options toggle is enabled for A1111 too', async () => {
  const { tree } = await openEditor(A1111_SAMPLING_CONFIG);
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'expected the chevron toggle');
  assert.notEqual(toggle.props.disabled, true);
});

test('the A1111 panel lists sampling parameters unchecked by default', async () => {
  const { harness, tree } = await openEditor(A1111_SAMPLING_CONFIG);
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  assert.ok(panel, 'expected the expanded panel');
  const text = textOf(panel).join(' ');
  assert.match(text, /Steps/i);
  assert.match(text, /CFG scale/i);
  assert.ok(!findAll(panel, (node) => node.type === 'textarea').length, 'A1111 has no workflow box');
  const boxes = findAll(panel, (node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(boxes.length, 6);
  assert.ok(boxes.every((box) => box.props.checked === false), 'everything starts unchecked');
});

test('switching an A1111 parameter on persists it in the expose map', async () => {
  const { harness, tree } = await openEditor(A1111_SAMPLING_CONFIG);
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const boxes = findAll(panel, (node) => node.type === 'input' && node.props.type === 'checkbox');
  boxes[0].props.onChange({ target: { checked: true } });
  opened = harness.renderRoot();
  const save = findButton(opened, (node) => /save/i.test(textOf(node).join('')));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/config'));
  const body = JSON.parse(posted[posted.length - 1].body);
  const provider = body.config.providers.find((item) => item.id === 'p4');
  assert.equal(provider.modelOptions['sd15.safetensors'].expose.steps, true);
});

/* 尺寸：值由选择器经 mapping 注入，列表里不再占一行；认不出来时才留手选。 */

const SIZED_ANALYSIS = {
  ok: true,
  format: 'api',
  mapping: {
    prompt: { node: '18:17', input: 'value' },
    width: { node: '18:6', input: 'width' },
    height: { node: '18:6', input: 'height' },
    image: null
  },
  candidates: {
    prompt: [{ node: '18:17', input: 'value', classType: 'PrimitiveStringMultiline' }],
    width: [{ node: '18:6', input: 'width', classType: 'EmptyFlux2LatentImage' }],
    height: [{ node: '18:6', input: 'height', classType: 'EmptyFlux2LatentImage' }]
  },
  params: [
    { name: 'prompt', role: true, node: '18:17', input: 'value', type: 'STRING' },
    { name: 'width', role: true, node: '18:6', input: 'width', type: 'INT' },
    { name: 'height', role: true, node: '18:6', input: 'height', type: 'INT' },
    { name: 'steps', node: '18:7', input: 'steps', type: 'INT' }
  ],
  warnings: []
};

/** 打开面板 → 填工作流 → 解析 → 返回渲染后的树。 */
async function openParsed(analysis, config = CONFIG) {
  const { harness, tree } = await openEditor(config, { analyze: analysis });
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  textarea.props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  const parse = findButton(opened, (node) => /parse workflow/i.test(textOf(node).join('')));
  await parse.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  return harness.renderRoot();
}

const hasRow = (tree, key) => findAll(tree, (node) => node.props && node.props.key === key).length > 0;

const FIXED_SIZE_CONFIG = { ...CONFIG, defaults: { auto: false, width: 768, height: 1024 } };

test('the panel shows width and height while the size is Auto', async () => {
  const tree = await openParsed(SIZED_ANALYSIS);
  assert.ok(hasRow(tree, 'width'), 'Auto lets the model move the size, so show where it lands');
  assert.ok(hasRow(tree, 'height'));
});

test('the panel hides width and height while the picker pins the size', async () => {
  const tree = await openParsed(SIZED_ANALYSIS, FIXED_SIZE_CONFIG);
  assert.ok(!hasRow(tree, 'width'), 'a pinned size is the picker\'s business');
  assert.ok(!hasRow(tree, 'height'));
});

test('the panel still offers width and height when the graph does not reveal them', async () => {
  const analysis = {
    ...SIZED_ANALYSIS,
    mapping: { prompt: { node: '18:17', input: 'value' }, width: null, height: null, image: null }
  };
  const tree = await openParsed(analysis, FIXED_SIZE_CONFIG);
  assert.ok(hasRow(tree, 'width'), 'an undetected size needs the manual fallback');
  assert.ok(hasRow(tree, 'height'), 'an undetected size needs the manual fallback');
});

/* 提示词与负面词由工具参数直接写入：参数列表里不占行。 */

test('the params table has no prompt or negative prompt rows', async () => {
  const tree = await openParsed(SIZED_ANALYSIS);
  assert.ok(!hasRow(tree, 'prompt'), 'the prompt travels as the tool argument, not as a row');
  assert.ok(!hasRow(tree, 'negative_prompt'));
  assert.match(textOf(tree).join(' '), /straight from the tool call/i,
    'the panel has to say why these two are absent');
  const boxes = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(boxes.length, 3, 'width, height and steps keep their switches');
});

/* ───────────────────────── 任务 9'：一键配置 + 键锁 ───────────────────────── */

/** 自定义提供商：默认不上锁，「一键配置」按钮只在这一档出现。 */
const CUSTOM_RELAY_CONFIG = {
  providers: [{
    id: 'p9', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
    key: '', hasKey: true, adapter: 'custom', protocol: 'openai-images', optionalKey: false,
    customEndpoints: {
      generate: 'https://api.siliconflow.cn/v1/images/generations',
      edit: '',
      models: 'https://api.siliconflow.cn/v1/models'
    },
    models: ['Qwen/Qwen-Image'], names: {}
  }],
  active: { providerId: 'p9', model: 'Qwen/Qwen-Image' },
  defaults: {}
};

/** 从预设创建（provider.presetId 在）：预设已经把字段模板配好，键默认全锁。 */
const PRESET_CONFIG = {
  providers: [{
    id: 'pa', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    key: '', hasKey: true, adapter: '', protocol: 'openai-images', optionalKey: false,
    presetId: 'openai',
    models: ['gpt-image-2.5-flare'], names: {}
  }],
  active: { providerId: 'pa', model: 'gpt-image-2.5-flare' },
  defaults: {}
};

/** 手填的中转站：adapter 空、没有 presetId（也是老配置的样子），默认不锁。 */
const RELAY_CONFIG = {
  providers: [{
    id: 'pb', name: 'Relay', baseUrl: 'https://gateway.example/v1',
    key: '', hasKey: true, adapter: '', protocol: 'openai-images', optionalKey: false,
    models: ['gpt-image-2.5-flare'], names: {}
  }],
  active: { providerId: 'pb', model: 'gpt-image-2.5-flare' },
  defaults: {}
};

/** 检测路由的返回：形状与宿主一致（rules 只带 size/quality，字段与命中标记分表）。 */
const DETECTED_QWEN = {
  ok: true,
  models: ['Qwen/Qwen-Image'],
  rules: {
    'Qwen/Qwen-Image': {
      size: {
        mode: 'wh-string', field: 'image_size', separator: 'x', second: null,
        domain: { allowed: ['1328x1328', '1664x928'] }
      },
      quality: null
    }
  },
  fields: {
    'Qwen/Qwen-Image': {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: null,
      image: { path: 'image', as: 'dataUrl' }
    }
  },
  matched: { 'Qwen/Qwen-Image': true }
};

/** 认不出的网关：尺寸走兜底，质量与字段规则都没命中。 */
const DETECTED_UNKNOWN = {
  ok: true,
  models: ['Qwen/Qwen-Image'],
  rules: {
    'Qwen/Qwen-Image': {
      size: { mode: 'wh-string', field: 'size', separator: 'x', second: null, domain: { multiple: 1 } },
      quality: null
    }
  },
  fields: { 'Qwen/Qwen-Image': null },
  matched: { 'Qwen/Qwen-Image': false }
};

/** 展开某个模型（第 index 行）的选项面板，返回渲染后的树。 */
function openModelPanel(harness) {
  optionsToggle(harness.renderRoot()).props.onClick(fakeEvent());
  return harness.renderRoot();
}

const paramInput = (tree, key) => findAll(tree, (node) => node.type === 'input'
  && node.props['data-param-key'] === key)[0] || null;
const paramLock = (tree, key) => findAll(tree, (node) => node.type === 'button'
  && node.props['data-lock-key'] === key)[0] || null;

async function configureAll(harness) {
  const button = findButton(harness.renderRoot(), (node) => /Configure all/i.test(textOf(node).join('')));
  assert.ok(button, 'expected the one-click configure button');
  await button.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  return harness.renderRoot();
}

async function saveAndPosted(harness) {
  const save = findButton(harness.renderRoot(), (node) => /save/i.test(textOf(node).join('')));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/config'));
  return JSON.parse(posted[posted.length - 1].body).config;
}

test('预设来源的提供商默认全锁，中转站与自定义提供商默认不锁', async () => {
  const preset = await openEditor(PRESET_CONFIG);
  const presetPanel = openModelPanel(preset.harness);
  assert.equal(paramInput(presetPanel, 'size').props.disabled, true,
    '预设来源的尺寸输入必须默认禁用（写的是摘要与锁，不是空格）');
  assert.equal(paramInput(presetPanel, 'prompt').props.disabled, true);
  assert.equal(paramLock(presetPanel, 'size').props['aria-pressed'], 'true');

  // adapter 为空的中转站是最常见的一档：以前按 adapter 判会把它一起锁死，现在看 presetId。
  const relay = await openEditor(RELAY_CONFIG);
  const relayPanel = openModelPanel(relay.harness);
  assert.notEqual(paramInput(relayPanel, 'size').props.disabled, true,
    '手填的中转站默认不上锁');
  assert.equal(paramLock(relayPanel, 'prompt').props['aria-pressed'], 'false');

  const custom = await openEditor(CUSTOM_RELAY_CONFIG);
  const customPanel = openModelPanel(custom.harness);
  assert.notEqual(paramInput(customPanel, 'size').props.disabled, true,
    '自定义提供商默认不上锁');
  assert.notEqual(paramInput(customPanel, 'image').props.disabled, true);
});

test('锁状态只存与默认不同的键：预设上锁、自配解锁', () => {
  const { api } = createHarness({ config: PRESET_CONFIG });
  // 跨 vm 边界的对象走一趟 JSON：deepEqual 会比对原型，vm 里的 Object 与本进程不是同一个。
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const preset = { presetId: 'openai' };
  const relay = { adapter: '' };
  const custom = { adapter: 'custom' };

  const customEntry = {};
  api.__test.writeLock(customEntry, 'size', true, custom);
  assert.deepEqual(plain(customEntry.locked), { size: true }, '默认不锁，上锁才写');
  api.__test.writeLock(customEntry, 'size', false, custom);
  assert.equal(customEntry.locked, undefined, '回到默认值就该把整条锁删掉');

  const presetEntry = {};
  api.__test.writeLock(presetEntry, 'image', false, preset);
  assert.deepEqual(plain(presetEntry.locked), { image: false }, '预设默认全锁，解锁才写');
  assert.deepEqual(plain(api.__test.lockedMapOf({}, preset)), {
    size: true, quality: true, prompt: true, negative: true, model: true, n: true, image: true
  });
  for (const provider of [relay, custom]) {
    assert.deepEqual(plain(api.__test.lockedMapOf({}, provider)), {
      size: false, quality: false, prompt: false, negative: false, model: false, n: false, image: false
    });
  }
  // 老配置没有 presetId：按自配处理（放宽），一升级不该发现改不了尺寸。
  assert.equal(plain(api.__test.lockedMapOf({}, {})).size, false);
});

test('一键配置把命中的尺寸与字段写进去，并给写过的键上锁', async () => {
  const { harness, tree } = await openEditor(CUSTOM_RELAY_CONFIG, { detect: DETECTED_QWEN });
  const opened = await configureAll(harness);
  assert.ok(opened);
  const asked = harness.fetchCalls.filter((call) => call.url.includes('/detect-model-rule'));
  assert.equal(asked.length, 1, '一键配置只问一次路由（一次传所有模型）');
  const payload = JSON.parse(asked[0].body);
  assert.deepEqual(payload.models, ['Qwen/Qwen-Image']);
  assert.equal(payload.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(payload.adapter, 'custom');

  const config = await saveAndPosted(harness);
  const provider = config.providers.find((item) => item.id === 'p9');
  const entry = provider.modelOptions['Qwen/Qwen-Image'];
  assert.deepEqual(entry.size, { mode: 'wh-string', field: 'image_size', separator: 'x' });
  assert.equal(entry.fields.prompt.path, 'prompt');
  assert.equal(entry.fields.negative.path, 'negative_prompt');
  assert.equal(entry.fields.model.path, 'model');
  assert.deepEqual(entry.fields.image, { path: 'image', as: 'dataUrl' });
  assert.equal(entry.fields.n, undefined, '规则说 n 不发（null），就不该落盘一条空模板');
  // 写进去的键全部上锁；没写的不上锁（下次点还会重试）。
  assert.deepEqual(entry.locked, { size: true, prompt: true, negative: true, model: true, image: true });
  // 一键配置不动用户填的地址。
  assert.equal(provider.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(provider.customEndpoints.generate, 'https://api.siliconflow.cn/v1/images/generations');
});

test('一键配置跳过已上锁的键，只写没上锁的', async () => {
  const lockedConfig = {
    providers: [{
      ...CUSTOM_RELAY_CONFIG.providers[0],
      modelOptions: {
        'Qwen/Qwen-Image': {
          size: { mode: 'aspect', field: 'hand_picked' },
          locked: { size: true }
        }
      }
    }],
    active: CUSTOM_RELAY_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(lockedConfig, { detect: DETECTED_QWEN });
  await configureAll(harness);
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.deepEqual(entry.size, { mode: 'aspect', field: 'hand_picked' },
    '上锁的尺寸不能被一键配置改写');
  assert.equal(entry.fields.prompt.path, 'prompt', '没上锁的提示词照写');
  assert.deepEqual(entry.locked, {
    size: true, prompt: true, negative: true, model: true, image: true
  });
});

test('一键配置只对命中规则的模型写入，未命中的既不写也不锁，结果提示报数', async () => {
  const twoModels = {
    providers: [{
      ...CUSTOM_RELAY_CONFIG.providers[0],
      models: ['Qwen/Qwen-Image', 'mystery-model-9']
    }],
    active: CUSTOM_RELAY_CONFIG.active,
    defaults: {}
  };
  const mixed = {
    ok: true,
    models: ['Qwen/Qwen-Image', 'mystery-model-9'],
    rules: {
      'Qwen/Qwen-Image': DETECTED_QWEN.rules['Qwen/Qwen-Image'],
      'mystery-model-9': DETECTED_UNKNOWN.rules['Qwen/Qwen-Image']
    },
    fields: {
      'Qwen/Qwen-Image': DETECTED_QWEN.fields['Qwen/Qwen-Image'],
      'mystery-model-9': null
    },
    matched: { 'Qwen/Qwen-Image': true, 'mystery-model-9': false }
  };
  const { harness } = await openEditor(twoModels, { detect: mixed });
  const opened = await configureAll(harness);
  const notice = findAll(opened, (node) => node.props && node.props['data-rule-notice'] !== undefined);
  assert.equal(notice.length, 1, '要给个结果提示');
  assert.equal(textOf(notice[0]).join(''), 'Configured 1 model(s) — 1 did not match a rule');
  const config = await saveAndPosted(harness);
  const options = config.providers.find((item) => item.id === 'p9').modelOptions;
  assert.ok(options['Qwen/Qwen-Image'], '命中的模型写进去了');
  assert.equal(options['mystery-model-9'], undefined, '规则没认出来就一个键都不写');
});

test('展开面板显示只读摘要：用了哪个规则、尺寸/质量/提示词/参考图各发到哪', async () => {
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { detect: DETECTED_QWEN });
  await configureAll(harness);
  const opened = openModelPanel(harness);
  const summary = findAll(opened, (node) => node.props && node.props['data-rule-summary'] !== undefined)[0];
  assert.ok(summary, '面板顶部要有只读摘要');
  assert.equal(textOf(summary).join(''),
    'By Qwen/Qwen-Image rule: size image_size / quality none / prompt prompt / image image');
});

test('规则没命中时的摘要直说按 OpenAI 兼容发送', async () => {
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { detect: DETECTED_UNKNOWN });
  await configureAll(harness);
  const opened = openModelPanel(harness);
  const summary = findAll(opened, (node) => node.props && node.props['data-rule-summary'] !== undefined)[0];
  assert.ok(summary);
  assert.match(textOf(summary).join(''), /No matching rule/);
});

test('点锁图标解锁后输入框变回可编辑，再点又锁上', async () => {
  const { harness } = await openEditor(PRESET_CONFIG);
  let opened = openModelPanel(harness);
  assert.equal(paramInput(opened, 'size').props.disabled, true);
  paramLock(opened, 'size').props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.notEqual(paramInput(opened, 'size').props.disabled, true, '解锁后可手填');
  paramLock(opened, 'size').props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.equal(paramInput(opened, 'size').props.disabled, true, '再点一次又锁上');
});

test('「全部解锁」把预设提供商的七个键一次解锁', async () => {
  const { harness } = await openEditor(PRESET_CONFIG);
  let opened = openModelPanel(harness);
  const unlock = findButton(opened, (node) => /Unlock all/i.test(textOf(node).join('')));
  assert.ok(unlock, '「高级」里要有全部解锁');
  unlock.props.onClick(fakeEvent());
  opened = harness.renderRoot();
  for (const key of ['size', 'quality', 'prompt', 'negative', 'model', 'n', 'image']) {
    assert.notEqual(paramInput(opened, key).props.disabled, true, key + ' 应该已解锁');
  }
});

test('单点自动检测只写未上锁的键，而且不上锁（下次还会重算）', async () => {
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { detect: DETECTED_QWEN });
  let opened = openModelPanel(harness);
  const detectButton = findButton(opened, (node) => /Auto-detect/i.test(textOf(node).join('')));
  assert.ok(detectButton, '每个模型保留单点自动检测');
  await detectButton.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const asked = harness.fetchCalls.filter((call) => call.url.includes('/detect-model-rule'));
  assert.deepEqual(JSON.parse(asked[asked.length - 1].body).models, ['Qwen/Qwen-Image']);
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.equal(entry.size.field, 'image_size');
  assert.equal(entry.locked, undefined, '自动检测不写锁：三种自动上锁里没有它');
});

test('手填的输入框收在默认折叠的「高级」里', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const details = findAll(panel, (node) => node.type === 'details');
  assert.equal(details.length, 1, '恰好一个「高级」折叠区');
  assert.notEqual(details[0].props.open, true, '默认折叠');
  assert.match(textOf(findAll(details[0], (node) => node.type === 'summary')[0]).join(''), /Advanced/i);
  // 七个键的输入都在折叠区里，锁图标与摘要留在外面。
  for (const key of ['size', 'quality', 'prompt', 'negative', 'model', 'n', 'image']) {
    assert.ok(findAll(details[0], (node) => node.props && node.props['data-param-key'] === key).length
      || findAll(details[0], (node) => node.props && node.props['data-lock-key'] === key).length,
      key + ' 的控件应该收在高级里');
  }
});

test('「一键配置」在中转站与自定义提供商上出现，预设来源不出现', async () => {
  const hasBulk = (tree) => Boolean(findButton(tree, (node) => /Configure all/i.test(textOf(node).join(''))));
  assert.ok(hasBulk((await openEditor(RELAY_CONFIG)).tree), 'adapter 为空的中转站最需要一键配置');
  assert.ok(hasBulk((await openEditor(CUSTOM_RELAY_CONFIG)).tree), '自定义协议也要有');
  assert.ok(!hasBulk((await openEditor(PRESET_CONFIG)).tree), '预设来源开箱即用，不出现');
});

test('选预设就记 presetId（来源），手改 API 地址就清掉', async () => {
  const openNewProvider = async () => {
    const harness = createHarness({ config: { providers: [], active: { providerId: '', model: '' }, defaults: {} } });
    await new Promise((resolve) => setImmediate(resolve));
    const add = findButton(harness.renderRoot(), (node) => /Add provider/i.test(textOf(node).join('')));
    assert.ok(add, 'expected the add-provider button');
    add.props.onClick();
    const tree = harness.renderRoot();
    const presetSelect = findAll(tree, (node) => node.type === 'select'
      && findAll(node, (child) => child.type === 'option' && String(child.props.value) === 'openai').length === 1)[0];
    assert.ok(presetSelect, 'expected the provider preset select');
    return { harness, presetSelect };
  };
  const lastProvider = (config) => normalizeConfig(config).providers.pop();

  const first = await openNewProvider();
  first.presetSelect.props.onChange({ target: { value: 'openai' } });
  assert.equal(lastProvider(await saveAndPosted(first.harness)).presetId, 'openai',
    '从预设创建要记下来源');

  // 换一家网关（手改地址）之后就不该再按预设对待。
  const second = await openNewProvider();
  second.presetSelect.props.onChange({ target: { value: 'openai' } });
  const urlInput = findAll(second.harness.renderRoot(), (node) => node.type === 'input'
    && node.props.value === 'https://api.openai.com/v1')[0];
  assert.ok(urlInput, 'expected the API URL input');
  urlInput.props.onChange({ target: { value: 'https://relay.example.com/v1' } });
  const saved = lastProvider(await saveAndPosted(second.harness));
  assert.equal(saved.presetId, undefined, '改了地址就不再是预设来源（配置里不落这个字段）');
  assert.equal(saved.baseUrl, 'https://relay.example.com/v1');
});

test('摘要里的质量只在真的会发质量时出现', async () => {
  const { api } = createHarness({ config: PRESET_CONFIG });
  // 摘要取值用一份最小的翻译表，直接把 key 当成模板。
  const translate = (key, params) => {
    const templates = {
      'form.ruleSummary': 'size {size} / quality {quality} / prompt {prompt} / image {image}',
      'form.ruleSummaryFallback': 'fallback',
      'form.ruleNone': 'none'
    };
    const template = templates[key] || key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
  const base = {
    rule: {
      size: { mode: 'wh-string', field: 'image_size' },
      quality: { field: 'quality', options: ['low', 'high'], default: 'high' }
    },
    fields: { prompt: { path: 'prompt' }, image: { path: 'image', as: 'dataUrl' } },
    matched: true
  };
  assert.equal(api.__test.ruleSummaryText(translate, 'm', base),
    'size image_size / quality none / prompt prompt / image image',
    '质量规则命中但字段模板里没有 quality：质量根本不会发，摘要必须说 none');
  const withTemplate = JSON.parse(JSON.stringify(base));
  withTemplate.fields.quality = { path: 'quality' };
  assert.equal(api.__test.ruleSummaryText(translate, 'm', withTemplate),
    'size image_size / quality quality / prompt prompt / image image');
});

test('一键配置补上质量模板后，摘要随之变成「会发质量」', async () => {
  // 质量规则命中、但字段模板里没有 quality（自定义协议常见）：这时质量压根发不出去。
  const qualityNoTemplate = {
    ok: true,
    models: ['Qwen/Qwen-Image'],
    rules: {
      'Qwen/Qwen-Image': {
        size: { mode: 'wh-string', field: 'image_size', separator: 'x', second: null, domain: {} },
        quality: { field: 'quality', options: ['low', 'high'], default: 'high', map: null }
      }
    },
    fields: { 'Qwen/Qwen-Image': { prompt: { path: 'prompt' }, image: { path: 'image', as: 'dataUrl' } } },
    matched: { 'Qwen/Qwen-Image': true }
  };
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { detect: qualityNoTemplate });
  await configureAll(harness);
  const opened = openModelPanel(harness);
  const summary = findAll(opened, (node) => node.props && node.props['data-rule-summary'] !== undefined)[0];
  assert.match(textOf(summary).join(''), /quality quality/,
    '一键配置会把 fields.quality 补上（否则质量永远是死的），摘要要立刻跟上');
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.deepEqual(entry.fields.quality, { path: 'quality' });
  assert.ok(entry.quality, '质量覆盖要一起写');
});

test('一键配置抄规则时带上面板控件 control，mode none 不写', () => {
  const { api } = createHarness({ config: PRESET_CONFIG });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(
    plain(api.__test.sizeOverrideFromRule({ mode: 'wh-string', field: 'size', control: 'aspect' })),
    { mode: 'wh-string', field: 'size', control: 'aspect' },
    '向量模型的 control 要跟着规则一起落盘，否则面板控件会退回宽高'
  );
  assert.equal(api.__test.sizeOverrideFromRule({ mode: 'none' }), null,
    'mode none 是「不发尺寸」，没有值可写');
});

test('拉模型列表后，新增的模型自动填未上锁的键（不锁）', async () => {
  const fetched = {
    models: ['Qwen/Qwen-Image', 'flux-1-dev'],
    allModels: ['Qwen/Qwen-Image', 'flux-1-dev'],
    filteredCount: 0,
    names: {},
    // 宿主只给「本次新增」的模型附规则，形状是 { size, quality }。
    detected: {
      'flux-1-dev': { size: { mode: 'wh-string', field: 'image_size', separator: 'x' }, quality: null }
    }
  };
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { models: fetched });
  const fetchButton = findButton(harness.renderRoot(), (node) => /Fetch available models/i.test(textOf(node).join('')));
  assert.ok(fetchButton, 'expected the fetch models button');
  await fetchButton.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = harness.renderRoot();
  // 已配置过的模型默认勾上、新模型默认不勾：勾上 flux-1-dev 再采纳。
  // 候选是一个 li，外面还套着提供商那一行的 li，所以按文本「恰好等于模型 id」找最里面那个。
  const candidate = findAll(tree, (node) => node.type === 'li'
    && textOf(node).join('').trim() === 'flux-1-dev')[0];
  assert.ok(candidate, 'expected the new model in the candidate list');
  const checkbox = findAll(candidate, (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
  assert.ok(checkbox, 'expected a candidate checkbox');
  checkbox.props.onChange();
  tree = harness.renderRoot();
  const adopt = findButton(tree, (node) => /Update list/i.test(textOf(node).join('')));
  assert.ok(adopt, 'expected the adopt button');
  adopt.props.onClick();
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['flux-1-dev'];
  assert.ok(entry, '新增模型要自动填规则');
  assert.equal(entry.size.field, 'image_size');
  assert.equal(entry.locked, undefined, '自动填不是「普通上锁」的三种情况之一');
});


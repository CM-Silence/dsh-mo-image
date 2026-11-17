import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { normalizeConfig } from '../lib/config-store.js';
import { applyFields, multipartFields, promptParts, resolveFields } from '../lib/field-templates.js';
import { A1111_PARAMS } from '../lib/adapters.js';

/** 宿主下发的「零配置参数行」：A1111 第一次展开模型时按它把行摆出来。 */
const PARAM_DEFAULTS = {
  a1111: A1111_PARAMS.map((param) => ({ name: param.name, type: param.type, default: param.default }))
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * 宿主下发的参考图能力（`capabilities[].models[].image`）：这些 fixture 多数是 OpenAI 兼容
 * 网关，宿主会声明 `{ multipart: 'image[]' }`。个别用例（「宿主什么都没声明」）显式传
 * `capabilities: []` 覆盖掉。
 */
function defaultCapabilities(config) {
  return ((config && config.providers) || []).map((provider) => ({
    providerId: provider.id,
    models: (provider.models || []).map((model) => ({ model: model, image: { multipart: 'image[]' } }))
  }));
}

/** Stateful React stand-in, so clicking the chevron re-renders the settings section. */
function createHarness({ config, primitives = null, analyze = null, params = null, detect = null, models = null, capabilities = null } = {}) {
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
      if (params && String(url).includes('/comfy/params')) {
        return new Response(JSON.stringify(params), { status: 200, headers: { 'content-type': 'application/json' } });
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
        localPresets: [],
        paramDefaults: PARAM_DEFAULTS,
        capabilities: capabilities === null ? defaultCapabilities(config) : capabilities
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

  return { fetchCalls, renderRoot, api, locale };
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

/** 「常规」参数表：云端模型，四个逻辑字段都有字段模板（老配置形状，没有 params）。 */
const PARAM_TABLE_CONFIG = {
  providers: [{
    ...CLOUD_CONFIG.providers[0],
    modelOptions: {
      'gpt-image-2.5-flare': {
        fields: {
          prompt: { path: 'prompt' },
          negative: { path: 'negative_prompt' },
          model: { path: 'model' },
          n: { path: 'n' }
        }
      }
    }
  }],
  active: CLOUD_CONFIG.active,
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
  const select = findAll(panel, (node) => node.type === 'select'
    && node.props['data-param-key'] === 'size')[0];
  assert.ok(select, 'the encoding select is there');
  assert.deepEqual(findAll(select, (node) => node.type === 'option').map((node) => String(node.props.value)),
    ['', 'wh-string', 'wh-fields', 'aspect', 'tier', 'prompt']);
  const input = findAll(panel, (node) => node.type === 'input' && node.props['data-param-key'] === 'size')[0];
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

/* ───────────── 解析参数：原始值输入 → 离散参数表的行 ───────────── */

const PARAMS_RESPONSE = {
  ok: true,
  format: 'api',
  count: 2,
  params: [
    { node: '18:7', input: 'steps', name: 'steps', classType: 'KSampler', type: 'number', value: 25, display: '25' },
    { node: '18:5', input: 'text', name: 'text', classType: 'CLIPTextEncode', type: 'text', value: 'a cat', display: 'a cat' }
  ]
};

/** 打开 ComfyUI 折叠区，填一段工作流，点「解析参数」，返回（重渲染后的）harness。 */
async function openParsedParams(response = PARAMS_RESPONSE) {
  const built = await openEditor(CONFIG, { params: response });
  optionsToggle(built.tree).props.onClick(fakeEvent());
  let opened = built.harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  findAll(panel, (node) => node.type === 'textarea')[0]
    .props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = built.harness.renderRoot();
  const parse = findButton(opened, (node) => /Parse parameters/i.test(textOf(node).join('')));
  assert.ok(parse, 'expected a parse-parameters button');
  await parse.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  return built.harness;
}

test('解析参数 posts the workflow and lists the literal inputs', async () => {
  const harness = await openParsedParams();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/comfy/params'));
  assert.equal(posted.length, 1, 'expected one params POST');
  assert.equal(JSON.parse(posted[0].body).workflow, '{"1":{"class_type":"KSampler"}}');
  const opened = harness.renderRoot();
  const boxes = findAll(opened, (node) => node.type === 'input' && node.props['data-param-candidate']);
  assert.deepEqual(boxes.map((box) => box.props['data-param-candidate']), ['18:7.steps', '18:5.text']);
  assert.ok(boxes.every((box) => box.props.checked === false), 'nothing is picked before the user picks');
  assert.equal(findAll(opened, (node) => node.props['data-param-key'] === 'params:add').length, 0,
    'ComfyUI rows come from parsing, not from a blank row');
});

test('checking a candidate turns it into a table row with node/input, default and type', async () => {
  const harness = await openParsedParams();
  let opened = harness.renderRoot();
  const box = findAll(opened, (node) => node.type === 'input' && node.props['data-param-candidate'] === '18:7.steps')[0];
  assert.ok(box, 'expected the steps candidate');
  box.props.onChange();
  opened = harness.renderRoot();
  const bind = findAll(opened, (node) => node.props && node.props['data-param-bind-target'] === '18:7.steps');
  assert.equal(bind.length, 1, 'the row shows where it lands in the workflow');
  assert.equal(findAll(opened, (node) => node.type === 'input'
    && node.props['data-param-candidate'] === '18:7.steps')[0].props.checked, true,
  'the candidate stays checked while its row exists');

  // 取消勾选 = 从表里移除那一行；再勾上又回来。
  findAll(opened, (node) => node.type === 'input' && node.props['data-param-candidate'] === '18:7.steps')[0]
    .props.onChange();
  let cleared = harness.renderRoot();
  assert.equal(findAll(cleared, (node) => node.props && node.props['data-param-bind-target'] === '18:7.steps').length, 0,
    'unchecking removes the row');
  findAll(cleared, (node) => node.type === 'input' && node.props['data-param-candidate'] === '18:7.steps')[0]
    .props.onChange();
  opened = harness.renderRoot();

  const save = findButton(opened, (node) => /save/i.test(textOf(node).join('')));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/config'));
  const body = JSON.parse(posted[posted.length - 1].body);
  const entry = body.config.providers.find((item) => item.id === 'p1').modelOptions['flux.safetensors'];
  assert.ok(Array.isArray(entry.params) && entry.params.length === 1, 'the picked candidate must be saved as a row');
  const row = entry.params[0];
  assert.equal(row.node, '18:7');
  assert.equal(row.input, 'steps');
  assert.equal(row.name, 'steps');
  assert.equal(row.type, 'number', 'INT folds into the table vocabulary');
  assert.equal(row.default, '25', 'the default is the value the workflow carries');
  assert.equal(row.expose, false, 'picking a row is not the same as exposing it');
});

test('a parse failure shows the host error instead of failing silently', async () => {
  const harness = await openParsedParams({ ok: false, error: '工作流不是合法 JSON：Unexpected token n' });
  const text = textOf(harness.renderRoot()).join(' ');
  assert.match(text, /Parameter parsing failed/, 'the panel says what failed');
  assert.match(text, /Unexpected token n/, 'and repeats the readable reason');
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
  // 提示词行被挡在外面（它走工具参数），剩下的才是可调参数行；类型也折成表里的词表。
  assert.ok(Array.isArray(entry.params) && entry.params.length === 1, 'params must be stored too');
  assert.equal(entry.params[0].name, 'steps');
  assert.equal(entry.params[0].node, '18:7');
  assert.equal(entry.params[0].input, 'steps');
  assert.equal(entry.params[0].type, 'number');
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
  assert.ok(!findAll(panel, (node) => node.type === 'textarea').length, 'A1111 has no workflow box');
  // 参数表现在是唯一一张表：六行 sdapi 字段，每行一个「暴露」开关。
  const names = findAll(panel, (node) => node.props['data-param-field'] === 'name').map((node) => String(node.props.value));
  assert.deepEqual(names, ['steps', 'cfg_scale', 'sampler_name', 'scheduler', 'seed', 'denoising_strength']);
  const descriptions = findAll(panel, (node) => node.props['data-param-field'] === 'description')
    .map((node) => String(node.props.value)).join(' ');
  assert.match(descriptions, /Sampling steps/i, '每一行都带着给对话模型看的说明');
  assert.match(descriptions, /prompt constrains the image/i);
  const boxes = findAll(panel, (node) => node.type === 'input' && node.props.type === 'checkbox'
    && node.props['data-param-field'] === 'expose');
  assert.equal(boxes.length, 6);
  assert.ok(boxes.every((box) => box.props.checked === false), 'everything starts unchecked');
});

test('switching an A1111 parameter on persists it on the row, not in the old expose map', async () => {
  const { harness, tree } = await openEditor(A1111_SAMPLING_CONFIG);
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const boxes = findAll(panel, (node) => node.type === 'input' && node.props.type === 'checkbox'
    && node.props['data-param-field'] === 'expose');
  boxes[0].props.onChange({ target: { checked: true } });
  opened = harness.renderRoot();
  const save = findButton(opened, (node) => /save/i.test(textOf(node).join('')));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes('/api/mo-image/config'));
  const body = JSON.parse(posted[posted.length - 1].body);
  const provider = body.config.providers.find((item) => item.id === 'p4');
  const entry = provider.modelOptions['sd15.safetensors'];
  assert.equal(entry.expose, undefined, 'the old per-name switch map is gone');
  assert.equal(entry.params[0].name, 'steps');
  assert.equal(entry.params[0].expose, true);
  assert.equal(entry.params[1].expose, false, 'the rest stay off');
  assert.equal(entry.params[0].default, '20', 'the seeded default travels with the row');
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

test('展开面板不再渲染规则摘要：规则只活在检测里，面板上只剩锁与手填', async () => {
  for (const detect of [DETECTED_QWEN, DETECTED_UNKNOWN]) {
    const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { detect });
    await configureAll(harness);
    const opened = openModelPanel(harness);
    assert.equal(findAll(opened, (node) => node.props && node.props['data-rule-summary'] !== undefined).length, 0,
      '摘要节点不该再出现');
    const body = textOf(opened).join(' ');
    assert.doesNotMatch(body, /By .* rule/, '命中规则的摘要文案不再显示');
    assert.doesNotMatch(body, /No matching rule/, '未命中的摘要文案也不再显示');
  }
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

test('「全部解锁」把预设提供商的锁一次全解开', async () => {
  const { harness } = await openEditor(PRESET_CONFIG);
  let opened = openModelPanel(harness);
  const unlock = findButton(opened, (node) => /Unlock all/i.test(textOf(node).join('')));
  assert.ok(unlock, '「高级」里要有全部解锁');
  unlock.props.onClick(fakeEvent());
  opened = harness.renderRoot();
  // 「常规」现在是参数表：prompt 行是代表键，其余三行按字段模板有没有出现。
  for (const key of ['size', 'quality', 'prompt', 'image']) {
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
  // 现有参数的控件都在折叠区里（没有字段模板的行不渲染），锁图标与摘要留在外面。
  for (const key of ['size', 'quality', 'prompt', 'image']) {
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

test('一键配置补上质量模板（否则质量永远是死的）', async () => {
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
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.deepEqual(entry.fields.quality, { path: 'quality' });
  // 抄进来的是「质量」方框的新形状：勾上 + 档位表 + 规则那个默认档的标记。
  assert.deepEqual(entry.quality, {
    supported: true,
    field: 'quality',
    options: [
      { label: '', value: 'low', default: false },
      { label: '', value: 'high', default: true }
    ],
    default: 'high'
  }, '质量覆盖要一起写，而且写成方框认的形状');
});

test('一键配置不会撤销「这个模型不发质量」：用户关掉过的保持关掉', async () => {
  // 中转站没有 presetId（锁默认全开），所以「上锁即保护」在这里不成立：
  // 用户明确取消勾选过的质量要像上锁一样挡住规则写入。
  const declined = {
    providers: [{
      id: 'p9', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
      key: '', hasKey: true, adapter: 'custom', protocol: 'openai-images', optionalKey: false,
      customEndpoints: {
        generate: 'https://api.siliconflow.cn/v1/images/generations',
        edit: '',
        models: 'https://api.siliconflow.cn/v1/models'
      },
      models: ['Qwen/Qwen-Image'], names: {},
      modelOptions: { 'Qwen/Qwen-Image': { quality: { supported: false } } }
    }],
    active: { providerId: 'p9', model: 'Qwen/Qwen-Image' },
    defaults: {}
  };
  const detect = {
    ok: true,
    models: ['Qwen/Qwen-Image'],
    rules: {
      'Qwen/Qwen-Image': {
        size: { mode: 'wh-string', field: 'image_size', separator: 'x', second: null, domain: {} },
        quality: { field: 'quality', options: ['low', 'high'], default: 'high', map: null }
      }
    },
    fields: { 'Qwen/Qwen-Image': { prompt: { path: 'prompt' } } },
    matched: { 'Qwen/Qwen-Image': true }
  };
  const { harness } = await openEditor(declined, { detect: detect });
  await configureAll(harness);
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.deepEqual(entry.quality, { supported: false }, '规则说收也不算：用户关掉过');
  assert.deepEqual(entry.size, { mode: 'wh-string', field: 'image_size', separator: 'x' }, '别的键照旧抄');
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

/* ───────────────────── 参数面板的排版：单行 vs 方框（只改布局） ───────────────────── */

/** 面板里的一行：单输入的参数一行，多输入的参数放进方框里。 */
const paramRow = (tree, key) => findAll(tree, (node) => node.props && node.props['data-param-row'] === key)[0] || null;
const paramBox = (tree, key) => findAll(tree, (node) => node.props && node.props['data-param-box'] === key)[0] || null;

/** 用 modelOptions 里的尺寸覆盖把面板摆成指定编码方式的样子。 */
function sizedConfig(mode, extra = {}) {
  return {
    providers: [{
      id: 'p7', name: 'Sized Relay', baseUrl: 'https://gateway.example/v1',
      key: '', hasKey: true, adapter: '', protocol: 'openai-images', optionalKey: false,
      models: ['m1'], names: {},
      modelOptions: { m1: { size: Object.assign({ mode }, extra) } }
    }],
    active: { providerId: 'p7', model: 'm1' },
    defaults: {}
  };
}

test('单行用 flex 排版：label 不伸缩，输入框吃满剩余宽度，锁原地不动', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const row = paramRow(opened, 'size:field');
  assert.equal(row.props.style.display, 'flex');
  assert.equal(row.props.style.minWidth, 0);
  assert.equal(row.children[0].props.style.flex, 'none', 'label 不参与伸缩：变长时挤的是输入框，右侧不变');
  const input = row.children[1];
  assert.equal(input.props.style.flex, '1 1 auto');
  assert.equal(input.props.style.minWidth, 0, 'min-width:0 才允许被长 label 挤窄');
  assert.equal(row.children[2], null, '尺寸行没有行尾锁（锁在标题行）');
});

/* ───────────────────── 「常规」离散参数表：表头 / 行 / 单元格 ───────────────────── */

const commonBox = (tree) => paramBox(tree, 'common');
const paramGrid = (tree, key) => findAll(tree, (node) => node.props && node.props['data-param-grid'] === key);
const commonRows = (tree) => findAll(commonBox(tree), (node) => node.props
  && node.props['data-param-grid'] === 'params:row');
const commonRow = (tree, role) => commonRows(tree)
  .find((node) => node.props['data-param-role'] === role) || null;
const paramCell = (row, field) => findAll(row, (node) => node.props
  && node.props['data-param-field'] === field)[0] || null;
const addParamButton = (tree) => findAll(commonBox(tree), (node) => node.props
  && node.props['data-param-key'] === 'params:add')[0] || null;
/** 保存后落进配置的那条模型选项（表格用例都是 CLOUD_CONFIG 的 p2）。 */
const savedTableEntry = async (harness) => {
  const config = await saveAndPosted(harness);
  return config.providers.find((item) => item.id === 'p2').modelOptions['gpt-image-2.5-flare'];
};

test('「常规」是一张离散参数表：表头用 data-param-grid，表体一行一个参数', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  const opened = openModelPanel(harness);
  const box = commonBox(opened);
  assert.ok(box, '「常规」方框存在');
  assert.equal(textOf(box.children[0].children[0]).join(''), 'General', '第一行仍是标题「常规」');

  const head = paramGrid(opened, 'params:head')[0];
  assert.ok(head, '表头行在');
  assert.deepEqual(textOf(head).join('|').split('|'),
    ['Parameter name', 'Type', 'Default', 'Description', 'Expose'],
    '表头：参数名 / 类型 / 默认值 / 描述 / 暴露');
  assert.equal(paramRow(box, 'prompt'), null, '表头不占用 data-param-row');
  assert.equal(paramRow(box, 'negative'), null, '表体也不占用 data-param-row（label 不再固定 88px）');

  const rows = commonRows(opened);
  assert.deepEqual(rows.map((row) => row.props['data-param-role']),
    ['prompt', 'negative', 'model', 'n'], '内置四行按固定顺序排列');
  for (const row of rows) {
    for (const field of ['name', 'type', 'default', 'description', 'expose']) {
      assert.ok(paramCell(row, field), row.props['data-param-role'] + ' 缺 ' + field + ' 单元格');
    }
  }
});

test('提示词是固定第一行：不可删、暴露固定、类型固定 text、默认空，只有名字能改', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  const opened = openModelPanel(harness);
  const row = commonRow(opened, 'prompt');
  assert.ok(row, '提示词行在');
  assert.equal(commonRows(opened)[0].props['data-param-role'], 'prompt', '固定第一行');
  assert.equal(paramCell(row, 'remove'), null, '行尾没有删除按钮');

  const type = paramCell(row, 'type');
  assert.equal(type.props.value, 'text', '类型固定 text');
  assert.equal(type.props.disabled, true, '类型不能改');
  const def = paramCell(row, 'default');
  assert.equal(def.props.value, '');
  assert.equal(def.props.disabled, true, '默认值固定空');
  const expose = paramCell(row, 'expose');
  assert.equal(expose.props.checked, true, '暴露固定勾选');
  assert.equal(expose.props.disabled, true, '暴露不能取消');
  const name = paramCell(row, 'name');
  assert.notEqual(name.props.disabled, true, '只有参数名能改');
  assert.equal(name.props['data-param-key'], 'prompt', '参数名沿用内置键，旧的查询仍可用');

  name.props.onChange({ target: { value: 'input.prompt' } });
  const next = harness.renderRoot();
  assert.equal(paramCell(commonRow(next, 'prompt'), 'name').props.value, 'input.prompt');
  const entry = await savedTableEntry(harness);
  assert.equal(entry.fields.prompt.path, 'input.prompt', '改名同步到字段模板');
  assert.deepEqual(entry.params[0], {
    role: 'prompt', name: 'input.prompt', type: 'text', default: '',
    description: 'Image prompt', expose: true
  }, '固定属性照旧，名字变了');
});

test('普通行可以新增 / 编辑 / 删除；删掉内置行会去掉对应的字段模板', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  assert.equal(commonRows(opened).length, 4);

  // 删除内置的负面词行：参数表与字段模板一起清掉。
  paramCell(commonRow(opened, 'negative'), 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.equal(commonRow(opened, 'negative'), null, '负面词行没了');
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']),
    ['prompt', 'model', 'n']);

  // 新增一行：用户行没有 role。
  addParamButton(opened).props.onClick();
  opened = harness.renderRoot();
  let rows = commonRows(opened);
  assert.equal(rows.length, 4, '新增的一行立刻出现');
  const custom = rows[3];
  assert.equal(custom.props['data-param-role'], undefined, '用户行没有 role');
  assert.equal(paramCell(custom, 'name').props.value, '', '新行等着填名字');

  const edit = (field, value) => {
    paramCell(commonRows(harness.renderRoot())[3], field).props.onChange({ target: { value: value } });
    return harness.renderRoot();
  };
  edit('name', 'seed');
  edit('type', 'number');
  edit('default', '42');
  opened = edit('description', 'Seed value');
  paramCell(commonRows(opened)[3], 'expose').props.onChange({ target: { checked: true } });
  opened = harness.renderRoot();
  assert.equal(paramCell(commonRows(opened)[3], 'expose').props.checked, true);

  const entry = await savedTableEntry(harness);
  assert.equal(entry.fields.negative, undefined, '删掉内置行 = 去掉字段模板覆盖');
  assert.equal(entry.fields.model.path, 'model', '别的字段模板不动');
  const seed = entry.params.find((row) => row.name === 'seed');
  assert.deepEqual(seed, {
    name: 'seed', type: 'number', default: '42', description: 'Seed value', expose: true
  }, '用户行只进参数表，没有 role');
});

test('删用户行只动参数表，不动字段模板', async () => {
  const stored = {
    providers: [{
      ...PARAM_TABLE_CONFIG.providers[0],
      modelOptions: {
        'gpt-image-2.5-flare': {
          fields: { prompt: { path: 'prompt' }, model: { path: 'model' } },
          params: [
            { role: 'prompt', name: 'prompt', type: 'text', default: '', description: 'p', expose: true },
            { name: 'seed', type: 'number', default: '42', description: 's', expose: true }
          ]
        }
      }
    }],
    active: PARAM_TABLE_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(stored);
  let opened = openModelPanel(harness);
  assert.equal(commonRows(opened).length, 3, '提示词 + 模型（来自 fields） + 用户行');
  const seedRow = commonRows(opened).find((row) => !row.props['data-param-role']);
  paramCell(seedRow, 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.equal(commonRows(opened).some((row) => !row.props['data-param-role']), false, '用户行删掉了');
  const entry = await savedTableEntry(harness);
  assert.equal(entry.params.some((row) => row.name === 'seed'), false);
  assert.equal(entry.fields.model.path, 'model', '删用户行不动字段模板');
});

test('type 选 enum 时行内多一个「选项」输入，逗号分隔落盘', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  assert.equal(paramCell(commonRow(opened, 'negative'), 'options'), null, '非 enum 不显示选项');

  paramCell(commonRow(opened, 'negative'), 'type').props.onChange({ target: { value: 'enum' } });
  opened = harness.renderRoot();
  const options = paramCell(commonRow(opened, 'negative'), 'options');
  assert.ok(options, 'enum 行内出现选项输入');
  options.props.onChange({ target: { value: 'euler, ddim' } });
  opened = harness.renderRoot();
  assert.equal(paramCell(commonRow(opened, 'negative'), 'options').props.value, 'euler, ddim');

  const entry = await savedTableEntry(harness);
  const negative = entry.params.find((row) => row.role === 'negative');
  assert.equal(negative.type, 'enum');
  assert.deepEqual(negative.options, ['euler', 'ddim']);

  paramCell(commonRow(opened, 'negative'), 'type').props.onChange({ target: { value: 'text' } });
  opened = harness.renderRoot();
  assert.equal(paramCell(commonRow(opened, 'negative'), 'options'), null, '切回 text 后选项收起');
});

test('老配置没有 params 时从 fields 派生；没有的字段不显示行', async () => {
  const migrated = {
    providers: [{
      ...PARAM_TABLE_CONFIG.providers[0],
      modelOptions: {
        'gpt-image-2.5-flare': {
          fields: {
            prompt: { path: 'prompt' },
            negative: { path: 'negative_prompt' },
            model: { path: 'model' },
            n: null
          }
        }
      }
    }],
    active: PARAM_TABLE_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(migrated);
  const opened = openModelPanel(harness);
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']),
    ['prompt', 'negative', 'model'], 'n 是显式不发，不显示行');
  assert.equal(paramCell(commonRow(opened, 'negative'), 'name').props.value, 'negative_prompt');
  assert.equal(paramCell(commonRow(opened, 'negative'), 'description').props.value, 'What to avoid',
    '描述默认值来自内置文案表');

  // 第一次编辑就把派生行落成 params（不再依赖 fields）。
  paramCell(commonRow(opened, 'model'), 'expose').props.onChange({ target: { checked: true } });
  const entry = await savedTableEntry(harness);
  assert.deepEqual(entry.params.map((row) => row.role), ['prompt', 'negative', 'model']);
  assert.equal(entry.params[1].name, 'negative_prompt');
  assert.equal(entry.params[2].expose, true);
});

test('没有 fields 也没有 params 的老配置只剩固定的提示词行', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']), ['prompt']);
});

test('params 回读：类型 / 默认值 / 描述 / 暴露按落盘的来', async () => {
  const stored = {
    providers: [{
      ...PARAM_TABLE_CONFIG.providers[0],
      modelOptions: {
        'gpt-image-2.5-flare': {
          params: [
            { role: 'prompt', name: 'prompt', type: 'text', default: '', description: 'custom prompt doc', expose: true },
            {
              role: 'negative', name: 'negative_prompt', type: 'enum', default: 'blurry',
              description: 'avoid', expose: false, options: ['blurry', 'low quality']
            },
            { name: 'seed', type: 'number', default: '42', description: 'seed', expose: true }
          ]
        }
      }
    }],
    active: PARAM_TABLE_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(stored);
  const opened = openModelPanel(harness);
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']),
    ['prompt', 'negative', undefined], '内置行在前，用户行在后');
  const negative = commonRow(opened, 'negative');
  assert.equal(paramCell(negative, 'type').props.value, 'enum');
  assert.equal(paramCell(negative, 'default').props.value, 'blurry');
  assert.equal(paramCell(negative, 'description').props.value, 'avoid');
  assert.equal(paramCell(negative, 'expose').props.checked, false);
  assert.equal(paramCell(negative, 'options').props.value, 'blurry, low quality');
  const custom = commonRows(opened)[2];
  assert.equal(paramCell(custom, 'name').props.value, 'seed');
  assert.equal(paramCell(custom, 'expose').props.checked, true);
  assert.equal(paramCell(commonRow(opened, 'prompt'), 'description').props.value, 'custom prompt doc');
});

test('params 落盘后能通过 config-store 回读（端到端）', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  paramCell(commonRow(opened, 'prompt'), 'name').props.onChange({ target: { value: 'input.prompt' } });
  opened = harness.renderRoot();
  addParamButton(opened).props.onClick();
  opened = harness.renderRoot();
  const edit = (field, value) => {
    paramCell(commonRows(harness.renderRoot())[4], field).props.onChange({ target: { value: value } });
    return harness.renderRoot();
  };
  edit('name', 'seed');
  edit('type', 'number');
  edit('default', '42');
  opened = edit('description', 'Random seed');
  paramCell(commonRows(opened)[4], 'expose').props.onChange({ target: { checked: true } });
  opened = harness.renderRoot();

  const saved = await saveAndPosted(harness);
  const normalized = normalizeConfig(saved).providers.find((item) => item.id === 'p2')
    .modelOptions['gpt-image-2.5-flare'];
  assert.equal(normalized.fields.prompt.path, 'input.prompt', '改名同步的字段模板也落盘了');
  assert.deepEqual(normalized.params.map((row) => row.role || row.name),
    ['prompt', 'negative', 'model', 'n', 'seed'], '内置行在前，用户行在后');
  assert.equal(normalized.params[0].name, 'input.prompt');
  assert.deepEqual(normalized.params[4], {
    name: 'seed', type: 'number', default: '42', description: 'Random seed', expose: true
  });
});

test('整块上锁：框内控件与增删按钮全部禁用，解锁后恢复', async () => {
  const locked = {
    providers: [{
      ...PARAM_TABLE_CONFIG.providers[0],
      modelOptions: {
        'gpt-image-2.5-flare': {
          fields: PARAM_TABLE_CONFIG.providers[0].modelOptions['gpt-image-2.5-flare'].fields,
          locked: { prompt: true }
        }
      }
    }],
    active: PARAM_TABLE_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(locked);
  let opened = openModelPanel(harness);
  const lock = paramLock(opened, 'prompt');
  assert.ok(lock, '锁挂在「常规」标题行（复用 prompt 这个键）');
  assert.equal(lock.props['aria-pressed'], 'true');
  for (const control of findAll(commonBox(opened),
    (node) => ['input', 'select', 'button'].includes(node.type))) {
    if (control.props['data-lock-key']) continue; // 锁按钮自己永远可点
    assert.equal(control.props.disabled, true, '上锁后框里每个控件都禁用');
  }
  assert.equal(addParamButton(opened).props.disabled, true, '新增按钮也禁用');

  lock.props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.equal(paramLock(opened, 'prompt').props['aria-pressed'], 'false');
  for (const row of commonRows(opened)) {
    assert.notEqual(paramCell(row, 'name').props.disabled, true, '解锁后参数名可编辑');
  }
  const negative = commonRow(opened, 'negative');
  assert.notEqual(paramCell(negative, 'expose').props.disabled, true);
  assert.notEqual(addParamButton(opened).props.disabled, true, '新增按钮解禁');
});

test('一键配置改字段路径时，已存的参数表内置行名字跟着走', async () => {
  const stored = {
    providers: [{
      ...CUSTOM_RELAY_CONFIG.providers[0],
      modelOptions: {
        'Qwen/Qwen-Image': {
          params: [
            { role: 'prompt', name: 'old_prompt', type: 'text', default: '', description: 'p', expose: true },
            { role: 'negative', name: 'old_negative', type: 'text', default: '', description: 'n', expose: false },
            { name: 'seed', type: 'number', default: '42', description: 's', expose: true }
          ]
        }
      }
    }],
    active: CUSTOM_RELAY_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(stored, { detect: DETECTED_QWEN });
  await configureAll(harness);
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.equal(entry.fields.prompt.path, 'prompt');
  assert.equal(entry.params.find((row) => row.role === 'prompt').name, 'prompt',
    '规则改过的字段路径要同步进参数表');
  assert.equal(entry.params.find((row) => row.role === 'negative').name, 'negative_prompt');
  assert.deepEqual(entry.params.find((row) => row.name === 'seed'), {
    name: 'seed', type: 'number', default: '42', description: 's', expose: true
  }, '用户行不动');
});

/* ───────────────────── 排版微调：标题字号 / 固定 label 宽度 / 即时气泡 ───────────────────── */

/** 行 label 的固定宽度：所有行输入框的起点就靠它对齐。 */
const LABEL_W = 88;

/** 悬停用：给气泡定位与「是否截断」判断一个假的 DOM 度量。 */
function tipTarget({ scrollWidth = 0, clientWidth = 0 } = {}) {
  return {
    scrollWidth: scrollWidth,
    clientWidth: clientWidth,
    getBoundingClientRect: () => ({ left: 24, top: 120, bottom: 140, right: 112, width: 88, height: 20 })
  };
}

/** 渲染树里的自绘气泡（悬停才挂载，role=tooltip）。 */
const tipNodes = (tree) => findAll(tree, (node) => node.props && node.props.role === 'tooltip');

test('方框标题比正文大一号并加粗，锁仍在标题行原位', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const titles = { common: 'General', size: 'Size', image: 'Reference image' };
  for (const key of Object.keys(titles)) {
    const head = paramBox(opened, key).children[0];
    const title = head.children[0];
    assert.equal(textOf(title).join(''), titles[key], key + ' 的标题文案没变');
    assert.equal(title.props.style.fontSize, 14, key + ' 的标题比正文大一号');
    assert.equal(title.props.style.fontWeight, 600, key + ' 的标题加粗');
  }
  // 三个方框的锁都在标题行；「常规」的锁复用 prompt 键，管的是整张参数表。
  for (const [key, lockKey] of [['common', 'prompt'], ['size', 'size'], ['image', 'image']]) {
    const head = paramBox(opened, key).children[0];
    const last = head.children[head.children.length - 1];
    assert.equal(last.type, 'button', key + ' 的锁还在标题行');
    assert.equal(last.props['data-lock-key'], lockKey);
  }
});

test('参数行 label 固定 88px 并单行截断：长键名不再把输入框挤没', async () => {
  const { harness } = await openEditor(sizedConfig('aspect', {
    field: 'aspect_ratio', second: { from: 'aspect', field: 'imageSize' }
  }));
  const opened = openModelPanel(harness);
  const rows = findAll(opened, (node) => node.props && node.props['data-param-row']);
  // 编码方式 / 比例 / 分辨率 / 质量勾选 / 参考图四条 ——「常规」已经是参数表，不在这批里。
  assert.ok(rows.length >= 8, '三个方框里的行都在');
  for (const row of rows) {
    const label = row.children[0];
    const key = row.props['data-param-row'];
    assert.equal(label.type, 'span', key + ' 的行首仍是 label');
    assert.equal(label.props.style.width, LABEL_W, key + ' 的 label 是固定宽度');
    assert.equal(label.props.style.minWidth, LABEL_W, key + ' 的 label 不会被压窄');
    assert.equal(label.props.style.flex, 'none', key + ' 的 label 不参与伸缩');
    assert.equal(label.props.style.overflow, 'hidden', key + ' 的 label 裁掉超出的文字');
    assert.equal(label.props.style.textOverflow, 'ellipsis', key + ' 的 label 超长显示省略号');
    assert.equal(label.props.style.whiteSpace, 'nowrap', key + ' 的 label 不换行');
    // 截断是视觉的：DOM 里仍是完整文案，悬停气泡才有全名可给。
    assert.ok(textOf(label).join('').length > 0, key + ' 的 label 有文本');
  }
});

test('所有行的输入框左边缘严格对齐：同一个 x', async () => {
  const { harness } = await openEditor(sizedConfig('aspect', {
    field: 'aspect_ratio', second: { from: 'aspect', field: 'imageSize' }
  }));
  const opened = openModelPanel(harness);
  const starts = new Set();
  let rows = 0;
  for (const key of ['common', 'size', 'image']) {
    const box = paramBox(opened, key);
    assert.ok(box, key + ' 方框在');
    // '8px 10px' → 左边距 10。
    const padLeft = Number(String(box.props.style.padding).split(/\s+/).pop().replace('px', ''));
    const boxRows = findAll(box, (node) => node.props && node.props['data-param-row']);
    for (const row of boxRows) {
      rows += 1;
      const label = row.children[0];
      const control = row.children[1];
      assert.ok(control, row.props['data-param-row'] + ' 的控件紧跟在 label 后面');
      assert.equal(label.props.style.margin, 0, 'label 没有外边距把输入框推偏');
      starts.add(padLeft + label.props.style.width + Number(row.props.style.gap));
    }
  }
  assert.ok(rows >= 7, '尺寸与参考图的行都在');
  // 每一行都是「内边距 10 + label 88 + 间距 6」：输入框的起点 x 完全一致。
  assert.deepEqual([...starts], [104], '所有行的输入框起点必须是同一个 x');
});

test('德语 / 俄语的长参数名只截断 label，输入框照样吃满剩余宽度', async () => {
  const cases = [
    ['de', 'Parametername: Auflösung'],
    ['ru', 'Имя параметра: разрешение']
  ];
  for (const [lang, expected] of cases) {
    const { harness } = await openEditor(sizedConfig('aspect', {
      field: 'aspect_ratio', second: { from: 'aspect', field: 'imageSize' }
    }));
    // 面板打开后再切语言：设置页的 Edit 按钮文案跟着语言变，先按英文进面板。
    harness.locale.active = lang;
    const opened = openModelPanel(harness);
    const resolution = paramRow(opened, 'size:second');
    assert.equal(textOf(resolution.children[0]).join(''), expected, lang + ' 的长键名完整保留在 DOM 里');
    // 截断的是 label，不是输入框：固定宽度、输入框仍吃满剩余宽度。
    for (const key of ['size:mode', 'size:field', 'size:second']) {
      const row = paramRow(opened, key);
      assert.equal(row.children[0].props.style.width, LABEL_W, lang + ' 的 ' + key + ' label 仍是固定宽度');
      assert.equal(row.children[1].props.style.flex, '1 1 auto', lang + ' 的 ' + key + ' 输入框仍吃满剩余宽度');
      assert.equal(row.children[1].props.style.minWidth, 0, lang + ' 的 ' + key + ' 输入框不会被 label 顶出去');
    }
  }
});

test('被截断的 label 悬停立刻显示完整文案；没截断的不弹', async () => {
  // 没截断（88px 放得下）：完整文案就在眼前，不弹。
  const short = await openEditor(CLOUD_CONFIG);
  let panel = openModelPanel(short.harness);
  const quality = paramRow(panel, 'quality:supported').children[0];
  assert.equal(textOf(quality).join(''), 'Supports quality');
  quality.props.ref.current = tipTarget({ scrollWidth: 60, clientWidth: LABEL_W });
  quality.props.onPointerEnter();
  panel = short.harness.renderRoot();
  assert.equal(tipNodes(panel).length, 0, '没被截断的 label 不该弹气泡');

  // 截断（德语/俄语那种长键名）：悬停立刻给全名，不经过原生 title 的 1 秒延迟。
  const long = await openEditor(sizedConfig('aspect', {
    field: 'aspect_ratio', second: { from: 'aspect', field: 'imageSize' }
  }));
  panel = openModelPanel(long.harness);
  const resolution = paramRow(panel, 'size:second').children[0];
  assert.equal(textOf(resolution).join(''), 'Parameter name: resolution', 'DOM 里保留完整文案');
  assert.equal(resolution.props.title, undefined, '不能用有延迟的原生 title');
  resolution.props.ref.current = tipTarget({ scrollWidth: 220, clientWidth: LABEL_W });
  resolution.props.onPointerEnter();
  panel = long.harness.renderRoot();
  const tip = findAll(paramRow(panel, 'size:second').children[0],
    (node) => node.props && node.props.role === 'tooltip')[0];
  assert.ok(tip, '悬停立刻出现气泡');
  assert.equal(tip.props.style.position, 'fixed');
  assert.equal(tip.props['data-instant-tip'], '', '自绘气泡结构在');
  assert.equal(textOf(tip).join(''), 'Parameter name: resolution', '气泡里是完整文案');
  // 移开就收起。
  paramRow(panel, 'size:second').children[0].props.onPointerLeave();
  panel = long.harness.renderRoot();
  assert.equal(tipNodes(panel).length, 0, '移开鼠标就收起');
});

test('协议问号：悬停立刻弹出气泡，三条地址一行一条', async () => {
  const { harness, tree } = await openEditor(CLOUD_CONFIG);
  const help = findAll(tree, (node) => node.props && node.props['data-route-help'] !== undefined)[0];
  assert.ok(help, '协议 label 右侧的问号在');
  assert.equal(help.props.title, undefined, '不再用有延迟的原生 title');
  assert.equal(typeof help.props.onPointerEnter, 'function', '悬停立刻展开');
  help.props.ref.current = tipTarget();
  help.props.onPointerEnter();
  const opened = harness.renderRoot();
  const tip = tipNodes(opened)[0];
  assert.ok(tip, '悬停立刻出现气泡');
  assert.equal(tip.props.style.position, 'fixed');
  assert.equal(tip.props.style.whiteSpace, 'pre-line', '气泡按 \\n 分行');
  const lines = String(tip.children[0]).split('\n');
  assert.deepEqual(lines,
    ['Text-to-image：Not supported', 'Image-to-image：Not supported', 'List models：Not supported'],
    '三条地址各占一行（这里协议表为空，所以都是「不支持」）');
});

test('尺寸是多输入参数：一个方框，标题行带锁，框内每行一个输入', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'size');
  assert.ok(box, '尺寸应该被方框框起来');
  const head = box.children[0];
  assert.equal(textOf(head.children[0]).join(''), 'Size', '第一行是标题「尺寸」');
  assert.ok(findAll(head, (node) => node.type === 'button' && node.props['data-lock-key'] === 'size').length === 1,
    '锁在标题行上，不在每一行的行尾');
  assert.equal(findAll(head, (node) => node.type === 'input').length, 0, '标题行不放输入框');
  assert.ok(paramRow(box, 'size:mode'), '第二行是编码方式');
  assert.ok(paramRow(box, 'size:field'), '第三行是参数名');
  assert.equal(findAll(box, (node) => node.type === 'p').length, 0, '框里不再有说明段落');
});

test('说明文字改成 title：悬停才显示，不占一行', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'size');
  const modeSelect = findAll(box, (node) => node.type === 'select' && node.props['data-param-key'] === 'size')[0];
  assert.ok(modeSelect, '有编码方式下拉');
  assert.match(String(modeSelect.props.title || ''), /adapter decides/i, '尺寸块的说明挂在编码方式上');
  const nameInput = findAll(box, (node) => node.type === 'input' && node.props['data-param-key'] === 'size')[0];
  assert.match(String(nameInput.props.title || ''), /dotted paths/i, '参数名的说明挂在输入框上');
});

test('宽+高 编码方式下有两个参数名输入：宽 / 高，且都能改', async () => {
  const { harness } = await openEditor(sizedConfig('wh-fields'));
  let opened = openModelPanel(harness);
  let box = paramBox(opened, 'size');
  assert.ok(box);
  const width = paramRow(box, 'size:width');
  const height = paramRow(box, 'size:height');
  assert.ok(width, '「参数名：宽」这一行在');
  assert.ok(height, '「参数名：高」这一行在');
  assert.equal(textOf(width.children[0]).join(''), 'Parameter name: width');
  assert.equal(textOf(height.children[0]).join(''), 'Parameter name: height');
  const widthInput = width.children[1];
  const heightInput = height.children[1];
  // 默认就显示 body 里真正会用的两个键名；它们可编辑，不是只读展示。
  assert.equal(widthInput.props.value, 'width');
  assert.equal(heightInput.props.value, 'height');
  assert.equal(widthInput.props.readOnly, undefined, '宽的键名要能改');
  assert.equal(heightInput.props.readOnly, undefined, '高的键名要能改');
  assert.notEqual(widthInput.props.disabled, true, '没上锁就能改');
  assert.equal(widthInput.props['data-param-key'], 'size');
  assert.equal(heightInput.props['data-param-key'], 'size');
  assert.equal(paramRow(box, 'size:field'), null, '宽+高 不再有单个通用参数名');
  assert.equal(paramRow(box, 'size:second'), null, '宽+高 的第二个参数名就是「高」');

  // 改两个键名 → 落盘成 size.field / size.second.field（请求层按这两个名字发）。
  widthInput.props.onChange({ target: { value: 'w' } });
  heightInput.props.onChange({ target: { value: 'h' } });
  opened = harness.renderRoot();
  box = paramBox(opened, 'size');
  assert.equal(paramRow(box, 'size:width').children[1].props.value, 'w');
  assert.equal(paramRow(box, 'size:height').children[1].props.value, 'h');
  const config = await saveAndPosted(harness);
  assert.deepEqual(config.providers[0].modelOptions.m1.size, {
    mode: 'wh-fields', field: 'w', second: { field: 'h' }
  });
});

test('比例+分辨率 编码方式下有两个参数名输入：比例 / 分辨率', async () => {
  const { harness } = await openEditor(sizedConfig('aspect', {
    field: 'aspect_ratio', second: { from: 'aspect', field: 'imageSize' }
  }));
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'size');
  const aspect = paramRow(box, 'size:field');
  const resolution = paramRow(box, 'size:second');
  assert.ok(aspect, '「参数名：比例」这一行在');
  assert.ok(resolution, '「参数名：分辨率」这一行在');
  assert.equal(textOf(aspect).join(''), 'Parameter name: ratio');
  assert.equal(textOf(resolution.children[0]).join(''), 'Parameter name: resolution');
  assert.equal(aspect.children[1].props.value, 'aspect_ratio');
  assert.equal(resolution.children[1].props.value, 'imageSize');
});

test('其它编码方式只有一个参数名输入', async () => {
  for (const mode of ['wh-string', 'tier']) {
    const { harness } = await openEditor(sizedConfig(mode, { field: 'image_size' }));
    const opened = openModelPanel(harness);
    const box = paramBox(opened, 'size');
    assert.ok(paramRow(box, 'size:field'), mode + ' 有参数名这一行');
    assert.equal(paramRow(box, 'size:width'), null, mode + ' 没有「宽」');
    assert.equal(paramRow(box, 'size:height'), null, mode + ' 没有「高」');
    assert.equal(paramRow(box, 'size:second'), null, mode + ' 没有「分辨率」');
    assert.equal(textOf(paramRow(box, 'size:field')).join(''), 'Parameter name', mode + ' 的 label 是通用的「参数名」');
    const nameInputs = findAll(box, (node) => node.type === 'input' && node.props['data-param-key'] === 'size');
    assert.equal(nameInputs.length, 1, mode + ' 只有一个参数名输入');
  }
});

test('prompt 编码方式下没有参数名可填：那一行不出现', async () => {
  const { harness } = await openEditor(sizedConfig('prompt'));
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'size');
  assert.ok(paramBox(opened, 'size'), '尺寸还是个方框');
  assert.ok(paramRow(box, 'size:mode'), '编码方式还在');
  assert.equal(paramRow(box, 'size:field'), null, '该形态不发字段名，别摆一个死键输入');
  assert.equal(findAll(box, (node) => node.type === 'input' && node.props['data-param-key'] === 'size').length, 0);
});

test('上锁时框里的输入全部禁用', async () => {
  const cases = [
    ['aspect', { field: 'aspect_ratio', second: { from: 'aspect', field: 'imageSize' } }, 3], // 编码方式 + 比例 + 分辨率
    ['wh-fields', {}, 3] // 编码方式 + 只读的宽 / 高
  ];
  for (const [mode, extra, least] of cases) {
    const config = sizedConfig(mode, extra);
    config.providers[0].presetId = 'openai'; // 预设来源的提供商默认全锁
    const { harness } = await openEditor(config);
    const opened = openModelPanel(harness);
    const box = paramBox(opened, 'size');
    const controls = findAll(box, (node) => node.type === 'input' || node.type === 'select');
    assert.ok(controls.length >= least, mode + ' 框里的控件数够了');
    assert.equal(paramLock(opened, 'size').props['aria-pressed'], 'true', mode + ' 这个键是上锁的');
    for (const control of controls) {
      assert.equal(control.props.disabled, true, mode + ' 上锁后框里每个控件都该禁用');
    }
  }
});

test('参考图有两个输入，也用方框框起来：字段名 / 传法', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'image');
  assert.ok(box, '参考图应该是一个方框');
  const field = paramRow(box, 'image:field');
  const as = paramRow(box, 'image:as');
  assert.ok(field && as, '字段名与传法各占一行');
  assert.equal(textOf(field.children[0]).join(''), 'Field name');
  assert.equal(textOf(as.children[0]).join(''), 'Encoding');
  assert.equal(field.children[1].props['data-param-key'], 'image');
  assert.equal(as.children[1].props['data-param-key'], 'image.as');
  assert.ok(findAll(box, (node) => node.type === 'button' && node.props['data-lock-key'] === 'image').length === 1,
    '参考图的锁在标题行');
  assert.equal(paramRow(opened, 'image'), null, '参考图不再挤成一整行');
});

test('「常规」只装离散参数表：尺寸 / 质量 / 参考图各在自己的方框里', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'common');
  assert.ok(box, '「常规」方框存在');
  assert.equal(textOf(box.children[0].children[0]).join(''), 'General', '第一行是标题「常规」');
  assert.equal(findAll(box.children[0], (node) => node.props && node.props['data-lock-key'] === 'prompt').length, 1,
    '标题行的锁管整张参数表');

  // 表头与表体都用 data-param-grid：参数行的「label 固定 88px」约定只管单输入行。
  assert.equal(findAll(box, (node) => node.props && node.props['data-param-row']).length, 0);
  assert.equal(paramGrid(opened, 'params:head').length, 1);
  assert.ok(commonRows(opened).length > 0);

  // 四个方框各管一摊：尺寸 / 质量 / 参考图都不在「常规」里。
  assert.equal(paramRow(box, 'size:mode'), null, '尺寸不进「常规」');
  assert.equal(paramRow(box, 'quality:field'), null, '质量不进「常规」：它有自己的方框');
  assert.equal(paramRow(box, 'quality:supported'), null, '质量的勾选框也不在「常规」里');
  assert.equal(paramRow(box, 'image:field'), null, '参考图不进「常规」');
});

test('方框一律占满面板宽度：不再半宽、也不按内容收缩', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  for (const key of ['common', 'size', 'image']) {
    const box = paramBox(opened, key);
    assert.ok(box, key + ' 方框在');
    assert.equal(box.props.style.width, '100%', key + ' 占满宽度');
    assert.equal(box.props.style.boxSizing, 'border-box', key + ' 的 padding 算在宽度里');
    assert.equal(box.props.style.gridColumn, '1 / -1', key + ' 横跨整个面板网格');
    assert.equal(box.props.style.justifySelf, 'stretch');
  }
  assert.equal(paramBox(opened, 'common').props.style.display, 'grid');

  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const details = findAll(panel, (node) => node.type === 'details')[0];
  assert.equal(details.props.style.gridColumn, '1 / -1', '「高级」整个折叠区横跨两列');
  assert.equal(details.props.style.width, '100%');
  const body = findAll(details, (node) => hasClass(node, 'customizedBody'))[0];
  assert.equal(body.props.style.gridTemplateColumns, 'minmax(0, 1fr)', '框体是单列：每个方框都占满');
});

test('自动检测与全部解锁挪进「高级」这一行的右端', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const panel = findAll(opened, (node) => hasClass(node, 'modelAdvanced'))[0];
  const summary = findAll(panel, (node) => node.type === 'summary')[0];
  assert.ok(summary, '「高级」的 summary 在');
  assert.equal(summary.props.style.justifyContent, 'space-between', 'label 左、两个按钮右');

  const detectButton = findAll(summary, (node) => node.type === 'button' && /Auto-detect/.test(textOf(node).join('')))[0];
  const unlockButton = findAll(summary, (node) => node.type === 'button' && /Unlock all/.test(textOf(node).join('')))[0];
  assert.ok(detectButton, '自动检测在 summary 里');
  assert.ok(unlockButton, '全部解锁在 summary 里');
  // 面板上各只剩这一个：没有另一处散落的按钮。
  assert.equal(findAll(panel, (node) => node.type === 'button' && /Auto-detect/.test(textOf(node).join(''))).length, 1);
  assert.equal(findAll(panel, (node) => node.type === 'button' && /Unlock all/.test(textOf(node).join(''))).length, 1);

  // 点按钮不该把折叠区开合：preventDefault / stopPropagation 都要拦住。
  const calls = { prevented: 0, stopped: 0 };
  const event = () => ({
    preventDefault() { calls.prevented += 1; },
    stopPropagation() { calls.stopped += 1; }
  });
  unlockButton.props.onClick(event());
  assert.deepEqual(calls, { prevented: 1, stopped: 1 });
  detectButton.props.onClick(event());
  assert.equal(harness.fetchCalls.filter((call) => call.url.includes('/detect-model-rule')).length, 1,
    '自动检测照旧发起请求');
  assert.equal(calls.prevented, 2);
  assert.equal(calls.stopped, 2);
});

/* ───────── 参考图「传法」：先选传法、后填字段名，不用回来重选 ───────── */

/** 参考图方框里的两个控件：字段名输入、传法下拉。 */
const imageFieldInput = (tree) => paramRow(tree, 'image:field').children[1];
const imageAsSelect = (tree) => paramRow(tree, 'image:as').children[1];

/** 保存后落进配置的那条模型选项（CLOUD_CONFIG 的模型）。 */
async function savedImageEntry(harness) {
  const config = await saveAndPosted(harness);
  const provider = config.providers.find((item) => item.id === 'p2');
  const options = provider && provider.modelOptions;
  return options ? options['gpt-image-2.5-flare'] : undefined;
}

/** 选传法：下拉的 onChange 就够，不用整张表单。 */
function pickAs(harness, value) {
  imageAsSelect(harness.renderRoot()).props.onChange({ target: { value: value } });
  return harness.renderRoot();
}

/** 填字段名（空串 = 清空）。 */
function typeFieldName(harness, value) {
  imageFieldInput(harness.renderRoot()).props.onChange({ target: { value: value } });
  return harness.renderRoot();
}

test('字段名为空时选传法立刻生效：值进了配置，但不造任何模板', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  let panel = openModelPanel(harness);
  assert.equal(imageFieldInput(panel).props.value, '', '一开始没有字段名');
  assert.equal(imageAsSelect(panel).props.value, '', '也就没有传法');

  panel = pickAs(harness, 'base64');
  assert.equal(imageAsSelect(panel).props.value, 'base64', '没有字段名也能选，选完就显示选中的值');

  const entry = await savedImageEntry(harness);
  assert.equal(entry.fieldsAs.image, 'base64', '选择真的进了配置');
  assert.equal(entry.fields, undefined, '没有字段名就不造模板：空 path 的模板会把请求写坏');
});

test('先选传法再填字段名：合成出来的模板带着 as，一次都不用回来重选', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  openModelPanel(harness);
  pickAs(harness, 'base64');
  const panel = typeFieldName(harness, 'image');
  assert.equal(imageAsSelect(panel).props.value, 'base64', '填完字段名，传法还在');

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { path: 'image', as: 'base64' });
  assert.equal(entry.fieldsAs, undefined, '传法已经并进模板，配置里不再留暂存');
  // 合成出来的模板是真能用的：field-templates 照着它把图写成 base64。
  const body = applyFields({}, entry.fields, { image: { buffer: Buffer.from('hi'), contentType: 'image/png' } });
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { image: 'aGk=' }, '选过的传法真的生效');
});

test('先填字段名再改传法也一样：只换 as，不动字段名', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  openModelPanel(harness);
  typeFieldName(harness, 'image_url');
  const panel = pickAs(harness, 'url');
  assert.equal(imageFieldInput(panel).props.value, 'image_url', '字段名没被传法改动');

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { path: 'image_url', as: 'url' });
});

test('清空字段名再填回来，传法不丢', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  openModelPanel(harness);
  typeFieldName(harness, 'image');
  pickAs(harness, 'base64');
  // 清空字段名 = 去掉这条覆盖，但传法留着（否则重填名字还得再选一次）。
  let panel = typeFieldName(harness, '');
  assert.equal(imageAsSelect(panel).props.value, 'base64', '清空字段名不会把传法一起清掉');
  panel = typeFieldName(harness, 'input_image');
  assert.equal(imageAsSelect(panel).props.value, 'base64');

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { path: 'input_image', as: 'base64' });
});

test('字段名为空时不会产出空 path 的模板：field-templates 编译不抛错', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  openModelPanel(harness);
  for (const value of ['dataUrl', 'base64', 'url']) pickAs(harness, value);

  const entry = await savedImageEntry(harness);
  assert.equal(entry.fieldsAs.image, 'url', '最后一次选择被记住');
  // 配置里只有「暂存的传法」，没有模板：三层合并之后是无字段可发。
  const fields = resolveFields({ override: entry.fields });
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), {}, '没有模板可选，也就不会有空 path');
  assert.doesNotThrow(() => applyFields({}, fields, {}), '编译不抛错');
  assert.doesNotThrow(() => promptParts(fields, { prompt: 'hi' }));
  assert.doesNotThrow(() => multipartFields(fields, {}));
  for (const spec of Object.values(entry.fields || {})) {
    if (spec && typeof spec === 'object' && 'path' in spec) {
      assert.ok(String(spec.path).trim().length > 0, '任何模板的 path 都必须非空');
    }
  }
});

test('fieldTemplateOf 在字段名为空时返回 null，不会造出 { path: "" }', () => {
  const { api } = createHarness({ config: CLOUD_CONFIG });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.equal(api.__test.fieldTemplateOf('path', '', 'base64'), null, '空字段名 → 没有模板');
  assert.equal(api.__test.fieldTemplateOf('path', '   ', 'base64'), null, '只有空白也算空');
  assert.deepEqual(plain(api.__test.fieldTemplateOf('path', 'image', 'base64')),
    { path: 'image', as: 'base64' });
  assert.deepEqual(plain(api.__test.fieldTemplateOf('path', 'image', '')), { path: 'image' });
  // multipart 的模板形状不认 as（field-templates 那里没有这个键），别硬塞。
  assert.deepEqual(plain(api.__test.fieldTemplateOf('multipart', 'image[]', 'base64')),
    { multipart: 'image[]' });
  assert.deepEqual(plain(api.__test.fieldTemplateOf('numbered', 'input_image', 'base64')),
    { numbered: 'input_image', as: 'base64' });
});

test('传法暂存只认三种编码，别的东西不会被记成模板的一部分', () => {
  const { api } = createHarness({ config: CLOUD_CONFIG });
  const pending = (value) => api.__test.pendingFieldAsOf({ fieldsAs: { image: value } }, 'image');
  for (const value of ['dataUrl', 'base64', 'url']) assert.equal(pending(value), value, value + ' 认得');
  assert.equal(pending('bogus'), '', '不认识的传法当作没选：别让它跟着字段名混进模板');
  assert.equal(api.__test.pendingFieldAsOf({}, 'image'), '', '没暂存就是空');
  assert.equal(api.__test.pendingFieldAsOf(null, 'image'), '');
});

/* ───────── 参考图方框：支持开关 + 多图策略（策略就是模板形状） ───────── */

/** 带字段模板覆盖的云端配置（p2 / gpt-image-2.5-flare）。 */
function imageConfig(fields) {
  const config = JSON.parse(JSON.stringify(CLOUD_CONFIG));
  if (fields) config.providers[0].modelOptions = { 'gpt-image-2.5-flare': { fields: fields } };
  return config;
}

/** 宿主声明的参考图模板：capabilities[].models[].image。 */
function imageCapability(template) {
  return [{ providerId: 'p2', models: [{ model: 'gpt-image-2.5-flare', image: template }] }];
}

/** 「支持参考图」勾选框（面板别处也有复选框，所以按方框限定）。 */
function imageCheckbox(tree) {
  const box = paramBox(tree, 'image');
  return box && findAll(box, (node) => node.type === 'input' && node.props.type === 'checkbox')[0] || null;
}

/** 多图策略下拉。 */
function imageModeSelect(tree) {
  const row = paramRow(tree, 'image:mode');
  return row ? row.children[1] : null;
}

/** 勾 / 取消勾「支持参考图」。 */
function toggleImage(harness, checked) {
  imageCheckbox(harness.renderRoot()).props.onChange({ target: { checked: checked } });
  return harness.renderRoot();
}

/** 选多图策略。 */
function pickMode(harness, value) {
  imageModeSelect(harness.renderRoot()).props.onChange({ target: { value: value } });
  return harness.renderRoot();
}

/** 两张参考图：小到可以直接比对 base64。 */
const REF_A = { buffer: Buffer.from('a'), contentType: 'image/png' };
const REF_B = { buffer: Buffer.from('b'), contentType: 'image/png' };
const dataUrlOf = (tag) => 'data:image/png;base64,' + Buffer.from(tag).toString('base64');

/** 模板 → 请求体（JSON 与 multipart 两个出口）。 */
function bodiesOf(fields, images) {
  const resolved = resolveFields({ override: fields });
  const json = JSON.parse(JSON.stringify(applyFields({}, resolved, { image: images })));
  const form = multipartFields(resolved, { image: images }, images).map((item) => item.name);
  return { json, form };
}

test('参考图方框的标题行下面多一个「支持参考图」：和质量的勾选框同一套', async () => {
  const { harness } = await openEditor(imageConfig({ image: { path: 'image', as: 'dataUrl' } }));
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'image');
  assert.ok(box, '参考图还是独立方框');
  assert.equal(textOf(box.children[0].children[0]).join(''), 'Reference image', '标题没变');
  const supported = paramRow(box, 'image:supported');
  assert.ok(supported, '勾选框自己占一行');
  assert.equal(textOf(supported.children[0]).join(''), 'Supports reference image');
  assert.equal(supported.children[1].type, 'input');
  assert.equal(supported.children[1].props.type, 'checkbox');
  assert.equal(supported.children[1].props['data-param-key'], 'image');
  assert.equal(imageCheckbox(opened).props.checked, true, '已经有模板就勾着');
});

test('取消勾选：框内其余行整块不渲染，字段模板写成显式不发，请求里没有参考图字段', async () => {
  const { harness } = await openEditor(imageConfig({ image: { path: 'image', as: 'dataUrl' } }));
  openModelPanel(harness);
  const panel = toggleImage(harness, false);
  assert.equal(imageCheckbox(panel).props.checked, false);
  assert.equal(paramRow(panel, 'image:field'), null, '不勾时没有字段名');
  assert.equal(paramRow(panel, 'image:as'), null, '不勾时没有传法');
  assert.equal(paramRow(panel, 'image:mode'), null, '不勾时没有多图策略');

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields, { image: null }, '显式不发就是 null，不是「没配」');
  const bodies = bodiesOf(entry.fields, REF_A);
  assert.deepEqual(bodies.json, {}, 'JSON body 里没有参考图');
  assert.deepEqual(bodies.form, [], 'multipart 表单里也没有参考图');
});

test('勾上时补默认模板：宿主什么都没声明就写 { path, as: dataUrl }', async () => {
  const { harness } = await openEditor(imageConfig(), { capabilities: [] });
  let panel = openModelPanel(harness);
  assert.equal(imageCheckbox(panel).props.checked, false, '宿主没声明就不勾');
  assert.equal(paramRow(panel, 'image:field'), null, '不勾时框里只有勾选框');

  panel = toggleImage(harness, true);
  assert.equal(imageCheckbox(panel).props.checked, true);
  assert.equal(imageFieldInput(panel).props.value, 'image', '默认模板的字段名');
  assert.equal(imageAsSelect(panel).props.value, 'dataUrl', '默认模板的传法');
  assert.equal(imageModeSelect(panel).props.value, 'single', '默认是单张');

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { path: 'image', as: 'dataUrl' });
  const bodies = bodiesOf(entry.fields, REF_A);
  assert.deepEqual(bodies.json, { image: dataUrlOf('a') }, '勾了就真的发得出去');
});

test('默认勾上来自宿主声明：有模板就勾着，且不写一条多余的覆盖', async () => {
  const { harness } = await openEditor(imageConfig(), {
    capabilities: imageCapability({ numbered: 'input_image', as: 'dataUrl' })
  });
  const panel = openModelPanel(harness);
  assert.equal(imageCheckbox(panel).props.checked, true, '预设/规则声明了 image 模板就默认勾上');
  assert.equal(imageFieldInput(panel).props.value, '', '继承时不写覆盖，字段名留空');
  assert.equal(imageModeSelect(panel).props.value, 'numbered', '策略照宿主声明的形状显示');

  const entry = await savedImageEntry(harness);
  assert.equal(entry && entry.fields, undefined, '什么都没动就不该多出一条覆盖');
});

test('取消勾选后再勾回来：回到继承宿主声明的状态，不再凭空造模板', async () => {
  const { harness } = await openEditor(imageConfig(), {
    capabilities: imageCapability({ multipart: 'image[]' })
  });
  openModelPanel(harness);
  toggleImage(harness, false);
  toggleImage(harness, true);
  const entry = await savedImageEntry(harness);
  assert.equal(entry, undefined, 'null 被删掉，链路回到「跟随预设/规则」，什么都不留');
});

test('多图策略 single：同一个字段，一张图就是标量', async () => {
  const { harness } = await openEditor(imageConfig(), {
    capabilities: imageCapability({ path: 'image', as: 'dataUrl' })
  });
  let panel = openModelPanel(harness);
  assert.equal(imageModeSelect(panel).props.value, 'single');
  panel = pickMode(harness, 'single');
  assert.deepEqual(
    findAll(imageModeSelect(panel), (node) => node.type === 'option').map((node) => String(node.props.value)),
    ['single', 'array', 'numbered'], '三个取值：单张 / 数组 / 按序号'
  );

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { path: 'image', as: 'dataUrl' });
  assert.deepEqual(bodiesOf(entry.fields, REF_A).json, { image: dataUrlOf('a') }, '一张就是标量');
});

test('多图策略 array：所有图塞进同一个字段的数组', async () => {
  const { harness } = await openEditor(imageConfig(), {
    capabilities: imageCapability({ path: 'image', as: 'dataUrl' })
  });
  openModelPanel(harness);
  pickMode(harness, 'array');
  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { path: 'image[]', as: 'dataUrl' });
  assert.deepEqual(bodiesOf(entry.fields, [REF_A, REF_B]).json,
    { image: [dataUrlOf('a'), dataUrlOf('b')] }, '两张都在同一个数组里');
  assert.deepEqual(bodiesOf(entry.fields, REF_A).json, { image: [dataUrlOf('a')] },
    '数组形态一张也还是数组');
});

test('多图策略 numbered：字段名当前缀，按序号展开', async () => {
  const { harness } = await openEditor(imageConfig({ image: { path: 'input_image', as: 'dataUrl' } }));
  openModelPanel(harness);
  pickMode(harness, 'numbered');
  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.fields.image, { numbered: 'input_image', as: 'dataUrl' });
  assert.deepEqual(bodiesOf(entry.fields, [REF_A, REF_B]).json,
    { input_image: dataUrlOf('a'), input_image_2: dataUrlOf('b') },
    '第一张不带序号，第二张开始 _2 / _3 …');
});

test('multipart 端点：策略只换字段名，形状仍是 multipart（换成 JSON 路径会丢图）', async () => {
  const cases = [
    ['array', { multipart: 'image[]' }, ['image[]', 'image[]']],
    ['single', { multipart: 'image' }, ['image', 'image']]
  ];
  for (const [mode, template, names] of cases) {
    const { harness } = await openEditor(imageConfig(), {
      capabilities: imageCapability({ multipart: 'image[]' })
    });
    const panel = openModelPanel(harness);
    assert.equal(imageModeSelect(panel).props.value, 'array', 'image[] 读回来就是数组策略');

    pickMode(harness, mode);
    const entry = await savedImageEntry(harness);
    assert.deepEqual(entry.fields.image, template, mode + ' 的形状');
    const bodies = bodiesOf(entry.fields, [REF_A, REF_B]);
    assert.deepEqual(bodies.form, names, mode + ' 的表单字段名');
    assert.deepEqual(bodiesOf(entry.fields, REF_A).json, {}, 'multipart 模板不往 JSON body 里写东西');
  }
});

test('切策略时字段名与传法不丢', async () => {
  const start = { path: 'image_url', as: 'url' };
  const cases = [
    ['array', { path: 'image_url[]', as: 'url' }],
    ['numbered', { numbered: 'image_url', as: 'url' }],
    ['single', { path: 'image_url', as: 'url' }]
  ];
  for (const [mode, template] of cases) {
    const { harness } = await openEditor(imageConfig({ image: start }));
    const before = openModelPanel(harness);
    assert.equal(imageFieldInput(before).props.value, 'image_url');
    assert.equal(imageAsSelect(before).props.value, 'url');

    const panel = pickMode(harness, mode);
    assert.equal(imageFieldInput(panel).props.value, 'image_url', mode + '：字段名没丢（[] 归策略管）');
    assert.equal(imageAsSelect(panel).props.value, 'url', mode + '：传法没丢');
    assert.deepEqual((await savedImageEntry(harness)).fields.image, template, mode + ' 的形状');
  }

  // 切完策略再改传法：形状与字段名都还在。
  for (const [mode, template] of [
    ['array', { path: 'image_url[]', as: 'base64' }],
    ['numbered', { numbered: 'image_url', as: 'base64' }]
  ]) {
    const { harness } = await openEditor(imageConfig({ image: start }));
    openModelPanel(harness);
    pickMode(harness, mode);
    pickAs(harness, 'base64');
    assert.deepEqual((await savedImageEntry(harness)).fields.image, template, mode + ' 之后改传法');
  }
});

test('multipart 端点不提供「按序号」：那个形状写不进表单，选了会静默丢图', async () => {
  const optionsOf = (tree) => findAll(imageModeSelect(tree), (node) => node.type === 'option')
    .map((node) => ({ value: String(node.props.value), disabled: node.props.disabled === true }));

  const multipart = await openEditor(imageConfig(), { capabilities: imageCapability({ multipart: 'image[]' }) });
  assert.deepEqual(optionsOf(openModelPanel(multipart.harness)), [
    { value: 'single', disabled: false },
    { value: 'array', disabled: false },
    { value: 'numbered', disabled: true }
  ], '表单端点只有单张 / 数组两种形状');

  // JSON 端点三种都能选；老配置里已经存成 numbered 的，就算宿主声明是表单也照样显示。
  const json = await openEditor(imageConfig({ image: { numbered: 'input_image', as: 'dataUrl' } }));
  assert.deepEqual(optionsOf(openModelPanel(json.harness)).map((item) => item.disabled), [false, false, false]);
});

test('老配置读回来能显示成对应策略（只有 path / 只有 multipart 都认）', async () => {
  const cases = [
    [{ path: 'image' }, 'single', 'image'],
    [{ path: 'images[]', as: 'dataUrl' }, 'array', 'images'],
    [{ multipart: 'image[]' }, 'array', 'image'],
    [{ multipart: 'image' }, 'single', 'image'],
    [{ numbered: 'input_image', as: 'dataUrl' }, 'numbered', 'input_image'],
    [{ path: 'input.messages[0].content[]', wrap: 'image', as: 'dataUrl' }, 'array', 'input.messages[0].content']
  ];
  for (const [template, mode, name] of cases) {
    const { harness } = await openEditor(imageConfig({ image: template }));
    const panel = openModelPanel(harness);
    assert.equal(imageCheckbox(panel).props.checked, true, JSON.stringify(template) + ' 有模板，勾着');
    assert.equal(imageModeSelect(panel).props.value, mode, JSON.stringify(template) + ' 的策略');
    assert.equal(imageFieldInput(panel).props.value, name, JSON.stringify(template) + ' 的字段名');
  }
});

test('上锁时参考图方框里的控件全部禁用', async () => {
  const config = imageConfig({ image: { path: 'image', as: 'dataUrl' } });
  config.providers[0].presetId = 'openai'; // 预设来源的提供商默认全锁
  const { harness } = await openEditor(config);
  const opened = openModelPanel(harness);
  assert.equal(paramLock(opened, 'image').props['aria-pressed'], 'true', '这个键是上锁的');
  for (const control of [imageCheckbox(opened), imageFieldInput(opened), imageAsSelect(opened), imageModeSelect(opened)]) {
    assert.ok(control, '控件在');
    assert.equal(control.props.disabled, true, '上锁后每个控件都该禁用');
  }
});

test('imageStrategyOf / imageNameOf / imageTemplateOf：策略就是模板形状', () => {
  const { api } = createHarness({ config: CLOUD_CONFIG });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.equal(api.__test.imageStrategyOf({ path: 'image' }), 'single');
  assert.equal(api.__test.imageStrategyOf({ path: 'images[]' }), 'array');
  assert.equal(api.__test.imageStrategyOf({ multipart: 'image[]' }), 'array');
  assert.equal(api.__test.imageStrategyOf({ multipart: 'image' }), 'single');
  assert.equal(api.__test.imageStrategyOf({ numbered: 'input_image' }), 'numbered');
  assert.equal(api.__test.imageStrategyOf(null), 'single', '没模板时按单张摆');

  assert.equal(api.__test.imageNameOf({ path: 'image[]' }), 'image', '[] 归策略管');
  assert.equal(api.__test.imageNameOf({ numbered: 'input_image' }), 'input_image');
  assert.equal(api.__test.imageNameOf(undefined), '');

  assert.deepEqual(plain(api.__test.imageTemplateOf('path', 'single', 'image', 'url')), { path: 'image', as: 'url' });
  assert.deepEqual(plain(api.__test.imageTemplateOf('path', 'array', 'image', 'url')), { path: 'image[]', as: 'url' });
  assert.deepEqual(plain(api.__test.imageTemplateOf('path', 'array', 'image[]', 'url')), { path: 'image[]', as: 'url' },
    '字段名自己带 [] 也不会叠成 [][]');
  assert.deepEqual(plain(api.__test.imageTemplateOf('numbered', 'single', 'input_image', 'dataUrl')),
    { path: 'input_image', as: 'dataUrl' });
  assert.deepEqual(plain(api.__test.imageTemplateOf('path', 'numbered', 'input_image', 'dataUrl')),
    { numbered: 'input_image', as: 'dataUrl' });
  assert.deepEqual(plain(api.__test.imageTemplateOf('multipart', 'array', 'image', 'url')),
    { multipart: 'image[]' }, 'multipart 的模板不认 as，别硬塞');
  assert.equal(api.__test.imageTemplateOf('path', 'single', '  ', 'url'), null, '空字段名不造模板');
});

test('一键配置不会撤销「这个模型不发参考图」：用户关掉过的保持关掉', async () => {
  // 中转站没有 presetId（锁默认全开），所以「上锁即保护」在这里不成立：
  // 用户明确取消勾选过的参考图要像上锁一样挡住规则写入。
  const declined = {
    providers: [{
      id: 'p9', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
      key: '', hasKey: true, adapter: 'custom', protocol: 'openai-images', optionalKey: false,
      customEndpoints: {
        generate: 'https://api.siliconflow.cn/v1/images/generations',
        edit: '',
        models: 'https://api.siliconflow.cn/v1/models'
      },
      models: ['Qwen/Qwen-Image'], names: {},
      modelOptions: { 'Qwen/Qwen-Image': { fields: { image: null } } }
    }],
    active: { providerId: 'p9', model: 'Qwen/Qwen-Image' },
    defaults: {}
  };
  const detect = {
    ok: true,
    models: ['Qwen/Qwen-Image'],
    rules: {
      'Qwen/Qwen-Image': {
        size: { mode: 'wh-string', field: 'image_size', separator: 'x', second: null, domain: {} },
        quality: null
      }
    },
    fields: {
      'Qwen/Qwen-Image': { prompt: { path: 'prompt' }, image: { path: 'images[]', as: 'dataUrl' } }
    },
    matched: { 'Qwen/Qwen-Image': true }
  };
  const { harness } = await openEditor(declined, { detect: detect });
  await configureAll(harness);
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.equal(entry.fields.image, null, '规则说收也不算：用户关掉过');
  assert.deepEqual(entry.fields.prompt, { path: 'prompt' }, '别的字段照旧抄');
});

/* ───────── 「一键配置」只给规则表能管的协议 ───────── */

/** 只换 adapter 的本地提供商：一键配置该不该出现就看它。 */
function adapterOnlyConfig(adapter) {
  return {
    providers: [{
      id: 'pz', name: 'Local ' + (adapter || 'auto'), baseUrl: 'http://127.0.0.1:9999',
      key: '', hasKey: false, adapter: adapter, protocol: 'openai-images', optionalKey: true,
      models: ['m1'], names: {}
    }],
    active: { providerId: 'pz', model: 'm1' },
    defaults: {}
  };
}

test('「一键配置」不出现在只认工作流参数的协议上，OpenAI 兼容的本地协议照样有', async () => {
  const hasBulk = (tree) => Boolean(findButton(tree, (node) => /Configure all/i.test(textOf(node).join(''))));
  // 这三种的尺寸与质量走工作流参数，规则表里根本没有它们：按钮只会写噪音。
  for (const adapter of ['a1111', 'comfyui', 'swarmui']) {
    const { tree } = await openEditor(adapterOnlyConfig(adapter));
    assert.ok(!hasBulk(tree), adapter + ' 不该出现一键配置');
  }
  // localai 与 sd-server 走 OpenAI 兼容参数，规则照样管用；adapter 为空的中转站同理。
  for (const adapter of ['localai', 'openai-images', '']) {
    const { tree } = await openEditor(adapterOnlyConfig(adapter));
    assert.ok(hasBulk(tree), (adapter || '(空 adapter)') + ' 必须保留一键配置');
  }
});

/* ───────────────────── 「质量」方框：勾选 + 参数名 + 挡位表 ───────────────────── */

/** 带质量覆盖的云端配置（p2 / gpt-image-2.5-flare）。 */
function qualityConfig(quality, extra = {}) {
  return {
    providers: [{
      id: 'p2', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
      key: '', hasKey: true, adapter: 'openai-images', protocol: 'openai-images', optionalKey: false,
      models: ['gpt-image-2.5-flare'], names: {},
      modelOptions: { 'gpt-image-2.5-flare': Object.assign({ quality: quality }, extra) }
    }],
    active: { providerId: 'p2', model: 'gpt-image-2.5-flare' },
    defaults: {}
  };
}

/** 质量方框里的一行参数（勾选框 / 参数名）。 */
const qualityRow = (tree, key) => paramRow(tree, 'quality:' + key);
/** 挡位表的表头行。 */
const qualityHead = (tree) => findAll(tree, (node) => node.props && node.props['data-param-grid'] === 'quality:head')[0] || null;
/** 挡位表的表体行，按显示顺序。 */
const qualityOptions = (tree) => findAll(tree, (node) => node.props && node.props['data-param-grid'] === 'quality:option');
/** 质量方框里的勾选框（面板别处可能还有复选框，所以按方框限定）。 */
function qualityCheckbox(tree) {
  const box = paramBox(tree, 'quality');
  return box && findAll(box, (node) => node.type === 'input' && node.props.type === 'checkbox')[0] || null;
}
/** 质量方框里的某个控件：key 是 data-param-key，index 是挡位行号（不传 = 不限行）。 */
function qualityControl(tree, key, index) {
  const scope = index === undefined ? paramBox(tree, 'quality') : qualityOptions(tree)[index];
  if (!scope) return null;
  return findAll(scope, (node) => node.props && node.props['data-param-key'] === key)[0] || null;
}
/** 「+ 添加挡位」。 */
const qualityAddButton = (tree) => findButton(paramBox(tree, 'quality'), (node) => /Add level/i.test(textOf(node).join('')));
/** 每个挡位行上的三个控件按列取值，方便整表比对。 */
const qualityTable = (tree) => qualityOptions(tree).map((_row, index) => ({
  label: qualityControl(tree, 'quality.option.label', index).props.value,
  value: qualityControl(tree, 'quality.option.value', index).props.value,
  default: qualityControl(tree, 'quality.option.default', index).props.checked
}));

test('质量是一个独立方框：和尺寸同级、标题行带锁、占满面板宽度', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'quality');
  assert.ok(box, '质量方框存在');
  assert.equal(textOf(box.children[0].children[0]).join(''), 'Quality', '标题是「质量」');
  assert.equal(box.props.style.width, '100%');
  assert.equal(box.props.style.boxSizing, 'border-box');
  assert.equal(box.props.style.gridColumn, '1 / -1');
  // 锁复用现有的锁图标与 data-lock-key 语义，位置在标题行。
  const head = box.children[0];
  const last = head.children[head.children.length - 1];
  assert.equal(last.type, 'button');
  assert.equal(last.props['data-lock-key'], 'quality');
  assert.equal(last.props['aria-pressed'], 'false', '自配的网关默认不上锁');

  // 方框顺序：常规 → 尺寸 → 质量 → 参考图（尺寸和质量挨着，都是「参数形状」这一类）。
  const body = findAll(opened, (node) => hasClass(node, 'customizedBody'))[0];
  const order = findAll(body, (node) => node.props && node.props['data-param-box']).map((node) => node.props['data-param-box']);
  assert.deepEqual(order, ['common', 'size', 'quality', 'image']);
});

test('没配过质量的模型：复选框不勾，参数名与挡位表整块不渲染', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  // 宿主下发的能力里没有质量（这个模型的规则/预设都不收），所以默认不勾。
  assert.equal(qualityCheckbox(opened).props.checked, false);
  assert.equal(qualityRow(opened, 'field'), null, '不勾时没有参数名');
  assert.equal(qualityHead(opened), null, '不勾时没有表头');
  assert.equal(qualityOptions(opened).length, 0, '不勾时没有挡位行');
  assert.equal(qualityAddButton(opened), null, '不勾时连「添加挡位」也不摆');
});

test('勾选后出现参数名与挡位表，并把字段模板这条闸门补上', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  let panel = openModelPanel(harness);
  qualityCheckbox(panel).props.onChange({ target: { checked: true } });
  panel = harness.renderRoot();
  assert.equal(qualityCheckbox(panel).props.checked, true);
  assert.ok(qualityRow(panel, 'field'), '勾上以后有参数名');
  assert.ok(qualityHead(panel), '勾上以后有表头');
  assert.equal(textOf(qualityHead(panel)).join(''), 'Level nameValueDefault', '三列表头：挡位名 / 值 / 是否默认');
  assert.ok(qualityAddButton(panel), '勾上以后有「添加挡位」');

  const entry = await savedImageEntry(harness);
  assert.equal(entry.quality.supported, true);
  assert.deepEqual(entry.fields.quality, { path: 'quality' },
    '勾选时顺手补模板：没有它的话质量参数照样发不出去');
});

test('取消勾选后参数名与挡位表消失，配置里留下 supported:false 而档位表不丢', async () => {
  const { harness } = await openEditor(qualityConfig({
    supported: true,
    field: 'quality',
    options: [
      { label: 'Low', value: 'low', default: false },
      { label: 'High', value: 'high', default: true }
    ]
  }));
  let panel = openModelPanel(harness);
  assert.equal(qualityOptions(panel).length, 2, '一开始是勾着的，档位表在');
  qualityCheckbox(panel).props.onChange({ target: { checked: false } });
  panel = harness.renderRoot();
  assert.equal(qualityRow(panel, 'field'), null, '取消勾选后参数名不渲染');
  assert.equal(qualityOptions(panel).length, 0, '取消勾选后挡位表不渲染');

  const entry = await savedImageEntry(harness);
  assert.equal(entry.quality.supported, false, '取消勾选要落盘成 supported:false');
  assert.deepEqual(entry.quality.options.map((item) => item.value), ['low', 'high'],
    '取消勾选只关掉「收不收」，别把用户填好的档位表删了');
});

test('参数名改了以后 quality.field 与字段模板一起写：质量发到新字段', async () => {
  const { harness } = await openEditor(qualityConfig({
    supported: true,
    field: 'quality',
    options: [{ label: 'High', value: 'high', default: true }]
  }));
  const panel = openModelPanel(harness);
  const input = qualityRow(panel, 'field').children[1];
  assert.equal(input.props.value, 'quality');
  input.props.onChange({ target: { value: 'parameters.quality' } });

  const entry = await savedImageEntry(harness);
  assert.equal(entry.quality.field, 'parameters.quality', '覆盖层记下参数名');
  assert.deepEqual(entry.fields.quality, { path: 'parameters.quality' }, '字段模板才是真正决定落点的那一处');
});

test('参数名清空 = 删掉模板覆盖，回落到规则/预设', async () => {
  const { harness } = await openEditor(qualityConfig({
    supported: true,
    field: 'quality',
    options: [{ label: 'High', value: 'high', default: true }]
  }, { fields: { quality: { path: 'quality' } } }));
  const panel = openModelPanel(harness);
  qualityRow(panel, 'field').children[1].props.onChange({ target: { value: '' } });

  const entry = await savedImageEntry(harness);
  assert.equal(entry.quality.field, undefined);
  assert.equal(entry.fields, undefined, '清空后不该留下一条空模板');
});

test('挡位表：加行 / 改挡位名与值 / 单选默认', async () => {
  const { harness } = await openEditor(qualityConfig({
    supported: true,
    field: 'quality',
    options: [
      { label: 'Low', value: 'low', default: false },
      { label: 'High', value: 'high', default: true }
    ]
  }));
  let panel = openModelPanel(harness);
  assert.deepEqual(qualityTable(panel), [
    { label: 'Low', value: 'low', default: false },
    { label: 'High', value: 'high', default: true }
  ], '行序就是配置里的顺序，单选只有一条');

  // 改挡位名与值（值才是发出去的那个）。
  qualityControl(panel, 'quality.option.label', 0).props.onChange({ target: { value: '好省' } });
  panel = harness.renderRoot();
  qualityControl(panel, 'quality.option.value', 0).props.onChange({ target: { value: 'cheap' } });
  panel = harness.renderRoot();

  // 加一条新挡位，填好并设为默认。
  qualityAddButton(panel).props.onClick();
  panel = harness.renderRoot();
  assert.equal(qualityOptions(panel).length, 3, '新增一行空白挡位');
  qualityControl(panel, 'quality.option.label', 2).props.onChange({ target: { value: 'Ultra' } });
  panel = harness.renderRoot();
  qualityControl(panel, 'quality.option.value', 2).props.onChange({ target: { value: 'ultra' } });
  panel = harness.renderRoot();
  qualityControl(panel, 'quality.option.default', 2).props.onChange();
  panel = harness.renderRoot();
  assert.deepEqual(qualityTable(panel), [
    { label: '好省', value: 'cheap', default: false },
    { label: 'High', value: 'high', default: false },
    { label: 'Ultra', value: 'ultra', default: true }
  ], '单选是唯一的表达：选了新的，旧的自动让位');

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.quality.options, [
    { label: '好省', value: 'cheap', default: false },
    { label: 'High', value: 'high', default: false },
    { label: 'Ultra', value: 'ultra', default: true }
  ], '显示名 / 值 / 默认标记都按编辑结果落盘');
  assert.equal(entry.quality.default, 'ultra', '默认档跟着单选走');
});

test('挡位表：删除一行', async () => {
  const { harness } = await openEditor(qualityConfig({
    supported: true,
    field: 'quality',
    options: [
      { label: 'Low', value: 'low', default: false },
      { label: 'High', value: 'high', default: true },
      { label: 'Ultra', value: 'ultra', default: false }
    ]
  }));
  const panel = openModelPanel(harness);
  assert.equal(qualityControl(panel, 'quality.option.remove', 1).props['aria-label'], 'Remove level 2');
  qualityControl(panel, 'quality.option.remove', 1).props.onClick();

  const entry = await savedImageEntry(harness);
  assert.deepEqual(entry.quality.options.map((item) => item.value), ['low', 'ultra']);
  assert.equal(entry.quality.default, undefined, '删掉的正好是默认档：默认随之清空，退回规则');
});

test('上锁时质量方框里的控件全部禁用', async () => {
  const config = qualityConfig({
    supported: true,
    field: 'quality',
    options: [{ label: 'High', value: 'high', default: true }]
  });
  config.providers[0].presetId = 'openai'; // 预设来源的提供商默认全锁
  const { harness } = await openEditor(config);
  const opened = openModelPanel(harness);
  const box = paramBox(opened, 'quality');
  assert.equal(paramLock(opened, 'quality').props['aria-pressed'], 'true', '这个键是上锁的');
  const controls = findAll(box, (node) => node.type === 'input' || node.type === 'button');
  assert.ok(controls.length >= 5, '勾选框 + 参数名 + 每行三个控件 + 添加');
  for (const control of controls) {
    // 标题行上的锁自己永远可点，它不是「框内的输入」。
    if (control.props['data-lock-key'] === 'quality') continue;
    assert.equal(control.props.disabled, true, '上锁后框里每个控件都该禁用');
  }
});

test('老形状的质量覆盖（字符串挡位 + 顶层 default）在面板里读得动', async () => {
  const { harness } = await openEditor(qualityConfig({
    field: 'rendering_speed', options: ['turbo', 'quality'], default: 'quality'
  }));
  const panel = openModelPanel(harness);
  assert.equal(qualityCheckbox(panel).props.checked, true, '老配置按「收质量」处理');
  assert.equal(qualityRow(panel, 'field').children[1].props.value, 'rendering_speed');
  assert.deepEqual(qualityTable(panel), [
    { label: '', value: 'turbo', default: false },
    { label: '', value: 'quality', default: true }
  ], '顶层 default 折成那一条上的单选');
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Stateful React stand-in, so clicking the chevron re-renders the settings section. */
function createHarness({ config, primitives = null, analyze = null } = {}) {
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

  return { fetchCalls, renderRoot };
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

test('the model options toggle is disabled for a cloud provider', async () => {
  const { tree } = await openEditor(CLOUD_CONFIG);
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'chevron stays rendered so the row layout is stable');
  assert.equal(toggle.props.disabled, true, 'cloud providers must not open model options');
  assert.match(String(toggle.props.title), /ComfyUI/i, 'the tooltip should explain why it is disabled');
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

test('the model options toggle is disabled for a local provider that does not use ComfyUI workflows', async () => {
  const { tree } = await openEditor(A1111_CONFIG);
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'chevron stays rendered so the row layout is stable');
  assert.equal(toggle.props.disabled, true, 'A1111 has its own parameter model, no custom workflow');
});

test('a disabled toggle never expands the workflow panel', async () => {
  const { harness, tree } = await openEditor(CLOUD_CONFIG);
  const toggle = optionsToggle(tree);
  if (typeof toggle.props.onClick === 'function') toggle.props.onClick(fakeEvent());
  const after = harness.renderRoot();
  assert.equal(findAll(after, (node) => hasClass(node, 'modelAdvanced')).length, 0,
    'disabled control must not open the panel');
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

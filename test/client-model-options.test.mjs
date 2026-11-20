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
function createHarness({ config, primitives = null, analyze = null, params = null, detect = null, models = null, capabilities = null, paramDefaults = null } = {}) {
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
        providerPresets: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images', models: [] }],
        localPresets: [],
        // 返回格式预设：宿主每次都会下发，模型选项里的「输出设置」靠它渲染两个下拉。
        outputPresets: ['auto', 'openai', 'binary', 'image-url', 'image-base64', 'task-location', 'task-json'],
        paramDefaults: paramDefaults === null ? PARAM_DEFAULTS : paramDefaults,
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

/**
 * 跨 vm 边界的对象先过一趟 JSON：deepEqual 也比原型，vm 里的 Object 与本进程不是同一个。
 * 样式对象是 client.js 在 vm 里现造的，所以比对它们之前一律走这里。
 */
const plainValue = (value) => JSON.parse(JSON.stringify(value));

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

/**
 * 带 enum 参数的云端配置（p2 / gpt-image-2.5-flare）：
 * 行序是提示词 → 负面词（enum）→ 模型 → 张数 → 采样器（enum），两个 enum 行前后分开摆，
 * 用来锁「每个 enum 一个方框、顺序按表里」和「常规表只留 text / number / boolean」。
 * 质量也开着，好把挡位表和选项表放在同一棵树里比 grid。
 */
const ENUM_CONFIG = {
  providers: [{
    ...CLOUD_CONFIG.providers[0],
    modelOptions: {
      'gpt-image-2.5-flare': {
        quality: {
          supported: true, field: 'quality',
          options: [{ label: 'Low', value: 'low', default: true }]
        },
        params: [
          { role: 'prompt', name: 'prompt', type: 'text', default: '', description: 'Image prompt', expose: true },
          {
            role: 'negative', name: 'negative_prompt', type: 'enum', default: 'blurry',
            description: 'What to avoid', expose: false, options: ['blurry', 'low quality']
          },
          { role: 'model', name: 'model', type: 'text', default: '', description: 'Model name', expose: false },
          { role: 'n', name: 'n', type: 'number', default: '1', description: 'Images per request', expose: false },
          {
            name: 'sampler', type: 'enum', default: 'euler', description: 'Sampler',
            expose: true, options: ['euler', 'ddim']
          }
        ]
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

/**
 * 模型选项展开后的面板：「输入设置」那个 details 本体。
 *
 * 以前它外面还套着一层 div.modelAdvanced（带内边距），比「输出设置」宽出去一截、右端差 4px；
 * 现在两块都是 .modelRow 的直接子项，所以面板就是 details 本身。
 */
const modelSections = (tree) => findAll(tree, (node) => node.type === 'details'
  && node.props && node.props['data-mo-image-input-settings'] !== undefined);
const openModelSection = (tree) => modelSections(tree)[0] || null;

test('the model options toggle opens the size panel for a cloud provider', async () => {
  const { harness, tree } = await openEditor(CLOUD_CONFIG);
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'chevron stays rendered for every model');
  assert.notEqual(toggle.props.disabled, true, 'cloud providers can override how the size is sent');
  toggle.props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = openModelSection(opened);
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

test('the workflow textarea is about half the old height', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = openModelSection(opened);
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  assert.equal(Number(textarea.props.rows), 4, '8 行 → 4 行');
  assert.equal(Number(textarea.props.style.minHeight), 80, '160px → 80px');
});

/** 「常规」方框里工作流那一行（label + 示例按钮）。 */
const workflowLabelRow = (tree) => findAll(commonBox(tree), (node) => node.props
  && node.props['data-param-workflow'] === 'label')[0] || null;
/** 「常规」方框里工作流的 textarea。 */
const workflowTextarea = (tree) => findAll(commonBox(tree), (node) => node.props
  && node.props['data-param-workflow'] === 'input')[0] || null;

test('自定义工作流搬进「常规」方框，且排在参数表前面', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const box = commonBox(opened);
  assert.ok(box, 'ComfyUI 的「常规」方框在');
  const labelRow = workflowLabelRow(opened);
  const textarea = workflowTextarea(opened);
  assert.ok(labelRow, '工作流 label 行在「常规」方框里');
  assert.ok(textarea, '工作流 textarea 在「常规」方框里');
  // 方框第一个孩子是标题行；工作流 label 紧跟标题，是参数表前的第一行。
  assert.equal(box.children[1], labelRow, '工作流 label 是标题后的第一行');
  assert.equal(box.children[2], textarea, 'textarea 紧跟 label 行');
  const table = findAll(box, (node) => node.props && node.props['data-param-table'] === 'common')[0];
  assert.ok(table, '参数表还在');
  assert.ok(box.children.indexOf(table) > box.children.indexOf(textarea), '参数表排在工作流后面');
});

test('「插入示例模板」在 label 行右侧，靠右对齐', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const labelRow = workflowLabelRow(opened);
  assert.ok(labelRow, '工作流 label 行在');
  assert.equal(labelRow.props.style.display, 'flex', 'label 与按钮同一行');
  const sample = findAll(labelRow, (node) => node.type === 'button'
    && node.props['data-param-workflow-action'] === 'sample')[0];
  assert.ok(sample, '示例模板按钮在 label 行');
  assert.equal(textOf(sample).join(''), 'Insert sample template');
  assert.equal(sample.props.style.marginLeft, 'auto', '靠右对齐');
  // 无边框小字按钮：它只是「给一份能跑的样例」，不是这里的主操作。
  assert.ok(hasClass(sample, 'linkButton'), '插入示例模板用无边框按钮');
  const labelText = findAll(labelRow, (node) => node.type === 'span'
    && hasClass(node, 'modelFieldLabel'))[0];
  assert.ok(labelText, 'label 文本在');
  assert.equal(textOf(labelText).join(''), 'Custom workflow (ComfyUI API format)');
});

test('两段旧提示（整行说明 / 占位符清单）不再渲染', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const body = textOf(opened).join(' ');
  assert.doesNotMatch(body, /Override the ComfyUI workflow for this model/, '整行说明已删');
  assert.doesNotMatch(body, /Placeholders:/, '占位符清单已删');
  assert.doesNotMatch(body, /\{\{prompt\}\}/, '占位符本身也不再出现');
  // 自动选择那句并进了 placeholder，不再单独占一行。
  assert.match(workflowTextarea(opened).props.placeholder, /Leave blank to use the builtin workflow/);
});

test('参数表为空时给一行空状态提示，有行就消失（不占表格行）', async () => {
  // 「解析工作流」的响应里可以带可挂参数的行；这里用它把空表填上。
  const analysis = {
    ok: true,
    format: 'api',
    mapping: { prompt: { node: '18:17', input: 'value' } },
    candidates: { prompt: [{ node: '18:17', input: 'value', classType: 'PrimitiveStringMultiline' }] },
    params: [{ name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25 }],
    warnings: []
  };
  const { harness, tree } = await openEditor(CONFIG, { analyze: analysis });
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  let box = commonBox(opened);
  const empty = findAll(box, (node) => node.props && node.props['data-param-empty'])[0];
  assert.ok(empty, '空表的提示在');
  assert.equal(empty.props['data-param-empty'], 'workflow', 'ComfyUI 用解析相关的文案');
  assert.equal(empty.props['data-param-grid'], undefined, '不是表格行');
  assert.equal(empty.props['data-param-table'], undefined, '也不另起一张表');
  assert.match(textOf(empty).join(''), /No parameters parsed yet/);
  assert.match(textOf(empty).join(''), /Parse workflow/, '引导点「解析工作流」');
  assert.equal(commonRows(opened).length, 0, '确实还没有参数行');

  // 粘贴工作流并解析后，空状态消失。
  workflowTextarea(opened).props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  await findButton(opened, (node) => /Parse workflow/i.test(textOf(node).join(''))).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  opened = harness.renderRoot();
  box = commonBox(opened);
  assert.equal(findAll(box, (node) => node.props && node.props['data-param-empty']).length, 0,
    '有参数行就不再显示空状态');
  assert.equal(commonRows(opened).length, 1);
  assert.equal(paramCell(commonRows(opened)[0], 'name').props.value, 'steps');
});

test('不靠解析的协议空表用通用文案（点「添加参数」自己加）', async () => {
  const { harness, tree } = await openEditor(A1111_CONFIG, { paramDefaults: { a1111: [] } });
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const empty = findAll(commonBox(opened), (node) => node.props && node.props['data-param-empty'])[0];
  assert.ok(empty, 'A1111 空表也有提示');
  assert.equal(empty.props['data-param-empty'], 'generic');
  assert.match(textOf(empty).join(''), /Add parameter/);
  assert.equal(findAll(empty, (node) => node.props['data-param-grid']).length, 0);
  assert.ok(findAll(commonBox(opened), (node) => node.props['data-param-key'] === 'params:add').length,
    '「添加参数」还在');
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
  const panel = openModelSection(opened);
  assert.ok(panel, 'the size panel opens');
  assert.ok(findAll(panel, (node) => node.type === 'select').length >= 1);
});

test('clicking the toggle again closes the panel', async () => {
  const { harness, tree } = await openEditor(CLOUD_CONFIG);
  const toggle = optionsToggle(tree);
  toggle.props.onClick(fakeEvent());
  assert.equal(modelSections(harness.renderRoot()).length, 1);
  optionsToggle(harness.renderRoot()).props.onClick(fakeEvent());
  assert.equal(modelSections(harness.renderRoot()).length, 0);
});

test('the model row exposes model options as a chevron icon button, not a text button', async () => {
  const { tree } = await openEditor();
  const toggle = optionsToggle(tree);
  assert.ok(toggle, 'expected an aria-expanded icon button on the model row');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.match(String(toggle.props['aria-label']), /Model options/);
  // 原生 title 有延迟：模型选项按钮也走即时气泡。
  assert.equal(toggle.props.title, undefined, '不再用有延迟的原生 title');
  assert.equal(typeof toggle.props.onPointerEnter, 'function', '悬停立刻展开说明');
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
  assert.equal(modelSections(tree).length, 0,
    'panel stays collapsed until toggled');
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  const panel = openModelSection(opened);
  assert.ok(panel, 'expected the expanded input-settings panel');
  const textarea = findAll(panel, (node) => node.type === 'textarea')[0];
  assert.ok(textarea, 'expected a workflow textarea');
});

test('editing the workflow and saving sends modelOptions for that model', async () => {
  const { harness, tree } = await openEditor();
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = openModelSection(opened);
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
  const panel = openModelSection(opened);
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

/* ───────────── ComfyUI 折叠区只保留「解析工作流」 ───────────── */

test('解析参数入口、loading 与候选清单已移除，只留「解析工作流」', async () => {
  const { harness, tree } = await openEditor(CONFIG);
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const workflowPanel = openModelSection(opened);
  findAll(workflowPanel, (node) => node.type === 'textarea')[0]
    .props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  const labels = findAll(opened, (node) => node.type === 'button').map((node) => textOf(node).join(''));
  assert.ok(labels.includes('Parse workflow'), '解析工作流还在');
  // 有边框按钮（与「添加模型」同一套）：它是工作流那边的主操作。
  assert.ok(hasClass(findAll(opened, (node) => node.type === 'button'
    && /Parse workflow/i.test(textOf(node).join('')))[0], 'addModelButton'), '解析工作流用有边框按钮');
  assert.equal(labels.filter((label) => /Parse parameters/i.test(label)).length, 0, '解析参数按钮没了');
  assert.equal(findAll(opened, (node) => node.props['data-param-key'] === 'params:parse').length, 0,
    '入口的定位属性也不在了');
  assert.equal(findAll(opened, (node) => node.props['data-param-candidate']).length, 0,
    '候选清单整段不渲染');
  assert.doesNotMatch(textOf(opened).join(' '), /Checked inputs become parameter rows/i,
    '候选清单的说明文案也不再出现');
});

/** ComfyUI 工作流行里已经存下来的 enum 行：走的是和其他协议同一套 enum 方框。 */
const COMFY_ENUM_CONFIG = {
  providers: [{
    ...CONFIG.providers[0],
    modelOptions: {
      'flux.safetensors': {
        workflow: '{"1":{"class_type":"KSampler"}}',
        params: [{
          name: 'sampler_name', node: '18:7', input: 'sampler_name',
          type: 'enum', options: ['euler', 'ddim'], expose: false
        }]
      }
    }
  }],
  active: CONFIG.active,
  defaults: {}
};

test('工作流的 enum 参数也单独成框：ComfyUI 折叠区走的是同一套渲染', async () => {
  const { harness, tree } = await openEditor(COMFY_ENUM_CONFIG);
  optionsToggle(tree).props.onClick(fakeEvent());
  const opened = harness.renderRoot();
  assert.equal(commonRows(opened).length, 0, 'enum 行不进「常规」表');
  const box = enumBoxNamed(opened, 'sampler_name');
  assert.ok(box, 'enum 行在自己的方框里');
  assert.deepEqual(enumOptions(box).map((_row, at) => enumCell(box, 'option.label', at).props.value),
    ['euler', 'ddim'], '存下来的选项原样呈现');
  assert.deepEqual(findAll(opened, (node) => node.props && node.props['data-param-bind-target']), [],
    '工作流的落点也不渲染');
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
  const panel = openModelSection(opened);
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
  const panel = openModelSection(opened);
  assert.ok(panel, 'expected the expanded panel');
  assert.ok(!findAll(panel, (node) => node.type === 'textarea').length, 'A1111 has no workflow box');
  // 参数表现在是唯一一张表：六行 sdapi 字段，每行一个「暴露」开关。
  const names = findAll(panel, (node) => node.props['data-param-field'] === 'name').map((node) => String(node.props.value));
  assert.deepEqual(names, ['steps', 'cfg_scale', 'sampler_name', 'scheduler', 'seed', 'denoising_strength']);
  const descriptions = findAll(panel, (node) => node.props['data-param-field'] === 'description')
    .map((node) => String(node.props.value)).join(' ');
  assert.match(descriptions, /Sampling steps/i, '每一行都带着给对话模型看的说明');
  assert.match(descriptions, /prompt constrains the image/i);
  const boxes = findAll(panel, (node) => node.type === 'button'
    && node.props['data-param-field'] === 'expose');
  assert.equal(boxes.length, 6);
  assert.ok(boxes.every((box) => box.props['aria-pressed'] === 'false'), 'everything starts unexposed');
});

test('switching an A1111 parameter on persists it on the row, not in the old expose map', async () => {
  const { harness, tree } = await openEditor(A1111_SAMPLING_CONFIG);
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  const panel = openModelSection(opened);
  const boxes = findAll(panel, (node) => node.type === 'button'
    && node.props['data-param-field'] === 'expose');
  boxes[0].props.onClick();
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
  const panel = openModelSection(opened);
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
  const boxes = findAll(tree, (node) => node.type === 'button'
    && node.props['data-param-field'] === 'expose');
  assert.equal(boxes.length, 3, 'width, height and steps keep their expose toggles');
  assert.ok(boxes.every((box) => box.props['aria-pressed'] === 'false'));
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
    key: '', hasKey: true, adapter: 'openai-images', protocol: 'openai-images', optionalKey: false,
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
    key: '', hasKey: true, adapter: 'openai-images', protocol: 'openai-images', optionalKey: false,
    models: ['gpt-image-2.5-flare'], names: {}
  }],
  active: { providerId: 'pb', model: 'gpt-image-2.5-flare' },
  defaults: {}
};

/**
 * 手动上锁一份配置的当前模型。
 *
 * 预设来源已经没有「模型选项」面板了（预设定死了输入与返回），所以「锁」现在只剩
 * 用户自己按上去这一种用法：把 entry.locked 写进夹具，面板就会按锁态渲染。
 */
function lockKeysFor(config, keys) {
  const provider = config.providers[0];
  const model = config.active.model;
  const previous = (provider.modelOptions || {})[model] || {};
  const locked = Object.assign({}, previous.locked);
  for (const key of keys) locked[key] = true;
  provider.modelOptions = Object.assign({}, provider.modelOptions, {
    [model]: Object.assign({}, previous, { locked: locked })
  });
  return config;
}

/** 手动上锁的中转站：预设来源没有面板，锁态只能用这种方式构造。 */
const LOCKED_RELAY_CONFIG = lockKeysFor(JSON.parse(JSON.stringify(RELAY_CONFIG)), ['size', 'quality', 'prompt', 'image']);

/** 八个键全锁的中转站（整块锁的选中态：`PARAM_KEYS.every(locked)`）。 */
const ALL_LOCKED_RELAY_CONFIG = lockKeysFor(JSON.parse(JSON.stringify(RELAY_CONFIG)),
  ['size', 'quality', 'prompt', 'negative', 'model', 'n', 'image', 'operations']);

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
/**
 * 模型选项面板自己的框体：模型行里「输入设置」那个 details 的 customizedBody。
 * 不能直接取全树第一个 customizedBody —— 提供商表单自己的折叠区（协议设置 / 自定义设置）
 * 也是同一个类名，而且排在模型行前面。
 */
const panelBody = (tree) => {
  const panel = openModelSection(tree);
  return panel ? findAll(panel, (node) => hasClass(node, 'customizedBody'))[0] : null;
};

async function configureAll(harness) {
  const button = findButton(harness.renderRoot(), (node) => /Configure every model/i.test(textOf(node).join('')));
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

test('预设来源没有模型选项：中转站与自定义提供商有，且默认不锁', async () => {
  // 预设已经把输入与返回定死了，模型行的箭头还在但禁用（不是删掉——列表里有的行有、
  // 有的没有，看着像漏渲染）。
  const preset = await openEditor(PRESET_CONFIG);
  const presetToggle = optionsToggle(preset.harness.renderRoot());
  assert.ok(presetToggle, '预设来源：箭头照旧渲染');
  assert.equal(presetToggle.props.disabled, true, '预设来源：只是禁用');

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

test('锁状态只存与默认不同的键：预设上锁、自配解锁、ComfyUI 的输入键不锁', () => {
  const { api } = createHarness({ config: PRESET_CONFIG });
  // 跨 vm 边界的对象走一趟 JSON：deepEqual 会比对原型，vm 里的 Object 与本进程不是同一个。
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const preset = { presetId: 'openai', adapter: 'openai-images' };
  const relay = { adapter: '' };
  const custom = { adapter: 'custom' };
  // ComfyUI 的参数是用户自己接到工作流上的：输入键不锁，但返回格式仍是协议定的，照锁。
  const comfy = { presetId: 'comfyui', adapter: 'comfyui' };

  const customEntry = {};
  api.__test.writeLock(customEntry, 'size', true, custom);
  assert.deepEqual(plain(customEntry.locked), { size: true }, '默认不锁，上锁才写');
  api.__test.writeLock(customEntry, 'size', false, custom);
  assert.equal(customEntry.locked, undefined, '回到默认值就该把整条锁删掉');

  const presetEntry = {};
  api.__test.writeLock(presetEntry, 'image', false, preset);
  assert.deepEqual(plain(presetEntry.locked), { image: false }, '预设默认全锁，解锁才写');
  assert.deepEqual(plain(api.__test.lockedMapOf({}, preset)), {
    size: true, quality: true, prompt: true, negative: true, model: true, n: true, image: true, operations: true
  });
  for (const provider of [relay, custom]) {
    assert.deepEqual(plain(api.__test.lockedMapOf({}, provider)), {
      size: false, quality: false, prompt: false, negative: false, model: false, n: false, image: false, operations: false
    });
  }
  assert.deepEqual(plain(api.__test.lockedMapOf({}, comfy)), {
    size: false, quality: false, prompt: false, negative: false, model: false, n: false, image: false, operations: true
  }, 'ComfyUI：输入参数不锁，输出设置照预设来源锁');
  // 老配置没有 presetId：按自配处理（放宽），一升级不该发现改不了尺寸。
  assert.equal(plain(api.__test.lockedMapOf({}, {})).size, false);
});

test('本地部署三条（ComfyUI / A1111 / SwarmUI）默认不锁输入键，OpenAI 兼容的 sd-server 仍锁', () => {
  const { api } = createHarness({ config: PRESET_CONFIG });
  const unlockedInputs = {
    size: false, quality: false, prompt: false, negative: false, model: false, n: false, image: false
  };
  // 参数清单由部署端决定（装了哪个 sampler、模型目录里有哪几个 checkpoint、工作流接了什么），
  // 预设给不了映射：锁住这些键等于让这个模型配不下去。返回格式仍是协议定的，三种都照锁。
  for (const adapter of ['comfyui', 'a1111', 'swarmui']) {
    assert.deepEqual(plainValue(api.__test.lockDefaultsFor({ presetId: adapter, adapter })),
      { ...unlockedInputs, operations: true },
      adapter + '：输入键默认不锁，返回格式仍按预设来源锁');
  }
  // sd-server / localai / openai-gateway 走 OpenAI 兼容字段（adapter 是 openai-images）：
  // 尺寸、质量、字段模板都有规则可写，和云端预设同一档，照旧全锁。
  for (const presetId of ['sd-server', 'localai', 'openai-gateway']) {
    const defaults = plainValue(api.__test.lockDefaultsFor({ presetId, adapter: 'openai-images' }));
    for (const key of ['size', 'quality', 'prompt', 'negative', 'model', 'n', 'image', 'operations']) {
      assert.equal(defaults[key], true, presetId + ' 的 ' + key + ' 仍锁');
    }
  }
  // 协议 id 是配置里的字符串（可能是手写的）：大小写与空白不该决定锁不锁。
  assert.deepEqual(plainValue(api.__test.lockDefaultsFor({ presetId: 'a1111', adapter: ' A1111 ' })),
    { ...unlockedInputs, operations: true });
});

/** 本地部署预设：presetId 在，但参数由部署端决定。 */
function localPresetConfig(presetId, adapter, baseUrl) {
  return {
    providers: [{
      id: 'pl', name: presetId, baseUrl, key: '', hasKey: false, adapter,
      protocol: 'openai-images', optionalKey: true, presetId,
      models: ['local-model.safetensors'], names: {}
    }],
    active: { providerId: 'pl', model: 'local-model.safetensors' },
    defaults: {}
  };
}

test('面板上 A1111 / SwarmUI 的输入键能直接改，sd-server 的还是锁', async () => {
  // A1111 的模型面板只有参数表（尺寸 / 采样器全走 sdapi 参数），锁在表标题那一行。
  const a1111 = await openEditor(localPresetConfig('a1111', 'a1111', 'http://127.0.0.1:7860'));
  const a1111Panel = openModelPanel(a1111.harness);
  assert.ok(paramBox(a1111Panel, 'common'), 'A1111 的参数表在');
  assert.equal(paramLock(a1111Panel, 'prompt').props['aria-pressed'], 'false', 'A1111 的参数表默认不锁');
  assert.notEqual(paramCell(commonRows(a1111Panel)[0], 'name').props.disabled, true, 'A1111 的参数行能直接改');

  // SwarmUI 走模型选项面板：尺寸方框的锁也默认松着。
  const swarm = await openEditor(localPresetConfig('swarmui', 'swarmui', 'http://127.0.0.1:7801'));
  const swarmPanel = openModelPanel(swarm.harness);
  assert.equal(paramLock(swarmPanel, 'size').props['aria-pressed'], 'false', 'SwarmUI 的尺寸不锁');
  const sizeMode = findAll(swarmPanel, (node) => node.type === 'select'
    && node.props['data-param-key'] === 'size')[0];
  assert.notEqual(sizeMode.props.disabled, true, 'SwarmUI 的尺寸控件能直接改');

  // sd-server 走 OpenAI 兼容字段：和云端预设同一档，箭头在但禁用。
  const sd = await openEditor(localPresetConfig('sd-server', 'openai-images', 'http://127.0.0.1:8080/v1'));
  const sdToggle = optionsToggle(sd.harness.renderRoot());
  assert.ok(sdToggle, 'sd-server：箭头照旧渲染');
  assert.equal(sdToggle.props.disabled, true, 'sd-server：只是禁用');
});

test('一键配置把命中的尺寸与字段写进去，并把整块输入设置锁上', async () => {
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
  // 配好的模型整块输入设置锁上（七个输入键都锁），返回格式那个键不跟着动。
  assert.deepEqual(entry.locked, {
    size: true, quality: true, prompt: true, negative: true, model: true, n: true, image: true
  });
  assert.equal(entry.locked.operations, undefined, '输出设置的锁不归一键配置管');
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
    size: true, quality: true, prompt: true, negative: true, model: true, n: true, image: true
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
  assert.equal(textOf(notice[0]).join(''),
    'Configured 1 model(s); 1 have no specific rule and use protocol defaults (not written, not locked)');
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
  // 锁态来自用户自己按的那几下（预设来源没有面板了）：夹具里把这几个键上锁。
  const { harness } = await openEditor(LOCKED_RELAY_CONFIG);
  let opened = openModelPanel(harness);
  assert.equal(paramInput(opened, 'size').props.disabled, true);
  paramLock(opened, 'size').props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.notEqual(paramInput(opened, 'size').props.disabled, true, '解锁后可手填');
  paramLock(opened, 'size').props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.equal(paramInput(opened, 'size').props.disabled, true, '再点一次又锁上');
});

test('整块锁：一键全锁 / 一键全解，都走标题行那一把锁', async () => {
  const { harness } = await openEditor(ALL_LOCKED_RELAY_CONFIG);
  let opened = openModelPanel(harness);
  const masterLock = () => findAll(opened, (node) => node.type === 'button'
    && node.props['data-mo-image-params-lock'] !== undefined)[0];
  assert.ok(masterLock(), '「输入设置」标题行上有整块锁');
  assert.equal(masterLock().props['aria-pressed'], 'true', '这四个键都锁着 → 显示已上锁');
  masterLock().props.onClick(fakeEvent());
  opened = harness.renderRoot();
  // 「常规」现在是参数表：prompt 行是代表键，其余三行按字段模板有没有出现。
  for (const key of ['size', 'quality', 'prompt', 'image']) {
    assert.notEqual(paramInput(opened, key).props.disabled, true, key + ' 应该已解锁');
  }
  assert.equal(masterLock().props['aria-pressed'], 'false', '全解开之后显示未上锁');

  // 再点一次：全部锁回去。
  masterLock().props.onClick(fakeEvent());
  opened = harness.renderRoot();
  for (const key of ['size', 'quality', 'prompt', 'image']) {
    assert.equal(paramInput(opened, key).props.disabled, true, key + ' 应该已锁上');
  }
});

test('「输入设置」里的「一键配置」只配这一个模型，并把整块输入设置锁上', async () => {
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG, { detect: DETECTED_QWEN });
  let opened = openModelPanel(harness);
  // 标题行的小字按钮：和模型目录那颗同款（linkButton），文案是「一键配置」。
  const configure = findButton(opened, (node) => hasClass(node, 'linkButton')
    && textOf(node).join('') === 'Configure');
  assert.ok(configure, '每个模型都有一颗「一键配置」');
  await configure.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  opened = harness.renderRoot();
  const asked = harness.fetchCalls.filter((call) => call.url.includes('/detect-model-rule'));
  assert.deepEqual(JSON.parse(asked[asked.length - 1].body).models, ['Qwen/Qwen-Image'], '只问这一个模型');
  // 配好的模型整块输入设置锁上：锁图标变成「已上锁」，框里的控件随之禁用。
  assert.equal(findAll(opened, (node) => node.props && node.props['data-mo-image-params-lock'] !== undefined)[0]
    .props['aria-pressed'], 'true', '配完显示已上锁');
  assert.equal(paramInput(opened, 'size').props.disabled, true, '框里的控件跟着禁用');
  const config = await saveAndPosted(harness);
  const entry = config.providers.find((item) => item.id === 'p9').modelOptions['Qwen/Qwen-Image'];
  assert.equal(entry.size.field, 'image_size');
  assert.equal(entry.locked.size, true, '一键配置写过的键顺手锁上');
});

test('手填的输入框收在默认折叠的「输入设置」里', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  const details = modelSections(opened);
  assert.equal(details.length, 1, '恰好一个「输入设置」折叠区');
  assert.notEqual(details[0].props.open, true, '默认折叠');
  assert.match(textOf(findAll(details[0], (node) => node.type === 'summary')[0]).join(''), /Input settings/);
  // 现有参数的控件都在折叠区里（没有字段模板的行不渲染），锁图标与摘要留在外面。
  for (const key of ['size', 'quality', 'prompt', 'image']) {
    assert.ok(findAll(details[0], (node) => node.props && node.props['data-param-key'] === key).length
      || findAll(details[0], (node) => node.props && node.props['data-lock-key'] === key).length,
      key + ' 的控件应该收在输入设置里');
  }
});

test('「一键配置所有模型」在中转站与自定义提供商上出现，预设来源不出现', async () => {
  const hasBulk = (tree) => Boolean(findButton(tree, (node) => /Configure every model/i.test(textOf(node).join(''))));
  assert.ok(hasBulk((await openEditor(RELAY_CONFIG)).tree), 'adapter 为空的中转站最需要一键配置');
  assert.ok(hasBulk((await openEditor(CUSTOM_RELAY_CONFIG)).tree), '自定义协议也要有');
  assert.ok(!hasBulk((await openEditor(PRESET_CONFIG)).tree), '预设来源开箱即用，不出现');
});

test('选预设就记 presetId（来源），手改 API 地址不动它', async () => {
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

  // 同一家提供商换个地址（反代 / 换域名 / 私有化部署）之后仍然是那份预设：
  // 来源不跟着地址丢，否则锁默认值与「协议设置整块隐藏」都会翻面。
  // 真要换一套配置，用户会另建一个提供商。
  const second = await openNewProvider();
  second.presetSelect.props.onChange({ target: { value: 'openai' } });
  const urlInput = findAll(second.harness.renderRoot(), (node) => node.type === 'input'
    && node.props.value === 'https://api.openai.com/v1')[0];
  assert.ok(urlInput, 'expected the API URL input');
  urlInput.props.onChange({ target: { value: 'https://relay.example.com/v1' } });
  const saved = lastProvider(await saveAndPosted(second.harness));
  assert.equal(saved.presetId, 'openai', '改地址不影响来源');
  assert.equal(saved.baseUrl, 'https://relay.example.com/v1', '地址照改');
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
      key: '', hasKey: true, adapter: 'openai-images', protocol: 'openai-images', optionalKey: false,
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

/* ─────────────── enum 参数：一个参数一个方框（和「质量」方框同构） ─────────────── */

/** enum 方框：`data-param-box="enum:<行号>"`，每个 enum 参数一个。 */
const enumBoxes = (tree) => findAll(tree, (node) => node.props
  && /^enum:\d+$/.test(String(node.props['data-param-box'] || '')));
/** 按参数名找那个 enum 方框（标题与参数名输入都是它）。 */
const enumBoxNamed = (tree, name) => enumBoxes(tree).find((box) => {
  const input = enumCell(box, 'name');
  return Boolean(input) && input.props.value === name;
}) || null;
const enumKeyOf = (box) => String(box.props['data-param-box']);
/** 选项表的表头 / 表体行：grid 键带方框号，多个 enum 参数也不会互相串。 */
const enumHead = (box) => findAll(box, (node) => node.props
  && node.props['data-param-grid'] === enumKeyOf(box) + ':head')[0] || null;
const enumOptions = (box) => findAll(box, (node) => node.props
  && node.props['data-param-grid'] === enumKeyOf(box) + ':option');
/** 方框里的某个控件：field 是键后缀（option.label / option.default …）或 data-param-field，index 是选项行号。 */
const enumCell = (box, field, index) => {
  const scope = index === undefined ? box : enumOptions(box)[index];
  if (!scope) return null;
  if (field.startsWith('option.')) {
    const key = enumKeyOf(box) + '.' + field;
    return findAll(scope, (node) => node.props && node.props['data-param-key'] === key)[0] || null;
  }
  return findAll(scope, (node) => node.props && node.props['data-param-field'] === field)[0] || null;
};

/* ─────────────── 模型：独立成框（不再是「常规」表里的一行） ─────────────── */

/** 模型方框：`data-param-box="model"`，框里是参数名 + 行级锁（暴露是推导的，没有控件），不可删。 */
const modelBox = (tree) => paramBox(tree, 'model');
const modelNameInput = (tree) => findAll(modelBox(tree), (node) => node.type === 'input'
  && node.props['data-param-field'] === 'name')[0] || null;
const modelRowLock = (tree) => findAll(modelBox(tree), (node) => node.type === 'button'
  && node.props['data-lock-key'] === 'model')[0] || null;
/** 选择器切到「自动」：不固定模型，模型名交给对话模型挑。 */
const autoConfig = (config) => ({
  ...config, active: { providerId: config.active.providerId, model: 'auto' }
});

test('「常规」是一张离散参数表：表头用 data-param-grid，表体一行一个参数', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  const opened = openModelPanel(harness);
  const box = commonBox(opened);
  assert.ok(box, '「常规」方框存在');
  assert.equal(textOf(box.children[0].children[0]).join(''), 'General', '第一行仍是标题「常规」');

  const head = paramGrid(opened, 'params:head')[0];
  assert.ok(head, '表头行在');
  assert.deepEqual(textOf(head).join('|').split('|'),
    ['Parameter name', 'Type', 'Default', 'Description', 'Actions'],
    '表头：参数名 / 类型 / 默认值 / 描述 / 操作');
  // 只有表头居中；表体保持左对齐（操作列是图标按钮）。
  for (const cell of head.children) assert.equal(cell.props.style.textAlign, 'center', '表头文字居中');
  assert.equal(paramRow(box, 'prompt'), null, '表头不占用 data-param-row');
  assert.equal(paramRow(box, 'negative'), null, '表体也不占用 data-param-row（label 不再固定 88px）');

  const rows = commonRows(opened);
  assert.deepEqual(rows.map((row) => row.props['data-param-role']),
    ['prompt', 'negative', 'n'], '内置行按固定顺序排列；模型行自成方框（见 modelBox）');
  for (const row of rows) {
    assert.equal(row.props.style.gridTemplateColumns, head.props.style.gridTemplateColumns,
      '表体与表头共用同一套 grid 列宽');
    assert.equal(row.props.style.columnGap, head.props.style.columnGap, '列间距也一致');
    assert.equal(row.props.style.minHeight, 48, '所有行等高：两行小字也装得下');
    assert.equal(row.children.length, 5, '每行只有五格：落点与选项不再自占整行');
    for (const field of ['name', 'type', 'default', 'description', 'expose']) {
      assert.ok(paramCell(row, field), row.props['data-param-role'] + ' 缺 ' + field + ' 单元格');
    }
    assert.equal(paramCell(row, 'name').props.style.textAlign, undefined, '表体不居中');
    assert.equal(findAll(paramCell(row, 'description'), (node) => node.type === 'details').length, 0,
      '描述格里不再挂 enum 选项的折叠小字：enum 行整行搬去了自己的方框');
  }
  assert.equal(findAll(box, (node) => node.props && node.props['data-param-bind-target']).length, 0,
    '落点不再渲染：参数名格子只有一行');
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
  assert.equal(expose.props['aria-pressed'], 'true', '暴露固定打开');
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
  assert.equal(commonRows(opened).length, 3, '提示词 + 负面词 + 张数（模型自成方框，不在表里）');

  // 删除内置的负面词行：第一次点击只进入确认，第二次才真删。
  paramCell(commonRow(opened, 'negative'), 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.ok(commonRow(opened, 'negative'), '第一次点击不删行');
  const armed = paramCell(commonRow(opened, 'negative'), 'remove');
  assert.equal(textOf(armed).join(''), '', '确认态不换文字');
  assert.equal(findAll(armed, (node) => node.type === 'svg')[0].props['data-param-glyph'], 'warning',
    '同一个按钮换成警告图标');
  assert.ok(hasClass(armed, 'iconButtonDanger'), '仍是模型列表那个删除按钮的样式');
  paramCell(commonRow(opened, 'negative'), 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.equal(commonRow(opened, 'negative'), null, '负面词行没了');
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']),
    ['prompt', 'n']);

  // 新增一行：用户行没有 role。
  addParamButton(opened).props.onClick();
  opened = harness.renderRoot();
  let rows = commonRows(opened);
  assert.equal(rows.length, 3, '新增的一行立刻出现');
  const custom = rows[2];
  assert.equal(custom.props['data-param-role'], undefined, '用户行没有 role');
  assert.equal(paramCell(custom, 'name').props.value, '', '新行等着填名字');

  const edit = (field, value) => {
    paramCell(commonRows(harness.renderRoot())[2], field).props.onChange({ target: { value: value } });
    return harness.renderRoot();
  };
  edit('name', 'seed');
  edit('type', 'number');
  edit('default', '42');
  opened = edit('description', 'Seed value');
  paramCell(commonRows(opened)[2], 'expose').props.onClick();
  opened = harness.renderRoot();
  assert.equal(paramCell(commonRows(opened)[2], 'expose').props['aria-pressed'], 'true');

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
  assert.equal(commonRows(opened).length, 2, '提示词 + 用户行（模型自成方框，不在表里）');
  const seedRow = commonRows(opened).find((row) => !row.props['data-param-role']);
  paramCell(seedRow, 'remove').props.onClick();
  opened = harness.renderRoot();
  const stillThere = commonRows(opened).find((row) => !row.props['data-param-role']);
  assert.ok(stillThere, '第一次点击只是确认');
  paramCell(stillThere, 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.equal(commonRows(opened).some((row) => !row.props['data-param-role']), false, '用户行删掉了');
  const entry = await savedTableEntry(harness);
  assert.equal(entry.params.some((row) => row.name === 'seed'), false);
  assert.equal(entry.fields.model.path, 'model', '删用户行不动字段模板');
});

test('enum 行搬出「常规」表：每个 enum 参数一个方框，标题是参数名', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  assert.equal(enumBoxes(opened).length, 0, '没有 enum 行时没有 enum 方框');
  assert.equal(paramCell(commonRow(opened, 'negative'), 'type').props.value, 'text', '负面词一开始是 text');

  paramCell(commonRow(opened, 'negative'), 'type').props.onChange({ target: { value: 'enum' } });
  opened = harness.renderRoot();
  // ① 「常规」表里不再有这一行：只剩 text / number / boolean。
  assert.equal(commonRow(opened, 'negative'), null, 'enum 行不在「常规」表里');
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']), ['prompt', 'n'],
    '「常规」只留 text / number / boolean 的行');
  // ② 它成了自己的一个方框，标题是参数名。
  const boxes = enumBoxes(opened);
  assert.equal(boxes.length, 1, '一个 enum 参数一个方框');
  const box = boxes[0];
  assert.equal(textOf(box.children[0].children[0]).join(''), 'negative_prompt', '标题用参数名');
  const name = enumCell(box, 'name');
  assert.ok(name, '框内还有参数名输入');
  assert.equal(name.props.value, 'negative_prompt');
  assert.equal(name.props['data-param-key'], 'negative', '参数名沿用行键，旧查询仍可用');
  // ③ 框里是选项表，不是散装输入框。
  assert.ok(enumHead(box), '选项表有表头');
  assert.deepEqual(textOf(enumHead(box)), ['Option name', 'Value', 'Default', 'Actions'],
    '表头：选项名 / 值 / 是否默认 / 操作');
  assert.equal(enumOptions(box).length, 0, '刚切成 enum 时没有选项行');
  assert.ok(enumCell(box, 'option.add'), '框里有「添加选项」');
  assert.ok(enumCell(box, 'remove'), '行级删除也跟过来：enum 行仍能被去掉');

  // ④ 标题跟着用户改过的名字走。
  enumCell(box, 'name').props.onChange({ target: { value: 'sampling' } });
  opened = harness.renderRoot();
  assert.equal(textOf(enumBoxes(opened)[0].children[0].children[0]).join(''), 'sampling', '标题跟着参数名');

  const entry = await savedTableEntry(harness);
  assert.equal(entry.params.find((row) => row.role === 'negative').type, 'enum');
  assert.equal(entry.params.find((row) => row.role === 'negative').name, 'sampling');
});

test('选项表：添加 / 改名 / 单选默认 / 删除，按编辑结果落盘', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  let opened = openModelPanel(harness);
  // 回读：两个选项按配置顺序；值列是真正发出去的字符串；default 命中哪个就勾哪个。
  let box = enumBoxNamed(opened, 'negative_prompt');
  assert.ok(box, '负面词的 enum 方框在');
  assert.equal(enumOptions(box).length, 2);
  assert.deepEqual(enumOptions(box).map((_row, at) => enumCell(box, 'option.label', at).props.value),
    ['blurry', 'low quality']);
  assert.deepEqual(enumOptions(box).map((_row, at) => textOf(enumCell(box, 'option.value', at)).join('')),
    ['blurry', 'low quality'], 'enum 的选项名就是值，两列看到的是同一个字符串');
  assert.deepEqual(enumOptions(box).map((_row, at) => enumCell(box, 'option.default', at).props.checked),
    [true, false], 'default 命中哪个选项就勾哪个');

  // 添加一条、写上值、设为默认。
  enumCell(box, 'option.add').props.onClick();
  opened = harness.renderRoot();
  box = enumBoxNamed(opened, 'negative_prompt');
  assert.equal(enumOptions(box).length, 3, '加一行空的选项');
  assert.equal(enumCell(box, 'option.label', 2).props.value, '', '新选项等着填');
  enumCell(box, 'option.label', 2).props.onChange({ target: { value: 'euler' } });
  opened = harness.renderRoot();
  box = enumBoxNamed(opened, 'negative_prompt');
  assert.equal(textOf(enumCell(box, 'option.value', 2)).join(''), 'euler', '值列跟着选项名走');
  enumCell(box, 'option.default', 2).props.onChange();
  opened = harness.renderRoot();

  // 删掉原来默认的那条：单选随之清空（默认值不能指向已经不存在的选项）。
  box = enumBoxNamed(opened, 'negative_prompt');
  assert.deepEqual(enumOptions(box).map((_row, at) => enumCell(box, 'option.default', at).props.checked),
    [false, false, true]);
  enumCell(box, 'option.remove', 0).props.onClick();
  opened = harness.renderRoot();
  box = enumBoxNamed(opened, 'negative_prompt');
  assert.deepEqual(enumOptions(box).map((_row, at) => enumCell(box, 'option.label', at).props.value),
    ['low quality', 'euler'], '删除只去掉那一行');
  assert.deepEqual(enumOptions(box).map((_row, at) => enumCell(box, 'option.default', at).props.checked),
    [false, true], '默认档删掉后单选落到剩下的那条');

  const entry = await savedTableEntry(harness);
  const negative = entry.params.find((row) => row.role === 'negative');
  assert.equal(negative.type, 'enum');
  assert.deepEqual(negative.options, ['low quality', 'euler'], '增删选项落盘');
  assert.equal(negative.default, 'euler', '默认值跟着单选走');
});

test('enum 方框标题行保留行级操作：暴露与行锁都写回 params', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  let opened = openModelPanel(harness);
  let box = enumBoxNamed(opened, 'negative_prompt');
  assert.equal(enumCell(box, 'expose').props['aria-pressed'], 'false', '默认不暴露');
  enumCell(box, 'expose').props.onClick();
  opened = harness.renderRoot();
  box = enumBoxNamed(opened, 'negative_prompt');
  assert.equal(enumCell(box, 'expose').props['aria-pressed'], 'true', '暴露是行级的，点一下就开');

  const lock = findAll(box, (node) => node.type === 'button'
    && node.props['data-lock-key'] === enumKeyOf(box))[0];
  assert.ok(lock, '标题行有行级锁（data-lock-key 仍在）');
  assert.equal(lock.props['aria-pressed'], 'false', '默认不锁');
  lock.props.onClick(fakeEvent());
  opened = harness.renderRoot();
  box = enumBoxNamed(opened, 'negative_prompt');
  assert.equal(findAll(box, (node) => node.type === 'button'
    && node.props['data-lock-key'] === enumKeyOf(box))[0].props['aria-pressed'], 'true');

  const entry = await savedTableEntry(harness);
  const negative = entry.params.find((row) => row.role === 'negative');
  assert.equal(negative.expose, true, '暴露写进 params');
  assert.equal(negative.locked, true, '行级锁也写进 params（只存 true）');
});

test('enum 方框的删除：第一次只变成确认，第二次才真删', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  let opened = openModelPanel(harness);
  enumCell(enumBoxNamed(opened, 'sampler'), 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.ok(enumBoxNamed(opened, 'sampler'), '第一次点击不删');
  const armed = enumCell(enumBoxNamed(opened, 'sampler'), 'remove');
  assert.equal(textOf(armed).join(''), '', '确认态不换文字');
  assert.equal(findAll(armed, (node) => node.type === 'svg')[0].props['data-param-glyph'], 'warning',
    '同一个按钮换成警告图标');
  enumCell(enumBoxNamed(opened, 'sampler'), 'remove').props.onClick();
  opened = harness.renderRoot();
  assert.equal(enumBoxNamed(opened, 'sampler'), null, '第二次点击才真删');

  const entry = await savedTableEntry(harness);
  assert.equal(entry.params.some((row) => row.name === 'sampler'), false, '删掉的 enum 行不再落盘');
  assert.equal(entry.params.filter((row) => row.type === 'enum').length, 1, '别的 enum 行不受影响');
});

test('选项表与参数表同一套 grid：列宽固定 / 表头居中 / 超长截断 / 行等高', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  const opened = openModelPanel(harness);
  const box = enumBoxNamed(opened, 'negative_prompt');
  const paramsHead = paramGrid(opened, 'params:head')[0];
  const paramsRow = commonRows(opened)[0];
  const head = enumHead(box);
  const row = enumOptions(box)[0];

  // 同一套 grid：同一个 display / 列间距 / 行高，列宽是一份固定模板（含 px 列）。
  assert.equal(head.props.style.display, paramsHead.props.style.display, '表头用 grid');
  assert.equal(row.props.style.display, paramsRow.props.style.display, '表体也用 grid');
  assert.equal(head.props.style.columnGap, paramsHead.props.style.columnGap, '列间距与参数表一致');
  assert.equal(row.props.style.columnGap, paramsRow.props.style.columnGap);
  assert.equal(row.props.style.minHeight, paramsRow.props.style.minHeight, '行等高：选项行和参数行一样高');
  assert.equal(row.props.style.gridTemplateColumns, head.props.style.gridTemplateColumns,
    '表头与表体共用一份列宽');
  assert.match(String(head.props.style.gridTemplateColumns), /\d+px/, '有固定像素列：长内容撑不开列宽');
  for (const cell of head.children) {
    if (!textOf(cell).length) continue; // 删除列没有表头文字
    assert.equal(cell.props.style.textAlign, 'center', '表头文字居中');
  }
  // 值列是只读文本，超长截断（三件套与参数表的格子一致）。
  const valueCell = enumCell(box, 'option.value', 0);
  assert.equal(textOf(valueCell).join(''), 'blurry');
  for (const style of ['overflow', 'textOverflow', 'whiteSpace', 'minWidth']) {
    assert.equal(valueCell.props.style[style], paramCell(paramsRow, 'name').props.style[style],
      '截断样式与参数表一致：' + style);
  }

  // 质量挡位表也搬进了同一套 grid：列宽 / 列间距 / 行高都一样，表头也居中。
  const ladderHead = qualityHead(opened);
  assert.ok(ladderHead, '质量挡位表在');
  assert.equal(ladderHead.props.style.gridTemplateColumns, head.props.style.gridTemplateColumns,
    '质量挡位表与 enum 选项表共用同一份列宽');
  assert.equal(ladderHead.props.style.columnGap, head.props.style.columnGap);
  assert.equal(qualityOptions(opened)[0].props.style.minHeight, row.props.style.minHeight, '挡位行与选项行等高');
  for (const cell of ladderHead.children) {
    if (!textOf(cell).length) continue;
    assert.equal(cell.props.style.textAlign, 'center', '挡位表表头也居中');
  }
});

test('三张表的最后一列表头统一是「操作」并居中', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  const opened = openModelPanel(harness);
  const heads = [
    ['常规参数表', paramGrid(opened, 'params:head')[0]],
    ['enum 选项表', enumHead(enumBoxNamed(opened, 'negative_prompt'))],
    ['质量挡位表', qualityHead(opened)]
  ];
  const lastTexts = [];
  for (const [label, head] of heads) {
    assert.ok(head, label + ' 的表头在');
    const last = head.children[head.children.length - 1];
    assert.equal(textOf(last).join(''), 'Actions', label + ' 的最后一列表头是「操作」');
    assert.equal(last.props.style.textAlign, 'center', label + ' 的最后一列表头居中');
    lastTexts.push(textOf(last).join(''));
  }
  assert.deepEqual(lastTexts, ['Actions', 'Actions', 'Actions'], '三张表的最后一列表头一致');
});

test('方框顺序：常规 → 模型 → 各 enum 方框（按表里的顺序）→ 尺寸 → 质量 → 参考图', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  const opened = openModelPanel(harness);
  const body = panelBody(opened);
  assert.ok(body, '模型选项面板的框体在');
  assert.deepEqual(findAll(body, (node) => node.props && node.props['data-param-box'])
    .map((node) => node.props['data-param-box']),
  ['common', 'model', 'enum:1', 'enum:4', 'size', 'quality', 'image'],
  '常规表 → 模型框 → enum 各自成框（按表里顺序）→ 尺寸 / 质量 / 参考图照旧在最后');
});

test('方框标题用正文主色（主题自适应），不再是次要灰', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  const opened = openModelPanel(harness);
  const boxes = findAll(opened, (node) => node.props && node.props['data-param-box']);
  assert.deepEqual(boxes.map((node) => node.props['data-param-box']),
    ['common', 'model', 'enum:1', 'enum:4', 'size', 'quality', 'image'],
    '常规 / 模型 / 各 enum / 尺寸 / 质量 / 参考图的方框都检查');
  for (const box of boxes) {
    const key = box.props['data-param-box'];
    const title = box.children[0].children[0];
    const color = String((title.props.style && title.props.style.color) || '');
    // 主题变量：深色 / 浅色主题各自解析成正文主色，而不是宿主的次要灰。
    assert.match(color, /var\(--dsw-alias-label-primary\)|currentColor/, key + ' 的标题颜色要取正文主色');
    assert.doesNotMatch(color, /label-secondary|label-tertiary|opacity|#646a73/, key + ' 的标题不能再用次要灰');
    // 只改颜色：字号 / 字重保持 14px / 600。
    assert.equal(title.props.style.fontSize, 14, key + ' 标题字号不变');
    assert.equal(title.props.style.fontWeight, 600, key + ' 标题字重不变');
  }
  // 其它文字保留灰的层次：行 label 没有跟着变主色，表头仍压低一档。
  const rowLabel = paramRow(paramBox(opened, 'image'), 'image:field').children[0];
  assert.equal(rowLabel.props.style.color, undefined, '行 label 不跟标题一起变亮');
  const headCell = paramGrid(opened, 'params:head')[0].children[0];
  assert.equal(headCell.props.style.opacity, 0.72, '表头仍是原来的灰');
});

/* ─────────────── 模型框：独立方框 + 参数名提示（暴露是推导的，没有控件） ─────────────── */

test('模型独立成框：常规表里没有 model 行，框里只有参数名与行级锁，且不可删', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  assert.ok(modelBox(opened), '模型方框存在');
  assert.equal(textOf(modelBox(opened).children[0].children[0]).join(''), 'Model', '标题是「模型」');
  assert.equal(commonRow(opened, 'model'), null, '「常规」表里没有 model 行');
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']),
    ['prompt', 'negative', 'n'], '「常规」只留还能增删的普通行');
  assert.equal(textOf(modelNameInput(opened).props.value).join(''), 'model', '参数名默认 model');
  assert.equal(modelNameInput(opened).props['data-param-key'], 'model', '沿用的还是 model 这个键');
  // 模型是特殊值：暴露只由「选择器是不是自动」推导，框里不给手动开关。
  assert.equal(findAll(modelBox(opened), (node) => node.props && node.props['data-param-field'] === 'expose').length, 0,
    '模型框里没有暴露控件');
  assert.equal(findAll(modelBox(opened), (node) => node.props && node.props['data-param-key'] === 'model.expose').length, 0);
  const lock = modelRowLock(opened);
  assert.ok(lock, '行级锁在标题行');
  assert.equal(lock.props['aria-pressed'], 'false', '默认不锁');
  assert.equal(findAll(modelBox(opened), (node) => node.props && node.props['data-param-field'] === 'remove').length, 0,
    '模型行不可删：行尾没有删除按钮');
  assert.equal(findAll(modelBox(opened), (node) => node.props && node.props['data-param-key'] === 'model.remove').length, 0);

  // 行级锁仍写回 params 里同一行；模型行不写 expose（那是推导值，写了也没人读）。
  modelRowLock(opened).props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.equal(modelRowLock(opened).props['aria-pressed'], 'true', '行级锁写回同一行');
  const entry = await savedTableEntry(harness);
  const modelRow = entry.params.find((row) => row.role === 'model');
  assert.equal(modelRow.locked, true, '行级锁落在同一行');
  assert.equal('expose' in modelRow, false, '模型行没有 expose：暴露是按选择器推导的');
});

test('选择器在「自动」时模型框也没有暴露控件，落盘的模型行同样不写 expose', async () => {
  const auto = await openEditor(autoConfig(PARAM_TABLE_CONFIG));
  let panel = openModelPanel(auto.harness);
  assert.equal(findAll(modelBox(panel), (node) => node.props && node.props['data-param-field'] === 'expose').length, 0,
    '自动模式下框里也没有暴露控件');
  assert.equal(modelNameInput(panel).props['data-param-key'], 'model');

  // 任何一次编辑都会把整张表写回 draft：这时模型行照样不带 expose。
  modelRowLock(panel).props.onClick(fakeEvent());
  panel = auto.harness.renderRoot();
  assert.equal(modelRowLock(panel).props['aria-pressed'], 'true', '行级锁照常写回');
  const entry = await savedTableEntry(auto.harness);
  const modelRow = entry.params.find((row) => row.role === 'model');
  assert.ok(modelRow, '模型行照常在表里');
  assert.equal(modelRow.locked, true, '行级锁落在同一行');
  assert.equal('expose' in modelRow, false, '自动模式也不给模型行写 expose');
});

test('老配置里模型行带着 expose：读进来照常可用，改一次就以推导为准（不再写回）', async () => {
  const stored = {
    providers: [{
      ...PARAM_TABLE_CONFIG.providers[0],
      modelOptions: {
        'gpt-image-2.5-flare': {
          params: [
            { role: 'prompt', name: 'prompt', type: 'text', default: '', expose: true },
            { role: 'model', name: 'model', type: 'text', default: '', description: 'old', expose: true, locked: true }
          ]
        }
      }
    }],
    active: PARAM_TABLE_CONFIG.active,
    defaults: {}
  };
  const { harness } = await openEditor(stored);
  let opened = openModelPanel(harness);
  assert.equal(modelNameInput(opened).props.value, 'model', '老行照常读进来');
  assert.equal(modelRowLock(opened).props['aria-pressed'], 'true', '行级锁保留');
  assert.equal(findAll(modelBox(opened), (node) => node.props && node.props['data-param-field'] === 'expose').length, 0,
    '框里没有暴露控件');

  modelNameInput(opened).props.onChange({ target: { value: 'image_model' } });
  opened = harness.renderRoot();
  assert.equal(modelNameInput(opened).props.value, 'image_model');
  const entry = await savedTableEntry(harness);
  const modelRow = entry.params.find((row) => row.role === 'model');
  assert.equal(modelRow.name, 'image_model', '改名照旧落盘');
  assert.equal(modelRow.locked, true, '行级锁照旧保留');
  assert.equal('expose' in modelRow, false, '老配置里的 expose 被忽略，不再写回去');
});

test('模型参数名为空：标红并给一行提示，但保存照常成功', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let panel = openModelPanel(harness);
  modelNameInput(panel).props.onChange({ target: { value: '' } });
  panel = harness.renderRoot();
  const input = modelNameInput(panel);
  assert.equal(input.props.value, '', '清空后不会自己弹回默认名');
  assert.equal(input.props['aria-invalid'], 'true', '参数名为空：该行标红');
  assert.ok(input.props.style.borderColor, '红边框');
  const hint = findAll(modelBox(panel), (node) => node.props && node.props['data-param-hint'] === 'model');
  assert.equal(hint.length, 1, '在框内给一行提示');
  assert.match(textOf(hint[0]).join(''), /cannot be empty/i, '提示说清楚留空的后果');

  // 只提示、不拦截：保存照常发出去，配置照常落盘。
  const saved = await saveAndPosted(harness);
  assert.ok(saved, '保存没有被拦下');
  const entry = saved.providers.find((item) => item.id === 'p2').modelOptions['gpt-image-2.5-flare'];
  assert.equal(entry.fields && entry.fields.model, undefined, '空名 = 去掉字段模板覆盖');
});

test('操作列：暴露 / 行级锁 / 删除三个按钮，说明走即时气泡而不是原生 title', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  const row = commonRow(opened, 'negative');
  const actions = findAll(row, (node) => node.props['data-param-cell'] === 'actions')[0];
  assert.ok(actions, '操作列在');
  assert.deepEqual(findAll(actions, (node) => node.type === 'button')
    .map((node) => node.props['data-param-key']),
  ['negative.expose', 'negative.lock', 'negative.remove'], '三个操作按钮按顺序排列');

  const expose = paramCell(row, 'expose');
  assert.equal(expose.props.title, undefined, '不用有延迟的原生 title');
  assert.equal(typeof expose.props.onPointerEnter, 'function', '悬停立刻展开说明');
  assert.equal(expose.props['aria-pressed'], 'false');
  expose.props.ref.current = tipTarget({ scrollWidth: 160, clientWidth: 80 });
  expose.props.onPointerEnter();
  opened = harness.renderRoot();
  const tip = findAll(commonRow(opened, 'negative'), (node) => node.props && node.props.role === 'tooltip')[0];
  assert.ok(tip, '悬停出即时气泡');
  assert.match(textOf(tip).join(''), /tuned through params/i, '气泡说明暴露的用途');
  expose.props.onPointerLeave();
});

test('即时气泡宽度跟随内容：max-content + 上限 260，到上限才换行', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  const row = commonRow(opened, 'negative');
  const expose = paramCell(row, 'expose');
  expose.props.ref.current = tipTarget({ scrollWidth: 160, clientWidth: 80 });
  expose.props.onPointerEnter();
  opened = harness.renderRoot();
  const tip = findAll(commonRow(opened, 'negative'), (node) => node.props
    && node.props.role === 'tooltip')[0];
  assert.ok(tip, '悬停出即时气泡');
  assert.equal(tip.props.style.width, 'max-content', '短说明不再被拉成固定宽度');
  assert.equal(tip.props.style.maxWidth, 260, '到上限才折行');
  assert.equal(tip.props.style.whiteSpace, 'normal');
  assert.equal(tip.props.style.wordBreak, 'break-word');
});

test('操作列三个按钮换成同一套 SVG 图标，尺寸 / 描边 / 基线一致', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  const row = commonRow(opened, 'negative');
  const actions = findAll(row, (node) => node.props['data-param-cell'] === 'actions')[0];
  const buttons = findAll(actions, (node) => node.type === 'button');
  assert.deepEqual(buttons.map((node) => node.props['data-param-key']),
    ['negative.expose', 'negative.lock', 'negative.remove'], '三个操作按钮仍在原位');
  // 暴露 / 锁定是插件自己的 SVG；删除按钮复用模型列表那个 primitives 垃圾桶图标。
  const glyphs = buttons.slice(0, 2).map((button) => findAll(button, (node) => node.type === 'svg')[0]);
  for (const [at, svg] of glyphs.entries()) {
    assert.ok(svg, '第 ' + (at + 1) + ' 个按钮用 SVG 图标');
    assert.equal(svg.props.width, 14);
    assert.equal(svg.props.height, 14);
    assert.equal(svg.props.fill, 'none');
    assert.equal(svg.props.stroke, 'currentColor');
    assert.equal(Number(svg.props.strokeWidth), 1.6);
    assert.equal(textOf(buttons[at]).join(''), '', '不再渲染 emoji 文本');
  }
  // 未暴露 = 划掉的眼睛（eye-off），不是正常眼睛。
  assert.deepEqual(glyphs.map((svg) => svg.props['data-param-glyph']), ['eye-off', 'unlock']);
  assert.equal(findAll(buttons[2], (node) => node.type === 'IconTrash').length, 1,
    '删除按钮用的是模型列表同一套垃圾桶图标');
  assert.equal(textOf(buttons[2]).join(''), '', '删除按钮不渲染文字');

  // 暴露打开后眼睛变回正常眼睛。
  buttons[0].props.onClick();
  opened = harness.renderRoot();
  const exposed = paramCell(commonRow(opened, 'negative'), 'expose');
  assert.equal(findAll(exposed, (node) => node.type === 'svg')[0].props['data-param-glyph'], 'eye');
  assert.equal(exposed.props['aria-pressed'], 'true');

  // 上锁后锁图标跟着变，aria-pressed 语义不变；闭锁 / 开锁形状不同。
  buttons[1].props.onClick(fakeEvent());
  opened = harness.renderRoot();
  const lock = paramCell(commonRow(opened, 'negative'), 'lock');
  const lockGlyph = findAll(lock, (node) => node.type === 'svg')[0];
  assert.equal(lockGlyph.props['data-param-glyph'], 'lock');
  assert.equal(lock.props['aria-pressed'], 'true');
  const unlockedGlyph = findAll(paramCell(commonRow(opened, 'n'), 'lock'), (node) => node.type === 'svg')[0];
  assert.equal(unlockedGlyph.props['data-param-glyph'], 'unlock', '未锁的行仍是开锁');
  // 两种锁的路径/矩形形状必须不一样（不是只靠颜色区分）。
  const shapeOf = (glyph) => findAll(glyph, (node) => node.type === 'path' || node.type === 'rect')
    .map((node) => node.props.d || [node.props.x, node.props.y, node.props.width, node.props.height, node.props.rx].join(','))
    .join('|');
  assert.notEqual(shapeOf(lockGlyph), shapeOf(unlockedGlyph), '闭锁 / 开锁形状不同');
});

test('三张表的删除按钮复用模型列表那个删除按钮：同一个组件、同一套样式与图标', async () => {
  const { harness } = await openEditor(ENUM_CONFIG);
  const opened = openModelPanel(harness);
  const dangerButtons = findAll(opened, (node) => node.type === 'button' && hasClass(node, 'iconButtonDanger'));
  // 模型行 + 参数表行 + enum 选项行 + 质量挡位行，都是同一个删除按钮。
  assert.ok(dangerButtons.length >= 4, '删除按钮分布在模型行与三张表里');
  for (const button of dangerButtons) {
    assert.ok(hasClass(button, 'iconButton'), '同一个 iconButton 基类');
    assert.equal(findAll(button, (node) => node.type === 'IconTrash').length, 1, '同一个垃圾桶图标');
    assert.equal(textOf(button).join(''), '', '图标按钮不渲染文字');
    assert.equal(typeof button.props.onPointerEnter, 'function', '说明走即时气泡');
  }
});

test('单元格超长截断，悬停给出完整内容', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  const row = commonRow(opened, 'negative');
  const name = paramCell(row, 'name');
  assert.equal(name.props.title, undefined, '原生 title 有延迟，不能用');
  assert.equal(name.props.style.textOverflow, 'ellipsis', '超长显示省略号');
  assert.equal(name.props.style.whiteSpace, 'nowrap', '不换行');
  assert.equal(name.props.style.overflow, 'hidden', '格子裁掉溢出');
  name.props.ref.current = tipTarget({ scrollWidth: 220, clientWidth: 90 });
  name.props.onPointerEnter();
  opened = harness.renderRoot();
  const refreshedNameCell = findAll(commonRow(opened, 'negative'),
    (node) => node.props['data-param-cell'] === 'name')[0];
  const tip = findAll(refreshedNameCell, (node) => node.props && node.props.role === 'tooltip')[0];
  assert.ok(tip, '被截断时悬停有气泡');
  assert.equal(textOf(tip).join(''), 'negative_prompt', '气泡里是完整内容');
  paramCell(commonRow(opened, 'negative'), 'name').props.onPointerLeave();
});

test('行级锁写进 params：保存后保留，且只存 true', async () => {
  const { harness } = await openEditor(PARAM_TABLE_CONFIG);
  let opened = openModelPanel(harness);
  // 模型行的行级锁跟着搬进了模型方框的标题行。
  const lock = modelRowLock(opened);
  assert.equal(lock.props['aria-pressed'], 'false', '默认不锁');
  lock.props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.equal(modelRowLock(opened).props['aria-pressed'], 'true');
  const entry = await savedTableEntry(harness);
  assert.equal(entry.params.find((row) => row.role === 'model').locked, true, '行级锁落盘');
  assert.equal(entry.params.filter((row) => row.locked).length, 1, '没锁的行不写 locked:false');
});

test('一键配置/自动检测改字段路径时跳过上锁的行', () => {
  const { api } = createHarness({ config: CUSTOM_RELAY_CONFIG });
  const provider = CUSTOM_RELAY_CONFIG.providers[0];
  const entries = {
    'Qwen/Qwen-Image': {
      matched: true,
      rule: {},
      fields: { model: { path: 'new_model' }, negative: { path: 'new_negative' } }
    }
  };
  const modelOptions = {
    'Qwen/Qwen-Image': {
      params: [
        { role: 'model', name: 'old_model', type: 'text', locked: true },
        { role: 'negative', name: 'old_negative', type: 'text' }
      ]
    }
  };
  const result = api.__test.mergeRuleResult(provider, modelOptions, entries, {});
  const rows = result.modelOptions['Qwen/Qwen-Image'].params;
  assert.equal(rows.find((row) => row.role === 'model').name, 'old_model', '上锁的行不被改写');
  assert.equal(rows.find((row) => row.role === 'negative').name, 'new_negative', '没锁的行照旧同步');
});

const SEED_MODEL_ANALYSIS = {
  ok: true,
  format: 'api',
  mapping: {
    prompt: { node: '18:17', input: 'value' },
    seed: { node: '18:7', input: 'seed' },
    model: { node: '18:1', input: 'unet_name' },
    width: { node: '18:6', input: 'width' },
    height: { node: '18:6', input: 'height' },
    image: null
  },
  candidates: {
    seed: [{ node: '18:7', input: 'seed', classType: 'KSampler', value: 1 }],
    model: [{ node: '18:1', input: 'unet_name', classType: 'UNETLoader', value: 'flux.safetensors' }]
  },
  params: [
    { name: 'seed', role: true, node: '18:7', input: 'seed', type: 'INT' },
    { name: 'model', role: true, node: '18:1', input: 'unet_name', type: 'STRING' },
    { name: 'steps', node: '18:7', input: 'steps', type: 'INT' }
  ],
  warnings: []
};

test('删掉旧的种子/模型映射下拉后，两行仍在参数表里可编辑', async () => {
  const tree = await openParsed(SEED_MODEL_ANALYSIS, FIXED_SIZE_CONFIG);
  assert.equal(findAll(tree, (node) => node.props && node.props['data-mapping-key']).length, 0,
    '映射面板不再有种子/模型下拉');
  assert.match(textOf(tree).join(' '), /straight from the tool call/i,
    '提示词那句说明还在（解释它们为什么不在映射里）');
  const rows = commonRows(tree);
  const rowWith = (name) => rows.find((row) => findAll(row, (node) => node.props
    && node.props['data-param-field'] === 'name' && node.props.value === name).length);
  const seed = rowWith('seed');
  const model = rowWith('model');
  assert.ok(seed, '种子是参数表里的普通行');
  assert.ok(model, '模型是参数表里的普通行');
  assert.equal(findAll(tree, (node) => node.props && node.props['data-param-bind-target']).length, 0,
    '落点不再渲染：node/input 只留在数据里，不占参数名格子');
  const name = paramCell(model, 'name');
  assert.notEqual(name.props.disabled, true, '模型行仍可编辑');
  assert.equal(typeof name.props.onChange, 'function', '改名照旧走行内输入');
  assert.equal(paramCell(model, 'type').props.value, 'text');
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
    ['prompt', 'negative'], 'n 是显式不发，不显示行；模型行搬进了自己的方框');
  assert.equal(paramCell(commonRow(opened, 'negative'), 'name').props.value, 'negative_prompt');
  assert.equal(paramCell(commonRow(opened, 'negative'), 'description').props.value, 'What to avoid',
    '描述默认值来自内置文案表');
  assert.equal(modelNameInput(opened).props.value, 'model', '模型方框从 fields 派生参数名');

  // 第一次编辑就把派生行落成 params（不再依赖 fields）。
  modelRowLock(opened).props.onClick(fakeEvent());
  const entry = await savedTableEntry(harness);
  assert.deepEqual(entry.params.map((row) => row.role), ['prompt', 'negative', 'model']);
  assert.equal(entry.params[1].name, 'negative_prompt');
  assert.equal(entry.params[2].locked, true, '这次编辑是模型行的行级锁');
  assert.equal('expose' in entry.params[2], false, '模型行不写 expose');
});

test('没有 fields 也没有 params 的老配置只剩固定的提示词行，模型框回落到默认名', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  const opened = openModelPanel(harness);
  assert.deepEqual(commonRows(opened).map((row) => row.props['data-param-role']), ['prompt']);
  assert.equal(modelNameInput(opened).props.value, 'model', '模型方框永远在，参数名默认 model');
  assert.equal(modelNameInput(opened).props.placeholder, 'model');
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
    ['prompt', undefined], 'enum 行搬出「常规」表，剩下的内置行在前、用户行在后');
  const negative = enumBoxNamed(opened, 'negative_prompt');
  assert.ok(negative, 'enum 行在自己的方框里');
  assert.equal(enumCell(negative, 'name').props.value, 'negative_prompt');
  assert.equal(enumCell(negative, 'description').props.value, 'avoid');
  assert.equal(enumCell(negative, 'expose').props['aria-pressed'], 'false');
  assert.deepEqual(enumOptions(negative).map((_row, at) => enumCell(negative, 'option.label', at).props.value),
    ['blurry', 'low quality'], '选项按落盘的顺序');
  assert.deepEqual(enumOptions(negative).map((_row, at) => enumCell(negative, 'option.default', at).props.checked),
    [true, false], '默认值命中哪一项就勾哪一项');
  const custom = commonRows(opened)[1];
  assert.equal(paramCell(custom, 'name').props.value, 'seed');
  assert.equal(paramCell(custom, 'expose').props['aria-pressed'], 'true');
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
    paramCell(commonRows(harness.renderRoot())[3], field).props.onChange({ target: { value: value } });
    return harness.renderRoot();
  };
  edit('name', 'seed');
  edit('type', 'number');
  edit('default', '42');
  opened = edit('description', 'Random seed');
  paramCell(commonRows(opened)[3], 'expose').props.onClick();
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
  // 模型框跟着「常规」的整块锁一起锁：它也是这四个逻辑字段之一。
  for (const control of findAll(modelBox(opened), (node) => ['input', 'button'].includes(node.type))) {
    assert.equal(control.props.disabled, true, '上锁后模型框里的控件也禁用');
  }

  lock.props.onClick(fakeEvent());
  opened = harness.renderRoot();
  assert.equal(paramLock(opened, 'prompt').props['aria-pressed'], 'false');
  for (const row of commonRows(opened)) {
    assert.notEqual(paramCell(row, 'name').props.disabled, true, '解锁后参数名可编辑');
  }
  assert.notEqual(modelNameInput(opened).props.disabled, true, '解锁后模型参数名可编辑');
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

test('方框标题旁的锁：tooltip 走即时气泡，不用原生 title', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  let opened = openModelPanel(harness);
  const boxes = [
    ['common', 'prompt'],
    ['model', 'model'],
    ['size', 'size'],
    ['quality', 'quality'],
    ['image', 'image']
  ];
  for (const [boxKey, lockKey] of boxes) {
    const box = paramBox(opened, boxKey);
    assert.ok(box, boxKey + ' 方框在');
    const lock = findAll(box.children[0], (node) => node.type === 'button'
      && node.props['data-lock-key'] === lockKey)[0];
    assert.ok(lock, boxKey + ' 的锁在标题行');
    assert.equal(lock.props.title, undefined, boxKey + ' 的锁不再用原生 title');
    assert.equal(typeof lock.props.onPointerEnter, 'function', boxKey + ' 的锁悬停立刻出气泡');
    assert.equal(lock.props['data-locked'], 'false', boxKey + ' 的 data-locked 仍在');
  }
  // 悬停其中一个锁：气泡里是「未上锁：会被一键配置覆盖」。
  const qualityLock = findAll(paramBox(opened, 'quality').children[0], (node) => node.type === 'button'
    && node.props['data-lock-key'] === 'quality')[0];
  qualityLock.props.ref.current = tipTarget();
  qualityLock.props.onPointerEnter();
  opened = harness.renderRoot();
  const tip = tipNodes(paramBox(opened, 'quality'))
    .find((node) => /bulk configure overwrites it/i.test(textOf(node).join('')));
  assert.ok(tip, '未上锁的锁气泡给出「会被一键配置覆盖」');
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
  // 表单里现在有两个问号（协议地址、鉴权方式）。假 React 的 hook 按组件类型共享，
  // 悬停会用同一份状态把两个都渲染出来 —— 这里按内容挑协议地址那一个（只有它含换行）。
  const tip = tipNodes(opened).find((node) => String(node.children[0]).includes('\n'));
  assert.ok(tip, '悬停立刻出现气泡');
  assert.equal(tip.props.style.position, 'fixed');
  assert.equal(tip.props.style.whiteSpace, 'pre-line', '气泡按 \\n 分行');
  assert.equal(tip.props.style.width, 'max-content', '宽度仍跟随内容');
  assert.equal(tip.props.style.maxWidth, 300, '多行地址的上限仍收在 300');
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

test('尺寸 / 参考图的说明改成即时气泡：悬停才显示，不占一行', async () => {
  const { harness } = await openEditor(CLOUD_CONFIG);
  let opened = openModelPanel(harness);
  const box = paramBox(opened, 'size');
  const modeSelect = findAll(box, (node) => node.type === 'select' && node.props['data-param-key'] === 'size')[0];
  assert.ok(modeSelect, '有编码方式下拉');
  assert.equal(modeSelect.props.title, undefined, '不再用有延迟的原生 title');
  assert.equal(typeof modeSelect.props.onPointerEnter, 'function', '悬停立刻展开说明');
  modeSelect.props.ref.current = tipTarget({ scrollWidth: 200, clientWidth: 100 });
  modeSelect.props.onPointerEnter();
  opened = harness.renderRoot();
  const modeTip = tipNodes(paramBox(opened, 'size'))
    .find((node) => /adapter decides/i.test(textOf(node).join('')));
  assert.ok(modeTip, '尺寸块的说明挂在编码方式上的即时气泡里');

  const nameInput = findAll(paramBox(opened, 'size'), (node) => node.type === 'input' && node.props['data-param-key'] === 'size')[0];
  assert.ok(nameInput, '有参数名输入');
  assert.equal(nameInput.props.title, undefined, '参数名的说明也不用原生 title');
  nameInput.props.ref.current = tipTarget({ scrollWidth: 200, clientWidth: 100 });
  nameInput.props.onPointerEnter();
  opened = harness.renderRoot();
  const nameTip = tipNodes(paramBox(opened, 'size'))
    .find((node) => /dotted paths/i.test(textOf(node).join('')));
  assert.ok(nameTip, '参数名的说明挂在输入框上的即时气泡里');
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
    // 手动上锁：预设来源没有模型选项了，锁态只能这么构造（见 lockKeysFor）。
    lockKeysFor(config, ['size']);
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

  const details = openModelSection(opened);
  assert.equal(details.props.style.gridColumn, '1 / -1', '「输入设置」整个折叠区横跨两列');
  assert.equal(details.props.style.width, '100%');
  const body = findAll(details, (node) => hasClass(node, 'customizedBody'))[0];
  assert.equal(body.props.style.gridTemplateColumns, 'minmax(0, 1fr)', '框体是单列：每个方框都占满');
});

/** 「输入设置 / 输出设置」两块折叠区：按 data-* 标记找，不按文案。 */
const settingsSection = (tree, marker) => findAll(tree, (node) => node.type === 'details'
  && node.props && node.props[marker] !== undefined)[0] || null;
const settingsRow = (section) => findAll(section, (node) => node.type === 'summary')[0] || null;

test('输入设置与输出设置是同一行结构：标题在左、操作区在右，两行逐字段对齐', async () => {
  // 自定义端点这一档同时有两样参照物：两块折叠区都在，模型目录里也有「获取可用模型」。
  const { harness } = await openEditor(CUSTOM_RELAY_CONFIG);
  const opened = openModelPanel(harness);
  const input = settingsSection(opened, 'data-mo-image-input-settings');
  const output = settingsSection(opened, 'data-mo-image-output-settings');
  assert.ok(input, '「输入设置」折叠区在');
  assert.ok(output, '「输出设置」折叠区在');
  const rows = [settingsRow(input), settingsRow(output)];
  assert.ok(rows[0] && rows[1], '两行都在');

  // ① 同一个容器（类名相同 = 同一份内边距），两格布局：标题左、操作区右。
  assert.equal(rows[0].props.className, rows[1].props.className, '两行用同一个容器类');
  for (const row of rows) {
    assert.equal(row.props.style.display, 'flex', '显式 flex：不靠宿主样式');
    assert.equal(row.props.style.justifyContent, 'space-between', '只有一条左基线、一条右基线');
    assert.equal(row.props.style.alignItems, 'center', '锁图标与按钮同一条垂直中线');
    assert.equal(row.props.style.width, '100%');
    assert.equal(row.children.length, 2, '标题 + 操作区，别的不放（多一个按钮就会撑高、挪基线）');
  }

  // ② 左格、右格各自同一份样式：左边缘与右边缘因此是同一条线。
  assert.deepEqual(plainValue(rows[0].children[0].props.style), plainValue(rows[1].children[0].props.style),
    '标题格同一份样式');
  assert.equal(rows[0].children[1].props.className, rows[1].children[1].props.className, '操作区同一个盒子');
  assert.deepEqual(plainValue(rows[0].children[1].props.style), plainValue(rows[1].children[1].props.style),
    '操作区同一份样式');
  assert.equal(rows[1].children[1].props.style.display, 'flex');
  assert.equal(rows[1].children[1].props.style.alignItems, 'center', '操作区内部也居中');

  // ③ 输入行右边两个控件：左「一键配置」（小字链接，和「获取可用模型」同款）、右整块锁。
  const inputButtons = findAll(rows[0], (node) => node.type === 'button');
  assert.equal(inputButtons.length, 2, '输入行是「一键配置 + 锁」两个控件');
  const configureOne = inputButtons[0];
  assert.equal(textOf(configureOne).join(''), 'Configure', '先是一键配置');
  const fetchModelsButton = findButton(opened, (node) => /Fetch available models/i.test(textOf(node).join('')));
  assert.ok(fetchModelsButton, '模型目录里的「获取可用模型」是同一套样式的参照');
  assert.equal(configureOne.props.className, fetchModelsButton.props.className, '同一个组件 + 同一个类名');
  assert.ok(hasClass(configureOne, 'linkButton'), '就是 linkButton，不是 secondaryButton');
  // 整块锁紧跟其后，和「输出设置」右端那把同构（同一个图标按钮类）。
  const masterLock = inputButtons[1];
  assert.equal(masterLock.props['data-mo-image-params-lock'], '', '整块锁在第二位');
  assert.equal(masterLock.props.className, rows[1].children[1].children[0].props.className,
    '与输出行的锁同一个类');
  assert.equal(findAll(rows[0], (node) => node.type === 'button' && /Unlock all|Lock all/.test(textOf(node).join(''))).length,
    0, '解锁 / 上锁不再是一颗写字的按钮');
  // 面板上只此一处一键配置（单模型那颗）：没有第二份散落的按钮。
  assert.equal(findAll(opened, (node) => node.type === 'button'
    && textOf(node).join('') === 'Configure').length, 1);

  // ④ 输出行右边还是一个锁图标，且不带按钮内边距（右边缘才和按钮对齐）。
  const outputButtons = findAll(rows[1], (node) => node.type === 'button');
  assert.equal(outputButtons.length, 1, '输出行只有一把锁');
  assert.equal(outputButtons[0].props['data-lock-key'], 'operations');
  assert.equal(outputButtons[0].props.style.padding, 0, '锁图标没有按钮内边距');

  // ⑤ 点「一键配置」照旧只配这一个模型、不开合折叠区。
  const calls = { prevented: 0, stopped: 0 };
  configureOne.props.onClick({
    preventDefault() { calls.prevented += 1; },
    stopPropagation() { calls.stopped += 1; }
  });
  assert.deepEqual(calls, { prevented: 1, stopped: 1 });
  assert.equal(harness.fetchCalls.filter((call) => call.url.includes('/detect-model-rule')).length, 1,
    '一键配置照旧发起请求');
});

test('「输入设置」展开后直接是参数表：说明与「全部解锁」那一行已经去掉', async () => {
  const { harness } = await openEditor(LOCKED_RELAY_CONFIG);
  const opened = openModelPanel(harness);
  const input = settingsSection(opened, 'data-mo-image-input-settings');
  const body = findAll(input, (node) => hasClass(node, 'customizedBody'))[0];
  assert.ok(body, '「输入设置」的内容区在');
  // 第一块就是参数表：没有「说明 + 全部解锁」那一条工具条了。
  const firstBox = paramBox(body, 'common');
  assert.ok(firstBox, '参数表还在');
  assert.match(textOf(body.children[0]).join(' '), /General/, '展开后第一块就是「常规」方框');
  assert.equal(findAll(opened, (node) => node.props && node.props['data-mo-image-unlock-row']).length, 0,
    '整条工具条都不在了');
  assert.equal(findAll(opened, (node) => node.type === 'button' && /Unlock all/.test(textOf(node).join(''))).length, 0,
    '「全部解锁」这颗按钮也没了');
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
  // 手动上锁：预设来源没有模型选项了，锁态只能这么构造（见 lockKeysFor）。
  lockKeysFor(config, ['image']);
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
  const hasBulk = (tree) => Boolean(findButton(tree, (node) => /Configure every model/i.test(textOf(node).join(''))));
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
  // 方框顺序：常规 → 模型 → 尺寸 → 质量 → 参考图（模型是一个参数，紧跟参数表）。
  const body = panelBody(opened);
  assert.ok(body, '模型选项面板的框体在');
  const order = findAll(body, (node) => node.props && node.props['data-param-box']).map((node) => node.props['data-param-box']);
  assert.deepEqual(order, ['common', 'model', 'size', 'quality', 'image']);
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
  assert.equal(textOf(qualityHead(panel)).join(''), 'Level nameValueDefaultActions', '四列表头：挡位名 / 值 / 是否默认 / 操作');
  // 最后一列「操作」和参数表一致，居中。
  const qualityHeadCells = qualityHead(panel).children;
  assert.equal(textOf(qualityHeadCells[qualityHeadCells.length - 1]).join(''), 'Actions', '最后一列是「操作」');
  for (const cell of qualityHeadCells) assert.equal(cell.props.style.textAlign, 'center', '表头文字居中');
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
  // 手动上锁：预设来源没有模型选项了，锁态只能这么构造（见 lockKeysFor）。
  lockKeysFor(config, ['quality']);
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

/* ───────────── workflow 类适配器（ComfyUI / A1111）：输入设置折叠区 ───────────── */

/**
 * 预设来源的两条本地部署：presetId 在，但参数归部署端——输入键默认不锁、返回格式照锁
 * （见 lockDefaultsFor）。拿它们当夹具，「默认未上锁」才不是「碰巧没有 presetId」。
 */
const COMFY_PRESET_CONFIG = {
  providers: [{ ...CONFIG.providers[0], presetId: 'comfyui' }],
  active: CONFIG.active,
  defaults: {}
};
const A1111_PRESET_CONFIG = {
  providers: [{ ...A1111_CONFIG.providers[0], presetId: 'a1111' }],
  active: A1111_CONFIG.active,
  defaults: {}
};

/** 展开模型选项后，某个作用域里按锁键找的那个锁按钮。 */
const lockWithKey = (tree, key) => findAll(tree, (node) => node.type === 'button'
  && node.props['data-lock-key'] === key)[0] || null;

test('ComfyUI / A1111 的输入内容也收进「输入设置」：标题行与其它协议同一份结构，右端是锁', async () => {
  const cases = [
    { label: 'ComfyUI', config: COMFY_PRESET_CONFIG, workflow: true },
    { label: 'A1111', config: A1111_PRESET_CONFIG, workflow: false }
  ];
  for (const item of cases) {
    const { harness, tree } = await openEditor(item.config);
    optionsToggle(tree).props.onClick(fakeEvent());
    const opened = harness.renderRoot();
    const input = settingsSection(opened, 'data-mo-image-input-settings');
    assert.ok(input, item.label + '：输入设置折叠区在');
    // 和另一块一样默认收起：不写受控 open，浏览器默认就是收起。
    assert.equal(input.props.open, undefined, item.label + '：输入设置默认收起');

    // 标题行就是 settingsSummary 产出的那一行（那个标记只有它会写）：两格、同一套布局。
    const row = settingsRow(input);
    assert.equal(row.props['data-mo-image-settings-row'], '', item.label + '：标题行走 settingsSummary');
    assert.ok(row.props.className, item.label + '：标题行有容器类（内边距归宿主）');
    assert.equal(row.props.style.display, 'flex');
    assert.equal(row.props.style.justifyContent, 'space-between');
    assert.equal(row.props.style.alignItems, 'center');
    assert.equal(row.props.style.width, '100%');
    assert.equal(row.children.length, 2, item.label + '：左边标题 + 右边操作区');
    assert.equal(textOf(row.children[0]).join(''), 'Input settings', item.label + '：标题在左');
    assert.deepEqual(plainValue(row.children[0].props.style), {
      minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }, item.label + '：标题格截断，长文案不挤操作区');
    assert.ok(hasClass(row.children[1], 'rowActions'), item.label + '：操作区就是 rowActions 盒子');
    assert.deepEqual(plainValue(row.children[1].props.style),
      { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' },
      item.label + '：操作区同一份样式');

    // 右端只有一把锁（默认未上），没有「自动检测」：workflow 参数不来自规则表。
    const actions = findAll(row.children[1], (node) => node.type === 'button');
    assert.equal(actions.length, 1, item.label + '：右端只放一个控件');
    assert.equal(actions[0].props['data-lock-key'], 'prompt', item.label + '：锁复用「常规」参数表的键');
    assert.equal(actions[0].props['aria-pressed'], 'false', item.label + '：默认未上锁');
    assert.equal(textOf(row.children[1]).join(''), '', item.label + '：右端是图标，没有按钮文案');
    assert.doesNotMatch(textOf(input).join(' '), /Auto-detect/, item.label + '：输入设置里没有自动检测');

    // 输入内容全在 details 里（不留在外面平铺）。
    assert.ok(findAll(input, (node) => node.props && node.props['data-param-box'] === 'common')[0],
      item.label + '：常规参数表在 details 里');
    assert.equal(findAll(input, (node) => node.props && node.props['data-param-box'] === 'size').length, 0,
      item.label + '：workflow 面板没有尺寸方框');
    const textareas = findAll(input, (node) => node.type === 'textarea');
    if (item.workflow) {
      assert.equal(textareas.length, 1, 'ComfyUI：工作流编辑器在 details 里');
      assert.notEqual(textareas[0].props.disabled, true, 'ComfyUI：工作流编辑器仍可编辑');
      // 顺序：工作流编辑器在前、解析出的参数表在后。
      const inside = findAll(input, () => true);
      const table = findAll(input, (node) => node.props && node.props['data-param-table'] === 'common')[0];
      assert.ok(inside.indexOf(textareas[0]) < inside.indexOf(table), 'ComfyUI：编辑器在前、参数表在后');
    } else {
      assert.equal(textareas.length, 0, 'A1111：没有工作流编辑器');
      // A1111 的 sdapi 参数是预置行，也在 details 里。
      const names = findAll(input, (node) => node.props && node.props['data-param-field'] === 'name');
      assert.equal(names.length, 6, 'A1111：六行默认参数在 details 里');
      assert.equal(names[0].props.value, 'steps');
      assert.match(textOf(input).join(' '), /WebUI/, 'A1111：参数行说明也在 details 里');
    }
  }
});

test('输入设置与输出设置是 .modelRow 同一层的兄弟节点：同一份样式，中间不再夹容器', async () => {
  // 回归：输入设置外面曾多套一层 div.modelAdvanced（带 2px 4px 内边距），输出设置却是直接挂在
  // .modelRow 上的 details——两边缩进差 4px，右端的控件自然一个偏左、一个偏右。
  // 现在两块都是 .modelRow 的直接子项，内联样式相同、从右端控件到折叠区那一串祖先逐层同构。
  const cases = [
    // 自定义端点：两块折叠区都在（这个夹具里只有自定义协议会派生返回格式面板）。
    { label: '自定义端点', config: CUSTOM_RELAY_CONFIG }
  ];
  for (const item of cases) {
    const { harness } = await openEditor(item.config);
    const opened = openModelPanel(harness);
    const input = settingsSection(opened, 'data-mo-image-input-settings');
    const output = settingsSection(opened, 'data-mo-image-output-settings');
    assert.ok(input && output, item.label + '：两块折叠区都在');

    // 从根到目标的祖先链（命中返回 [] 之外的路径；用来取父节点与逐层结构）。
    const pathTo = (target, node = opened, trail = []) => {
      if (node === null || node === undefined) return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = pathTo(target, child, trail);
          if (found) return found;
        }
        return null;
      }
      if (typeof node !== 'object') return null;
      if (node === target) return trail;
      for (const child of node.children || []) {
        const found = pathTo(target, child, trail.concat([node]));
        if (found) return found;
      }
      return null;
    };
    const inPath = pathTo(input);
    const outPath = pathTo(output);
    assert.ok(inPath && outPath, item.label + '：两块折叠区都能定位');
    const inParent = inPath[inPath.length - 1];
    const outParent = outPath[outPath.length - 1];
    assert.equal(inParent, outParent, item.label + '：两块折叠区挂在同一个父节点下');
    assert.ok(hasClass(inParent, 'modelRow'), item.label + '：父节点就是 .modelRow');
    // 中间没有多余的一层包装：两块 details 的父节点相同 = 同一层兄弟。
    assert.equal(findAll(opened, (node) => hasClass(node, 'modelAdvanced')).length, 0,
      item.label + '：div.modelAdvanced 那层包装已经删掉');

    // 样式链对等：同一个 grid 落位、同一份宽度 → 左右边缘重合。
    assert.deepEqual(plainValue(input.props.style), plainValue(output.props.style),
      item.label + '：两块折叠区同一份内联样式（grid-column / width / min-width）');
    assert.equal(input.props.style.gridColumn, '1 / -1', item.label + '：输入设置横跨整行');
    assert.equal(input.props.style.width, '100%', item.label + '：不靠父容器的内边距凑宽度');
    assert.equal(input.props.style.minWidth, 0);

    // 锁图标 x 相同 → 从锁往上到折叠区那一串祖先逐层同构（层数、类名、内联样式都一样）。
    const firstButtonOf = (section) => findAll(section, (node) => node.type === 'button')[0] || null;
    const inButton = firstButtonOf(settingsRow(input));
    const outButton = firstButtonOf(settingsRow(output));
    assert.ok(inButton && outButton, item.label + '：两行右端都有控件');
    assert.ok(pathTo(inButton).includes(input), item.label + '：输入行的控件在输入设置里');
    assert.ok(pathTo(outButton).includes(output), item.label + '：输出行的控件在输出设置里');
    const chainOf = (section, path) => path.slice(path.indexOf(section)).reverse();
    const inChain = chainOf(input, pathTo(inButton));
    const outChain = chainOf(output, pathTo(outButton));
    assert.equal(inChain.length, outChain.length, item.label + '：锁到折叠区的祖先层数相同');
    const shapeOf = (chain) => chain.map((node) => ({
      className: String(node.props.className || ''),
      style: plainValue(node.props.style || {})
    }));
    assert.deepEqual(shapeOf(inChain), shapeOf(outChain),
      item.label + '：从锁到折叠区逐层同构（右端基线因此是同一条线）');
  }
});

test('workflow 适配器的输入设置锁默认未上：预设来源也能直接改，点锁才锁住参数表', async () => {
  const { harness } = await openEditor(A1111_PRESET_CONFIG);
  let opened = openModelPanel(harness);
  let input = settingsSection(opened, 'data-mo-image-input-settings');
  assert.equal(lockWithKey(settingsRow(input), 'prompt').props['aria-pressed'], 'false',
    '标题行的锁默认未上');
  assert.equal(lockWithKey(commonBox(input), 'prompt').props['aria-pressed'], 'false',
    '「常规」方框的锁是同一个键，也是未上');
  const nameInput = () => findAll(input, (node) => node.props
    && node.props['data-param-field'] === 'name')[0];
  assert.notEqual(nameInput().props.disabled, true, '没上锁：参数表直接能改');

  // 点标题行的锁：和点「常规」方框的锁是同一个状态（同一个键、同一套落盘）。
  lockWithKey(settingsRow(input), 'prompt').props.onClick({ preventDefault() {}, stopPropagation() {} });
  opened = harness.renderRoot();
  input = settingsSection(opened, 'data-mo-image-input-settings');
  assert.equal(lockWithKey(settingsRow(input), 'prompt').props['aria-pressed'], 'true', '点了就锁上');
  assert.equal(nameInput().props.disabled, true, '上锁后参数表禁用');
});

test('ComfyUI 解析出的参数行也收在「输入设置」里，工作流编辑器照旧可编辑并能保存', async () => {
  const analysis = {
    ok: true,
    format: 'api',
    mapping: { prompt: { node: '18:17', input: 'value' } },
    candidates: { prompt: [{ node: '18:17', input: 'value', classType: 'PrimitiveStringMultiline' }] },
    params: [{ name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25 }],
    warnings: []
  };
  const { harness, tree } = await openEditor(CONFIG, { analyze: analysis });
  optionsToggle(tree).props.onClick(fakeEvent());
  let opened = harness.renderRoot();
  let input = settingsSection(opened, 'data-mo-image-input-settings');
  const textarea = findAll(input, (node) => node.type === 'textarea')[0];
  assert.ok(textarea, '工作流编辑器在输入设置里');
  textarea.props.onChange({ target: { value: '{"1":{"class_type":"KSampler"}}' } });
  opened = harness.renderRoot();
  const parse = findAll(settingsSection(opened, 'data-mo-image-input-settings'), (node) => node.type === 'button'
    && /Parse workflow/i.test(textOf(node).join('')))[0];
  assert.ok(parse, '「解析工作流」也在输入设置里');
  await parse.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  opened = harness.renderRoot();
  input = settingsSection(opened, 'data-mo-image-input-settings');
  const parsed = findAll(input, (node) => node.props && node.props['data-param-grid'] === 'params:row');
  assert.equal(parsed.length, 1, '解析出的参数行收在输入设置里');
  assert.equal(findAll(input, (node) => node.props && node.props['data-param-field'] === 'name')[0].props.value,
    'steps');
  const editor = findAll(input, (node) => node.type === 'textarea')[0];
  assert.ok(editor, '工作流编辑器仍在');
  assert.notEqual(editor.props.disabled, true, '锁只管参数表，工作流编辑器仍可编辑');

  // 保存：工作流与解析结果都照旧落盘。
  const save = findButton(opened, (node) => /save/i.test(textOf(node).join('')));
  await save.props.onClick();
  const posted = harness.fetchCalls.filter((call) => call.method === 'POST'
    && call.url.includes('/api/mo-image/config'));
  const provider = JSON.parse(posted[posted.length - 1].body).config.providers.find((item) => item.id === 'p1');
  const entry = provider.modelOptions['flux.safetensors'];
  assert.equal(entry.workflow, '{"1":{"class_type":"KSampler"}}', '工作流照旧保存');
  assert.equal(entry.params[0].name, 'steps', '解析出的参数照旧保存');
});


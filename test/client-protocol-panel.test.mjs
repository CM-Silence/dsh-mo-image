import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const T = {
  'form.route.generate': '文生图',
  'form.route.edit': '图生图',
  'form.route.models': '获取模型列表',
  'form.routeUnsupported': '不支持',
  'form.protocolRoutes': '协议地址',
  'form.routeHint': '地址由上面的服务地址拼出',
  'form.customProtocol': '自定义（自己填地址）',
  'form.protocolOption.edit': '编辑端点',
  'form.protocolOption.edit.edits': '单独的 /images/edits',
  'form.protocolOption.edit.same': '同一个 /images/generations',
  'form.protocolOption.edit.none': '不支持图生图',
  'form.protocolOption.editHint': '编辑请求发到哪个地址',
  'form.protocolOption.auth': '鉴权方式',
  'form.protocolOption.auth.bearer': 'Authorization: Bearer',
  'form.protocolOption.auth.api-key': 'api-key 头',
  'form.protocolOption.authHint': '鉴权头形态'
};
const t = (key) => T[key] || key;

/** 协议清单的片段：带选项的那条（openai-images）与不带选项的那条（comfyui）各一。 */
const ADAPTERS = [
  { id: 'comfyui', label: 'ComfyUI', local: true, supportsModels: true, routes: { generate: '/prompt', edit: '/prompt', models: '/object_info' } },
  {
    id: 'openai-images',
    label: 'OpenAI Images 兼容',
    local: false,
    supportsModels: true,
    routes: { generate: '/images/generations', edit: '/images/edits', models: '/models' },
    options: [
      {
        name: 'edit',
        values: ['edits', 'same', 'none'],
        default: 'edits',
        routes: {
          edits: { generate: '/images/generations', edit: '/images/edits', models: '/models' },
          same: { generate: '/images/generations', edit: '/images/generations', models: '/models' },
          none: { generate: '/images/generations', edit: '', models: '/models' }
        }
      },
      { name: 'auth', values: ['bearer', 'api-key'], default: 'bearer' }
    ]
  }
];

// 组件内部的 hook 顺序会随实现变化，所以按「初始值是 'catalog' 的那个 state」定位模式开关。
const CATALOG = 'catalog';

function loadClient({ customMode = false } = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  let hooks = [];
  let hookIndex = 0;

  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) {
        const value = typeof initial === 'function' ? initial() : initial;
        hooks[index] = (customMode && value === CATALOG) ? 'custom' : value;
      }
      return [hooks[index], () => {}];
    },
    useEffect(fn) { hooks[hookIndex++] = fn; },
    useLayoutEffect(fn) { hooks[hookIndex++] = fn; },
    useMemo(fn) { hookIndex++; return fn(); },
    useCallback(fn) { hookIndex++; return fn; },
    useRef(value) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = { current: value };
      return hooks[index];
    }
  };
  const window = {
    __ModuleLoader__: { load(definition) { loaded = definition; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
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
    window, document, React, console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal,
    Response: globalThis.Response,
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      config: { providers: [], active: {} },
      adapters: ADAPTERS,
      providerPresets: [],
      localPresets: []
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
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
  api.apply({
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    slots: { inject(_key, callback) { callback(); }, register() { return () => {}; } },
    locale: null
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

  return {
    React, render,
    h: React.createElement,
    setCatalog() { api.__test.applyCatalog({ adapters: ADAPTERS, providerPresets: [], localPresets: [], capabilities: [] }); },
    form() { return api.__test.ImageProviderForm; }
  };
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const item of node) collect(item, predicate, out); return out; }
  if (typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) collect(child, predicate, out);
  return out;
}

function text(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) text(item, out); return out; }
  for (const child of node.children || []) text(child, out);
  return out;
}

function renderForm(client, provider, isNew = false) {
  const Form = client.form();
  assert.ok(Form, 'client.__test.ImageProviderForm 没暴露');
  return client.render(client.h(Form, {
    provider: provider, isNew: isNew, onSave() {}, onClose() {}, t: t
  }));
}

/** 协议 label 右侧的问号：三条地址在它的即时气泡里（aria-description 也给出全文）。 */
const routeHelpOf = (node) => collect(node, (item) => item.props && item.props['data-route-help'] !== undefined)[0];

test('三条地址收进协议 label 右侧的问号：悬停立刻看，一行一条，不再占版面', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Comfy', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', models: [], names: {}
  });
  const help = routeHelpOf(node);
  assert.ok(help, '协议 label 右侧要有问号');
  assert.equal(help.props['aria-label'], '协议地址', '问号要有可读的名字');
  // 原生 title 有约 1 秒延迟：这里不再用它，改成悬停立刻出现的自绘气泡。
  assert.equal(help.props.title, undefined, '不能用有延迟的原生 title');
  assert.equal(typeof help.props.onPointerEnter, 'function', '悬停立刻展开');
  assert.equal(help.props['aria-description'],
    '文生图：http://127.0.0.1:8188/prompt\n'
    + '图生图：http://127.0.0.1:8188/prompt\n'
    + '获取模型列表：http://127.0.0.1:8188/object_info');
  // 地址不再作为三行正文渲染。
  const body = text(node).join(' ');
  assert.doesNotMatch(body, /文生图：/);
  assert.doesNotMatch(body, /获取模型列表：/);
});

test('问号里不支持的项写成占位符，而不是整行消失', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'LocalAI', baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'openai-images',
    protocolOptions: { edit: 'none' }, models: [], names: {}
  });
  const help = routeHelpOf(node);
  assert.ok(help);
  assert.match(help.props['aria-description'], /文生图：http:\/\/127\.0\.0\.1:8080\/v1\/images\/generations/);
  assert.match(help.props['aria-description'], /图生图：不支持/);
  assert.match(help.props['aria-description'], /获取模型列表：http:\/\/127\.0\.0\.1:8080\/v1\/models/);
});

test('协议选项改了地址：问号跟着当前取值走', () => {
  const client = loadClient();
  client.setCatalog();
  const render = (protocolOptions) => routeHelpOf(renderForm(client, {
    id: 'p1', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'openai-images',
    protocolOptions: protocolOptions, models: [], names: {}
  })).props['aria-description'];
  // 默认 edits → /images/edits
  assert.match(render({}), /图生图：https:\/\/api\.siliconflow\.cn\/v1\/images\/edits/);
  // same → 同一个 generations
  assert.match(render({ edit: 'same' }), /图生图：https:\/\/api\.siliconflow\.cn\/v1\/images\/generations/);
  assert.match(render({ edit: 'none' }), /图生图：不支持/);
});

test('协议有选项时，协议下拉下面给出选择项（取值与默认值来自宿主清单）', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  }, false);
  const selects = collect(node, (item) => item.type === 'select' && item.props['data-mo-image-protocol-option']);
  assert.deepEqual(
    selects.map((item) => item.props['data-mo-image-protocol-option']),
    ['edit', 'auth'],
    '两个协议级选项都要有下拉'
  );
  const edit = selects[0];
  assert.equal(edit.props.value, 'edits', '没选过就显示默认值');
  const editOptions = collect(edit, (item) => item.type === 'option');
  assert.deepEqual(editOptions.map((option) => option.props.value), ['edits', 'same', 'none']);
  assert.deepEqual(editOptions.map((option) => text(option).join('')), ['单独的 /images/edits', '同一个 /images/generations', '不支持图生图']);
  assert.equal(selects[1].props.value, 'bearer');

  // 选过的值要回显。
  const picked = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    protocolOptions: { edit: 'same', auth: 'api-key' }, models: [], names: {}
  }, false);
  const pickedSelects = collect(picked, (item) => item.type === 'select' && item.props['data-mo-image-protocol-option']);
  assert.deepEqual(pickedSelects.map((item) => item.props.value), ['same', 'api-key']);
});

test('没有声明选项的协议不渲染选项下拉', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Comfy', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', models: [], names: {}
  });
  const selects = collect(node, (item) => item.type === 'select' && item.props['data-mo-image-protocol-option']);
  assert.deepEqual(selects, []);
});

test('选中自定义时给出三个输入框', () => {
  const client = loadClient({ customMode: true });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: '网关', baseUrl: 'https://g.example', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/images/generations', edit: '', models: '' },
    models: [], names: {}
  }, true);
  const inputs = collect(node, (item) => item.type === 'input');
  const byName = (name) => inputs.find((item) => item.props.name === name);
  assert.ok(byName('route-generate'), '自定义模式应渲染文生图输入框');
  assert.equal(byName('route-generate').props.value, 'https://g.example/v1/images/generations');
  assert.equal(byName('route-edit').props.value, '');
  assert.equal(byName('route-models').props.value, '');
  // 自定义协议的地址是自己填的：问号里显示的就是填了什么，空着的说「不支持」。
  const help = routeHelpOf(node);
  assert.ok(help);
  assert.match(help.props['aria-description'], /文生图：https:\/\/g\.example\/v1\/images\/generations/);
  assert.match(help.props['aria-description'], /图生图：不支持/);
  assert.match(help.props['aria-description'], /获取模型列表：不支持/);
});

function fetchButton(node) {
  return collect(node, (item) => item.type === 'button' && text(item).join(' ').includes('form.fetchModels')).pop();
}

test('自定义协议填了模型列表地址才给出拉取按钮', () => {
  const withUrl = loadClient({ customMode: true });
  withUrl.setCatalog();
  const filled = renderForm(withUrl, {
    id: 'p1', name: '网关', baseUrl: '', adapter: 'custom',
    customEndpoints: {
      generate: 'https://g.example/v1/images/generations',
      edit: '',
      models: 'https://g.example/v1/models'
    },
    models: [], names: {}
  }, true);
  const button = fetchButton(filled);
  assert.ok(button, '填了模型列表地址应给出拉取按钮');
  assert.notEqual(button.props.disabled, true);

  const withoutUrl = loadClient({ customMode: true });
  withoutUrl.setCatalog();
  const empty = renderForm(withoutUrl, {
    id: 'p1', name: '网关', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/images/generations', edit: '', models: '' },
    models: [], names: {}
  }, true);
  assert.equal(fetchButton(empty), undefined, '没填模型列表地址不该给出拉取按钮');
});

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
  'form.protocolAuto': '自动',
  'form.protocolMore': '更多协议…',
  'protocol.comfyui': 'ComfyUI',
  'protocol.openai-images': 'OpenAI Images',
  'form.customProtocol': '自定义',
  'form.protocolOption.edit': '图生图端点',
  'form.protocolOption.edit.edits': '单独的 /images/edits',
  'form.protocolOption.edit.same': '同一个 /images/generations',
  'form.protocolOption.edit.none': '不支持图生图',
  'form.protocolOption.editHint': '编辑请求发到哪个地址',
  'form.auth': '鉴权方式',
  'form.auth.bearer': 'Authorization: Bearer <key>',
  'form.auth.api-key': 'api-key <key>',
  'form.auth.x-key': 'x-key <key>',
  'form.auth.fal-key': 'Authorization: Key <key>',
  'form.auth.custom': '自定义请求头',
  'form.authHint': '鉴权头形态',
  'form.authHeader': '请求头名称',
  'form.authPrefix': '前缀',
  'form.advanced': '自定义设置',
  'form.protocolSettings': '协议设置',
  'form.authFollow': '跟随协议',
  'form.modeCatalog': '第三方模型提供商',
  'form.modeCustom': '自定义模型 API',
  'form.modeLocal': '本地模型',
  'form.outputPreset.auto': '跟随协议',
  'form.outputPreset.customLegacy': '自定义（来自旧配置）',
  'form.outputPreset.customLegacyHint': '当前值是以前手写的返回配置，原样保留；上面的预设选一个即可覆盖它。'
};
const t = (key) => T[key] || key;

/** 客户端在主清单缺 authModes 时的兜底顺序。 */
const AUTH_MODES = ['bearer', 'api-key', 'x-key', 'fal-key', 'custom', 'none', 'basic', 'query'];

/** 协议清单的片段：带选项的那条（openai-images）与不带选项的那条（comfyui）各一。label 是 i18n key。 */
const ADAPTERS = [
  { id: 'comfyui', label: 'protocol.comfyui', local: true, supportsModels: true, routes: { generate: '/prompt', edit: '/prompt', models: '/object_info' } },
  {
    id: 'openai-images',
    label: 'protocol.openai-images',
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
      }
    ]
  }
];

// 组件内部的 hook 顺序会随实现变化，所以按「初始值是 'catalog' 的那个 state」定位模式开关。
const CATALOG = 'catalog';

/** 目录里的一份云端预设：新增表单从它建，预设置信（协议 / 鉴权 / 返回格式）全都自带。 */
const PROVIDER_PRESET_FIXTURE = [{
  id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
  protocol: 'openai-images', models: ['gpt-image-1']
}];

/** 宿主下发的本地部署器清单（LOCAL_PRESETS 的完整 id 集，形状与真清单一致）。 */
const LOCAL_DEPLOYER_FIXTURE = [
  { id: 'sd-server', name: 'sd-server', baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'openai-images' },
  { id: 'a1111', name: 'A1111', baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111' },
  { id: 'comfyui', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui' },
  { id: 'swarmui', name: 'SwarmUI', baseUrl: 'http://127.0.0.1:7801', adapter: 'swarmui' },
  { id: 'localai', name: 'LocalAI', baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'openai-images' },
  { id: 'openai-gateway', name: '其他 OpenAI 兼容网关', baseUrl: 'http://127.0.0.1:3000/v1', adapter: 'openai-images' }
];

function loadClient({
  customMode = false,
  preserveFormState = false,
  providerPresets = [],
  localPresets = []
} = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let loaded = null;
  let hooks = [];
  let hookIndex = 0;
  const formHooks = [];

  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) {
        const value = typeof initial === 'function' ? initial() : initial;
        hooks[index] = (customMode && value === CATALOG) ? 'custom' : value;
      }
      const owner = hooks;
      return [owner[index], (update) => {
        if (preserveFormState) owner[index] = typeof update === 'function' ? update(owner[index]) : update;
      }];
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
      providerPresets: providerPresets,
      localPresets: localPresets
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
      hooks = preserveFormState && node.type === api.__test.ImageProviderForm ? formHooks : [];
      hookIndex = 0;
      return render(node.type(node.props || {}));
    }
    return { type: node.type, props: node.props || {}, children: (node.children || []).map(render) };
  }

  return {
    React, render,
    h: React.createElement,
    setCatalog() { api.__test.applyCatalog({
      adapters: ADAPTERS, providerPresets: providerPresets, localPresets: localPresets, capabilities: [],
      outputPresets: ['auto', 'openai', 'binary', 'task-json']
    }); },
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

/** 目标节点在渲染树里的父节点（用来验证两个控件是否同处一行 / 同一个 hover 容器）。 */
function parentOf(root, target, parent = null) {
  if (root === null || root === undefined) return null;
  if (Array.isArray(root)) {
    for (const item of root) {
      const hit = parentOf(item, target, parent);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof root !== 'object') return null;
  if (root === target) return parent;
  for (const child of root.children || []) {
    const hit = parentOf(child, target, root);
    if (hit) return hit;
  }
  return null;
}

/** 渲染树的先序遍历 —— 就是 DOM 顺序；拿它给几个控件排序。 */
function preorder(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const item of node) preorder(item, out); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children || []) preorder(child, out);
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

test('协议声明的选项只有图生图端点：取值与默认值来自宿主清单', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  }, false);
  const selects = collect(node, (item) => item.type === 'select' && item.props['data-mo-image-protocol-option']);
  assert.deepEqual(
    selects.map((item) => item.props['data-mo-image-protocol-option']),
    ['edit'],
    '鉴权已升成提供商字段，协议选项里只剩图生图端点'
  );
  const edit = selects[0];
  assert.equal(edit.props.value, 'edits', '没选过就显示默认值');
  const editOptions = collect(edit, (item) => item.type === 'option');
  assert.deepEqual(editOptions.map((option) => option.props.value), ['edits', 'same', 'none']);
  assert.deepEqual(editOptions.map((option) => text(option).join('')), ['/images/edits', '/images/generations', '不支持']);

  // 选过的值要回显。
  const picked = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    protocolOptions: { edit: 'same' }, models: [], names: {}
  }, false);
  const pickedSelects = collect(picked, (item) => item.type === 'select' && item.props['data-mo-image-protocol-option']);
  assert.deepEqual(pickedSelects.map((item) => item.props.value), ['same']);
});

test('「图生图端点」只显示路径：edits / same / none 对应三条路径或「不支持」', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  });
  const labelRow = collect(node, (item) => item.props && item.props['data-protocol-option-label'] === 'edit')[0];
  assert.ok(labelRow, '图生图端点 label 行在');
  assert.match(text(labelRow).join(''), /图生图端点/, '不再叫「编辑端点」');
  assert.doesNotMatch(text(labelRow).join(''), /编辑端点/);
  const edit = collect(node, (item) => item.type === 'select'
    && item.props['data-mo-image-protocol-option'] === 'edit')[0];
  assert.deepEqual(collect(edit, (item) => item.type === 'option').map((option) => text(option).join('')),
    ['/images/edits', '/images/generations', '不支持'], '下拉只显示值本身');
  // 原来那行「编辑请求发到哪个地址…」不再渲染。
  assert.doesNotMatch(text(node).join(' '), /编辑请求发到哪个地址/);
});

test('鉴权方式是提供商字段：换任何协议，下拉都仍然可用', () => {
  // 这条是这次改动的核心：鉴权不挂在协议下面，所以 comfyui / custom / 空串这些
  // 「没有协议级选项」的协议下也必须看得到它。
  for (const adapter of ['openai-images', 'comfyui', 'custom', '']) {
    const client = loadClient();
    client.setCatalog();
    const node = renderForm(client, {
      id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: adapter, models: [], names: {}
    });
    const select = collect(node, (item) => item.type === 'select'
      && item.props['data-mo-image-auth-mode'] !== undefined)[0];
    assert.ok(select, '协议 ' + (adapter || '(自动)') + ' 下鉴权下拉不该消失');
    assert.deepEqual(
      collect(select, (item) => item.type === 'option').map((option) => option.props.value),
      ['', ...AUTH_MODES],
      '「跟随协议」加上支持的鉴权模式都能选'
    );
    assert.equal(select.props.value, '', '没设过就显示「跟随协议」（不显式设置）');
  }
});

test('鉴权方式的取值回显 provider.auth，认不出的值回落到「跟随协议」', () => {
  const client = loadClient();
  client.setCatalog();
  for (const mode of AUTH_MODES) {
    const node = renderForm(client, {
      id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'comfyui',
      auth: { mode: mode }, models: [], names: {}
    });
    const select = collect(node, (item) => item.type === 'select'
      && item.props['data-mo-image-auth-mode'] !== undefined)[0];
    assert.equal(select.props.value, mode);
  }
  const bogus = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'comfyui',
    auth: { mode: 'bogus' }, models: [], names: {}
  });
  assert.equal(collect(bogus, (item) => item.type === 'select'
    && item.props['data-mo-image-auth-mode'] !== undefined)[0].props.value, '',
  '认不出的值 = 没设 = 跟随协议');
});

test('「跟随协议」不落 provider.auth；选了具体模式才有 auth 字段', async () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  };
  let saved = null;
  const render = () => client.render(client.h(client.form(), {
    provider: provider, isNew: false, onSave(next) { saved = next; }, onClose() {}, t: t
  }));
  let tree = render();
  const authSelect = () => collect(tree, (item) => item.type === 'select'
    && item.props['data-mo-image-auth-mode'] !== undefined)[0];
  const save = () => collect(tree, (item) => item.type === 'button'
    && text(item).join('').includes('form.save')).pop();

  // 默认项就是「跟随协议」，选项值 ''：不显式设置，用协议自己的默认鉴权。
  assert.equal(authSelect().props.value, '');
  const first = collect(authSelect(), (item) => item.type === 'option')[0];
  assert.equal(text(first).join(''), '跟随协议', '默认项文案是「跟随协议」');

  await save().props.onClick();
  assert.equal('auth' in saved, false, '跟随协议 = 配置里没有 auth 字段');

  // 选一个具体模式：下拉回显它，保存就带上。
  authSelect().props.onChange({ target: { value: 'api-key' } });
  tree = render();
  assert.equal(authSelect().props.value, 'api-key');
  await save().props.onClick();
  assert.deepEqual(Object.keys(saved.auth), ['mode'], '选了具体模式就落盘');
  assert.equal(saved.auth.mode, 'api-key');
});

test('选 custom 时多出头名与前缀两个输入框，值来自 provider.auth', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    auth: { mode: 'custom', header: 'X-API-Key', prefix: 'Token ' }, models: [], names: {}
  });
  const inputs = collect(node, (item) => item.type === 'input');
  const header = inputs.find((item) => item.props.name === 'auth-header');
  const prefix = inputs.find((item) => item.props.name === 'auth-prefix');
  assert.ok(header, 'custom 要给请求头名称输入框');
  assert.ok(prefix, 'custom 要给前缀输入框');
  assert.equal(header.props.value, 'X-API-Key');
  assert.equal(prefix.props.value, 'Token ');
  // 两个标签都渲染出来（文案键是拼出来的，测试里用兜底字典兜住）。
  const body = text(node).join(' ');
  assert.match(body, /请求头名称/);
  assert.match(body, /前缀/);

  // 非 custom 时不出现这两格（免得「选了 Bearer 还在填头名」）。
  for (const mode of ['bearer', 'api-key', 'x-key', 'fal-key']) {
    const plain = renderForm(client, {
      id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
      auth: { mode: mode }, models: [], names: {}
    });
    assert.equal(
      collect(plain, (item) => item.type === 'input' && String(item.props.name || '').startsWith('auth-')).length,
      0,
      mode + ' 下不该有 custom 的两个输入框'
    );
  }
});

test('「鉴权方式」label 右侧的问号收着说明，下面那行提示不再渲染', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  });
  const labelRow = collect(node, (item) => item.props && item.props['data-mo-image-auth-label-row'] !== undefined)[0];
  assert.ok(labelRow, '鉴权方式 label 行在');
  const help = collect(labelRow, (item) => item.props && item.props['data-mo-image-auth-help'] !== undefined)[0];
  assert.ok(help, '问号在 label 右侧');
  assert.equal(help.props.className?.includes('helpButton') || help.props.className === 'helpButton', true,
    '与协议问号同一套样式');
  assert.equal(help.props['aria-description'], '鉴权头形态');
  assert.equal(help.props.title, undefined, '不用有延迟的原生 title');
  assert.equal(typeof help.props.onPointerEnter, 'function', '悬停立刻展开');
  assert.doesNotMatch(text(node).join(' '), /鉴权头形态/, '说明只进气泡，不再占一行');
  assert.equal(text(help).join(''), '?');
});

/** 目标控件是不是收在这个折叠区里。 */
function insideOf(details, target) {
  return collect(details, (item) => item === target).length === 1;
}

/** 该控件有没有 <details> 祖先（= 被收进某个折叠区）。 */
function insideAnyDetails(node, target) {
  for (let parent = parentOf(node, target); parent; parent = parentOf(node, parent)) {
    if (parent.type === 'details') return true;
  }
  return false;
}

test('三个主字段常显：密钥 / 显示名称 / API 地址都不在任何折叠区里', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  });
  const key = collect(node, (n) => n.type === 'input' && n.props.type === 'password')[0];
  const name = collect(node, (n) => n.type === 'input' && n.props.value === 'Relay')[0];
  const url = collect(node, (n) => n.type === 'input' && n.props.value === 'https://g.example/v1')[0];
  for (const [label, control] of [['API 密钥', key], ['显示名称', name], ['API 地址', url]]) {
    assert.ok(control, label + ' 在');
    assert.equal(insideAnyDetails(node, control), false, label + ' 不能收进折叠区');
  }
  // 对照组：同样的断言能抓到被收起来的东西（协议就在协议设置里）。
  const protocol = collect(node, (n) => n.type === 'select' && n.props['data-mo-image-protocol'] !== undefined)[0];
  assert.equal(insideAnyDetails(node, protocol), true, '协议是收在折叠区里的');
});

test('协议设置：默认收起的折叠区，协议 / 鉴权 / 图生图端点 / 两个返回格式都在里面', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  };
  let node = renderForm(client, provider);
  const settings = detailsOf(node, '协议设置');
  assert.ok(settings, '协议设置折叠区在');
  assert.equal(settings.props.open, false, '默认收起：多数人打开面板只改密钥 / 地址 / 模型目录');

  // 五个控件：API 协议、鉴权方式、图生图端点、文生图返回格式、图生图返回格式。
  const controls = () => protocolPanelControls(node);
  assert.deepEqual(Object.keys(controls()),
    ['API 协议', '鉴权方式', '图生图端点', '文生图返回格式', '图生图返回格式']);
  for (const [label, control] of Object.entries(controls())) {
    assert.ok(control, label + ' 在');
    assert.ok(insideOf(settings, control), label + ' 收在协议设置里');
  }
  // 「识别协议」按钮跟在协议下拉同一行，也一并收进来。
  const detect = collect(node, (n) => n.props && n.props['data-mo-image-detect-protocol'] !== undefined)[0];
  assert.ok(detect, '识别协议按钮在');
  assert.ok(insideOf(settings, detect), '识别协议按钮也收在协议设置里');

  // 顺序按协议本身来：协议（含识别按钮）→ 鉴权 → 图生图端点 → 文生图返回格式 → 图生图返回格式。
  const order = preorder(settings);
  const at = (target) => order.indexOf(target);
  const { 'API 协议': protocol, '鉴权方式': auth, '图生图端点': edit } = controls();
  const { '文生图返回格式': generateFormat, '图生图返回格式': editFormat } = controls();
  assert.ok(at(protocol) < at(auth), '鉴权排在协议下面');
  assert.ok(at(auth) < at(edit), '图生图端点在鉴权之后');
  assert.ok(at(edit) < at(generateFormat), '返回格式读的就是上面这套协议，排在最后');
  assert.ok(at(generateFormat) < at(editFormat), '文生图返回格式在图生图返回格式之前');

  // 展开：open 是受控状态，点一下 summary 重渲染就是展开态，控件一个不少。
  settings.props.onToggle({ currentTarget: { open: true } });
  node = renderForm(client, provider);
  const opened = detailsOf(node, '协议设置');
  assert.equal(opened.props.open, true, '点开 summary 就展开');
  for (const [label, control] of Object.entries(controls())) {
    assert.ok(insideOf(opened, control), label + ' 展开后还在原地');
  }
});

/** 协议设置里的五个控件，按他们出现的顺序命名；缺就是 undefined。 */
function protocolPanelControls(node) {
  const pick = (predicate) => collect(node, (n) => n.type === 'select' && predicate(n.props))[0];
  return {
    'API 协议': pick((props) => props['data-mo-image-protocol'] !== undefined),
    '鉴权方式': pick((props) => props['data-mo-image-auth-mode'] !== undefined),
    '图生图端点': pick((props) => props['data-mo-image-protocol-option'] === 'edit'),
    '文生图返回格式': pick((props) => props['data-mo-image-output-preset'] === 'generate'),
    '图生图返回格式': pick((props) => props['data-mo-image-output-preset'] === 'edit')
  };
}

test('预设来源的提供商不渲染「协议设置」：协议 / 鉴权 / 图生图端点 / 返回格式一个都不出现', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: [], names: {}
  });
  // 判据就是来源（provider.presetId）：预设里协议 / 鉴权 / 返回格式都写好了，
  // 用户零配置就该能用，所以整块不渲染——不是藏起来留个空壳。
  assert.equal(detailsOf(node, '协议设置'), undefined, '预设来源不该有「协议设置」折叠区');
  for (const [label, control] of Object.entries(protocolPanelControls(node))) {
    assert.equal(control, undefined, label + ' 不该出现');
  }
  // 「识别协议」是协议设置里的动作：协议已知，连按钮一起不显示。
  assert.equal(collect(node, (n) => n.props && n.props['data-mo-image-detect-protocol'] !== undefined).length, 0,
    '预设来源不需要识别协议');
  // 常显的三段与「自定义设置」照旧：藏起来的只是协议那一块。
  const name = collect(node, (n) => n.type === 'input' && n.props.value === 'OpenAI')[0];
  const url = collect(node, (n) => n.type === 'input' && n.props.value === 'https://api.openai.com/v1')[0];
  const key = collect(node, (n) => n.type === 'input' && n.props.type === 'password')[0];
  for (const [label, control] of [['显示名称', name], ['API 地址', url], ['API 密钥', key]]) {
    assert.ok(control, label + ' 还在');
    assert.equal(insideAnyDetails(node, control), false, label + ' 仍然常显');
  }
  assert.ok(detailsOf(node, '自定义设置'), '「自定义设置」还在');
});

test('判据只看 presetId：同一份配置去掉它，就是自己填的网关，协议设置照旧渲染', () => {
  // 对照组：地址和协议一模一样，只差来源。不能靠 baseUrl 猜「是不是内置的」。
  const provider = {
    id: 'p1', name: 'Relay', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images', models: [], names: {}
  };
  const custom = loadClient();
  custom.setCatalog();
  const customNode = renderForm(custom, provider);
  const customSettings = detailsOf(customNode, '协议设置');
  assert.ok(customSettings, '没有 presetId 的提供商仍然有「协议设置」');
  for (const [label, control] of Object.entries(protocolPanelControls(customNode))) {
    assert.ok(control, label + ' 在');
    assert.ok(insideOf(customSettings, control), label + ' 收在协议设置里');
  }
  assert.equal(collect(customNode, (n) => n.props && n.props['data-mo-image-detect-protocol'] !== undefined).length, 1,
    '识别协议按钮在（协议未知，这正是它派上用场的地方）');

  const preset = loadClient();
  preset.setCatalog();
  const presetNode = renderForm(preset, { ...provider, presetId: 'openai' });
  assert.equal(detailsOf(presetNode, '协议设置'), undefined, '加上 presetId 就变回预设来源，整块不渲染');
});

test('新增从目录选预设：协议 / 返回格式都不渲染（与编辑页同一条判据）', () => {
  const client = loadClient({ preserveFormState: true, providerPresets: PROVIDER_PRESET_FIXTURE });
  client.setCatalog();
  const provider = { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} };
  let node = renderForm(client, provider, true);
  // 目录模式默认带出一份预设（真机上由 effect 补；这里直接点下拉选，走同一条 choosePreset）。
  const presetSelect = collect(node, (item) => item.type === 'select'
    && collect(item, (child) => child.type === 'option' && child.props.value === 'openai').length === 1)[0];
  assert.ok(presetSelect, '目录模式下要能选预设');
  presetSelect.props.onChange({ target: { value: 'openai' } });
  node = renderForm(client, provider, true);

  // 预设在目录里已经把协议 / 鉴权 / 返回格式写好了：整块不渲染，返回格式编辑器也不残留。
  assert.equal(detailsOf(node, '协议设置'), undefined, '新增表单不该有「协议设置」折叠区');
  for (const [label, control] of Object.entries(protocolPanelControls(node))) {
    assert.equal(control, undefined, label + ' 不该出现在新增表单里');
  }
  assert.equal(collect(node, (item) => item.props && item.props['data-mo-image-output-presets'] !== undefined).length, 0,
    '返回格式面板不再残留');
  assert.equal(collect(node, (item) => item.props && item.props['data-mo-image-operations'] !== undefined).length, 0,
    '自定义协议的 JSON 编辑器也不该出现');
  // 主字段与模型目录照旧（目录模式的显示名称来自预设，不单独出输入框）。
  const providerSelect = collect(node, (item) => item.type === 'select'
    && collect(item, (child) => child.type === 'option' && child.props.value === 'openai').length === 1)[0];
  assert.equal(providerSelect.props.value, 'openai', '预设选择器停在刚选的这一项');
  const url = collect(node, (item) => item.type === 'input' && item.props.value === 'https://api.openai.com/v1')[0];
  assert.ok(url, 'API 地址在');
  assert.ok(detailsOf(node, '自定义设置'), '「自定义设置」还在');
});

test('新建提供商的三个 tab 按「第三方 → 本地 → 自定义」排列，默认仍选中第三方', () => {
  const client = loadClient({ providerPresets: PROVIDER_PRESET_FIXTURE, localPresets: LOCAL_DEPLOYER_FIXTURE });
  client.setCatalog();
  const node = renderForm(client, { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} }, true);
  const labels = ['第三方模型提供商', '本地模型', '自定义模型 API'];
  const tabs = collect(node, (item) => item.type === 'button' && labels.includes(text(item).join('')));
  assert.deepEqual(tabs.map((tab) => text(tab).join('')), labels, 'DOM 顺序：第三方 → 本地 → 自定义');
  // 排序变了，默认值不跟着变：仍然停在第三方（catalog），渲染的是目录表单。
  const providerSelect = collect(node, (item) => item.type === 'select'
    && collect(item, (child) => child.type === 'option' && child.props.value === 'openai').length === 1)[0];
  assert.ok(providerSelect, '默认选中的仍是「第三方模型提供商」（catalog）');
});

test('新增本地部署：与云厂商预设同一规则，鉴权 / 返回格式都不渲染', () => {
  const client = loadClient({ preserveFormState: true, localPresets: LOCAL_DEPLOYER_FIXTURE });
  client.setCatalog();
  const provider = { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} };
  let node = renderForm(client, provider, true);
  const localButton = collect(node, (item) => item.type === 'button' && text(item).join('') === '本地模型')[0];
  assert.ok(localButton, '模式开关里要有「本地模型」');
  localButton.props.onClick();
  node = renderForm(client, provider, true);

  // 本地预设也是 presetId 来源：零配置是它的卖点，鉴权同样不在这条路上配。
  assert.equal(collect(node, (item) => item.type === 'select'
    && item.props['data-mo-image-auth-mode'] !== undefined).length, 0,
  '本地部署不渲染鉴权方式（要配鉴权走「自定义模型 API」）');
  assert.equal(collect(node, (item) => item.props && item.props['data-mo-image-output-presets'] !== undefined).length, 0,
    '返回格式由本地预设写好，不再渲染');
  assert.equal(collect(node, (item) => item.props && item.props['data-mo-image-output-preset'] !== undefined).length, 0,
    '返回格式下拉一个都不剩');
  assert.equal(collect(node, (item) => item.props && item.props['data-mo-image-operations'] !== undefined).length, 0,
    '请求与返回格式的 JSON 编辑器也不出现');
  // 主字段照旧：显示名称 / 地址 / 密钥 + 模型目录。
  const name = collect(node, (item) => item.type === 'input' && item.props.value === 'sd-server')[0];
  assert.ok(name, '显示名称在');
  const url = collect(node, (item) => item.type === 'input' && item.props.value === 'http://127.0.0.1:8080/v1')[0];
  assert.ok(url, 'API 地址在');
  assert.ok(collect(node, (item) => item.type === 'input' && item.props.type === 'password')[0], '密钥还在');
});

test('本地预设编辑：与云厂商预设同一规则，整块协议设置都不渲染（含鉴权）', () => {
  for (const local of LOCAL_DEPLOYER_FIXTURE) {
    const client = loadClient({ localPresets: LOCAL_DEPLOYER_FIXTURE });
    client.setCatalog();
    const node = renderForm(client, {
      id: 'p1', name: local.name, baseUrl: local.baseUrl, adapter: local.adapter,
      presetId: local.id, auth: { mode: 'custom', header: 'X-API-Key', prefix: 'Token ' },
      models: [], names: {}
    });
    assert.equal(detailsOf(node, '协议设置'), undefined, local.id + '：不渲染「协议设置」');
    for (const [label, control] of Object.entries(protocolPanelControls(node))) {
      assert.equal(control, undefined, local.id + '：' + label + ' 不该出现');
    }
    // 主字段与「自定义设置」照旧。
    const url = collect(node, (item) => item.type === 'input' && item.props.value === local.baseUrl)[0];
    assert.ok(url, local.id + '：API 地址仍常显');
    assert.ok(detailsOf(node, '自定义设置'), local.id + '：「自定义设置」还在');
  }
});

test('本地部署清单在场时，云厂商预设照旧整块不渲染协议设置', () => {
  const client = loadClient({ localPresets: LOCAL_DEPLOYER_FIXTURE });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: [], names: {}
  });
  assert.equal(detailsOf(node, '协议设置'), undefined, '云端预设与本地预设同一套判据');
  for (const [label, control] of Object.entries(protocolPanelControls(node))) {
    assert.equal(control, undefined, label + ' 不该出现');
  }
});

test('自定义 API：本地部署清单在场时协议设置五项照样全在（对照组）', () => {
  const client = loadClient({ localPresets: LOCAL_DEPLOYER_FIXTURE });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  });
  const settings = detailsOf(node, '协议设置');
  assert.ok(settings, '没有 presetId = 自己填的网关，协议设置在');
  const controls = protocolPanelControls(node);
  assert.deepEqual(Object.keys(controls),
    ['API 协议', '鉴权方式', '图生图端点', '文生图返回格式', '图生图返回格式']);
  for (const [label, control] of Object.entries(controls)) {
    assert.ok(control, label + ' 在');
    assert.ok(insideOf(settings, control), label + ' 收在协议设置里');
  }
});

test('手改 API 地址就不再算预设来源：协议设置重新出现（判据跟着 draft.presetId 走）', () => {
  // 预设的地址被换掉 = 换成另一家网关：形状未知了，这时候正需要这一块开关。
  // 判据不是「地址像不像预设」，而是来源有没有被清掉——urlField 改地址时会把 presetId 清掉。
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: [], names: {}
  };
  let node = renderForm(client, provider);
  assert.equal(detailsOf(node, '协议设置'), undefined, '预设来源：先是藏着的');
  const url = collect(node, (n) => n.type === 'input' && n.props.value === 'https://api.openai.com/v1')[0];
  assert.ok(url, 'API 地址输入框在');
  url.props.onChange({ target: { value: 'https://relay.example/v1' } });
  node = renderForm(client, provider);
  assert.ok(detailsOf(node, '协议设置'), '换了地址就是自己填的网关：协议设置回来');
  assert.equal(collect(node, (n) => n.props && n.props['data-mo-image-protocol'] !== undefined).length, 1,
    '协议下拉也跟着回来');
});

test('隐藏协议设置不清值：预设来源存在里面的协议 / 鉴权 / 返回格式保存时原样带回', async () => {
  const client = loadClient();
  client.setCatalog();
  const operations = { version: 1, generate: { output: 'binary' } };
  const provider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai',
    // 用户以前在这块里手动改过的三样：现在看不见了，但一个都不能丢。
    protocolOptions: { edit: 'same' },
    auth: { mode: 'api-key' },
    operations: operations,
    models: [], names: {}
  };
  let saved = null;
  const tree = client.render(client.h(client.form(), {
    provider: provider, isNew: false, onSave(next) { saved = next; }, onClose() {}, t: t
  }));
  const save = collect(tree, (item) => item.type === 'button'
    && text(item).join('').includes('form.save')).pop();
  assert.ok(save, '保存按钮要存在');
  await save.props.onClick();

  // 跨 vm 边界的对象走一趟 JSON：deepEqual 会比对原型，vm 里的 Object 与本进程不是同一个。
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.ok(saved, '保存要提交一份配置');
  assert.equal(saved.adapter, 'openai-images', '协议不能因为不显示就被清掉');
  assert.deepEqual(plain(saved.protocolOptions), { edit: 'same' }, '协议级选项原样带回');
  assert.deepEqual(plain(saved.auth), { mode: 'api-key' }, '鉴权方式原样带回');
  assert.deepEqual(plain(saved.operations), operations, '返回格式原样带回');
  assert.equal(saved.presetId, 'openai', '来源也原样带回');
});

test('「自定义设置」只留接入细节：模型目录在，协议 / 鉴权 / 返回格式都不在', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: ['m'], names: {}
  });
  const advanced = detailsOf(node, '自定义设置');
  assert.ok(advanced, '自定义设置折叠区在');
  assert.equal(advanced.props.open, false, '默认收起');

  const fetch = fetchButton(node);
  assert.ok(fetch, '「获取可用模型」入口在');
  assert.ok(insideOf(advanced, fetch), '模型目录（含拉取按钮）仍在自定义设置里');

  for (const [label, prop] of [
    ['API 协议', 'data-mo-image-protocol'],
    ['鉴权方式', 'data-mo-image-auth-mode'],
    ['返回格式', 'data-mo-image-output-presets']
  ]) {
    assert.equal(collect(advanced, (n) => n.props && n.props[prop] !== undefined).length, 0,
      label + ' 不该收进自定义设置');
  }
});

test('自定义协议：路由与调度模型留在「自定义设置」，请求与返回格式跟着协议常显', () => {
  const client = loadClient();
  client.setCatalog();
  const gateway = renderForm(client, {
    id: 'p1', name: 'Gateway', baseUrl: 'https://g.example/v1', adapter: 'custom', models: ['m'], names: {}
  });
  const advanced = detailsOf(gateway, '自定义设置');
  const route = collect(gateway, (n) => n.type === 'input' && n.props.name === 'route-generate')[0];
  assert.ok(route, '自定义路由输入框在');
  assert.ok(insideOf(advanced, route), '路由是接入细节：收在自定义设置里');

  const settings = detailsOf(gateway, '协议设置');
  const operations = collect(gateway, (n) => n.props && n.props['data-mo-image-operations'] === 'provider')[0];
  assert.ok(operations, '「请求与返回格式」编辑器在');
  assert.ok(insideOf(settings, operations), '请求与返回格式跟着协议，收在协议设置里');
  assert.equal(collect(advanced, (n) => n.props && n.props['data-mo-image-operations'] === 'provider').length, 0,
    '同一块不再出现在自定义设置里');

  const responses = renderForm(client, {
    id: 'p2', name: 'Responses', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses',
    hostModel: 'gpt-5.2', models: [], names: {}
  });
  const hostModel = collect(responses, (n) => n.type === 'input' && n.props.value === 'gpt-5.2')[0];
  assert.ok(hostModel, '调度模型输入框在');
  assert.ok(insideOf(detailsOf(responses, '自定义设置'), hostModel), '调度模型也属于接入细节');
});

test('新增自定义仍然平铺：协议 / 鉴权 / 图生图端点都不进折叠区', () => {
  const client = loadClient({ customMode: true });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  }, true);
  const protocol = collect(node, (n) => n.type === 'select' && n.props['data-mo-image-protocol'] !== undefined)[0];
  const auth = collect(node, (n) => n.type === 'select' && n.props['data-mo-image-auth-mode'] !== undefined)[0];
  const edit = collect(node, (n) => n.type === 'select' && n.props['data-mo-image-protocol-option'] === 'edit')[0];
  for (const [label, control] of [['API 协议', protocol], ['鉴权方式', auth], ['图生图端点', edit]]) {
    assert.ok(control, label + ' 在');
    assert.equal(insideAnyDetails(node, control), false, label + ' 不能收进折叠区');
  }
});

test('识别协议挪到协议下拉右侧，且与问号不在同一个 hover 容器里', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  });
  const select = collect(node, (item) => item.type === 'select'
    && item.props['data-mo-image-protocol'] !== undefined)[0];
  const detect = collect(node, (item) => item.props
    && item.props['data-mo-image-detect-protocol'] !== undefined)[0];
  assert.ok(select && detect);
  const row = parentOf(node, detect);
  assert.ok(row, '识别按钮有父容器');
  assert.equal(row.props['data-mo-image-protocol-row'], '', '与下拉同一行');
  assert.equal(parentOf(node, select), row, '识别按钮紧贴协议下拉右侧');
  assert.equal(collect(row, (item) => item.type === 'select'
    && item.props['data-mo-image-protocol'] !== undefined).length, 1);

  // 问号在 label 行，识别按钮在下拉行：hover 只作用在各自按钮上。
  const help = routeHelpOf(node);
  const labelRow = parentOf(node, help);
  assert.ok(labelRow, '问号有 label 行容器');
  assert.equal(labelRow.props['data-mo-image-protocol-label-row'], '');
  assert.notEqual(labelRow, row, '问号与识别按钮不共用一个容器');
  assert.equal(collect(labelRow, (item) => item.props
    && item.props['data-mo-image-detect-protocol'] !== undefined).length, 0,
  '识别按钮不在问号所在的 label 行');
  assert.equal(collect(row, (item) => item.props && item.props['data-route-help'] !== undefined).length, 0,
    '问号不在下拉行');
  // 悬停识别协议不会触发问号的即时气泡。
  if (typeof detect.props.onPointerEnter === 'function') detect.props.onPointerEnter();
  assert.equal(collect(renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  }), (item) => item.props && item.props.role === 'tooltip').length, 0,
  'hover 识别协议时问号不进入 hover 态');
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

test('自定义操作预览使用实际端点，返回预设可直接写入草稿', () => {
  const client = loadClient({ customMode: true, preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Gateway', adapter: 'custom', baseUrl: '',
    customEndpoints: { generate: 'old' },
    operations: { version: 1, generate: { path: 'v1/render', method: 'POST' }, models: { path: 'https://g.example/v1/catalog' } },
    models: ['m']
  };
  const select = (tree) => collect(tree, (node) => node.props['data-mo-image-output-preset'] === 'generate')[0];
  let tree = renderForm(client, provider, true);
  assert.match(routeHelpOf(tree).props['aria-description'], /https:\/\/g\.example\/v1\/render/);
  assert.match(routeHelpOf(tree).props['aria-description'], /https:\/\/g\.example\/v1\/catalog/);
  assert.notEqual(fetchButton(tree).props.disabled, true);
  assert.equal(select(tree).props.value, 'auto');
  select(tree).props.onChange({ target: { value: 'binary' } });
  tree = renderForm(client, provider, true);
  assert.equal(select(tree).props.value, 'binary');
  const editor = collect(tree, (node) => node.props['data-mo-image-operations'] === 'provider')[0];
  const json = collect(editor, (node) => node.type === 'textarea')[0];
  assert.deepEqual(JSON.parse(json.props.value).generate, { path: 'v1/render', method: 'POST', output: 'binary' });
});

/** 按 summary 文案定位折叠区：「协议设置」与「自定义设置」都靠它找。 */
function detailsOf(node, label) {
  return collect(node, (item) => item.type === 'details'
    && collect(item, (child) => child.type === 'summary' && text(child).join('') === label).length > 0)[0];
}

test('内置协议的返回格式只剩预设下拉：手写 JSON 输入框与提示都已删除', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    operations: { version: 1, generate: { output: 'binary' } },
    models: [], names: {}
  });
  const panel = collect(node, (item) => item.props['data-mo-image-output-presets'] === 'provider')[0];
  assert.ok(panel, '返回预设面板要渲染');
  // 返回格式属于协议：跟着协议收在「协议设置」里，不再塞进「自定义设置」。
  const settings = detailsOf(node, '协议设置');
  assert.ok(settings, '协议设置折叠区在');
  assert.equal(insideOf(settings, panel), true, '这块 UI 跟着协议走');
  const advanced = detailsOf(node, '自定义设置');
  assert.ok(advanced, '自定义设置折叠区还在');
  assert.equal(insideOf(advanced, panel), false, '不再留在自定义设置里');
  const selects = collect(panel, (item) => item.type === 'select' && item.props['data-mo-image-output-preset']);
  assert.deepEqual(
    selects.map((item) => item.props['data-mo-image-output-preset']).sort(),
    ['edit', 'generate'],
    '文生图与图生图两个预设下拉都在'
  );
  assert.equal(selects.find((item) => item.props['data-mo-image-output-preset'] === 'generate').props.value, 'binary');
  // 「跟随协议」只换文案：选项值仍是 auto（协议自带描述符），两个下拉共用这一份文案。
  const autoOption = (select) => collect(select, (item) => item.type === 'option'
    && item.props && item.props.value === 'auto')[0];
  assert.deepEqual(selects.map((select) => text(autoOption(select)).join('')), ['跟随协议', '跟随协议'],
    '两个下拉的 auto 项都显示「跟随协议」，不露出裸值 auto');
  assert.equal(collect(node, (item) => item.type === 'textarea').length, 0, '手写 JSON 的输入框已不存在');
  assert.equal(collect(node, (item) => item.type === 'textarea'
    && item.props['aria-label'] === '返回格式覆盖').length, 0, '旧的 JSON 入口（aria-label）也不存在');
});

test('旧配置里手写的 output 显示为只读「自定义（来自旧配置）」，保存时原样保留', async () => {
  const client = loadClient();
  client.setCatalog();
  const legacy = { kind: 'json', pick: [{ path: 'data.0.url', as: 'url' }] };
  let saved = null;
  const tree = client.render(client.h(client.form(), {
    provider: {
      id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
      operations: { version: 1, generate: { output: legacy } },
      models: [], names: {}
    },
    isNew: false,
    onSave(next) { saved = next; },
    onClose() {},
    t: t
  }));
  const select = collect(tree, (item) => item.props['data-mo-image-output-preset'] === 'generate')[0];
  assert.equal(select.props.value, 'custom', '匹配不到预设的旧值要显示成自定义');
  const option = collect(select, (item) => item.type === 'option'
    && item.props && item.props.value === 'custom')[0];
  assert.ok(option, '自定义项要出现在下拉里');
  assert.equal(option.props.disabled, true, '自定义项是只读的');
  assert.equal(text(option).join(''), '自定义（来自旧配置）');
  assert.equal(collect(tree, (item) => item.props['data-mo-image-output-legacy-hint'] !== undefined).length, 1,
    '给一句简短说明');
  const save = collect(tree, (item) => item.type === 'button'
    && text(item).join('').includes('form.save')).pop();
  assert.ok(save, '保存按钮要存在');
  await save.props.onClick();
  assert.deepEqual(saved.operations.generate.output, legacy, '用户重新选预设之前，旧值不能被丢掉');
});

test('旧配置的自定义值可以被预设覆盖', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    operations: { version: 1, generate: { output: { kind: 'binary' } } },
    models: [], names: {}
  };
  const render = () => renderForm(client, provider);
  let tree = render();
  const select = () => collect(tree, (item) => item.props['data-mo-image-output-preset'] === 'generate')[0];
  assert.equal(select().props.value, 'custom');
  select().props.onChange({ target: { value: 'binary' } });
  tree = render();
  assert.equal(select().props.value, 'binary', '重新选预设就覆盖旧的自定义值');
  assert.equal(collect(tree, (item) => item.props['data-mo-image-output-legacy-hint'] !== undefined).length, 0,
    '覆盖之后不再显示旧配置说明');
});

// ---------------------------------------------------------------------------
// 精简本地模型表单 / 模型选项里的返回格式 / 模型行布局
// ---------------------------------------------------------------------------

/** 从根到目标节点的祖先链（含目标自己）。 */
function ancestorsOf(root, target, chain = []) {
  if (root === null || root === undefined) return null;
  if (Array.isArray(root)) {
    for (const item of root) {
      const hit = ancestorsOf(item, target, chain);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof root !== 'object') return null;
  const next = chain.concat([root]);
  if (root === target) return next;
  for (const child of root.children || []) {
    const hit = ancestorsOf(child, target, next);
    if (hit) return hit;
  }
  return null;
}

/** 模型行的 options 开关（chevron 图标按钮，带 aria-expanded）。 */
function modelOptionsToggle(row) {
  return collect(row, (item) => item.type === 'button'
    && typeof item.props['aria-expanded'] === 'boolean')[0];
}

/** 展开第 index 个模型的选项面板（需要 preserveFormState 才会记住状态）。 */
function expandModelOptions(client, provider, render, index = 0) {
  let node = render();
  const row = collect(node, (item) => item.props && item.props['data-row-key'] === String(index))[0];
  assert.ok(row, '模型行 ' + index + ' 在');
  const toggle = modelOptionsToggle(row);
  assert.ok(toggle, '模型行上要有展开按钮');
  toggle.props.onClick({ currentTarget: { focus() {} } });
  node = render();
  return collect(node, (item) => item.props && item.props['data-row-key'] === String(index))[0];
}

test('本地模型表单不再显示预设提示：地址下面与密钥下面的两段文字都不渲染', () => {
  // 夹具带两段提示原文：真清单里宿主下发的 urlHint / hint 就是这个形状。
  const fixtures = [{
    id: 'sd-server', name: 'sd-server', baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'openai-images',
    urlHint: 'HINT-URL 只填服务根地址，末尾保留 /v1',
    hint: 'HINT-KEY 原生 OpenAI Images 接口'
  }];
  const client = loadClient({ preserveFormState: true, localPresets: fixtures });
  client.setCatalog();
  const provider = { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} };
  let node = renderForm(client, provider, true);
  const localTab = collect(node, (item) => item.type === 'button' && text(item).join('') === '本地模型')[0];
  assert.ok(localTab, '「本地模型」tab 在');
  localTab.props.onClick();
  node = renderForm(client, provider, true);

  const body = text(node).join(' ');
  assert.doesNotMatch(body, /HINT-URL/, 'API 地址下面那行提示已删掉');
  assert.doesNotMatch(body, /HINT-KEY/, 'API 密钥下面那行提示已删掉');
  // 只删提示，字段本身照旧常显（本地服务有时确实要填密钥）。
  assert.ok(collect(node, (item) => item.type === 'input' && item.props.value === 'http://127.0.0.1:8080/v1')[0],
    'API 地址输入框还在');
  assert.ok(collect(node, (item) => item.type === 'input' && item.props.value === 'sd-server')[0],
    '显示名称输入框还在');
  assert.ok(collect(node, (item) => item.type === 'input' && item.props.type === 'password')[0],
    'API 密钥输入框还在');
});

test('预设有来源时，模型选项里没有返回格式（返回格式属于预设）', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: ['gpt-image-1'], names: {}
  };
  const row = expandModelOptions(client, provider, () => renderForm(client, provider));
  assert.equal(collect(row, (item) => item.props && item.props['data-mo-image-output-presets'] !== undefined).length, 0,
    '预设来源的模型选项里不再有返回格式面板');
  assert.equal(collect(row, (item) => item.props && item.props['data-mo-image-output-preset'] !== undefined).length, 0,
    '两个返回格式下拉也一个都不剩');
});

test('自定义模型 API 保留模型选项里的返回格式，两个下拉排在同一行', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
    models: ['m'], names: {}
  };
  const row = expandModelOptions(client, provider, () => renderForm(client, provider));
  // 自定义协议的模型选项是手写 JSON（没有手改过就不显示下拉），这块保留。
  assert.ok(collect(row, (item) => item.props && item.props['data-mo-image-operations'] === 'm')[0],
    '自定义协议的模型选项还在');

  // 两个返回格式下拉（提供方这一层）在同一行：同一个父容器、横向两列。
  const tree = renderForm(client, provider);
  const generate = collect(tree, (item) => item.type === 'select'
    && item.props['data-mo-image-output-preset'] === 'generate')[0];
  const edit = collect(tree, (item) => item.type === 'select'
    && item.props['data-mo-image-output-preset'] === 'edit')[0];
  assert.ok(generate && edit, '两个下拉都在');
  const rowBox = ancestorsOf(tree, generate).find((item) => item.props && item.props.style
    && item.props.style.gridTemplateColumns);
  assert.ok(rowBox, '两个下拉要有一个横向排布的父容器');
  assert.equal(ancestorsOf(tree, edit).includes(rowBox), true, '两个下拉是同一个父容器的子元素');
  assert.equal(rowBox.props.style.gridTemplateColumns, 'minmax(0, 1fr) minmax(0, 1fr)',
    '一行两列（各占半宽），不再是上下两行');
});

test('隐藏的返回格式不清掉老配置：模型上已配过的 output 保存时原样带回', async () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const operations = { version: 1, generate: { output: 'binary' } };
  const provider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: ['gpt-image-1'], names: {},
    modelOptions: { 'gpt-image-1': { operations: operations } }
  };
  const render = () => renderForm(client, provider);
  expandModelOptions(client, provider, render);
  let saved = null;
  const tree = client.render(client.h(client.form(), {
    provider: provider, isNew: false, onSave(next) { saved = next; }, onClose() {}, t: t
  }));
  const save = collect(tree, (item) => item.type === 'button' && text(item).join('').includes('form.save')).pop();
  assert.ok(save, '保存按钮要存在');
  await save.props.onClick();
  const plain = JSON.parse(JSON.stringify(saved.modelOptions));
  assert.deepEqual(plain['gpt-image-1'].operations, operations, '模型上看不见的返回格式不能被丢掉');
});

test('模型行展开前后布局一致：两个输入框的列不变，各自 min-width: 0', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    models: ['doubao-seedream-4-0-250828'], names: { 'doubao-seedream-4-0-250828': 'Doubao Seedream' }
  };
  // data-row-key 在外层模型卡片上，列定义在内层的 .modelRow 上。
  const rowOf = (tree) => collect(tree, (item) => String(item.props.className || '').includes('modelRow'))[0];
  const render = () => renderForm(client, provider);
  const collapsed = rowOf(render());
  assert.ok(collapsed, '模型行在');
  const columns = collapsed.props.style.gridTemplateColumns;
  assert.equal(columns, 'auto minmax(0, 1.4fr) minmax(0, 1fr) auto auto',
    '列宽固定：ID 与显示名称各占一份比例，其余是按钮');

  expandModelOptions(client, provider, render);
  const expanded = rowOf(render());
  assert.equal(expanded.props.style.gridTemplateColumns, columns,
    '展开选项面板不改变这一行的列宽');

  // 两个输入框都在第 1 行、各自的列位固定；都允许被压缩 + 省略号截断，谁也不把谁挤没。
  const fields = collect(expanded, (item) => item.type === 'label'
    && ['2', '3'].includes(String(item.props.style && item.props.style.gridColumn)));
  assert.deepEqual(fields.map((item) => item.props.style.gridColumn), ['2', '3'],
    '两个输入框分别钉在第 2 / 3 列，位置不随展开变化');
  assert.deepEqual(fields.map((item) => item.props.style.gridRow), ['1', '1'], '都在同一行');
  const inputs = fields.map((label) => collect(label, (item) => item.type === 'input')[0]);
  assert.equal(inputs.filter(Boolean).length, 2, '模型 ID 与显示名称两个输入框都在');
  for (const input of inputs) {
    assert.equal(input.props.style.minWidth, 0, '输入框能收缩（min-width: 0）');
    assert.equal(input.props.style.textOverflow, 'ellipsis', '超长用省略号截断');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { normalizeConfig } from '../lib/config-store.js';

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
  'form.inputSettings': '输入设置',
  'form.outputSettings': '输出设置',
  'form.protocolSettings': '协议设置',
  'form.modelOperationsHint': '在 JSON 里覆盖 generate 或 edit。省略的选项沿用提供商设置。',
  // 旧折叠区的标题；折叠区没了之后它只剩一个用处——返回格式 JSON 编辑器的 aria-label。
  'form.operations': '请求与返回格式',
  'form.authFollow': '跟随协议',
  'form.modeCatalog': '第三方模型提供商',
  'form.modeCustom': '自定义模型 API',
  'form.modeLocal': '本地模型',
  'form.localDeployer': '本地部署器',
  'form.keyLocalOptional': '本地无鉴权可留空',
  'form.keyEnter': '输入 API 密钥',
  'form.providerUnrecognized': '未识别出提供商预设，将使用通用协议配置；如需零配置体验，请从「第三方模型提供商」里选择。',
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

/** 表单顶部那句「认不出提供商预设」的红字（没有就是 undefined）。 */
function presetNoticeOf(node) {
  return collect(node, (item) => item.props && item.props['data-mo-image-provider-notice'] !== undefined)[0];
}

test('认不出提供商：表单顶部一句红字，排在 API 密钥上方', () => {
  // 「本该是某个已知提供商，但认不出是哪家」的那一档：地址就是内置预设的地址
  // （api.openai.com），协议却不是预设里的那一条 —— 说不出是哪份预设。
  const client = loadClient({ providerPresets: PROVIDER_PRESET_FIXTURE });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', models: [], names: {}
  });
  const notice = presetNoticeOf(node);
  assert.ok(notice, '预设地址 + 非预设协议：要有这句提醒');
  assert.match(text(notice).join(''), /未识别出提供商预设/, '文案走 form.providerUnrecognized');
  // 位置：表单最顶部（第一个块），API 密钥上方，且不在任何折叠区里。
  assert.equal(formBlocks(node)[0], notice, '排在表单最顶部');
  const key = collect(node, (n) => n.type === 'input' && n.props.type === 'password')[0];
  assert.ok(key, 'API 密钥在');
  const order = preorder(node);
  assert.ok(order.indexOf(notice) < order.indexOf(key), '红字排在 API 密钥上方');
  assert.equal(insideAnyDetails(node, notice), false, '红字常显，不进折叠区');
  // 颜色用现有的错误色变量：不新造颜色。
  assert.match(String(notice.props.style.color), /--dsw-alias-state-error-primary/);
});

test('自定义 API 不提醒：地址不在任何预设里，列表里就带着「自定义」标签', () => {
  // 实测的 APIYI：adapter 是空串（不是 'custom'）、编辑页 isNew 为假 —— 旧判据在这里误报。
  // 判据与列表里的「自定义」标签共用一份：自己填的端点本来就没有预设来源。
  const client = loadClient({ providerPresets: PROVIDER_PRESET_FIXTURE });
  client.setCatalog();
  for (const adapter of ['', 'openai-images']) {
    const node = renderForm(client, {
      id: 'p1', name: 'APIYI', baseUrl: 'https://api.apiyi.com/v1', adapter: adapter, models: [], names: {}
    });
    assert.equal(presetNoticeOf(node), undefined, (adapter || '(自动)') + '：自定义 API 不该有红字');
  }
});

test('自定义协议不提醒：adapter 就是用户自己挑的「自定义」，它本来就没有 presetId', () => {
  const client = loadClient({ providerPresets: PROVIDER_PRESET_FIXTURE });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Gateway', baseUrl: 'https://g.example/v1', adapter: 'custom', models: [], names: {}
  });
  assert.equal(presetNoticeOf(node), undefined, '自定义协议不该有这句红字');
  // 地址恰好是预设地址也一样：请求形状是用户自己写的，不因为地址像谁就变成预设来源。
  assert.equal(presetNoticeOf(renderForm(client, {
    id: 'p1', name: 'Gateway', baseUrl: 'https://api.openai.com/v1', adapter: 'custom', models: [], names: {}
  })), undefined, '自定义协议即使地址像预设也不提醒');
  // 对照：同一份地址换成非预设的具体协议就有了（证明不是「永远没有」）。
  const other = renderForm(client, {
    id: 'p1', name: 'Gateway', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', models: [], names: {}
  });
  assert.ok(presetNoticeOf(other), '换了协议就该提醒');
});

test('新建的「自定义模型 API」入口不提醒：那个入口本来就是自己配', () => {
  // 用户已经明确选了「我自己配」，红字再说「没认出预设」纯属噪音。
  const client = loadClient({ customMode: true });
  client.setCatalog();
  const node = renderForm(client, {
    id: '', name: '', baseUrl: 'https://g.example/v1', adapter: '', presetId: '', models: [], names: {}
  }, true);
  assert.equal(presetNoticeOf(node), undefined, '自定义 API 入口不该有红字');
  // 对照：编辑一个地址是预设、协议不是预设的老配置仍然提醒 —— 证明不是「永远没有」。
  const editing = loadClient({ providerPresets: PROVIDER_PRESET_FIXTURE });
  editing.setCatalog();
  assert.ok(presetNoticeOf(renderForm(editing, {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', models: [], names: {}
  })), '预设地址 + 非预设协议：编辑页照旧提醒');
});

test('预设来源不提醒：有 presetId 就是认出来了', () => {
  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: [], names: {}
  });
  assert.equal(presetNoticeOf(node), undefined, '认出来源就没有红字');
});

test('火山方舟 Agent Plan（旧配置 adapter 为空）回填 volcengine-plan：协议设置整块隐藏', () => {
  // 实测：名称与地址都和预设一字不差，adapter 却是空串 —— 以前按空 adapter 只兜底 openai，
  // 认不出来；现在在全部预设里按地址认唯一命中，回填来源。
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: '火山方舟 Agent Plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      adapter: '', protocol: 'openai-images',
      models: ['doubao-seedream-4-0-250828'], names: {}
    }],
    active: { providerId: 'p1', model: 'doubao-seedream-4-0-250828' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  const provider = config.providers[0];
  assert.equal(provider.presetId, 'volcengine-plan', '地址唯一命中预设');

  const client = loadClient();
  client.setCatalog();
  const node = renderForm(client, provider);
  assert.equal(presetNoticeOf(node), undefined, '认出来源就没有红字');
  assert.equal(detailsOf(node, '协议设置'), undefined, '预设来源：整块协议设置不渲染');
  assert.ok(detailsOf(node, '自定义设置'), '「自定义设置」照旧在');
});

test('新增从目录选预设：不提醒（选中的就是这个提供商的来源）', () => {
  const client = loadClient({ preserveFormState: true, providerPresets: PROVIDER_PRESET_FIXTURE });
  client.setCatalog();
  const provider = { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} };
  let node = renderForm(client, provider, true);
  const presetSelect = collect(node, (item) => item.type === 'select'
    && collect(item, (child) => child.type === 'option' && child.props.value === 'openai').length === 1)[0];
  presetSelect.props.onChange({ target: { value: 'openai' } });
  node = renderForm(client, provider, true);
  assert.equal(presetNoticeOf(node), undefined, '目录入口不提醒');
});

test('升级前的老配置：normalizeConfig 按分组补上来源，判据就变「预设来源」', () => {
  // 升级前的配置里没有 presetId（那个字段当年还不存在）：面板把它当自定义 API，协议设置冒出来。
  const legacyProvider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    models: [], names: {}
  };
  const before = loadClient();
  before.setCatalog();
  assert.ok(detailsOf(renderForm(before, legacyProvider), '协议设置'),
    '没有来源：按自定义 API 渲染，协议设置照旧在');

  // 宿主读配置时按分组补上来源（openai-images 那组里按地址认到了 openai）：同一份配置在面板里变成「预设来源」。
  const config = normalizeConfig({
    version: 1,
    providers: [Object.assign({ apiKeyEnv: 'MO_IMAGE_P1_API_KEY' }, legacyProvider)],
    active: { providerId: 'p1', model: '' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  assert.equal(config.providers[0].presetId, 'openai', '地址等于预设地址，补上来源');

  const after = loadClient();
  after.setCatalog();
  const node = renderForm(after, config.providers[0]);
  assert.equal(detailsOf(node, '协议设置'), undefined, '补上来源后：整块不渲染');
  for (const [label, control] of Object.entries(protocolPanelControls(node))) {
    assert.equal(control, undefined, label + ' 不该出现');
  }

  // 反向：手改过地址的老配置补不上来源，协议设置照旧在（那是他要用的东西）。
  const relay = normalizeConfig({
    version: 1,
    providers: [{ ...legacyProvider, baseUrl: 'https://my-relay.example/v1' }],
    active: { providerId: 'p1', model: '' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  assert.equal(relay.providers[0].presetId, undefined, '自建网关不补来源');
  const relayNode = renderForm(after, relay.providers[0]);
  assert.ok(detailsOf(relayNode, '协议设置'), '协议设置照旧渲染');
  for (const [label, control] of Object.entries(protocolPanelControls(relayNode))) {
    assert.ok(control, label + ' 在');
  }
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

test('本地模型的字段顺序：部署器 → 显示名称 → 密钥 →（自定义设置）地址 → 模型目录', () => {
  // 地址跟着本地部署器走，选完就填好了：常显它只会让人以为还得核对一遍，所以收进折叠区。
  // 模型目录同样是「选完部署器就不用再动」的接入细节：跟地址住进同一个折叠区，地址在前。
  // 部署器清单里那份 sd-server 无鉴权（optionalKey），密钥的 placeholder 要跟着说清楚。
  const localPresets = LOCAL_DEPLOYER_FIXTURE.map((item) => ({ ...item, optionalKey: true }));
  const client = loadClient({ preserveFormState: true, localPresets: localPresets });
  client.setCatalog();
  const provider = { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} };
  let node = renderForm(client, provider, true);
  const localButton = collect(node, (item) => item.type === 'button' && text(item).join('') === '本地模型')[0];
  assert.ok(localButton, '模式开关里要有「本地模型」');
  localButton.props.onClick();
  node = renderForm(client, provider, true);

  const deployer = collect(node, (item) => item.type === 'select'
    && collect(item, (child) => child.type === 'option' && child.props.value === 'sd-server').length === 1)[0];
  const name = collect(node, (item) => item.type === 'input' && item.props.value === 'sd-server')[0];
  const key = collect(node, (item) => item.type === 'input' && item.props.type === 'password')[0];
  const url = collect(node, (item) => item.type === 'input' && item.props.value === 'http://127.0.0.1:8080/v1')[0];
  const directory = collect(node, (item) => String((item.props || {}).className || '').endsWith('modelCatalog'))[0];
  const advanced = detailsOf(node, '自定义设置');
  for (const [label, control] of [['本地部署器', deployer], ['显示名称', name], ['API 密钥', key], ['API 地址', url], ['模型目录', directory]]) {
    assert.ok(control, label + ' 在');
  }
  assert.ok(advanced, '「自定义设置」折叠区在');

  // 折叠区里是地址与模型目录两项，顺序 地址 → 模型目录；标题沿用同一句「自定义设置」，默认收起。
  assert.equal(insideOf(advanced, url), true, 'API 地址收在「自定义设置」里');
  assert.equal(insideOf(advanced, directory), true, '模型目录也收在「自定义设置」里');
  const inSection = preorder(advanced);
  assert.ok(inSection.indexOf(url) < inSection.indexOf(directory), '折叠区里地址在前、模型目录在后');
  assert.equal(advanced.props.open, false, '默认收起');
  assert.equal(key.props.placeholder, '本地无鉴权可留空', '密钥 placeholder 保留');

  // 顺序：部署器 → 显示名称 → 密钥 → 折叠区（地址 + 模型目录）；密钥常显在折叠区上方。
  const order = preorder(node);
  const at = (target) => order.indexOf(target);
  assert.ok(at(deployer) < at(name), '本地部署器在最上');
  assert.ok(at(name) < at(key), '显示名称在密钥之前');
  assert.ok(at(key) < at(advanced), '密钥排在「自定义设置」之前');
  assert.ok(at(key) < at(directory), '模型目录排在密钥之后');
  assert.equal(insideAnyDetails(node, key), false, 'API 密钥常显');
  assert.equal(insideAnyDetails(node, deployer), false, '本地部署器常显');
  assert.equal(insideAnyDetails(node, directory), true, '模型目录不再常显');
});

test('本地模型：模型目录收在「自定义设置」折叠区里，模型行也跟着一起收着', () => {
  // 本地部署器的模型目录是「这台机器装了哪些 checkpoint」这类接入细节：展开折叠区才看得到，
  // 不在默认视图里占一屏。判据是「它是折叠区的后代」，不是「它排在折叠区后面」。
  const client = loadClient({ preserveFormState: true, localPresets: LOCAL_DEPLOYER_FIXTURE });
  client.setCatalog();
  const provider = { id: '', name: '', baseUrl: '', adapter: '', presetId: '', models: [], names: {} };
  let node = renderForm(client, provider, true);
  const localButton = collect(node, (item) => item.type === 'button' && text(item).join('') === '本地模型')[0];
  assert.ok(localButton, '模式开关里要有「本地模型」');
  localButton.props.onClick();
  node = renderForm(client, provider, true);

  const advanced = detailsOf(node, '自定义设置');
  assert.ok(advanced, '「自定义设置」折叠区在');
  const directory = collect(node, (item) => String((item.props || {}).className || '').endsWith('modelCatalog'))[0];
  assert.ok(directory, '模型目录在');
  assert.equal(insideOf(advanced, directory), true, '模型目录收在「自定义设置」里');

  // 加一行模型：整行（含 ID / 显示名称 / 删除）也在同一个折叠区里，不是只收了个标题。
  const addModel = collect(node, (item) => item.type === 'button' && text(item).join('').includes('form.addModel'))[0];
  assert.ok(addModel, '「添加模型」按钮在');
  addModel.props.onClick();
  node = renderForm(client, provider, true);
  const advancedWithRow = detailsOf(node, '自定义设置');
  const row = collect(node, (item) => item.props && item.props['data-row-key'] === '0')[0];
  assert.ok(row, '模型行在');
  assert.equal(insideOf(advancedWithRow, row), true, '模型行跟着模型目录一起收在「自定义设置」里');
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

test('手改 API 地址不动预设来源：协议设置照旧整块不渲染（判据只看 presetId）', () => {
  // 同一家提供商换个地址（反代、换域名、私有化部署）很常见：它仍然是那份预设带来的
  // 字段模板与锁，不该被重新当成「自己填的网关」。判据不是「地址像不像预设」，
  // 而是来源还在不在——urlField 改地址时不碰 presetId。
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
  assert.equal(detailsOf(node, '协议设置'), undefined, '换了地址仍是预设来源：协议设置还是不出现');
  assert.equal(collect(node, (n) => n.props && n.props['data-mo-image-protocol'] !== undefined).length, 0,
    '协议下拉也不出现');
  // 地址本身照用户的输入走，只是来源没被连带清掉。
  assert.ok(collect(node, (n) => n.type === 'input' && n.props.value === 'https://relay.example/v1')[0],
    'API 地址跟着用户输入');
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

// ---------------------------------------------------------------------------
// 新建「自定义模型 API」与编辑页共用同一套布局
// ---------------------------------------------------------------------------

/** 表单根：`.editor`（新建的自定义 API 与编辑页用的是同一个壳）。 */
function formRoot(node) {
  return collect(node, (item) => String((item.props || {}).className || '').endsWith('editor'))[0];
}

/** 表单根的直接子项（数组与 Fragment 展开、null 丢掉）—— 就是 DOM 顺序。 */
function formBlocks(node) {
  const root = formRoot(node);
  assert.ok(root, '表单根 .editor 在');
  const out = [];
  const append = (items) => {
    for (const item of items || []) {
      if (item === null || item === undefined) continue;
      if (Array.isArray(item)) { append(item); continue; }
      if (item.type === 'Fragment') { append(item.children); continue; }
      out.push(item);
    }
  };
  append(root.children);
  return out;
}

/** 新建才有的那一排「第三方 / 本地 / 自定义」模式开关。 */
function modeBarOf(blocks) {
  return blocks.find((item) => String((item.props || {}).className || '').endsWith('addModes'));
}

/**
 * 表单骨架：只留布局（节点类型、类名与 data-* 标记、顺序），文案 / 取值 / 内联样式全丢掉。
 * 允许两侧不同的东西（回显值、占位符、按钮文案）都不进骨架，所以骨架相等 = 布局是同一段代码。
 */
function formSkeleton(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map(formSkeleton).filter((item) => item !== null);
  if (typeof node !== 'object') return 'text';
  const props = node.props || {};
  // 顶部那句红字是**条件元素**（认不出来源才出现），不是布局差异：比对骨架时整棵子树丢掉。
  if (props['data-mo-image-provider-notice'] !== undefined) return null;
  const marks = Object.keys(props)
    .filter((key) => key === 'className' || key.startsWith('data-'))
    .sort()
    .map((key) => key + '=' + String(props[key]));
  const children = (node.children || []).map(formSkeleton).filter((item) => item !== null);
  return JSON.stringify({
    type: typeof node.type === 'string' ? node.type : 'component',
    marks: marks,
    children: children
  });
}

/** 去掉新建才有的模式开关之后，表单根的骨架（顺序 + 折叠区 + 控件）。 */
function bodySkeleton(node) {
  const blocks = formBlocks(node);
  const modeBar = modeBarOf(blocks);
  // formSkeleton 对「条件元素」（顶部红字）返回 null：这里一并丢掉，否则两侧会差一个块。
  return blocks.filter((item) => item !== modeBar).map(formSkeleton).filter((item) => item !== null);
}

/**
 * 去掉提供商表单的折叠外壳：`<details class="customized"><summary/><div class="customizedBody">…</div></details>`
 * 换回它 body 里的那串字段（按原顺序摊平）。
 *
 * 新建的「自定义模型 API」是平铺的、编辑页是折叠的：两棵树去掉这层壳之后应当逐块相同——
 * 验证的是「字段顺序只有一处定义」，而不是「两边长得一模一样」。
 */
function withoutSections(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map(withoutSections).filter((item) => item !== null);
  if (typeof node !== 'object') return node;
  const props = node.props || {};
  const isSection = node.type === 'details' && String(props.className || '').includes('customized');
  if (isSection) {
    const body = (node.children || []).find((child) => child && child.type === 'div'
      && String((child.props || {}).className || '').includes('customizedBody'));
    return body ? withoutSections(body.children) : null;
  }
  // 摊平：Fragment / 数组 / 条件元素（null）都化成同一层，两侧才好逐块比对。
  const children = [];
  const append = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value) append(item); return; }
    children.push(value);
  };
  for (const child of (node.children || [])) append(withoutSections(child));
  return { type: node.type, props: props, children: children };
}

test('新建「自定义模型 API」全部平铺，编辑页仍是两个折叠区：字段顺序来自同一处', () => {
  const cases = [
    {
      label: '内置协议',
      provider: {
        id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
        models: ['m'], names: {}
      }
    },
    {
      label: '自定义协议',
      provider: {
        id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
        customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
        models: ['m'], names: {}
      }
    }
  ];
  for (const item of cases) {
    const editing = loadClient();
    editing.setCatalog();
    const edited = renderForm(editing, item.provider, false);

    const creating = loadClient({ customMode: true });
    creating.setCatalog();
    const added = renderForm(creating, item.provider, true);

    // 编辑页照旧折叠：这次只动新建的那条入口。
    assert.ok(detailsOf(edited, '协议设置'), item.label + '：编辑页的「协议设置」还在');
    assert.ok(detailsOf(edited, '自定义设置'), item.label + '：编辑页的「自定义设置」还在');

    // 新建的自定义 API：两个折叠区都不再出现（自定义协议那块「请求与返回格式」编辑器自带
    // 一个 details 外壳，它是编辑器本身，不是这次要拆的「协议设置 / 自定义设置」）。
    assert.equal(detailsOf(added, '协议设置'), undefined, item.label + '：没有「协议设置」折叠区');
    assert.equal(detailsOf(added, '自定义设置'), undefined, item.label + '：没有「自定义设置」折叠区');
    assert.deepEqual(collect(formRoot(added), (node) => node.type === 'details'
      && (node.props['data-mo-image-protocol-settings'] !== undefined
        || node.props['data-mo-image-advanced'] !== undefined)), [],
    item.label + '：两个折叠区的标记一个都不剩');

    // 差的只是那层壳：去掉壳之后两棵树逐块相同（字段顺序没有第二份定义）。
    assert.deepEqual(bodySkeleton(withoutSections(added)), bodySkeleton(withoutSections(edited)),
      item.label + '：去掉折叠外壳后，新建与编辑逐块相同');
    assert.ok(modeBarOf(formBlocks(added)), item.label + '：新建有「第三方 / 本地 / 自定义」开关');
    assert.equal(modeBarOf(formBlocks(edited)), undefined, item.label + '：编辑页没有模式开关');
  }
});

test('新建「自定义模型 API」：协议 / 鉴权 / 图生图端点 / 返回格式全部平铺，没有折叠区', () => {
  const client = loadClient({ customMode: true });
  client.setCatalog();
  const node = renderForm(client, {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: [], names: {}
  }, true);

  // 两个折叠区都不再出现：这条入口的全部字段一次看全（模型行没展开时一个 details 都没有）。
  assert.equal(detailsOf(node, '协议设置'), undefined, '不再有「协议设置」折叠区');
  assert.equal(detailsOf(node, '自定义设置'), undefined, '不再有「自定义设置」折叠区');
  assert.deepEqual(collect(node, (item) => item.type === 'details'), [], '表单里没有任何 details');

  const controls = protocolPanelControls(node);
  assert.deepEqual(Object.keys(controls),
    ['API 协议', '鉴权方式', '图生图端点', '文生图返回格式', '图生图返回格式'],
    '与编辑页同一组控件、同一个顺序');
  for (const [label, control] of Object.entries(controls)) {
    assert.ok(control, label + ' 在');
    assert.equal(insideAnyDetails(node, control), false, label + ' 不被折叠区包裹');
  }

  // 顺序：协议 → 鉴权 → 图生图端点 → 返回格式。
  const order = preorder(formRoot(node));
  const at = (target) => order.indexOf(target);
  assert.ok(at(controls['API 协议']) < at(controls['鉴权方式']), '协议在前、鉴权在后');
  assert.ok(at(controls['鉴权方式']) < at(controls['图生图端点']), '图生图端点在鉴权之后');
  assert.ok(at(controls['图生图端点']) < at(controls['文生图返回格式']), '返回格式读的就是上面这套协议，排在最后');
  const detect = collect(node, (n) => n.props && n.props['data-mo-image-detect-protocol'] !== undefined)[0];
  assert.ok(detect, '识别协议按钮在');
  assert.equal(insideAnyDetails(node, detect), false, '识别协议按钮也平铺');

  // 三个主字段排在协议相关字段之前，同样不被折叠。
  const key = collect(node, (n) => n.type === 'input' && n.props.type === 'password')[0];
  const name = collect(node, (n) => n.type === 'input' && n.props.value === 'Relay')[0];
  const url = collect(node, (n) => n.type === 'input' && n.props.value === 'https://g.example/v1')[0];
  for (const [label, control] of [['API 密钥', key], ['显示名称', name], ['API 地址', url]]) {
    assert.ok(control, label + ' 在');
    assert.equal(insideAnyDetails(node, control), false, label + ' 常显');
    assert.ok(at(control) < at(controls['API 协议']), label + ' 排在协议之前');
  }
});

test('新建「自定义模型 API」：模型目录 / 路由 / 调度模型平铺在返回格式之后', () => {
  const client = loadClient({ customMode: true });
  client.setCatalog();
  const gateway = renderForm(client, {
    id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
    // 自定义协议 + 旧配置：返回格式是「两个下拉 + 一份手写 JSON」，它必须只出现一次。
    operations: { version: 1, generate: { output: 'binary' } },
    models: ['m'], names: {}
  }, true);

  assert.equal(detailsOf(gateway, '自定义设置'), undefined, '不再有「自定义设置」折叠区');
  const operations = collect(gateway, (n) => n.props && n.props['data-mo-image-operations'] === 'provider')[0];
  assert.ok(operations, '自定义协议的返回格式面板在');
  assert.notEqual(operations.type, 'details', '不再套「请求与返回格式」折叠区');
  assert.equal(collect(gateway, (n) => n.type === 'details'
    && n.props && n.props['data-mo-image-operations'] !== undefined).length, 0,
  '没有任何 details 还挂着返回格式的标记');
  assert.equal(collect(gateway, (n) => n.props && n.props['data-mo-image-operations'] === 'provider').length, 1,
    '返回格式面板只渲染一份，别因为平铺重复一遍');
  const directory = collect(gateway, (n) => String((n.props || {}).className || '').endsWith('modelCatalog'))[0];
  assert.ok(directory, '模型目录在');
  const route = collect(gateway, (n) => n.type === 'input' && n.props.name === 'route-generate')[0];
  assert.ok(route, '路由输入框在');
  for (const [label, control] of [['请求与返回格式', operations], ['模型目录', directory], ['路由', route]]) {
    assert.equal(insideAnyDetails(gateway, control), false, label + ' 平铺');
  }
  // 顺序：返回格式 → 模型目录 → 路由（协议相关在前、接入细节在后）。
  const order = preorder(formRoot(gateway));
  const at = (target) => order.indexOf(target);
  assert.ok(at(operations) < at(directory), '模型目录排在返回格式之后');
  assert.ok(at(directory) < at(route), '路由排在模型目录之后');

  // 调度模型（openai-responses 才有）同样平铺，排在路由之后。
  const responses = renderForm(client, {
    id: 'p2', name: 'Responses', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses',
    hostModel: 'gpt-5.2', models: [], names: {}
  }, true);
  const hostModel = collect(responses, (n) => n.type === 'input' && n.props.value === 'gpt-5.2')[0];
  assert.ok(hostModel, '调度模型输入框在');
  assert.equal(insideAnyDetails(responses, hostModel), false, '调度模型平铺');
  assert.equal(detailsOf(responses, '自定义设置'), undefined, '调度模型也没有折叠区包着');
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

test('自定义协议的返回格式不再套折叠区：两个下拉直接排开，JSON 编辑器跟在下面', () => {
  const client = loadClient();
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
    operations: { version: 1, generate: { method: 'POST', path: 'v1/render' } },
    models: ['m'], names: {}
  };
  const node = renderForm(client, provider);
  const panel = collect(node, (item) => item.props && item.props['data-mo-image-operations'] === 'provider')[0];
  assert.ok(panel, '返回格式面板在');
  assert.notEqual(panel.type, 'details', '不再套「请求与返回格式」details');
  assert.equal(detailsOf(node, '请求与返回格式'), undefined, '没有那个折叠区了');
  // 位置不变：它是协议这一组的最后一项（协议 → 鉴权 → 图生图端点 → 返回格式）。
  assert.equal(insideOf(detailsOf(node, '协议设置'), panel), true, '跟着协议设置走');

  // 两个下拉是本面板的第一块，和内置协议一样一行两列。
  const selects = collect(panel, (item) => item.type === 'select' && item.props['data-mo-image-output-preset']);
  assert.deepEqual(selects.map((item) => item.props['data-mo-image-output-preset']).sort(), ['edit', 'generate'],
    '文生图与图生图两个下拉都在');
  const order = preorder(panel);
  const at = (target) => order.indexOf(target);
  // 两个下拉同一行两列：与内置协议同一个排法。
  const selectRow = ancestorsOf(panel, selects[0])
    .find((item) => item.props && item.props.style && item.props.style.gridTemplateColumns);
  assert.ok(selectRow, '两个下拉要有一个横向排布的父容器');
  assert.equal(collect(selectRow, (item) => item.type === 'select').length, 2, '两个下拉在同一个父容器里');
  assert.equal(selectRow.props.style.gridTemplateColumns, 'minmax(0, 1fr) minmax(0, 1fr)', '一行两列，各占半宽');

  // 顺序：下拉 → 说明 → JSON。JSON 是自定义协议唯一能定义请求方法 / 字段映射的地方，必须保留。
  const hint = collect(panel, (item) => item.type === 'p')[0];
  const json = collect(panel, (item) => item.type === 'textarea' && item.props['data-mo-image-operations-json'] !== undefined)[0];
  assert.ok(hint, '说明文字还在');
  assert.ok(json, 'JSON 编辑器在');
  assert.ok(at(selects[0]) < at(hint), '下拉在前');
  assert.ok(at(hint) < at(json), 'JSON 跟在说明后面');
  assert.equal(JSON.parse(json.props.value).generate.method, 'POST', '把草稿里的 operations 回显出来');
});

test('JSON 编辑器只在自定义协议出现：内置协议的表单里一份都没有', () => {
  const jsonEditors = (tree) => collect(tree, (item) => item.props
    && item.props['data-mo-image-operations-json'] !== undefined);
  const cases = [
    { label: 'openai-images', provider: { id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images', models: ['gpt-image-1'], names: {} } },
    { label: 'comfyui', provider: { id: 'p2', name: 'Comfy', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', models: ['flux-dev'], names: {} } },
    { label: 'a1111', provider: { id: 'p3', name: 'A1111', baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111', models: ['sdxl'], names: {} } },
    { label: 'openai-responses', provider: { id: 'p4', name: 'Responses', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', models: ['gpt-image-1'], names: {} } }
  ];
  for (const item of cases) {
    const client = loadClient();
    client.setCatalog();
    const node = renderForm(client, item.provider);
    assert.deepEqual(jsonEditors(node), [], item.label + '：没有返回格式 JSON 编辑器');
    assert.equal(collect(node, (child) => child.props && child.props['data-mo-image-operations'] !== undefined).length, 0,
      item.label + '：也没有那块自定义协议的面板');
    // 返回格式本身照旧：两个预设下拉。
    const panel = collect(node, (child) => child.props['data-mo-image-output-presets'] === 'provider')[0];
    assert.ok(panel, item.label + '：返回格式面板在');
    assert.equal(collect(panel, (child) => child.type === 'select').length, 2, item.label + '：两个下拉都在');
  }

  // 自定义协议：有且只有一份。
  const custom = loadClient();
  custom.setCatalog();
  const customNode = renderForm(custom, {
    id: 'p5', name: 'Gateway', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
    models: ['m'], names: {}
  });
  assert.equal(jsonEditors(customNode).length, 1, '自定义协议：一份 JSON 编辑器');
});

test('自定义协议：老配置里手写的 operations 保存时原样带回', async () => {
  const client = loadClient();
  client.setCatalog();
  // 形如以前手写的那种配置：请求方法 / 字段映射 / 响应解析都在。
  const operations = {
    version: 1,
    generate: { method: 'PATCH', path: 'v1/render', transport: 'json', fields: { prompt: { path: 'input.text' } }, output: 'binary' },
    edit: { method: 'POST', path: 'v1/edit' },
    models: { method: 'GET', path: 'v1/catalog' }
  };
  let saved = null;
  const tree = client.render(client.h(client.form(), {
    provider: {
      id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
      customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
      operations: operations, models: ['m'], names: {}
    },
    isNew: false,
    onSave(next) { saved = next; },
    onClose() {},
    t: t
  }));
  const json = collect(tree, (item) => item.type === 'textarea'
    && item.props['data-mo-image-operations-json'] !== undefined)[0];
  assert.ok(json, 'JSON 编辑器把老配置回显出来');
  assert.deepEqual(JSON.parse(json.props.value), operations, '回显的就是原值');
  const save = collect(tree, (item) => item.type === 'button'
    && text(item).join('').includes('form.save')).pop();
  assert.ok(save, '保存按钮要存在');
  await save.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(saved.operations)), operations, '没动过就不许改');
  assert.equal(saved.customEndpoints.generate, 'https://g.example/v1/render', '端点照旧');
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

/**
 * 模型选项里的两块折叠区：按 data-* 标记找。
 * 输入设置的 summary 上还挂着「自动检测 / 全部解锁」两个按钮，按文案匹配不可靠。
 */
function modelSection(tree, marker) {
  return collect(tree, (item) => item.type === 'details'
    && item.props && item.props[marker] !== undefined)[0] || null;
}

test('模型选项分成输入设置与输出设置两块折叠区：默认都收起，输入在前', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
    models: ['doubao-seedream-4-0-250828'], names: {}
  };
  const row = expandModelOptions(client, provider, () => renderForm(client, provider));

  const input = modelSection(row, 'data-mo-image-input-settings');
  const output = modelSection(row, 'data-mo-image-output-settings');
  assert.ok(input, '输入设置折叠区在');
  assert.ok(output, '输出设置折叠区在');
  // 没写 open 属性 = 浏览器默认收起；写了受控的 open 反而会把用户点开的状态弹回去。
  assert.equal(input.props.open, undefined, '输入设置默认收起');
  assert.equal(output.props.open, undefined, '输出设置默认收起');

  const summaryOf = (section) => text(collect(section, (item) => item.type === 'summary')[0]).join('');
  assert.match(summaryOf(input), /输入设置/);
  assert.doesNotMatch(summaryOf(input), /高级/, '「高级（手填字段名）」这个名字不再出现');
  assert.equal(summaryOf(output), '输出设置');

  // 顺序：先填输入，再定返回格式。
  const order = preorder(row);
  assert.ok(order.indexOf(input) < order.indexOf(output), '输入设置在输出设置之前');

  // 输入设置里还是原来那一摊：参数表 / 尺寸 / 质量 / 参考图。
  assert.ok(collect(input, (item) => item.props['data-param-key'] === 'size')[0], '尺寸还在输入设置里');
  assert.ok(collect(input, (item) => item.props['data-param-key'] === 'image')[0], '参考图还在输入设置里');
  assert.equal(collect(input, (item) => item.props['data-mo-image-output-presets'] !== undefined).length, 0,
    '返回格式不在输入设置里');
  // 内置协议的输出设置就是那两个预设下拉。
  assert.ok(collect(output, (item) => item.props['data-mo-image-output-presets'] !== undefined)[0],
    '输出设置里是返回格式');
  assert.ok(collect(output, (item) => item.props['data-mo-image-output-preset'] === 'generate')[0],
    '文生图返回格式收在输出设置里');
  // 自配的网关（没有 presetId）：两块都不锁，直接能改。
  const sizeInput = collect(input, (item) => item.type === 'input' && item.props['data-param-key'] === 'size')[0];
  assert.notEqual(sizeInput.props.disabled, true, '自定义来源的输入设置不锁');
  const outputSelect = collect(output, (item) => item.type === 'select'
    && item.props['data-mo-image-output-preset'] === 'generate')[0];
  assert.notEqual(outputSelect.props.disabled, true, '自定义来源的输出设置不锁');
  assert.equal(collect(output, (item) => item.props['data-lock-key'] === 'operations')[0].props['aria-pressed'],
    'false', '锁图标显示为未锁');
});

test('预设来源：两块设置区都在但默认锁住，点锁能解锁（解锁状态会落盘）', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: ['gpt-image-1'], names: {}
  };
  const row = expandModelOptions(client, provider, () => renderForm(client, provider));
  const input = modelSection(row, 'data-mo-image-input-settings');
  const output = modelSection(row, 'data-mo-image-output-settings');
  // 两块都在：预设来源不该把整块藏起来，只该锁住（看得到、改不了）。
  assert.ok(input, '输入设置在');
  assert.ok(output, '输出设置在');
  assert.equal(input.props.open, undefined, '输入设置默认收起');
  assert.equal(output.props.open, undefined, '输出设置默认收起');

  // 输入设置：每个方框的锁都按着，框内控件全部禁用。
  assert.equal(collect(input, (item) => item.props['data-lock-key'] === 'size')[0].props['aria-pressed'], 'true',
    '尺寸方框的锁是锁上的');
  assert.equal(collect(input, (item) => item.type === 'input' && item.props['data-param-key'] === 'size')[0]
    .props.disabled, true, '锁住时尺寸输入禁用');
  assert.equal(collect(input, (item) => item.type === 'input' && item.props['data-param-key'] === 'image')[0]
    .props.disabled, true, '锁住时参考图控件禁用');

  // 输出设置：下拉摆着（看得到当前预设）但禁用，锁图标可按。
  const outputSelects = collect(output, (item) => item.type === 'select'
    && item.props['data-mo-image-output-preset']);
  assert.equal(outputSelects.length, 2, '两个返回格式下拉都在');
  for (const select of outputSelects) {
    assert.equal(select.props.disabled, true, '锁住时返回格式下拉禁用');
  }
  const lock = collect(output, (item) => item.props['data-lock-key'] === 'operations')[0];
  assert.ok(lock, '输出设置的锁在标题行');
  assert.equal(lock.props['aria-pressed'], 'true', '预设来源默认锁住');

  // 点锁解锁：下拉立刻能改，保存时落一句 locked.operations = false（沿用现有 locked，不另造字段）。
  lock.props.onClick({ preventDefault() {}, stopPropagation() {} });
  const unlockedRow = collect(renderForm(client, provider), (item) => item.props && item.props['data-row-key'] === '0')[0];
  const unlockedOutput = modelSection(unlockedRow, 'data-mo-image-output-settings');
  const unlockedSelects = collect(unlockedOutput, (item) => item.type === 'select'
    && item.props['data-mo-image-output-preset']);
  assert.equal(unlockedSelects.length, 2, '解锁后两个下拉还在');
  for (const select of unlockedSelects) {
    assert.notEqual(select.props.disabled, true, '解锁后可改');
  }
  assert.equal(collect(unlockedOutput, (item) => item.props['data-lock-key'] === 'operations')[0]
    .props['aria-pressed'], 'false', '锁图标跟随解锁');
});

test('预设来源的锁只影响 UI：已存的返回格式与输入覆盖保存后原样带回', async () => {
  const client = loadClient();
  client.setCatalog();
  const operations = { version: 1, generate: { output: 'binary' } };
  const provider = {
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
    presetId: 'openai', models: ['gpt-image-1'], names: {},
    modelOptions: {
      'gpt-image-1': {
        operations: operations,
        size: { mode: 'wh-string', field: 'image_size' },
        fields: { prompt: { path: 'prompt' } },
        params: [{ name: 'seed', type: 'number', default: '1', description: '' }]
      }
    }
  };
  let saved = null;
  const tree = client.render(client.h(client.form(), {
    provider: provider, isNew: false, onSave(next) { saved = next; }, onClose() {}, t: t
  }));
  const save = collect(tree, (item) => item.type === 'button' && text(item).join('').includes('form.save')).pop();
  assert.ok(save, '保存按钮要存在');
  await save.props.onClick();
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const entry = plain(saved.modelOptions)['gpt-image-1'];
  assert.deepEqual(entry.operations, operations, '锁住的返回格式不能因为禁用就被丢掉');
  assert.deepEqual(entry.size, { mode: 'wh-string', field: 'image_size' }, '锁住的尺寸覆盖也在');
  assert.deepEqual(entry.fields, { prompt: { path: 'prompt' } }, '字段模板原样带回');
  assert.deepEqual(entry.params, [{ name: 'seed', type: 'number', default: '1', description: '' }], '参数表原样带回');
});

test('ComfyUI 例外：预设来源的输入参数默认不锁（工作流是用户自己接的），输出设置照锁', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui',
    presetId: 'comfyui', models: ['flux.safetensors'], names: {}
  };
  const row = expandModelOptions(client, provider, () => renderForm(client, provider));
  // 输入参数：工作流的参数映射预设给不了，锁住等于让这个模型配不下去。
  // 第一把 prompt 锁现在在「输入设置」标题行（第二把在「常规」方框里，同一个键）。
  const input = modelSection(row, 'data-mo-image-input-settings');
  assert.ok(input, 'ComfyUI 的「输入设置」折叠区在');
  const inputRow = collect(input, (item) => item.type === 'summary')[0];
  assert.match(text(inputRow).join(''), /输入设置/);
  assert.equal(collect(inputRow, (item) => item.props['data-lock-key'] === 'prompt')[0].props['aria-pressed'], 'false',
    'ComfyUI 的输入参数不锁');
  const textarea = collect(input, (item) => item.type === 'textarea' && item.props['data-param-workflow']);
  assert.ok(textarea.length, '工作流编辑器还在');
  assert.notEqual(textarea[0].props.disabled, true, '工作流编辑器可用');
  // 返回格式仍然是协议定的：按预设来源锁。
  const output = modelSection(row, 'data-mo-image-output-settings');
  assert.ok(output, '输出设置在');
  assert.equal(collect(output, (item) => item.props['data-lock-key'] === 'operations')[0].props['aria-pressed'],
    'true', 'ComfyUI 的返回格式照预设来源锁住');
});

test('workflow 类适配器（ComfyUI / A1111）的输入设置与输出设置同一行结构：左标题、右端是锁', () => {
  const cases = [
    { label: 'ComfyUI', adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188', model: 'flux.safetensors' },
    { label: 'A1111', adapter: 'a1111', baseUrl: 'http://127.0.0.1:7860', model: 'sdxl.safetensors' }
  ];
  const plain = (value) => JSON.parse(JSON.stringify(value));
  for (const item of cases) {
    const client = loadClient({ preserveFormState: true });
    client.setCatalog();
    const provider = {
      id: 'p1', name: item.label, baseUrl: item.baseUrl, adapter: item.adapter,
      presetId: item.adapter, models: [item.model], names: {}
    };
    const row = expandModelOptions(client, provider, () => renderForm(client, provider));
    const input = modelSection(row, 'data-mo-image-input-settings');
    const output = modelSection(row, 'data-mo-image-output-settings');
    assert.ok(input, item.label + '：输入设置折叠区在');
    assert.ok(output, item.label + '：输出设置折叠区还在（这次没动它）');
    assert.equal(input.props.open, undefined, item.label + '：输入设置默认收起');
    assert.equal(output.props.open, undefined, item.label + '：输出设置默认收起');

    // 同一个 settingsSummary：同一个容器类、同一份两端对齐布局、同样两格。
    const inRow = collect(input, (node) => node.type === 'summary')[0];
    const outRow = collect(output, (node) => node.type === 'summary')[0];
    assert.ok(inRow && outRow, item.label + '：两行都在');
    assert.equal(inRow.props['data-mo-image-settings-row'], '', item.label + '：标题行走 settingsSummary');
    assert.equal(inRow.props.className, outRow.props.className, item.label + '：同一个容器类');
    assert.deepEqual(plain(inRow.props.style), plain(outRow.props.style), item.label + '：同一份布局样式');
    assert.equal(inRow.props.style.display, 'flex');
    assert.equal(inRow.props.style.justifyContent, 'space-between');
    assert.equal(inRow.props.style.alignItems, 'center');
    assert.equal(inRow.children.length, 2, item.label + '：左标题 + 右操作区');
    assert.deepEqual(plain(inRow.children[0].props.style), plain(outRow.children[0].props.style),
      item.label + '：标题格同一份样式');
    assert.equal(inRow.children[1].props.className, outRow.children[1].props.className,
      item.label + '：操作区同一个盒子');
    assert.deepEqual(plain(inRow.children[1].props.style), plain(outRow.children[1].props.style),
      item.label + '：操作区同一份样式');

    // 输入行右端是锁（不是自动检测），默认未上。
    assert.match(text(inRow.children[0]).join(''), /输入设置/);
    const actions = collect(inRow.children[1], (node) => node.type === 'button');
    assert.equal(actions.length, 1, item.label + '：右端只放一个控件');
    assert.equal(actions[0].props['data-lock-key'], 'prompt', item.label + '：锁复用「常规」参数表的键');
    assert.equal(actions[0].props['aria-pressed'], 'false', item.label + '：参数归部署端，默认不锁');
    assert.doesNotMatch(text(inRow).join(' '), /自动检测/, item.label + '：输入行没有自动检测');

    // 输入内容都在 details 里，工作流编辑器（ComfyUI）仍可编辑。
    assert.ok(collect(input, (node) => node.props && node.props['data-param-box'] === 'common')[0],
      item.label + '：常规参数表在 details 里');
    const textareas = collect(input, (node) => node.type === 'textarea');
    if (item.adapter === 'comfyui') {
      assert.equal(textareas.length, 1, 'ComfyUI：工作流编辑器在 details 里');
      assert.notEqual(textareas[0].props.disabled, true, 'ComfyUI：工作流编辑器仍可编辑');
    } else {
      assert.equal(textareas.length, 0, 'A1111：没有工作流编辑器');
    }

    // 输入在前、输出在后（这次只换输入的包法，顺序不变）。
    const order = preorder(row);
    assert.ok(order.indexOf(input) < order.indexOf(output), item.label + '：输入设置在输出设置之前');
  }
});

test('输入设置与输出设置挂在同一个 .modelRow 下：左右边缘与右端锁的 x 相同', () => {
  // 回归：输入设置曾多套一层 div.modelAdvanced（带 2px 4px 内边距），输出设置却直接挂在
  // .modelRow 上——两行的左右边缘因此差 4px，右端的锁一个偏左、一个偏右、行高也略有差异。
  // 现在两块 details 是同一层的兄弟节点：父节点、内联样式、从锁到折叠区那一串祖先都同构。
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    { label: 'ComfyUI', adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188', model: 'flux.safetensors' },
    { label: 'A1111', adapter: 'a1111', baseUrl: 'http://127.0.0.1:7860', model: 'sdxl.safetensors' }
  ];
  for (const item of cases) {
    const client = loadClient({ preserveFormState: true });
    client.setCatalog();
    const provider = {
      id: 'p1', name: item.label, baseUrl: item.baseUrl, adapter: item.adapter,
      presetId: item.adapter, models: [item.model], names: {}
    };
    const render = () => renderForm(client, provider);
    expandModelOptions(client, provider, render);
    const tree = render();
    const row = collect(tree, (node) => String((node.props || {}).className || '').includes('modelRow'))[0];
    assert.ok(row, item.label + '：模型行在');
    const input = modelSection(tree, 'data-mo-image-input-settings');
    const output = modelSection(tree, 'data-mo-image-output-settings');
    assert.ok(input && output, item.label + '：两块折叠区都在');

    // ① 结构对等：父节点就是同一个 .modelRow，中间没有夹任何容器。
    const inputParent = parentOf(tree, input);
    const outputParent = parentOf(tree, output);
    assert.ok(inputParent && outputParent, item.label + '：两块折叠区都有父节点');
    assert.equal(inputParent, outputParent, item.label + '：两块折叠区挂在同一个父节点下');
    assert.equal(inputParent, row, item.label + '：父节点就是 .modelRow');
    assert.equal(collect(row, (node) => String((node.props || {}).className || '').includes('modelAdvanced')).length, 0,
      item.label + '：div.modelAdvanced 那层包装已经删掉');

    // ② 样式链对等：同一个 grid 落位、同一份宽度 → 左右边缘重合。
    assert.deepEqual(plain(input.props.style), plain(output.props.style),
      item.label + '：两块折叠区同一份内联样式（grid-column / width / min-width）');
    assert.equal(input.props.style.gridColumn, '1 / -1', item.label + '：输入设置横跨整行');
    assert.equal(input.props.style.width, '100%', item.label + '：宽度不靠父容器的内边距凑');
    assert.equal(input.props.style.minWidth, 0);

    // ③ 锁的 x 相同：从锁往上到折叠区那一串祖先逐层同构（层数、类名、内联样式都一样）。
    const pathTo = (target, node = tree, trail = []) => {
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
    const lockOf = (section) => collect(section, (node) => node.type === 'button'
      && node.props['data-lock-key'] !== undefined)[0] || null;
    const inLock = lockOf(input);
    const outLock = lockOf(output);
    assert.ok(inLock && outLock, item.label + '：两行右端都是锁');
    const chainOf = (section, lock) => {
      const path = pathTo(lock);
      assert.ok(path, item.label + '：锁在树上');
      return path.slice(path.indexOf(section)).reverse();
    };
    const inChain = chainOf(input, inLock);
    const outChain = chainOf(output, outLock);
    assert.equal(inChain.length, 3, item.label + '：锁 → 操作区 → 标题行 → 折叠区');
    assert.equal(inChain.length, outChain.length, item.label + '：两行的祖先层数相同');
    const shapeOf = (chain) => chain.map((node) => ({
      className: String(node.props.className || ''),
      style: plain(node.props.style || {})
    }));
    assert.deepEqual(shapeOf(inChain), shapeOf(outChain),
      item.label + '：从锁到折叠区逐层同构（锁因此在同一条竖线上）');
    // 锁本身也不带内边距：右边缘与按钮式控件对齐。
    assert.equal(inLock.props.style.padding, 0, item.label + '：输入行的锁没有按钮内边距');
    assert.deepEqual(plain(inLock.props.style), plain(outLock.props.style), item.label + '：两把锁同一份样式');
  }
});

test('自定义提供商的模型选项两块都在，输出设置里直接是手写 JSON（不再套一层）', () => {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const provider = {
    id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
    models: ['m'], names: {}
  };
  const row = expandModelOptions(client, provider, () => renderForm(client, provider));
  const input = modelSection(row, 'data-mo-image-input-settings');
  const output = modelSection(row, 'data-mo-image-output-settings');
  assert.ok(input, '输入设置在');
  assert.ok(output, '输出设置也在');
  const bodyOfOutput = collect(output, (item) => String(item.props.className || '').includes('customizedBody'))[0];
  assert.equal(collect(bodyOfOutput, (item) => item.type === 'details').length, 0,
    '输出设置里不再套一层「请求与返回格式」：两层折叠区只为同一个 JSON 框');
  const textarea = collect(output, (item) => item.type === 'textarea')[0];
  assert.ok(textarea, 'JSON 输入框收在输出设置里');
  assert.notEqual(textarea.props.disabled, true, '自定义来源不锁，直接能改');
  assert.ok(collect(output, (item) => item.props['data-mo-image-operations'] === 'm')[0],
    '模型级返回格式的标记还在');
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

/** `.modelRow` 的直接子项（就是 DOM 子元素）：null 丢掉，数组与 Fragment 展开。 */
function modelRowChildren(row) {
  const out = [];
  for (const child of row.children || []) {
    if (child === null || child === undefined) continue;
    if (Array.isArray(child)) { out.push(...child); continue; }
    if (child.type === 'Fragment') { out.push(...(child.children || [])); continue; }
    out.push(child);
  }
  return out;
}

/**
 * 模型行第 1 行里的五个控件（与 DSH 设置页同一套）：拖动把手 / ID / 展开 / 删除 / 显示名称。
 * 返回 '' 的是展开面板——它们必须自己横跨整行，不能作为普通网格项参与排版。
 */
function modelRowControlRole(item) {
  const props = item.props || {};
  if (item.type === 'button') {
    if (props['aria-keyshortcuts']) return 'drag';
    if (typeof props['aria-expanded'] === 'boolean') return 'toggle';
    if (String(props['aria-label'] || '').startsWith('form.deleteModel')) return 'delete';
    return '';
  }
  if (item.type === 'label') {
    if (String(props.className || '').includes('modelName')) return 'name';
    if (collect(item, (node) => node.type === 'input')[0]) return 'id';
  }
  return '';
}

/** 展开面板的种类：输入设置 / 输出设置 / 自定义 JSON / 模型参数。 */
function modelRowPanelKind(item) {
  const props = item.props || {};
  if (props['data-mo-image-input-settings'] !== undefined) return 'inputSettings';
  if (props['data-mo-image-output-settings'] !== undefined) return 'outputSettings';
  if (props['data-mo-image-output-presets'] !== undefined) return 'outputPresets';
  if (props['data-mo-image-operations'] !== undefined) return 'operations';
  return String(props.className || '') || String(item.type);
}

/**
 * 模型行的落位模型（只用来检查「谁会被排进第 1 列」）。
 *
 * 宿主样式表里 `.modelRow` 是 5 列网格（DSH ModelsSection：auto / 1.4fr / 1fr / auto / auto），
 * 没有显式 grid-column 的子项按 DOM 顺序依次占列；`grid-column: 1 / -1` 的面板自己起一行、
 * 横跨整行。列模板与窄宽度重排都归宿主，所以测试不复述列宽，只复述「5 列 + 顺序占列」这条
 * 布局协议——插件一旦把列定义内联抄回来，前面那条断言就会先红。
 */
function modelRowPlacement(row) {
  const COLUMNS = 5;
  const cells = [];
  let column = 1;
  for (const item of modelRowChildren(row)) {
    const style = item.props.style || {};
    if (style.gridColumn === '1 / -1') {
      cells.push({ item: item, columnStart: 1, span: COLUMNS });
      column = 1;
      continue;
    }
    if (column > COLUMNS) column = 1;
    cells.push({ item: item, columnStart: column, span: 1 });
    column += 1;
  }
  return cells;
}

test('模型行展开：面板整行铺开，第 1 列只留给拖动把手，列模板归宿主', () => {
  // 两种来源各测一遍：展开后都是「模型参数」+「输出设置」两块面板；
  // 输出设置里的内容随协议走（内置协议是两个预设下拉，自定义协议是手写 JSON）。
  const cases = [
    {
      label: '内置协议',
      provider: {
        id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
        models: ['doubao-seedream-4-0-250828'], names: { 'doubao-seedream-4-0-250828': 'Doubao Seedream' }
      },
      panels: ['outputSettings', 'inputSettings'],
      output: 'data-mo-image-output-presets'
    },
    {
      label: '自定义协议',
      provider: {
        id: 'p1', name: 'Gateway', baseUrl: '', adapter: 'custom',
        customEndpoints: { generate: 'https://g.example/v1/render', edit: '', models: '' },
        models: ['m'], names: {}
      },
      panels: ['outputSettings', 'inputSettings'],
      output: 'data-mo-image-operations'
    }
  ];

  for (const item of cases) {
    const client = loadClient({ preserveFormState: true });
    client.setCatalog();
    const provider = item.provider;
    const rowOf = (tree) => collect(tree, (node) => String(node.props.className || '').includes('modelRow'))[0];
    const collapsed = rowOf(renderForm(client, provider));
    assert.ok(collapsed, item.label + '：模型行在');

    // 列模板（以及 display / gap / align）都在宿主样式表里：内联一份就会盖住宿主的
    // @container 窄宽度重排，还变成一份不会跟着 DSH 升级的副本。
    const collapsedStyle = collapsed.props.style || {};

    const render = () => renderForm(client, provider);
    expandModelOptions(client, provider, render);
    const expanded = rowOf(render());

    // c) 展开前后列模板一模一样（而且一直是宿主的，不是插件内联的）。
    assert.equal(expanded.props.style && expanded.props.style.gridTemplateColumns,
      collapsedStyle.gridTemplateColumns,
      item.label + '：展开前后列模板不变');

    // 行里只有面板能写 grid-column / grid-row：五个控件的位置由宿主样式表的类规则决定。
    for (const [state, row] of [['展开前', collapsed], ['展开后', expanded]]) {
      const rowStyle = row.props.style || {};
      for (const key of ['display', 'gridTemplateColumns', 'alignItems', 'gap']) {
        assert.equal(rowStyle[key], undefined,
          item.label + '：' + state + '的 .modelRow ' + key + ' 归宿主样式表');
      }
      for (const child of modelRowChildren(row)) {
        const style = child.props.style || {};
        assert.equal(style.gridColumn === undefined || style.gridColumn === '1 / -1', true,
          item.label + '：' + state + '不内联控件列位');
        assert.equal(style.gridRow, undefined, item.label + '：' + state + '不内联控件行位');
      }
    }

    // a) 每个面板型直接子项都横跨整行。漏一个，它就会被当成下一个网格项排进第 1 列，
    //    把 auto 轨道撑大、压塌同一列里的两个输入框。
    const panels = modelRowChildren(expanded).filter((child) => !modelRowControlRole(child));
    assert.deepEqual(panels.map(modelRowPanelKind).sort(), item.panels.slice().sort(),
      item.label + '：展开后正好是这些面板');
    for (const panel of panels) {
      const style = panel.props.style || {};
      assert.equal(style.gridColumn, '1 / -1',
        item.label + '：' + modelRowPanelKind(panel) + ' 面板要横跨整行');
      assert.equal(style.minWidth, 0, item.label + '：' + modelRowPanelKind(panel) + ' 面板要能压缩');
    }
    // 返回格式收在「输出设置」里，内容随协议走；模型参数面板里没有返回格式。
    const output = panels.find((panel) => modelRowPanelKind(panel) === 'outputSettings');
    assert.ok(collect(output, (node) => node.props && node.props[item.output] !== undefined)[0],
      item.label + '：返回格式在输出设置里');
    const params = panels.find((panel) => modelRowPanelKind(panel) === 'inputSettings');
    assert.equal(collect(params, (node) => node.props && node.props[item.output] !== undefined).length, 0,
      item.label + '：模型参数面板里没有返回格式');

    // b) 展开前后，只占第 1 列的直接子项只有拖动把手一个。
    for (const [state, row] of [['展开前', collapsed], ['展开后', expanded]]) {
      const firstColumn = modelRowPlacement(row)
        .filter((cell) => cell.columnStart === 1 && cell.span === 1)
        .map((cell) => cell.item);
      assert.equal(firstColumn.length, 1, item.label + '：' + state + '第 1 列只有一格');
      assert.equal(modelRowControlRole(firstColumn[0]), 'drag',
        item.label + '：' + state + '第 1 列是拖动把手');
    }

    // 两个输入框仍然能收缩；input 不支持 text-overflow，别再写这条无效样式。
    const fields = modelRowChildren(expanded)
      .filter((child) => ['id', 'name'].includes(modelRowControlRole(child)));
    assert.equal(fields.length, 2, item.label + '：模型 ID 与显示名称两个输入框都在');
    for (const label of fields) {
      const input = collect(label, (node) => node.type === 'input')[0];
      assert.ok(input, item.label + '：输入框在');
      assert.equal(input.props.style.minWidth, 0, item.label + '：输入框能收缩（min-width: 0）');
      assert.equal(input.props.style.textOverflow, undefined,
        item.label + '：input 不支持 text-overflow，不能写');
    }
  }
});

// ---------------------------------------------------------------------------
// 样式常量的等价替换护栏：渲染树里的内联样式必须与抽常量之前一字不差
// ---------------------------------------------------------------------------

/**
 * 表单里重复 ≥3 次的样式组合抽成了模块级常量（FIELD_LABEL_ROW_STYLE / PARAM_ROW_STYLE /
 * FLUSH_TEXT_STYLE / CHOICE_INPUT_STYLE / FIXED_CONTROL_STYLE / ADD_ROW_STYLE，
 * 以及选区皮肤的 STATIC_ROW_STYLE）。抽常量只许换写法，不许改视觉——值必须逐字段相同。
 *
 * 所以这里把三张有代表性的表单各录一份内联样式基线
 * （test/fixtures/provider-form-styles.baseline.json）：先序遍历渲染树，每个带 style 的节点
 * 记一行「节点类型|按字段名排序的样式」，重构后逐行比对。任何一条样式的字段或值变了
 * （哪怕只是 gap 6 → 8），那一行就对不上。
 *
 * 覆盖边界：这三张表单走的是「展开模型选项」这条路径，把提供商表单、输入设置（参数表 /
 * 工作流编辑器 / 质量与尺寸行）与输出设置（预设下拉）的内联样式都录进来了；
 * 选区皮肤的 cmes-row 由 test/client-selector-skin.test.mjs 单独锁住。
 *
 * 重建基线（只在**有意**改视觉时用，且单独提交让基线 diff 能被 review）：
 *   node --input-type=module -e "import fs from 'node:fs'; import { buildStyleSnapshot } from './test/client-protocol-panel.test.mjs'; fs.writeFileSync('test/fixtures/provider-form-styles.baseline.json', JSON.stringify(buildStyleSnapshot(), null, 2) + '\n')"
 */

const STYLE_BASELINE_URL = new URL('./fixtures/provider-form-styles.baseline.json', import.meta.url);
let STYLE_BASELINE = null;
let STYLE_BASELINE_ERROR = null;
try {
  STYLE_BASELINE = JSON.parse(readFileSync(STYLE_BASELINE_URL, 'utf8'));
} catch (error) {
  STYLE_BASELINE_ERROR = error;
}

/** 一条内联样式的稳定写法：字段名排序，值取 JSON 形态（与对象里的类型一一对应）。 */
function styleLine(type, style) {
  const plain = JSON.parse(JSON.stringify(style));
  const fields = Object.keys(plain).sort()
    .map((name) => name + '=' + JSON.stringify(plain[name])).join(';');
  return String(type) + '|' + fields;
}

/** 渲染树里所有内联样式，按先序（= DOM 顺序）拍成行。 */
function styleLines(node) {
  return preorder(node)
    .filter((item) => item.props && item.props.style && typeof item.props.style === 'object')
    .map((item) => styleLine(item.type, item.props.style));
}

/**
 * 三张覆盖不同分支的表单：ComfyUI（工作流编辑器 / 参数提示）、内置 OpenAI Images
 * （参数表 / 质量与尺寸行 / 预设下拉）、A1111（自己那套参数提示）。
 */
const STYLE_CASES = [
  {
    name: 'comfyui-expanded',
    provider: {
      id: 'p1', name: 'Comfy', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui',
      models: ['flux-dev'], names: {}
    }
  },
  {
    name: 'openai-images-expanded',
    provider: {
      id: 'p1', name: 'Relay', baseUrl: 'https://g.example/v1', adapter: 'openai-images',
      models: ['gpt-image-1'], names: {}
    }
  },
  {
    name: 'a1111-expanded',
    provider: {
      id: 'p1', name: 'A1111', baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111',
      models: ['sdxl'], names: {}
    }
  }
];

/** 新客户端 + 展开模型选项，再取整张表单。 */
function renderStyleCase(item) {
  const client = loadClient({ preserveFormState: true });
  client.setCatalog();
  const render = () => renderForm(client, item.provider);
  expandModelOptions(client, item.provider, render);
  return render();
}

export function buildStyleSnapshot() {
  const snapshot = {};
  for (const item of STYLE_CASES) snapshot[item.name] = styleLines(renderStyleCase(item));
  return snapshot;
}

test('样式常量是等价替换：渲染树逐节点的内联样式与基线完全一致', () => {
  assert.equal(STYLE_BASELINE_ERROR, null,
    '读不到基线 test/fixtures/provider-form-styles.baseline.json：'
    + (STYLE_BASELINE_ERROR && STYLE_BASELINE_ERROR.message));
  const snapshot = buildStyleSnapshot();
  for (const item of STYLE_CASES) {
    const expected = STYLE_BASELINE[item.name];
    const actual = snapshot[item.name];
    assert.ok(Array.isArray(expected), item.name + '：基线里没有这一组');
    assert.ok(actual.length > 0, item.name + '：一个带样式的节点都没渲染出来');
    // 先逐行比对，把第一处差异直接说清楚（deepEqual 的 diff 对一行字符串没什么帮助）。
    const limit = Math.max(actual.length, expected.length);
    for (let index = 0; index < limit; index += 1) {
      if (actual[index] === expected[index]) continue;
      assert.fail(item.name + '：第 ' + index + ' 个带样式的节点变了\n'
        + '  基线：' + expected[index] + '\n'
        + '  现在：' + actual[index]);
    }
  }
});

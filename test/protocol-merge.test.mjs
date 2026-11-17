/**
 * 协议收敛：六条 OpenAI Images 家族协议 → 一条 openai-images + 协议级选项。
 *
 * 这里锁四件事：
 *
 *   1. **旧 id 的映射**：老配置里的 dall-e-3 / gpt-image / together / localai /
 *      siliconflow / volcengine-ark 升级成 openai-images + 对应的 `edit` 选项；
 *      幂等（已经是新值的不能再变），而且 presetId / modelOptions 原样保留。
 *   2. **旧 id 与新 id 产出同一个请求体**：同一模型经旧 id（升级后）与新 id 发出的
 *      path / headers / body 逐字节一致——合并只许改名字，不许改线上请求。
 *   3. **选项本身**：`edit:'same' | 'none'` 的编辑地址与编码、`auth:'api-key'` 的鉴权头。
 *   4. 清单里不再有那六个 id（下拉少 6 项）。
 *
 * 基线层面的「旧协议 body 没变」由 test/adapter-body-regression.test.mjs 的 variants 段锁着。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listAdapters, resolveAdapter, prepareGenerate, prepareEdit, adapterSupportsKind,
  adapterManifest, LEGACY_PROTOCOL_ALIASES
} from '../lib/adapters.js';
import { normalizeConfig } from '../lib/config-store.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const IMAGE = { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };

/** 每条旧协议用什么模型 / 地址复现它当年的形态（和基线表的输入一致）。 */
const LEGACY = {
  'dall-e-3': { model: 'dall-e-3', baseUrl: 'https://api.openai.com/v1', options: {} },
  'gpt-image': { model: 'gpt-image-2.5-flare', baseUrl: 'https://api.openai.com/v1', options: {} },
  'together': { model: 'black-forest-labs/FLUX.1-schnell', baseUrl: 'https://api.together.xyz/v1', options: { edit: 'none' } },
  'localai': { model: 'localai-model', baseUrl: 'http://127.0.0.1:8080/v1', options: { edit: 'none' } },
  'siliconflow': { model: 'Qwen/Qwen-Image', baseUrl: 'https://api.siliconflow.cn/v1', options: { edit: 'same' } },
  'volcengine-ark': { model: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', options: { edit: 'same' } }
};

function providerOf(id, extra) {
  return Object.assign({ id: 'p1', name: id, baseUrl: LEGACY[id].baseUrl, adapter: id, models: [LEGACY[id].model] }, extra || {});
}

/** 把一家提供商过一遍配置规范化（就是老配置升级时走的那个函数）。 */
function upgraded(provider) {
  return normalizeConfig({ providers: [provider], active: { providerId: 'p1', model: '' } }).providers[0];
}

function requestOf(kind, provider, model) {
  const adapter = resolveAdapter(provider, model);
  const input = {
    model,
    prompt: 'a cat sitting on a windowsill',
    negativePrompt: 'blurry, text',
    fitted: { width: 1024, height: 1024, size: '1024x1024' },
    quality: null,
    images: [IMAGE]
  };
  const built = kind === 'edit'
    ? prepareEdit(adapter, provider, input, new Set(), adapter.editFields[0] || 'image')
    : prepareGenerate(adapter, provider, input, new Set());
  return { id: adapter.id, path: built.path, headers: built.headers, body: built.body };
}

/** multipart 与 JSON 两种 body 都摊成可比的字符串。 */
function bodyText(body) {
  if (typeof body === 'string') return body;
  const entries = [];
  for (const [key, value] of body.entries()) {
    entries.push([key, typeof value === 'string' ? value : 'file:' + value.name + ':' + value.size]);
  }
  return JSON.stringify(entries);
}

function sameRequest(kind, left, right, label) {
  assert.equal(left.path, right.path, label + ' 的 ' + kind + ' 请求地址变了');
  assert.equal(bodyText(left.body), bodyText(right.body), label + ' 的 ' + kind + ' 请求体变了');
  assert.deepEqual(left.headers, right.headers, label + ' 的 ' + kind + ' 请求头变了');
}

/* ------------------------------------------------------------ 1. 旧 id 映射 */

test('旧协议 id 映射成 openai-images + 对应的 edit 选项', () => {
  for (const [legacy, spec] of Object.entries(LEGACY)) {
    const mapped = upgraded(providerOf(legacy));
    assert.equal(mapped.adapter, 'openai-images', legacy + ' 没有映射');
    const expected = Object.keys(spec.options).length ? spec.options : undefined;
    assert.deepEqual(mapped.protocolOptions, expected, legacy + ' 的选项映射不对');
  }
});

test('映射是幂等的：已经是新值的配置再跑一遍什么都不变', () => {
  for (const legacy of Object.keys(LEGACY)) {
    const once = upgraded(providerOf(legacy));
    const twice = upgraded(once);
    assert.deepEqual(twice, once, legacy + ' 第二次规范化又变了');
  }
  // 新值本身（包括用户选的选项）也不该被迁移表碰到。
  for (const options of [{}, { edit: 'none' }, { edit: 'same' }, { edit: 'edits' }, { edit: 'edits', auth: 'api-key' }]) {
    const provider = { id: 'p9', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images', models: ['flux-1'], protocolOptions: options };
    const once = upgraded(provider);
    assert.equal(once.adapter, 'openai-images');
    // 空选项不落盘（没写 = 默认值），有内容才存。
    assert.deepEqual(once.protocolOptions, Object.keys(options).length ? options : undefined);
    assert.deepEqual(upgraded(once), once, 'openai-images 的配置第二次规范化变了');
  }
});

test('映射保留 presetId 与 modelOptions（锁与覆盖不能丢）', () => {
  const modelOptions = {
    'dall-e-3': {
      size: { field: 'size', mode: 'wh-string' },
      quality: { field: 'quality', options: ['standard', 'hd'] },
      locked: { size: true, quality: false }
    }
  };
  const provider = providerOf('dall-e-3', { presetId: 'openai', modelOptions: modelOptions });
  const mapped = upgraded(provider);
  assert.equal(mapped.presetId, 'openai', 'presetId 丢了：锁的默认值与一键配置都会失效');
  assert.deepEqual(mapped.modelOptions, modelOptions, 'modelOptions 变了：用户的覆盖与锁被改过');
});

test('provider.protocol 上的旧 id 也一起改掉', () => {
  const mapped = upgraded({ id: 'p2', name: 'legacy', baseUrl: 'https://api.siliconflow.cn/v1', adapter: '', protocol: 'siliconflow', models: ['Qwen/Qwen-Image'] });
  assert.equal(mapped.protocol, 'openai-images');
  assert.equal(mapped.adapter, 'openai-images');
  assert.deepEqual(mapped.protocolOptions, { edit: 'same' });
});

test('映射表与实现一致：LEGACY_PROTOCOL_ALIASES 里就是这六条', () => {
  assert.deepEqual(Object.keys(LEGACY_PROTOCOL_ALIASES).sort(), Object.keys(LEGACY).sort());
  for (const [legacy, spec] of Object.entries(LEGACY)) {
    assert.equal(LEGACY_PROTOCOL_ALIASES[legacy].adapter, 'openai-images', legacy);
    const declared = LEGACY_PROTOCOL_ALIASES[legacy].protocolOptions;
    assert.deepEqual(declared, spec.options, legacy + ' 的迁移选项与测试表不一致');
  }
});

test('清单里没有那六条协议了（下拉少 6 项）', () => {
  const ids = listAdapters().map((entry) => entry.id);
  for (const legacy of Object.keys(LEGACY)) assert.equal(ids.includes(legacy), false, legacy + ' 还留在协议清单里');
  assert.equal(ids.length, 20, '协议数变了');
});

/* -------------------------------------------- 2. 旧 id 与新 id 的请求体一致 */

for (const [legacy, spec] of Object.entries(LEGACY)) {
  test('旧 id ' + legacy + ' 与新 id 产出的请求逐字节一致', () => {
    const oldProvider = upgraded(providerOf(legacy));
    const newProvider = upgraded({
      id: 'p1', name: legacy, baseUrl: spec.baseUrl, adapter: 'openai-images',
      models: [spec.model], protocolOptions: spec.options
    });
    // 升级后的老配置必须与新写法**完全等价**：后面的请求一致是从这里来的。
    assert.deepEqual(oldProvider, newProvider, legacy + ' 升级后的配置与新写法不等价');

    for (const kind of ['generate', 'edit']) {
      const before = requestOf(kind, oldProvider, spec.model);
      const after = requestOf(kind, newProvider, spec.model);
      assert.equal(after.id, 'openai-images');
      sameRequest(kind, before, after, legacy);
    }
  });
}

/* --------------------------------------------------------- 3. 选项本身 */

test("edit:'same' 把编辑发到 /images/generations，参考图走 JSON 的 image", () => {
  const provider = { id: 'p3', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images', protocolOptions: { edit: 'same' } };
  const adapter = resolveAdapter(provider, 'flux-1');
  assert.equal(adapter.endpoints.edit, '/images/generations');
  assert.equal(adapter.transport.edit, 'json');
  assert.equal(adapterSupportsKind(adapter, 'edit'), true);

  const built = prepareEdit(adapter, provider, {
    model: 'flux-1', prompt: 'p', fitted: { width: 1024, height: 1024, size: '1024x1024' }, images: [IMAGE]
  }, new Set(), 'image');
  assert.equal(built.path, '/images/generations');
  const body = JSON.parse(built.body);
  assert.match(String(body.image), /^data:image\/png;base64,/);
});

test("edit:'none' 明确声明不支持图生图（地址为空、传输仍是 JSON）", () => {
  const provider = { id: 'p4', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images', protocolOptions: { edit: 'none' } };
  const adapter = resolveAdapter(provider, 'flux-1');
  assert.equal(adapter.endpoints.edit, '');
  assert.equal(adapter.transport.edit, 'json');
  assert.equal(adapterSupportsKind(adapter, 'edit'), false);
  assert.equal(adapterSupportsKind(adapter, 'generate'), true);
  // 清单里给客户端的地址也要跟着变（编辑那条显示成「不支持」）。
  const manifest = adapterManifest().find((item) => item.id === 'openai-images');
  const editOption = manifest.options.find((option) => option.name === 'edit');
  assert.equal(editOption.routes.none.edit, '');
  assert.equal(editOption.routes.same.edit, '/images/generations');
  assert.equal(editOption.routes.edits.edit, '/images/edits');
  assert.deepEqual(editOption.values, ['edits', 'same', 'none']);
  assert.equal(editOption.default, 'edits');
});

test("默认（不写选项）仍然是 /images/edits + multipart", () => {
  const provider = { id: 'p5', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images' };
  const adapter = resolveAdapter(provider, 'flux-1');
  assert.equal(adapter.endpoints.edit, '/images/edits');
  assert.equal(adapter.transport.edit, 'multipart');
  assert.deepEqual(adapter.editFields, ['image[]', 'image']);
});

test("auth:'api-key' 用 api-key 头，默认仍是 Bearer", () => {
  const bearer = { id: 'p6', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images', key: 'sk-test' };
  const apiKey = { id: 'p7', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images', key: 'sk-test', protocolOptions: { auth: 'api-key' } };
  const input = { model: 'flux-1', prompt: 'p', fitted: { width: 1024, height: 1024, size: '1024x1024' } };

  const withBearer = prepareGenerate(resolveAdapter(bearer, 'flux-1'), bearer, input, new Set());
  assert.equal(withBearer.headers.Authorization, 'Bearer sk-test');
  assert.equal(withBearer.headers['api-key'], undefined);

  const withApiKey = prepareGenerate(resolveAdapter(apiKey, 'flux-1'), apiKey, input, new Set());
  assert.equal(withApiKey.headers['api-key'], 'sk-test');
  assert.equal(withApiKey.headers.Authorization, undefined);
  // 鉴权形态只改头，不改 body。
  assert.equal(bodyText(withApiKey.body), bodyText(withBearer.body));
});

test('非法选项值被忽略，回落到协议默认', () => {
  const provider = { id: 'p8', name: 'relay', baseUrl: 'https://gateway.example.com/v1', adapter: 'openai-images', protocolOptions: { edit: 'bogus', auth: 'bogus' } };
  const adapter = resolveAdapter(provider, 'flux-1');
  assert.equal(adapter.endpoints.edit, '/images/edits');
  assert.equal(adapter.headers, undefined);
  const headers = prepareGenerate(adapter, provider, { model: 'flux-1', prompt: 'p', fitted: { omit: true, size: 'none' } }, new Set()).headers;
  assert.equal(headers.Authorization, undefined, '没有 key 就不发鉴权头');
});

test('选项只跟着声明了它的协议走：别的协议不受影响', () => {
  const custom = { id: 'p9', name: 'custom', baseUrl: 'https://gateway.example.com/v1', adapter: 'custom', protocolOptions: { edit: 'none' } };
  const adapter = resolveAdapter(custom, 'anything');
  assert.equal(adapter.id, 'custom');
  assert.equal(adapter.endpoints.edit, '');
  // custom 的地址是用户填的，选项不参与：edit 还是空串（用户没填）。
  const filled = { ...custom, customEndpoints: { generate: 'https://x.example/v1/images/generations', edit: 'https://x.example/v1/images/edits', models: '' } };
  assert.equal(resolveAdapter(filled, 'anything').endpoints.edit, 'https://x.example/v1/images/edits');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImageStatus, canEditModel, editCapableModels, normalizeKeySource, pickAutoEditModel, STATUS_CONTRACT } from '../lib/status.js';
import { resolveAdapter } from '../lib/adapters.js';

const defaults = { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true };
const okKey = { ok: true, source: 'env', ref: 'MO_IMAGE_TEST_API_KEY' };

function configOf(provider, active, extraDefaults) {
  return {
    version: 1,
    providers: [provider],
    active,
    defaults: { ...defaults, ...(extraDefaults || {}) }
  };
}

test('optionalKey 的本地模型算已配置，Key 来源是 optional', () => {
  const provider = {
    id: 'p1', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188',
    adapter: 'comfyui', optionalKey: true, models: ['moss.safetensors']
  };
  const status = buildImageStatus({
    config: configOf(provider, { providerId: 'p1', model: 'moss.safetensors' }),
    version: '0.7.0',
    key: { ok: true, source: 'optional', ref: '' }
  });
  assert.equal(status.contract, STATUS_CONTRACT);
  assert.equal(status.version, '0.7.0');
  assert.equal(status.configured, true);
  assert.equal(status.missing, '');
  assert.equal(status.key.source, 'optional');
  assert.match(status.message, /无需 API Key/);
  assert.equal(status.capabilities.maxRefs, 16);
});

test('Auto 模式算已配置，候选模型都支持编辑时 edit=true', () => {
  const provider = {
    id: 'p2', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    adapter: '', models: ['gpt-image-2.5-flare', 'gpt-image-1']
  };
  const status = buildImageStatus({
    config: configOf(provider, { providerId: 'p2', model: 'auto' }),
    version: '0.7.0',
    key: okKey
  });
  assert.equal(status.auto, true);
  assert.equal(status.model, 'auto');
  assert.equal(status.configured, true);
  assert.equal(status.capabilities.generate, true);
  assert.equal(status.capabilities.edit, true);
  assert.deepEqual(status.models, ['gpt-image-2.5-flare', 'gpt-image-1']);
});

test('Auto 下候选模型不支持编辑时 edit=false', () => {
  const provider = {
    id: 'p3', name: 'Ideogram', baseUrl: 'https://api.ideogram.ai',
    adapter: '', models: ['ideogram-3']
  };
  const status = buildImageStatus({
    config: configOf(provider, { providerId: 'p3', model: 'auto' }),
    version: '0.7.0',
    key: okKey
  });
  assert.equal(status.auto, true);
  assert.equal(status.configured, true);
  assert.equal(status.capabilities.edit, false);
  assert.deepEqual(status.capabilities.editModels, []);
});

test('Auto 下自动忽略不能图生图的模型，只列可改图的', () => {
  const provider = {
    id: 'p12', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui',
    optionalKey: true, models: ['flux.safetensors', 'moss.safetensors'],
    modelOptions: { 'moss.safetensors': { workflow: '{}', mapping: { image: null } } }
  };
  const status = buildImageStatus({
    config: configOf(provider, { providerId: 'p12', model: 'auto' }),
    version: '0.8.0',
    key: { ok: true, source: 'optional', ref: '' }
  });
  assert.equal(status.capabilities.edit, true);
  assert.deepEqual(status.capabilities.editModels, ['flux.safetensors']);
  assert.deepEqual(editCapableModels(provider, provider.models), ['flux.safetensors']);
  assert.deepEqual(pickAutoEditModel(provider, provider.models, ''), { model: 'flux.safetensors', capable: ['flux.safetensors'] });
  assert.deepEqual(pickAutoEditModel(provider, provider.models, 'moss.safetensors'), { model: '', capable: ['flux.safetensors'] });
});

test('选中的模型不在目录里算没选模型', () => {
  const provider = {
    id: 'p4', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    adapter: '', models: ['gpt-image-2.5-flare']
  };
  const status = buildImageStatus({
    config: configOf(provider, { providerId: 'p4', model: 'gone-model' }),
    version: '0.7.0',
    key: okKey
  });
  assert.equal(status.configured, false);
  assert.equal(status.model, '');
  assert.equal(status.missing, 'model');
  assert.match(status.message, /没有选中模型/);
});

test('缺 provider / baseUrl / key 的 missing 口径', () => {
  const empty = buildImageStatus({ config: { providers: [], active: {} }, version: '0.7.0', key: { ok: false, source: '', ref: '' } });
  assert.equal(empty.missing, 'provider');

  const noBase = buildImageStatus({
    config: configOf({ id: 'p5', name: 'X', baseUrl: '', models: ['m'] }, { providerId: 'p5', model: 'm' }),
    version: '0.7.0',
    key: okKey
  });
  assert.equal(noBase.missing, 'baseUrl');

  const noKey = buildImageStatus({
    config: configOf({ id: 'p6', name: 'X', baseUrl: 'https://x.test/v1', models: ['m'] }, { providerId: 'p6', model: 'm' }),
    version: '0.7.0',
    key: { ok: false, source: '', ref: 'MO_IMAGE_P6_API_KEY' }
  });
  assert.equal(noKey.missing, 'key');
  assert.match(noKey.message, /API Key 没找到/);
});

test('ComfyUI 自定义工作流没有图片槽时不能编辑', () => {
  const provider = {
    id: 'p7', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui',
    optionalKey: true, models: ['m.safetensors'],
    modelOptions: { 'm.safetensors': { workflow: '{"1":{"class_type":"SaveImage"}}', mapping: { image: null } } }
  };
  const adapter = resolveAdapter(provider, 'm.safetensors');
  assert.equal(canEditModel(provider, 'm.safetensors', adapter), false);
  const status = buildImageStatus({
    config: configOf(provider, { providerId: 'p7', model: 'm.safetensors' }),
    version: '0.7.0',
    key: { ok: true, source: 'optional', ref: '' }
  });
  assert.equal(status.capabilities.edit, false);
  assert.deepEqual(status.capabilities.editModels, []);
});

test('ComfyUI 工作流有 {{image}} 或图片映射时可以编辑', () => {
  const withSlot = {
    id: 'p8', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui',
    optionalKey: true, models: ['a.safetensors'],
    modelOptions: { 'a.safetensors': { workflow: '{"2":{"inputs":{"image":"{{image}}"}}}' } }
  };
  assert.equal(canEditModel(withSlot, 'a.safetensors', resolveAdapter(withSlot, 'a.safetensors')), true);

  const withMapping = {
    ...withSlot, id: 'p9', models: ['b.safetensors'],
    modelOptions: { 'b.safetensors': { workflow: '{}', mapping: { image: { node: '2', input: 'image' } } } }
  };
  assert.equal(canEditModel(withMapping, 'b.safetensors', resolveAdapter(withMapping, 'b.safetensors')), true);

  const builtin = {
    id: 'p10', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui',
    optionalKey: true, models: ['sd.safetensors']
  };
  assert.equal(canEditModel(builtin, 'sd.safetensors', resolveAdapter(builtin, 'sd.safetensors')), true);
});

test('凭据来源归一成契约里的四种', () => {
  assert.equal(normalizeKeySource('file'), 'credentials', 'DSH 凭据文件不是“配置文件”');
  assert.equal(normalizeKeySource('keychain'), 'credentials');
  assert.equal(normalizeKeySource('env'), 'env');
  assert.equal(normalizeKeySource('process'), 'env');
  assert.equal(normalizeKeySource('config'), 'config');
  assert.equal(normalizeKeySource('optional'), 'optional');
  assert.equal(normalizeKeySource(''), '');
});

test('默认值原样带出，尺寸策略跟随 defaults.auto', () => {
  const provider = { id: 'p11', name: 'X', baseUrl: 'https://x.test/v1', adapter: '', models: ['gpt-image-1'] };
  const picker = buildImageStatus({
    config: configOf(provider, { providerId: 'p11', model: 'gpt-image-1' }),
    version: '0.7.0', key: okKey
  });
  assert.deepEqual(picker.capabilities.size, { mode: 'picker' });
  assert.equal(picker.promptOptimization, true);

  const fixed = buildImageStatus({
    config: configOf(provider, { providerId: 'p11', model: 'gpt-image-1' }, { auto: false, width: 2000, height: 2000 }),
    version: '0.7.0', key: okKey
  });
  assert.deepEqual(fixed.capabilities.size, { mode: 'fixed', width: 2000, height: 2000 });
});

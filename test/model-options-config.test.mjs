import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, normalizeModelOptions } from '../lib/index.js';
import { normalizeQuality } from '../lib/config-store.js';

test('normalizeModelOptions keeps a workflow for models that exist', () => {
  const out = normalizeModelOptions(
    { 'a.safetensors': { workflow: '{"1":{}}' }, 'ghost.safetensors': { workflow: '{"2":{}}' } },
    ['a.safetensors']
  );
  assert.deepEqual(Object.keys(out), ['a.safetensors']);
  assert.equal(out['a.safetensors'].workflow, '{"1":{}}');
});

test('normalizeModelOptions drops empty or non-string workflows', () => {
  const out = normalizeModelOptions(
    { 'a': { workflow: '   ' }, 'b': { workflow: 42 }, 'c': {} },
    ['a', 'b', 'c']
  );
  assert.deepEqual(out, {});
});

test('normalizeModelOptions caps very large payloads', () => {
  const huge = 'x'.repeat(2_500_000);
  const out = normalizeModelOptions({ a: { workflow: huge } }, ['a']);
  assert.deepEqual(out, {}, 'oversized workflow should be rejected');
});

test('normalizeModelOptions tolerates garbage input', () => {
  assert.deepEqual(normalizeModelOptions(null, ['a']), {});
  assert.deepEqual(normalizeModelOptions('nope', ['a']), {});
  assert.deepEqual(normalizeModelOptions({ a: 'nope' }, ['a']), {});
});

test('normalizeConfig carries modelOptions through for each provider', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'local', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
      models: ['flux.safetensors'],
      modelOptions: { 'flux.safetensors': { workflow: '{"1":{"class_type":"KSampler"}}' } }
    }],
    active: { providerId: 'p1', model: 'flux.safetensors' }
  });
  const provider = config.providers[0];
  assert.ok(provider.modelOptions);
  assert.equal(provider.modelOptions['flux.safetensors'].workflow, '{"1":{"class_type":"KSampler"}}');
});

test('normalizeConfig omits modelOptions when nothing usable is configured', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{ id: 'p1', name: 'x', baseUrl: 'http://x', models: ['m'], modelOptions: {} }],
    active: { providerId: 'p1', model: 'm' }
  });
  assert.equal(config.providers[0].modelOptions, undefined);
});

test('normalizeConfig drops modelOptions for adapters that cannot run custom workflows', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'cloud', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
      models: ['gpt-image-2.5-flare'],
      modelOptions: { 'gpt-image-2.5-flare': { workflow: '{"1":{"class_type":"KSampler"}}' } }
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' }
  });
  assert.equal(config.providers[0].modelOptions, undefined,
    'only the ComfyUI adapter understands custom workflows');
});

test('normalizeConfig keeps size overrides for cloud adapters', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'cloud', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
      models: ['gpt-image-2.5-flare'],
      modelOptions: {
        'gpt-image-2.5-flare': {
          workflow: '{"1":{"class_type":"KSampler"}}',
          size: { mode: 'wh-string', field: 'size', separator: 'x' }
        }
      }
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' }
  });
  const options = config.providers[0].modelOptions;
  assert.ok(options, '云端模型的尺寸覆盖必须能存下来');
  assert.equal(options['gpt-image-2.5-flare'].size.field, 'size');
  assert.equal(options['gpt-image-2.5-flare'].workflow, undefined, '工作流只有 ComfyUI 认');
});

test('normalizeModelOptions keeps a valid mapping next to the workflow', () => {
  const out = normalizeModelOptions({
    'm1': { workflow: '{"1":{}}', mapping: { prompt: { node: '1', input: 'text' }, width: null } }
  }, ['m1']);
  assert.deepEqual(out.m1.mapping.prompt, { node: '1', input: 'text' });
  assert.equal(out.m1.mapping.width, null);
});

test('normalizeConfig keeps field template overrides for cloud adapters', () => {
  // 任务 7' 把通用请求体交给字段模板以后，用户覆盖也要真的能落盘（否则面板改了等于没改）。
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['flux-1-schnell'],
      modelOptions: {
        'flux-1-schnell': { fields: { prompt: { path: 'input.prompt' }, negative: null } }
      }
    }],
    active: { providerId: 'p1', model: 'flux-1-schnell' }
  });
  const options = config.providers[0].modelOptions;
  assert.ok(options, '字段模板覆盖必须能存下来');
  assert.deepEqual(options['flux-1-schnell'].fields, {
    prompt: { path: 'input.prompt' },
    negative: null
  });
});

test('normalizeModelOptions drops a field template it cannot parse', () => {
  const out = normalizeModelOptions({ m: { fields: { prompt: { nonsense: true } } } }, ['m']);
  assert.deepEqual(out, {}, '认不出的模板整条丢掉，别存一个发送时才炸的东西');
  // 一条坏模板不影响同一个模型上其它合法的字段模板。
  const mixed = normalizeModelOptions({
    m: { fields: { prompt: { nonsense: true }, n: { path: 'num_images' } } }
  }, ['m']);
  assert.deepEqual(mixed.m.fields, { n: { path: 'num_images' } });
});

test('normalizeModelOptions drops a mapping that is not shaped node/input', () => {
  const out = normalizeModelOptions({ 'm1': { workflow: '{"1":{}}', mapping: { prompt: 'nope' } } }, ['m1']);
  assert.equal(out.m1.mapping, undefined);
});

test('normalizeModelOptions accepts a workflow up to 2 MB', () => {
  const big = '{"1":"' + 'x'.repeat(1_500_000) + '"}';
  const out = normalizeModelOptions({ 'm1': { workflow: big } }, ['m1']);
  assert.ok(out.m1, 'a 1.5 MB workflow must survive');
});

test('normalizeQuality 保留用户自定义档位', () => {
  assert.equal(normalizeQuality('ultra'), 'ultra');
  assert.equal(normalizeQuality(' ULTRA '), 'ultra');
  assert.equal(normalizeQuality(''), 'high');
  assert.equal(normalizeQuality('x'.repeat(40)), 'high', '异常长的值仍然回退');
  assert.equal(normalizeQuality('has space'), 'high');
});

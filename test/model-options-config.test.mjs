import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, normalizeModelOptions } from '../lib/index.js';

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
  const huge = 'x'.repeat(300000);
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

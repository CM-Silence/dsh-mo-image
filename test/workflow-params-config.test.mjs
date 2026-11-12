import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { settingsPayload } from '../lib/prompt-profiles.js';
import { normalizeModelOptions, workflowParamsOf } from '../lib/index.js';
import { collectRoleParams } from '../lib/comfy-workflow.js';

const provider = { id: 'p-comfy', adapter: 'comfyui' };
const PARAMS = [
  { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25 },
  { name: 'sampler_name', node: '18:7', input: 'sampler_name', type: 'enum', default: 'er_sde', options: ['euler', 'er_sde'] }
];

test('settingsPayload lists parameter names and types without defaults', () => {
  const payload = settingsPayload({
    provider, model: 'moss.safetensors', adapter: { id: 'comfyui' },
    workflowParams: PARAMS
  });
  assert.equal(payload.params.length, 2);
  assert.deepEqual(payload.params[0], { name: 'steps', type: 'INT' });
  assert.deepEqual(payload.params[1], { name: 'sampler_name', type: 'enum', options: ['euler', 'er_sde'] });
  assert.match(payload.hint, /params/);
  assert.doesNotMatch(payload.hint, /steps/, 'the hint must not repeat the parameter list');
  assert.doesNotMatch(payload.hint, /默认 25/, 'defaults must not leak into the hint');
});

test('settingsPayload omits params when the model has none', () => {
  const payload = settingsPayload({ provider, model: 'flux.safetensors', adapter: { id: 'comfyui' } });
  assert.equal(payload.params, undefined);
  assert.doesNotMatch(payload.hint, /params/);
});

test('normalizeModelOptions keeps per-parameter exposure flags', () => {
  const out = normalizeModelOptions({
    m1: {
      workflow: '{"1":{}}',
      params: [
        { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25, expose: false },
        { name: 'cfg', node: '18:7', input: 'cfg', type: 'FLOAT', default: 2.5 }
      ]
    }
  }, ['m1']);
  assert.equal(out.m1.params.length, 2);
  assert.equal(out.m1.params[0].expose, false, 'a hidden parameter stays hidden');
  assert.equal(out.m1.params[1].expose, undefined, 'the default is exposed');
});

test('normalizeModelOptions drops a malformed parameter list instead of half-keeping it', () => {
  const out = normalizeModelOptions({
    m1: { workflow: '{"1":{}}', params: [{ name: 'steps' }] }
  }, ['m1']);
  assert.equal(out.m1.params, undefined);
});

const MIXED = [
  { name: 'prompt', role: true, node: '1', input: 'value', type: 'STRING', default: 'x' },
  { name: 'steps', node: '2', input: 'steps', type: 'INT', default: 25 }
];

test('role params are exposed by default while tunables stay hidden', () => {
  const provider = { modelOptions: { m1: { workflow: '{}', params: MIXED } } };
  const out = workflowParamsOf(provider, 'm1', { id: 'comfyui' });
  assert.deepEqual(out.map((param) => param.name), ['prompt']);
});

test('an explicit expose flag overrides the default in both directions', () => {
  const provider = {
    modelOptions: { m1: { workflow: '{}', params: MIXED, expose: { prompt: false, steps: true } } }
  };
  const out = workflowParamsOf(provider, 'm1', { id: 'comfyui' });
  assert.deepEqual(out.map((param) => param.name), ['steps']);
});

test('non-comfy adapters never get workflow params', () => {
  const provider = { modelOptions: { m1: { workflow: '{}', params: MIXED } } };
  assert.equal(workflowParamsOf(provider, 'm1', { id: 'a1111' }), undefined);
});

test('seed and model stay hidden by default even though they are role params', () => {
  const provider = {
    modelOptions: {
      m1: {
        workflow: '{}',
        params: [
          { name: 'seed', role: true, node: '3', input: 'seed', type: 'INT', default: 1 },
          { name: 'model', role: true, node: '1', input: 'unet_name', type: 'STRING', default: 'x' }
        ]
      }
    }
  };
  assert.equal(workflowParamsOf(provider, 'm1', { id: 'comfyui' }), undefined);
});

test('role params take their type from object_info and never report a link as a string', () => {
  const objectInfo = JSON.parse(readFileSync('test/fixtures/object-info.sample.json', 'utf8'));
  const graph = {
    '18:6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['19', 0], height: ['19', 1], batch_size: 1 } }
  };
  const mapping = { width: { node: '18:6', input: 'width' }, height: { node: '18:6', input: 'height' } };
  const params = collectRoleParams(graph, mapping, objectInfo);
  const width = params.find((item) => item.name === 'width');
  assert.equal(width.type, 'INT');
  assert.equal(width.default, undefined, 'a link is not a usable default');
});

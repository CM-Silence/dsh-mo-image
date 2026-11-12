import test from 'node:test';
import assert from 'node:assert/strict';

import { settingsPayload } from '../lib/prompt-profiles.js';
import { normalizeModelOptions } from '../lib/index.js';

const provider = { id: 'p-comfy', adapter: 'comfyui' };
const PARAMS = [
  { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25 },
  { name: 'sampler_name', node: '18:7', input: 'sampler_name', type: 'enum', default: 'er_sde', options: ['euler', 'er_sde'] }
];

test('settingsPayload lists workflow parameters and their defaults', () => {
  const payload = settingsPayload({
    provider, model: 'moss.safetensors', adapter: { id: 'comfyui' },
    workflowParams: PARAMS
  });
  assert.equal(payload.params.length, 2);
  assert.match(payload.hint, /steps/);
  assert.match(payload.hint, /默认 25/);
  assert.match(payload.hint, /sampler_name/);
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

test('settingsPayload hides parameters the user unchecked', () => {
  const payload = settingsPayload({
    provider, model: 'moss.safetensors', adapter: { id: 'comfyui' },
    workflowParams: [
      { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25, expose: false },
      { name: 'cfg', node: '18:7', input: 'cfg', type: 'FLOAT', default: 2.5 }
    ]
  });
  assert.deepEqual(payload.params.map((param) => param.name), ['cfg']);
  assert.doesNotMatch(payload.hint, /steps/);
});

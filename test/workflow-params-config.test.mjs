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

test('normalizeModelOptions keeps the analyzed parameters and the exposure flag', () => {
  const out = normalizeModelOptions({
    m1: { workflow: '{"1":{}}', params: PARAMS, exposeParams: false }
  }, ['m1']);
  assert.equal(out.m1.params.length, 2);
  assert.equal(out.m1.exposeParams, false);
});

test('normalizeModelOptions treats a missing exposure flag as exposed', () => {
  const out = normalizeModelOptions({ m1: { workflow: '{"1":{}}', params: PARAMS } }, ['m1']);
  assert.equal(out.m1.exposeParams, undefined, 'default exposure is the absence of the flag');
});

test('normalizeModelOptions drops a malformed parameter list instead of half-keeping it', () => {
  const out = normalizeModelOptions({
    m1: { workflow: '{"1":{}}', params: [{ name: 'steps' }] }
  }, ['m1']);
  assert.equal(out.m1.params, undefined);
});

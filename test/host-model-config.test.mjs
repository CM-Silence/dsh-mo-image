import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/index.js';

test('normalizeConfig keeps hostModel for the responses adapter', () => {
  const out = normalizeConfig({
    providers: [{ id: 'p', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: ' gpt-5.2 ' }]
  });
  assert.equal(out.providers[0].hostModel, 'gpt-5.2');
});

test('normalizeConfig drops hostModel from providers that do not need it', () => {
  const out = normalizeConfig({
    providers: [{ id: 'p', baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl', hostModel: 'gpt-5.2' }]
  });
  assert.equal(out.providers[0].hostModel, undefined);
});

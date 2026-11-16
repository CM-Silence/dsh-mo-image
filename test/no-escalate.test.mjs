import test from 'node:test';
import assert from 'node:assert/strict';

import { sizeHintText } from '../lib/adapters.js';
import { callImageApi } from '../lib/index.js';

/* 尺寸被拒：只发一次请求，错误里带该模型的合法范围。 */

const adapter = {
  id: 'x', label: 'X',
  endpoints: { generate: '/images/generations', edit: '' },
  transport: { generate: 'json', edit: 'json' },
  size: { style: 'string', field: 'size', allowed: ['1024x1024', '1792x1024'], allowCustom: false }
};

test('sizeHintText lists the allowed sizes', () => {
  assert.match(sizeHintText({}, 'dall-e-3'), /1024x1024/);
  assert.match(sizeHintText({}, 'dall-e-3'), /1792x1024/);
});

test('sizeHintText falls back to pixel budget and multiple', () => {
  const loose = {};
  assert.match(sizeHintText(loose, 'gpt-image-1.5'), /16/);
  assert.match(sizeHintText(loose, 'gpt-image-1.5'), /0\.66/);
});

test('a size rejection is reported once and never retried', async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { message: 'size is below the minimum allowed' } }), { status: 400 });
  };
  await assert.rejects(
    () => callImageApi('generate', adapter, { baseUrl: 'http://127.0.0.1:1', key: 'k' },
      { model: 'm', prompt: 'p', fitted: { size: '512x512', width: 512, height: 512 } }, undefined),
    /尺寸|size/
  );
  assert.equal(calls.length, 1, 'no escalation retry');
});

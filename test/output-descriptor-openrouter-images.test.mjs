/**
 * `openrouter-images` 迁到输出描述符：迁移前的特征化基线 + 迁移后的字段钉住。
 *
 * 今天的读法：`data[0].b64_json` 裸 base64 直解，contentType 取同级的 `media_type`
 * （没有就按字节签名）。只看 `data[0]`，没有 URL 分支，也没有兜底扫描。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

const PROVIDER = () => ({ baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images', key: 'k' });

function stubGeneration(t, payload) {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init });
    return jsonResponse(payload);
  };
  return calls;
}

async function generate(payload) {
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, 'google/gemini-3.1-flash-image');
  assert.equal(adapter.id, 'openrouter-images');
  return adapter.execute('generate', provider, {
    model: 'google/gemini-3.1-flash-image', prompt: 'a red panda',
    fitted: { width: 1344, height: 768, size: '1344x768' }
  }, new AbortController().signal);
}

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('openrouter-images：data.0.b64_json → 字节，contentType 取 media_type', async (t) => {
  stubGeneration(t, { data: [{ b64_json: PNG_RED, media_type: 'image/webp' }] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/webp');
});

test('openrouter-images：media_type 缺失时按字节签名兜底', async (t) => {
  stubGeneration(t, { data: [{ b64_json: PNG_RED }] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png');
});

test('openrouter-images：media_type 是空串时也按字节签名兜底（`||` 的语义）', async (t) => {
  stubGeneration(t, { data: [{ b64_json: PNG_RED, media_type: '' }] });
  const result = await generate();
  assert.equal(result.contentType, 'image/png');
});

test('openrouter-images：只看 data[0]（后面几项今天不读）', async (t) => {
  stubGeneration(t, { data: [{ revised_prompt: 'x' }, { b64_json: PNG_RED, media_type: 'image/png' }] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'OpenRouter 没有返回图片');
    return true;
  });
});

test('openrouter-images：data 缺失时同样报固定文案', async (t) => {
  stubGeneration(t, { choices: [] });
  await assert.rejects(() => generate(), /OpenRouter 没有返回图片/);
});

test('openrouter-images：data[0] 的 b64_json 解不出图时也报固定文案', async (t) => {
  stubGeneration(t, { data: [{ b64_json: 'AAAA' }] });
  await assert.rejects(() => generate(), /OpenRouter 没有返回图片/);
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('openrouter-images：output 描述符钉住 data.0 + contentTypePath + 64MB', () => {
  const adapter = resolveAdapter(PROVIDER(), 'google/gemini-3.1-flash-image');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes', 'pick']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.maxBytes, 64 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(adapter.output.emptyMessage, 'OpenRouter 没有返回图片');
  assert.deepEqual(adapter.output.pick, [{
    path: 'data.0.b64_json',
    as: 'base64',
    contentTypePath: 'media_type'
  }]);
});

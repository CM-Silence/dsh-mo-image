/**
 * `a1111` 迁到输出描述符：迁移前的特征化基线 + 迁移后的字段钉住。
 *
 * 今天的读法：`payload.images[0]` 当 base64 直解（容忍 `data:` 前缀，前缀里的类型优先），
 * 解不出就报「A1111 没有返回图片」；只看第一张，没有 URL 分支。
 * 另外 `execute()` 会把「被忽略的参数」拼成 `note` 附加在结果上——那是请求侧的事，
 * 迁移后必须还在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

const PROVIDER = () => ({ baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111', optionalKey: true });

function stubTxt2Img(t, payload) {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init });
    return jsonResponse(payload);
  };
  return calls;
}

async function generate(payload, input) {
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, '');
  assert.equal(adapter.id, 'a1111');
  return adapter.execute('generate', provider, Object.assign({
    model: 'sdxl-base.safetensors', prompt: 'a cat', fitted: { width: 512, height: 512, size: '512x512' }
  }, input || {}), new AbortController().signal);
}

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('a1111：images.0 裸 base64 → 字节', async (t) => {
  stubTxt2Img(t, { images: [PNG_RED], info: '{}' });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png');
});

test('a1111：images.0 带 data: 前缀 → 前缀里的类型优先', async (t) => {
  // 字节是 PNG，前缀写 webp：迁移前 base64ToImage 会返回前缀里的类型。
  stubTxt2Img(t, { images: ['data:image/webp;base64,' + PNG_RED] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/webp');
});

test('a1111：只看第一张（images[0] 坏掉时不会去读 images[1]）', async (t) => {
  stubTxt2Img(t, { images: ['AAAA', PNG_RED] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'A1111 没有返回图片');
    return true;
  });
});

test('a1111：images 是空数组时报固定文案', async (t) => {
  stubTxt2Img(t, { images: [] });
  await assert.rejects(() => generate(), /A1111 没有返回图片/);
});

test('a1111：没有 images 字段时也报固定文案', async (t) => {
  stubTxt2Img(t, { info: '{}' });
  await assert.rejects(() => generate(), /A1111 没有返回图片/);
});

test('a1111：被忽略的参数仍然拼成 note 附在结果上', async (t) => {
  stubTxt2Img(t, { images: [PNG_RED] });
  const result = await generate(null, { params: { mystery: 1 } });
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), 'note 不能顶掉图片字节');
  assert.match(String(result.note), /已忽略.*mystery/);
});

test('a1111：img2img 的响应走同一条读法', async (t) => {
  stubTxt2Img(t, { images: [PNG_RED] });
  const provider = PROVIDER();
  const result = await resolveAdapter(provider, '').execute('edit', provider, {
    model: 'sdxl-base.safetensors', prompt: 'make it blue', fitted: { omit: true, size: 'none' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png' }]
  }, new AbortController().signal);
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('a1111：output 描述符钉住 images.0 + base64 + 50MB', () => {
  const adapter = resolveAdapter(PROVIDER(), '');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes', 'pick']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.maxBytes, 50 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(adapter.output.emptyMessage, 'A1111 没有返回图片');
  assert.deepEqual(adapter.output.pick, [{ path: 'images.0', as: 'base64' }]);
});

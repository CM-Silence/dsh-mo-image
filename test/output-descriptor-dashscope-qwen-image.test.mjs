/**
 * `dashscope-qwen-image` 迁到输出描述符：迁移前的特征化基线 + 迁移后的字段钉住。
 *
 * 今天的读法：`output.choices[0].message.content[]` 里第一个带 `.image` 的项，
 * 拿到的 URL 交给 fetchResultImage 下载（没有 base64 分支、没有兜底扫描）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const PROVIDER = () => ({ baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k' });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

function chatPayload(content) {
  return { output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: content } }] } };
}

function stubQwen(t, payload) {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    if (target.endsWith('/services/aigc/multimodal-generation/generation')) return jsonResponse(payload);
    if (target === 'https://cdn.test/qwen.png' || target === 'https://cdn.test/second.png'
      || target === 'https://dashscope.aliyuncs.com/out/qwen.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };
  return calls;
}

async function generate(payload) {
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');
  assert.equal(adapter.id, 'dashscope-qwen-image');
  return adapter.execute('generate', provider, {
    model: 'qwen-image-3.0-pro', prompt: '一只猫', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
}

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('dashscope-qwen-image：content[] 里的 image → 下载（同源带凭据）', async (t) => {
  const remote = 'https://dashscope.aliyuncs.com/out/qwen.png';
  const calls = stubQwen(t, chatPayload([{ image: remote }]));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  const download = calls.find((call) => call.url === remote);
  assert.ok(download, 'URL 由 execute() 交给 fetchResultImage');
  assert.equal(download.init.headers.Authorization, 'Bearer k', '同源下载带凭据（跨源默认不带，判定在 fetchResultImage）');
});

test('dashscope-qwen-image：跳过没有 image 的项（text 项在前）', async (t) => {
  stubQwen(t, chatPayload([
    { text: '好的，这是你要的图片' },
    { image: 'https://cdn.test/qwen.png' }
  ]));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('dashscope-qwen-image：多个 image 项时取第一个（不是最后一张）', async (t) => {
  const calls = stubQwen(t, chatPayload([
    { image: 'https://cdn.test/qwen.png' },
    { image: 'https://cdn.test/second.png' }
  ]));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.ok(calls.some((call) => call.url === 'https://cdn.test/qwen.png'));
  assert.ok(!calls.some((call) => call.url === 'https://cdn.test/second.png'), '第二张不该被下载');
});

test('dashscope-qwen-image：没有 output.choices 时报固定文案', async (t) => {
  stubQwen(t, { request_id: 'x' });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, '百炼 Qwen-Image 没有返回图片');
    return true;
  });
});

test('dashscope-qwen-image：content 不是数组时报固定文案', async (t) => {
  stubQwen(t, chatPayload('https://cdn.test/qwen.png'));
  await assert.rejects(() => generate(), /百炼 Qwen-Image 没有返回图片/);
});

test('dashscope-qwen-image：图生图（edit）的响应走同一条读法', async (t) => {
  stubQwen(t, chatPayload([{ image: 'https://cdn.test/qwen.png' }]));
  const provider = PROVIDER();
  const result = await resolveAdapter(provider, 'qwen-image-3.0-pro').execute('edit', provider, {
    model: 'qwen-image-3.0-pro', prompt: '换背景',
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png' }]
  }, new AbortController().signal);
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('dashscope-qwen-image：output 描述符钉住 content[].image + as:url + 32MB', () => {
  const adapter = resolveAdapter(PROVIDER(), 'qwen-image-3.0-pro');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes', 'pick']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.maxBytes, 32 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(adapter.output.emptyMessage, '百炼 Qwen-Image 没有返回图片');
  assert.deepEqual(adapter.output.pick, [{ path: 'output.choices.0.message.content[].image', as: 'url' }]);
});

/* --------------------------------------------------------- 迁移后的已知差异（如实钉住） */

/**
 * 迁移前对 `item.image` 不做任何 URL 校验，直接塞给 fetchResultImage；相对路径/垃圾串会
 * 变成一次注定失败的请求。描述符的 `as:'url'` 只认 http(s)，所以这种值被跳过，
 * 后面若有真正的图片 URL 就能拿到（更稳，但确实不是逐字节等价）。
 */
test('dashscope-qwen-image 已知差异：非 http 的 image 值被跳过，取后面那个合法 URL', async (t) => {
  stubQwen(t, chatPayload([
    { image: 'View/local/relative.png' },
    { image: 'https://cdn.test/qwen.png' }
  ]));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

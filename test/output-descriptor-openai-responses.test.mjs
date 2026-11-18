/**
 * `openai-responses` 迁到输出描述符：迁移前的特征化基线 + 迁移后的字段钉住。
 *
 * 今天的读法：`payload.output` 里 `type === 'image_generation_call'` 且 `result` 非空的第一项，
 * 裸 base64 直解。响应里没有 URL 分支，也没有兜底扫描。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';
import { callImageApi } from '../lib/image-execution.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

const PROVIDER = () => ({
  baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k'
});

function stubResponses(t, payload) {
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
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  assert.equal(adapter.id, 'openai-responses');
  return adapter.execute('generate', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
}

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('openai-responses：image_generation_call 的 result（裸 base64）→ 字节', async (t) => {
  stubResponses(t, { output: [{ type: 'image_generation_call', status: 'completed', result: PNG_RED }] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png', 'contentType 只来自字节签名');
});

test('openai-responses：跳过 reasoning / message 等其它 output 项', async (t) => {
  stubResponses(t, { output: [
    { type: 'reasoning', result: PNG_1PX },
    { type: 'message', content: [{ type: 'output_text', text: 'here' }] },
    { type: 'image_generation_call', result: PNG_RED }
  ] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), '只有 image_generation_call 那项算图');
});

test('openai-responses：多个 image_generation_call 取第一个（不是最后一张）', async (t) => {
  stubResponses(t, { output: [
    { type: 'image_generation_call', result: PNG_RED },
    { type: 'image_generation_call', result: PNG_1PX }
  ] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

test('openai-responses：type 对但没有 result 的项被跳过', async (t) => {
  stubResponses(t, { output: [
    { type: 'image_generation_call', status: 'in_progress' },
    { type: 'image_generation_call', result: PNG_RED }
  ] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

test('openai-responses：没有图时报固定文案', async (t) => {
  stubResponses(t, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'no' }] }] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'Responses API 没有返回图片（检查 tool_choice 与主模型是否支持 image_generation）');
    return true;
  });
});

test('openai-responses：output 不是数组时同样报固定文案', async (t) => {
  stubResponses(t, { output: { type: 'image_generation_call', result: PNG_RED } });
  await assert.rejects(() => generate(), /Responses API 没有返回图片/);
});

test('openai-responses：经 callImageApi 的通用入口也是同一条读取路径', async (t) => {
  stubResponses(t, { output: [{ type: 'image_generation_call', result: PNG_RED }] });
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  const result = await callImageApi('generate', adapter, provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('openai-responses：output 描述符钉住「filter + any + 64MB + 原文案」', () => {
  const adapter = resolveAdapter(PROVIDER(), 'gpt-image-2.5-flare');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes', 'pick']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.maxBytes, 64 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(
    adapter.output.emptyMessage,
    'Responses API 没有返回图片（检查 tool_choice 与主模型是否支持 image_generation）'
  );
  assert.deepEqual(adapter.output.pick, [{
    path: 'output[]',
    as: 'base64',
    any: ['result'],
    where: [{ path: 'type', equals: 'image_generation_call' }]
  }]);
});

/* --------------------------------------------------------- 迁移后的已知差异（如实钉住） */

/**
 * 迁移前是 `items.find(匹配)` + 只解那一项：第一项 result 坏掉时直接报错，不会看第二项。
 * 描述符的语义是「候选逐个试、第一个解得出图的赢」，所以这里会拿到第二项的有效图。
 * 这是**放宽**（只影响「第一项坏、后面还有好图」的边角输入），单独钉住，别当成回归。
 */
test('openai-responses 已知差异：第一个匹配项的 result 坏掉时会继续试下一个（迁移后放宽）', async (t) => {
  stubResponses(t, { output: [
    { type: 'image_generation_call', result: 'AAAA' },
    { type: 'image_generation_call', result: PNG_RED }
  ] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

/**
 * `google-gemini` 迁到输出描述符：**迁移前**的特征化基线 + **迁移后**的字段钉住。
 *
 * 这条难在响应读法不是「一条路径」：
 *   - `candidates.0.content.parts[]` 要**逆序**扫（thinking 模型的草图在前，结果在后）；
 *   - 跳过 `thought === true`（注意：只跳过严格的布尔 true，字符串 "true" 不跳——今天就是这样）；
 *   - `inlineData` / `inline_data` 是**按 part 交错**判定的，拆成两条候选会变成
 *     「先全表驼峰、再全表蛇形」，选出的 part 会不一样；
 *   - `mimeType` / `mime_type` 覆盖 contentType，缺失时按字节签名兜底；
 *   - 无图时的报错要带 `finishReason`（有才带）。
 *
 * 所以这个文件前半段在迁移前必须全绿，迁移后必须原样全绿；后半段（字段钉住）在迁移前是红的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
// 2x2 红：与 PNG_1PX 字节不同，用来证明「取到的是哪一个 part」。
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';
const PNG_THOUGHT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC';

const PROVIDER = () => ({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'k' });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

/** 打桩 fetch：返回给定的 candidates 载荷，并把请求记下来。 */
function stubGemini(t, payload) {
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
  const adapter = resolveAdapter(provider, 'gemini-3.1-flash-image');
  assert.equal(adapter.id, 'google-gemini');
  return adapter.execute('generate', provider, {
    model: 'gemini-3.1-flash-image', prompt: 'a cat', fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);
}

const parts = (...items) => ({ candidates: [{ content: { parts: items } }] });

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('gemini：驼峰 inlineData → 字节，contentType 取 mimeType', async (t) => {
  stubGemini(t, parts({ inlineData: { mimeType: 'image/webp', data: PNG_RED } }));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  // 原实现直接用 upstream 的 mimeType（哪怕字节是 PNG），这里必须原样保留。
  assert.equal(result.contentType, 'image/webp');
});

test('gemini：蛇形 inline_data → 字节，contentType 取 mime_type', async (t) => {
  stubGemini(t, parts({ inline_data: { mime_type: 'image/webp', data: PNG_RED } }));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/webp');
});

test('gemini：mimeType 缺失时按字节签名兜底（PNG → image/png）', async (t) => {
  stubGemini(t, parts({ inlineData: { data: PNG_RED } }));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png');
});

test('gemini：跳过 thought === true 的 part（草图在后也必须拿到真结果）', async (t) => {
  // 反着放：thought 在最后，逆序扫时它是第一个候选人——不跳过就会选成草图。
  stubGemini(t, parts(
    { inlineData: { mimeType: 'image/png', data: PNG_RED } },
    { thought: true, inlineData: { mimeType: 'image/png', data: PNG_THOUGHT } }
  ));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), 'thought 草图不能当结果');
});

test('gemini：thought 只认布尔 true——字符串 "true" 今天不跳（照旧）', async (t) => {
  stubGemini(t, parts(
    { inlineData: { mimeType: 'image/png', data: PNG_1PX } },
    { thought: 'true', inlineData: { mimeType: 'image/png', data: PNG_RED } }
  ));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), '逆序扫到的 part 就是它，字符串 thought 不拦');
});

test('gemini：多张非 thought 图取最后一张（逆序不是笔误，是 thinking 模型的写法）', async (t) => {
  stubGemini(t, parts(
    { inlineData: { mimeType: 'image/png', data: PNG_1PX } },
    { inlineData: { mimeType: 'image/png', data: PNG_RED } }
  ));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), '取的是 part[1]');
});

test('gemini：驼峰与蛇形按 part 交错判定——最后一个 part 的拼写赢', async (t) => {
  // 若拆成两条候选（先全表 inlineData、再全表 inline_data），这里会选中 part[0] 的 PNG_1PX。
  stubGemini(t, parts(
    { inlineData: { mimeType: 'image/png', data: PNG_1PX } },
    { inline_data: { mime_type: 'image/png', data: PNG_RED } }
  ));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), '逆序下第一个有图的 part 是 part[1] 的蛇形拼写');
});

test('gemini：最后一个 part 解不出图时退到前一个', async (t) => {
  stubGemini(t, parts(
    { inlineData: { mimeType: 'image/png', data: PNG_RED } },
    { inlineData: { mimeType: 'image/png', data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }
  ));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), '坏 base64 要跳过，不是选错');
});

test('gemini：inlineData 没有 data 的 part 被跳过', async (t) => {
  stubGemini(t, parts(
    { inlineData: { mimeType: 'image/png', data: PNG_RED } },
    { inlineData: { mimeType: 'image/png' } }
  ));
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

test('gemini：没有图时报错带 finishReason', async (t) => {
  stubGemini(t, { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'no' }] } }] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'Gemini 没有返回图片（finishReason=SAFETY）');
    return true;
  });
});

test('gemini：连 finishReason 都没有时只有基础文案', async (t) => {
  stubGemini(t, { candidates: [{ content: { parts: [] } }] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'Gemini 没有返回图片');
    return true;
  });
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('gemini：output 描述符钉住「逆序 + 过滤 thought + 双拼写 + contentType」', () => {
  const adapter = resolveAdapter(PROVIDER(), 'gemini-3.1-flash-image');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyDetail', 'emptyMessage', 'kind', 'maxBytes', 'pick']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.maxBytes, 48 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(adapter.output.emptyMessage, 'Gemini 没有返回图片');
  assert.deepEqual(adapter.output.emptyDetail, { path: 'candidates.0.finishReason', label: 'finishReason' });
  assert.equal(adapter.output.scan, undefined, 'gemini 今天没有兜底扫描，别顺手加');

  assert.equal(adapter.output.pick.length, 1, 'any 必须在一个 pick 里按 part 交错，不能拆成两条候选');
  assert.deepEqual(adapter.output.pick[0], {
    path: 'candidates.0.content.parts[]',
    as: 'base64',
    select: 'last',
    where: [{ path: 'thought', notEquals: true }],
    any: ['inlineData.data', 'inline_data.data'],
    contentTypePath: ['inlineData.mimeType', 'inline_data.mime_type']
  });
});

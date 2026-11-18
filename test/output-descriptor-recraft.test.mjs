/**
 * `recraft` 迁到输出描述符：迁移前的特征化基线 + 迁移后的字段钉住。
 *
 * recraft 今天**没有**协议自己的读取逻辑：整段是 `decodeImagePayload(payload)` 的
 * 「任意位置扫描」（先全表 base64 → 再带图片后缀的 URL → 再任意 URL），
 * 后面那句 `throw new Error('Recraft 没有返回图片')` 是死代码。
 *
 * 所以等价迁移 = 保留兜底扫描、把体积上限与文案显式写下来；收紧成 `data.0` 是行为变化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

const PROVIDER = () => ({ baseUrl: 'https://external.api.recraft.ai/v1', adapter: 'recraft', key: 'k' });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/**
 * 打桩 fetch：生成端点回 payload；`extra` 里声明的地址回给定响应；
 * `https://cdn.test/*.png` 默认回 1x1 PNG。返回 calls，方便断言下载去了哪。
 */
function stubRecraft(t, payload, extra) {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    if (target.endsWith('/images/generations') || target.endsWith('/images/imageToImage')) {
      return typeof payload === 'function' ? payload() : jsonResponse(payload);
    }
    if (extra && extra[target]) return extra[target]();
    if (/^https:\/\/cdn\.test\/.+\.png$/.test(target)) return pngResponse();
    throw new Error('unexpected url ' + target);
  };
  return calls;
}

async function generate() {
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, 'recraftv4_1');
  assert.equal(adapter.id, 'recraft');
  return adapter.execute('generate', provider, {
    model: 'recraftv4_1', prompt: 'a landscape', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
}

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('recraft：data.0.url → 交给 fetchResultImage 下载（同源带凭据）', async (t) => {
  const remote = 'https://external.api.recraft.ai/v1/files/out.png';
  const calls = stubRecraft(t, { data: [{ url: remote }] }, { [remote]: pngResponse });

  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  const download = calls.find((call) => call.url === remote);
  assert.ok(download, 'URL 由 execute() 交给 fetchResultImage');
  assert.equal(download.init.headers.Authorization, 'Bearer k');
});

test('recraft：data.0.b64_json → 字节（扫描的 base64 轮次）', async (t) => {
  stubRecraft(t, { data: [{ b64_json: PNG_RED }] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png');
});

test('recraft：同一份响应里 b64 与 url 都有时选 base64（扫描顺序，不是字段顺序）', async (t) => {
  stubRecraft(t, { data: [{ url: 'https://cdn.test/other.png', b64_json: PNG_RED }] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'), '两样都有时 base64 赢');
});

test('recraft：图不在 data.0 时兜底扫描仍然找得到（中转改形状不会挂）', async (t) => {
  stubRecraft(t, { result: { previews: [{ image_url: 'https://cdn.test/moved.png' }] } });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('recraft：没有图片后缀的任意 URL 也能被第三轮扫描捡到', async (t) => {
  stubRecraft(t, { output: 'https://cdn.test/plain' }, { 'https://cdn.test/plain': pngResponse });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('recraft：没有图时报的是 decodeImagePayload 的文案（协议自己那句是死代码）', async (t) => {
  stubRecraft(t, { data: [{ revised_prompt: 'a landscape' }] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, '生图接口返回格式不认识');
    return true;
  });
});

test('recraft：响应体是 JSON null 时报「没有返回图片」', async (t) => {
  stubRecraft(t, () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, '生图接口没有返回图片');
    return true;
  });
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('recraft：output 描述符钉住「纯兜底扫描 + 32MB + 原文案」', () => {
  const adapter = resolveAdapter(PROVIDER(), 'recraftv4_1');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes', 'scan']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.scan, true, '收紧成 data.0 是行为变化：中转改形状就挂');
  assert.equal(adapter.output.maxBytes, 32 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  // 迁移前这句 throw 在 decodeImagePayload 之后，永远到不了；写下来是为了以后关掉 scan 时文案不变。
  assert.equal(adapter.output.emptyMessage, 'Recraft 没有返回图片');
});

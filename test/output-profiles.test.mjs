/**
 * 输出格式描述符：词汇表校验 + 读取语义 + ideogram 的真实响应。
 *
 * 这里钉三件事：
 *   1. 必填项与「描述符不许带凭据」是硬规则，不是约定；
 *   2. `json` 的读取顺序必须和迁移前的 decodeImagePayload 等价（候选 base64 在前；
 *      scan 兜底照抄「先全表 base64 → 再图片后缀 URL → 再任意 URL」）；
 *   3. ideogram 的响应路径逐条钉住：b64 / url / 非 data.0 的兜底 / 无图文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';
import { decodeImagePayload } from '../lib/adapter-kit.js';
import {
  readOutput, readTaskImage, taskSpecOf, validateOutputProfile
} from '../lib/output-profiles.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
// 2x2 红：和 PNG_1PX 字节不同，用来证明取到的是哪一个候选。
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

const IDEOGRAM_PROVIDER = () => ({ baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram', key: 'k' });

/* ------------------------------------------------------- 校验（三条铁律） */

test('描述符必填 maxBytes / emptyMessage，且拒绝 headers 与凭据字段', () => {
  const json = { kind: 'json', pick: [{ path: 'data.0.b64_json', as: 'base64' }] };
  assert.throws(() => validateOutputProfile({ ...json, emptyMessage: 'x' }), /maxBytes/, 'maxBytes 必填');
  assert.throws(() => validateOutputProfile({ ...json, maxBytes: 1024 }), /emptyMessage/, 'emptyMessage 必填');
  assert.throws(() => validateOutputProfile({ kind: 'binary', maxBytes: 1024, emptyMessage: 'x' }), /kind/, 'kind 只认 json / task');
  assert.throws(
    () => validateOutputProfile({ ...json, maxBytes: 1024, emptyMessage: 'x', headers: { Authorization: 'k' } }),
    /凭据字段/,
    '描述符里不能有 headers'
  );
  assert.throws(
    () => validateOutputProfile({ ...json, maxBytes: 1024, emptyMessage: 'x', pollHeaders: { 'x-key': 'k' } }),
    /凭据字段/,
    'pollHeaders 同样是 headers'
  );
});

test('尚未实现的字段在定义时就报错，不允许静默不生效', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'x' };
  assert.throws(() => validateOutputProfile({ ...base, from: [] }), /from/, 'from 级联留给 openai-chat');
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', as: 'relative' }] }), /pick\.as/, 'relative 留给 comfy/swarmui');
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', select: 'last' }] }), /select/, 'select 留给 gemini');
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', where: [] }] }), /where/, 'where 留给 gemini');
  assert.throws(
    () => validateOutputProfile({ kind: 'task', path: '/tasks/{taskId}', idPath: 'a', statusPath: 'b', resultPath: 'c', success: ['OK'], failure: [], intervalMs: 1, maxBytes: 1, emptyMessage: 'x', poll: {} }),
    /poll/,
    'task 分支这一批是扁平字段'
  );
});

test('字段白名单：拼错的键在定义时报错，不静默落到默认值', () => {
  const base = { kind: 'json', pick: [{ path: 'a' }], maxBytes: 1024, emptyMessage: 'x' };
  assert.throws(() => validateOutputProfile({ ...base, scanning: true }), /不认识的字段 scanning/);
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', form: 'x' }] }), /不认识的字段 form/);
  assert.throws(
    () => validateOutputProfile({
      kind: 'task', path: '/t', idPath: 'a', statisPath: 'b', statusPath: 'b',
      resultPath: 'c', success: ['OK'], failure: [], intervalMs: 1, maxBytes: 1, emptyMessage: 'x'
    }),
    /不认识的字段 statisPath/
  );
});

/* --------------------------------------------- json 读取：顺序与兜底语义 */

test('json 候选按 pick 顺序取，base64 在前——与 decodeImagePayload 选的是同一张', () => {
  const profile = {
    kind: 'json',
    pick: [
      { path: 'data.0.b64_json', as: 'base64' },
      { path: 'data.0.url', as: 'url' }
    ],
    scan: true,
    maxBytes: 1024,
    emptyMessage: 'x'
  };
  const both = { data: [{ b64_json: PNG_RED, url: 'https://cdn.test/other.png' }] };
  const picked = readOutput(both, profile);
  assert.deepEqual(picked.bytes, Buffer.from(PNG_RED, 'base64'), '两样都有时取 base64，不是 url');
  assert.deepEqual(picked.bytes, decodeImagePayload(both, null).bytes, '与迁移前 decodeImagePayload 的结果一致');

  const urlOnly = { data: [{ url: 'https://cdn.test/a.png' }] };
  assert.deepEqual(readOutput(urlOnly, profile), { url: 'https://cdn.test/a.png' });
  assert.deepEqual(readOutput(urlOnly, profile), decodeImagePayload(urlOnly, null));
});

test('json 的 scan 兜底保留 decodeImagePayload 的三轮扫描与报错文案', () => {
  const profile = {
    kind: 'json',
    pick: [{ path: 'data.0.b64_json', as: 'base64' }],
    scan: true,
    maxBytes: 1024,
    emptyMessage: '协议自己的文案'
  };
  // 图不在 data.0：兜底扫描仍然找得到（中转改形状不会挂）。
  assert.deepEqual(
    readOutput({ result: { previews: [{ image_url: 'https://cdn.test/moved.png' }] } }, profile),
    { url: 'https://cdn.test/moved.png' }
  );
  // 没有图：文案与迁移前一致（scan 路径保留 decodeImagePayload 的两句话）。
  assert.throws(() => readOutput({}, profile), /格式不认识/);
  assert.throws(() => readOutput(null, profile), /生图接口没有返回图片/);

  // 关掉 scan 才轮到描述符自己的 emptyMessage。
  const strict = { ...profile, scan: false };
  assert.throws(() => readOutput({ data: [] }, strict), /协议自己的文案/);
});

test('pick.as 的 auto / dataUrl 解释规则', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: '协议自己的文案' };
  const auto = { ...base, pick: [{ path: 'a', as: 'auto' }] };
  assert.deepEqual(readOutput({ a: 'data:image/png;base64,' + PNG_1PX }, auto).bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual(readOutput({ a: 'https://cdn.test/any' }, auto), { url: 'https://cdn.test/any' }, 'auto 先试 base64，再认 http(s)');

  const dataUrl = { ...base, pick: [{ path: 'a', as: 'dataUrl' }] };
  assert.deepEqual(readOutput({ a: 'data:image/png;base64,' + PNG_1PX }, dataUrl).bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.throws(() => readOutput({ a: 'https://cdn.test/any' }, dataUrl), /协议自己的文案/, 'dataUrl 不认普通 URL');
});

/* ------------------------------------------------- task 读取的收敛与语义 */

test('taskSpecOf 同时认新写法 output 与老写法 poll', () => {
  assert.equal(taskSpecOf({ output: { kind: 'task', path: '/new' } }).path, '/new');
  assert.equal(taskSpecOf({ poll: { path: '/legacy' } }).path, '/legacy');
  assert.equal(taskSpecOf({}), null);
  assert.equal(taskSpecOf(null), null);
});

test('task 结果节点：缺失用描述符文案，存在但读不出图保留「格式不认识」', () => {
  const spec = { kind: 'task', resultPath: 'output.results', emptyMessage: '任务完成但没有图' };
  assert.throws(() => readTaskImage(null, spec), /任务完成但没有图/);
  assert.throws(() => readTaskImage({}, spec), /格式不认识/);
  assert.deepEqual(
    readTaskImage({ results: [{ url: 'https://cdn.test/out.png' }] }, spec),
    { url: 'https://cdn.test/out.png' }
  );
});

/* ---------------------------------------------- ideogram 的真实响应路径 */

test('ideogram 的输出描述符钉住 json 主干的字段（maxBytes 与 base64 优先）', () => {
  const adapter = resolveAdapter(IDEOGRAM_PROVIDER(), 'ideogram-3');
  assert.equal(adapter.output.kind, 'json');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes', 'pick', 'scan']);
  assert.deepEqual(adapter.output.pick, [
    { path: 'data.0.b64_json', as: 'base64' },
    { path: 'data.0.url', as: 'url' }
  ]);
  assert.equal(adapter.output.scan, true, 'scan 兜底保留：收紧成 data.0 是行为变化');
  assert.equal(adapter.output.maxBytes, 32 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
});

test('ideogram 的 data.0.b64_json 直接落成字节', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => jsonResponse({ data: [{ b64_json: PNG_RED }] });

  const provider = IDEOGRAM_PROVIDER();
  const result = await resolveAdapter(provider, 'ideogram-3').execute('generate', provider, {
    model: 'ideogram-3', prompt: 'a poster', fitted: { omit: true }
  }, new AbortController().signal);

  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png');
});

test('ideogram 的 data.0.url 经 fetchResultImage 下载（同源带凭据），描述符自己不下载', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    if (target === 'https://api.ideogram.ai/v2/image/generate/ideogram-3') {
      return jsonResponse({ data: [{ url: 'https://api.ideogram.ai/out.png' }] });
    }
    if (target === 'https://api.ideogram.ai/out.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const provider = IDEOGRAM_PROVIDER();
  const result = await resolveAdapter(provider, 'ideogram-3').execute('generate', provider, {
    model: 'ideogram-3', prompt: 'a poster', fitted: { omit: true }
  }, new AbortController().signal);

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  const download = calls.find((call) => call.url === 'https://api.ideogram.ai/out.png');
  assert.ok(download, 'URL 由 execute() 交给 fetchResultImage 下载');
  // ideogram 没有声明 authHeader，所以同源下载走默认 Bearer——迁移前就是这个形状，这一步不改它。
  assert.equal(download.init.headers.Authorization, 'Bearer k');
});

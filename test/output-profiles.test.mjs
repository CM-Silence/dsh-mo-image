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
  readOutput, readTaskImage, resultNodeOf, taskPollTarget, taskSpecOf, taskStateOf, validateOutputProfile, viaUrlOf
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
  assert.throws(() => validateOutputProfile({ kind: 'xml', maxBytes: 1024, emptyMessage: 'x' }), /kind/, 'kind 只认 json / task / binary');
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
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', as: 'absolute' }] }), /pick\.as/, 'as 只认四种解释 + relative');
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', select: 'all' }] }), /select/, 'all 还没有消费者');
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', where: [{ path: 'b', equals: 1 }] }] }), /where/, 'where 只对 [] 路径生效，单值路径写了就是静默不生效');
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

/* ------------------------------------------------ task 的新字段（四条异步迁移） */

test('task 的轮询地址二选一：pollUrlPath（地址在响应里）或 path（按 id 拼）', () => {
  const base = {
    kind: 'task', statusPath: 'status', resultPath: 'out',
    success: ['OK'], failure: [], intervalMs: 1, maxBytes: 1, emptyMessage: 'x'
  };
  assert.throws(() => validateOutputProfile({ ...base }), /path.*pollUrlPath/);
  // 按 id 拼（模板里出现 {taskId}）时 idPath 必填，否则拼不出来。
  assert.throws(() => validateOutputProfile({ ...base, path: '/tasks/{taskId}' }), /idPath/);
  assert.doesNotThrow(() => validateOutputProfile({ ...base, path: '/tasks/{taskId}', idPath: 'id' }));
  // 地址在响应里：不需要 path / idPath。
  assert.doesNotThrow(() => validateOutputProfile({ ...base, pollUrlPath: 'polling_url' }));
});

test('task 的 via 只认 json-get，必须显式写 maxBytes，且不许带 headers', () => {
  const task = {
    kind: 'task', pollUrlPath: 'status_url', statusPath: 'status', resultPath: 'out',
    success: ['OK'], failure: [], intervalMs: 1, maxBytes: 1, emptyMessage: 'x'
  };
  assert.throws(() => validateOutputProfile({ ...task, via: { kind: 'poll', urlPath: ['a'], maxBytes: 1 } }), /via\.kind/);
  assert.throws(() => validateOutputProfile({ ...task, via: { kind: 'json-get', urlPath: [], maxBytes: 1 } }), /urlPath/);
  // 结果 JSON 的上限与轮询响应不同：漏写会静默落回默认值，所以必填。
  assert.throws(() => validateOutputProfile({ ...task, via: { kind: 'json-get', urlPath: ['a'] } }), /maxBytes/);
  assert.throws(
    () => validateOutputProfile({ ...task, via: { kind: 'json-get', urlPath: ['a'], maxBytes: 1, headers: {} } }),
    /凭据字段/,
    'via 也不许开 headers 的口子'
  );
  assert.doesNotThrow(
    () => validateOutputProfile({ ...task, via: { kind: 'json-get', urlPath: ['submission.response_url'], maxBytes: 1 } })
  );
});

test('taskPollTarget：{root} 去掉末尾 /v1，pollUrlPath 优先，拼不出来返回空串', () => {
  const provider = { baseUrl: 'https://api.example.cn/v1' };
  assert.equal(
    taskPollTarget({ path: '{root}/v1/tasks/{taskId}', idPath: 'task_id' }, provider, { task_id: 'a b' }),
    'https://api.example.cn/v1/tasks/a%20b',
    '{root} 去掉的是末尾 /v1，{taskId} 走 encodeURIComponent'
  );
  assert.equal(
    taskPollTarget({ path: '/tasks/{taskId}' }, provider, {}, 't1'),
    'https://api.example.cn/v1/tasks/t1',
    '不带 {root} 的模板按相对 provider 的路径拼'
  );
  assert.equal(
    taskPollTarget({ pollUrlPath: 'polling_url' }, provider, { polling_url: 'https://poll.test/1' }),
    'https://poll.test/1'
  );
  assert.equal(taskPollTarget({ pollUrlPath: 'polling_url' }, provider, {}), '', '提交响应没给就是空串');
  assert.equal(taskPollTarget({ path: '{root}/v1/tasks/{taskId}', idPath: 'task_id' }, provider, {}), '');
});

test('viaUrlOf：先看提交响应，再看轮询载荷；只产出 URL 字符串', () => {
  const via = { kind: 'json-get', urlPath: ['submission.response_url', 'payload.response_url'] };
  assert.equal(
    viaUrlOf(via, { response_url: 'https://q/from-submit' }, { response_url: 'https://q/from-poll' }),
    'https://q/from-submit'
  );
  assert.equal(viaUrlOf(via, {}, { response_url: 'https://q/from-poll' }), 'https://q/from-poll');
  assert.equal(viaUrlOf(via, {}, {}), '');
});

test('taskStateOf：errorPath 把成功状态翻成失败；状态词比较不区分大小写', () => {
  const fal = {
    statusPath: 'status', success: ['COMPLETED'], failure: [], errorPath: 'error', resultPath: 'images.0.url'
  };
  assert.deepEqual(taskStateOf(fal, { status: 'COMPLETED' }), { state: 'success', status: 'COMPLETED', node: null });
  assert.deepEqual(
    taskStateOf(fal, { status: 'COMPLETED', error: 'runner crashed' }),
    { state: 'failure', status: 'COMPLETED', message: 'runner crashed' }
  );
  // 迁移前的语义：COMPLETED 以外的状态词一律算「还在跑」，失败只看 error 字段。
  assert.deepEqual(taskStateOf(fal, { status: 'IN_PROGRESS' }), { state: 'pending', status: 'IN_PROGRESS' });

  const replicate = {
    statusPath: 'status', success: ['succeeded'], failure: ['failed'], failureMessagePath: ['error'], resultPath: 'output'
  };
  assert.deepEqual(taskStateOf(replicate, { status: 'Succeeded' }), { state: 'success', status: 'SUCCEEDED', node: null });
  assert.equal(taskStateOf(replicate, { status: 'FAILED', error: 'boom' }).message, 'boom');
});

test('resultNodeOf：有序候选，空数组 / 空串按「没有」处理', () => {
  const spec = { resultPath: ['output_images', 'data.0.url'] };
  assert.deepEqual(resultNodeOf({ output_images: ['https://cdn.test/a.png'] }, spec), ['https://cdn.test/a.png']);
  assert.deepEqual(resultNodeOf({ output_images: [], data: [{ url: 'https://cdn.test/b.png' }] }, spec), 'https://cdn.test/b.png');
  assert.equal(resultNodeOf({ output_images: '' }, spec), null, '空串不是结果');
  assert.equal(resultNodeOf({}, spec), null);
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

/* ------------------------------------------ binary（stability 迁移的新 kind） */

test('binary 描述符：kind 认 binary，字段只有 kind / maxBytes / emptyMessage', () => {
  assert.doesNotThrow(() => validateOutputProfile({ kind: 'binary', maxBytes: 1, emptyMessage: 'x' }));
  assert.throws(
    () => validateOutputProfile({ kind: 'binary', maxBytes: 1, emptyMessage: 'x', pick: [] }),
    /不认识的字段 pick/,
    'binary 没有 pick：拼错字段不能静默不生效'
  );
});

test('readOutput kind:binary：响应头取 contentType、签名兜底，JSON {image} 也照吃', () => {
  const profile = { kind: 'binary', maxBytes: 1, emptyMessage: 'stability 没有图' };
  const bytes = Buffer.from(PNG_1PX, 'base64');
  assert.deepEqual(
    readOutput(null, profile, { binary: bytes, contentType: 'image/png' }),
    { bytes: bytes, contentType: 'image/png' }
  );
  assert.deepEqual(
    readOutput(null, profile, { binary: bytes, contentType: 'text/plain; charset=utf-8' }),
    { bytes: bytes, contentType: 'image/png' },
    '非图片响应头按图片签名兜底'
  );
  assert.deepEqual(
    readOutput({ image: PNG_1PX }, profile, { binary: Buffer.from('not an image') }).bytes,
    bytes,
    'JSON 形态（stability 的 application/json 响应）仍然能读'
  );
  assert.throws(() => readOutput(null, profile, { binary: Buffer.from('not an image') }), /stability 没有图/);
  assert.throws(
    () => readOutput({ message: 'no image' }, profile, { binary: null }),
    /格式不认识/,
    'JSON 里没有图时保留 decodeImagePayload 的原文案，不被 emptyMessage 覆盖'
  );
});

/* ------------------------------------- from 级联 + text 正则（openai-chat） */

/** openai-chat 迁完后的形状：先 images[]、再 content 两级正则、最后兜底扫描。 */
function chatProfile() {
  return {
    kind: 'json',
    from: [
      { path: 'choices.0.message.images[]', as: 'auto', any: ['image_url.url', 'url', ''] },
      {
        path: 'choices.0.message.content',
        text: [
          { regex: 'data:image/[a-z+]+;base64,[A-Za-z0-9+/=\\r\\n]+', as: 'base64' },
          { regex: 'https?://[^\\s)"\'<>]+\\.(?:png|jpe?g|webp)(?:\\?[^\\s)"\'<>]*)?', as: 'url' }
        ]
      }
    ],
    scan: true,
    maxBytes: 1024,
    emptyMessage: '该中转没有返回图片'
  };
}

test('from 的 images[] + any：元素可以是字符串 / image_url.url / url，按元素顺序判定', () => {
  const profile = chatProfile();
  assert.deepEqual(
    readOutput({ choices: [{ message: { images: ['https://cdn.test/a.png'] } }] }, profile),
    { url: 'https://cdn.test/a.png' },
    '字符串元素走 any 的 ""（元素本身）'
  );
  assert.deepEqual(
    readOutput({
      choices: [{ message: { images: [
        { image_url: { url: 'data:image/png;base64,' + PNG_1PX } },
        { url: 'https://cdn.test/b.png' }
      ] } }]
    }, profile).bytes,
    Buffer.from(PNG_1PX, 'base64'),
    '带 image_url.url 的对象元素'
  );
  assert.deepEqual(
    readOutput({ choices: [{ message: { images: [{ url: 'https://cdn.test/b.png' }] } }] }, profile),
    { url: 'https://cdn.test/b.png' },
    '带 url 的对象元素'
  );
});

test('from 的 text：content 是字符串或 parts[].text，正则按「先 data URL、再 http」跨文本判定', () => {
  const profile = chatProfile();
  assert.deepEqual(
    readOutput({
      choices: [{ message: { content: [
        { type: 'text', text: 'here:' },
        { type: 'text', text: 'data:image/png;base64,' + PNG_1PX }
      ] } }]
    }, profile).bytes,
    Buffer.from(PNG_1PX, 'base64'),
    'parts[].text'
  );
  assert.deepEqual(
    readOutput({ choices: [{ message: { content: 'see https://cdn.test/c.png' } }] }, profile),
    { url: 'https://cdn.test/c.png' },
    '字符串 content 里的 http 链接'
  );
  assert.deepEqual(
    readOutput({ choices: [{ message: { content: 'data:image/png;base64,' + PNG_1PX } }] }, profile).bytes,
    Buffer.from(PNG_1PX, 'base64'),
    '字符串 content 里的 data URL'
  );
  // 文本顺序里 http 链接在前、data URL 在后：迁移前的代码是「先所有文本找 data URL」，
  // 所以这里必须选 data URL；按「逐段文本依次试正则」会选错。
  assert.deepEqual(
    readOutput({ choices: [{ message: { content: [
      { text: 'https://cdn.test/d.png' },
      { text: 'data:image/png;base64,' + PNG_RED }
    ] } }] }, profile).bytes,
    Buffer.from(PNG_RED, 'base64'),
    '正则级优先于文本顺序'
  );
});

test('from 级联全部落空：scan 兜底；仍没有则抛 emptyMessage（不把 decode 文案透出去）', () => {
  const profile = chatProfile();
  assert.deepEqual(
    readOutput({ data: [{ url: 'https://cdn.test/e.png' }] }, profile),
    { url: 'https://cdn.test/e.png' }
  );
  assert.throws(
    () => readOutput({ choices: [{ message: { content: '抱歉' } }] }, profile),
    /该中转没有返回图片/,
    'openai-chat 迁移前就是吞掉扫描错误再报自己的文案'
  );
});

test('from / text 的字段白名单与取值：拼错的字段不静默生效', () => {
  const base = { kind: 'json', maxBytes: 1, emptyMessage: 'x' };
  assert.throws(() => validateOutputProfile({ ...base, from: [] }), /from/);
  assert.throws(() => validateOutputProfile({ ...base, from: [{ path: 'a', text: [] }] }), /text/);
  assert.throws(
    () => validateOutputProfile({ ...base, from: [{ path: 'a', text: [{ regex: '(', as: 'base64' }] }] }),
    /正则/
  );
  assert.throws(
    () => validateOutputProfile({ ...base, from: [{ path: 'a', text: [{ regex: 'x', as: 'relative' }] }] }),
    /as/
  );
  assert.throws(() => validateOutputProfile({ ...base, from: [{ path: 'a', any: 'url' }] }), /any/);
  assert.throws(() => validateOutputProfile({ ...base, from: [{ path: 'a', unknown: 1 }] }), /不认识的字段 unknown/);
  assert.doesNotThrow(() => validateOutputProfile({ ...base, from: [{ path: 'a', any: ['url', ''] }] }));
});

/* --------------------------- 第二批迁移新增的词汇表（gemini / swarmui / recraft） */

test('select：默认 first，last 把候选列反过来——每个候选仍然试到底', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'x' };
  const last = {
    ...base,
    pick: [{ path: 'parts[].data', as: 'base64', select: 'last' }]
  };
  assert.deepEqual(
    readOutput({ parts: [{ data: PNG_1PX }, { data: 'AAAA' }, { data: PNG_RED }] }, last).bytes,
    Buffer.from(PNG_RED, 'base64'),
    '第一个候选人赢了'
  );
  assert.deepEqual(
    readOutput({ parts: [{ data: PNG_1PX }, { data: PNG_RED }] }, last).bytes,
    Buffer.from(PNG_RED, 'base64'),
    '两张都合法时取最后一张'
  );
  assert.deepEqual(
    readOutput({ parts: [{ data: PNG_RED }, { data: 'AAAA' }] }, last).bytes,
    Buffer.from(PNG_RED, 'base64'),
    '最后一张解不出时退到前一张（与迁移前的逆序循环一致）'
  );
});

test('where：只过滤 [] 元素；notEquals 保留「没有这个字段」的元素', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'x' };
  const profile = {
    ...base,
    pick: [{
      path: 'parts[]', as: 'base64', select: 'last', any: ['data'],
      where: [{ path: 'thought', notEquals: true }]
    }]
  };
  // 没有 thought 字段的 part 必须保留（迁移前是 `part.thought === true` 才跳）。
  assert.deepEqual(readOutput({ parts: [
    { data: 'AAAA' },
    { data: PNG_RED },
    { thought: true, data: PNG_1PX }
  ] }, profile).bytes, Buffer.from(PNG_RED, 'base64'), 'thought part 被过滤，剩下最后一个');
  // 字符串 "true" 不是布尔 true，不跳（迁移前就是严格比较）。
  assert.deepEqual(readOutput({ parts: [
    { data: PNG_1PX },
    { thought: 'true', data: PNG_RED }
  ] }, profile).bytes, Buffer.from(PNG_RED, 'base64'));

  const equals = {
    ...base,
    pick: [{ path: 'output[]', as: 'base64', any: ['result'], where: [{ path: 'type', equals: 'image_generation_call' }] }]
  };
  assert.deepEqual(readOutput({ output: [
    { type: 'reasoning', result: PNG_1PX },
    { type: 'image_generation_call', result: PNG_RED }
  ] }, equals).bytes, Buffer.from(PNG_RED, 'base64'));
  assert.throws(() => readOutput({ output: [{ type: 'reasoning', result: PNG_1PX }] }, equals), /x/);
});

test('where 的写法校验：必须非空、必须恰有一个 equals / notEquals、路径拼错不生效', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'x' };
  const pick = (where) => ({ ...base, pick: [{ path: 'a[]', where: where }] });
  assert.throws(() => validateOutputProfile(pick([])), /where/);
  assert.throws(() => validateOutputProfile(pick([{ path: 'a' }])), /equals/);
  assert.throws(() => validateOutputProfile(pick([{ path: 'a', equals: 1, notEquals: 2 }])), /equals/);
  assert.throws(() => validateOutputProfile(pick([{ path: 'a', equal: 1 }])), /不认识的字段 equal/);
  assert.doesNotThrow(() => validateOutputProfile(pick([{ path: 'a', equals: 1 }])));
  assert.doesNotThrow(() => validateOutputProfile(pick([{ path: 'a', equals: false }])));
  assert.doesNotThrow(() => validateOutputProfile(pick([{ path: 'a', notEquals: true }])));
});

test('contentTypePath：纯点号路径相对父对象（openrouter 的 data.0），[] 路径相对元素（gemini 的 part）', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'x' };
  // openrouter：值本身是字符串，父对象是 data[0]。
  const openrouter = {
    ...base,
    pick: [{ path: 'data.0.b64_json', as: 'base64', contentTypePath: 'media_type' }]
  };
  const picked = readOutput({ data: [{ b64_json: PNG_RED, media_type: 'image/webp' }] }, openrouter);
  assert.deepEqual(picked.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(picked.contentType, 'image/webp', 'upstream 的 media_type 覆盖签名类型');
  assert.equal(
    readOutput({ data: [{ b64_json: PNG_RED }] }, openrouter).contentType,
    'image/png',
    '没有 media_type 时保留字节签名'
  );

  // gemini：值是 part 对象，contentTypePath 相对这个元素，可写多条候选。
  const gemini = {
    ...base,
    pick: [{
      path: 'parts[]', as: 'base64', select: 'last',
      any: ['inlineData.data', 'inline_data.data'],
      contentTypePath: ['inlineData.mimeType', 'inline_data.mime_type']
    }]
  };
  assert.equal(
    readOutput({ parts: [{ inline_data: { mime_type: 'image/webp', data: PNG_RED } }] }, gemini).contentType,
    'image/webp'
  );
  assert.equal(
    readOutput({ parts: [{ inlineData: { data: PNG_RED } }] }, gemini).contentType,
    'image/png',
    'mimeType 缺失时退回签名'
  );
  // 写法校验：空数组 / 非字符串都不许静默不生效；带 text 的条目没有读取方。
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', contentTypePath: [] }] }), /contentTypePath/);
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a', contentTypePath: [1] }] }), /contentTypePath/);
  assert.throws(
    () => validateOutputProfile({ ...base, pick: [{ path: 'a', text: [{ regex: 'x' }], contentTypePath: 'b' }] }),
    /contentTypePath/
  );
});

test('emptyDetail：只补「上游给了原因」的那一句；缺字段时文案不变', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'Gemini 没有返回图片' };
  const profile = { ...base, pick: [{ path: 'parts[].data' }], emptyDetail: { path: 'candidates.0.finishReason', label: 'finishReason' } };
  assert.throws(() => readOutput({ candidates: [{ finishReason: 'SAFETY' }] }, profile), (error) => {
    assert.equal(error.message, 'Gemini 没有返回图片（finishReason=SAFETY）');
    return true;
  });
  assert.throws(() => readOutput({ candidates: [{}] }, profile), (error) => {
    assert.equal(error.message, 'Gemini 没有返回图片');
    return true;
  });
  assert.throws(() => validateOutputProfile({ ...base, pick: [{ path: 'a' }], emptyDetail: {} }), /emptyDetail/);
  assert.throws(
    () => validateOutputProfile({ ...base, pick: [{ path: 'a' }], emptyDetail: { path: 'a', label: 'b', unknown: 1 } }),
    /不认识的字段 unknown/
  );
  // task / binary 的 emptyMessage 没有 payload 读取面，写了 emptyDetail 会静默不生效。
  assert.throws(
    () => validateOutputProfile({ kind: 'binary', maxBytes: 1, emptyMessage: 'x', emptyDetail: { path: 'a', label: 'b' } }),
    /不认识的字段 emptyDetail/
  );
});

test('纯兜底扫描：只有 scan 没有 pick 也是合法形状（recraft 迁移前就是任意位置扫描）', () => {
  const profile = { kind: 'json', scan: true, maxBytes: 1024, emptyMessage: 'Recraft 没有返回图片' };
  assert.doesNotThrow(() => validateOutputProfile(profile));
  assert.deepEqual(readOutput({ data: [{ url: 'https://cdn.test/a.png' }] }, profile), { url: 'https://cdn.test/a.png' });
  // 扫描自己的报错照旧透出去（迁移前 throw 在 decodeImagePayload 里，描述符的文案是死代码）。
  assert.throws(() => readOutput({}, profile), /格式不认识/);
  assert.throws(() => validateOutputProfile({ kind: 'json', maxBytes: 1, emptyMessage: 'x' }), /pick 或 from/);
  assert.throws(
    () => validateOutputProfile({ kind: 'json', scan: false, maxBytes: 1, emptyMessage: 'x' }),
    /pick 或 from/,
    'scan:false 等于什么都没写，不能当合法形状'
  );
});

test('pick.as 的 relative：按 options.baseUrl 拼，不把 http / data 当相对路径', () => {
  const base = { kind: 'json', maxBytes: 1024, emptyMessage: 'SwarmUI 没有返回图片' };
  const profile = { ...base, pick: [{ path: 'images.0', as: 'relative' }] };
  assert.deepEqual(
    readOutput({ images: ['View/local/raw/out.png'] }, profile, { baseUrl: 'http://127.0.0.1:7801/' }),
    { url: 'http://127.0.0.1:7801/View/local/raw/out.png' }
  );
  assert.deepEqual(
    readOutput({ images: ['/View/local/raw/out.png'] }, profile, { baseUrl: 'http://127.0.0.1:7801' }),
    { url: 'http://127.0.0.1:7801/View/local/raw/out.png' },
    '开头的斜杠不重复'
  );
  assert.throws(() => readOutput({ images: ['https://cdn.test/a.png'] }, profile, { baseUrl: 'http://h' }), /没有返回图片/);
  assert.throws(() => readOutput({ images: ['data:image/png;base64,' + PNG_1PX] }, profile, { baseUrl: 'http://h' }), /没有返回图片/);
  assert.throws(() => readOutput({ images: ['a.png'] }, profile), /没有返回图片/, '没有 baseUrl 拼不出来');
});

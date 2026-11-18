/**
 * `openai-images`（通用网关）迁到「输出候选列表」的特征化基线。
 *
 * 迁移前，这条协议的响应侧是 `image-execution.js` 里一段 `if (adapter.autoAsync)` 的启发式：
 * 认 11 个任务 id 键 / 12 个轮询地址键（**键的优先序**高于层级）、`urls.get`、9 个成功词 /
 * 9 个失败词、结果字段的键表优先级、三条猜地址规则、以及最后 `decodeImagePayload` 的任意位置扫描。
 *
 * 迁移后这些全部变成数据：`output` 是一个**有序候选数组**，读取器按顺序试，第一个解析出图的赢。
 * 这份文件用同一批真实响应钉住「顺序」——每处顺序敏感的用例都断言**调用了哪些地址、按什么顺序**，
 * 只断言"最后拿到图"是证明不了顺序的。
 *
 * 最下面一节是迁移后的字段钉住（形状 + 没有 headers）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';
import { resolveAdapter } from '../lib/adapters.js';
import { outputProfiles, readOutput, taskPlanOf, taskPollTargets, validateOutputProfile } from '../lib/output-profiles.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
// 2x2 红：与 PNG_1PX 字节不同，用来说明拿到的是哪一张。
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

function gateway(baseUrl = 'https://gateway.test/v1') {
  return { id: 'gw', name: 'gateway', baseUrl: baseUrl, key: 'gw-key', adapter: 'openai-images' };
}

/**
 * 按 URL 表分发 fetch，记下每次调用。handler 也可以是函数（拿到第几次访问）。
 * 轮询起步是 2s：这里只压缩等待时长，不改变「先等再问」的顺序（本文件不断言时序）。
 */
function stub(t, routes) {
  const calls = [];
  const seen = new Map();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; });
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, Math.min(Number(ms) || 0, 1), ...args);
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    const handler = routes[target];
    if (!handler) throw new Error('unexpected url ' + target);
    const count = (seen.get(target) || 0) + 1;
    seen.set(target, count);
    return typeof handler === 'function' ? handler(count, { url: target, init: init }) : handler;
  };
  return calls;
}

async function generate(provider) {
  const resolved = provider || gateway();
  const adapter = resolveAdapter(resolved, 'some-image-model');
  assert.equal(adapter.id, 'openai-images');
  return callImageApi('generate', adapter, resolved, {
    model: 'some-image-model', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);
}

const GEN = 'https://gateway.test/v1/images/generations';

/* ------------------------------------------------ 形态一：直接出图（同步） */

test('直接出图：data.0.b64_json → 字节，不下载也不轮询', async (t) => {
  const calls = stub(t, { [GEN]: jsonResponse({ created: 1, data: [{ b64_json: PNG_RED }] }) });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(calls.map((call) => call.url), [GEN], '提交一次就够');
});

test('直接出图：data.0.url → 走 fetchResultImage；跨源不带凭据', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ created: 1, data: [{ url: 'https://cdn.test/out.png' }] }),
    'https://cdn.test/out.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  const download = calls.find((call) => call.url === 'https://cdn.test/out.png');
  assert.ok(download, 'URL 由执行器交给 fetchResultImage');
  assert.equal(download.init.headers, undefined, '跨源结果地址不带 Key');
});

test('直接出图：同一份响应里 b64 与 url 都有时取 url（结果键表的顺序，不是扫描顺序）', async (t) => {
  // 今天认结果图用的是 taskImageOf 的键表顺序（url 在 b64_json 之前），
  // 不是 decodeImagePayload 的「先 base64」。两份都在时选的是 url —— 迁移时顺序不能照抄错。
  stub(t, {
    [GEN]: jsonResponse({ data: [{ url: 'https://cdn.test/other.png', b64_json: PNG_RED }] }),
    'https://cdn.test/other.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'), 'url 赢（下载到的是 1x1）');
  assert.notDeepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

test('直接出图：只有 b64 时才轮到 b64', async (t) => {
  stub(t, { [GEN]: jsonResponse({ data: [{ b64_json: PNG_RED }] }) });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
});

/* ------------------------------------------- 形态二：任务包络（轮询到出图） */

test('任务形态：只有 task_id → 按 /v1/tasks/{id} 派生轮询地址', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-1' }),
    // 第一次 RUNNING，第二次 SUCCEEDED（同一个地址，按访问次数切换）
    'https://gateway.test/v1/tasks/job-1': (seen) => (seen === 1
      ? jsonResponse({ task_status: 'RUNNING' })
      : jsonResponse({ task_status: 'SUCCEEDED', images: [{ url: 'https://cdn.test/out.png' }] })),
    'https://cdn.test/out.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual(calls.map((call) => call.url), [
    GEN, 'https://gateway.test/v1/tasks/job-1', 'https://gateway.test/v1/tasks/job-1', 'https://cdn.test/out.png'
  ], '派生地址只用了第一条规则，且先等再问');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer gw-key', '同源轮询带凭据');
});

test('任务形态：响应里给了 polling_url → 直接用它，不再派生', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-2', polling_url: 'https://poll.test/job-2' }),
    'https://poll.test/job-2': jsonResponse({ status: 'SUCCEEDED', images: ['https://cdn.test/out.png'] }),
    'https://cdn.test/out.png': pngResponse()
  });
  await generate();
  const polls = calls.filter((call) => call.url !== GEN && !call.url.endsWith('.png'));
  assert.deepEqual(polls.map((call) => call.url), ['https://poll.test/job-2']);
  assert.equal(polls[0].init.headers.Authorization, undefined, '跨源轮询不带 Key');
});

test('任务形态：Replicate 风格 urls.get（没有 polling_url 键）也能跟着轮询', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ id: 'pred-1', urls: { get: 'https://poll.test/pred/1' } }),
    'https://poll.test/pred/1': jsonResponse({ status: 'succeeded', output: ['https://cdn.test/out.png'] }),
    'https://cdn.test/out.png': pngResponse()
  });
  await generate();
  const polls = calls.filter((call) => /poll\.test/.test(call.url));
  assert.deepEqual(polls.map((call) => call.url), ['https://poll.test/pred/1']);
});

test('任务形态：地址键的优先序就是表里的顺序（polling_url 压过 status_url）', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({
      status_url: 'https://poll.test/by-status',
      polling_url: 'https://poll.test/by-polling',
      task_id: 'job-3'
    }),
    'https://poll.test/by-polling': jsonResponse({ status: 'done', images: ['https://cdn.test/out.png'] }),
    'https://poll.test/by-status': jsonResponse({ status: 'done', images: ['https://cdn.test/other.png'] }),
    'https://cdn.test/out.png': pngResponse(),
    'https://cdn.test/other.png': pngResponse()
  });
  await generate();
  const polls = calls.filter((call) => /poll\.test/.test(call.url));
  assert.deepEqual(polls.map((call) => call.url), ['https://poll.test/by-polling']);
});

test('任务形态：嵌套的 task_id 压过顶层的通用 id', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ id: 'generic-10', data: { task_id: 'real-10' } }),
    'https://gateway.test/v1/tasks/real-10': jsonResponse({
      task_status: 'SUCCEED', images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });
  await generate();
  const polls = calls.filter((call) => call.url.includes('/tasks/'));
  assert.deepEqual(polls.map((call) => call.url), ['https://gateway.test/v1/tasks/real-10']);
});

test('任务形态：派生地址 404/405 时换下一条规则（/v1/tasks → /tasks）', async (t) => {
  const provider = gateway('https://gateway.test/openai');
  const calls = stub(t, {
    'https://gateway.test/openai/images/generations': jsonResponse({ id: 'job-4' }),
    'https://gateway.test/openai/v1/tasks/job-4': jsonResponse({ error: 'not found' }, 404),
    'https://gateway.test/openai/tasks/job-4': jsonResponse({
      status: 'SUCCEEDED', output_images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });
  await generate(provider);
  const polls = calls.filter((call) => call.url.includes('/tasks/'));
  assert.deepEqual(polls.map((call) => call.url), [
    'https://gateway.test/openai/v1/tasks/job-4',
    'https://gateway.test/openai/tasks/job-4'
  ]);
});

test('任务形态：任务失败时把网关的 errors[].message 带出来', async (t) => {
  stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-5' }),
    'https://gateway.test/v1/tasks/job-5': jsonResponse({
      status: 'failed', errors: [{ message: 'prompt rejected by moderation' }]
    })
  });
  await assert.rejects(() => generate(), /prompt rejected by moderation/);
});

test('任务形态：成功状态词不在表里但载荷里已经有容器图 → 直接返回，继续等是错的', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-6' }),
    'https://gateway.test/v1/tasks/job-6': jsonResponse({
      status: 'GENERATING_DONE', output_images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(calls.filter((call) => call.url.includes('/tasks/')).length, 1, '只问了一次');
});

/* ------------------------------------- 形态三：202 + Location（没有任务体） */

test('无 id 但有 Location 头：照它轮询（202 也走这条路）', async (t) => {
  const calls = stub(t, {
    [GEN]: () => new Response('', { status: 202, headers: { location: 'https://poll.test/jobs/job-7' } }),
    'https://poll.test/jobs/job-7': jsonResponse({ status: 'done', images: ['https://cdn.test/out.png'] }),
    'https://cdn.test/out.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual(calls.map((call) => call.url), [GEN, 'https://poll.test/jobs/job-7', 'https://cdn.test/out.png']);
});

test('任务包络与 Location 同时出现时，任务包络优先（今天就是先认包络）', async (t) => {
  const calls = stub(t, {
    [GEN]: () => new Response(JSON.stringify({ task_id: 'job-8' }), {
      status: 202, headers: { 'content-type': 'application/json', location: 'https://poll.test/ignored' }
    }),
    'https://gateway.test/v1/tasks/job-8': jsonResponse({
      task_status: 'SUCCEEDED', images: ['https://cdn.test/out.png']
    }),
    'https://poll.test/ignored': jsonResponse({ status: 'done', images: ['https://cdn.test/other.png'] }),
    'https://cdn.test/out.png': pngResponse(),
    'https://cdn.test/other.png': pngResponse()
  });
  await generate();
  assert.ok(calls.some((call) => call.url === 'https://gateway.test/v1/tasks/job-8'), '派生地址');
  assert.equal(calls.some((call) => call.url === 'https://poll.test/ignored'), false, 'Location 没被用');
});

/* ------------------------------------------------- 混合形态与兜底扫描 */

test('混合形态：任务包络里已经带图 → 直接返回，不轮询', async (t) => {
  const calls = stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-9', url: 'https://cdn.test/out.png' }),
    'https://cdn.test/out.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(calls.filter((call) => call.url.includes('/tasks/')).length, 0, '没有轮询');
});

test('混合形态：包络里的顶层 url 不是图片时退回轮询', async (t) => {
  stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-10', url: 'https://gateway.test/status' }),
    'https://gateway.test/status': jsonResponse({ status: 'running' }),
    'https://gateway.test/v1/tasks/job-10': jsonResponse({
      task_status: 'SUCCEEDED', images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('兜底扫描：图不在 data.0 也没有任务信号 → 任意位置扫描', async (t) => {
  stub(t, {
    [GEN]: jsonResponse({ result: { previews: [{ image_url: 'https://cdn.test/moved.png' }] } }),
    'https://cdn.test/moved.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('兜底扫描：响应体本身就是图片（非 JSON）也能落地', async (t) => {
  stub(t, { [GEN]: pngResponse() });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
});

test('没有图：JSON 里没有图报「格式不认识」，空响应体报「没有返回图片」', async (t) => {
  stub(t, { [GEN]: jsonResponse({ created: 1, data: [] }) });
  await assert.rejects(() => generate(), /格式不认识/);
  stub(t, { [GEN]: jsonResponse(null) });
  await assert.rejects(() => generate(), /生图接口没有返回图片/);
});

test('同步响应的图下不下来：抛的是下载错误（不是「没有返回图片」）', async (t) => {
  // 迁移前最后一步是 decodeImagePayload + fetchResultImage，下载失败原样上抛；
  // 候选列表里这一条是**最后一项**，所以它的下载错误不能被「全部落空」吞掉。
  stub(t, {
    [GEN]: jsonResponse({ data: [{ url: 'https://cdn.test/not-an-image' }] }),
    'https://cdn.test/not-an-image': () => new Response('{"error":"nope"}', {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(() => generate(), (error) => {
    assert.match(error.message, /下载生成图失败/);
    assert.equal(error.code, 'download_failed');
    return true;
  });
});

/* -------------------------------------- 迁移后：候选列表的形状与词汇表 */

test('openai-images：output 是 4 条有序候选（现在出图 → 任务包络 → Location → 兜底扫描）', () => {
  const adapter = resolveAdapter(gateway(), 'm');
  assert.ok(Array.isArray(adapter.output), '迁移后 output 是有序候选数组');
  assert.deepEqual(adapter.output.map((item) => item.kind), ['json', 'task', 'task', 'json']);

  // 1) 直接出图：url 在 b64_json 之前（迁移前 taskImageOf 的键表顺序），**没有** scan。
  assert.deepEqual(adapter.output[0].pick, [
    { path: 'data.0.url', as: 'url' },
    { path: 'data.0.b64_json', as: 'base64' }
  ]);
  assert.equal(adapter.output[0].scan, undefined, 'scan 一旦提前，任务包络里有个图片链接就不会再轮询');

  // 2) 任务包络：键优先序 = 迁移前 firstTaskString 的键表顺序（键高于层级）。
  const task = adapter.output[1];
  assert.deepEqual(task.idPath.slice(0, 4), ['task_id', 'data.task_id', 'output.task_id', 'result.task_id']);
  assert.ok(task.idPath.indexOf('task_id') < task.idPath.indexOf('id'), 'task_id 压过通用 id');
  assert.deepEqual(task.pollUrlPath.slice(0, 4), [
    'polling_url', 'data.polling_url', 'output.polling_url', 'result.polling_url'
  ]);
  assert.ok(task.pollUrlPath.indexOf('polling_url') < task.pollUrlPath.indexOf('status_url'));
  assert.equal(task.pollUrlPath[task.pollUrlPath.length - 1], 'result.urls.get', 'urls.get 在地址键表之后');
  assert.deepEqual(task.path, ['{root}/v1/tasks/{taskId}', '/tasks/{taskId}', '{submitUrl}/{taskId}']);
  assert.deepEqual(task.success, [
    'SUCCEED', 'SUCCEEDED', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'DONE', 'FINISHED', 'READY'
  ]);
  assert.deepEqual(task.failure, [
    'FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'ABORTED', 'REJECTED', 'EXPIRED', 'MODERATED'
  ]);
  assert.deepEqual(task.statusPath.slice(0, 3), ['task_status', 'task_status.status', 'task_status.state']);
  assert.deepEqual(task.errorPath.slice(0, 4), ['error', 'data.error', 'output.error', 'result.error']);
  assert.ok(task.resultPath.indexOf('url') < task.resultPath.indexOf('b64_json'), '结果键表里 url 在前');
  assert.equal(task.scan, true, '成功状态词不在表里但载荷带图时也要能出图');
  assert.equal(task.intervalMs, 2000, '迁移前 followTask 的固定起步间隔');
  assert.equal(task.maxBytes, 32 * 1024 * 1024);

  // 3) Location：只在响应头里，读法（状态词/结果/失败文案）与包络那条完全一样。
  const location = adapter.output[2];
  assert.equal(location.pollUrlFrom, 'location');
  assert.equal(location.idPath, undefined, 'Location 形态没有任务体');
  assert.deepEqual(location.resultPath, task.resultPath);
  assert.deepEqual(location.success, task.success);

  // 4) 兜底：任意位置扫描（迁移前就是 decodeImagePayload(parsed, buffer)）。
  const scan = adapter.output[3];
  assert.equal(scan.scan, true);
  assert.equal(scan.pick, undefined);

  // 描述符不碰凭据/请求头：整段数据里不许出现这些键。
  assert.doesNotMatch(JSON.stringify(adapter.output), /"(headers|authorization|apiKey|token|secret)"/i);
});

/* --------------------------------- 两处已知行为差异（钉住，别当没发生） */

test('已知差异①：还在跑、但载荷里已经有图（非容器键）→ 现在直接返回，不再等到成功', async (t) => {
  // 迁移前是三层读取：容器键（images/output/output_images…）**总是**读；顶层 url / b64_json
  // 这类键只在「成功或没有状态词」时读；任意位置扫描只在成功时跑。
  // 数据化之后 resultPath 是一条有序键表、不再按状态分层，所以「RUNNING + 顶层 url」也算结果。
  // 方向是**放宽**，只影响「图已经在响应里、状态词还没到」这一种情形。
  const calls = stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-x' }),
    'https://gateway.test/v1/tasks/job-x': jsonResponse({
      status: 'RUNNING', url: 'https://cdn.test/preview.png'
    }),
    'https://cdn.test/preview.png': pngResponse()
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(calls.filter((call) => call.url.includes('/tasks/')).length, 1, '一次轮询就出图');
});

test('已知差异②：成功状态词 + 错误字段 → 现在算失败（迁移前会继续找图再报「没有图」）', async (t) => {
  // 迁移前通用网关的成功分支不看 error 字段；描述符的 errorPath 把 fal 那条规则
  // （状态说完成、但载荷带 error）推广到了所有 task 描述符，通用网关因此也吃到。
  // 两边的结果都是报错，差别只在文案：失败原因 vs「完成了但没有返回图片」。
  stub(t, {
    [GEN]: jsonResponse({ task_id: 'job-y' }),
    'https://gateway.test/v1/tasks/job-y': jsonResponse({
      task_status: 'SUCCEEDED', errors: [{ message: 'moderation blocked the result' }]
    })
  });
  await assert.rejects(() => generate(), /moderation blocked the result/);
});

test('候选数组的校验：必须非空，每一项各自过铁律，报错要点出是第几项', () => {
  const ok = { kind: 'json', scan: true, maxBytes: 1, emptyMessage: 'x' };
  assert.throws(() => outputProfiles([], 'gw'), /非空数组/);
  assert.throws(() => outputProfiles([ok, { kind: 'json' }], 'gw'), /候选\[1\]/);
  assert.throws(() => validateOutputProfile([ok], 'gw'), /必须是一个对象/, '单描述符入口不认数组');
  assert.doesNotThrow(() => outputProfiles([ok], 'gw'));
  // 有序路径字段：字符串与数组都吃，空数组不收。
  const task = {
    kind: 'task', pollUrlFrom: 'location', statusPath: 'status', resultPath: 'out',
    success: ['OK'], failure: [], intervalMs: 1, maxBytes: 1, emptyMessage: 'x'
  };
  assert.doesNotThrow(() => validateOutputProfile(task));
  assert.doesNotThrow(() => validateOutputProfile({ ...task, statusPath: ['a', 'b'], resultPath: ['x', 'y'] }));
  assert.throws(() => validateOutputProfile({ ...task, statusPath: [] }), /statusPath/);
  assert.throws(() => validateOutputProfile({ ...task, pollUrlFrom: 'etag' }), /pollUrlFrom/);
  assert.throws(
    () => validateOutputProfile({ ...task, path: '/tasks/{taskId}', idPath: 'id' }),
    /不能和 path \/ pollUrlPath 同时写/
  );
});

test('readOutput 吃候选数组：第一个解析出图的赢，全落空抛最后一项的错误', () => {
  const first = { kind: 'json', pick: [{ path: 'a', as: 'base64' }], maxBytes: 1, emptyMessage: '第一项' };
  const second = { kind: 'json', pick: [{ path: 'b', as: 'base64' }], maxBytes: 1, emptyMessage: '第二项' };
  assert.deepEqual(
    readOutput({ b: PNG_RED }, [first, second]).bytes,
    Buffer.from(PNG_RED, 'base64'),
    '第一项落空就试第二项'
  );
  assert.deepEqual(
    readOutput({ a: PNG_RED, b: PNG_1PX }, [first, second]).bytes,
    Buffer.from(PNG_RED, 'base64'),
    '顺序即优先级'
  );
  assert.throws(() => readOutput({}, [first, second]), /第二项/, '全部落空用**最后一项**的文案');
});

test('taskPollTargets：响应地址 → 三条派生规则，按顺序、去重、{submitUrl} 与编码', () => {
  const provider = { baseUrl: 'https://gateway.test/v1' };
  const spec = {
    pollUrlPath: ['polling_url', 'status_url'],
    idPath: 'task_id',
    path: ['{root}/v1/tasks/{taskId}', '/tasks/{taskId}', '{submitUrl}/{taskId}']
  };
  assert.deepEqual(
    taskPollTargets(spec, provider, { task_id: 'a b', polling_url: 'https://poll.test/1' }, '', 'https://gateway.test/v1/images/generations'),
    [
      'https://poll.test/1',
      'https://gateway.test/v1/tasks/a%20b',
      'https://gateway.test/v1/images/generations/a%20b'
    ],
    '响应给的地址第一，其次 /v1/tasks，再 /tasks（与站点根相同就去重），最后提交地址/{id}'
  );
  // 没有 id 时只剩响应给的那条；没有响应地址时只剩派生规则。
  assert.deepEqual(
    taskPollTargets(spec, provider, { polling_url: 'https://poll.test/1' }, '', 'https://gateway.test/v1/images/generations'),
    ['https://poll.test/1']
  );
  assert.deepEqual(
    taskPollTargets(spec, provider, { task_id: 'x' }, '', 'https://gateway.test/v1/images/generations'),
    ['https://gateway.test/v1/tasks/x', 'https://gateway.test/v1/images/generations/x']
  );
});

test('taskPlanOf：拿到 id 或地址才算任务；Location 形态只认响应头', () => {
  const spec = {
    kind: 'task', pollUrlPath: ['polling_url'], idPath: ['task_id', 'id'],
    path: ['/tasks/{taskId}', '{submitUrl}/{taskId}'], statusPath: 'status', resultPath: 'out',
    success: ['OK'], failure: [], intervalMs: 1, maxBytes: 1, emptyMessage: 'x'
  };
  const ctx = { provider: { baseUrl: 'https://gateway.test/v1' }, submitUrl: 'https://gateway.test/v1/images/generations' };
  assert.equal(taskPlanOf(spec, { foo: 1 }, ctx), null, '既没有 id 也没有地址：不是任务');
  assert.deepEqual(taskPlanOf(spec, { id: 'job' }, ctx).pollTargets, [
    'https://gateway.test/v1/tasks/job', 'https://gateway.test/v1/images/generations/job'
  ]);
  const location = { ...spec, pollUrlPath: undefined, idPath: undefined, path: undefined, pollUrlFrom: 'location' };
  assert.equal(taskPlanOf(location, {}, ctx), null, '没有 Location 头就不成立');
  assert.deepEqual(taskPlanOf(location, {}, { ...ctx, location: 'https://poll.test/j' }).pollTargets, ['https://poll.test/j']);
});

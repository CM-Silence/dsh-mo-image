/**
 * 四条异步协议迁到输出描述符的**端到端特征化基线**：bfl / replicate / modelscope / fal。
 *
 * 为什么单独一个文件：别的测试盯的是「最后拿到字节没有」，这里盯的是**线上发生了什么**——
 * 提交体原文（JSON 字符串，键顺序也算）、轮询的次数与顺序、每一跳的请求头、
 * 结果图下载地址、轮询间隔。迁移只许换写法，不许换行为。
 *
 * 这份 golden 是**迁移前**从旧 `async` 描述符（pollUrl / statusOf / resolve）录下来的：
 * 迁移后必须原样对上；四条各自先绿再迁，迁完仍绿。改动任何一条，
 * 对应协议的测试就会在这一行红掉，而不是等到用户投诉「这家中转突然不认了」。
 *
 * 覆盖不到的地方（迁移报告里点名）：上游返回垃圾（status 之外的错误形态）、
 * 结果图 URL 不是 http(s)、提交响应缺 task_id 时的**报错文案**——这些没有线上断言，
 * 迁移前后可能有一两句话不一样，见 test/async-protocols.test.mjs 的字段钉住用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';
import { resolveAdapter } from '../lib/adapters.js';
import { resetAsyncSchemaCache } from '../lib/adapters/async.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const FITTED = { width: 1024, height: 1024, size: '1024x1024' };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function imageResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/** 头里的键排过序，只为了 golden 好读；值一个不改。 */
function plainHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = String(value[key]);
  return out;
}

/** 记录每一次出站请求：url / method / headers / body 原文。routes 返回 null 表示「没打桩」。 */
function recordRequests(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method || 'GET'),
      headers: plainHeaders(init.headers),
      body: init.body === undefined ? null : String(init.body)
    };
    calls.push(call);
    const response = routes(call, calls);
    if (!response) throw new Error('unexpected url ' + call.url);
    return response;
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/**
 * 轮询间隔照实记下来，但定时器立刻放行：测试不真的等 1–2 秒。
 *
 * 只记「第一条出站请求之后」的等待：Windows 上读系统代理会挂一个 5s 兜底定时器
 * （lib/proxy.js 的 readSystemProxy），它发生在第一个请求之前，与轮询无关。
 */
function recordWaits(t, calls) {
  const waits = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (calls.length) waits.push(Number(ms) || 0);
    return original(fn, 0, ...args);
  };
  t.after(() => { globalThis.setTimeout = original; });
  return waits;
}

function seen(calls, url) {
  return calls.filter((call) => call.url === url).length;
}

/* ------------------------------------------------------------------- bfl */

test('bfl：提交 → 轮询两次 polling_url → result.sample → 下载（请求序列与迁移前逐字节一致）', async (t) => {
  const calls = recordRequests(t, (call) => {
    if (call.url === 'https://api.bfl.ai/v1/flux-2-pro') {
      return jsonResponse({ id: 'job-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-1' });
    }
    if (call.url === 'https://api.bfl.ai/v1/get_result?id=job-1') {
      if (seen(calls, call.url) === 1) return jsonResponse({ id: 'job-1', status: 'Pending' });
      return jsonResponse({ id: 'job-1', status: 'Ready', result: { sample: 'https://cdn.test/bfl.png' } });
    }
    if (call.url === 'https://cdn.test/bfl.png') return imageResponse();
    return null;
  });
  const waits = recordWaits(t, calls);

  const provider = { baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl', key: 'k' };
  const result = await callImageApi('generate', resolveAdapter(provider, 'flux-2-pro'), provider, {
    model: 'flux-2-pro', prompt: 'a fox', fitted: FITTED
  }, new AbortController().signal);

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual({ calls: calls, waits: waits }, {
    calls: [
      {
        url: 'https://api.bfl.ai/v1/flux-2-pro',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-key': 'k' },
        body: '{"prompt":"a fox","width":1024,"height":1024,"output_format":"png"}'
      },
      {
        url: 'https://api.bfl.ai/v1/get_result?id=job-1',
        method: 'GET',
        headers: { 'x-key': 'k' },
        body: null
      },
      {
        url: 'https://api.bfl.ai/v1/get_result?id=job-1',
        method: 'GET',
        headers: { 'x-key': 'k' },
        body: null
      },
      {
        url: 'https://cdn.test/bfl.png',
        method: 'GET',
        headers: {},
        body: null
      }
    ],
    waits: [1000, 1150]
  });
});

/* -------------------------------------------------------------- replicate */

test('replicate：schema → 提交 → 轮询两次 urls.get → output → 下载（请求序列与迁移前逐字节一致）', async (t) => {
  resetAsyncSchemaCache();
  const calls = recordRequests(t, (call) => {
    const schema = 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro';
    const submit = schema + '/predictions';
    const poll = 'https://api.replicate.com/v1/predictions/p1';
    if (call.url === schema) {
      return jsonResponse({
        latest_version: {
          openapi_schema: {
            components: {
              schemas: { Input: { properties: { prompt: { type: 'string' } } } }
            }
          }
        }
      });
    }
    if (call.url === submit) {
      return jsonResponse({ id: 'p1', status: 'starting', urls: { get: poll } });
    }
    if (call.url === poll) {
      if (seen(calls, poll) === 1) return jsonResponse({ status: 'processing' });
      return jsonResponse({ status: 'succeeded', output: ['https://cdn.test/rep.png'] });
    }
    if (call.url === 'https://cdn.test/rep.png') return imageResponse();
    return null;
  });
  const waits = recordWaits(t, calls);

  const provider = { baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8_test' };
  const result = await callImageApi('generate', resolveAdapter(provider, 'black-forest-labs/flux-2-pro'), provider, {
    model: 'black-forest-labs/flux-2-pro', prompt: 'a fox', fitted: FITTED
  }, new AbortController().signal);

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual({ calls: calls, waits: waits }, {
    calls: [
      {
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro',
        method: 'GET',
        headers: { Authorization: 'Bearer r8_test', 'Content-Type': 'application/json' },
        body: null
      },
      {
        url: 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
        method: 'POST',
        headers: { Authorization: 'Bearer r8_test', 'Content-Type': 'application/json' },
        body: '{"input":{"prompt":"a fox"}}'
      },
      {
        url: 'https://api.replicate.com/v1/predictions/p1',
        method: 'GET',
        headers: { Authorization: 'Bearer r8_test', 'Content-Type': 'application/json' },
        body: null
      },
      {
        url: 'https://api.replicate.com/v1/predictions/p1',
        method: 'GET',
        headers: { Authorization: 'Bearer r8_test', 'Content-Type': 'application/json' },
        body: null
      },
      {
        url: 'https://cdn.test/rep.png',
        method: 'GET',
        headers: {},
        body: null
      }
    ],
    waits: [1000, 1150]
  });
});

/* -------------------------------------------------------------- modelscope */

test('modelscope：提交 → 轮询两次 {root}/v1/tasks/{id}（带 Task-Type）→ output_images → 下载', async (t) => {
  const calls = recordRequests(t, (call) => {
    if (call.url === 'https://api-inference.modelscope.cn/v1/images/generations') {
      return jsonResponse({ task_id: 'task-1', task_status: 'PENDING' });
    }
    if (call.url === 'https://api-inference.modelscope.cn/v1/tasks/task-1') {
      if (seen(calls, call.url) === 1) return jsonResponse({ task_id: 'task-1', task_status: 'RUNNING' });
      return jsonResponse({ task_id: 'task-1', task_status: 'SUCCEED', output_images: ['https://cdn.test/out.png'] });
    }
    if (call.url === 'https://cdn.test/out.png') return imageResponse();
    return null;
  });
  const waits = recordWaits(t, calls);

  // 站点根（不带 /v1）：轮询路径必须自己补出 {root}/v1/tasks/{id}。
  const provider = { baseUrl: 'https://api-inference.modelscope.cn', key: 'ms-key' };
  const result = await callImageApi('generate', resolveAdapter(provider, 'Qwen/Qwen-Image-2.1'), provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a red fox in the snow', fitted: FITTED
  }, new AbortController().signal);

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual({ calls: calls, waits: waits }, {
    calls: [
      {
        url: 'https://api-inference.modelscope.cn/v1/images/generations',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ms-key',
          'Content-Type': 'application/json',
          'X-ModelScope-Async-Mode': 'true'
        },
        body: '{"prompt":"a red fox in the snow","model":"Qwen/Qwen-Image-2.1","size":"1024x1024"}'
      },
      {
        url: 'https://api-inference.modelscope.cn/v1/tasks/task-1',
        method: 'GET',
        headers: { Authorization: 'Bearer ms-key', 'X-ModelScope-Task-Type': 'image_generation' },
        body: null
      },
      {
        url: 'https://api-inference.modelscope.cn/v1/tasks/task-1',
        method: 'GET',
        headers: { Authorization: 'Bearer ms-key', 'X-ModelScope-Task-Type': 'image_generation' },
        body: null
      },
      {
        url: 'https://cdn.test/out.png',
        method: 'GET',
        headers: {},
        body: null
      }
    ],
    waits: [2000, 2300]
  });
});

/* ------------------------------------------------------------------- fal */

test('fal：提交 → 轮询两次 status_url（202 待续）→ 二次 GET response_url → images → 下载', async (t) => {
  const calls = recordRequests(t, (call) => {
    if (call.url === 'https://queue.fal.run/fal-ai/flux-2-pro') {
      return jsonResponse({
        status: 'IN_QUEUE',
        request_id: 'r1',
        status_url: 'https://queue.test/s',
        response_url: 'https://queue.test/r'
      });
    }
    if (call.url === 'https://queue.test/s') {
      if (seen(calls, call.url) === 1) return jsonResponse({ status: 'IN_PROGRESS' }, 202);
      return jsonResponse({ status: 'COMPLETED' });
    }
    if (call.url === 'https://queue.test/r') return jsonResponse({ images: [{ url: 'https://cdn.test/fal.png' }] });
    if (call.url === 'https://cdn.test/fal.png') return imageResponse();
    return null;
  });
  const waits = recordWaits(t, calls);

  const provider = { baseUrl: 'https://queue.fal.run', adapter: 'fal', key: 'k' };
  const result = await callImageApi('generate', resolveAdapter(provider, 'fal-ai/flux-2-pro'), provider, {
    model: 'fal-ai/flux-2-pro', prompt: 'a fox', fitted: FITTED
  }, new AbortController().signal);

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.deepEqual({ calls: calls, waits: waits }, {
    calls: [
      {
        url: 'https://queue.fal.run/fal-ai/flux-2-pro',
        method: 'POST',
        headers: { Authorization: 'Key k', 'Content-Type': 'application/json' },
        body: '{"prompt":"a fox","num_images":1,"output_format":"jpeg","image_size":{"width":1024,"height":1024}}'
      },
      {
        url: 'https://queue.test/s',
        method: 'GET',
        headers: {},
        body: null
      },
      {
        url: 'https://queue.test/s',
        method: 'GET',
        headers: {},
        body: null
      },
      {
        url: 'https://queue.test/r',
        method: 'GET',
        headers: {},
        body: null
      },
      {
        url: 'https://cdn.test/fal.png',
        method: 'GET',
        headers: {},
        body: null
      }
    ],
    waits: [1000, 1150]
  });
});

/* ---------------------------------------------- 结果图下载的凭据范围（同源 / 跨源） */

/**
 * 四条协议的结果图下载都走 fetchResultImage()：同源带自己的 Key、跨源 CDN 不带。
 * 前面四条用例的下载都在 cdn.test（跨源），这里把同源那一半补上——
 * 鉴权头形态（x-key / Key / Bearer）也一并钉住，省得以后哪家被写成统一 Bearer。
 */
test('四条异步协议的结果图下载：同源带 Key，跨源 CDN 不带', async (t) => {
  resetAsyncSchemaCache();
  const routes = new Map([
    ['https://api.bfl.ai/v1/flux-2-pro', () => jsonResponse({ polling_url: 'https://api.bfl.ai/v1/get_result?id=j1' })],
    ['https://api.bfl.ai/v1/get_result?id=j1', () => jsonResponse({ status: 'Ready', result: { sample: 'https://api.bfl.ai/v1/out.png' } })],
    ['https://api.bfl.ai/v1/out.png', imageResponse],
    ['https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro', () => jsonResponse({
      latest_version: { openapi_schema: { components: { schemas: { Input: { properties: {} } } } } }
    })],
    ['https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions', () => jsonResponse({
      id: 'p1', urls: { get: 'https://api.replicate.com/v1/predictions/p1' }
    })],
    ['https://api.replicate.com/v1/predictions/p1', () => jsonResponse({
      status: 'succeeded', output: ['https://api.replicate.com/v1/out.png']
    })],
    ['https://api.replicate.com/v1/out.png', imageResponse],
    ['https://api-inference.modelscope.cn/v1/images/generations', () => jsonResponse({ task_id: 't1' })],
    ['https://api-inference.modelscope.cn/v1/tasks/t1', () => jsonResponse({
      task_status: 'SUCCEED', output_images: ['https://api-inference.modelscope.cn/v1/out.png']
    })],
    ['https://api-inference.modelscope.cn/v1/out.png', imageResponse],
    ['https://queue.fal.run/fal-ai/flux-2-pro', () => jsonResponse({
      status_url: 'https://queue.fal.run/s1', response_url: 'https://queue.fal.run/r1'
    })],
    ['https://queue.fal.run/s1', () => jsonResponse({ status: 'COMPLETED' })],
    ['https://queue.fal.run/r1', () => jsonResponse({ images: [{ url: 'https://queue.fal.run/fal-ai/flux-2-pro/out.png' }] })],
    ['https://queue.fal.run/fal-ai/flux-2-pro/out.png', imageResponse]
  ]);
  const calls = recordRequests(t, (call) => (routes.get(call.url) ? routes.get(call.url)() : null));
  recordWaits(t, calls); // 这里不断言间隔，只把 1–2s 的轮询等待快进掉

  const runs = [
    { provider: { baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl', key: 'k' }, model: 'flux-2-pro' },
    {
      provider: { baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8' },
      model: 'black-forest-labs/flux-2-pro'
    },
    { provider: { baseUrl: 'https://api-inference.modelscope.cn', key: 'ms' }, model: 'Qwen/Qwen-Image-2.1' },
    { provider: { baseUrl: 'https://queue.fal.run', adapter: 'fal', key: 'fal' }, model: 'fal-ai/flux-2-pro' }
  ];
  for (const run of runs) {
    await callImageApi('generate', resolveAdapter(run.provider, run.model), run.provider, {
      model: run.model, prompt: 'x', fitted: FITTED
    }, new AbortController().signal);
  }

  const headersOf = (url) => {
    const call = calls.find((item) => item.url === url);
    assert.ok(call, '结果图必须真的被下载：' + url);
    return call.headers;
  };
  assert.deepEqual(headersOf('https://api.bfl.ai/v1/out.png'), { 'x-key': 'k' });
  assert.deepEqual(headersOf('https://api.replicate.com/v1/out.png'), { Authorization: 'Bearer r8' });
  assert.deepEqual(headersOf('https://api-inference.modelscope.cn/v1/out.png'), { Authorization: 'Bearer ms' });
  assert.deepEqual(headersOf('https://queue.fal.run/fal-ai/flux-2-pro/out.png'), { Authorization: 'Key fal' });
});

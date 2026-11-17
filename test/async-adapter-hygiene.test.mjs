import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  preparePhaseAsync, analyzeComfyWorkflow, resetComfyObjectInfoCache, resolveAdapter
} from '../lib/adapters.js';
import { callImageApi } from '../lib/index.js';
import { resetAsyncSchemaCache } from '../lib/adapters/async.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

function referenceImage() {
  return { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };
}

/* --------------------------------------------------------- preparePhaseAsync */

/** 造一个新式异步描述符：提交体故意做成「顶层 + input 嵌套」，覆盖点分路径删除。 */
function phaseAdapter(overrides = {}) {
  return Object.assign({
    id: 'phase-test',
    label: 'Phase test',
    headers: { 'x-app': 'dsh' },
    async: {
      edit: true,
      submitPath: () => '/jobs',
      build: async (input) => ({
        body: {
          prompt: input.prompt,
          model: input.model,
          input: {
            prompt: input.prompt,
            model: input.model,
            width: input.width,
            height: input.height,
            image: 'data:image/png;base64,AAAA'
          },
          width: input.width,
          steps: 20,
          guidance: 3.5
        },
        note: 'built'
      })
    }
  }, overrides);
}

const phaseProvider = () => ({ baseUrl: 'https://api.test', key: 'k' });

test('preparePhaseAsync removes dotted drop paths and reports what it removed', async () => {
  const built = await preparePhaseAsync(
    phaseAdapter(), phaseProvider(),
    { model: 'm', prompt: 'hi', width: 1024, height: 768 }, undefined,
    ['input.width', 'steps']
  );

  const body = JSON.parse(built.body);
  assert.equal(body.input.width, undefined, 'a nested optional field is gone');
  assert.equal(body.steps, undefined, 'a top-level optional field is gone');
  assert.equal(body.input.height, 768, 'sibling fields stay');
  assert.equal(body.prompt, 'hi');
  assert.deepEqual(built.dropped, ['input.width', 'steps']);
  assert.deepEqual(built.blockedDrops, []);
  // 原有字段一个不少：调用方还在用 path/headers/body/note。
  assert.equal(built.path, '/jobs');
  assert.equal(built.note, 'built');
  assert.equal(built.headers['x-app'], 'dsh');
  assert.equal(built.headers.Authorization, 'Bearer k');
});

test('preparePhaseAsync never drops prompt, model or reference images', async () => {
  const protectedDrops = [
    'prompt', 'model', 'images', 'input.prompt', 'input.model', 'input.image', 'input', 'input_image_2'
  ];
  const built = await preparePhaseAsync(
    phaseAdapter(), phaseProvider(),
    { model: 'm', prompt: 'hi', width: 1024, images: [] }, undefined,
    protectedDrops
  );

  assert.deepEqual(built.blockedDrops, protectedDrops, 'every protected path is reported back');
  assert.deepEqual(built.dropped, [], 'nothing protected was actually removed');
  const body = JSON.parse(built.body);
  assert.equal(body.prompt, 'hi');
  assert.equal(body.model, 'm');
  assert.equal(body.input.prompt, 'hi');
  assert.equal(body.input.model, 'm');
  assert.equal(body.input.image, 'data:image/png;base64,AAAA');
  assert.ok(body.input, 'dropping the whole input object would take necessary fields with it');
});

test('preparePhaseAsync only reports paths it really deleted', async () => {
  const built = await preparePhaseAsync(
    phaseAdapter(), phaseProvider(),
    { model: 'm', prompt: 'hi', width: 1024 }, undefined,
    new Set(['input.missing', 'width', 'guidance'])
  );

  assert.deepEqual(built.dropped, ['width', 'guidance'], 'a Set is accepted and unknown paths are not claimed');
  assert.equal(JSON.parse(built.body).width, undefined);
});

test('preparePhaseAsync refuses prototype-chain paths from upstream errors', async () => {
  const before = Object.prototype.toString;
  const built = await preparePhaseAsync(
    phaseAdapter(), phaseProvider(),
    { model: 'm', prompt: 'hi', width: 1024 }, undefined,
    ['__proto__.toString', 'constructor.prototype.polluted', 'input.__proto__']
  );

  assert.deepEqual(built.dropped, [], 'prototype paths are never claimed as dropped');
  assert.equal(Object.prototype.toString, before, 'Object.prototype.toString must survive');
  assert.equal({}.polluted, undefined);
  assert.equal(JSON.parse(built.body).prompt, 'hi');
});

test('preparePhaseAsync keeps the original build error as the cause', async () => {
  const original = new Error('build exploded');
  original.code = 'E_BUILD';
  const adapter = phaseAdapter();
  adapter.async.build = async () => { throw original; };

  await assert.rejects(
    () => preparePhaseAsync(adapter, phaseProvider(), { model: 'm', prompt: 'x' }),
    (error) => {
      // 文案不变，但调用方还会按分类字段和 cause 决策，不能被吞掉。
      assert.equal(error.message, 'build exploded');
      assert.equal(error.cause, original);
      assert.equal(error.code, 'E_BUILD');
      return true;
    }
  );
});

/* ------------------------------------------------- ComfyUI 节点签名缓存 */

const fluxWorkflow = () => readFileSync('test/fixtures/flux-t2i.api.json', 'utf8');
const objectInfoSample = () => JSON.parse(readFileSync('test/fixtures/object-info.sample.json', 'utf8'));

test('analyzeComfyWorkflow shares one object_info request between concurrent callers', async (t) => {
  resetComfyObjectInfoCache();
  const base = 'http://127.0.0.1:8222';
  let calls = 0;
  stubFetch(t, async (url) => {
    const target = String(url);
    assert.equal(target, base + '/object_info');
    calls += 1;
    // 故意晚一点返回：两个调用必须真的在时间上重叠，才谈得上合并。
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(objectInfoSample());
  });

  const request = () => analyzeComfyWorkflow({ base, provider: { baseUrl: base }, workflow: fluxWorkflow() });
  const [first, second] = await Promise.all([request(), request()]);
  // 缓存命中之后（TTL 内）也不该再打一次 20MB 的接口。
  const third = await request();

  assert.equal(calls, 1, 'two in-flight reads plus a cached read still fetch once');
  assert.equal(first.format, 'api');
  assert.deepEqual(second.mapping.prompt, first.mapping.prompt);
  assert.ok(third.mapping.prompt, 'the cached signature still drives the mapping');
});

test('a failed object_info read is not cached', async (t) => {
  resetComfyObjectInfoCache();
  const base = 'http://127.0.0.1:8223';
  let calls = 0;
  stubFetch(t, async () => { calls += 1; return jsonResponse({}, 503); });

  await assert.rejects(
    () => analyzeComfyWorkflow({ base, provider: {}, workflow: fluxWorkflow() }),
    /节点签名/
  );
  await assert.rejects(
    () => analyzeComfyWorkflow({ base, provider: {}, workflow: fluxWorkflow() }),
    /节点签名/
  );
  assert.equal(calls, 2, 'a transient failure must be retried instead of remembered');
});

test('the object_info cache keeps at most its entry limit and evicts the oldest', async (t) => {
  resetComfyObjectInfoCache();
  const sample = objectInfoSample();
  let calls = 0;
  stubFetch(t, async () => { calls += 1; return jsonResponse(sample); });

  // 容量上限是 50 条：每个 base 都是不同的缓存键。
  const request = (index) => analyzeComfyWorkflow({
    base: 'http://127.0.0.1:' + (8300 + index), provider: {}, workflow: fluxWorkflow()
  });
  for (let index = 0; index < 51; index++) await request(index);
  assert.equal(calls, 51);

  await request(50);
  assert.equal(calls, 51, 'the newest entry is still cached');
  await request(0);
  assert.equal(calls, 52, 'the oldest entry was evicted when the 51st was inserted');
});

test('the object_info cache also honours a total byte budget', async (t) => {
  resetComfyObjectInfoCache();
  // 造一份约 2MB 的签名：三条就超过 4MB 预算，必须开始淘汰旧条目。
  const sample = objectInfoSample();
  sample.PAD = { input: { required: {} }, padding: 'x'.repeat(2 * 1024 * 1024) };
  let calls = 0;
  stubFetch(t, async () => { calls += 1; return jsonResponse(sample); });

  const request = (index) => analyzeComfyWorkflow({
    base: 'http://127.0.0.1:' + (8400 + index), provider: {}, workflow: fluxWorkflow()
  });
  await request(0);
  await request(1);
  await request(2);
  assert.equal(calls, 3);

  await request(2);
  assert.equal(calls, 3, 'the newest big entry survives the budget trim');
  await request(0);
  assert.equal(calls, 4, 'big signatures cannot pile up without a byte budget');
});

/* ------------------------------------------------- Replicate 模型 schema */

const replicateSchema = () => ({
  latest_version: {
    openapi_schema: {
      components: {
        schemas: {
          Input: { properties: { prompt: { type: 'string' }, image: { type: 'string', format: 'uri' } } }
        }
      }
    }
  }
});

function replicateAdapter(providerDef) {
  return resolveAdapter(providerDef, 'acme/merged-model');
}

function replicateInput() {
  return {
    model: 'acme/merged-model', prompt: 'x', fitted, images: [referenceImage()]
  };
}

test('two concurrent replicate builds share one schema request', async (t) => {
  resetAsyncSchemaCache();
  const providerDef = { baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8-test' };
  let schemaCalls = 0;
  stubFetch(t, async (url) => {
    assert.equal(String(url), 'https://api.replicate.com/v1/models/acme/merged-model');
    schemaCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(replicateSchema());
  });

  const adapter = replicateAdapter(providerDef);
  const signal = () => new AbortController().signal;
  const [first, second] = await Promise.all([
    adapter.async.build(replicateInput(), providerDef, signal()),
    adapter.async.build(replicateInput(), providerDef, signal())
  ]);

  assert.equal(schemaCalls, 1, 'the second build waits for the in-flight schema read');
  assert.ok(String(first.body.input.image).startsWith('data:image/png;base64,'));
  assert.ok(String(second.body.input.image).startsWith('data:image/png;base64,'));

  // TTL 内命中缓存，不再请求。
  await adapter.async.build(replicateInput(), providerDef, signal());
  assert.equal(schemaCalls, 1);

  // 凭据版本参与缓存键：换 Key 视为不同权限，必须重新取 schema。
  const otherProvider = Object.assign({}, providerDef, { key: 'r8-other' });
  await adapter.async.build(replicateInput(), otherProvider, signal());
  assert.equal(schemaCalls, 2);
});

test('a failed schema read is retried by the next build', async (t) => {
  resetAsyncSchemaCache();
  const providerDef = { baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8-retry' };
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: 'busy' }, 503);
    return jsonResponse(replicateSchema());
  });

  const adapter = replicateAdapter(providerDef);
  const input = replicateInput();
  const first = await adapter.async.build(input, providerDef, new AbortController().signal);
  const second = await adapter.async.build(input, providerDef, new AbortController().signal);

  assert.equal(first.body.input.image, undefined, 'no schema means no guessed image field');
  assert.ok(String(second.body.input.image).startsWith('data:image/png;base64,'));
  assert.equal(calls, 2);
});

/* --------------------------------------------------- fal 结果地址的凭据范围 */

/**
 * fal 的结果不在轮询载荷里：执行器要按 response_url 再 GET 一次 JSON。
 * 那一跳的请求头按**下载凭据**判定（同源带、跨源不带）——这是 url 泄漏风险最高的一跳。
 * 迁移前这条断言直接调 adapter.async.resolve()；迁移后走真实执行器，判定入口不变。
 */
async function falViaHeaders(responseUrl) {
  const calls = [];
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      calls.push({ url: target, headers: (init && init.headers) || {} });
      if (target === 'https://queue.fal.run/fal-ai/flux-2-pro') {
        return jsonResponse({
          status_url: 'https://queue.fal.run/fal-ai/flux-2-pro/requests/req-1/status',
          response_url: responseUrl
        });
      }
      if (target.endsWith('/status')) return jsonResponse({ status: 'COMPLETED' });
      if (target === responseUrl) return jsonResponse({ images: [{ url: 'https://cdn.test/out.png' }] });
      if (target === 'https://cdn.test/out.png') {
        return new Response(Buffer.from(PNG_1PX, 'base64'), {
          status: 200, headers: { 'content-type': 'image/png' }
        });
      }
      throw new Error('unexpected url ' + target);
    };
    const provider = { baseUrl: 'https://queue.fal.run', adapter: 'fal', key: 'fal-key' };
    await callImageApi('generate', resolveAdapter(provider, 'fal-ai/flux-2-pro'), provider, {
      model: 'fal-ai/flux-2-pro', prompt: 'x', fitted
    }, new AbortController().signal);
  } finally {
    globalThis.fetch = original;
  }
  const via = calls.find((call) => call.url === responseUrl);
  assert.ok(via, 'response_url 必须真的被 GET 一次');
  return via.headers;
}

test('fal never sends the key to a cross-origin response_url', async () => {
  const crossOrigin = await falViaHeaders('https://cdn.example/result.json');
  assert.equal(crossOrigin.Authorization, undefined, 'a third-party CDN must not receive the key');

  const own = await falViaHeaders('https://queue.fal.run/fal-ai/flux-2-pro/requests/req-1');
  assert.equal(own.Authorization, 'Key fal-key', 'fal own origin still gets authenticated');
});

/* ------------------------------------------------------- ComfyUI 轮询退避 */

test('comfyui polls start at 1s, grow and stop at the 5s cap', async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const waits = [];
  // 只截获退避等待：记下请求的毫秒数，然后立刻放行，测试不会真的等十几秒。
  globalThis.setTimeout = (fn, ms, ...args) => {
    waits.push(Number(ms) || 0);
    return originalSetTimeout(fn, 0, ...args);
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const base = 'http://127.0.0.1:8224';
  let historyCalls = 0;
  stubFetch(t, async (url) => {
    const target = String(url);
    if (target.endsWith('/prompt')) return jsonResponse({ prompt_id: 'p-backoff' });
    if (target.includes('/history/')) {
      historyCalls += 1;
      // 15 次「还在跑」足够让最短的抖动路径也升到 5s 封顶。
      if (historyCalls < 15) return jsonResponse({});
      return jsonResponse({
        'p-backoff': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } }
      });
    }
    if (target.includes('/view?')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'unexpected ' + target }, 404);
  });

  const provider = { baseUrl: base, adapter: 'comfyui', optionalKey: true };
  await resolveAdapter(provider, '').execute('generate', provider, {
    model: 'sdxl.safetensors', prompt: 'a cat', fitted: { width: 512, height: 512, size: '512x512' }
  }, new AbortController().signal);

  const polls = waits.filter((ms) => ms >= 500);
  assert.ok(polls.length >= 15, 'every history query waits');
  assert.equal(polls[0], 1000, 'the first wait is 1s instead of the old 700ms');
  assert.ok(polls[1] >= 1150 && polls[1] <= 1300, 'the second wait grows by 1.15-1.3: ' + polls[1]);
  for (let index = 1; index < polls.length; index++) {
    assert.ok(polls[index] >= polls[index - 1], 'waits never shrink');
  }
  assert.ok(polls.every((ms) => ms <= 5000), 'never above the 5s cap');
  assert.equal(polls[polls.length - 1], 5000, 'a long queue settles at the 5s cap');
});

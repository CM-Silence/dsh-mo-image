/**
 * 「识别协议」的探测表：本地部署（ComfyUI / A1111 / SwarmUI）与 OpenAI 兼容网关。
 *
 * 老实现只探一次 `GET /models`，于是本地地址（`http://127.0.0.1:8188`）永远掉进「自定义」——
 * ComfyUI 根本没有 `/models`。这里钉住新的判定：
 *
 *   1. 静态判定优先，一次请求都不发（主机表 / 本地匹配）；
 *   2. 探测表**由协议清单的 `routes.models` 驱动**，一条协议一行，命中即停；
 *   3. 内网地址先问本地那三条，公网地址只问 `/models`（同一地址只探一次）；
 *   4. 每个探针 3 秒、只发 GET、绝不触发生成；认证失败 / 超时 / 非 JSON 都不抛异常；
 *   5. 手选了协议时只校验不改写（`expected`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocolOf, isLocalBaseUrl, PROTOCOL_PROBES, adapterManifest } from '../lib/adapters.js';

/** 把 globalThis.fetch 换成记录桩：handler 决定回什么。 */
function stubFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: String((init && init.method) || 'GET'),
      headers: (init && init.headers) || {},
      signal: init && init.signal
    });
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status: status,
  headers: { 'content-type': 'application/json' }
});
const miss = () => new Response('not found', { status: 404 });
const urls = (calls) => calls.map((call) => call.url);

/** 一个什么都认的桩：只回指定的那条路径，其它 404。 */
const routeOf = (exactPath, respond) => (url) => (url.endsWith(exactPath) ? respond() : miss());

test('探测表由协议清单的 routes.models 驱动，不在这里另抄一份路径', () => {
  const manifest = new Map(adapterManifest().map((adapter) => [adapter.id, adapter]));
  for (const row of PROTOCOL_PROBES) {
    const adapter = manifest.get(row.protocol);
    assert.ok(adapter, '探测表里的 ' + row.protocol + ' 在协议清单里不存在');
    assert.equal(row.path, adapter.routes.models, row.protocol + ' 的探针路径必须等于 routes.models');
    assert.equal(row.local, adapter.local === true, row.protocol + ' 的 local 标记必须和清单一致');
    assert.ok(row.accepts.length > 0, row.protocol + ' 没说清模型端点返回什么形状');
  }
  // 反过来：清单里有模型端点的协议都得进探测表，否则它永远只能靠手选。
  for (const adapter of manifest.values()) {
    if (!adapter.routes.models) continue;
    assert.ok(
      PROTOCOL_PROBES.some((row) => row.protocol === adapter.id),
      adapter.id + ' 有 models 端点却没进探测表'
    );
  }
  // 本地三条排在 /models 之前：内网地址先问本地服务。
  assert.deepEqual(PROTOCOL_PROBES.filter((row) => row.local).map((row) => row.protocol), ['comfyui', 'a1111', 'swarmui']);
  assert.equal(PROTOCOL_PROBES.find((row) => row.protocol === 'openai-images').path, '/models');
});

test('本机 / 内网地址识别（决定探测顺序的那一层）', () => {
  const local = [
    'http://127.0.0.1:8188', 'http://127.1.2.3', 'http://localhost:7860', 'http://[::1]:8188',
    'http://::1', 'http://192.168.1.5:8188', 'http://10.0.0.8', 'http://172.16.0.9',
    'http://172.31.255.254', 'http://169.254.1.1', 'http://comfy.local:8188', 'http://mybox:8188'
  ];
  const remote = [
    'https://api.openai.com/v1', 'https://relay.example/v1', 'http://8.8.8.8',
    'http://172.15.0.1', 'http://172.32.0.1', 'http://192.169.0.1', 'http://11.0.0.1'
  ];
  for (const baseUrl of local) assert.equal(isLocalBaseUrl(baseUrl), true, baseUrl);
  for (const baseUrl of remote) assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
});

test('ComfyUI：/object_info 200 + JSON 对象 → comfyui，只发一次 GET', async (t) => {
  const calls = stubFetch(t, routeOf('/object_info', () => json({ CheckpointLoaderSimple: {}, UNETLoader: {} })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188', key: 'k' }, '');
  assert.deepEqual(result, {
    protocol: 'comfyui', matched: false, probed: true, probe: '/object_info', shape: 'object'
  });
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info'], '命中就停，不该再问别的端点');
  assert.equal(calls[0].method, 'GET');
});

test('装了很多节点的 ComfyUI：超大 /object_info（超过 1MB 上限）照样认得出', async (t) => {
  // 装了几百个自定义节点的 ComfyUI，/object_info 能到 20MB+；探针只读前缀，不整份解析。
  const huge = '{"CheckpointLoaderSimple":{"input":{}},"Pad":"' + 'x'.repeat(1200 * 1024) + '"}';
  const calls = stubFetch(t, routeOf('/object_info', () => new Response(huge, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188' }, '');
  assert.equal(result.protocol, 'comfyui');
  assert.equal(result.probe, '/object_info');
  assert.equal(result.shape, 'object');
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info']);
});

test('A1111：/sdapi/v1/sd-models 200 + 数组 → a1111，先问 ComfyUI 的端点', async (t) => {
  const calls = stubFetch(t, routeOf('/sdapi/v1/sd-models', () => json([{ title: 'sd_xl_base_1.0' }])));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:7860' }, '');
  assert.deepEqual(result, {
    protocol: 'a1111', matched: false, probed: true, probe: '/sdapi/v1/sd-models', shape: 'array'
  });
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:7860/object_info',
    'http://127.0.0.1:7860/sdapi/v1/sd-models'
  ], '内网地址按「本地优先」的顺序探');
});

test('SwarmUI：/API/ListModels 200 + JSON → swarmui', async (t) => {
  const calls = stubFetch(t, routeOf('/API/ListModels', () => json({ files: [{ name: 'sdxl' }] })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:7801' }, '');
  assert.deepEqual(result, {
    protocol: 'swarmui', matched: false, probed: true, probe: '/API/ListModels', shape: 'object'
  });
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:7801/object_info',
    'http://127.0.0.1:7801/sdapi/v1/sd-models',
    'http://127.0.0.1:7801/API/ListModels'
  ]);
});

test('本地 OpenAI 兼容（sd-server / LocalAI）：本地三条都不中，最后认 /models', async (t) => {
  const calls = stubFetch(t, routeOf('/models', () => json({ data: [{ id: 'sd-cpp-local' }] })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8080/v1', key: 'k' }, '');
  // openai-images 是通用兜底：只证明「兼容」，说不出具体是谁，所以不带 probe（既有形状）。
  assert.deepEqual(result, { protocol: 'openai-images', matched: false, probed: true });
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:8080/v1/object_info',
    'http://127.0.0.1:8080/v1/sdapi/v1/sd-models',
    'http://127.0.0.1:8080/v1/API/ListModels',
    'http://127.0.0.1:8080/v1/models'
  ]);
});

test('Gemini 的 {models:[…]} 与 OpenAI 的 {data:[…]} 靠形状区分（同一个 /models）', async (t) => {
  const gemini = stubFetch(t, routeOf('/models', () => json({ models: [{ name: 'models/gemini-3-pro-image' }] })));
  const first = await detectProtocolOf({ baseUrl: 'https://relay.example/v1' }, '');
  assert.deepEqual(first, {
    protocol: 'google-gemini', matched: false, probed: true, probe: '/models', shape: 'gemini-models'
  });
  assert.equal(gemini.length, 1, '同一个地址只探一次');

  const openai = stubFetch(t, routeOf('/models', () => json({ data: [{ id: 'flux' }] })));
  const second = await detectProtocolOf({ baseUrl: 'https://relay2.example/v1' }, '');
  assert.deepEqual(second, { protocol: 'openai-images', matched: false, probed: true });
  assert.equal(openai.length, 1);
});

test('公网地址只探 /models：不发多余请求（本地那三条是内网才问）', async (t) => {
  const calls = stubFetch(t, () => miss());
  const result = await detectProtocolOf({ baseUrl: 'https://relay.example/v1', key: 'k' }, '');
  assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  assert.deepEqual(urls(calls), ['https://relay.example/v1/models']);
});

test('全都 404 → 自定义（客户端据此预填三条相对地址）；全部只发 GET，绝不触发生成', async (t) => {
  const calls = stubFetch(t, () => miss());
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188' }, '');
  assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  assert.equal(calls.length, 4, '四条候选各问一次，问完就退');
  for (const call of calls) {
    assert.equal(call.method, 'GET', '探针只能发 GET：' + call.url);
    assert.doesNotMatch(call.url, /images\/(generations|edits)/, '绝不能发会生成图片的请求：' + call.url);
    assert.doesNotMatch(call.url, /\/prompt$/, '绝不能提交工作流：' + call.url);
  }
  assert.ok(calls.every((call) => call.signal), '每个探针都要带自己的超时 signal');
});

test('认证失败 / 500 / 非 JSON / 网络错误都不抛异常，继续问下一个', async (t) => {
  const failures = [
    () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    () => new Response('forbidden', { status: 403 }),
    () => new Response('boom', { status: 500 }),
    () => new Response('<html>not json</html>', { status: 200 }),
    () => { throw new Error('ECONNREFUSED'); }
  ];
  let respond = failures[0];
  const calls = stubFetch(t, (url, init) => respond(url, init));
  for (const failure of failures) {
    respond = failure;
    const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188', key: 'k' }, '');
    assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  }
  // 每个探针失败后都继续，四条候选 × 5 种失败。
  assert.equal(calls.length, failures.length * 4);
});

/**
 * 一个「挂住直到自己的 signal 被 abort」的 fetch 桩。
 *
 * `AbortSignal.timeout()` 的定时器是 unref 的（Node 不拿它撑事件循环），所以桩里要自己
 * 挂一个真定时器：否则进程会在超时触发之前就把「promise 还挂着」当成测试失败。
 */
function hangUntilAborted(t, _url, init) {
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  return new Promise((_resolve, reject) => {
    const signal = init && init.signal;
    if (!signal) return;
    const abort = () => {
      clearTimeout(keepAlive);
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort);
  });
}

test('超时（默认 3 秒）也不抛：挂住的地址退回自定义', async (t) => {
  const calls = stubFetch(t, (url, init) => hangUntilAborted(t, url, init));
  const startedAt = Date.now();
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188' }, '', { probeTimeoutMs: 25 });
  assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  assert.equal(calls.length, 4, '每个候选都等到自己的超时');
  assert.ok(Date.now() - startedAt < 2000, '用的是 25ms 的测试超时，不是默认 3 秒');
});

test('总预算封顶：一个地址挂住时不会把设置页卡在那里', async (t) => {
  const calls = stubFetch(t, (url, init) => hangUntilAborted(t, url, init));
  // 预算 30ms、单探针 5000ms：第一个探针按预算掐掉之后就不该再发第二个。
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188' }, '', { budgetMs: 30, probeTimeoutMs: 5000 });
  assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  assert.equal(calls.length, 1, '预算用尽就停，不再问后面的候选');
});

test('尾斜杠不会拼出 //object_info', async (t) => {
  const calls = stubFetch(t, routeOf('/object_info', () => json({ X: {} })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188/' }, '');
  assert.equal(result.protocol, 'comfyui');
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info']);
});

/* ------------------------------------------------------- 手选协议：只校验 */

test('手选了 ComfyUI：只校验，不换协议、不改选项（探针命中）', async (t) => {
  const calls = stubFetch(t, routeOf('/object_info', () => json({ CheckpointLoaderSimple: {} })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188' }, '', { expected: 'comfyui' });
  assert.deepEqual(result, {
    protocol: 'comfyui', matched: true, probed: true, verified: true, probe: '/object_info', shape: 'object'
  });
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info'], '验过就停，不去问 /models');
});

test('手选了协议而地址静态就能证明：零请求', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('静态能证明就不该发请求'); });
  const gemini = await detectProtocolOf(
    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    'gemini-2.5-flash-image',
    { expected: 'google-gemini' }
  );
  assert.deepEqual(gemini, { protocol: 'google-gemini', matched: true, probed: false, verified: true });

  const azure = await detectProtocolOf(
    { baseUrl: 'https://res.openai.azure.com/openai/v1' },
    'gpt-image-2.5-flare',
    { expected: 'openai-images' }
  );
  // 校验模式不写协议选项：用户选的就是这条协议，别顺手改它的选项。
  assert.deepEqual(azure, { protocol: 'openai-images', matched: true, probed: false, verified: true });
  assert.deepEqual(urls(calls), []);
});

test('手选的协议没通过：协议保留，只报告「不像」，并给出看起来像谁', async (t) => {
  // 用户选了 A1111，地址其实是 ComfyUI。
  const calls = stubFetch(t, routeOf('/object_info', () => json({ X: {} })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:7860' }, '', { expected: 'a1111' });
  assert.equal(result.protocol, 'a1111', '不许把用户选的协议改掉');
  assert.equal(result.verified, false);
  assert.equal(result.matched, false);
  assert.equal(result.probe, '/sdapi/v1/sd-models', '说清校验的是哪个探针');
  assert.equal(result.suggested, 'comfyui', '顺手告诉用户看起来像谁');
  assert.equal(result.suggestedProbe, '/object_info');
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:7860/sdapi/v1/sd-models',
    'http://127.0.0.1:7860/object_info'
  ], '刚校验过的那条不再重问');
});

test('手选的协议没通过、也没有更像的：不给 suggested', async (t) => {
  stubFetch(t, () => miss());
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:7860' }, '', { expected: 'a1111' });
  assert.deepEqual(result, {
    protocol: 'a1111', matched: false, probed: true, verified: false, probe: '/sdapi/v1/sd-models'
  });
});

test('手选的是没有模型端点的协议（BFL 一类）：只靠静态判定，不发请求', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('不该发请求'); });
  const result = await detectProtocolOf({ baseUrl: 'https://api.bfl.ai/v1' }, 'flux-pro-1.1', { expected: 'bfl' });
  assert.deepEqual(result, { protocol: 'bfl', matched: true, probed: false, verified: true });
  const wrong = await detectProtocolOf({ baseUrl: 'https://relay.example/v1' }, 'some-model', { expected: 'bfl' });
  assert.deepEqual(wrong, { protocol: 'bfl', matched: false, probed: false, verified: false });
  assert.deepEqual(urls(calls), []);
});

test('「自定义」不算手选了协议：仍然做完整识别', async (t) => {
  stubFetch(t, routeOf('/object_info', () => json({ X: {} })));
  const result = await detectProtocolOf({ baseUrl: 'http://127.0.0.1:8188' }, '', { expected: 'custom' });
  assert.equal(result.protocol, 'comfyui');
  assert.equal(result.verified, undefined, '自定义没有可校验的协议');
});

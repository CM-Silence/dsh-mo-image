/**
 * 「识别协议」的探测表：本地部署（ComfyUI / A1111 / SwarmUI）与 OpenAI 兼容网关。
 *
 * 判定拆成两步（宿主管顺序与形状，客户端管循环）：
 *   1. `detectProtocolStart()`：**零上游请求**——静态能认就给答案，否则只给探测顺序；
 *   2. `probeProtocolPath()`：只探一条路径，返回这条形状能证明的协议，绝不抛异常。
 *
 * 这里钉住：
 *   - 探测顺序：内网本地三条优先、`/models` 收尾；公网 `/models` 优先，不中再试那三条
 *     （公网最坏 4 个请求），命中即停；
 *   - 单探针 15 秒、只发 GET、认证失败 / 超时 / 非 JSON / 连不上都当「不是它」；
 *   - 校验模式以手选协议的路径打头。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProtocolStart, probeProtocolPath, isLocalBaseUrl, PROTOCOL_PROBES, adapterManifest
} from '../lib/adapters.js';

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

/**
 * 按宿主给的顺序逐条探、命中即停——客户端那半边在 lib/client.js，这里只为把顺序、
 * 「命中即停」和「一条一个请求」钉死。返回最后命中的那条（全都不中时 `hit` 为 null）。
 */
async function runPlan(provider, model, options = {}) {
  const start = detectProtocolStart(provider, model, options);
  if (start.done) return { start: start, hit: null, steps: [] };
  const steps = [];
  for (const probe of start.probes) {
    const step = await probeProtocolPath(provider, probe, options);
    assert.ok(step, '宿主给出的路径必须能探：' + probe);
    steps.push(step);
    if (step.protocols.length) break;
  }
  const last = steps[steps.length - 1] || null;
  return { start: start, hit: last && last.protocols.length ? last : null, steps: steps };
}

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
  // 本地三条排在 /models 之前（表自己的顺序）；探测时的先后由 probeOrderOf 按地址决定。
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
    'http://172.15.0.1', 'http://172.32.0.1', 'http://192.169.0.1', 'http://11.0.0.1',
    'https://comfy.example.com'
  ];
  for (const baseUrl of local) assert.equal(isLocalBaseUrl(baseUrl), true, baseUrl);
  for (const baseUrl of remote) assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
});

test('探测顺序：内网本地三条优先，公网 /models 优先；只给顺序，不发请求', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('给顺序这一步不该发请求'); });

  const inside = detectProtocolStart({ baseUrl: 'http://127.0.0.1:8188' }, '');
  assert.deepEqual(inside, {
    done: false,
    probes: ['/object_info', '/sdapi/v1/sd-models', '/API/ListModels', '/models']
  });

  const outside = detectProtocolStart({ baseUrl: 'https://comfy.example.com' }, '');
  assert.deepEqual(outside, {
    done: false,
    probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']
  }, '公网：一个 /models 先试 5 种形状，不中再试本地那三条（最坏 4 个请求）');

  assert.deepEqual(calls, [], '排顺序是纯静态判断');
});

test('内网 ComfyUI：/object_info 200 + JSON 对象 → comfyui，只发一次 GET', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/object_info') ? json({ CheckpointLoaderSimple: {}, UNETLoader: {} }) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:8188', key: 'k' }, '');
  assert.deepEqual(run.hit, { probe: '/object_info', shape: 'object', protocols: ['comfyui'], status: 200, reason: '' });
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info'], '命中就停，不该再问别的端点');
  assert.equal(calls[0].method, 'GET');
});

test('装了很多节点的 ComfyUI：超大 /object_info（超过 1MB 上限）照样认得出', async (t) => {
  // 装了几百个自定义节点的 ComfyUI，/object_info 能到 20MB+；探针只读前缀，不整份解析。
  const huge = '{"CheckpointLoaderSimple":{"input":{}},"Pad":"' + 'x'.repeat(1200 * 1024) + '"}';
  const calls = stubFetch(t, (url) => (url.endsWith('/object_info') ? new Response(huge, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:8188' }, '');
  assert.equal(run.hit.probe, '/object_info');
  assert.equal(run.hit.shape, 'object');
  assert.deepEqual(run.hit.protocols, ['comfyui']);
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info']);
});

test('内网 A1111：/sdapi/v1/sd-models 200 + 数组 → a1111，先问 ComfyUI 的端点', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/sdapi/v1/sd-models') ? json([{ title: 'sd_xl_base_1.0' }]) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:7860' }, '');
  assert.deepEqual(run.hit, { probe: '/sdapi/v1/sd-models', shape: 'array', protocols: ['a1111'], status: 200, reason: '' });
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:7860/object_info',
    'http://127.0.0.1:7860/sdapi/v1/sd-models'
  ], '内网地址按「本地优先」的顺序探');
});

test('内网 SwarmUI：/API/ListModels 200 + JSON → swarmui', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/API/ListModels') ? json({ files: [{ name: 'sdxl' }] }) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:7801' }, '');
  assert.deepEqual(run.hit, { probe: '/API/ListModels', shape: 'object', protocols: ['swarmui'], status: 200, reason: '' });
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:7801/object_info',
    'http://127.0.0.1:7801/sdapi/v1/sd-models',
    'http://127.0.0.1:7801/API/ListModels'
  ]);
});

test('本地 OpenAI 兼容（sd-server / LocalAI）：本地三条都不中，最后认 /models', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/models') ? json({ data: [{ id: 'sd-cpp-local' }] }) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:8080/v1', key: 'k' }, '');
  assert.deepEqual(run.hit.protocols, ['openai-images', 'openai-chat', 'openai-responses', 'openrouter-images', 'tokenhub-hy-image']);
  assert.equal(run.hit.shape, 'openai-data');
  assert.deepEqual(urls(calls), [
    'http://127.0.0.1:8080/v1/object_info',
    'http://127.0.0.1:8080/v1/sdapi/v1/sd-models',
    'http://127.0.0.1:8080/v1/API/ListModels',
    'http://127.0.0.1:8080/v1/models'
  ]);
});

test('公网自托管 ComfyUI：/models 404 之后照样认得出（本次放宽的正是这条）', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/object_info') ? json({ CheckpointLoaderSimple: {} }) : miss()));
  const run = await runPlan({ baseUrl: 'https://comfy.example.com', key: 'k' }, '');
  assert.deepEqual(run.hit, { probe: '/object_info', shape: 'object', protocols: ['comfyui'], status: 200, reason: '' });
  assert.deepEqual(urls(calls), [
    'https://comfy.example.com/models',
    'https://comfy.example.com/object_info'
  ], '公网先 /models，命中即停：不再问 A1111 / SwarmUI');
});

test('公网自托管 A1111：/models 与 /object_info 都不中，看 /sdapi/v1/sd-models', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/sdapi/v1/sd-models') ? json([{ title: 'sdxl' }]) : miss()));
  const run = await runPlan({ baseUrl: 'https://a1111.example.com' }, '');
  assert.deepEqual(run.hit, { probe: '/sdapi/v1/sd-models', shape: 'array', protocols: ['a1111'], status: 200, reason: '' });
  assert.deepEqual(urls(calls), [
    'https://a1111.example.com/models',
    'https://a1111.example.com/object_info',
    'https://a1111.example.com/sdapi/v1/sd-models'
  ]);
});

test('公网全都不中：最坏就是 4 个请求（/models + 本地三条），客户端据此落自定义', async (t) => {
  const calls = stubFetch(t, () => miss());
  const run = await runPlan({ baseUrl: 'https://relay.example.com/v1', key: 'k' }, '');
  assert.equal(run.hit, null);
  assert.deepEqual(urls(calls), [
    'https://relay.example.com/v1/models',
    'https://relay.example.com/v1/object_info',
    'https://relay.example.com/v1/sdapi/v1/sd-models',
    'https://relay.example.com/v1/API/ListModels'
  ]);
  for (const call of calls) {
    assert.equal(call.method, 'GET', '探针只能发 GET：' + call.url);
    assert.doesNotMatch(call.url, /images\/(generations|edits)/, '绝不能发会生成图片的请求：' + call.url);
    assert.doesNotMatch(call.url, /\/prompt$/, '绝不能提交工作流：' + call.url);
    assert.ok(call.signal, '每个探针都要带自己的超时 signal');
  }
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
    const run = await runPlan({ baseUrl: 'http://127.0.0.1:8188', key: 'k' }, '');
    assert.equal(run.hit, null, '失败就是「不是它」，不许命中也不许抛');
  }
  // 每轮 4 条候选 × 5 种失败。
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

test('单探针超时也不抛：挂住的地址照样把四条都问完（每条各自 25ms）', async (t) => {
  const calls = stubFetch(t, (url, init) => hangUntilAborted(t, url, init));
  const startedAt = Date.now();
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:8188' }, '', { probeTimeoutMs: 25 });
  assert.equal(run.hit, null);
  assert.equal(calls.length, 4, '每个候选都等到自己的超时');
  assert.ok(Date.now() - startedAt < 2000, '用的是 25ms 的测试超时，不是默认 15 秒');
});

/**
 * 失败也要分得清：401/403 是「Key 的事」，404 是「这个地址没有该接口」，
 * 超时 / 连不上是另一类。以前它们都是 `shape: ''`，界面上只能合成一句「没认出协议」。
 */
test('探针带回 HTTP 状态：401 / 404 各是各的，且 401 绝不算命中', async (t) => {
  let status = 401;
  stubFetch(t, () => new Response('{"error":{"message":"bad key"}}', { status: status }));
  const unauthorized = await probeProtocolPath({ baseUrl: 'https://relay.example/v1', key: 'k' }, '/models');
  assert.deepEqual(unauthorized, { probe: '/models', shape: '', protocols: [], status: 401, reason: '' });
  assert.deepEqual(unauthorized.protocols, [], '401 不能被当成命中');

  status = 404;
  const notFound = await probeProtocolPath({ baseUrl: 'https://relay.example/v1', key: 'k' }, '/models');
  assert.deepEqual(notFound, { probe: '/models', shape: '', protocols: [], status: 404, reason: '' });
});

test('探针超时：status 0 + reason timeout（客户端据此说「超时」）', async (t) => {
  stubFetch(t, (url, init) => hangUntilAborted(t, url, init));
  const step = await probeProtocolPath({ baseUrl: 'https://relay.example.com/v1' }, '/models', { probeTimeoutMs: 25 });
  assert.deepEqual(step, { probe: '/models', shape: '', protocols: [], status: 0, reason: 'timeout' });
});

test('连不上：status 0 + reason network（和 404 的「没有该接口」分开）', async (t) => {
  stubFetch(t, () => { throw new Error('ECONNREFUSED'); });
  const step = await probeProtocolPath({ baseUrl: 'https://relay.example.com/v1' }, '/models');
  assert.deepEqual(step, { probe: '/models', shape: '', protocols: [], status: 0, reason: 'network' });
});

test('200 但不像模型列表：status 200 + reason invalid，仍然不命中', async (t) => {
  stubFetch(t, () => new Response('<html>not json</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' }
  }));
  const step = await probeProtocolPath({ baseUrl: 'https://relay.example.com/v1' }, '/models');
  assert.deepEqual(step, { probe: '/models', shape: '', protocols: [], status: 200, reason: 'invalid' });
});

test('探针不带响应体摘要：上游把 Key 回显在错误里也不会进返回值', async (t) => {
  const key = 'sk-live-do-not-leak';
  stubFetch(t, () => new Response(JSON.stringify({ error: { message: 'bad Authorization: Bearer ' + key } }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  }));
  const step = await probeProtocolPath({ baseUrl: 'https://relay.example/v1', key: key }, '/models');
  assert.equal(step.status, 401);
  assert.ok(!JSON.stringify(step).includes(key), '返回值里绝不能出现 Key');
});

test('probeProtocolPath 只认计划里的路径：计划外的路径一个请求都不发', async (t) => {
  const calls = stubFetch(t, () => json({ data: [] }));
  const step = await probeProtocolPath({ baseUrl: 'https://comfy.example.com' }, '/admin/secret');
  assert.equal(step, null);
  assert.deepEqual(calls, [], '这条路由是「按计划探一个」，不是任意路径的 GET 代理');
});

test('形状 → 协议：/models 的 {data:[…]} 是通用兜底，{models:[…]} 只证明 Gemini', async (t) => {
  let respond = () => json({ models: [{ name: 'models/gemini-3-pro-image' }] });
  stubFetch(t, (url) => (url.endsWith('/models') ? respond() : miss()));
  const gemini = await probeProtocolPath({ baseUrl: 'https://relay.example/v1' }, '/models');
  assert.deepEqual(gemini, { probe: '/models', shape: 'gemini-models', protocols: ['google-gemini'], status: 200, reason: '' });

  respond = () => json({ data: [{ id: 'flux' }] });
  const openai = await probeProtocolPath({ baseUrl: 'https://relay.example/v1' }, '/models');
  assert.equal(openai.shape, 'openai-data');
  assert.equal(openai.protocols[0], 'openai-images', '混淆时先给通用那条');
});

test('尾斜杠不会拼出 //object_info', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/object_info') ? json({ X: {} }) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:8188/' }, '');
  assert.deepEqual(run.hit.protocols, ['comfyui']);
  assert.deepEqual(urls(calls), ['http://127.0.0.1:8188/object_info']);
});

/* ------------------------------------------------------- 手选协议：只校验 */

test('校验模式：手选协议的探针排在计划最前面（内网 A1111 的例子）', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('排顺序不该发请求'); });
  const start = detectProtocolStart({ baseUrl: 'http://127.0.0.1:7860' }, '', { expected: 'a1111' });
  assert.deepEqual(start, {
    done: false,
    probes: ['/sdapi/v1/sd-models', '/object_info', '/API/ListModels', '/models']
  });
  assert.deepEqual(calls, []);
});

test('校验模式：手选协议的探针排在计划最前面（公网 openai-images 的例子）', () => {
  const start = detectProtocolStart({ baseUrl: 'https://relay.example/v1' }, '', { expected: 'openai-images' });
  assert.deepEqual(start, {
    done: false,
    probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']
  });
});

test('校验模式：地址静态就能证明 → 零请求直接 verified', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('静态能证明就不该发请求'); });
  const gemini = detectProtocolStart(
    { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    'gemini-2.5-flash-image',
    { expected: 'google-gemini' }
  );
  assert.deepEqual(gemini, {
    done: true,
    answer: { protocol: 'google-gemini', matched: true, probed: false, verified: true }
  });

  const azure = detectProtocolStart(
    { baseUrl: 'https://res.openai.azure.com/openai/v1' },
    'gpt-image-2.5-flare',
    { expected: 'openai-images' }
  );
  assert.deepEqual(azure, {
    done: true,
    answer: { protocol: 'openai-images', matched: true, probed: false, verified: true }
  });
  assert.deepEqual(calls, []);
});

test('手选的是没有模型端点的协议（BFL 一类）：只靠静态判定，不发请求', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('不该发请求'); });
  const hit = detectProtocolStart({ baseUrl: 'https://api.bfl.ai/v1' }, 'flux-pro-1.1', { expected: 'bfl' });
  assert.deepEqual(hit, {
    done: true,
    answer: { protocol: 'bfl', matched: true, probed: false, verified: true }
  });
  const wrong = detectProtocolStart({ baseUrl: 'https://relay.example/v1' }, 'some-model', { expected: 'bfl' });
  assert.deepEqual(wrong, {
    done: true,
    answer: { protocol: 'bfl', matched: false, probed: false, verified: false }
  });
  assert.deepEqual(calls, []);
});

test('校验模式命中：probeProtocolPath 的 protocols 里带着手选协议（客户端据此 verified）', async (t) => {
  stubFetch(t, (url) => (url.endsWith('/object_info') ? json({ CheckpointLoaderSimple: {} }) : miss()));
  const step = await probeProtocolPath({ baseUrl: 'http://127.0.0.1:8188' }, '/object_info');
  assert.deepEqual(step.protocols, ['comfyui']);
  assert.ok(step.protocols.includes('comfyui'));
});

test('「自定义」不算手选了协议：仍然做完整识别', async (t) => {
  const calls = stubFetch(t, (url) => (url.endsWith('/object_info') ? json({ X: {} }) : miss()));
  const run = await runPlan({ baseUrl: 'http://127.0.0.1:8188' }, '', { expected: 'custom' });
  assert.deepEqual(run.hit.protocols, ['comfyui']);
  assert.equal(calls.length, 1);
});

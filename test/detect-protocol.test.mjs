/**
 * 「识别协议」按钮的宿主半边：`detectProtocolStart()` 的静态判定与探测顺序。
 *
 * 规矩：
 *   1. 能靠地址/模型名认出来的，**一次请求都不发**——包括「已知的 OpenAI 兼容主机」
 *      （官方 / Azure / Together / 硅基流动 / 火山方舟 …）：直接判定 openai-images，
 *      并带上该主机的协议级选项；
 *   2. 只有主机完全不在表里（中转站 / 自建网关）才返回探测顺序；排顺序本身也是纯静态的，
 *      真正发请求是客户端拿着顺序一条条调 `probeProtocolPath()`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocolStart } from '../lib/adapters.js';

/** 把 globalThis.fetch 换成计数桩：这里所有用例都不该走到它。 */
function stubFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: String((init && init.method) || 'GET'), headers: (init && init.headers) || {} });
    return handler(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('认得出具体协议时一次探测都不发', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('本地匹配不该发请求'); });
  const cases = [
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash-image', 'google-gemini'],
    ['https://external.api.recraft.ai/v1', 'recraftv4', 'recraft'],
    ['https://openrouter.ai/api/v1', 'google/gemini-3.1-flash-image', 'openrouter-images'],
    ['https://api.bfl.ai/v1', 'flux-pro-1.1', 'bfl'],
    ['https://api.replicate.com/v1', 'black-forest-labs/flux', 'replicate'],
    ['https://dashscope.aliyuncs.com/api/v1', 'qwen-image-3.0-pro', 'dashscope-qwen-image'],
    ['https://dashscope.aliyuncs.com/api/v1', 'wanx2.1-t2i-turbo', 'dashscope-wanx']
  ];
  for (const [baseUrl, model, protocol] of cases) {
    const start = detectProtocolStart({ baseUrl: baseUrl, key: 'k' }, model);
    assert.deepEqual(start, {
      done: true,
      answer: { protocol: protocol, matched: true, probed: false }
    }, baseUrl + ' → ' + protocol);
  }
  assert.deepEqual(calls, [], '本地匹配阶段不该发任何请求');
});

test('已知的 OpenAI 兼容主机：直接判定 openai-images，零探测', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('已知主机不该探测 /models'); });
  const cases = [
    // 方舟 Agent Plan 的完整地址：/api/plan/v3/models 是 404，靠探测永远认不出来。
    ['https://ark.cn-beijing.volces.com/api/plan/v3', { edit: 'same' }],
    ['https://ark.cn-beijing.volces.com/api/v3', { edit: 'same' }],
    ['https://api.together.xyz/v1', { edit: 'none' }],
    ['https://api.siliconflow.cn/v1', { edit: 'same' }],
    // Azure 并进 openai-images 之后，鉴权形态（provider.auth）单独带回来，不进协议选项。
    ['https://res.openai.azure.com/openai/v1', {}, { mode: 'api-key' }],
    ['https://api.openai.com/v1', {}],
    ['https://api.fireworks.ai/inference/v1', {}],
    ['https://api.novita.ai/v3/openai', {}],
    // xAI / 智谱也并进来了：没有编辑端点。
    ['https://api.x.ai/v1', { edit: 'none' }],
    ['https://open.bigmodel.cn/api/paas/v4', { edit: 'none' }]
  ];
  for (const [baseUrl, expectedOptions, expectedAuth] of cases) {
    const start = detectProtocolStart({ baseUrl: baseUrl, key: 'k' }, 'some-image-model');
    const expected = { protocol: 'openai-images', matched: true, probed: false };
    if (Object.keys(expectedOptions).length) expected.protocolOptions = expectedOptions;
    if (expectedAuth) expected.auth = expectedAuth;
    assert.deepEqual(start, { done: true, answer: expected }, baseUrl);
  }
  assert.deepEqual(calls, [], '已知主机一个探测请求都不该发');
});

test('未知主机：只给探测顺序，自己不发请求', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('排顺序不该发请求'); });
  const start = detectProtocolStart({ baseUrl: 'https://relay.example/v1', key: 'k' }, 'flux-schnell');
  assert.deepEqual(start, {
    done: false,
    probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']
  });
  assert.deepEqual(calls, []);
});

test('地址都没有时给空协议（客户端自己拦），也不排探测顺序', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('没有地址不该发请求'); });
  assert.deepEqual(detectProtocolStart({}, 'x'), {
    done: true,
    answer: { protocol: '', matched: false, probed: false }
  });
  assert.deepEqual(calls, []);
});

test('配置里显式选中的协议不参与识别：按钮问的是地址像谁', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('排顺序不该发请求'); });
  const start = detectProtocolStart({
    baseUrl: 'https://relay.example/v1',
    adapter: 'openrouter-images',
    protocol: 'openai-responses'
  }, 'some-model');
  assert.deepEqual(start, {
    done: false,
    probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']
  });
  assert.deepEqual(calls, []);
});

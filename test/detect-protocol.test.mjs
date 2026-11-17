/**
 * 「识别协议」按钮的宿主半边（detectProtocolOf）。
 *
 * 规矩只有一条：能靠地址/模型名认出来的，**一次请求都不发**；只落到兜底的 openai-images
 * 才允许探测一次 GET /models——而且只读，绝不能碰 /images/generations（会花钱、耗配额）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocolOf } from '../lib/adapters.js';

/** 把 globalThis.fetch 换成计数桩：handler 决定回什么。 */
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

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status: status,
  headers: { 'content-type': 'application/json' }
});

test('认得出具体协议时一次探测都不发', async (t) => {
  const calls = stubFetch(t, () => { throw new Error('本地匹配不该发请求'); });
  const cases = [
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash-image', 'google-gemini'],
    ['https://api.x.ai/v1', 'grok-imagine-image', 'xai-imagine'],
    ['https://external.api.recraft.ai/v1', 'recraftv4', 'recraft'],
    ['https://api.openai.azure.com/openai/v1', 'gpt-image-2.5-flare', 'azure-openai'],
    ['https://openrouter.ai/api/v1', 'google/gemini-3.1-flash-image', 'openrouter-images'],
    ['https://api.bfl.ai/v1', 'flux-pro-1.1', 'bfl'],
    ['https://api.replicate.com/v1', 'black-forest-labs/flux', 'replicate'],
    ['https://open.bigmodel.cn/api/paas/v4', 'cogview-4', 'zhipu'],
    ['https://dashscope.aliyuncs.com/api/v1', 'qwen-image-3.0-pro', 'dashscope-qwen-image'],
    ['https://dashscope.aliyuncs.com/api/v1', 'wanx2.1-t2i-turbo', 'dashscope-wanx']
  ];
  for (const [baseUrl, model, protocol] of cases) {
    const result = await detectProtocolOf({ baseUrl: baseUrl, key: 'k' }, model);
    assert.deepEqual(result, { protocol: protocol, matched: true, probed: false }, baseUrl + ' → ' + protocol);
  }
  assert.deepEqual(calls, [], '本地匹配阶段不该发任何请求');
});

test('只落到兜底时探测一次 GET /models：200 + JSON → OpenAI 兼容网关', async (t) => {
  const calls = stubFetch(t, () => json({ data: [{ id: 'flux-schnell' }] }));
  const result = await detectProtocolOf({ baseUrl: 'https://relay.example/v1', key: 'k' }, 'flux-schnell');
  assert.deepEqual(result, { protocol: 'openai-images', matched: false, probed: true });
  assert.equal(calls.length, 1, '探测只发一次');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://relay.example/v1/models');
  assert.equal(calls[0].headers.Authorization, 'Bearer k', '探测带现有鉴权');
  assert.doesNotMatch(calls[0].url, /images\/(generations|edits)/, '绝不能发会生成图片的请求');
});

test('探测失败（404 / 401 / 500 / 非 JSON / 网络错误）都退回自定义', async (t) => {
  let handler = () => new Response('missing', { status: 404 });
  const calls = stubFetch(t, (url, init) => handler(url, init));
  const failures = [
    () => new Response('missing', { status: 404 }),
    () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    () => new Response('boom', { status: 500 }),
    () => new Response('<html>not json</html>', { status: 200 }),
    () => { throw new Error('ECONNREFUSED'); }
  ];
  for (const failure of failures) {
    handler = failure;
    const result = await detectProtocolOf({ baseUrl: 'https://relay.example/v1', key: 'k' }, '');
    assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  }
  assert.equal(calls.length, failures.length, '每次识别只发一次探测');
  assert.ok(calls.every((call) => call.url === 'https://relay.example/v1/models'));
});

test('地址都没有时不探测，直接把 protocol 留空（客户端自己拦）', async (t) => {
  const calls = stubFetch(t, () => json({ data: [] }));
  assert.deepEqual(await detectProtocolOf({}, 'x'), { protocol: '', matched: false, probed: false });
  assert.deepEqual(calls, []);
});

test('配置里显式选中的协议不参与识别：按钮问的是地址像谁', async (t) => {
  const calls = stubFetch(t, () => new Response('missing', { status: 404 }));
  const result = await detectProtocolOf({
    baseUrl: 'https://relay.example/v1',
    adapter: 'openrouter-images',
    protocol: 'openai-responses'
  }, 'some-model');
  assert.deepEqual(result, { protocol: 'custom', matched: false, probed: true });
  assert.equal(calls.length, 1);
});

/**
 * /api/mo-image/detect-protocol 路由：「识别协议」按钮在宿主这一侧的样子。
 *
 * 路由现在是**一次问一条**：
 *   - 不带 `probe`：静态能认就给答案（零上游请求），否则只返回探测顺序；
 *   - 带 `probe`：只探这一条路径，返回形状与它能证明的协议；命中即停由客户端做。
 *
 * 这里只管路由的约定：请求里现填的地址/密钥（或已保存的提供商）怎么用、
 * 计划外的 probe 怎么拒、地址缺失/提供商不存在时给带 code 的 400。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body) { if (body !== undefined) this.body = String(body); }
  };
}

function jsonReq(payload) {
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); }
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status: status,
  headers: { 'content-type': 'application/json' }
});

async function setup(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-detect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Saved relay', baseUrl: 'https://saved.example/v1', key: 'saved-key',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');
  process.env.DSH_HOME = home;

  const routes = [];
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register() { return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get() { return undefined; }
  };
  const mod = await import('../lib/index.js?detect-protocol-route-test');
  mod.apply(fake, { update: { skipCheck: true } });
  const route = routes.find((item) => item.path === '/api/mo-image/detect-protocol');
  assert.ok(route, 'the settings page needs the detect-protocol route');

  const calls = [];
  const original = globalThis.fetch;
  let respond = () => json({ data: [] });
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: String((init && init.method) || 'GET'),
      headers: (init && init.headers) || {}
    });
    return respond(url, init);
  };
  t.after(() => { globalThis.fetch = original; });

  return { route, calls, setRespond(fn) { respond = fn; } };
}

test('known host: answers from the local match without probing anything', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash-image' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: true, protocol: 'google-gemini', matched: true, probed: false
  });
  assert.deepEqual(calls, [], '认出协议时不该探测上游');
});

test('已知主机：火山方舟 Agent Plan 的完整地址 → openai-images + edit:same，零探测', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', key: 'draft-key', model: 'doubao-seedream-4-0-250828'
  }), res);
  assert.equal(res.status, 200);
  // /api/plan/v3/models 是 404，探测一定失败；所以这条路必须是「本地就认出来」。
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: true, protocol: 'openai-images', matched: true, probed: false,
    protocolOptions: { edit: 'same' }
  });
  assert.deepEqual(calls, [], '已知主机一个请求都不该发');
});

test('unknown host: answers only with the probe plan — zero upstream requests', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1', key: 'draft-key' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: false,
    probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']
  }, '公网 /models 打头，再试本地那三条');
  assert.deepEqual(calls, [], '排顺序不发请求');
});

test('probe step: one request, returns hit + shape + protocols', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  setRespond((url) => (url.endsWith('/object_info')
    ? json({ CheckpointLoaderSimple: {} })
    : new Response('missing', { status: 404 })));
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://comfy.example.com', key: 'k', probe: '/object_info' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: false, probe: '/object_info', hit: true, shape: 'object', protocols: ['comfyui'], status: 200
  });
  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [
    { url: 'https://comfy.example.com/object_info', method: 'GET' }
  ]);
  assert.doesNotMatch(calls[0].url, /images\/(generations|edits)/, '绝不能发会生成图片的请求');
});

test('probe miss: 404 answers hit:false (客户端继续下一条)', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  setRespond(() => new Response('missing', { status: 404 }));
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1', probe: '/models' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: false, probe: '/models', hit: false, shape: '', protocols: [], status: 404
  });
  assert.deepEqual(calls.map((call) => call.url), ['https://relay.example/v1/models']);
});

test('缺 Key 是独立状态：计划回复带 credential=missing，探针不带 Authorization', async (t) => {
  const { route, calls } = await setup(t);
  const plan = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1' }), plan);
  assert.equal(plan.status, 200);
  assert.deepEqual(JSON.parse(plan.body), {
    ok: true, done: false,
    probes: ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels'],
    credential: 'missing'
  });

  // 没 Key 也照发探针（本地 / 公开端点本来就可能不要鉴权），但请求里不能凭空多一个
  // Authorization：那会让 401 变成「我们发了个空 Bearer」而不是「用户没填 Key」。
  const probe = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1', probe: '/models' }), probe);
  assert.deepEqual(calls.map((call) => call.url), ['https://relay.example/v1/models']);
  assert.ok(
    !Object.keys(calls[0].headers || {}).some((name) => name.toLowerCase() === 'authorization'),
    '缺 Key 时不该带 Authorization 头'
  );
});

test('探针把 401 带回路由：hit:false + status:401，且响应里不回显 Key', async (t) => {
  const { route, setRespond } = await setup(t);
  setRespond(() => new Response(JSON.stringify({ error: { message: 'bad key: sk-secret' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  }));
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1', key: 'sk-secret', probe: '/models' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: false, probe: '/models', hit: false, shape: '', protocols: [], status: 401
  });
  assert.ok(!res.body.includes('sk-secret'), '响应体里绝不能出现 Key');
});

test('probe outside the plan: 400 with a translatable code, and zero requests', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'https://relay.example/v1', probe: '/admin/secret'
  }), res);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).code, 'provider.invalidProbe');
  assert.deepEqual(calls, [], '这条路由不是任意路径的 GET 代理');
});

test('a saved provider is used by id (no key in the draft)', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({ providerId: 'p1' }), res);
  assert.equal(res.status, 200);
  const answer = JSON.parse(res.body);
  assert.equal(answer.done, false);
  assert.deepEqual(answer.probes, ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']);
  assert.deepEqual(calls, [], '排顺序不发请求');

  const probe = makeRes();
  await route.handler(jsonReq({ providerId: 'p1', probe: '/models' }), probe);
  assert.deepEqual(JSON.parse(probe.body).protocols, ['openai-images', 'openai-chat', 'openai-responses', 'openrouter-images']);
  assert.deepEqual(calls.map((call) => call.url), ['https://saved.example/v1/models'], '用已保存的地址探测');
});

test('missing address or provider still answers with a code the UI can translate', async (t) => {
  const { route, calls } = await setup(t);
  const noUrl = makeRes();
  await route.handler(jsonReq({}), noUrl);
  assert.equal(noUrl.status, 400);
  assert.equal(JSON.parse(noUrl.body).code, 'provider.missingBaseUrl');

  const ghost = makeRes();
  await route.handler(jsonReq({ providerId: 'nope' }), ghost);
  assert.equal(ghost.status, 500);
  assert.equal(JSON.parse(ghost.body).code, 'provider.notFound');
  assert.deepEqual(calls, [], '连地址都没有就不该打上游');
});

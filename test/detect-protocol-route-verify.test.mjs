/**
 * `/api/mo-image/detect-protocol` 路由：探测表结果怎么送到设置页。
 *
 * 宿主那边认得对不对由 test/detect-protocol-local.test.mjs 钉；这里只管**路由的约定**：
 *   - 探针认出来的协议，`probe`（命中路径）与 `shape`（返回形状）要一起带回去，
 *     设置页才能写「已识别为 ComfyUI（/object_info 返回 JSON 对象）」；
 *   - 用户手选了协议（请求体里的 `expectedProtocol`）时，路由要把它转成校验模式：
 *     回答里带 `verified`，`protocol` 仍然是用户选的那条（外加可能有的 `suggested`）；
 *   - 一穷二白的老形状（公网 `/models` 命中 / 自定义）字段一个不多——老客户端不认新键，
 *     也不该因为多了个键就显示错话。
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
const miss = () => new Response('missing', { status: 404 });
const routeOf = (exactPath, respond) => (url) => (url.endsWith(exactPath) ? respond() : miss());

async function setup(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-detect-verify-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [],
    active: {},
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
  const mod = await import('../lib/index.js?detect-protocol-verify-test');
  mod.apply(fake, { update: { skipCheck: true } });
  const route = routes.find((item) => item.path === '/api/mo-image/detect-protocol');
  assert.ok(route, '设置页要用这条路由');

  const calls = [];
  const original = globalThis.fetch;
  let respond = () => json({ data: [] });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: String((init && init.method) || 'GET') });
    return respond(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });

  return { route, calls, setRespond(fn) { respond = fn; } };
}

test('内网 ComfyUI：路由把命中的探针与形状一起带回去', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  setRespond(routeOf('/object_info', () => json({ CheckpointLoaderSimple: {} })));
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'http://127.0.0.1:8188', key: 'draft-key' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, protocol: 'comfyui', matched: false, probed: true,
    probe: '/object_info', shape: 'object'
  });
  assert.deepEqual(calls.map((call) => call.url), ['http://127.0.0.1:8188/object_info']);
  assert.equal(calls[0].method, 'GET');
});

test('expectedProtocol：路由进校验模式，回答 verified + 看起来像谁，协议不变', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  setRespond(routeOf('/object_info', () => json({ CheckpointLoaderSimple: {} })));
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'http://127.0.0.1:7860', key: 'draft-key', expectedProtocol: 'a1111'
  }), res);
  assert.equal(res.status, 200);
  const answer = JSON.parse(res.body);
  assert.equal(answer.protocol, 'a1111', '用户选的协议不许被改掉');
  assert.equal(answer.verified, false);
  assert.equal(answer.suggested, 'comfyui');
  assert.equal(answer.suggestedProbe, '/object_info');
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:7860/sdapi/v1/sd-models',
    'http://127.0.0.1:7860/object_info'
  ]);
});

test('expectedProtocol 校验通过：verified + probe 一起回去', async (t) => {
  const { route } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-image',
    expectedProtocol: 'google-gemini'
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, protocol: 'google-gemini', matched: true, probed: false, verified: true
  });
});

test('公网 /models 命中还是老形状：不多带探针字段', async (t) => {
  const { route } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1', key: 'draft-key' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, protocol: 'openai-images', matched: false, probed: true });
});

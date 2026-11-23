/**
 * `/api/mo-image/detect-protocol` 路由：校验模式（expectedProtocol）怎么走。
 *
 * 用户手选了协议时按钮只校验、不改写。宿主这边把它翻译成：
 *   - 静态能证明 → 一次请求都不发，直接 `verified: true`；
 *   - 否则把**手选协议自己的探针**排在探测顺序最前面，由客户端逐条问；
 *     客户端拿 `protocols` 里有没有手选协议来判断「像不像它」，全都不中时保留用户的选择。
 *
 * 这里只管路由把这两件事送对；提示文案与循环在 test/client-detect-protocol-notes.test.mjs。
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
    get(name) { return name === 'connection' ? { requestRejection: () => undefined } : undefined; }
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

test('expectedProtocol 静态就能证明：零请求直接 verified', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-image',
    expectedProtocol: 'google-gemini'
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: true, protocol: 'google-gemini', matched: true, probed: false, verified: true
  });
  assert.deepEqual(calls, []);
});

test('expectedProtocol 校验：手选协议的探针排在计划最前面，且排顺序不发请求', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'http://127.0.0.1:7860', expectedProtocol: 'a1111'
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: false,
    probes: ['/sdapi/v1/sd-models', '/object_info', '/API/ListModels', '/models'],
    credential: 'missing'
  });
  assert.deepEqual(calls, []);
});

test('校验探针命中：protocols 里带着手选协议（客户端据此 verified）', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  setRespond(routeOf('/sdapi/v1/sd-models', () => json([{ title: 'sdxl' }])));
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'http://127.0.0.1:7860', probe: '/sdapi/v1/sd-models', expectedProtocol: 'a1111'
  }), res);
  assert.equal(res.status, 200);
  const answer = JSON.parse(res.body);
  assert.equal(answer.hit, true);
  assert.deepEqual(answer.protocols, ['a1111']);
  assert.deepEqual(calls.map((call) => call.url), ['http://127.0.0.1:7860/sdapi/v1/sd-models']);
});

test('校验没通过、下一条命中：protocols 告诉客户端「看起来像谁」', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  setRespond(routeOf('/object_info', () => json({ CheckpointLoaderSimple: {} })));
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'http://127.0.0.1:7860', probe: '/object_info', expectedProtocol: 'a1111'
  }), res);
  assert.equal(res.status, 200);
  const answer = JSON.parse(res.body);
  assert.equal(answer.hit, true);
  assert.deepEqual(answer.protocols, ['comfyui'], 'a1111 的协议保留给客户端，suggested 用这条');
  assert.deepEqual(calls.map((call) => call.url), ['http://127.0.0.1:7860/object_info']);
});

test('手选的是没有模型端点的协议（BFL 一类）：只报告「不像」，不发请求', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'https://relay.example/v1', model: 'some-model', expectedProtocol: 'bfl'
  }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, done: true, protocol: 'bfl', matched: false, probed: false, verified: false
  });
  assert.deepEqual(calls, []);
});

test('expectedProtocol 是「自定义」：不算手选协议，走普通识别顺序', async (t) => {
  const { route } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({
    baseUrl: 'https://relay.example/v1', expectedProtocol: 'custom'
  }), res);
  assert.equal(res.status, 200);
  const answer = JSON.parse(res.body);
  assert.equal(answer.done, false);
  assert.equal(answer.verified, undefined, '自定义没有可校验的协议');
  assert.deepEqual(answer.probes, ['/models', '/object_info', '/sdapi/v1/sd-models', '/API/ListModels']);
});

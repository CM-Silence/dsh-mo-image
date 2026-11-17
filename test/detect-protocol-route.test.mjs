/**
 * /api/mo-image/detect-protocol 路由：「识别协议」按钮在宿主这一侧的样子。
 *
 * 重点不是翻译逻辑（那在 detectProtocolOf 里），而是这条路由的约定：
 * 用请求里现填的地址/密钥（或已保存的提供商），认得出协议就 200 返回 id，
 * 认不出就返回 custom；地址缺失/提供商不存在时给带 code 的 400。
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
    calls.push({ url: String(url), method: String((init && init.method) || 'GET') });
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
  assert.deepEqual(JSON.parse(res.body), { ok: true, protocol: 'google-gemini', matched: true, probed: false });
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
    ok: true, protocol: 'openai-images', matched: true, probed: false, protocolOptions: { edit: 'same' }
  });
  assert.deepEqual(calls, [], '已知主机一个请求都不该发');
});

test('known host: azure carries the api-key option through the route', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://res.openai.azure.com/openai/v1', key: 'draft-key', model: 'gpt-image-2.5-flare' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, protocol: 'openai-images', matched: true, probed: false, protocolOptions: { auth: 'api-key' }
  });
  assert.deepEqual(calls, []);
});

test('unknown host: one read-only /models probe decides openai-images vs custom', async (t) => {
  const { route, calls, setRespond } = await setup(t);
  const ok = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1', key: 'draft-key' }), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, protocol: 'openai-images', matched: false, probed: true });
  assert.deepEqual(calls, [{ url: 'https://relay.example/v1/models', method: 'GET' }]);
  assert.doesNotMatch(calls[0].url, /images\/(generations|edits)/, '绝不能发会生成图片的请求');

  setRespond(() => new Response('missing', { status: 404 }));
  const miss = makeRes();
  await route.handler(jsonReq({ baseUrl: 'https://relay.example/v1' }), miss);
  assert.deepEqual(JSON.parse(miss.body), { ok: true, protocol: 'custom', matched: false, probed: true });
});

test('a saved provider is used by id (no key in the draft)', async (t) => {
  const { route, calls } = await setup(t);
  const res = makeRes();
  await route.handler(jsonReq({ providerId: 'p1' }), res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).protocol, 'openai-images');
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

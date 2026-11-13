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
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); }
  };
}

function fakeContext(routes, tools) {
  const credentials = {
    async resolve() { return { value: 'sk-test', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; },
    async set() {},
    async unset() {}
  };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

test('a 404 from the model list endpoint asks the user to type the model id', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-models-404-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: '火山方舟 Agent Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      key: 'sk-secret', protocol: 'openai-images', adapter: '', models: [], names: {}
    }],
    active: { providerId: 'p1', model: '' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'not found' } }), {
    status: 404, headers: { 'content-type': 'application/json' }
  });

  const routes = [];
  const tools = [];
  const mod = await import('../lib/index.js?models-404-test');
  mod.apply(fakeContext(routes, tools));
  const route = routes.find((item) => item.path === '/api/mo-image/models');
  assert.ok(route, 'expected the models route');

  const res = makeRes();
  await route.handler(jsonReq(JSON.stringify({
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', adapter: '', protocol: 'openai-images', key: 'sk-secret'
  })), res);

  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'models.notFound');
  assert.match(body.error, /模型 ID/);
});

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

function writeConfig(home, id, name) {
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id, name, baseUrl: 'https://api.test/v1', apiKeyEnv: 'MO_IMAGE_' + id.toUpperCase() + '_API_KEY',
      protocol: 'openai-images', adapter: '', models: ['model-a'], names: {}
    }],
    active: { providerId: id, model: 'model-a' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');
}

function fakeContext() {
  const routes = [];
  const credentials = {
    async resolve() { return undefined; },
    async describe() { return { configured: false, writable: true }; },
    async set() {},
    async unset() {}
  };
  return {
    routes,
    ctx: {
      effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
      inject(_deps, callback) { callback(this); },
      tools: { register() { return () => {}; } },
      webServer: {
        register(route) { routes.push(route); return () => {}; },
        getOrigin() { return 'http://127.0.0.1:1'; }
      },
      get(name) { return name === 'credentials' ? credentials : undefined; }
    }
  };
}

test('apply captures the config path per instance instead of import time', async (t) => {
  const a = mkdtempSync(path.join(os.tmpdir(), 'mo-image-path-a-'));
  const b = mkdtempSync(path.join(os.tmpdir(), 'mo-image-path-b-'));
  const originalHome = process.env.DSH_HOME;
  t.after(() => {
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
  writeConfig(a, 'pa', 'Provider A');
  writeConfig(b, 'pb', 'Provider B');

  const mod = await import('../lib/index.js?config-path-test');
  process.env.DSH_HOME = a;
  const first = fakeContext();
  mod.apply(first.ctx);
  const firstRoute = first.routes.find((route) => route.path === '/api/mo-image/config');
  const firstRes = makeRes();
  await firstRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:1' }, url: '/api/mo-image/config' }, firstRes);
  assert.equal(JSON.parse(firstRes.body).config.providers[0].name, 'Provider A');

  process.env.DSH_HOME = b;
  const second = fakeContext();
  mod.apply(second.ctx);
  const secondRoute = second.routes.find((route) => route.path === '/api/mo-image/config');
  const secondRes = makeRes();
  await secondRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:1' }, url: '/api/mo-image/config' }, secondRes);
  assert.equal(JSON.parse(secondRes.body).config.providers[0].name, 'Provider B');
});

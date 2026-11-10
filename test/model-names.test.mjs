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

function jsonReq(method, payload) {
  return {
    method,
    headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); }
  };
}

async function bootRoute(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-names-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5' },
    defaults: {}
  }, null, 2), 'utf8');

  process.env.DSH_HOME = home;
  const routes = [];
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register() { return () => {}; } },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
      getOrigin() { return 'http://127.0.0.1:1'; }
    },
    get() { return undefined; }
  };
  const mod = await import('../lib/index.js?model-names-test');
  mod.apply(fake);
  const route = routes.find((item) => item.path === '/api/mo-image/models');
  assert.ok(route, 'expected the models route');
  return route;
}

test('the model route returns the display names the endpoint lists', async (t) => {
  const route = await bootRoute(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: 'flux-1-dev', display_name: 'FLUX.1 dev' },
      { id: 'gpt-image-2.5' },
      { id: 'chat-model-9', name: 'Chat 9' }
    ]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = makeRes();
    await route.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.test/v1', adapter: 'openai-images', optionalKey: true
    })), res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.models, ['flux-1-dev', 'gpt-image-2.5']);
    assert.deepEqual(body.allModels, ['flux-1-dev', 'gpt-image-2.5', 'chat-model-9']);
    assert.deepEqual(body.names, { 'flux-1-dev': 'FLUX.1 dev', 'chat-model-9': 'Chat 9' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the model route omits names that merely repeat the id', async (t) => {
  const route = await bootRoute(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'flux-1-dev', display_name: 'flux-1-dev' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = makeRes();
    await route.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.test/v1', adapter: 'openai-images', optionalKey: true
    })), res);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).names, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('adapter listings carry display names where the provider labels its models', async (t) => {
  const { resolveAdapter, listProviderModelEntries } = await import('../lib/adapters.js');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const gemini = await listProviderModelEntries(
      resolveAdapter({ adapter: 'google-gemini' }, ''),
      { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', key: 'k' },
      AbortSignal.timeout(5000)
    );
    assert.deepEqual(gemini, [{ id: 'gemini-2.5-flash-image', name: 'Nano Banana' }]);

    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ id: 'sd-xl', name: 'SDXL 1.0' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const localai = await listProviderModelEntries(
      resolveAdapter({ adapter: 'localai' }, ''),
      { baseUrl: 'http://127.0.0.1:8080/v1' },
      AbortSignal.timeout(5000)
    );
    assert.deepEqual(localai, [{ id: 'sd-xl', name: 'SDXL 1.0' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

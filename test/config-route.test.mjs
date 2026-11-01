import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

test('config route migrates keys to the credentials store and never returns them', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  const configFile = path.join(state, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: 'secret',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');

  process.env.DSH_HOME = home;
  const routes = [];
  const tools = [];
  const secrets = new Map();
  const credentials = {
    async resolve(ref) {
      const value = secrets.get(ref);
      return value === undefined ? undefined : { value, source: 'file' };
    },
    async describe(ref) {
      return secrets.has(ref)
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true };
    },
    async set(ref, value) {
      if (!value) throw new Error('empty');
      secrets.set(ref, value);
    },
    async unset(ref) { secrets.delete(ref); }
  };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
      getOrigin() { return 'http://127.0.0.1:1'; }
    },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  const mod = await import('../lib/index.js?config-route-test');
  mod.apply(fake);
  const route = routes.find((item) => item.path === '/api/mo-image/config');
  assert.ok(route);

  const getRes = makeRes();
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:1' }, url: '/api/mo-image/config' }, getRes);
  assert.equal(getRes.status, 200);
  const getBody = JSON.parse(getRes.body);
  assert.equal(getBody.config.providers[0].key, undefined);
  assert.equal(getBody.config.providers[0].hasKey, true);
  assert.ok(Array.isArray(getBody.adapters));
  assert.ok(Array.isArray(getBody.providerPresets));
  assert.ok(Array.isArray(getBody.localPresets));
  assert.ok(getBody.providerPresets.some((preset) => preset.id === 'gemini' && preset.adapter === 'google-gemini'));
  assert.ok(getBody.providerPresets.some((preset) => preset.id === 'xai' && preset.adapter === 'xai-imagine'));
  assert.ok(getBody.localPresets.some((preset) => preset.id === 'a1111' && preset.adapter === 'a1111'));
  assert.ok(getBody.adapters.some((adapter) => adapter.id === 'a1111' && adapter.supportsModels === true));
  assert.equal(getBody.config.providers[0].keySource, 'file');
  assert.equal(getBody.config.providers[0].apiKeyEnv, 'MO_IMAGE_P1_API_KEY');
  assert.equal(getBody.config.defaults.promptOptimization, true);
  const p1 = getBody.capabilities.find((item) => item.providerId === 'p1');
  const model = p1 && p1.models.find((item) => item.model === 'gpt-image-2.5-flare');
  assert.ok(model && model.quality);
  assert.deepEqual(model.quality.options.map((item) => item.value), ['off', 'low', 'medium', 'high', 'auto']);
  assert.equal(model.quality.default, 'high');
  assert.equal(secrets.get('MO_IMAGE_P1_API_KEY'), 'secret');
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).providers[0].key, undefined);

  const postRes = makeRes();
  const payload = JSON.stringify({
    config: {
      version: 1,
      providers: [{
        id: 'p1', name: 'Test renamed', baseUrl: 'https://api.test/v1', key: '',
        models: ['gpt-image-2.5-flare'], names: {}, hasKey: true
      }],
      active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
      defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
    }
  });
  await route.handler(jsonReq('POST', payload), postRes);
  assert.equal(postRes.status, 200);
  const postBody = JSON.parse(postRes.body);
  assert.equal(postBody.config.providers[0].key, undefined);
  assert.equal(postBody.config.providers[0].hasKey, true);
  assert.equal(secrets.get('MO_IMAGE_P1_API_KEY'), 'secret');
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).providers[0].key, undefined);

  const newKeyRes = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    config: {
      version: 1,
      providers: [{
        id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: 'new-secret',
        models: ['gpt-image-2.5-flare'], names: {}
      }],
      active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
      defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
    }
  })), newKeyRes);
  assert.equal(newKeyRes.status, 200);
  assert.equal(secrets.get('MO_IMAGE_P1_API_KEY'), 'new-secret');
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).providers[0].key, undefined);

  const deleteRes = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    config: {
      version: 1, providers: [],
      active: { providerId: '', model: '' },
      defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
    }
  })), deleteRes);
  assert.equal(deleteRes.status, 200);
  assert.equal(secrets.has('MO_IMAGE_P1_API_KEY'), false);

  const offRes = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    config: {
      version: 1, providers: [], active: { providerId: '', model: '' },
      defaults: { quality: 'max', auto: false, width: 2000, height: 2000, promptOptimization: false }
    }
  })), offRes);
  assert.equal(offRes.status, 200);
  const offBody = JSON.parse(offRes.body).config.defaults;
  assert.equal(offBody.promptOptimization, false);
  assert.equal(offBody.quality, 'max');
  assert.equal(offBody.auto, false);
  assert.equal(offBody.width, 2000);
  assert.equal(offBody.height, 2000);

  const modelsRoute = routes.find((item) => item.path === '/api/mo-image/models');
  assert.ok(modelsRoute);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'local-model-a' }, { id: 'local-model-b' }] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  try {
    const modelsRes = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'http://127.0.0.1:9999/v1', adapter: 'openai-images', optionalKey: true
    })), modelsRes);
    assert.equal(modelsRes.status, 200);
    assert.deepEqual(JSON.parse(modelsRes.body).models, ['local-model-a', 'local-model-b']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const crossOrigin = makeRes();
  await route.handler({
    method: 'POST',
    headers: { host: '127.0.0.1:1', origin: 'http://evil.test', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); }
  }, crossOrigin);
  assert.equal(crossOrigin.status, 403);

  const formPost = makeRes();
  await route.handler({
    method: 'POST',
    headers: { host: '127.0.0.1:1', 'content-type': 'text/plain' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); }
  }, formPost);
  assert.equal(formPost.status, 415);

  const rebinding = makeRes();
  await route.handler({
    method: 'POST',
    headers: { host: 'evil.test', origin: 'http://evil.test', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); }
  }, rebinding);
  assert.equal(rebinding.status, 403);
});

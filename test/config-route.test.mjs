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
  assert.ok(getBody.providerPresets.some((preset) => preset.id === 'xai' && preset.adapter === 'openai-images'
    && preset.protocolOptions && preset.protocolOptions.edit === 'none'));
  assert.ok(getBody.localPresets.some((preset) => preset.id === 'a1111' && preset.adapter === 'a1111'));
  assert.ok(getBody.adapters.some((adapter) => adapter.id === 'a1111' && adapter.supportsModels === true));
  assert.equal(getBody.config.providers[0].keySource, 'file');
  assert.equal(getBody.config.providers[0].apiKeyEnv, 'MO_IMAGE_P1_API_KEY');
  assert.equal(getBody.config.defaults.promptOptimization, true);
  const p1 = getBody.capabilities.find((item) => item.providerId === 'p1');
  const model = p1 && p1.models.find((item) => item.model === 'gpt-image-2.5-flare');
  assert.ok(model && model.quality);
  assert.deepEqual(model.quality.options.map((item) => item.value), ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
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
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'flux-local-a' }, { id: 'gpt-4o' }, { id: 'flux-local-b' }]
  }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  try {
    const modelsRes = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'http://127.0.0.1:9999/v1', adapter: 'openai-images', optionalKey: true
    })), modelsRes);
    assert.equal(modelsRes.status, 200);
    const modelsBody = JSON.parse(modelsRes.body);
    assert.deepEqual(modelsBody.models, ['flux-local-a', 'flux-local-b']);
    assert.deepEqual(modelsBody.allModels, ['flux-local-a', 'gpt-4o', 'flux-local-b']);
    assert.equal(modelsBody.filteredCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 自定义协议：模型列表走用户自己填的那个绝对地址，不跟 baseUrl 拼
  let customUrl = '';
  globalThis.fetch = async (url) => {
    customUrl = String(url);
    return new Response(JSON.stringify({ data: [{ id: 'flux-x' }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const customRes = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://g.example',
      adapter: 'custom',
      protocol: 'openai-images',
      customEndpoints: {
        generate: 'https://g.example/v1/images/generations',
        edit: '',
        models: 'https://g.example/v1/models'
      }
    })), customRes);
    assert.equal(customRes.status, 200, customRes.body);
    assert.equal(customUrl, 'https://g.example/v1/models');
    assert.deepEqual(JSON.parse(customRes.body).models, ['flux-x']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'Qwen/Qwen-Image' }, { id: 'Qwen/Qwen2.5-72B-Instruct' }]
  }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  try {
    const modelsRes = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.siliconflow.cn/v1', adapter: '', optionalKey: false
    })), modelsRes);
    assert.equal(modelsRes.status, 200);
    const modelsBody = JSON.parse(modelsRes.body);
    assert.deepEqual(modelsBody.models, ['Qwen/Qwen-Image']);
    assert.deepEqual(modelsBody.allModels, ['Qwen/Qwen-Image', 'Qwen/Qwen2.5-72B-Instruct']);
    assert.equal(modelsBody.filteredCount, 1);
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

  const missingBase = makeRes();
  await modelsRoute.handler(jsonReq('POST', JSON.stringify({ baseUrl: '' })), missingBase);
  assert.equal(missingBase.status, 400);
  const missingBaseBody = JSON.parse(missingBase.body);
  assert.equal(missingBaseBody.code, 'provider.missingBaseUrl');
  assert.equal(missingBaseBody.error, '请先填写 API 地址');

  const badJson = makeRes();
  await modelsRoute.handler(jsonReq('POST', '{not json'), badJson);
  assert.equal(badJson.status, 502);
  assert.equal(JSON.parse(badJson.body).code, 'request.invalidJson');

  fake.get = () => undefined;
  const noCredentials = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    config: {
      version: 1,
      providers: [{ id: 'p9', name: 'No creds', baseUrl: 'https://api.test/v1', key: 'secret', models: [] }],
      active: { providerId: 'p9', model: '' },
      defaults: {}
    }
  })), noCredentials);
  assert.equal(noCredentials.status, 500);
  assert.equal(JSON.parse(noCredentials.body).code, 'config.credentialsUnavailable');

  const savedNoProxy = process.env.NO_PROXY;
  const savedOverride = process.env.MO_IMAGE_PROXY;
  process.env.NO_PROXY = '*';
  delete process.env.MO_IMAGE_PROXY;
  globalThis.fetch = async () => {
    throw Object.assign(new Error('fetch failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  };
  try {
    const networkRes = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images', optionalKey: true
    })), networkRes);
    assert.equal(networkRes.status, 502);
    const networkBody = JSON.parse(networkRes.body);
    assert.equal(networkBody.code, 'network.failed');
    assert.equal(networkBody.params.host, 'api.openai.com');
    assert.equal(networkBody.params.via, 'direct');
    assert.equal(networkBody.params.hint, 'timeout');
    assert.match(networkBody.error, /网络请求失败：api\.openai\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedNoProxy;
    if (savedOverride === undefined) delete process.env.MO_IMAGE_PROXY; else process.env.MO_IMAGE_PROXY = savedOverride;
  }

  process.env.NO_PROXY = '*';
  delete process.env.MO_IMAGE_PROXY;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401, headers: { 'content-type': 'application/json' }
    });
    const upstreamRes = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images', optionalKey: true
    })), upstreamRes);
    assert.equal(upstreamRes.status, 502);
    const upstreamBody = JSON.parse(upstreamRes.body);
    assert.equal(upstreamBody.code, 'upstream.http');
    assert.equal(upstreamBody.params.status, 401);
    assert.equal(upstreamBody.params.detail, 'bad key');

    globalThis.fetch = async () => new Response('not json', {
      status: 200, headers: { 'content-type': 'text/plain' }
    });
    const invalidJson = makeRes();
    await modelsRoute.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images', optionalKey: true
    })), invalidJson);
    assert.equal(JSON.parse(invalidJson.body).code, 'upstream.invalidJson');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedNoProxy;
    if (savedOverride === undefined) delete process.env.MO_IMAGE_PROXY; else process.env.MO_IMAGE_PROXY = savedOverride;
  }
});

/* ------------------------- 模型规则检测路由（尺寸 / 质量规则下发） ------------------------- */

/** 每个用例一份独立的 DSH_HOME 与模块实例，路由从 webServer.register 里捡。 */
async function bootRuleRoutes(t, seq, config) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-rules-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  if (config) writeFileSync(path.join(state, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
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
  const mod = await import('../lib/index.js?config-route-rules-' + seq);
  mod.apply(fake);
  return routes;
}

test('detect-model-rule 下发命中模型的尺寸规则，质量没有规则时返回 null', async (t) => {
  const routes = await bootRuleRoutes(t, 1);
  const route = routes.find((item) => item.path === '/api/mo-image/detect-model-rule');
  assert.ok(route, '缺少 /api/mo-image/detect-model-rule 路由');

  const res = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen-Image'
  })), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.model, 'Qwen/Qwen-Image');
  assert.equal(body.size.mode, 'wh-string');
  assert.equal(body.size.field, 'image_size');
  assert.equal(body.size.separator, 'x');
  assert.ok(body.size.domain.allowed.includes('1328x1328'));
  // 质量目前没有兜底规则：这个模型不该凭空得到一套档位。
  assert.equal(body.quality, null);
});

test('detect-model-rule 缺参数时回 4xx 与结构化的错误体', async (t) => {
  const routes = await bootRuleRoutes(t, 2);
  const route = routes.find((item) => item.path === '/api/mo-image/detect-model-rule');
  assert.ok(route, '缺少 /api/mo-image/detect-model-rule 路由');

  const noBaseUrl = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({ baseUrl: '' })), noBaseUrl);
  assert.equal(noBaseUrl.status, 400);
  const noBaseUrlBody = JSON.parse(noBaseUrl.body);
  assert.equal(noBaseUrlBody.ok, false);
  assert.equal(noBaseUrlBody.code, 'provider.missingBaseUrl');
  assert.equal(noBaseUrlBody.error, '请先填写 API 地址');

  const noModel = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://api.siliconflow.cn/v1', model: '   '
  })), noModel);
  assert.equal(noModel.status, 400);
  const noModelBody = JSON.parse(noModel.body);
  assert.equal(noModelBody.ok, false);
  assert.match(noModelBody.error, /模型/);
});

test('detect-model-rule 支持一次传多个模型，rules 仍是 { size, quality }', async (t) => {
  const routes = await bootRuleRoutes(t, 5);
  const route = routes.find((item) => item.path === '/api/mo-image/detect-model-rule');
  assert.ok(route, '缺少 /api/mo-image/detect-model-rule 路由');

  const res = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://api.siliconflow.cn/v1',
    adapter: 'custom',
    customEndpoints: { generate: 'https://api.siliconflow.cn/v1/images/generations' },
    models: ['Qwen/Qwen-Image', 'flux-1-dev', 'Qwen/Qwen-Image']
  })), res);
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  // 重复的模型只算一次，顺序按请求来。
  assert.deepEqual(Object.keys(body.rules), ['Qwen/Qwen-Image', 'flux-1-dev']);
  assert.equal(body.rules['Qwen/Qwen-Image'].size.mode, 'wh-string');
  assert.equal(body.rules['Qwen/Qwen-Image'].size.field, 'image_size');
  assert.equal(body.rules['Qwen/Qwen-Image'].quality, null);
  // 批量模式下「每条规则」的形状与单模型响应里的 size / quality 完全一致。
  assert.deepEqual(Object.keys(body.rules['Qwen/Qwen-Image']).sort(), ['quality', 'size']);
  // 字段模板与「有没有命中规则」另放两张表：一键配置要用它们决定写哪些键。
  assert.deepEqual(body.fields['Qwen/Qwen-Image'].prompt, { path: 'prompt' });
  assert.deepEqual(body.fields['Qwen/Qwen-Image'].image, { path: 'image', as: 'dataUrl' });
  assert.equal(body.matched['Qwen/Qwen-Image'], true);
  // 硅基流动的分支按主机命中所有模型，所以认不出的模型名也算命中。
  assert.equal(body.matched['flux-1-dev'], true);
});

test('detect-model-rule 批量模式：认不出的网关仍发兜底尺寸，但标记为未命中', async (t) => {
  const routes = await bootRuleRoutes(t, 6);
  const route = routes.find((item) => item.path === '/api/mo-image/detect-model-rule');
  assert.ok(route);

  const res = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://gateway.example/v1', models: ['some-unknown-model']
  })), res);
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  // 兜底规则让尺寸永远有值：面板据此知道「按 OpenAI 兼容发 size」。
  assert.equal(body.rules['some-unknown-model'].size.mode, 'wh-string');
  assert.equal(body.rules['some-unknown-model'].size.field, 'size');
  assert.equal(body.rules['some-unknown-model'].quality, null);
  assert.equal(body.matched['some-unknown-model'], false, '兜底不算认出');

  // 反过来：有专门尺寸规则、但网关不认识（中转站）的模型算认出——一键配置要给它写尺寸。
  const known = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://gateway.example/v1', models: ['flux-1-dev', 'doubao-seedream-5-5-261028']
  })), known);
  const knownBody = JSON.parse(known.body);
  assert.equal(knownBody.matched['flux-1-dev'], true, 'FLUX 在兼容网关上就是 size');
  assert.equal(knownBody.rules['flux-1-dev'].size.field, 'size');
  assert.equal(knownBody.matched['doubao-seedream-5-5-261028'], true, 'seedream 有自己的尺寸规则');
  assert.equal(knownBody.rules['doubao-seedream-5-5-261028'].size.field, 'size');
  assert.deepEqual(knownBody.rules['doubao-seedream-5-5-261028'].size.domain.tiers.map((item) => item.value),
    ['1K', '1.5K', '2K']);

  // 模型列表空了就是请求本身有问题，和单模型模式的「没填模型」同一档。
  const empty = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://gateway.example/v1', models: ['  ']
  })), empty);
  assert.equal(empty.status, 400);
  assert.equal(JSON.parse(empty.body).ok, false);
  assert.match(JSON.parse(empty.body).error, /模型/);
});

test('detect-model-rule 单模型响应只加字段与命中标记，不改老字段', async (t) => {
  const routes = await bootRuleRoutes(t, 7);
  const route = routes.find((item) => item.path === '/api/mo-image/detect-model-rule');
  assert.ok(route);

  const res = makeRes();
  await route.handler(jsonReq('POST', JSON.stringify({
    baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images', model: 'gpt-image-2.5-flare'
  })), res);
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.model, 'gpt-image-2.5-flare');
  assert.equal(body.size.field, 'size');
  assert.ok(Array.isArray(body.quality.options));
  assert.equal(body.quality.field, 'quality');
  // 官方端点没有负面词：字段模板如实写 null。
  assert.equal(body.fields.negative, null);
  assert.deepEqual(body.fields.image, { multipart: 'image[]' });
  assert.equal(body.matched, true);
});

test('models 路由只给本次新增的模型附 detected', async (t) => {
  const routes = await bootRuleRoutes(t, 3);
  const route = routes.find((item) => item.path === '/api/mo-image/models');
  assert.ok(route);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'flux-local-a' }, { id: 'Qwen/Qwen-Image' }, { id: 'chat-model-9' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = makeRes();
    await route.handler(jsonReq('POST', JSON.stringify({
      baseUrl: 'https://api.siliconflow.cn/v1',
      adapter: 'openai-images',
      optionalKey: true,
      // 表单里已经有的模型：不该再算规则，也不该出现在 detected 里。
      known: ['flux-local-a']
    })), res);
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.models, ['flux-local-a', 'Qwen/Qwen-Image']);
    assert.equal(body.knownSource, 'request');
    assert.deepEqual(body.detectedModels, ['Qwen/Qwen-Image']);
    assert.deepEqual(Object.keys(body.detected), ['Qwen/Qwen-Image']);
    assert.equal(body.detected['Qwen/Qwen-Image'].size.field, 'image_size');
    assert.equal(body.detected['Qwen/Qwen-Image'].quality, null);
    assert.equal(body.detected['flux-local-a'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('models 路由没传 known 时按已保存的模型列表判断新增', async (t) => {
  const routes = await bootRuleRoutes(t, 4, {
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: '',
      protocol: 'openai-images', adapter: '', models: ['gpt-image-2.5'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5' },
    defaults: {}
  });
  const route = routes.find((item) => item.path === '/api/mo-image/models');
  assert.ok(route);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'gpt-image-2.5' }, { id: 'flux-1-dev' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = makeRes();
    await route.handler(jsonReq('POST', JSON.stringify({
      providerId: 'p1', adapter: 'openai-images', optionalKey: true
    })), res);
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.models, ['gpt-image-2.5', 'flux-1-dev']);
    assert.equal(body.knownSource, 'provider');
    assert.deepEqual(body.detectedModels, ['flux-1-dev']);
    assert.equal(body.detected['gpt-image-2.5'], undefined);
    assert.equal(body.detected['flux-1-dev'].size.field, 'size');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

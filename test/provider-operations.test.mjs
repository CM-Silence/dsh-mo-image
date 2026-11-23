import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, callImageApi } from '../lib/index.js';
import { normalizeConfig } from '../lib/config-store.js';
import { detectProtocolStart, fitSize, providerPresetManifest, resolveAdapter } from '../lib/adapters.js';
import { normalizeOperations, outputPresetManifest } from '../lib/provider-operations.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const json = (data, status = 200) => Response.json(data, { status });
const png = () => new Response(Buffer.from(PNG, 'base64'), { headers: { 'content-type': 'image/png' } });
const input = { model: 'm', prompt: 'a red fox', fitted: { width: 512, height: 512, size: '512x512' } };
const relay = {
  id: 'relay', name: 'Mock relay', adapter: 'custom', baseUrl: 'https://relay.invalid/api',
  auth: { mode: 'custom', header: 'X-Relay-Key' }, models: ['m'],
  customEndpoints: { generate: 'render', edit: 'retouch', models: 'catalog' }
};

test('shipped Fireworks and Novita presets use their documented image APIs', async (t) => {
  const presets = providerPresetManifest();
  const cdn = 'https://cdn.invalid/result.png';
  const calls = stubFetch(t, ({ url, method, headers, body }) => {
    if (url.href === cdn) {
      assert.equal(headers.get('authorization'), null);
      assert.equal(method, 'GET');
      return png();
    }
    assert.equal(method, 'POST');
    assert.equal(headers.get('authorization'), 'Bearer mock-key');
    if (url.host === 'api.fireworks.ai') {
      assert.equal(url.pathname, '/inference/v1/workflows/accounts/fireworks/models/flux-1-schnell-fp8/text_to_image');
      assert.equal(headers.get('accept'), 'image/png');
      assert.deepEqual(JSON.parse(body), { prompt: input.prompt, aspect_ratio: '1:1' });
      return png();
    }
    assert.equal(url.href, 'https://api.novita.ai/v3beta/flux-1-schnell');
    assert.deepEqual(JSON.parse(body), {
      prompt: input.prompt, width: 512, height: 512, image_num: 1, response_image_format: 'png'
    });
    return json({ images: [{ image_url: cdn }], task: { task_id: 'done' } });
  });
  for (const id of ['fireworks', 'novita']) {
    const preset = presets.find((entry) => entry.id === id);
    const provider = normalizeConfig({ providers: [{ ...preset, presetId: id, key: 'mock-key' }] }).providers[0];
    const model = provider.models[0];
    assert.equal(provider.presetId, id);
    assert.equal(preset.supportsModels, false);
    assert.equal(detectProtocolStart({ baseUrl: preset.baseUrl }).done, false);
    const result = await callImageApi('generate', resolveAdapter(provider, model), provider, { ...input, model });
    assert.equal(result.contentType, 'image/png');
  }
  assert.equal(calls.length, 3);
});

test('Microsoft Foundry serves MAI generation and multipart edits under /mai/v1', async (t) => {
  const preset = providerPresetManifest().find((entry) => entry.id === 'azure-mai');
  const model = 'eastus/MAI-Image-2.6-Flash-202611:preview';
  const provider = normalizeConfig({
    providers: [{
      ...preset, presetId: preset.id, key: 'mock-key',
      baseUrl: 'https://demo.services.ai.azure.com/mai/v1', models: [model]
    }]
  }).providers[0];
  const adapter = resolveAdapter(provider, model);
  assert.equal(preset.supportsModels, false);
  assert.equal(adapter.id, 'custom');
  assert.equal(detectProtocolStart({ baseUrl: provider.baseUrl }, model).done, false);
  const fitted = fitSize(provider, '8192x384', model, adapter);
  assert.ok(fitted.width >= 768 && fitted.height >= 768);
  assert.ok(fitted.width * fitted.height <= 2359296);
  const calls = stubFetch(t, ({ url, method, headers, body }) => {
    assert.equal(method, 'POST');
    assert.equal(headers.get('api-key'), 'mock-key');
    assert.equal(headers.get('authorization'), null);
    if (url.pathname === '/mai/v1/images/generations') {
      assert.deepEqual(JSON.parse(body), { model, prompt: input.prompt, width: fitted.width, height: fitted.height });
    } else {
      assert.equal(url.pathname, '/mai/v1/images/edits');
      assert.equal(body.get('model'), model);
      assert.equal(body.get('prompt'), input.prompt);
      assert.deepEqual(body.getAll('image').map((file) => file.name), ['a.png', 'b.png']);
      assert.equal(body.has('width'), false);
      assert.equal(body.has('height'), false);
    }
    return json({ data: [{ b64_json: PNG }] });
  });
  const images = ['a.png', 'b.png'].map((filename) => ({ filename, buffer: Buffer.from(PNG, 'base64'), contentType: 'image/png' }));
  for (const kind of ['generate', 'edit']) {
    const result = await callImageApi(kind, adapter, provider, { ...input, model, fitted, images: kind === 'edit' ? images : [] });
    assert.equal(result.contentType, 'image/png');
  }
  await assert.rejects(
    callImageApi('edit', adapter, provider, { ...input, model, fitted, images: Array(6).fill(images[0]) }),
    /最多接受 5 张/
  );
  await assert.rejects(callImageApi('edit', adapter, provider, {
    ...input, model, fitted, images: [{ ...images[0], contentType: 'image/webp' }]
  }), /image\/jpeg、image\/png/);
  assert.equal(calls.length, 2);
});

test('TokenHub discovers supported Hy models and downloads final images after generation and edit', async (t) => {
  const preset = providerPresetManifest().find((entry) => entry.id === 'tencent-tokenhub');
  const [model] = preset.models;
  const variant = 'regional/' + model + ':latest';
  const provider = normalizeConfig({ providers: [{ ...preset, presetId: preset.id, key: 'mock-key' }] }).providers[0];
  const adapter = resolveAdapter(provider, model);
  const { home, route, tools } = hostFor(t);
  const cdn = 'https://images.example.test/hy-final.png';
  const submissions = [];
  const calls = stubFetch(t, ({ url, method, headers, body }) => {
    if (url.href === cdn) {
      assert.equal(method, 'GET');
      assert.equal(headers.get('authorization'), null);
      return png();
    }
    assert.equal(url.origin, 'https://tokenhub.tencentmaas.com');
    assert.equal(headers.get('authorization'), 'Bearer mock-key');
    if (url.pathname === '/v1/models') {
      assert.equal(method, 'GET');
      return json({ data: [
        { id: model, status: 'online' },
        { id: variant, name: 'Hy Preview', status: 'online' },
        { id: model + '-disabled', status: 'offline' },
        { id: 'wand-vega-image-pro', status: 'online' }, { id: 'hy4', status: 'online' }
      ] });
    }
    assert.equal(method, 'POST');
    assert.equal(url.pathname, '/v1/wand/hunyuan-image/v35-generation');
    submissions.push(JSON.parse(body));
    return json({
      choices: [{ delta: { type: 'image', image: { url: cdn } }, finish_reason: null }],
      assembled_history: [{ content: [{ image_url: { url: 'https://images.example.test/intermediate.png' } }] }]
    });
  });

  assert.equal(preset.supportsModels, true);
  assert.equal(detectProtocolStart(preset, variant).answer.protocol, adapter.id);
  const found = await route('models', { ...preset, presetId: preset.id, key: 'mock-key' });
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.models, [model, variant]);
  assert.equal(found.data.names[variant], 'Hy Preview');

  const fitted = fitSize(provider, '8192x8192', variant, adapter);
  assert.equal(fitted.size, '4096x4096');
  const image = { buffer: Buffer.from(PNG, 'base64'), contentType: 'image/png' };
  await configure(route, provider);
  const exec = { agent: { session: { header: { cwd: home } } } };
  await tools.get('mo_image_settings').execute({}, exec);
  const generated = await tools.get('mo_image_generate').execute({ prompt: input.prompt }, exec);
  assert.equal(path.dirname(generated.path), path.join(home, 'generated-images'));
  assert.deepEqual(readFileSync(generated.path), image.buffer);
  const edited = await callImageApi('edit', adapter, provider, { ...input, model: variant, fitted, images: [image] });
  assert.deepEqual(edited.bytes, image.buffer);

  const text = { type: 'text', text: input.prompt };
  assert.deepEqual(submissions, [
    { model, messages: [{ role: 'user', content: [text] }] },
    { model: variant, size: '4096x4096', messages: [{ role: 'user', content: [text, {
      type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG }
    }] }] }
  ]);
  await assert.rejects(callImageApi('generate', adapter, provider, { ...input, model: 'wand-vega-image-pro' }), /仅支持混元/);
  await assert.rejects(callImageApi('edit', adapter, provider, { ...input, model }), /至少一张参考图/);
  assert.equal(calls.length, 5);
});

test('Gemini keeps the original model ID and sends nested imageConfig only on the native protocol', async (t) => {
  const model = 'regional/gemini-3.1-flash-image-preview:latest';
  const native = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'native-key' };
  const compatible = { baseUrl: 'https://gateway.example/v1', adapter: 'openai-images', key: 'relay-key' };
  const calls = stubFetch(t, ({ url, body, headers }) => {
    const payload = JSON.parse(body);
    if (url.hostname === 'gateway.example') {
      assert.equal(url.pathname, '/v1/images/generations');
      assert.equal(payload.model, model);
      assert.equal(payload.size, '1024x1536');
      assert.equal(Object.hasOwn(payload, 'aspect_ratio'), false);
      assert.equal(Object.hasOwn(payload, 'generationConfig'), false);
      return json({ data: [{ b64_json: PNG }] });
    }
    assert.equal(url.pathname, '/v1beta/models/' + encodeURIComponent(model) + ':generateContent');
    assert.equal(headers.get('x-goog-api-key'), 'native-key');
    assert.deepEqual(payload.generationConfig.imageConfig, { aspectRatio: '2:3', imageSize: '1K' });
    assert.equal(Object.hasOwn(payload, 'aspect_ratio'), false);
    return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] });
  });
  for (const provider of [native, compatible]) {
    const adapter = resolveAdapter(provider, model);
    const fitted = fitSize(provider, '1024x1536', model, adapter);
    const result = await callImageApi('generate', adapter, provider, { ...input, model, fitted });
    assert.equal(result.contentType, 'image/png');
  }
  assert.equal(calls.length, 2);
});

function stubFetch(t, respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = { url: new URL(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body };
    calls.push(request);
    return respond(request);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function mount(home, saved = new Map()) {
  const tools = new Map();
  const routes = new Map();
  process.env.DSH_HOME = home;
  const ctx = {
    effect(fn) { return fn(); },
    inject(_deps, fn) { fn(ctx); },
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined };
      if (name === 'credentials') return this.credentials;
    },
    credentials: {
      async resolve(ref) { return { value: saved.get(ref) }; },
      async describe(ref) { return { configured: saved.has(ref), source: 'file' }; },
      async set(ref, value) {
        if (value === 'refused-by-test-store') throw new Error('write refused');
        saved.set(ref, value);
      },
      async unset(ref) { saved.delete(ref); }
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register(route) { routes.set(route.path, route.handler); return () => {}; }
    }
  };
  apply(ctx, { update: { skipCheck: true } });
  async function route(endpoint, body) {
    const request = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); }
    };
    const response = {
      status: 0,
      writeHead(status) { this.status = status; },
      end(data) { this.data = JSON.parse(data); }
    };
    await routes.get('/api/mo-image/' + endpoint)(request, response);
    return response;
  }
  return { tools, route, saved };
}

function hostFor(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-provider-'));
  const previous = process.env.DSH_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, ...mount(home) };
}

async function configure(route, provider, model = provider.models[0]) {
  const result = await route('config', {
    config: { providers: [provider], active: { providerId: provider.id, model } }
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

test('an unauthenticated draft can save, discover arbitrary model IDs, then generate through a custom operation', async (t) => {
  const { tools, route } = hostFor(t);
  const provider = { ...relay, auth: { mode: 'none' }, customEndpoints: { ...relay.customEndpoints, models: 'legacy-catalog' }, operations: {
    generate: {
      input: 'explicit', path: 'render/{model}', method: 'PUT', transport: 'form',
      body: { output_format: 'webp', response: { mode: 'file' } },
      fields: { prompt: { path: 'caption' } },
      headers: { 'X-Render-Schema': '1' },
      output: { kind: 'json', pick: [{ path: 'assets.0.image', as: 'relative' }] }
    },
    models: { path: 'catalog', method: 'POST', body: { filter: 'image' },
      output: { path: 'catalog', idPath: 'slug', namePath: 'display' } }
  } };
  const calls = stubFetch(t, ({ url, method, headers, body }) => {
    assert.equal(headers.get('Authorization'), null);
    if (url.pathname === '/api/catalog') {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(body), { filter: 'image' });
      return json({ catalog: [{ slug: 'm', display: 'A model' }, { slug: 'm' }] });
    }
    if (url.pathname === '/api/render/m') {
      assert.equal(method, 'PUT');
      assert.equal(headers.get('X-Render-Schema'), '1');
      assert.match(headers.get('content-type'), /^application\/x-www-form-urlencoded/);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), {
        caption: input.prompt, output_format: 'webp', response: '{"mode":"file"}'
      });
      return json({ assets: [{ image: '../result.png' }] });
    }
    if (url.pathname === '/api/result.png') return png();
    assert.fail('unexpected request ' + url.pathname);
  });
  const found = await route('models', provider);
  assert.equal(found.status, 200);
  assert.deepEqual(found.data.models, ['m']);
  assert.deepEqual(found.data.names, { m: 'A model' });
  const saved = await configure(route, provider);
  assert.deepEqual(saved.outputPresets, outputPresetManifest());
  assert.equal(saved.config.providers[0].operations.version, 1);
  const result = await tools.get('mo_image_generate').execute({ prompt: input.prompt }, { callId: 'form-generate' });
  assert.ok(existsSync(result.path));
  assert.deepEqual(calls.map(({ method }) => method), ['POST', 'PUT', 'GET']);
});

test('validation errors preserve the saved provider and never reach upstream', async (t) => {
  const { route } = hostFor(t);
  await configure(route, { ...relay, optionalKey: true });
  const calls = stubFetch(t, () => assert.fail('invalid configuration must be rejected first'));
  const bad = await route('config', { config: { providers: [{
    ...relay, operations: { edit: { method: 'GET', transport: 'multipart' } }
  }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'provider.invalidOperations');
  const auth = await route('models', { ...relay, auth: { mode: 'query', name: 'invalid name' } });
  assert.equal(auth.status, 400);
  assert.equal(auth.data.code, 'provider.invalidAuth');
  assert.equal((await route('config')).data.config.providers[0].optionalKey, true);
  assert.equal(calls.length, 0);
});

test('a failed credential update rolls back earlier updates in the same settings save', async (t) => {
  const { route, saved } = hostFor(t);
  const original = await configure(route, { ...relay, key: 'original-test-credential' });
  const first = original.config.providers[0];
  const result = await route('config', {
    config: {
      providers: [{ ...first, key: 'new-test-credential' }, {
        ...relay, id: 'second', key: 'refused-by-test-store'
      }]
    }
  });
  assert.equal(result.data.code, 'config.credentialSaveFailed');
  assert.equal(saved.get(first.apiKeyEnv), 'original-test-credential');
  assert.deepEqual((await route('config')).data.config.providers.map(({ id }) => id), ['relay']);
});

test('model-level auto inherits a built-in provider override while provider-level auto keeps the protocol default', async (t) => {
  const raw = {
    id: 'a1111', adapter: 'a1111', baseUrl: 'http://127.0.0.1:7860', optionalKey: true, models: ['m'],
    operations: {
      generate: { output: { kind: 'json', pick: [{ path: 'result.pixels', as: 'base64' }] } }
    },
    modelOptions: { m: { operations: { generate: { output: 'auto' } } } }
  };
  const provider = normalizeConfig({ providers: [raw] }).providers[0];
  assert.equal(provider.modelOptions.m?.operations?.generate, undefined);
  const protocolDefault = { ...raw, operations: { generate: { output: 'auto' } } };
  const restored = normalizeConfig({ providers: [protocolDefault] }).providers[0];
  assert.equal(restored.operations.generate.output, 'auto');
  let useNativeFormat = false;
  const calls = stubFetch(t, ({ url }) => {
    assert.equal(url.pathname, '/sdapi/v1/txt2img');
    return json(useNativeFormat ? { images: [PNG] } : { result: { pixels: PNG } });
  });
  for (const candidate of [raw, provider]) {
    const result = await callImageApi('generate', resolveAdapter(candidate, 'm'), candidate, input);
    assert.equal(result.bytes.toString('base64'), PNG);
  }
  useNativeFormat = true;
  const result = await callImageApi('generate', resolveAdapter(restored, 'm'), restored, input);
  assert.equal(result.bytes.toString('base64'), PNG);
  assert.equal(calls.length, 3);
});

test('custom model operations inherit the provider output on auto while explicit model overrides still work', async (t) => {
  const provider = normalizeConfig({ providers: [{
    ...relay, key: 'dummy', models: ['m', 'n'],
    operations: {
      generate: {
        input: 'explicit',
        fields: { prompt: { path: 'text' } },
        output: { kind: 'json', pick: [{ path: 'result.pixels', as: 'base64' }] }
      }
    },
    modelOptions: {
      m: { operations: { generate: { path: 'local-json', output: 'auto' } } },
      n: { operations: { generate: { path: 'local-image', output: 'binary' } } }
    }
  }] }).providers[0];
  assert.deepEqual(provider.modelOptions.m.operations.generate, { path: 'local-json' });
  const calls = stubFetch(t, ({ url, body }) => {
    assert.deepEqual(JSON.parse(body), { text: input.prompt });
    return url.pathname === '/api/local-image' ? png() : json({ result: { pixels: PNG } });
  });
  for (const model of ['m', 'n']) {
    const result = await callImageApi('generate', resolveAdapter(provider, model), provider, { ...input, model });
    assert.equal(result.bytes.toString('base64'), PNG);
  }
  assert.deepEqual(calls.map(({ url }) => url.pathname), ['/api/local-json', '/api/local-image']);
});

test('an ordinary POST is never repeated on 503 or when the optional field was not sent', async (t) => {
  const provider = { ...relay, key: 'dummy', adapter: 'openai-images' };
  const adapter = resolveAdapter(provider, 'm');
  let status = 503;
  const calls = stubFetch(t, () => json({ error: { message: 'unsupported parameter unused', param: 'unused' } }, status));
  await assert.rejects(callImageApi('generate', adapter, provider, input), { code: 'submission_unknown', submissionState: 'unknown' });
  assert.equal(calls.length, 1);
  status = 400;
  await assert.rejects(callImageApi('generate', adapter, provider, input), { code: 'duplicate_request' });
  assert.equal(calls.length, 2);
});

test('a relative task Location survives interruption, restart, and concurrent resumes without another submission', async (t) => {
  const { home, route, tools } = hostFor(t);
  let failPoll = true;
  const calls = stubFetch(t, ({ method, url }) => {
    if (method === 'POST' && url.pathname === '/api/render') {
      return new Response(null, { status: 202, headers: { Location: 'status/42' } });
    }
    if (url.pathname === '/api/status/42') return failPoll ? json({}, 401) : json({ state: 'FINISHED', output: '../result.png' });
    if (url.pathname === '/api/result.png') return png();
    assert.fail('unexpected request ' + method + ' ' + url.pathname);
  });
  await configure(route, { ...relay, auth: { mode: 'none' }, operations: { generate: {
    output: { kind: 'task', pollUrlFrom: 'location', statusPath: 'state', success: ['FINISHED'],
      resultPath: 'output', resultAs: 'relative', intervalMs: 250 }
  } } });
  const generate = tools.get('mo_image_generate');
  let jobId;
  const exec = { callId: 'gateway-task' };
  const capture = (error) => {
    assert.equal(error.code, 'auth');
    assert.equal(error.phase, 'poll');
    assert.equal(error.resumable, true);
    assert.match(error.jobId, /^[a-f0-9-]{36}$/);
    assert.match(error.message, new RegExp('resume_job_id=' + error.jobId));
    jobId = error.jobId;
    return true;
  };
  await assert.rejects(generate.execute({ prompt: input.prompt }, exec), capture);
  await assert.rejects(generate.execute({ prompt: input.prompt }, exec), capture);
  assert.equal(calls.length, 2, 'same tool identity reuses the accepted failure');
  failPoll = false;
  const afterRestart = mount(home).tools.get('mo_image_generate');
  const [first, second] = await Promise.all([
    afterRestart.execute({ resume_job_id: jobId }, {}), afterRestart.execute({ resume_job_id: jobId }, {})
  ]);
  assert.equal(first.jobId, jobId);
  assert.equal(first.path, second.path);
  assert.ok(existsSync(first.path));
  assert.deepEqual(calls.map(({ method, url }) => method + ' ' + url.pathname), [
    'POST /api/render', 'GET /api/status/42', 'GET /api/status/42', 'GET /api/result.png'
  ]);
});

test('a redirected image download recomputes authentication and a failed URL is fetched once', async (t) => {
  const provider = { ...relay, key: 'dummy-credential', auth: { mode: 'query', name: 'api_key' } };
  const calls = stubFetch(t, ({ url, method }) => {
    if (method === 'POST') return json({ data: [{ url: 'https://relay.invalid/api/out.png' }] });
    if (url.host === 'relay.invalid') {
      assert.equal(url.searchParams.get('api_key'), provider.key);
      return new Response(null, { status: 302, headers: { Location: 'https://cdn.invalid/out.png?sig=mock' } });
    }
    assert.equal(url.searchParams.get('api_key'), null);
    assert.equal(url.searchParams.get('sig'), 'mock');
    return new Response(null, { status: 404 });
  });
  await assert.rejects(callImageApi('generate', resolveAdapter(provider, 'm'), provider, input), { phase: 'download', status: 404 });
  assert.deepEqual(calls.map(({ url }) => url.host), ['relay.invalid', 'relay.invalid', 'cdn.invalid']);
});

test('static presets use the custom draft auth consistently across model lookup and submission', async (t) => {
  const { route } = hostFor(t);
  const provider = { ...relay, name: 'Gemini relay', adapter: 'google-gemini', baseUrl: 'https://relay.invalid/v1',
    key: 'dummy-credential', models: ['gemini-mock-image'] };
  const calls = stubFetch(t, ({ url, headers, method }) => {
    assert.equal(headers.get('X-Relay-Key'), provider.key);
    assert.equal(headers.get('x-goog-api-key'), null);
    if (method === 'POST') return json({ candidates: [{ content: { parts: [{ inlineData: { data: PNG } }] } }] });
    assert.equal(url.pathname, '/v1/models');
    return json({ models: [{ name: 'models/gemini-mock-image' }] });
  });
  assert.equal((await route('detect-protocol', { ...provider, probe: '/models', expectedProtocol: provider.adapter })).status, 200);
  assert.deepEqual((await route('models', provider)).data.models, ['gemini-mock-image']);
  await callImageApi('generate', resolveAdapter(provider, provider.models[0]), provider, { ...input, model: provider.models[0] });
  assert.equal(calls.length, 3);
});

test('a local ComfyUI preset shares metadata and authenticates draft analysis, saved analysis, and execution', async (t) => {
  const { tools, route } = hostFor(t);
  const provider = { ...relay, id: 'local', baseUrl: 'http://127.0.0.1:8810/comfy', adapter: 'comfyui',
    auth: { mode: 'custom', header: 'X-Relay-Key' }, key: 'dummy-credential', models: ['flux2-local.safetensors'] };
  const calls = stubFetch(t, ({ url, headers, method, body }) => {
    assert.equal(headers.get('X-Relay-Key'), provider.key);
    if (url.pathname.startsWith('/comfy/object_info/')) return json({}, 404);
    if (url.pathname === '/comfy/object_info') return json({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['local.safetensors']] } } },
      UNETLoader: { input: { required: { unet_name: [provider.models] } } },
      CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['flux2-vae.safetensors']] } } },
      SaveImage: { output_node: true }
    });
    if (url.pathname === '/comfy/prompt' && method === 'POST') {
      assert.equal(JSON.parse(body).prompt['1'].inputs.unet_name, provider.models[0]);
      return json({ prompt_id: 'comfy-task' });
    }
    if (url.pathname === '/comfy/history/comfy-task') {
      return json({ 'comfy-task': { outputs: { '7': { images: [{ filename: 'image.png' }] } } } });
    }
    if (url.pathname === '/comfy/view') return png();
    assert.fail('unexpected local request ' + url.pathname);
  });
  const found = await route('models', provider);
  const fullReads = () => calls.filter(({ url }) => url.pathname === '/comfy/object_info').length;
  assert.deepEqual(found.data.models, ['local.safetensors', provider.models[0]]);
  assert.equal(fullReads(), 1);
  const workflow = JSON.stringify({ 1: { class_type: 'SaveImage', inputs: { filename_prefix: 'test' } } });
  const params = await route('comfy/params', { workflow });
  assert.equal(params.data.ok, true);
  assert.equal(params.data.params[0].input, 'filename_prefix');
  const draftAnalysis = await route('comfy/analyze', { ...provider, workflow });
  assert.equal(draftAnalysis.data.ok, true, JSON.stringify(draftAnalysis.data));
  await configure(route, provider);
  const savedAnalysis = await route('comfy/analyze', { providerId: provider.id, workflow });
  assert.deepEqual(savedAnalysis.data, draftAnalysis.data);
  assert.equal(fullReads(), 1);
  const result = await tools.get('mo_image_generate').execute({ prompt: input.prompt }, {});
  assert.ok(existsSync(result.path));
  assert.ok(result.jobId);
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 1);
  assert.equal(fullReads(), 2, 'one fresh fallback covers all asset lookups during generation');
});

test('the advanced descriptor rejects unknown fields and version changes before use', () => {
  assert.throws(() => normalizeOperations({ version: 2 }), /版本/);
  assert.throws(() => normalizeOperations({ generate: { output: { kind: 'json', headers: {}, pick: [] } } }), /凭据/);
  assert.throws(() => normalizeOperations({
    generate: { fields: { prompt: { path: 'segments[999999999].text' } } }
  }), /索引/);
});

test('a native preset can reuse its request with a different return format', async (t) => {
  const provider = normalizeConfig({ providers: [{
    ...relay, adapter: 'google-gemini', key: 'dummy-credential',
    operations: { generate: { output: 'image-base64' } }
  }] }).providers[0];
  const calls = stubFetch(t, ({ url, headers, body }) => {
    assert.equal(url.pathname, '/api/models/m:generateContent');
    assert.equal(headers.get('x-relay-key'), provider.key);
    assert.equal(JSON.parse(body).contents[0].parts.at(-1).text, input.prompt);
    return json({ image: PNG });
  });
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, input);
  assert.equal(result.bytes.toString('base64'), PNG);
  assert.equal(calls.length, 1);
});

test('a completed task can return a binary image from its polling endpoint', async (t) => {
  const provider = {
    ...relay, auth: { mode: 'none' }, operations: { generate: {
      output: { kind: 'task', pollUrlFrom: 'location', pollOutput: 'binary', intervalMs: 250 }
    } }
  };
  const calls = stubFetch(t, ({ method, url }) => {
    if (method === 'POST') return new Response(null, { status: 202, headers: { Location: 'status/1' } });
    assert.equal(url.pathname, '/api/status/1');
    return png();
  });
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, input);
  assert.equal(result.bytes.toString('base64'), PNG);
  assert.deepEqual(calls.map(({ method }) => method), ['POST', 'GET']);
});

test('an explicit multipart edit sends mapped text, typed JSON and multiple reference files', async (t) => {
  const provider = normalizeConfig({ providers: [{
    ...relay, optionalKey: true, operations: { edit: {
      transport: 'multipart', input: 'explicit', output: 'binary',
      fields: { prompt: { multipart: 'caption' }, negative: { appendToPrompt: ' Avoid ' }, image: { multipart: 'files[]' } }
    } },
    modelOptions: { m: { params: [
      { name: 'metadata', type: 'json', default: { style: ['ink', 'paper'] } },
      { name: 'mode', type: 'enum', options: ['fast', 'quality'], expose: true }
    ] } }
  }] }).providers[0];
  const image = { buffer: Buffer.from(PNG, 'base64'), contentType: 'image/png', filename: 'image.png' };
  const adapter = resolveAdapter(provider, 'm');
  const calls = stubFetch(t, ({ body }) => {
    assert.equal(body.get('caption'), input.prompt + ' Avoid noise');
    assert.equal(body.get('model'), null);
    assert.equal(body.get('mode'), 'quality');
    assert.deepEqual(JSON.parse(body.get('metadata')), { style: ['ink', 'paper'] });
    assert.equal(body.getAll('files[]').length, 2);
    return png();
  });
  const editInput = { ...input, images: [image, image], negativePrompt: 'noise' };
  await assert.rejects(callImageApi('edit', adapter, provider, { ...editInput, params: { mode: 'other' } }), /参数 mode/);
  assert.equal(calls.length, 0);
  await callImageApi('edit', adapter, provider, { ...editInput, params: { mode: 'quality' } });
  assert.equal(calls.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-guard-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'p-active', name: 'Active', baseUrl: 'https://active.test/v1',
        apiKeyEnv: 'MO_IMAGE_P_ACTIVE_API_KEY', protocol: 'openai-images', adapter: '',
        models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], names: {}
      },
      {
        id: 'p-other', name: 'Other', baseUrl: 'https://other.test/v1',
        apiKeyEnv: 'MO_IMAGE_P_OTHER_API_KEY', protocol: 'openai-images', adapter: '',
        models: ['some-other-model'], names: {}
      }
    ],
    active: { providerId: 'p-active', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');
  return home;
}

function fakeContext(tools) {
  const credentials = {
    async resolve() { return { value: 'sk-test-key', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; },
    async set() {},
    async unset() {}
  };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

test('generation ignores provider/model arguments and sticks to the active selection', async (t) => {
  const home = makeHome();
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?tool-guard-test');
  mod.apply(fakeContext(tools));
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  assert.ok(generate);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await generate.execute({
    prompt: 'a red apple',
    provider: 'p-other',
    model: 'some-other-model'
  }, { signal: new AbortController().signal, agent: { session: { header: { cwd: home } } } });

  assert.ok(result.path);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://active.test/v1'), 'must stay on the selected provider');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-image-2.5-flare');
});

test('editing uses the selected model and never falls back to another one', async (t) => {
  const home = makeHome();
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?tool-guard-edit');
  mod.apply(fakeContext(tools));
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');
  assert.ok(edit);

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await edit.execute({
    prompt: '只把背景换成浅灰色',
    images: [reference]
  }, { signal: new AbortController().signal, agent: { session: { header: { cwd: home } } } });

  const form = captured.init.body;
  assert.equal(typeof form.get, 'function', 'gpt-image edits should be multipart');
  assert.equal(form.get('model'), 'gpt-image-2.5-flare', 'must not switch to the sunburst edit model');
});

test('a model without image editing reports that it does not support it', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-noedit-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p-ideogram', name: 'Ideogram', baseUrl: 'https://api.ideogram.ai',
      apiKeyEnv: 'MO_IMAGE_P_IDEOGRAM_API_KEY', protocol: 'openai-images', adapter: 'ideogram',
      models: ['ideogram-3'], names: {}
    }],
    active: { providerId: 'p-ideogram', model: 'ideogram-3' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }), 'utf8');
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?tool-guard-noedit');
  mod.apply(fakeContext(tools));
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');

  await assert.rejects(
    edit.execute({ prompt: '换成灰色背景', images: [reference] },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: home } } } }),
    /该模型不支持图生图/
  );
});

test('an upstream model-capability error is reported as "does not support" instead of a retry', async (t) => {
  const home = makeHome();
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?tool-guard-upstream');
  mod.apply(fakeContext(tools));
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      error: { message: 'model gpt-image-2.5-flare does not support image edits', type: 'invalid_request_error' }
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    edit.execute({ prompt: '换成灰色背景', images: [reference] },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: home } } } }),
    /该模型不支持图生图/
  );
  assert.equal(calls, 1, 'must fail fast instead of retrying other field names');
});

test('the tool surface documents the no-judgement and no-switching rules', async (t) => {
  const home = makeHome();
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?tool-guard-desc');
  mod.apply(fakeContext(tools));
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');

  for (const tool of [generate, edit]) {
    assert.match(tool.description, /never judge/i);
    assert.match(tool.description, /never switch/i);
  }
});

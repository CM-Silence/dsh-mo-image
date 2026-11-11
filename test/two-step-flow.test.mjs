import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function config(overrides = {}) {
  return Object.assign({
    version: 1,
    providers: [
      {
        id: 'p1', name: 'Local', baseUrl: 'https://api.test/v1',
        apiKeyEnv: 'MO_IMAGE_P1_API_KEY', optionalKey: true, protocol: 'openai-images',
        adapter: '',
        models: ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors'],
        names: {}
      }
    ],
    active: { providerId: 'p1', model: 'flux-2-klein-4b.safetensors' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  }, overrides);
}

function makeHome(cfg) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-two-step-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify(cfg), 'utf8');
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
    tools: { register(def) { tools.push(def); return () => {}; }, guard() { return () => {}; } },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

/** 一个稳定的会话：读取配置的那次调用和随后的生图必须落在同一个 session 上。 */
async function harness(t, cfg = config()) {
  const home = makeHome(cfg);
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?two-step-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: os.tmpdir() } } }
  };
  const tool = (name) => tools.find((item) => item.name === name);
  return {
    home, calls, exec, tool,
    settings: tool('mo_image_settings'),
    generate: tool('mo_image_generate'),
    edit: tool('mo_image_edit')
  };
}

test('the settings tool returns a minimal json with the model and a one-line hint', async (t) => {
  const { settings, exec } = await harness(t);
  assert.ok(settings, 'mo_image_settings must be registered');
  assert.equal(settings.parameters.required, undefined, 'the settings tool takes no arguments');

  const result = await settings.execute({}, exec);
  assert.deepEqual(Object.keys(result).sort(), ['hint', 'model', 'promptOptimization', 'provider']);
  assert.equal(result.provider, 'p1', 'the provider is reported by id only');
  assert.equal(result.model, 'flux-2-klein-4b.safetensors');
  assert.equal(result.promptOptimization, true);
  assert.match(result.hint, /30–80 词/, 'the FLUX word budget must be in the hint');
  assert.match(result.hint, /完整写法没读过/, 'the hint says to load the full rules only once');
  assert.match(result.hint, /读过就不用再加载/, 'and that a second read is wasted');
});

test('prompt optimization off only says to use the user wording', async (t) => {
  const cfg = config();
  cfg.defaults.promptOptimization = false;
  const { settings, exec } = await harness(t, cfg);

  const result = await settings.execute({}, exec);
  assert.equal(result.promptOptimization, false);
  assert.match(result.hint, /用户原话/);
  assert.doesNotMatch(result.hint, /30–80 词/, 'no dialect coaching while optimization is off');
  assert.doesNotMatch(result.hint, /skill/, 'nothing to read while optimization is off');
});

test('auto mode lists the model ids to pick from', async (t) => {
  const cfg = config();
  cfg.active = { providerId: 'p1', model: 'auto' };
  const { settings, exec } = await harness(t, cfg);

  const result = await settings.execute({}, exec);
  assert.equal(result.model, 'auto');
  assert.deepEqual(result.models, ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors']);
});

test('generating without reading the settings first is refused before any request', async (t) => {
  const { generate, calls, exec } = await harness(t);

  await assert.rejects(
    generate.execute({ prompt: 'a city at dusk' }, exec),
    /mo_image_settings/
  );
  assert.equal(calls.length, 0);
});

test('generating after reading the settings uses the picked model', async (t) => {
  const { settings, generate, calls, exec } = await harness(t);

  await settings.execute({}, exec);
  await generate.execute({ prompt: 'a city at dusk' }, exec);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).model, 'flux-2-klein-4b.safetensors');
});

test('editing is gated the same way as generating', async (t) => {
  const { settings, edit, calls, exec, home } = await harness(t);
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));

  await assert.rejects(
    edit.execute({ prompt: '改成夜景', images: [reference] }, exec),
    /mo_image_settings/
  );
  assert.equal(calls.length, 0);

  await settings.execute({}, exec);
  await edit.execute({ prompt: '改成夜景', images: [reference] }, exec);
  assert.equal(calls.length, 1);
});

test('switching the model after reading invalidates that read', async (t) => {
  const { settings, generate, exec, home } = await harness(t);
  await settings.execute({}, exec);

  // 用户在选择器里换了模型：上一次读到的配置已经不作数。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = config();
  next.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');

  await assert.rejects(
    generate.execute({ prompt: 'a classroom' }, exec),
    /mo_image_settings/
  );

  await settings.execute({}, exec);
  await generate.execute({ prompt: 'a classroom' }, exec);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeHome(config) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-models-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  if (config) writeFileSync(path.join(state, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return home;
}

function fakeContext(tools) {
  const credentials = {
    async resolve() { return { value: 'sk-secret', source: 'file' }; },
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

const CONFIG = {
  version: 1,
  providers: [
    {
      id: 'p-local', name: 'Local ComfyUI', baseUrl: 'http://127.0.0.1:8188',
      apiKeyEnv: 'MO_IMAGE_P_LOCAL_API_KEY', optionalKey: true, protocol: 'openai-images',
      adapter: 'comfyui',
      models: ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors'],
      names: { 'flux-2-klein-4b.safetensors': 'FLUX.2 Klein 4B' }
    },
    {
      id: 'p-cloud', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'MO_IMAGE_P_CLOUD_API_KEY', protocol: 'openai-images', adapter: '',
      models: ['gpt-image-2.5-flare'], names: {}
    }
  ],
  active: { providerId: 'p-local', model: 'flux-2-klein-4b.safetensors' },
  defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
};

async function loadTool(home, suffix) {
  process.env.DSH_HOME = home;
  const tools = [];
  const mod = await import(`../lib/index.js?model-list-${suffix}`);
  mod.apply(fakeContext(tools));
  return tools.find((tool) => tool.name === 'mo_image_list_models') || null;
}

test('the plugin exposes a tool that lists the configured image models', async (t) => {
  const home = makeHome(CONFIG);
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tool = await loadTool(home, 'main');
  assert.ok(tool, 'mo_image_list_models should be registered');
  assert.equal(tool.parameters.required, undefined, 'the tool takes no required arguments');

  const result = await tool.execute({}, { signal: new AbortController().signal });

  assert.equal(result.active.providerId, 'p-local');
  assert.equal(result.active.providerName, 'Local ComfyUI');
  assert.equal(result.active.model, 'flux-2-klein-4b.safetensors');
  assert.equal(result.active.modelName, 'FLUX.2 Klein 4B');
  assert.equal(result.auto, false);

  assert.equal(result.providers.length, 2);
  const local = result.providers.find((item) => item.id === 'p-local');
  assert.deepEqual(local.models.map((model) => model.id), [
    'flux-2-klein-4b.safetensors',
    'moss_image_sft_int8_convrot.safetensors'
  ]);
  assert.equal(local.models[0].name, 'FLUX.2 Klein 4B');
  assert.equal(local.models[1].name, '', 'models without a display name keep it empty');
  assert.equal(local.adapter, 'comfyui');
  assert.equal(local.local, true);
  assert.equal(local.active, true);

  const cloud = result.providers.find((item) => item.id === 'p-cloud');
  assert.equal(cloud.active, false);
  assert.equal(cloud.local, false);
});

test('the model list tool never exposes credentials or raw config fields', async (t) => {
  const home = makeHome(CONFIG);
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tool = await loadTool(home, 'secret');
  const result = await tool.execute({}, { signal: new AbortController().signal });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /sk-secret/, 'no resolved key may leak');
  assert.doesNotMatch(text, /apiKeyEnv/, 'internal credential references stay internal');
  assert.doesNotMatch(text, /MO_IMAGE_P_/, 'credential ref names stay internal');
});

test('the model list tool reports an empty setup without throwing', async (t) => {
  const home = makeHome(null);
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tool = await loadTool(home, 'empty');
  const result = await tool.execute({}, { signal: new AbortController().signal });
  assert.deepEqual(result.providers, []);
  assert.equal(result.active.providerId, '');
  assert.equal(result.active.model, '');
});

test('the tool description points at itself instead of the guarded config file', async (t) => {
  const home = makeHome(CONFIG);
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tool = await loadTool(home, 'desc');
  assert.match(tool.description, /list|模型/i);
  assert.doesNotMatch(tool.description, /config\.json/, 'do not send the model to the guarded file');
});

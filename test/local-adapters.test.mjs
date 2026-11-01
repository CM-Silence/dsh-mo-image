import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, adapterManifest, localPresetManifest } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('adapter and local preset manifests are the single client-facing capability source', () => {
  const adapters = adapterManifest();
  const presets = localPresetManifest();
  assert.ok(adapters.some((adapter) => adapter.id === 'openai-images' && adapter.supportsModels));
  assert.ok(adapters.some((adapter) => adapter.id === 'a1111' && adapter.supportsModels));
  assert.ok(adapters.some((adapter) => adapter.id === 'comfyui' && adapter.supportsModels));
  assert.ok(adapters.some((adapter) => adapter.id === 'swarmui' && adapter.supportsModels));
  assert.deepEqual(new Set(presets.map((preset) => preset.id)).size, presets.length);
  assert.ok(presets.every((preset) => adapters.some((adapter) => adapter.id === preset.adapter)));
  assert.ok(presets.every((preset) => typeof preset.urlHint === 'string' && preset.urlHint.length > 0));
});

test('A1111 adapter lists checkpoints and sends txt2img/img2img bodies', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/sdapi/v1/sd-models')) {
      return jsonResponse([{ title: 'sdxl-base.safetensors' }, { model_name: 'flux-dev.safetensors' }]);
    }
    return jsonResponse({ images: [PNG_1PX] });
  };
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111', optionalKey: true }, '');
  assert.equal(adapter.id, 'a1111');
  const models = await adapter.listModels({ baseUrl: 'http://127.0.0.1:7860', optionalKey: true }, new AbortController().signal);
  assert.deepEqual(models, ['sdxl-base.safetensors', 'flux-dev.safetensors']);

  const provider = { baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111', optionalKey: true };
  const generated = await adapter.execute('generate', provider, {
    model: 'sdxl-base.safetensors', prompt: 'a cat', negativePrompt: 'blur',
    fitted: { width: 512, height: 640, size: '512x640' }
  }, new AbortController().signal);
  assert.ok(generated.bytes.length > 0);
  const first = calls.find((call) => call.url.endsWith('/sdapi/v1/txt2img'));
  assert.ok(first);
  const body = JSON.parse(first.init.body);
  assert.equal(body.width, 512);
  assert.equal(body.height, 640);
  assert.deepEqual(body.override_settings, { sd_model_checkpoint: 'sdxl-base.safetensors' });
  assert.equal(body.negative_prompt, 'blur');
  assert.equal(first.init.headers.Authorization, undefined);

  const edited = await adapter.execute('edit', provider, {
    model: 'sdxl-base.safetensors', prompt: 'make it blue', negativePrompt: '',
    fitted: { omit: true, size: 'none' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png' }]
  }, new AbortController().signal);
  assert.ok(edited.bytes.length > 0);
  const editCall = calls.find((call) => call.url.endsWith('/sdapi/v1/img2img'));
  assert.ok(editCall);
  const editBody = JSON.parse(editCall.init.body);
  assert.equal(editBody.width, 1);
  assert.equal(editBody.height, 1);
  assert.equal(Array.isArray(editBody.init_images), true);
});

test('ComfyUI adapter lists CheckpointLoaderSimple checkpoints', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => jsonResponse({
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors', 'sdxl.safetensors']] } } }
  });
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true }, '');
  assert.equal(adapter.id, 'comfyui');
  const models = await adapter.listModels({ baseUrl: 'http://127.0.0.1:8188', optionalKey: true }, new AbortController().signal);
  assert.deepEqual(models, ['sd15.safetensors', 'sdxl.safetensors']);
});

test('ComfyUI adapter polls history and downloads the generated image', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/prompt')) {
      submitted = JSON.parse(init.body);
      return jsonResponse({ prompt_id: 'prompt-1' });
    }
    if (target.endsWith('/history/prompt-1')) {
      return jsonResponse({ 'prompt-1': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    if (target.includes('/view?')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'unexpected ' + target }, 404);
  };
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true }, '');
  const generated = await adapter.execute('generate', { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true }, {
    model: 'sdxl.safetensors', prompt: 'a cat', negativePrompt: 'blur',
    fitted: { width: 512, height: 512, size: '512x512' }
  }, new AbortController().signal);
  assert.ok(generated.bytes.length > 0);
  assert.equal(submitted.prompt['1'].inputs.ckpt_name, 'sdxl.safetensors');
  assert.equal(submitted.prompt['2'].inputs.text, 'a cat');
  assert.equal(submitted.prompt['4'].inputs.width, 512);
});

test('ComfyUI falls back to full object_info when node-specific lookup is unavailable', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/object_info/CheckpointLoaderSimple')) return jsonResponse({ error: 'not found' }, 404);
    return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['fallback.safetensors']] } } } });
  };
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true }, '');
  const models = await adapter.listModels({ baseUrl: 'http://127.0.0.1:8188', optionalKey: true }, new AbortController().signal);
  assert.deepEqual(models, ['fallback.safetensors']);
  assert.equal(calls.length, 2);
});

test('SwarmUI adapter creates a session, lists models, and downloads the result', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ target, init });
    if (target.endsWith('/API/GetNewSession')) return jsonResponse({ session_id: 'session-1' });
    if (target.endsWith('/API/ListModels')) return jsonResponse({ files: [{ name: 'OfficialStableDiffusion/sdxl' }] });
    if (target.endsWith('/API/GenerateText2Image')) return jsonResponse({ images: ['View/local/raw/out.png'] });
    if (target.endsWith('/View/local/raw/out.png')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'unexpected ' + target }, 404);
  };
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:7801', adapter: 'swarmui', optionalKey: true }, '');
  assert.equal(adapter.id, 'swarmui');
  const provider = { baseUrl: 'http://127.0.0.1:7801', adapter: 'swarmui', optionalKey: true };
  const models = await adapter.listModels(provider, new AbortController().signal);
  assert.deepEqual(models, ['OfficialStableDiffusion/sdxl']);
  const generated = await adapter.execute('generate', provider, {
    model: 'OfficialStableDiffusion/sdxl', prompt: 'a cat', negativePrompt: '',
    fitted: { width: 512, height: 512, size: '512x512' }
  }, new AbortController().signal);
  assert.ok(generated.bytes.length > 0);
  const generation = calls.find((call) => call.target.endsWith('/API/GenerateText2Image'));
  const body = JSON.parse(generation.init.body);
  assert.equal(body.session_id, 'session-1');
  assert.equal(body.model, 'OfficialStableDiffusion/sdxl');
  assert.equal(body.width, 512);
});


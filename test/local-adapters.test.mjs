import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, adapterManifest, localPresetManifest, adapterSupportsKind } from '../lib/adapters.js';

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
    if (String(url).endsWith('/object_info/UNETLoader')) return jsonResponse({ error: 'not found' }, 404);
    return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['fallback.safetensors']] } } } });
  };
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true }, '');
  const models = await adapter.listModels({ baseUrl: 'http://127.0.0.1:8188', optionalKey: true }, new AbortController().signal);
  assert.ok(models.includes('fallback.safetensors'));
  assert.ok(calls.length >= 2);
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

test('ComfyUI lists checkpoints and diffusion models together', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/object_info/CheckpointLoaderSimple')) {
      return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } } });
    }
    if (target.endsWith('/object_info/UNETLoader')) {
      return jsonResponse({ UNETLoader: { input: { required: { unet_name: [['flux-2-klein-4b.safetensors']] } } } });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true }, '');
  const models = await adapter.listModels({ baseUrl: 'http://127.0.0.1:8188', optionalKey: true }, new AbortController().signal);
  assert.deepEqual(models, ['sdxl.safetensors', 'flux-2-klein-4b.safetensors']);
});

function comfyObjectInfoMock() {
  const table = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['flux-2-klein-4b.safetensors']] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors']], type: [['flux2']] } } },
    VAELoader: { input: { required: { vae_name: [['flux2-vae.safetensors']] } } }
  };
  return (node) => (table[node] ? jsonResponse({ [node]: table[node] }) : jsonResponse({ error: 'not found' }, 404));
}

function comfyFetch(handler) {
  return async (url, init) => {
    const target = String(url);
    const node = /\/object_info\/([^/?]+)/.exec(target);
    if (node) return handler(node[1]);
    if (target.includes('/object_info')) return jsonResponse({ error: 'not found' }, 404);
    if (target.endsWith('/prompt')) return handler('prompt', init);
    if (target.includes('/history/')) return handler('history');
    if (target.includes('/upload/image')) return handler('upload', init);
    if (target.includes('/view?')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'unexpected ' + target }, 404);
  };
}

test('ComfyUI generates with a FLUX.2 diffusion model using the FLUX workflow', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const objectInfo = comfyObjectInfoMock();
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'p-flux' }); }
    if (kind === 'history') {
      return jsonResponse({ 'p-flux': { outputs: { '13': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return objectInfo(kind);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  const generated = await adapter.execute('generate', provider, {
    model: 'flux-2-klein-4b.safetensors', prompt: 'a cat', negativePrompt: '',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.ok(generated.bytes.length > 0);
  const workflow = submitted.prompt;
  assert.equal(workflow['1'].class_type, 'UNETLoader');
  assert.equal(workflow['1'].inputs.unet_name, 'flux-2-klein-4b.safetensors');
  assert.equal(workflow['2'].class_type, 'CLIPLoader');
  assert.equal(workflow['2'].inputs.clip_name, 'qwen_3_4b.safetensors');
  assert.equal(workflow['2'].inputs.type, 'flux2');
  assert.equal(workflow['3'].inputs.vae_name, 'flux2-vae.safetensors');
  assert.equal(workflow['9'].class_type, 'Flux2Scheduler');
  assert.equal(workflow['9'].inputs.steps, 4);
  assert.equal(workflow['10'].inputs.cfg, 1);
  assert.equal(workflow['11'].class_type, 'SamplerCustomAdvanced');
});

test('ComfyUI edits a FLUX.2 image by uploading the reference and using ReferenceLatent', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const objectInfo = comfyObjectInfoMock();
  let submitted = null;
  let uploaded = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'upload') { uploaded = init.body; return jsonResponse({ name: 'ref.png', subfolder: 'dsh', type: 'input' }); }
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'p-edit' }); }
    if (kind === 'history') {
      return jsonResponse({ 'p-edit': { outputs: { '13': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return objectInfo(kind);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  const edited = await adapter.execute('edit', provider, {
    model: 'flux-2-klein-4b.safetensors', prompt: 'make it blue', negativePrompt: '',
    fitted: { width: 1024, height: 1024, size: '1024x1024' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'in.png' }]
  }, new AbortController().signal);
  assert.ok(edited.bytes.length > 0);
  assert.ok(uploaded);
  const workflow = submitted.prompt;
  const loadImage = Object.values(workflow).find((node) => node.class_type === 'LoadImage');
  assert.equal(loadImage.inputs.image, 'dsh/ref.png');
  const reference = Object.values(workflow).filter((node) => node.class_type === 'ReferenceLatent');
  assert.equal(reference.length, 2);
  const guider = Object.values(workflow).find((node) => node.class_type === 'CFGGuider');
  assert.equal(workflow[guider.inputs.positive[0]].class_type, 'ReferenceLatent');
});

test('ComfyUI edits a checkpoint model through VAEEncode img2img', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const objectInfo = comfyObjectInfoMock();
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'upload') return jsonResponse({ name: 'ref.png', subfolder: '', type: 'input' });
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'p-sd' }); }
    if (kind === 'history') {
      return jsonResponse({ 'p-sd': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return objectInfo(kind);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  await adapter.execute('edit', provider, {
    model: 'sdxl.safetensors', prompt: 'make it blue', negativePrompt: '',
    fitted: { width: 512, height: 512, size: '512x512' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'in.png' }]
  }, new AbortController().signal);
  const workflow = submitted.prompt;
  assert.ok(Object.values(workflow).some((node) => node.class_type === 'VAEEncode'));
  const sampler = Object.values(workflow).find((node) => node.class_type === 'KSampler');
  assert.equal(sampler.inputs.denoise, 0.6);
});

test('ComfyUI generates with a MOSS model using the MOSS workflow', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const table = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['moss_image_sft_int8_convrot.safetensors']] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors', 'qwen3.5_9b_w4a8_gptq.safetensors']], type: [['flux2', 'moss_image']] } } },
    VAELoader: { input: { required: { vae_name: [['flux2-vae.safetensors', 'flux2-vae_small.safetensors']] } } }
  };
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'p-moss' }); }
    if (kind === 'history') {
      return jsonResponse({ 'p-moss': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return table[kind] ? jsonResponse({ [kind]: table[kind] }) : jsonResponse({ error: 'not found' }, 404);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  const generated = await adapter.execute('generate', provider, {
    model: 'moss_image_sft_int8_convrot.safetensors', prompt: 'a poster that says "OPEN"', negativePrompt: '',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.ok(generated.bytes.length > 0);
  const workflow = submitted.prompt;
  assert.equal(workflow['1'].class_type, 'UNETLoader');
  assert.equal(workflow['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors');
  assert.equal(workflow['2'].class_type, 'CLIPLoader');
  assert.equal(workflow['2'].inputs.clip_name, 'qwen3.5_9b_w4a8_gptq.safetensors');
  assert.equal(workflow['2'].inputs.type, 'moss_image');
  assert.equal(workflow['3'].inputs.vae_name, 'flux2-vae_small.safetensors');
  const sampler = workflow['7'];
  assert.equal(sampler.class_type, 'KSampler');
  assert.equal(sampler.inputs.steps, 25);
  assert.equal(sampler.inputs.cfg, 2.5);
  assert.equal(sampler.inputs.sampler_name, 'er_sde');
});

test('ComfyUI edits a MOSS image with the edit LoRA and MOSS edit encoders', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const table = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['moss_image_sft_int8_convrot.safetensors']] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen3.5_9b_w4a8_gptq.safetensors']], type: [['moss_image']] } } },
    VAELoader: { input: { required: { vae_name: [['flux2-vae_small.safetensors']] } } },
    LoraLoaderModelOnly: { input: { required: { lora_name: [['moss_image_edit_lora_rank_64_bf16.safetensors']] } } },
    TextEncodeMOSSImageEdit: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], edit_format: [['ai-toolkit', 'Moss-Image-Edit']], images: ['COMFY_AUTOGROW_V3'], image_strength: ['FLOAT'] } } }
  };
  let submitted = null;
  let uploaded = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'upload') { uploaded = init.body; return jsonResponse({ name: 'ref.png', subfolder: '', type: 'input' }); }
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'p-moss-edit' }); }
    if (kind === 'history') {
      return jsonResponse({ 'p-moss-edit': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return table[kind] ? jsonResponse({ [kind]: table[kind] }) : jsonResponse({ error: 'not found' }, 404);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  const edited = await adapter.execute('edit', provider, {
    model: 'moss_image_sft_int8_convrot.safetensors', prompt: 'change the background to a starry night sky',
    negativePrompt: '',
    fitted: { width: 1024, height: 1024, size: '1024x1024' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'in.png' }]
  }, new AbortController().signal);
  assert.ok(edited.bytes.length > 0);
  assert.ok(uploaded);
  const workflow = submitted.prompt;
  const nodes = Object.values(workflow);

  const lora = nodes.find((node) => node.class_type === 'LoraLoaderModelOnly');
  assert.ok(lora, 'edit LoRA must be applied');
  assert.equal(lora.inputs.lora_name, 'moss_image_edit_lora_rank_64_bf16.safetensors');
  assert.equal(workflow[lora.inputs.model[0]].class_type, 'UNETLoader');

  const encoders = nodes.filter((node) => node.class_type === 'TextEncodeMOSSImageEdit');
  assert.equal(encoders.length, 2, 'positive and negative encoders');
  assert.ok(encoders.every((node) => node.inputs.edit_format === 'Moss-Image-Edit'));
  assert.ok(encoders.every((node) => Array.isArray(node.inputs['images.image_0'])));

  const positive = encoders.find((node) => node.inputs.prompt.includes('starry'));
  assert.ok(positive, 'positive encoder carries the instruction');
  const sampler = nodes.find((node) => node.class_type === 'KSampler');
  assert.equal(sampler.inputs.steps, 30);
  assert.equal(sampler.inputs.cfg, 4);
  assert.equal(sampler.inputs.denoise, 1);
  assert.equal(sampler.inputs.positive[0], Object.keys(workflow).find((id) => workflow[id] === positive));

  const loadImage = nodes.find((node) => node.class_type === 'LoadImage');
  assert.ok(loadImage, 'reference image is loaded');
});

test('ComfyUI MOSS edit reports a clear error when the edit LoRA is missing', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const table = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['moss_image_sft_int8_convrot.safetensors']] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen3.5_9b_w4a8_gptq.safetensors']], type: [['moss_image']] } } },
    VAELoader: { input: { required: { vae_name: [['flux2-vae_small.safetensors']] } } },
    LoraLoaderModelOnly: { input: { required: { lora_name: [[]] } } },
    TextEncodeMOSSImageEdit: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], edit_format: [['Moss-Image-Edit']], images: ['COMFY_AUTOGROW_V3'], image_strength: ['FLOAT'] } } }
  };
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'upload') return jsonResponse({ name: 'ref.png', subfolder: '', type: 'input' });
    return table[kind] ? jsonResponse({ [kind]: table[kind] }) : jsonResponse({ error: 'not found' }, 404);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  await assert.rejects(
    () => adapter.execute('edit', provider, {
      model: 'moss_image_sft_int8_convrot.safetensors', prompt: 'make it blue',
      fitted: { width: 512, height: 512, size: '512x512' },
      images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'in.png' }]
    }, new AbortController().signal),
    /编辑 LoRA/i
  );
});

test('ComfyUI picks the FLUX encoder and VAE even when MOSS assets are installed', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const table = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors']] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen3.5_9b_w4a8_gptq.safetensors', 'qwen_3_4b.safetensors']], type: [['flux2', 'moss_image']] } } },
    VAELoader: { input: { required: { vae_name: [['flux2-vae.safetensors', 'flux2-vae_small.safetensors', 'pixel_space']] } } }
  };
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'p-flux2' }); }
    if (kind === 'history') {
      return jsonResponse({ 'p-flux2': { outputs: { '13': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return table[kind] ? jsonResponse({ [kind]: table[kind] }) : jsonResponse({ error: 'not found' }, 404);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  await adapter.execute('generate', provider, {
    model: 'flux-2-klein-4b.safetensors', prompt: 'a cat', negativePrompt: '',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  const workflow = submitted.prompt;
  assert.equal(workflow['2'].inputs.clip_name, 'qwen_3_4b.safetensors', 'FLUX must not reuse the MOSS text encoder');
  assert.equal(workflow['3'].inputs.vae_name, 'flux2-vae.safetensors', 'FLUX must not reuse the MOSS small VAE');
});

test('ComfyUI surfaces the execution error instead of claiming no image', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const objectInfo = comfyObjectInfoMock();
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') return jsonResponse({ prompt_id: 'p-err' });
    if (kind === 'history') {
      return jsonResponse({
        'p-err': {
          status: {
            status_str: 'error',
            messages: [['execution_error', { node_type: 'SamplerCustomAdvanced', exception_message: 'mat1 and mat2 shapes cannot be multiplied' }]]
          },
          outputs: {}
        }
      });
    }
    return objectInfo(kind);
  });
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  await assert.rejects(
    () => adapter.execute('generate', provider, {
      model: 'sdxl.safetensors', prompt: 'a cat', negativePrompt: '',
      fitted: { width: 512, height: 512, size: '512x512' }
    }, new AbortController().signal),
    /shapes cannot be multiplied/
  );
});

test('LocalAI preset declares generation only and never posts to a missing edit route', () => {
  const preset = localPresetManifest().find((item) => item.id === 'localai');
  assert.equal(preset.adapter, 'localai');
  const adapter = resolveAdapter({ baseUrl: 'http://127.0.0.1:8080/v1', adapter: 'localai', optionalKey: true }, '');
  assert.equal(adapter.id, 'localai');
  assert.equal(adapterSupportsKind(adapter, 'generate'), true);
  assert.equal(adapterSupportsKind(adapter, 'edit'), false);
  assert.ok(adapterManifest().some((item) => item.id === 'localai' && item.supportsModels));
});


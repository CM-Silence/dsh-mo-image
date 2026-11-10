import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, applyWorkflowTemplate, COMFY_WORKFLOW_PLACEHOLDERS } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/* ------------------------------------------------------------ template engine */

test('applyWorkflowTemplate replaces placeholders in nested strings', () => {
  const template = {
    '1': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', text: 'photo of {{prompt}}' } },
    '2': { inputs: { width: '{{width}}', height: '{{height}}', model: '{{model}}' } }
  };
  const out = applyWorkflowTemplate(template, {
    seed: 12345, steps: 20, prompt: 'a cat', width: 1024, height: 768, model: 'sdxl.safetensors'
  });
  assert.equal(out['1'].inputs.seed, 12345);
  assert.equal(out['1'].inputs.steps, 20);
  assert.equal(out['1'].inputs.text, 'photo of a cat');
  assert.equal(out['2'].inputs.width, 1024);
  assert.equal(out['2'].inputs.height, 768);
  assert.equal(out['2'].inputs.model, 'sdxl.safetensors');
});

test('applyWorkflowTemplate keeps numeric types when the value is the whole string', () => {
  const out = applyWorkflowTemplate({ a: '{{seed}}' }, { seed: 42 });
  assert.equal(out.a, 42);
  assert.equal(typeof out.a, 'number');
});

test('applyWorkflowTemplate leaves the source template untouched', () => {
  const template = { a: '{{prompt}}' };
  applyWorkflowTemplate(template, { prompt: 'x' });
  assert.equal(template.a, '{{prompt}}');
});

test('applyWorkflowTemplate throws a helpful error for unknown placeholders', () => {
  assert.throws(() => applyWorkflowTemplate({ a: '{{nope}}' }, { prompt: 'x' }), /nope/);
});

test('applyWorkflowTemplate replaces unknown placeholders only when told to', () => {
  const out = applyWorkflowTemplate({ a: '{{nope}}' }, { prompt: 'x' }, { lenient: true });
  assert.equal(out.a, '');
});

test('placeholder list documents the supported names', () => {
  for (const key of ['prompt', 'negative_prompt', 'width', 'height', 'seed', 'model', 'image']) {
    assert.ok(COMFY_WORKFLOW_PLACEHOLDERS.includes(key), key + ' should be documented');
  }
});

/* ------------------------------------------------------------ custom workflow */

function comfyFetch(handler) {
  return async (url, init) => {
    const target = String(url);
    if (target.includes('/upload/image')) return handler('upload', init);
    if (target.endsWith('/prompt')) return handler('prompt', init);
    if (target.includes('/history/')) return handler('history');
    if (target.includes('/view?')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
}

const CUSTOM_T2I = JSON.stringify({
  '4': { class_type: 'UNETLoader', inputs: { unet_name: '{{model}}', weight_dtype: 'default' } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['7', 0] } },
  '6': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  '8': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 12, model: ['4', 0], positive: ['5', 0], latent_image: ['6', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'custom', images: ['8', 0] } }
});

test('comfyui uses the per-model custom workflow when one is configured', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'cw-1' }); }
    if (kind === 'history') {
      return jsonResponse({ 'cw-1': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  });
  const provider = {
    baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
    modelOptions: { 'my-model.safetensors': { workflow: CUSTOM_T2I } }
  };
  const adapter = resolveAdapter(provider, '');
  const out = await adapter.execute('generate', provider, {
    model: 'my-model.safetensors', prompt: 'a lighthouse', negativePrompt: '',
    fitted: { width: 832, height: 1216, size: '832x1216' }
  }, new AbortController().signal);
  assert.ok(out.bytes.length > 0);
  const workflow = submitted.prompt;
  assert.equal(workflow['4'].inputs.unet_name, 'my-model.safetensors');
  assert.equal(workflow['5'].inputs.text, 'a lighthouse');
  assert.equal(workflow['6'].inputs.width, 832);
  assert.equal(workflow['6'].inputs.height, 1216);
  assert.equal(workflow['8'].inputs.steps, 12);
  assert.equal(typeof workflow['8'].inputs.seed, 'number');
});

test('comfyui custom workflow uploads the reference and fills {{image}} on edit', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const editTemplate = JSON.stringify({
    '4': { class_type: 'UNETLoader', inputs: { unet_name: '{{model}}' } },
    '5': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } }
  });
  let submitted = null;
  let uploaded = false;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'upload') { uploaded = true; return jsonResponse({ name: 'ref.png', subfolder: 'sub', type: 'input' }); }
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'cw-2' }); }
    if (kind === 'history') {
      return jsonResponse({ 'cw-2': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  });
  const provider = {
    baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
    modelOptions: { 'my-model.safetensors': { workflow: editTemplate } }
  };
  const adapter = resolveAdapter(provider, '');
  await adapter.execute('edit', provider, {
    model: 'my-model.safetensors', prompt: 'make it night',
    fitted: { width: 512, height: 512, size: '512x512' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'in.png' }]
  }, new AbortController().signal);
  assert.ok(uploaded, 'reference image must be uploaded');
  assert.equal(submitted.prompt['5'].inputs.image, 'sub/ref.png');
  assert.equal(submitted.prompt['6'].inputs.text, 'make it night');
});

test('comfyui custom workflow without {{image}} rejects an edit with a clear message', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = comfyFetch(() => jsonResponse({ error: 'should not be called' }, 500));
  const provider = {
    baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
    modelOptions: { 'my-model.safetensors': { workflow: CUSTOM_T2I } }
  };
  const adapter = resolveAdapter(provider, '');
  await assert.rejects(
    () => adapter.execute('edit', provider, {
      model: 'my-model.safetensors', prompt: 'change it',
      fitted: { width: 512, height: 512, size: '512x512' },
      images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'in.png' }]
    }, new AbortController().signal),
    /\{\{image\}\}/
  );
});

test('comfyui rejects a custom workflow that is not valid JSON', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = comfyFetch(() => jsonResponse({ error: 'should not be called' }, 500));
  const provider = {
    baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
    modelOptions: { 'bad.safetensors': { workflow: '{ not json ' } }
  };
  const adapter = resolveAdapter(provider, '');
  await assert.rejects(
    () => adapter.execute('generate', provider, {
      model: 'bad.safetensors', prompt: 'x',
      fitted: { width: 512, height: 512, size: '512x512' }
    }, new AbortController().signal),
    /JSON/
  );
});

test('comfyui falls back to the builtin workflow when the model has no options', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/object_info/CheckpointLoaderSimple')) {
      return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } } });
    }
    if (target.includes('/object_info/UNETLoader')) return jsonResponse({ error: 'not found' }, 404);
    if (target.includes('/object_info')) return jsonResponse({ error: 'not found' }, 404);
    if (target.endsWith('/prompt')) { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'bi-1' }); }
    if (target.includes('/history/')) {
      return jsonResponse({ 'bi-1': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    if (target.includes('/view?')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'unexpected ' + target }, 404);
  };
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  const adapter = resolveAdapter(provider, '');
  await adapter.execute('generate', provider, {
    model: 'sdxl.safetensors', prompt: 'a cat',
    fitted: { width: 512, height: 512, size: '512x512' }
  }, new AbortController().signal);
  assert.equal(submitted.prompt['1'].class_type, 'CheckpointLoaderSimple');
});

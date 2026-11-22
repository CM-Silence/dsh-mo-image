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
    modelOptions: { 'my-model.safetensors': { workflow: CUSTOM_T2I, params: [
      { name: 'checkpointAlias', node: '4', input: 'unet_name', type: 'text', expose: true },
      { name: 'widthAlias', node: '6', input: 'width', type: 'number', expose: true },
      { name: 'steps', node: '8', input: 'steps', type: 'number', expose: false }
    ] } }
  };
  const adapter = resolveAdapter(provider, '');
  const out = await adapter.execute('generate', provider, {
    model: 'my-model.safetensors', prompt: 'a lighthouse', negativePrompt: '',
    fitted: { width: 832, height: 1216, size: '832x1216' },
    params: { checkpointAlias: 'other.safetensors', widthAlias: 2048, steps: 30 }
  }, new AbortController().signal);
  assert.ok(out.bytes.length > 0);
  const workflow = submitted.prompt;
  assert.equal(workflow['4'].inputs.unet_name, 'my-model.safetensors');
  assert.equal(workflow['5'].inputs.text, 'a lighthouse');
  assert.equal(workflow['6'].inputs.width, 832);
  assert.equal(workflow['6'].inputs.height, 1216);
  assert.equal(workflow['8'].inputs.steps, 12);
  assert.equal(typeof workflow['8'].inputs.seed, 'number');
  assert.match(out.note, /checkpointAlias、widthAlias、steps/);
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
  globalThis.fetch = () => assert.fail('an unsupported workflow must not upload or submit');
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

test('ComfyUI binds a connected reference without a saved mapping or placeholder', async (t) => {
  const model = 'workflow';
  const workflow = JSON.stringify({
    '1': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    '2': { class_type: 'ImageEditor', inputs: { image: ['1', 0], prompt: '' } },
    '3': { class_type: 'PreviewImage', inputs: { images: ['2', 0] } }
  });
  const provider = { adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188', modelOptions: { [model]: { workflow } } };
  const calls = [];
  stubComfy(t, comfyFetch((kind, init) => {
    calls.push(kind);
    if (kind === 'upload') return jsonResponse({ name: 'ref.png', subfolder: 'images' });
    if (kind === 'prompt') {
      const graph = JSON.parse(init.body).prompt;
      assert.equal(graph['1'].inputs.image, 'images/ref.png');
      assert.equal(graph['2'].inputs.prompt, 'apply the edit');
      return jsonResponse({ prompt_id: 'auto-ref' });
    }
    return jsonResponse({ 'auto-ref': { outputs: { '3': { images: [{ filename: 'preview.png', type: 'temp' }] } } } });
  }));
  const result = await resolveAdapter(provider, model).execute('edit', provider, {
    model, prompt: 'apply the edit',
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png' }]
  });
  assert.ok(result.bytes.length);
  assert.deepEqual(calls, ['upload', 'prompt', 'history']);
});

test('numbered reference inputs reuse a slot and bind independently of node order', async (t) => {
  const model = 'workflow';
  const graph = {
    '1': { class_type: 'LoadImage', inputs: { image: '{{image_2}}' }, _meta: { title: 'Style' } },
    '2': { class_type: 'LoadImage', inputs: { image: '{{image_1}}' }, _meta: { title: 'Subject' } },
    '3': { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
    '4': { class_type: 'LoadImage', inputs: { image: 'static-overlay.png' } },
    '5': { class_type: 'ImageEditor', inputs: { subject: ['2', 0], style: ['1', 0], original: ['3', 0], overlay: ['4', 0], prompt: '' } },
    '6': { class_type: 'PreviewImage', inputs: { images: ['5', 0] } }
  };
  const provider = {
    adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    modelOptions: { [model]: { workflow: JSON.stringify(graph) } }
  };
  const adapter = resolveAdapter(provider, model);
  const calls = [];
  let uploads = 0;
  stubComfy(t, comfyFetch((kind, init) => {
    calls.push(kind);
    if (kind === 'upload') return jsonResponse({ name: 'uploaded-' + ++uploads + '.png' });
    if (kind === 'prompt') {
      const submitted = JSON.parse(init.body).prompt;
      assert.deepEqual(['1', '2', '3', '4'].map((id) => submitted[id].inputs.image),
        ['uploaded-2.png', 'uploaded-1.png', 'uploaded-1.png', 'static-overlay.png']);
      return jsonResponse({ prompt_id: 'numbered-ref' });
    }
    return jsonResponse({ 'numbered-ref': { outputs: { '6': { images: [{ filename: 'result.png' }] } } } });
  }));
  const image = { buffer: Buffer.from(PNG_1PX, 'base64'), filename: 'same.png', contentType: 'image/png' };
  const edit = (images) => adapter.execute('edit', provider, { model, prompt: 'apply the edit', images });
  await assert.rejects(() => edit([image]), /需要 2 张参考图/);
  assert.deepEqual(calls, []);
  await edit([image, image]);
  assert.deepEqual(calls, ['upload', 'upload', 'prompt', 'history']);
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

test('a params.prompt cannot override the prompt argument', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'pp-1' }); }
    if (kind === 'history') {
      return jsonResponse({ 'pp-1': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  });
  const provider = {
    baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
    modelOptions: {
      'm.safetensors': Object.assign({}, MAPPED_OPTIONS, {
        params: [
          { name: 'prompt', role: true, node: '5', input: 'text', type: 'STRING' },
          { name: 'sizeAlias', node: '6', input: 'width', type: 'INT', expose: true },
          { name: 'steps', node: '8', input: 'steps', type: 'INT', expose: true }
        ]
      })
    }
  };
  const result = await adapter0(provider).execute('generate', provider, {
    model: 'm.safetensors', prompt: 'a lighthouse', negativePrompt: '', fitted: { width: 832, height: 1216, size: '832x1216' },
    params: { prompt: 'hijacked', sizeAlias: 2048, steps: 30 }
  }, new AbortController().signal);
  assert.equal(submitted.prompt['5'].inputs.text, 'a lighthouse', 'the prompt argument wins');
  assert.equal(submitted.prompt['8'].inputs.steps, 30, 'a real tunable still applies');
  assert.equal(submitted.prompt['6'].inputs.width, 832);
  assert.match(String(result.note), /prompt/, 'the ignored key is reported back');
  assert.match(String(result.note), /sizeAlias/);
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

/* ------------------------------------------------ 尺寸：自动就别碰工作流 */

const MAPPED_T2I = JSON.stringify({
  '4': { class_type: 'UNETLoader', inputs: { unet_name: 'm.safetensors' } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt', clip: ['4', 1] } },
  '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: 640, height: 960, batch_size: 1 } },
  '8': { class_type: 'KSampler', inputs: { seed: 1, steps: 12, model: ['4', 0], positive: ['5', 0], latent_image: ['6', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mapped', images: ['8', 0] } }
});

const MAPPED_OPTIONS = {
  workflow: MAPPED_T2I,
  mapping: {
    prompt: { node: '5', input: 'text' },
    negative_prompt: null,
    width: { node: '6', input: 'width' },
    height: { node: '6', input: 'height' },
    seed: { node: '8', input: 'seed' },
    model: null,
    image: null
  }
};

function submitMapped(t, fitted, options = MAPPED_OPTIONS) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = comfyFetch((kind, init) => {
    if (kind === 'prompt') { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'sz-1' }); }
    if (kind === 'history') {
      return jsonResponse({ 'sz-1': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  });
  const provider = {
    baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
    modelOptions: { 'm.safetensors': options }
  };
  return adapter0(provider).execute('generate', provider, {
    model: 'm.safetensors', prompt: 'a lighthouse', negativePrompt: '', fitted
  }, new AbortController().signal).then(() => submitted);
}

const adapter0 = (provider) => resolveAdapter(provider, '');

test('an auto size leaves the mapped workflow resolution untouched', async (t) => {
  const submitted = await submitMapped(t, { omit: true, size: 'none' });
  assert.equal(submitted.prompt['6'].inputs.width, 640, 'the workflow own resolution must survive');
  assert.equal(submitted.prompt['6'].inputs.height, 960);
});

test('a size the chat model asked for is written into the mapped inputs', async (t) => {
  const submitted = await submitMapped(t, { width: 832, height: 1216, size: '832x1216' });
  assert.equal(submitted.prompt['6'].inputs.width, 832);
  assert.equal(submitted.prompt['6'].inputs.height, 1216);
});

const MIXED_OPTIONS = { ...MAPPED_OPTIONS, workflow: MAPPED_T2I.replace('"width":640', '"width":"{{width}}"') };

test('a requested size fills both a placeholder and its complementary mapping', async (t) => {
  const submitted = await submitMapped(t, { width: 832, height: 1216, size: '832x1216' }, MIXED_OPTIONS);
  assert.equal(submitted.prompt['6'].inputs.width, 832);
  assert.equal(submitted.prompt['6'].inputs.height, 1216);
});

test('auto size supplies a default placeholder value and preserves the existing mapped dimension', async (t) => {
  const submitted = await submitMapped(t, { omit: true, size: 'none' }, MIXED_OPTIONS);
  assert.equal(submitted.prompt['6'].inputs.width, 1024);
  assert.equal(submitted.prompt['6'].inputs.height, 960);
});

test('a builtin workflow still needs concrete numbers when the size is auto', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/object_info/CheckpointLoaderSimple')) {
      return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } } });
    }
    if (target.includes('/object_info')) return jsonResponse({ error: 'not found' }, 404);
    if (target.endsWith('/prompt')) { submitted = JSON.parse(init.body); return jsonResponse({ prompt_id: 'bi-2' }); }
    if (target.includes('/history/')) {
      return jsonResponse({ 'bi-2': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } });
    }
    if (target.includes('/view?')) {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse({ error: 'unexpected ' + target }, 404);
  };
  const provider = { baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true };
  await resolveAdapter(provider, '').execute('generate', provider, {
    model: 'sdxl.safetensors', prompt: 'a cat', fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);
  const latent = Object.values(submitted.prompt).find((node) => node.class_type === 'EmptyLatentImage');
  assert.ok(latent, 'the builtin graph needs a latent node');
  assert.equal(latent.inputs.width, 1024);
  assert.equal(latent.inputs.height, 1024);
});

/* ------------------------------------------------ analyzeComfyWorkflow */

import { analyzeComfyWorkflow } from '../lib/adapters.js';
import { analyzeWorkflow, listWorkflowInputs } from '../lib/comfy-workflow.js';
import { normalizeModelOptions, resolveSizeRequest, resolveToolQuality } from '../lib/config-store.js';
import { fitSize, qualityOptionsFor } from '../lib/adapters.js';
import { readFileSync } from 'node:fs';

const sampleObjectInfo = () => JSON.parse(readFileSync('test/fixtures/object-info.sample.json', 'utf8'));
const sdUiJson = () => JSON.stringify(JSON.parse(readFileSync('test/fixtures/sd-t2i.ui.json', 'utf8')));

function stubComfy(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

test('analyzeComfyWorkflow converts a UI workflow and returns a mapping', async (t) => {
  stubComfy(t, async (url) => (String(url).includes('/object_info')
    ? jsonResponse(sampleObjectInfo())
    : jsonResponse({}, 404)));
  const result = await analyzeComfyWorkflow({ base: 'http://127.0.0.1:8188', provider: {}, workflow: sdUiJson() });
  assert.equal(result.format, 'ui');
  assert.deepEqual(result.mapping.prompt, { node: '6', input: 'text' });
  assert.equal(result.mapping.width.node, '5');
  assert.equal(result.mapping.seed.node, '3');
});

test('analyzeComfyWorkflow refuses a UI workflow whose node classes are missing', async (t) => {
  stubComfy(t, async (url) => (String(url).includes('/object_info')
    ? jsonResponse(sampleObjectInfo())
    : jsonResponse({}, 404)));
  const ui = JSON.stringify({ nodes: [{ id: 1, type: 'MysteryNode', widgets_values: [] }], links: [] });
  await assert.rejects(
    () => analyzeComfyWorkflow({ base: 'http://127.0.0.1:8189', provider: {}, workflow: ui }),
    /没有安装/
  );
});

test('analyzeComfyWorkflow reports an unreachable object_info', async (t) => {
  stubComfy(t, async () => jsonResponse({}, 503));
  await assert.rejects(
    () => analyzeComfyWorkflow({ base: 'http://127.0.0.1:9999', provider: {}, workflow: sdUiJson() }),
    /object_info|节点签名/
  );
});

test('ComfyUI maps the prompt, size and quality directly from the model selector', async (t) => {
  const graph = {
    '1': { class_type: 'ImageGenerator', inputs: { prompt: '', width: 640, height: 960, image_quality: 'Low' } },
    '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], quality: 95 } }
  };
  const info = {
    ImageGenerator: { input: { required: { image_quality: [['Low', 'Very High', 'Auto']] } } },
    SaveImage: { output_node: true, input: { optional: { quality: ['INT'] } } }
  };
  const analysis = analyzeWorkflow(graph, info);
  assert.deepEqual(analysis.mapping.prompt, { node: '1', input: 'prompt' });
  assert.deepEqual(analysis.mapping.quality, { node: '1', input: 'image_quality' });
  assert.deepEqual(analysis.warnings, []);
  assert.deepEqual(analysis.params, []);
  for (const schema of [info, undefined]) {
    assert.deepEqual(listWorkflowInputs(graph, schema).map(({ node, input }) => [node, input]), [['2', 'quality']]);
  }
  const model = 'workflow';
  const provider = {
    adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    modelOptions: normalizeModelOptions({
      [model]: {
        workflow: JSON.stringify(graph), mapping: analysis.mapping, quality: analysis.quality,
        params: [{ name: 'qualityAlias', node: '1', input: 'image_quality', type: 'text', expose: true }]
      }
    }, [model], 'comfyui')
  };
  const adapter = resolveAdapter(provider, model);
  const quality = qualityOptionsFor(provider, model, adapter);
  assert.equal(quality.default, 'low');
  assert.deepEqual(quality.options.map((option) => option.value), ['off', 'low', 'very-high']);

  const submitted = [];
  stubComfy(t, comfyFetch((kind, init) => {
    if (kind === 'prompt') {
      submitted.push(JSON.parse(init.body).prompt);
      return jsonResponse({ prompt_id: 'selector-test-' + submitted.length });
    }
    const id = 'selector-test-' + submitted.length;
    return jsonResponse({ [id]: { outputs: { '2': { images: [{ filename: 'selector.png' }] } } } });
  }));
  const generate = async (defaults, args) => {
    const requested = resolveSizeRequest(provider, model, defaults, args, adapter);
    await adapter.execute('generate', provider, {
      model, prompt: 'user prompt',
      fitted: fitSize(provider, { kind: requested.control, text: requested.arg }, model, adapter),
      quality: resolveToolQuality(provider, model, defaults, args, adapter),
      params: { qualityAlias: 'bad', width: 2048, prompt: 'bad' }
    });
  };
  await generate({ auto: false, width: 768, height: 1024, quality: 'low' }, { size: '832x1216', quality: 'very-high' });
  await generate({ auto: true, quality: 'auto' }, { size: '832x1216', quality: 'very-high' });
  await generate({ auto: true, quality: 'auto' }, {});
  assert.deepEqual(submitted.map((workflow) => workflow['1'].inputs), [
    { prompt: 'user prompt', width: 768, height: 1024, image_quality: 'Low' },
    { prompt: 'user prompt', width: 832, height: 1216, image_quality: 'Very High' },
    { prompt: 'user prompt', width: 640, height: 960, image_quality: 'Low' }
  ]);
  assert.ok(submitted.every((workflow) => workflow['2'].inputs.quality === 95));
});

test('ComfyUI rejects a workflow without a prompt input before submitting', async (t) => {
  stubComfy(t, () => assert.fail('must not submit a workflow without a prompt'));
  const model = 'workflow';
  const workflow = JSON.stringify({
    '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'image' }, _meta: { title: '{{prompt}}' } }
  });
  const provider = { adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8188', modelOptions: { [model]: { workflow } } };
  await assert.rejects(
    () => resolveAdapter(provider, model).execute('generate', provider, { model, prompt: 'user prompt' }),
    /找不到可用的提示词输入/
  );
});

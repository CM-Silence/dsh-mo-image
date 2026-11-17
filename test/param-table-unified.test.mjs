/**
 * 一张参数表，两种绑定。
 *
 * 这一轮把 ComfyUI 的工作流参数和 A1111 的 sdapi 参数并进「常规」那张离散参数表：
 *
 *   HTTP 行     { name, type, default, description, expose }            name 是 body 路径
 *   工作流行    { node, input, type, default, description, expose, name? }  node/input 是落点
 *
 * 判据只有形状（有 node/input 就是工作流行），没有新顶层键。这个文件锁住形状、
 * 候选清单、A1111 的迁移结果，以及「有暴露行时不再说参数不支持」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeModelOptions, normalizeConfig, workflowParamsOf, paramNoticeOf } from '../lib/index.js';
import { listWorkflowInputs, applyWorkflowParams } from '../lib/comfy-workflow.js';
import {
  resolveAdapter, listComfyParams, paramDefaultsManifest, adapterTakesParamRows, A1111_PARAMS
} from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/* --------------------------------------------------- 行的形状（两种绑定） */

test('a workflow row keeps its node/input binding and carries default + description', () => {
  const out = normalizeModelOptions({
    m1: {
      workflow: '{}',
      params: [
        { node: '18:7', input: 'steps', type: 'INT', default: 25, description: '采样步数', expose: true },
        { node: '18:5', input: 'text', type: 'STRING', name: 'style_prompt', default: 'anime' }
      ]
    }
  }, ['m1'], 'comfyui');
  const rows = out.m1.params;
  assert.equal(rows[0].node, '18:7');
  assert.equal(rows[0].input, 'steps');
  assert.equal(rows[0].name, 'steps', 'name falls back to input when the row omits it');
  assert.equal(rows[0].type, 'number', 'INT folds into the table vocabulary');
  assert.equal(rows[0].default, '25');
  assert.equal(rows[0].description, '采样步数');
  assert.equal(rows[0].expose, true);
  assert.equal(rows[1].name, 'style_prompt');
  assert.equal(rows[1].type, 'text');
});

test('one table holds both bindings; a cloud adapter keeps only the HTTP rows', () => {
  const params = [
    { name: 'steps', type: 'number', default: '20' },
    { node: '7', input: 'cfg', type: 'FLOAT', default: 3.5 }
  ];
  const comfy = normalizeModelOptions({ m: { params } }, ['m'], 'comfyui');
  assert.equal(comfy.m.params.length, 2, 'both kinds live in the same array');
  assert.equal(comfy.m.params[1].node, '7');
  assert.equal(comfy.m.params[1].type, 'number');
  // 云端没有工作流：整条 provider 走一遍 normalizeConfig，工作流行会被摘掉。
  const config = normalizeConfig({
    providers: [{
      id: 'p', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['m'], modelOptions: { m: { params } }
    }],
    active: { providerId: 'p', model: 'm' }
  });
  assert.deepEqual(config.providers[0].modelOptions.m.params.map((row) => row.name), ['steps'],
    'workflow rows do not belong to a cloud adapter');
});

test('a broken row is dropped on its own instead of taking the whole table down', () => {
  const out = normalizeModelOptions({
    m: {
      params: [
        { node: '1', input: '', type: 'INT' },
        { name: 'steps', type: 'number', default: '20' },
        { node: '2', input: 'cfg', type: 'FLOAT' }
      ]
    }
  }, ['m'], 'comfyui');
  assert.deepEqual(out.m.params.map((row) => row.name), ['steps', 'cfg']);
});

test('an explicit empty name is a broken row, not an alias for the input name', () => {
  const out = normalizeModelOptions({ m: { params: [{ node: '1', input: 'x', name: '' }] } }, ['m'], 'comfyui');
  assert.equal(out.m, undefined);
});

test('a row default is coerced to the same string shape on both bindings', () => {
  const out = normalizeModelOptions({
    m: {
      params: [
        { name: 'steps', type: 'number', default: 20 },
        { node: '3', input: 'denoise', type: 'FLOAT', default: 0.6 },
        { node: '3', input: 'flag', type: 'BOOLEAN', default: false }
      ]
    }
  }, ['m'], 'comfyui');
  assert.equal(out.m.params[0].default, '20');
  assert.equal(out.m.params[1].default, '0.6');
  assert.equal(out.m.params[2].default, 'false');
});

test('一个行的 locked 标记会被保留，false 不落盘（不写 = 未锁）', () => {
  const out = normalizeModelOptions({
    m: {
      params: [
        { name: 'steps', type: 'number', locked: true },
        { node: '7', input: 'seed', type: 'INT', locked: true },
        { node: '7', input: 'cfg', type: 'FLOAT', locked: false }
      ]
    }
  }, ['m'], 'comfyui');
  assert.equal(out.m.params[0].locked, true, 'HTTP 行的行级锁');
  assert.equal(out.m.params[1].locked, true, '工作流行的行级锁');
  assert.equal(out.m.params[2].locked, undefined, 'false 不写进配置');
});

/* ------------------------------------------------------------ 候选清单 */

test('listWorkflowInputs lists literal inputs with an inferred type and skips links', () => {
  const graph = {
    '18:7': { class_type: 'KSampler', inputs: { seed: 1, steps: 25, cfg: 3.5, sampler_name: 'euler', model: ['18:1', 0] } },
    '18:5': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['18:2', 1], strength: true } }
  };
  const list = listWorkflowInputs(graph);
  const keys = list.map((item) => item.node + '.' + item.input);
  assert.ok(keys.includes('18:7.steps'));
  assert.ok(keys.includes('18:5.text'));
  assert.ok(!keys.includes('18:7.model'), 'a link is another node output, not a parameter');
  const steps = list.find((item) => item.input === 'steps');
  assert.equal(steps.type, 'number');
  assert.equal(steps.value, 25);
  assert.equal(steps.name, 'steps');
  assert.equal(list.find((item) => item.input === 'text').type, 'text');
  assert.equal(list.find((item) => item.input === 'strength').type, 'boolean');
  assert.equal(list.find((item) => item.input === 'sampler_name').type, 'text');
});

test('listWorkflowInputs sorts node ids in natural order so the panel reads top-down', () => {
  const graph = {
    '18:10': { class_type: 'A', inputs: { x: 1 } },
    '18:2': { class_type: 'B', inputs: { y: 2 } },
    '9': { class_type: 'C', inputs: { z: 3 } }
  };
  assert.deepEqual(listWorkflowInputs(graph).map((item) => item.node), ['9', '18:2', '18:10']);
});

test('listComfyParams turns an API workflow into candidates without asking the service', async () => {
  const workflow = readFileSync('test/fixtures/moss-t2i.api.json', 'utf8');
  const result = await listComfyParams({ base: '', provider: {}, workflow });
  assert.equal(result.format, 'api');
  assert.equal(result.count, result.params.length);
  assert.ok(result.params.length > 0);
  assert.ok(result.params.some((item) => item.node === '18:7' && item.input === 'steps'));
  assert.ok(result.params.some((item) => item.input === 'value'),
    'the prompt encoder input is a candidate too');
});

test('listComfyParams reports an unreadable workflow instead of returning an empty list', async () => {
  await assert.rejects(
    () => listComfyParams({ base: '', provider: {}, workflow: '{ not json' }),
    /JSON/,
    'broken JSON must surface as a readable error'
  );
  await assert.rejects(
    () => listComfyParams({ base: '', provider: {}, workflow: '{"a":1}' }),
    /ComfyUI/
  );
  await assert.rejects(
    () => listComfyParams({ base: '', provider: {}, workflow: '' }),
    /ComfyUI|JSON/
  );
});

test('a picked candidate becomes a workflow row that survives a save', () => {
  const candidate = { node: '18:7', input: 'steps', name: 'steps', type: 'number', value: 25 };
  const row = {
    name: candidate.name,
    node: candidate.node,
    input: candidate.input,
    type: candidate.type,
    default: String(candidate.value),
    expose: false
  };
  const out = normalizeModelOptions({ m: { workflow: '{}', params: [row] } }, ['m'], 'comfyui');
  assert.deepEqual(out.m.params[0], {
    name: 'steps', node: '18:7', input: 'steps', type: 'number', default: '25', expose: false
  });
});

test('a workflow row default is written into the graph; clearing it leaves the workflow alone', () => {
  const rows = [{ name: 'steps', node: '7', input: 'steps', type: 'number', default: '30' }];
  const applied = applyWorkflowParams({ '7': { class_type: 'KSampler', inputs: { steps: 20 } } }, rows, {});
  assert.equal(applied.graph['7'].inputs.steps, 30, 'the row default is the value we send');
  const cleared = applyWorkflowParams(
    { '7': { class_type: 'KSampler', inputs: { steps: 20 } } },
    [{ ...rows[0], default: '' }],
    {}
  );
  assert.equal(cleared.graph['7'].inputs.steps, 20, 'an empty default means "leave the workflow value"');
  assert.deepEqual(cleared.applied, [], 'defaults are not reported as model overrides');
});

/* ------------------------------------------------- 「暴露行」对对话模型可见 */

test('exposed HTTP rows show up in the prompt-facing parameter list', () => {
  const provider = {
    modelOptions: {
      m: {
        params: [
          { name: 'steps', type: 'number', default: '20', expose: true },
          { name: 'seed', type: 'number', default: '-1' }
        ]
      }
    }
  };
  const out = workflowParamsOf(provider, 'm', { id: 'openai-images' });
  assert.deepEqual(out.map((param) => param.name), ['steps']);
  assert.equal(adapterTakesParamRows({ id: 'openai-images' }), true);
});

test('exposed workflow rows show up for ComfyUI and stay out of a cloud adapter', () => {
  const provider = {
    modelOptions: {
      m: {
        params: [
          { name: 'steps', node: '7', input: 'steps', type: 'number', default: '25', expose: true },
          { name: 'cfg', node: '7', input: 'cfg', type: 'number', default: '3.5' }
        ]
      }
    }
  };
  assert.deepEqual(workflowParamsOf(provider, 'm', { id: 'comfyui' }).map((param) => param.name), ['steps']);
  assert.equal(workflowParamsOf(provider, 'm', { id: 'openai-images' }), undefined);
});

test('an adapter that builds its own body never advertises parameter rows it ignores', () => {
  const provider = {
    modelOptions: { m: { params: [{ name: 'steps', type: 'number', default: '20', expose: true }] } }
  };
  assert.equal(adapterTakesParamRows({ id: 'swarmui', execute() {} }), false);
  assert.equal(workflowParamsOf(provider, 'm', { id: 'swarmui', execute() {} }), undefined);
});

/* -------------------------------------------------------- A1111 的迁移 */

test('the A1111 manifest is a table row list with defaults', () => {
  const manifest = paramDefaultsManifest();
  assert.deepEqual(manifest.a1111.map((row) => row.name),
    ['steps', 'cfg_scale', 'sampler_name', 'scheduler', 'seed', 'denoising_strength']);
  assert.ok(manifest.a1111.every((row) => row.type && typeof row.default === 'string' && row.default !== ''));
  assert.equal(A1111_PARAMS.length, manifest.a1111.length);
});

function a1111Provider(modelOptions) {
  const provider = { baseUrl: 'http://127.0.0.1:7860', adapter: 'a1111', optionalKey: true };
  if (modelOptions) provider.modelOptions = modelOptions;
  return provider;
}

function stubFetch(t) {
  const original = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ images: [PNG_1PX] });
  };
  return calls;
}

const bodyOf = (calls, suffix) => JSON.parse(calls.filter((call) => call.url.endsWith(suffix)).pop().init.body);

test('A1111 sends the migrated rows: defaults, exposed overrides, reserved fields untouched', async (t) => {
  const calls = stubFetch(t);
  const provider = a1111Provider({
    m: {
      params: [
        { name: 'steps', type: 'number', default: '20', expose: true },
        { name: 'cfg_scale', type: 'number', default: '7' },
        { name: 'width', type: 'number', default: '999' },
        { name: 'denoising_strength', type: 'number', default: '0.4' }
      ]
    }
  });
  const adapter = resolveAdapter(provider, '');
  await adapter.execute('generate', provider, {
    model: 'm', prompt: 'a cat', fitted: { width: 512, height: 640, size: '512x640' },
    params: { steps: 30 }
  }, new AbortController().signal);
  const body = bodyOf(calls, '/sdapi/v1/txt2img');
  assert.equal(body.steps, 30, 'an exposed row takes the model value');
  assert.equal(body.cfg_scale, 7, 'a default is sent as a number');
  assert.equal(body.width, 512, 'the picker owns the size, not a row');
  assert.equal(body.height, 640);
  assert.equal(body.denoising_strength, undefined, 'img2img-only rows stay out of txt2img');
  assert.equal(body.prompt, 'a cat');
  assert.deepEqual(body.override_settings, { sd_model_checkpoint: 'm' });

  await adapter.execute('edit', provider, {
    model: 'm', prompt: 'make it blue', fitted: { omit: true, size: 'none' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png' }]
  }, new AbortController().signal);
  const editBody = bodyOf(calls, '/sdapi/v1/img2img');
  assert.equal(editBody.denoising_strength, 0.4, 'img2img gets the row default');
  assert.ok(Array.isArray(editBody.init_images));
});

test('A1111 reports the keys it could not honour', async (t) => {
  const calls = stubFetch(t);
  const provider = a1111Provider({
    m: { params: [{ name: 'steps', type: 'number', default: '20', expose: true }] }
  });
  const adapter = resolveAdapter(provider, '');
  const result = await adapter.execute('generate', provider, {
    model: 'm', prompt: 'a cat', fitted: { omit: true, size: 'none' },
    params: { steps: 30, mystery: 1, cfg_scale: 7 }
  }, new AbortController().signal);
  assert.equal(bodyOf(calls, '/sdapi/v1/txt2img').steps, 30);
  assert.match(String(result.note), /mystery/);
  assert.match(String(result.note), /cfg_scale/, 'an unexposed row is not a silent success');
});

test('an old A1111 config with only the expose map keeps following the WebUI', async (t) => {
  const calls = stubFetch(t);
  const provider = a1111Provider({ m: { expose: { steps: true } } });
  const adapter = resolveAdapter(provider, '');
  await adapter.execute('generate', provider, {
    model: 'm', prompt: 'a cat', fitted: { omit: true, size: 'none' },
    params: { steps: 35 }
  }, new AbortController().signal);
  const body = bodyOf(calls, '/sdapi/v1/txt2img');
  assert.equal(body.steps, 35, 'the switch still lets the model override');
  assert.equal(body.cfg_scale, undefined, 'nothing else is sent before the migration');
  assert.equal(body.sampler_name, undefined);
});

test('an old A1111 config still lists its switched-on parameters to the model', () => {
  const provider = { modelOptions: { 'sd15.safetensors': { expose: { steps: true, seed: false } } } };
  const out = workflowParamsOf(provider, 'sd15.safetensors', { id: 'a1111' });
  assert.deepEqual(out.map((param) => param.name), ['steps']);
  assert.equal(out[0].type, 'number');
});

/* ------------------------------------------------ 工具回复不再误报 */

test('a model with exposed rows is not told that workflow parameters are unsupported', () => {
  const provider = {
    modelOptions: { m: { params: [{ name: 'steps', type: 'number', default: '20', expose: true }] } }
  };
  // 通用路径（自己不放 note 的协议）由这里回报：只说没暴露的键。
  const adapter = { id: 'openai-images' };
  assert.equal(paramNoticeOf(provider, 'm', adapter, ['steps']), '');
  const partial = paramNoticeOf(provider, 'm', adapter, ['steps', 'bogus']);
  assert.match(partial, /没有暴露/);
  assert.doesNotMatch(partial, /不支持工作流参数/);
  const none = paramNoticeOf(provider, 'm', adapter, ['bogus']);
  assert.doesNotMatch(none, /不支持工作流参数/);
  assert.match(none, /bogus/);
});

test('a model without any exposed row says so in its own words, not "unsupported"', () => {
  const bare = { modelOptions: {} };
  const note = paramNoticeOf(bare, 'm', { id: 'openai-images' }, ['steps']);
  assert.match(note, /没有暴露任何可调参数/);
  assert.doesNotMatch(note, /不支持工作流参数/);
});

test('protocols that report ignored keys themselves stay quiet here', () => {
  const provider = {
    modelOptions: { m: { params: [{ name: 'steps', node: '7', input: 'steps', type: 'number', expose: true }] } }
  };
  assert.equal(paramNoticeOf(provider, 'm', { id: 'comfyui' }, ['mystery']), '',
    'ComfyUI reports inside execute()');
  assert.equal(paramNoticeOf(provider, 'm', { id: 'a1111' }, ['mystery']), '',
    'A1111 reports inside execute() too, so the tool note must not repeat it');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { settingsPayload, promptSectionText } from '../lib/prompt-profiles.js';
import { normalizeModelOptions, workflowParamsOf } from '../lib/index.js';
import { collectRoleParams } from '../lib/comfy-workflow.js';

const provider = { id: 'p-comfy', adapter: 'comfyui' };
const PARAMS = [
  { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25 },
  { name: 'sampler_name', node: '18:7', input: 'sampler_name', type: 'enum', default: 'er_sde', options: ['euler', 'er_sde'] }
];

test('settingsPayload lists parameter names and types without defaults', () => {
  const payload = settingsPayload({
    provider, model: 'moss.safetensors', adapter: { id: 'comfyui' },
    workflowParams: PARAMS
  });
  assert.equal(payload.params.length, 2);
  assert.deepEqual(payload.params[0], { name: 'steps', type: 'INT' });
  assert.deepEqual(payload.params[1], { name: 'sampler_name', type: 'enum', options: ['euler', 'er_sde'] });
  assert.match(payload.hint, /params/);
  assert.doesNotMatch(payload.hint, /steps/, 'the hint must not repeat the parameter list');
  assert.doesNotMatch(payload.hint, /默认 25/, 'defaults must not leak into the hint');
});

test('settingsPayload omits params when the model has none', () => {
  const payload = settingsPayload({ provider, model: 'flux.safetensors', adapter: { id: 'comfyui' } });
  assert.equal(payload.params, undefined);
  assert.doesNotMatch(payload.hint, /params/);
});

test('normalizeModelOptions keeps per-parameter exposure flags', () => {
  const out = normalizeModelOptions({
    m1: {
      workflow: '{"1":{}}',
      params: [
        { name: 'steps', node: '18:7', input: 'steps', type: 'INT', default: 25, expose: false },
        { name: 'cfg', node: '18:7', input: 'cfg', type: 'FLOAT', default: 2.5 }
      ]
    }
  }, ['m1']);
  assert.equal(out.m1.params.length, 2);
  assert.equal(out.m1.params[0].expose, false, 'a hidden parameter stays hidden');
  assert.equal(out.m1.params[1].expose, undefined, 'the default is exposed');
});

test('normalizeModelOptions drops a malformed parameter list instead of half-keeping it', () => {
  const out = normalizeModelOptions({
    m1: { workflow: '{"1":{}}', params: [{ name: '', node: '1', input: 'x' }] }
  }, ['m1']);
  assert.equal(out.m1.params, undefined);
});

const MIXED = [
  { name: 'prompt', role: true, node: '1', input: 'value', type: 'STRING', default: 'x' },
  { name: 'negative_prompt', role: true, node: '1', input: 'negative', type: 'STRING', default: '' },
  { name: 'steps', node: '2', input: 'steps', type: 'INT', default: 25 }
];

test('prompt and negative prompt are never params, even when an old config exposes them', () => {
  const provider = {
    modelOptions: { m1: { workflow: '{}', params: MIXED, expose: { prompt: true, negative_prompt: true } } }
  };
  assert.equal(workflowParamsOf(provider, 'm1', { id: 'comfyui' }), undefined,
    'these two arrive as the tool own arguments, so the model must not see them in params');
});

test('a tunable parameter stays hidden until it is switched on', () => {
  const hidden = { modelOptions: { m1: { workflow: '{}', params: MIXED } } };
  assert.equal(workflowParamsOf(hidden, 'm1', { id: 'comfyui' }), undefined);
  const shown = { modelOptions: { m1: { workflow: '{}', params: MIXED, expose: { steps: true } } } };
  assert.deepEqual(workflowParamsOf(shown, 'm1', { id: 'comfyui' }).map((param) => param.name), ['steps']);
});

test('non-comfy adapters never get workflow params', () => {
  const provider = { modelOptions: { m1: { workflow: '{}', params: MIXED } } };
  assert.equal(workflowParamsOf(provider, 'm1', { id: 'a1111' }), undefined);
});

test('seed and model stay hidden by default even though they are role params', () => {
  const provider = {
    modelOptions: {
      m1: {
        workflow: '{}',
        params: [
          { name: 'seed', role: true, node: '3', input: 'seed', type: 'INT', default: 1 },
          { name: 'model', role: true, node: '1', input: 'unet_name', type: 'STRING', default: 'x' }
        ]
      }
    }
  };
  assert.equal(workflowParamsOf(provider, 'm1', { id: 'comfyui' }), undefined);
});

test('width and height stay hidden by default because the picker already injects them', () => {
  const provider = {
    modelOptions: {
      m1: {
        workflow: '{}',
        params: [
          { name: 'prompt', role: true, node: '1', input: 'value', type: 'STRING' },
          { name: 'width', role: true, node: '2', input: 'width', type: 'INT' },
          { name: 'height', role: true, node: '2', input: 'height', type: 'INT' }
        ]
      }
    }
  };
  assert.equal(workflowParamsOf(provider, 'm1', { id: 'comfyui' }), undefined);
});

test('role params only offer what the model can still tune', () => {
  const graph = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
    '1-': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    '3': { class_type: 'KSampler', inputs: { seed: 1 } }
  };
  const mapping = {
    prompt: { node: '1', input: 'text' },
    negative_prompt: { node: '1-', input: 'text' },
    width: { node: '2', input: 'width' },
    height: { node: '2', input: 'height' },
    seed: { node: '3', input: 'seed' },
    model: null,
    image: null
  };
  assert.deepEqual(collectRoleParams(graph, mapping, null).map((param) => param.name),
    ['width', 'height', 'seed']);
});

test('a size parameter can still be switched on by hand when a workflow needs it', () => {
  const provider = {
    modelOptions: {
      m1: {
        workflow: '{}',
        params: [{ name: 'width', role: true, node: '2', input: 'width', type: 'INT' }],
        expose: { width: true }
      }
    }
  };
  assert.deepEqual(workflowParamsOf(provider, 'm1', { id: 'comfyui' }).map((param) => param.name), ['width']);
});

/* ───── 模型行（role:'model'）：暴露只由「选择器是不是自动」推导 ───── */

/**
 * 一个云端模型条目：模型行 + 一行真的暴露的普通参数。
 *
 * 模型行的 expose 故意写 false：推导规则不看这个值（老配置里写着什么都与它无关）。
 */
const MODEL_ROW_PROVIDER = {
  modelOptions: {
    'gpt-image-2.5-flare': {
      params: [
        { role: 'model', name: 'model', type: 'text', expose: false },
        { name: 'seed', type: 'number', default: '42', expose: true }
      ]
    }
  }
};
const CLOUD_ADAPTER = { id: 'openai-images' };

test('选择器停在「自动」时，模型行出现在暴露清单里', () => {
  const out = workflowParamsOf(MODEL_ROW_PROVIDER, 'auto', CLOUD_ADAPTER) || [];
  assert.deepEqual(out.map((param) => param.name), ['model'],
    '行上写着 expose:false 也不影响：自动模式就是暴露');
  assert.equal(out[0].expose, true, '输出里带着推导结果，下游按 expose 过滤时不会把它滤掉');
});

test('选了具体模型时，模型行不出现在暴露清单里', () => {
  const provider = {
    modelOptions: {
      'gpt-image-2.5-flare': { params: [{ role: 'model', name: 'model', type: 'text', expose: true }] }
    }
  };
  assert.equal(workflowParamsOf(provider, 'gpt-image-2.5-flare', CLOUD_ADAPTER), undefined,
    '行上写着 expose:true 也不认：固定模型时模型这一行不暴露');
});

test('模型行的推导不牵连其它参数行', () => {
  const fixed = workflowParamsOf(MODEL_ROW_PROVIDER, 'gpt-image-2.5-flare', CLOUD_ADAPTER) || [];
  assert.deepEqual(fixed.map((param) => param.name), ['seed'], '固定模型：普通参数行照旧按自己的 expose 出现');
  const auto = workflowParamsOf(MODEL_ROW_PROVIDER, 'auto', CLOUD_ADAPTER) || [];
  assert.deepEqual(auto.map((param) => param.name), ['model'],
    '自动模式：没有固定条目，只补上模型行，别的条目里的普通行不跟过来');
});

test('role params take their type from object_info and never report a link as a string', () => {
  const objectInfo = JSON.parse(readFileSync('test/fixtures/object-info.sample.json', 'utf8'));
  const graph = {
    '18:6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['19', 0], height: ['19', 1], batch_size: 1 } }
  };
  const mapping = { width: { node: '18:6', input: 'width' }, height: { node: '18:6', input: 'height' } };
  const params = collectRoleParams(graph, mapping, objectInfo);
  const width = params.find((item) => item.name === 'width');
  assert.equal(width.type, 'INT');
  assert.equal(width.default, undefined, 'a link is not a usable default');
});

const A1111_PROVIDER = {
  modelOptions: { 'sd15.safetensors': { expose: { steps: true, seed: false } } }
};

test('A1111 keeps every parameter hidden until it is switched on', () => {
  const provider = { modelOptions: { 'sd15.safetensors': { expose: {} } } };
  assert.equal(workflowParamsOf(provider, 'sd15.safetensors', { id: 'a1111' }), undefined);
});

test('A1111 returns only the parameters the user switched on', () => {
  const out = workflowParamsOf(A1111_PROVIDER, 'sd15.safetensors', { id: 'a1111' });
  assert.deepEqual(out.map((param) => param.name), ['steps']);
});

test('A1111 falls back to another model entry on the same provider', () => {
  const out = workflowParamsOf(A1111_PROVIDER, 'other.safetensors', { id: 'a1111' });
  assert.deepEqual(out.map((param) => param.name), ['steps']);
});

test('normalizeModelOptions accepts an A1111 entry without a workflow', () => {
  const out = normalizeModelOptions(
    { 'sd15.safetensors': { expose: { steps: true } } },
    ['sd15.safetensors'],
    'a1111'
  );
  assert.deepEqual(out['sd15.safetensors'].expose, { steps: true });
  assert.equal(out['sd15.safetensors'].workflow, undefined);
});

test('normalizeModelOptions still requires a workflow for ComfyUI', () => {
  const out = normalizeModelOptions({ m1: { expose: { steps: true } } }, ['m1'], 'comfyui');
  assert.deepEqual(out, {});
});

test('settingsPayload reports A1111 parameters without node positions', () => {
  const payload = settingsPayload({
    provider, model: 'sd15.safetensors', adapter: { id: 'a1111' },
    workflowParams: [{ name: 'steps', type: 'INT' }]
  });
  assert.deepEqual(payload.params, [{ name: 'steps', type: 'INT' }]);
});

test('settingsPayload reports the auto size mode with the sizes the model may pick', () => {
  const payload = settingsPayload({
    provider, model: 'flux.safetensors', adapter: { id: 'comfyui' },
    sizeMode: 'auto', sizeOptions: ['1024x1024', '1024x1536']
  });
  assert.equal(payload.sizeMode, 'auto');
  assert.deepEqual(payload.sizeOptions, ['1024x1024', '1024x1536']);
  assert.match(payload.hint, /size/);
});

test('settingsPayload says the size is fixed so the model leaves it alone', () => {
  const payload = settingsPayload({
    provider, model: 'flux.safetensors', adapter: { id: 'comfyui' },
    sizeMode: 'fixed', size: '768x1024'
  });
  assert.equal(payload.sizeMode, 'fixed');
  assert.match(payload.hint, /768x1024/);
});

test('the prompt section points at exposed params without repeating their names', () => {
  const section = promptSectionText({
    model: 'sd15.safetensors', adapter: { id: 'a1111' }, promptOptimization: true,
    workflowParams: [{ name: 'steps', type: 'INT' }, { name: 'cfg_scale', type: 'FLOAT' }]
  });
  assert.match(section, /按需调整设置结果里的可调参数/);
  assert.doesNotMatch(section, /steps|cfg_scale/);
  assert.match(section, /参数调优/, 'point the model at the skill section');
  assert.doesNotMatch(section, /karras|denoising_strength/, 'the details live in the skill, not every request');
});

test('the prompt section never mentions parameters when optimization is Off', () => {
  const section = promptSectionText({
    model: 'sd15.safetensors', adapter: { id: 'a1111' }, promptOptimization: false,
    workflowParams: [{ name: 'steps', type: 'INT' }]
  });
  assert.doesNotMatch(section, /可调参数/);
});

test('the prompt section stays quiet for models without exposed parameters', () => {
  const section = promptSectionText({ model: 'sd15.safetensors', adapter: { id: 'a1111' }, promptOptimization: true });
  assert.doesNotMatch(section, /可调参数/);
});

test('the generation skill documents how to tune parameters', () => {
  const skill = readFileSync('skills/mo-image-generation/SKILL.md', 'utf8');
  assert.match(skill, /参数调优/);
  assert.match(skill, /denoising_strength/);
  assert.match(skill, /karras/);
});

test('the editing skill documents the denoise ladder', () => {
  const skill = readFileSync('skills/mo-image-editing/SKILL.md', 'utf8');
  assert.match(skill, /重绘幅度/);
  assert.match(skill, /0\.2–0\.35/);
});

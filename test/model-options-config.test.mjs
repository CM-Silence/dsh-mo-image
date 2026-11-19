import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, normalizeModelOptions } from '../lib/index.js';
import { normalizeQuality } from '../lib/config-store.js';

test('normalizeModelOptions keeps a workflow for models that exist', () => {
  const out = normalizeModelOptions(
    { 'a.safetensors': { workflow: '{"1":{}}' }, 'ghost.safetensors': { workflow: '{"2":{}}' } },
    ['a.safetensors']
  );
  assert.deepEqual(Object.keys(out), ['a.safetensors']);
  assert.equal(out['a.safetensors'].workflow, '{"1":{}}');
});

test('normalizeModelOptions drops empty or non-string workflows', () => {
  const out = normalizeModelOptions(
    { 'a': { workflow: '   ' }, 'b': { workflow: 42 }, 'c': {} },
    ['a', 'b', 'c']
  );
  assert.deepEqual(out, {});
});

test('normalizeModelOptions caps very large payloads', () => {
  const huge = 'x'.repeat(2_500_000);
  const out = normalizeModelOptions({ a: { workflow: huge } }, ['a']);
  assert.deepEqual(out, {}, 'oversized workflow should be rejected');
});

test('normalizeModelOptions tolerates garbage input', () => {
  assert.deepEqual(normalizeModelOptions(null, ['a']), {});
  assert.deepEqual(normalizeModelOptions('nope', ['a']), {});
  assert.deepEqual(normalizeModelOptions({ a: 'nope' }, ['a']), {});
});

test('normalizeConfig carries modelOptions through for each provider', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'local', baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true,
      models: ['flux.safetensors'],
      modelOptions: { 'flux.safetensors': { workflow: '{"1":{"class_type":"KSampler"}}' } }
    }],
    active: { providerId: 'p1', model: 'flux.safetensors' }
  });
  const provider = config.providers[0];
  assert.ok(provider.modelOptions);
  assert.equal(provider.modelOptions['flux.safetensors'].workflow, '{"1":{"class_type":"KSampler"}}');
});

test('normalizeConfig omits modelOptions when nothing usable is configured', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{ id: 'p1', name: 'x', baseUrl: 'http://x', models: ['m'], modelOptions: {} }],
    active: { providerId: 'p1', model: 'm' }
  });
  assert.equal(config.providers[0].modelOptions, undefined);
});

test('normalizeConfig drops modelOptions for adapters that cannot run custom workflows', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'cloud', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
      models: ['gpt-image-2.5-flare'],
      modelOptions: { 'gpt-image-2.5-flare': { workflow: '{"1":{"class_type":"KSampler"}}' } }
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' }
  });
  assert.equal(config.providers[0].modelOptions, undefined,
    'only the ComfyUI adapter understands custom workflows');
});

test('normalizeConfig keeps size overrides for cloud adapters', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'cloud', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
      models: ['gpt-image-2.5-flare'],
      modelOptions: {
        'gpt-image-2.5-flare': {
          workflow: '{"1":{"class_type":"KSampler"}}',
          size: { mode: 'wh-string', field: 'size', separator: 'x' }
        }
      }
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' }
  });
  const options = config.providers[0].modelOptions;
  assert.ok(options, '云端模型的尺寸覆盖必须能存下来');
  assert.equal(options['gpt-image-2.5-flare'].size.field, 'size');
  assert.equal(options['gpt-image-2.5-flare'].workflow, undefined, '工作流只有 ComfyUI 认');
});

test('normalizeModelOptions keeps a valid mapping next to the workflow', () => {
  const out = normalizeModelOptions({
    'm1': { workflow: '{"1":{}}', mapping: { prompt: { node: '1', input: 'text' }, width: null } }
  }, ['m1']);
  assert.deepEqual(out.m1.mapping.prompt, { node: '1', input: 'text' });
  assert.equal(out.m1.mapping.width, null);
});

test('normalizeConfig keeps field template overrides for cloud adapters', () => {
  // 任务 7' 把通用请求体交给字段模板以后，用户覆盖也要真的能落盘（否则面板改了等于没改）。
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['flux-1-schnell'],
      modelOptions: {
        'flux-1-schnell': { fields: { prompt: { path: 'input.prompt' }, negative: null } }
      }
    }],
    active: { providerId: 'p1', model: 'flux-1-schnell' }
  });
  const options = config.providers[0].modelOptions;
  assert.ok(options, '字段模板覆盖必须能存下来');
  assert.deepEqual(options['flux-1-schnell'].fields, {
    prompt: { path: 'input.prompt' },
    negative: null
  });
});

test('normalizeModelOptions drops a field template it cannot parse', () => {
  const out = normalizeModelOptions({ m: { fields: { prompt: { nonsense: true } } } }, ['m']);
  assert.deepEqual(out, {}, '认不出的模板整条丢掉，别存一个发送时才炸的东西');
  // 一条坏模板不影响同一个模型上其它合法的字段模板。
  const mixed = normalizeModelOptions({
    m: { fields: { prompt: { nonsense: true }, n: { path: 'num_images' } } }
  }, ['m']);
  assert.deepEqual(mixed.m.fields, { n: { path: 'num_images' } });
});

test('normalizeModelOptions drops a mapping that is not shaped node/input', () => {
  const out = normalizeModelOptions({ 'm1': { workflow: '{"1":{}}', mapping: { prompt: 'nope' } } }, ['m1']);
  assert.equal(out.m1.mapping, undefined);
});

test('normalizeModelOptions accepts a workflow up to 2 MB', () => {
  const big = '{"1":"' + 'x'.repeat(1_500_000) + '"}';
  const out = normalizeModelOptions({ 'm1': { workflow: big } }, ['m1']);
  assert.ok(out.m1, 'a 1.5 MB workflow must survive');
});

test('normalizeQuality 保留用户自定义档位', () => {
  assert.equal(normalizeQuality('ultra'), 'ultra');
  assert.equal(normalizeQuality(' ULTRA '), 'ultra');
  assert.equal(normalizeQuality(''), 'high');
  assert.equal(normalizeQuality('x'.repeat(40)), 'high', '异常长的值仍然回退');
  assert.equal(normalizeQuality('has space'), 'high');
});

/* -------------------------------------------- 任务 9'：键锁与质量覆盖落盘 */

test('normalizeModelOptions 只留八个键上的布尔锁', () => {
  const out = normalizeModelOptions({
    m: {
      locked: { size: true, quality: false, nope: true, prompt: 'yes' },
      size: { mode: 'wh-string', field: 'image_size' }
    }
  }, ['m']);
  assert.deepEqual(out.m.locked, { size: true, quality: false },
    '不认识的键与非布尔值都要丢掉');
});

test('「输出设置」的锁也是一个正常的锁键：解锁后能存下来', () => {
  // 预设来源的返回格式默认锁住；用户点锁解锁 = locked.operations: false，
  // 和输入设置那七个键走同一条路（宿主这里只做形状校验，不猜默认）。
  const out = normalizeModelOptions({
    m: { locked: { operations: false }, operations: { version: 1, generate: { output: 'binary' } } }
  }, ['m']);
  assert.deepEqual(out.m.locked, { operations: false }, 'operations 的锁不被当成陌生键丢掉');
  assert.equal(out.m.operations.generate.output, 'binary', '锁与值是两件事，值照旧保留');
});

test('normalizeModelOptions 留住「只有锁」的模型条目', () => {
  // 预设提供商的模型默认全锁，用户解锁一个键就会产生这种条目——它必须能存下来。
  const out = normalizeModelOptions({ m: { locked: { size: false } } }, ['m']);
  assert.deepEqual(out.m.locked, { size: false });
});

test('normalizeModelOptions 丢掉空的或不认识的锁', () => {
  assert.deepEqual(normalizeModelOptions({ m: { locked: {} } }, ['m']), {});
  assert.deepEqual(normalizeModelOptions({ m: { locked: 'nope' } }, ['m']), {});
});

test('normalizeConfig 把质量覆盖与锁一起存下来', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: '云端', baseUrl: 'https://api.openai.com/v1', adapter: 'openai-images',
      models: ['gpt-image-2.5-flare'],
      modelOptions: {
        'gpt-image-2.5-flare': {
          quality: {
            supported: true,
            field: 'rendering_speed',
            options: [
              { label: 'Turbo', value: 'TURBO' },
              { label: 'Quality', value: 'Quality', default: true },
              { label: 'Off', value: 'OFF' }
            ],
            default: 'QUALITY'
          },
          locked: { quality: true, size: true }
        }
      }
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' }
  });
  const options = config.providers[0].modelOptions;
  assert.ok(options, '质量覆盖与锁必须能落盘');
  assert.deepEqual(options['gpt-image-2.5-flare'].locked, { quality: true, size: true });
  assert.equal(options['gpt-image-2.5-flare'].quality.supported, true);
  assert.equal(options['gpt-image-2.5-flare'].quality.field, 'rendering_speed');
  assert.deepEqual(options['gpt-image-2.5-flare'].quality.options, [
    { label: 'Turbo', value: 'turbo', default: false },
    { label: 'Quality', value: 'quality', default: true }
  ], '档位小写化、off 是全局固定档不落盘，显示名与默认标记跟着走');
  assert.equal(options['gpt-image-2.5-flare'].quality.default, 'quality');
});

test('normalizeModelOptions 丢掉形状不对的质量覆盖', () => {
  assert.deepEqual(normalizeModelOptions({ m: { quality: 'nope' } }, ['m']), {});
  assert.deepEqual(normalizeModelOptions({ m: { quality: { options: [] } } }, ['m']), {});
});

/* ------------------------------------------- 任务 9' 第二轮：来源与面板控件 */

test('normalizeConfig 保存并回读预设来源 presetId', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '',
      presetId: 'openai', models: ['gpt-image-2.5-flare']
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' }
  });
  assert.equal(config.providers[0].presetId, 'openai');
});

test('normalizeConfig 丢掉形状不对的 presetId', () => {
  const bad = ['../etc/passwd', 'has space', 'x'.repeat(80), 42, null, { a: 1 }, ''];
  for (const value of bad) {
    const config = normalizeConfig({
      version: 1,
      providers: [{ id: 'p1', name: 'x', baseUrl: 'https://x.test/v1', presetId: value, models: ['m'] }],
      active: { providerId: 'p1', model: 'm' }
    });
    assert.equal(config.providers[0].presetId, undefined, JSON.stringify(value));
  }
});

test('normalizeConfig 不凭空发明 presetId（老配置按自配处理）', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{ id: 'p1', name: 'x', baseUrl: 'https://gateway.example/v1', adapter: '', models: ['m'] }],
    active: { providerId: 'p1', model: 'm' }
  });
  assert.equal(config.providers[0].presetId, undefined, '没有来源记录就当作自配');
});

test('normalizeModelOptions 保留尺寸覆盖里的 control（面板控件）', () => {
  const out = normalizeModelOptions({
    m: { size: { mode: 'wh-string', field: 'size', control: 'aspect' } }
  }, ['m']);
  assert.equal(out.m.size.control, 'aspect', '向量模型的「面板给比例、线上发像素」要能落盘');
  assert.equal(out.m.size.mode, 'wh-string');
  assert.equal(normalizeModelOptions({ m: { size: { control: 'nonsense' } } }, ['m']).m, undefined,
    '认不出的 control 不算有效覆盖');
});

/* ------------------------------------------- 「常规」离散参数表（params） */

const PARAM_TABLE = [
  { role: 'prompt', name: 'prompt', type: 'text', default: '', description: '生图提示词', expose: true },
  { role: 'negative', name: 'negative_prompt', type: 'text', default: '', description: '不想出现的内容', expose: false },
  { name: 'seed', type: 'number', default: '42', description: '随机种子', expose: true }
];

test('normalizeModelOptions 原样保存离散参数表', () => {
  const out = normalizeModelOptions({ m: { params: PARAM_TABLE } }, ['m'], 'openai-images');
  assert.deepEqual(out.m.params, PARAM_TABLE);
});

test('normalizeConfig 让云端适配器也存得住离散参数表', () => {
  // 参数表不是 ComfyUI 的工作流参数：以前 non-comfy 适配器会被整段删掉。
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['flux-1-schnell'],
      modelOptions: { 'flux-1-schnell': { params: PARAM_TABLE } }
    }],
    active: { providerId: 'p1', model: 'flux-1-schnell' }
  });
  assert.deepEqual(config.providers[0].modelOptions['flux-1-schnell'].params, PARAM_TABLE);
});

test('模型行不落 expose：暴露只由选择器推导，行上的值没人读', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['m'],
      modelOptions: {
        m: {
          params: [
            { role: 'model', name: 'model', type: 'text', expose: false },
            { name: 'seed', type: 'number', default: '42', expose: true }
          ]
        }
      }
    }],
    active: { providerId: 'p1', model: 'm' }
  });
  const rows = config.providers[0].modelOptions.m.params;
  assert.equal(rows[0].role, 'model');
  assert.equal('expose' in rows[0], false,
    '模型行的暴露是运行时按「选择器是不是自动」推导的，行上的 expose 没人读，落盘只会留下假字段');
  assert.equal(rows[1].expose, true, '普通参数行照旧写 expose');
});

test('只有离散参数表的模型条目不会被 normalizeConfig 丢掉', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['m'], modelOptions: { m: { params: [PARAM_TABLE[0]] } }
    }],
    active: { providerId: 'p1', model: 'm' }
  });
  assert.ok(config.providers[0].modelOptions.m, '参数表本身就是一条配置');
});

test('离散参数表校验 role / type / 长度与 expose', () => {
  const out = normalizeModelOptions({
    m: {
      params: [
        { role: 'prompt', name: '  prompt  ', type: 'number', default: '9', description: 'p', expose: false },
        { role: 'unknown', name: 'x'.repeat(80), type: 'date', default: 42, description: 'd'.repeat(260), expose: 'yes' },
        { name: '', type: 'text' },
        { name: 'seed', type: 'NUMBER', default: 7, expose: true }
      ]
    }
  }, ['m'], 'openai-images');
  const rows = out.m.params;
  assert.equal(rows.length, 3, '空名字的行丢掉，其余留下');
  assert.deepEqual(rows[0], {
    role: 'prompt', name: 'prompt', type: 'text', default: '', description: 'p',
    expose: true
  }, '提示词行固定 text / 空默认 / 暴露');
  assert.equal(rows[1].role, undefined, '不认识的 role 不是内置行');
  assert.equal(rows[1].name.length, 64, 'name 截到上限');
  assert.equal(rows[1].type, 'text', '不认识的 type 回落到 text');
  assert.equal(rows[1].default, '42', '默认值统一成字符串');
  assert.equal(rows[1].description.length, 200, 'description 截到上限');
  assert.equal(rows[1].expose, false, 'expose 只认 true');
  assert.deepEqual(rows[2], {
    name: 'seed', type: 'number', default: '7', description: '', expose: true
  }, 'type 按小写认；缺省字段补空');
});

test('离散参数表把提示词永远排在第一行', () => {
  const out = normalizeModelOptions({
    m: {
      params: [
        { name: 'seed', type: 'number' },
        { role: 'negative', name: 'negative_prompt', type: 'text' },
        { role: 'prompt', name: 'prompt', type: 'text' }
      ]
    }
  }, ['m'], 'openai-images');
  assert.deepEqual(out.m.params.map((row) => row.role || row.name), ['prompt', 'negative', 'seed']);
});

test('离散参数表支持 enum 选项：字符串与数组都收，去重、限量', () => {
  const out = normalizeModelOptions({
    m: {
      params: [
        { name: 'sampler', type: 'enum', options: 'euler, ddim，euler' },
        { name: 'scheduler', type: 'enum', options: ['karras', ' normal ', 'karras'] },
        { name: 'text_only', type: 'text', options: ['ignored'] }
      ]
    }
  }, ['m'], 'openai-images');
  assert.deepEqual(out.m.params[0].options, ['euler', 'ddim']);
  assert.deepEqual(out.m.params[1].options, ['karras', 'normal']);
  assert.deepEqual(out.m.params[2].options, ['ignored'], '选项跟着行走，type 不拦');
});

test('空的离散参数表不落盘', () => {
  assert.equal(normalizeModelOptions({ m: { params: [] } }, ['m']).m, undefined);
  assert.equal(normalizeModelOptions({ m: { params: [{ name: '' }] } }, ['m']).m, undefined);
});

test('云端适配器仍然丢掉 ComfyUI 的工作流参数形状', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['m'],
      modelOptions: {
        m: {
          params: [{ name: 'steps', node: '18:7', input: 'steps', type: 'INT', expose: false }]
        }
      }
    }],
    active: { providerId: 'p1', model: 'm' }
  });
  assert.equal(config.providers[0].modelOptions, undefined, 'node/input 形状只属于工作流协议');
});

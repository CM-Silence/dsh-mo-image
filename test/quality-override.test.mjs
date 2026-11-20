/**
 * 「质量」方框的数据形状与请求侧行为。
 *
 * 这一轮把质量从「常规」里的一行参数名，升级成一个独立的方框，于是覆盖层从
 *   { field, options: [string], default: string }
 * 变成
 *   { supported, field, options: [{ label, value, default }], default }
 *
 * 这里锁的是四件用户能感知的事（与 UI 无关，全在数据/请求侧）：
 *
 *   1. 取消「支持质量参数」以后，请求里连 quality 这个键都没有；
 *   2. 勾选并自定义挡位后，那个挡位出现在选择器里（显示名也跟着走）；
 *   3. 参数名改成 a.b.c 之后，质量写到新字段；
 *   4. 老形状配置读回来不报错，按 supported:true + 空显示名处理。
 *
 * 第 3 条的机制值得记一笔：真正决定质量落在哪个字段的是**字段模板**
 * `modelOptions[m].fields.quality`，`quality.field` 只喂面板和识别路由。所以
 * 「换字段名」必须两处一起写（客户端质量方框里就是这么做的，见 client-model-options.test.mjs）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, prepareGenerate, qualityOptionsFor, qualityOverrideOf } from '../lib/adapters.js';
import { normalizeConfig, normalizeModelOptions } from '../lib/index.js';
import { resolveToolQuality, sanitizeQualityOption } from '../lib/config-store.js';

const MODEL = 'gpt-image-2.5-flare';
/** 尺寸怎么发跟这里无关：omit 掉，body 里就只剩质量这一件事。 */
const OMIT = { omit: true, size: 'none' };

/** 一家认质量的官方网关：预设给了 fields.quality，质量规则按模型名命中。 */
function providerOf(modelOptions) {
  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'gpt-image' };
  if (modelOptions) provider.modelOptions = modelOptions;
  return provider;
}

function generateBody(provider, quality, model = MODEL) {
  const adapter = resolveAdapter(provider, model);
  const prepared = prepareGenerate(adapter, provider, {
    model: model, prompt: 'a cat', quality: quality, fitted: OMIT
  }, new Set());
  return JSON.parse(prepared.body);
}

test('official BigModel uses model-specific quality options without sending internal modes', () => {
  const provider = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'openai-images', presetId: 'bigmodel' };
  for (const [model, options] of [
    ['glm-image', ['off', 'hd']],
    ['cogview-4', ['off', 'standard', 'hd']],
    ['cogview-4-250304', ['off', 'standard', 'hd']],
    ['cogview-3-flash', ['off', 'standard', 'hd']],
    ['vendor/CogView-4-250304:preview', ['off', 'standard', 'hd']]
  ]) {
    const adapter = resolveAdapter(provider, model);
    const spec = qualityOptionsFor(provider, model, adapter);
    assert.deepEqual(spec?.options.map((item) => item.value), options, model);
    assert.equal(generateBody(provider, 'off', model).quality, undefined, model);
    assert.equal(generateBody(provider, 'auto', model).quality, undefined, model);
    assert.equal(generateBody(provider, 'hd', model).quality, 'hd', model);
    assert.equal(generateBody(provider, 'high', model).quality, spec.default, model);
    assert.equal(spec.default, options[1], model);
  }
  const glm = resolveAdapter(provider, 'glm-image');
  assert.throws(() => resolveToolQuality(provider, 'glm-image', { quality: 'auto' }, { quality: 'standard' }, glm), /不支持质量档位/);
  assert.equal(generateBody(provider, 'hd', 'unknown-image').quality, undefined);
  const gateway = { adapter: 'openai-images', baseUrl: 'https://gateway.test/v1' };
  assert.equal(generateBody(gateway, 'hd', 'cogview-4').quality, undefined);
});

/** 一份「勾选了、也配了挡位」的覆盖，测试里按需改。 */
function qualityOverride(extra) {
  return Object.assign({
    supported: true,
    field: 'quality',
    options: [
      { label: 'Low', value: 'low', default: false },
      { label: 'High', value: 'high', default: true }
    ]
  }, extra || {});
}

/* ------------------------------------------------ 1. 取消勾选 = 不发质量 */

test('没勾「支持质量参数」时，请求里没有质量字段', () => {
  // 对照组：不配覆盖，规则命中 gpt-image，质量照常发。
  const plain = generateBody(providerOf(), 'high');
  assert.equal(plain.quality, 'high', '对照组：规则说这个模型收质量');

  // 勾选：覆盖层接上，照样发。
  const on = providerOf({ [MODEL]: { quality: qualityOverride() } });
  assert.equal(generateBody(on, 'high').quality, 'high');
  assert.ok(qualityOptionsFor(on, MODEL, resolveAdapter(on, MODEL)), '勾选时选择器有档位');

  // 取消勾选：请求里连这个键都不该有，选择器也不该再报档位。
  const off = providerOf({ [MODEL]: { quality: qualityOverride({ supported: false }) } });
  const body = generateBody(off, 'high');
  assert.equal('quality' in body, false, '取消勾选后 body 里不该再有 quality 键');
  assert.equal(
    qualityOptionsFor(off, MODEL, resolveAdapter(off, MODEL)),
    null,
    '取消勾选后选择器也不该有档位'
  );

  // 自己拼 body 的协议同样走 qualityForAdapter，所以这条闸门对它们一样有效。
  const responses = {
    baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses',
    modelOptions: { [MODEL]: { quality: qualityOverride({ supported: false }) } }
  };
  assert.equal(
    qualityOptionsFor(responses, MODEL, resolveAdapter(responses, MODEL)),
    null,
    '自己拼 body 的协议也受同一道闸门管'
  );
});

/* ------------------------------------- 2. 自定义挡位出现在选择器里（含显示名） */

test('勾选并自定义挡位后，那个挡位出现在选择器里，显示名跟着走', () => {
  const provider = providerOf({
    [MODEL]: {
      quality: qualityOverride({
        options: [
          { label: '超清', value: 'ultra', default: false },
          { label: 'Low', value: 'low', default: false },
          { label: 'High', value: 'high', default: true }
        ]
      })
    }
  });
  const spec = qualityOptionsFor(provider, MODEL, resolveAdapter(provider, MODEL));
  assert.ok(spec, '选择器还在');
  // off 仍然固定第一项：它表示「不发这个参数」。
  assert.deepEqual(spec.options.map((item) => item.value), ['off', 'ultra', 'low', 'high']);
  assert.equal(spec.options.find((item) => item.value === 'ultra').label, '超清',
    '自定义显示名要盖过生成式标签');
  assert.equal(spec.options.find((item) => item.value === 'low').label, 'Low',
    '显示名照抄用户写的，不再被内置词表改写');
  // 顺序就是用户排的顺序，不是字母序。
  assert.deepEqual(spec.options.slice(1).map((item) => item.value), ['ultra', 'low', 'high']);

  // 自定义挡位真的能发出去：它不再被「只认规则枚举」的老口径挡回来。
  assert.equal(generateBody(provider, 'ultra').quality, 'ultra');
});

test('自定义挡位没写显示名时回落到生成式标签', () => {
  const provider = providerOf({
    [MODEL]: {
      quality: qualityOverride({
        options: [
          { label: '', value: 'turbo', default: false },
          { label: '', value: 'high', default: true }
        ]
      })
    }
  });
  const spec = qualityOptionsFor(provider, MODEL, resolveAdapter(provider, MODEL));
  assert.equal(spec.options.find((item) => item.value === 'turbo').label, 'Turbo',
    '空显示名不该把选择器变成空白项');
});

/* ------------------------------------- 3. 参数名改成 a.b.c = 写到新字段 */

test('参数名改了之后，质量写到新字段', () => {
  // 客户端质量方框里改「参数名」会同时写这两处：quality.field 给面板与识别路由，
  // fields.quality 才是真正决定落点的字段模板（和 mergeRuleResult 的写法一致）。
  const provider = providerOf({
    [MODEL]: {
      quality: qualityOverride({ field: 'parameters.quality' }),
      fields: { quality: { path: 'parameters.quality' } }
    }
  });
  const body = generateBody(provider, 'high');
  assert.deepEqual(body.parameters, { quality: 'high' }, '质量写到点分路径的末层');
  assert.equal('quality' in body, false, '旧位置不该还留着');
  // 参数名留在这层覆盖里（面板与识别路由读它），档位表照旧可用。
  assert.equal(qualityOverrideOf(provider, MODEL).field, 'parameters.quality');
});

test('只写 quality.field 不动字段模板时，落点不变（回归保护）', () => {
  // 这条是用来钉住设计的：quality.field 不参与发请求。谁要是把两处合并成一处，
  // 上面那条用例会假绿——所以这条必须留着。
  const provider = providerOf({ [MODEL]: { quality: qualityOverride({ field: 'parameters.quality' }) } });
  const body = generateBody(provider, 'high');
  assert.equal(body.quality, 'high');
  assert.equal(body.parameters, undefined);
});

/* ------------------------------------------- 4. 老形状读回来不报错 */

test('老形状配置读回来不报错，按 supported:true + 空显示名处理', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'Landing relay', baseUrl: 'https://gateway.example/v1', adapter: '',
      models: ['m'], modelOptions: {
        m: {
          quality: { field: 'rendering_speed', options: ['TURBO', 'Quality', 'OFF'], default: 'QUALITY' }
        }
      }
    }],
    active: { providerId: 'p1', model: 'm' }
  });
  const quality = config.providers[0].modelOptions.m.quality;
  assert.equal(quality.supported, true, '老形状 = 用户当年就是「收质量」');
  assert.equal(quality.field, 'rendering_speed');
  assert.deepEqual(quality.options, [
    { label: '', value: 'turbo', default: false },
    { label: '', value: 'quality', default: true }
  ], '值小写化、off 不落盘、顶层 default 转成那一条的 default 标记');
  assert.equal(quality.default, 'quality', '顶层 default 保留，规则那边还在用它');

  // 老形状在新链路里照样能用：选择器拿得到档位。
  const adapter = resolveAdapter(config.providers[0], 'm');
  const spec = qualityOptionsFor(config.providers[0], 'm', adapter);
  assert.ok(spec, '老配置不该把质量整块弄丢');
});

test('老形状没有 default 时不硬造默认档', () => {
  const out = sanitizeQualityOption({ field: 'quality', options: ['low', 'high'] });
  assert.deepEqual(out.options, [
    { label: '', value: 'low', default: false },
    { label: '', value: 'high', default: false }
  ]);
  assert.equal(out.default, undefined);
});

test('只取消了勾选（没配挡位）也要存得住', () => {
  // 这是「取消勾选」能持久化的前提：老口径会把「什么都没有」判成没设。
  assert.deepEqual(sanitizeQualityOption({ supported: false }), { supported: false });
  assert.deepEqual(normalizeModelOptions({ m: { quality: { supported: false } } }, ['m']), {
    m: { quality: { supported: false } }
  }, '只有 supported:false 的条目不该被模型选项丢掉');
  // 真正的垃圾仍然丢掉。
  assert.equal(sanitizeQualityOption({ options: [] }), null);
  assert.equal(sanitizeQualityOption({ supported: true }), null, '勾了却什么都没有 = 没配');
});

/* --------------------------------------------------- 默认挡位 */

test('标了 default 的挡位成为选择器默认值', () => {
  const provider = providerOf({
    [MODEL]: {
      quality: qualityOverride({
        options: [
          { label: 'Low', value: 'low', default: false },
          { label: 'Ultra', value: 'ultra', default: true }
        ]
      })
    }
  });
  const spec = qualityOptionsFor(provider, MODEL, resolveAdapter(provider, MODEL));
  assert.equal(spec.default, 'ultra');
});

test('一个都没标默认时退回规则里的 default', () => {
  const provider = providerOf({
    [MODEL]: {
      quality: qualityOverride({
        options: [
          { label: 'Ultra', value: 'ultra', default: false },
          { label: 'Low', value: 'low', default: false },
          { label: 'High', value: 'high', default: false }
        ],
        default: ''
      })
    }
  });
  const spec = qualityOptionsFor(provider, MODEL, resolveAdapter(provider, MODEL));
  assert.equal(spec.default, 'high', '用户没标默认就跟着规则走（规则是 high），不取第一项');
});

test('规则 default 不在用户挡位表里时退回第一项', () => {
  const provider = providerOf({
    [MODEL]: {
      quality: qualityOverride({
        options: [
          { label: 'Ultra', value: 'ultra', default: false },
          { label: 'Low', value: 'low', default: false }
        ],
        default: ''
      })
    }
  });
  const spec = qualityOptionsFor(provider, MODEL, resolveAdapter(provider, MODEL));
  assert.equal(spec.default, 'ultra', '规则默认 high 不在表里，只能落在第一项');
});

test('默认档必须在自己的挡位表里，否则退回规则', () => {
  const out = sanitizeQualityOption({
    supported: true,
    options: [{ label: 'Low', value: 'low', default: true }],
    default: 'max'
  });
  assert.equal(out.default, 'low', '顶层 default 与挡位表打架时以标了 default 的那条为准');
});

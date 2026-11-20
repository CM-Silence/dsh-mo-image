import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIZE_RULES, QUALITY_RULES, detectSizeRule, detectQualityRule
} from '../lib/model-rules.js';

/*
 * 尺寸与质量规则：按模型名（必要时加主机）模糊匹配，命中第一条即返回。
 * 条目里的每个数值都能在 lib/adapters.js、lib/adapters/{cn,async,openai}.js
 * 的 size / quality / sizeByModel 声明里逐条对上——不许自己发明取值域。
 */

const SILICONFLOW = 'https://api.siliconflow.cn/v1';
const DASHSCOPE = 'https://dashscope.aliyuncs.com/api/v1';
const MODELSCOPE = 'https://api-inference.modelscope.cn';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const ARK = 'https://ark.cn-beijing.volces.com/api/v3';

/** 允许的「怎么发」：none 表示该模型不收尺寸字段。 */
const SIZE_MODES = ['wh-string', 'wh-fields', 'aspect', 'tier', 'prompt', 'none'];

/* ------------------------------------------------------------------ 形状 */

test('规则表条目都带正则 match 与合法的 mode', () => {
  assert.ok(Array.isArray(SIZE_RULES) && SIZE_RULES.length > 0);
  assert.ok(Array.isArray(QUALITY_RULES) && QUALITY_RULES.length > 0);
  for (const rule of SIZE_RULES) {
    assert.ok(rule.match instanceof RegExp, 'match 必须是正则');
    if (rule.host !== undefined) assert.equal(typeof rule.host, 'string');
    assert.ok(SIZE_MODES.includes(rule.size.mode), '未知 mode：' + rule.size.mode);
    assert.equal(typeof rule.domain, 'object');
  }
  for (const rule of QUALITY_RULES) {
    assert.ok(rule.match instanceof RegExp, 'match 必须是正则');
    if (rule.host !== undefined) assert.equal(typeof rule.host, 'string');
    assert.equal(typeof rule.quality.field, 'string');
    assert.ok(Array.isArray(rule.quality.options) && rule.quality.options.length > 0);
    // off 是全局固定档位，不进规则的 options。
    assert.equal(rule.quality.options.includes('off'), false);
  }
});

/* ------------------------------------------------------------- gpt-image */

test('gpt-image 命中 16 倍数与质量枚举', () => {
  const size = detectSizeRule('gpt-image-2.5-flare');
  assert.equal(size.size.mode, 'wh-string');
  assert.equal(size.size.field, 'size');
  assert.equal(size.domain.multiple, 16);
  assert.equal(size.domain.minPixels, 655360);
  assert.equal(size.domain.maxPixels, 8294400);
  assert.equal(size.domain.default, '1024x1024');

  const quality = detectQualityRule('gpt-image-2.5-flare');
  assert.equal(quality.quality.field, 'quality');
  assert.equal(quality.quality.default, 'high');
  assert.deepEqual(quality.quality.options, ['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
});

test('gpt-image 非 flare 档位没有 xhigh / max', () => {
  const quality = detectQualityRule('gpt-image-1.5');
  assert.deepEqual(quality.quality.options, ['low', 'medium', 'high', 'auto']);
  assert.equal(quality.quality.default, 'high');
});

/* --------------------------------------------------------------- dall-e-3 */

test('dall-e-3 只认三个固定尺寸与 standard / hd', () => {
  const size = detectSizeRule('dall-e-3');
  assert.equal(size.size.mode, 'wh-string');
  assert.equal(size.size.field, 'size');
  assert.deepEqual(size.domain.allowed, ['1024x1024', '1792x1024', '1024x1792']);
  assert.equal(size.domain.default, '1024x1024');

  const quality = detectQualityRule('dall-e-3');
  assert.equal(quality.quality.field, 'quality');
  assert.deepEqual(quality.quality.options, ['standard', 'hd']);
  assert.equal(quality.quality.default, 'standard');
});

/* --------------------------------------------------------------- seedream */

test('seedream 通用网关按档位表给像素预算', () => {
  const lite = detectSizeRule('seedream-5.0-lite');
  assert.equal(lite.size.mode, 'wh-string');
  assert.deepEqual(lite.domain.tiers, [
    { value: '2K', pixels: 4194304 },
    { value: '3K', pixels: 9437184 },
    { value: '4K', pixels: 16777216 }
  ]);
  assert.equal(lite.domain.minPixels, 3686400);
  assert.equal(lite.domain.maxPixels, 16777216);

  const v5 = detectSizeRule('seedream-5.0');
  assert.deepEqual(v5.domain.tiers, [
    { value: '1K', pixels: 1048576 },
    { value: '1.5K', pixels: 2359296 },
    { value: '2K', pixels: 4194304 }
  ]);
  assert.equal(v5.domain.maxPixels, 4624220);

  const v45 = detectSizeRule('seedream-4.5');
  assert.deepEqual(v45.domain.tiers, [{ value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }]);

  const v40 = detectSizeRule('seedream-4.0');
  assert.equal(v40.domain.minPixels, 921600);
  assert.equal(v40.domain.maxPixels, 16777216);
});

test('seedream 在火山方舟线上发档位名而不是宽高', () => {
  const size = detectSizeRule('doubao-seedream-5.0-250828', ARK);
  assert.equal(size.size.mode, 'tier');
  assert.equal(size.size.field, 'size');
  assert.deepEqual(size.domain.tiers.map((tier) => tier.value), ['1K', '1.5K', '2K']);
  assert.equal(size.domain.maxPixels, 4624220);

  const hyphen = detectSizeRule('doubao-seedream-5-0-250828', ARK);
  assert.deepEqual(hyphen.domain.tiers.map((tier) => tier.value), ['1K', '1.5K', '2K']);
  const documented = detectSizeRule('regional/doubao-seedream-5-5-261028:preview', ARK);
  assert.equal(documented.size.mode, 'tier');
  assert.deepEqual(documented.domain.tiers.map((tier) => tier.value), ['1K', '1.5K', '2K']);
});

/* ---------------------------------------------------- nano-banana / gemini */

test('nano-banana / gemini image 走比例 + 档位', () => {
  const banana = detectSizeRule('gemini-3-pro-image-preview');
  assert.equal(banana.size.mode, 'aspect');
  assert.equal(banana.size.field, 'generationConfig.imageConfig.aspectRatio');
  assert.equal(banana.size.second.field, 'generationConfig.imageConfig.imageSize');
  assert.deepEqual(banana.domain.tiers.map((tier) => tier.value), ['1K', '2K', '4K']);
  assert.equal(banana.domain.aspects.includes('21:9'), true);
  assert.equal(banana.domain.aspects.includes('8:1'), false);

  const flash = detectSizeRule('gemini-3.1-flash-image-preview');
  assert.deepEqual(flash.domain.tiers.map((tier) => tier.value), ['512', '1K', '2K', '4K']);

  const generic = detectSizeRule('nano-banana-2.1');
  assert.equal(generic.size.mode, 'aspect');
  assert.equal(generic.domain.aspects.length, 14);
  assert.deepEqual(generic.domain.tiers.map((tier) => tier.value), ['1K', '2K', '4K']);
  const lite = detectSizeRule('regional/gemini_3_1_flash_lite_image:production');
  assert.deepEqual(lite.domain.tiers.map((tier) => tier.value), ['1K']);
});

test('Gemini 模型使用带前后缀的 ID，只有原生协议匹配专用字段', () => {
  for (const model of ['publisher/gemini-3.1-flash-image-release:latest', 'publisher/nano_banana_2_1-v2']) {
    const native = detectSizeRule(model, 'https://gemini-gateway.example/v1beta', 'google-gemini');
    assert.equal(native.size.field, 'generationConfig.imageConfig.aspectRatio');
    const compatible = detectSizeRule(model, 'https://images-gateway.example/v1', 'openai-images');
    assert.equal(compatible.generic, true);
    assert.equal(compatible.size.field, 'size');
  }
});

test('gemini 2.5 flash image 不发尺寸字段', () => {
  const size = detectSizeRule('gemini-2.5-flash-image');
  assert.equal(size.size.mode, 'none');
});

/* -------------------------------------------------- qwen-image 两台主机 */

test('qwen-image 按主机分开：硅基流动 vs 百炼', () => {
  const sf = detectSizeRule('Qwen/Qwen-Image', SILICONFLOW);
  assert.equal(sf.size.field, 'image_size');
  assert.equal(sf.domain.allowCustom, true);
  assert.deepEqual(sf.domain.allowed, [
    '1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584'
  ]);

  const ds = detectSizeRule('qwen-image-3.0-pro', DASHSCOPE);
  assert.equal(ds.size.field, 'size');
  assert.equal(ds.size.separator, '*');
  assert.equal(ds.domain.minPixels, 262144);
  assert.equal(ds.domain.maxPixels, 4194304);
});

test('硅基流动的 qwen-image-edit 不收尺寸字段', () => {
  const size = detectSizeRule('Qwen/Qwen-Image-Edit-2509', SILICONFLOW);
  assert.equal(size.size.mode, 'none');
});

test('同一族模型在魔搭是宽高串、上限 1664', () => {
  const size = detectSizeRule('Qwen/Qwen-Image', MODELSCOPE);
  assert.equal(size.size.mode, 'wh-string');
  assert.equal(size.size.field, 'size');
  assert.equal(size.domain.multiple, 16);
  assert.equal(size.domain.maxSide, 1664);
});

test('qwen-image 在未知网关落到兜底规则，由用户覆盖', () => {
  // 硅基流动/百炼的主机指纹都不匹配，按设计走最后那条 OpenAI 兼容兜底（发 size），
  // 不要它的形态就由模型选项覆盖。
  const fallback = detectSizeRule('qwen-image-3.0-pro', 'https://gateway.example/v1');
  assert.equal(fallback.size.mode, 'wh-string');
  assert.equal(fallback.size.field, 'size');
  assert.equal(fallback.domain.multiple, 1);
});

/* ------------------------------------------------------------ 主机隔离 */

test('主机指纹压过只按模型名匹配的规则', () => {
  // gpt-image 模型在 OpenRouter 上走的是比例，不是 WxH 的 size。
  const openrouter = detectSizeRule('openai/gpt-image-1', OPENROUTER);
  assert.equal(openrouter.size.mode, 'aspect');
  assert.equal(openrouter.size.field, 'aspect_ratio');

  // Azure 的 gpt-image 与自家 OpenAI 尺寸域一致，但质量档位少了 xhigh / max。
  const azure = detectQualityRule('gpt-image-1', 'https://myres.openai.azure.com');
  assert.deepEqual(azure.quality.options, ['low', 'medium', 'high', 'auto']);
});

test('Together 与 Stability 的主机形态来自主机而不是模型名', () => {
  const together = detectSizeRule('Qwen/Qwen3-Image', 'https://api.together.xyz/v1');
  assert.equal(together.size.mode, 'wh-fields');

  const stability = detectSizeRule('core', 'https://api.stability.ai');
  assert.equal(stability.size.mode, 'aspect');
  assert.equal(stability.size.field, 'aspect_ratio');
  assert.equal(stability.domain.hint, 'fixedPixels');
});

/* ------------------------------------------------------------- 温度质量 */

test('ideogram 的质量字段是 rendering_speed 且需要大写映射', () => {
  const quality = detectQualityRule('ideogram-4');
  assert.equal(quality.quality.field, 'rendering_speed');
  assert.deepEqual(quality.quality.options, ['turbo', 'default', 'quality']);
  assert.deepEqual(quality.quality.map, { turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' });
  assert.equal(quality.quality.default, 'default');
});

test('没有质量声明的模型返回 null，不发质量字段', () => {
  assert.equal(detectQualityRule('seedream-5.0'), null);
  assert.equal(detectQualityRule('Qwen/Qwen-Image', SILICONFLOW), null);
});

/* ------------------------------------------------------------------ 未命中 */

/* ------------------------------------------------- 兜底与「真的没有」 */

test('认不出的模型落兜底尺寸规则，质量仍然是没有', () => {
  // 尺寸：兜底规则（match 通配、无主机）保证中转站不会突然不发 size。
  for (const rule of [detectSizeRule('some-private-model'), detectSizeRule('some-private-model', 'https://gateway.example/v1')]) {
    assert.ok(rule, '尺寸必须有兜底，未命中不许变成"不发"');
    assert.equal(rule.size.mode, 'wh-string');
    assert.equal(rule.size.field, 'size');
    assert.equal(rule.domain.multiple, 1);
  }
  // 质量没有兜底：没有质量声明的模型就是不报档位。
  assert.equal(detectQualityRule('some-private-model'), null);
  assert.equal(detectQualityRule('some-private-model', 'https://gateway.example/v1'), null);
  // 空模型名什么都不命中。
  assert.equal(detectSizeRule(''), null);
  assert.equal(detectQualityRule(''), null);
});

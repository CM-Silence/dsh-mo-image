import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, sizePolicyFor, sizeSpecFor, fitSize, prepareGenerate } from '../lib/adapters.js';

/* 各平台的尺寸形态：字段名、分隔符、档位、比例都得跟官方文档对齐。 */

// 尺寸策略按「provider(baseUrl) + 模型名」查规则表；adapter 只在要 execute 时用。
const providerFor = (baseUrl, extra) => Object.assign({ baseUrl: baseUrl, key: 'k' }, extra || {});
const adapterFor = (baseUrl, model, extra) => resolveAdapter(providerFor(baseUrl, extra), model);

test('ideogram uses letter-x aspect ratios, never a colon', () => {
  const policy = sizePolicyFor(providerFor('https://api.ideogram.ai'), 'ideogram-3');
  assert.equal(policy.control, 'aspect');
  assert.ok(policy.aspects.includes('16x9'));
  assert.ok(!policy.aspects.includes('16:9'));
});

test('ideogram sends the aspect ratio with an x', async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/a.png' }] }), { status: 200 });
  };
  const adapter = adapterFor('https://api.ideogram.ai', 'ideogram-3');
  await assert.rejects(() => adapter.execute('generate', { baseUrl: 'https://api.ideogram.ai', key: 'k' }, {
    model: 'ideogram-3', prompt: 'p', fitted: { width: 1600, height: 900, size: '1600x900', aspect: '16:9' }
  }, undefined));
  const form = calls[0].init.body;
  assert.equal(form.get('aspect_ratio'), '16x9');
});

test('gemini tier sets differ per model', () => {
  const flash = sizePolicyFor(providerFor('https://generativelanguage.googleapis.com/v1beta'), 'gemini-3.1-flash-image');
  assert.equal(flash.control, 'aspect');
  assert.deepEqual(flash.tiers.map((tier) => tier.value), ['512', '1K', '2K', '4K']);
  const pro = sizePolicyFor(providerFor('https://generativelanguage.googleapis.com/v1beta'), 'gemini-3-pro-image');
  assert.deepEqual(pro.tiers.map((tier) => tier.value), ['1K', '2K', '4K']);
});

test('xai only has 1k and 2k, lowercase', () => {
  const policy = sizePolicyFor(providerFor('https://api.x.ai/v1'), 'grok-imagine-image');
  assert.deepEqual(policy.tiers.map((tier) => tier.value), ['1k', '2k']);
});

test('stability exposes the nine documented ratios', () => {
  const policy = sizePolicyFor(providerFor('https://api.stability.ai'), 'core');
  assert.equal(policy.control, 'aspect');
  assert.deepEqual(policy.aspects, ['21:9', '16:9', '3:2', '5:4', '1:1', '4:5', '2:3', '9:16', '9:21']);
  assert.equal(policy.hint, 'fixedPixels');
});

test('bfl splits between flux-2 width/height and flux-3 ratio+tier', () => {
  const flux2 = sizePolicyFor(providerFor('https://api.bfl.ai/v1'), 'flux-2-pro');
  assert.equal(flux2.control, 'wh');
  assert.equal(flux2.maxPixels, 4194304);
  const flux3 = sizePolicyFor(providerFor('https://api.bfl.ai/v1'), 'flux-3-image');
  assert.equal(flux3.control, 'aspect');
  assert.deepEqual(flux3.tiers.map((tier) => tier.value), ['768sq', '1k', '1.5k', '2k', '4k']);
});

test('recraft picks the pixel table that belongs to the model family', () => {
  const oneK = sizePolicyFor(providerFor('https://external.api.recraft.ai/v1'), 'recraftv4_1');
  assert.equal(oneK.control, 'preset');
  assert.ok(oneK.allowed.includes('1344x768'), '1K family 16:9');
  const twoK = sizePolicyFor(providerFor('https://external.api.recraft.ai/v1'), 'recraftv4_1_pro');
  assert.ok(twoK.allowed.includes('2688x1536'), '2K family 16:9');
  assert.ok(!twoK.allowed.includes('1344x768'), 'the 1K table must not leak into a pro model');
});

test('openrouter wants ratio only for models without a resolution parameter', () => {
  const gemini = sizePolicyFor(providerFor('https://openrouter.ai/api/v1'), 'google/gemini-3.1-flash-image');
  assert.deepEqual(gemini.tiers.map((tier) => tier.value), ['512', '1K', '2K', '4K']);
  const flux = sizePolicyFor(providerFor('https://openrouter.ai/api/v1'), 'black-forest-labs/flux.2-pro');
  assert.equal(flux.tiers, undefined);
});

test('siliconflow drops image_size for the edit models and keeps the per-model tables', () => {
  const edit = sizePolicyFor(providerFor('https://api.siliconflow.cn/v1'), 'Qwen/Qwen-Image-Edit');
  assert.deepEqual(edit.wire, []);
  const kolors = sizePolicyFor(providerFor('https://api.siliconflow.cn/v1'), 'Kwai-Kolors/Kolors');
  assert.ok(kolors.allowed.includes('960x1280'));
});

test('modelscope caps Qwen-Image at 1664 and FLUX at 1024', () => {
  const qwen = sizePolicyFor(providerFor('https://api-inference.modelscope.cn'), 'Qwen/Qwen-Image-2.1');
  assert.equal(qwen.maxSide, 1664);
  const flux = sizePolicyFor(providerFor('https://api-inference.modelscope.cn'), 'black-forest-labs/FLUX.1-dev');
  assert.equal(flux.maxSide, 1024);
});

test('wanx accepts the documented wan2.6 recommendation table and no 1MP floor', () => {
  const policy = sizePolicyFor(providerFor('https://dashscope.aliyuncs.com/api/v1', { adapter: 'dashscope-wanx' }), 'wan2.6-t2i');
  assert.ok(policy.allowed.includes('1472x1104'));
  assert.equal(policy.minPixels, undefined, 'the doc contradicts itself, so no hard pixel floor');
});

test('wan2.7 is the one wanx model with 1K/2K/4K tiers', () => {
  const pro = sizePolicyFor(providerFor('https://dashscope.aliyuncs.com/api/v1', { adapter: 'dashscope-wanx' }), 'wan2.7-image-pro');
  assert.equal(pro.control, 'preset');
  assert.deepEqual(pro.tiers.map((tier) => tier.value), ['1K', '2K', '4K']);
  assert.equal(pro.maxPixels, 16777216);
  const plain = sizePolicyFor(providerFor('https://dashscope.aliyuncs.com/api/v1', { adapter: 'dashscope-wanx' }), 'wan2.7-image');
  assert.deepEqual(plain.tiers.map((tier) => tier.value), ['1K', '2K']);
  assert.equal(plain.maxPixels, 4194304);
});

test('ideogram transparent sends aspect plus output_resolution', async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/t.png' }] }), { status: 200 });
  };
  const provider = { baseUrl: 'https://api.ideogram.ai', key: 'k' };
  const adapter = adapterFor('https://api.ideogram.ai', 'ideogram-4-transparent');
  const policy = sizePolicyFor(provider, 'ideogram-4-transparent');
  assert.deepEqual(policy.tiers.map((tier) => tier.value), ['1k', '2k', '4k', '8k']);
  await assert.rejects(() => adapter.execute('generate', provider, {
    model: 'ideogram-4-transparent', prompt: 'p',
    fitted: { width: 1024, height: 1024, size: '1024x1024', aspect: '1:1', tier: '2k' }
  }, undefined));
  const form = calls[0].init.body;
  assert.equal(form.get('aspect_ratio'), '1x1');
  assert.equal(form.get('output_resolution'), '2k');
});

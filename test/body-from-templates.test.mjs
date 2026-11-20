/**
 * 任务 7'：通用请求体由字段模板组装（docs/…/2026-11-16-model-size-quality-rules.md）。
 *
 * 这一轮只搬不改：行为基线在 test/adapter-body-regression.test.mjs，33 条一个字节都不许动。
 * 所以这里锁的是**新能力**——协议不再持有字段名以后，body 跟着模板走：
 *
 *   1. 模型选项里改了某个逻辑字段的路径，body 就换位置；留空时跟随预设；
 *   2. 参考图只在编辑方向给（生成体里不该冒出 image / image_url）；
 *   3. 没命中预设也没命中规则的网关按 OpenAI 兼容兜底（最大的人群：中转站）；
 *   4. 协议自己拼 body 时通用组装不参与（那条路走不到，别让模板往死路径塞字段）；
 *   5. 收不收质量由 `fields.quality` 决定，协议上不再有 acceptsQuality。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAdapter, prepareGenerate, prepareEdit, prepareAsync, fitSize, qualityOptionsFor
} from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const OMIT = { omit: true, size: 'none' };

const IMAGE = { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };

function siliconflowProvider(extra) {
  return Object.assign({
    adapter: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', key: 'k'
  }, extra || {});
}

/* --------------------------------------------------- 覆盖 > 规则 > 预设 */

test('模型选项里改了 prompt 的路径，body 就写到那儿', () => {
  const provider = siliconflowProvider({
    modelOptions: { 'Qwen/Qwen-Image': { fields: { prompt: { path: 'input.prompt' } } } }
  });
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'Qwen/Qwen-Image', prompt: 'a cat', fitted: OMIT
  }, new Set()).body);
  assert.deepEqual(body.input, { prompt: 'a cat' });
  assert.equal(body.prompt, undefined, '旧的字段位置不该还留着');
});

test('模型选项留空时跟随预设', () => {
  const provider = siliconflowProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'Qwen/Qwen-Image', prompt: 'a cat', negativePrompt: 'blurry', fitted: OMIT
  }, new Set()).body);
  assert.equal(body.prompt, 'a cat');
  assert.equal(body.negative_prompt, 'blurry');
  assert.equal(body.input, undefined);
});

test('模型选项可以把负面词改成拼进提示词，而不是单开一个字段', () => {
  const provider = siliconflowProvider({
    modelOptions: {
      'Qwen/Qwen-Image': { fields: { negative: { appendToPrompt: ' | avoid: ' } } }
    }
  });
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'Qwen/Qwen-Image', prompt: 'a cat', negativePrompt: 'blurry', fitted: OMIT
  }, new Set()).body);
  assert.equal(body.prompt, 'a cat | avoid: blurry');
  assert.equal(body.negative_prompt, undefined);
});

/* ------------------------------------------------ 参考图只在编辑方向给 */

test('生成体里没有参考图，编辑体里才有', () => {
  const provider = siliconflowProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image');
  const input = { model: 'Qwen/Qwen-Image', prompt: 'a cat', fitted: OMIT, images: [IMAGE] };

  const generated = JSON.parse(prepareGenerate(adapter, provider, input, new Set()).body);
  assert.equal(generated.image, undefined);
  assert.equal(generated.image_url, undefined);

  const edited = JSON.parse(prepareEdit(adapter, provider, input, new Set(), 'image').body);
  assert.equal(edited.image, 'data:image/png;base64,' + PNG_1PX);
});

test('multipart 编辑端点的参考图字段名也来自模板', () => {
  const provider = { adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3000/v1', key: 'k' };
  const adapter = resolveAdapter(provider, 'flux-1-schnell');
  const built = prepareEdit(adapter, provider, {
    model: 'flux-1-schnell', prompt: 'a cat', fitted: OMIT, images: [IMAGE]
  }, new Set(), 'image[]');
  // FormData：文件和普通字段混在一起，只看参考图那一条。
  const file = built.body.get('image[]');
  assert.ok(file, '参考图应该挂在 image[] 上');
  assert.equal(file.name, 'ref.png');
});

/* ------------------------------------------------------- OpenAI 兼容兜底 */

test('嵌套尺寸路径也能被兼容性重试摘掉（drops 里是上游点名的线上字段名）', () => {
  // 万相的提交体是 { model, input, parameters: { size, n } }：尺寸规则写的是 parameters.size，
  // 但上游报错只会说 "unknown parameter: size"，两条名字都要能命中。
  const provider = { adapter: 'dashscope-wanx', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', key: 'k' };
  const model = 'wanx2.1-t2i-turbo';
  const adapter = resolveAdapter(provider, model);
  const input = { model, prompt: 'a cat', fitted: fitSize(provider, '1024x1024', model) };

  const kept = JSON.parse(prepareAsync(adapter, provider, input, new Set()).body);
  assert.equal(kept.parameters.size, '1024*1024');

  const dropped = JSON.parse(prepareAsync(adapter, provider, input, new Set(['size'])).body);
  assert.equal(dropped.parameters.size, undefined, '上游说不认 size，parameters.size 也要摘掉');
  assert.equal(dropped.parameters.n, 1, '别的参数不动');
  assert.equal(dropped.input.prompt, 'a cat');
});

test('没命中预设也没命中规则的网关按 OpenAI 兼容兜底', () => {
  const provider = { baseUrl: 'https://relay.invalid/v1', key: 'k' };
  const adapter = resolveAdapter(provider, 'mystery-image-v1');
  assert.equal(adapter.id, 'openai-images');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'mystery-image-v1', prompt: 'a cat', negativePrompt: 'blurry', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new Set()).body);
  assert.deepEqual(Object.keys(body).sort(), ['model', 'n', 'negative_prompt', 'prompt', 'size']);
  assert.equal(body.size, '1024x1024', '兜底仍然发尺寸（尺寸规则最后一条就是 OpenAI 兼容）');
});

test('协议自己拼 body 时通用组装不参与，只保留尺寸那条死路径', () => {
  const provider = { adapter: 'google-gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', key: 'k' };
  const adapter = resolveAdapter(provider, 'gemini-2.5-flash-image');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'gemini-2.5-flash-image', prompt: 'a cat', fitted: OMIT
  }, new Set()).body);
  // gemini 的尺寸是比例 + 档位，encoding 对 prompt 形态返回 {}，所以这里是空 body；
  // 关键是模板别把 contents[] / text 塞进一个 execute() 根本不用的 body。
  assert.deepEqual(body, {});
});

/* ------------------------------------------------------------ 质量闸门 */

test('收不收质量由 fields.quality 决定，而不是协议上的 acceptsQuality', () => {
  const official = { baseUrl: 'https://api.openai.com/v1', adapter: 'gpt-image' };
  assert.deepEqual(
    qualityOptionsFor(official, 'gpt-image-1.5', resolveAdapter(official, 'gpt-image-1.5'))
      .options.map((item) => item.value),
    ['off', 'low', 'medium', 'high', 'auto']
  );

  // 中转站上的 gpt-image 也收：openai 预设的 fields.quality 在那里照样生效。
  const relay = { baseUrl: 'https://relay.example.com/v1' };
  assert.ok(
    qualityOptionsFor(relay, 'gpt-image-2.5-flare', resolveAdapter(relay, 'gpt-image-2.5-flare')),
    '中转站上的 gpt-image 不该丢掉质量档位'
  );

  // 自己拼 body、没有预设的协议不套用通用兜底，所以不会凭模型名多出档位。
  const chat = { baseUrl: 'https://relay.example.com/v1', adapter: 'openai-chat' };
  assert.equal(
    qualityOptionsFor(chat, 'gpt-image-2.5-flare', resolveAdapter(chat, 'gpt-image-2.5-flare')),
    null,
    'openai-chat 没有质量字段'
  );
});

test('质量档位是 off 时 body 里连 quality 这个键都没有', () => {
  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'gpt-image' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', quality: 'off', fitted: OMIT
  }, new Set()).body);
  assert.equal(body.quality, undefined);
});

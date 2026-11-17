/**
 * 参考图的「宿主声明」：能力清单里多出来的 `image` 一栏，以及 `fields.image = null`
 * （显式不发）能不能原样落盘、读回来还是「不发」。
 *
 * 「支持参考图」这个勾选框的默认值只能来自宿主：面板自己猜不出这家网关把参考图发到哪
 * （预设 + 模型规则才算得出来）。所以 capabilityManifest 每条模型多给一个 `image`：
 * 预设/规则声明的那条模板，**不含用户覆盖**——面板拿它当默认勾选值，取消勾选写的是
 * `fields.image = null`，要是把覆盖层算进来，取消一次就再也继承不回预设的模板了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { capabilityManifest, normalizeConfig } from '../lib/index.js';
import { applyFields, multipartFields, resolveFields } from '../lib/field-templates.js';

/** 某条模型的 image 能力。 */
function imageOf(provider, model) {
  const manifest = capabilityManifest({ providers: [provider] });
  const entry = manifest[0].models.find((item) => item.model === model);
  assert.ok(entry, model + ' 不在能力清单里');
  return entry.image === undefined ? undefined : entry.image;
}

test('能力清单给每条模型一栏 image：预设声明的 multipart 模板', () => {
  assert.deepEqual(imageOf({
    id: 'p1', baseUrl: 'https://api.openai.com/v1', adapter: '', models: ['gpt-image-2.5-flare']
  }, 'gpt-image-2.5-flare'), { multipart: 'image[]' });
});

test('能力清单的 image 跟着模型规则走：按序号展开的那一族', () => {
  assert.deepEqual(imageOf({
    id: 'p2', baseUrl: 'https://api.bfl.ai', adapter: 'bfl', models: ['flux-2-pro']
  }, 'flux-2-pro'), { numbered: 'input_image', as: 'dataUrl' });
});

test('预设说「不发参考图」的模型：image 一栏是 null', () => {
  // gemini 的参考图是 contents[].parts[].inlineData，六种模板形状表达不了，预设里明确写 null。
  assert.equal(imageOf({
    id: 'p3', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    adapter: 'google-gemini', models: ['gemini-2.5-flash-image']
  }, 'gemini-2.5-flash-image'), null);
});

test('自己在 execute() 里拼 body、规则也没声明的模型：image 一栏是 null', () => {
  assert.equal(imageOf({
    id: 'p4', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-chat', models: ['relay-chat-model']
  }, 'relay-chat-model'), null);
});

test('image 能力只看声明层：用户覆盖不参与（取消勾选后还能继承回来）', () => {
  const provider = {
    id: 'p1', baseUrl: 'https://api.openai.com/v1', adapter: '', models: ['gpt-image-2.5-flare'],
    modelOptions: {
      'gpt-image-2.5-flare': {
        fields: { image: null },
        // 覆盖层里就算写了别的形状，也不该改变「宿主声明的是什么」。
        fieldsAs: { image: 'base64' }
      }
    }
  };
  assert.deepEqual(imageOf(provider, 'gpt-image-2.5-flare'), { multipart: 'image[]' },
    '覆盖层写 null 是「这一轮不发」，不是「宿主没声明」');
});

test('用户覆盖换了个形状也不影响声明层', () => {
  const provider = {
    id: 'p1', baseUrl: 'https://api.openai.com/v1', adapter: '', models: ['gpt-image-2.5-flare'],
    modelOptions: { 'gpt-image-2.5-flare': { fields: { image: { path: 'image_url', as: 'url' } } } }
  };
  assert.deepEqual(imageOf(provider, 'gpt-image-2.5-flare'), { multipart: 'image[]' });
});

test('fields.image = null 落盘后还是 null：显式不发不是「没配」', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'Relay', baseUrl: 'https://relay.example.com/v1', adapter: 'openai-images',
      models: ['m1'], names: {}, modelOptions: { m1: { fields: { image: null } } }
    }],
    active: { providerId: 'p1', model: 'm1' }
  });
  const entry = config.providers[0].modelOptions.m1;
  assert.deepEqual(entry.fields, { image: null }, 'null 必须原样留下来');
});

test('explicit no-send reaches the request: 两个出口都不产出参考图字段', () => {
  const fields = resolveFields({ override: { image: null }, preset: { image: { multipart: 'image[]' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), { image: null }, '覆盖层写 null 时后面两层不许把它盖掉');
  const image = { buffer: Buffer.from('png'), contentType: 'image/png' };
  assert.deepEqual(applyFields({ prompt: 'hi' }, fields, { image: image }), { prompt: 'hi' },
    'JSON body 里没有参考图');
  assert.deepEqual(multipartFields(fields, { image: [image] }, [image]), [],
    'multipart 表单里也没有参考图');
});

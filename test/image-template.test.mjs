/**
 * 参考图字段模板的两处**静默失败**：
 *
 *   1. multipart 端点 + `{ path: 'image[]' }`：字段名与端点 `editFields[0]` 相等，
 *      imageTemplateFor 原样返回 path 形状；multipartFields 只认 multipart 形状，
 *      于是 FormData 里一个文件项都没有——参考图凭空消失，上游只当纯文生图处理。
 *   2. `image: null / false`（显式「不发参考图」）：imageTemplateFor 把它当成「没配」，
 *      回落到默认字段，JSON 与 multipart 两个出口都把图发了出去。
 *
 * 两层各锁一组：字段模板层（imageTemplateFor 的产物交给 multipartFields / applyFields），
 * 请求体层（prepareEdit 真正组出来的 FormData / JSON）。对照组锁住三种旧形状不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { imageTemplateFor, resolveAdapter, prepareEdit } from '../lib/adapters.js';
import { applyFields, multipartFields } from '../lib/field-templates.js';

const IMAGE = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', filename: 'ref.png' };

/* ------------------------------------------------- 字段模板层：形状选择 */

test('multipart 端点：path 名字里带 [] 的参考图模板换成 multipart 形状', () => {
  const template = imageTemplateFor({ image: { path: 'image[]' } }, 'image[]', true);
  assert.deepEqual(template, { multipart: 'image[]' });

  // 这个形状交给 field-templates 必须真的产出文件项，而不是被当成 JSON 路径忽略掉。
  assert.deepEqual(
    multipartFields({ image: template }, { image: [IMAGE] }, [IMAGE]).map((entry) => entry.name),
    ['image[]']
  );
  const body = {};
  applyFields(body, { image: template }, { image: [IMAGE] });
  assert.deepEqual(body, {}, 'multipart 形状不写 JSON body');
});

test('multipart 端点：path 与端点字段名相等时也算表单字段', () => {
  assert.deepEqual(imageTemplateFor({ image: { path: 'image' } }, 'image', true), { multipart: 'image' });
  // 换字段重试时以调用方点名的字段为准，别把 [] 带过去。
  assert.deepEqual(imageTemplateFor({ image: { path: 'image[]' } }, 'image', true), { multipart: 'image' });
});

test('显式不发：image 为 null / false 时没有参考图字段', () => {
  assert.equal(imageTemplateFor({ image: null }, 'image[]', true), null);
  assert.equal(imageTemplateFor({ image: false }, 'image[]', false), null);
  assert.equal(imageTemplateFor({ image: null }, 'image', false), null);
  // 「没有字段」在 field-templates 的两个出口里都是空结果，不会写出 image。
  assert.deepEqual(multipartFields({ image: null }, { image: [IMAGE] }, [IMAGE]), []);
  const body = {};
  applyFields(body, { image: null, prompt: { path: 'prompt' } }, { image: [IMAGE], prompt: 'a cat' });
  assert.deepEqual(body, { prompt: 'a cat' });
  // 完全没有这个键仍然是「没配」，沿用默认字段。
  assert.deepEqual(imageTemplateFor({}, 'image[]', true), { multipart: 'image[]' });
});

test('对照：path / multipart / numbered 三种旧形状的模板不变', () => {
  // path 名字与端点不同：仍然按端点字段名走 multipart。
  assert.deepEqual(imageTemplateFor({ image: { path: 'image' } }, 'image[]', true), { multipart: 'image[]' });
  // multipart 形状：名字与调用方点名的字段不同时仍按点名的那一个发（旧行为），
  // 相等时原样保留；到 JSON 端点仍然换成 path + dataUrl。
  assert.deepEqual(imageTemplateFor({ image: { multipart: 'image' } }, 'image[]', true), { multipart: 'image[]' });
  assert.deepEqual(imageTemplateFor({ image: { multipart: 'image' } }, 'image', true), { multipart: 'image' });
  assert.deepEqual(
    imageTemplateFor({ image: { multipart: 'image' } }, 'image', false),
    { path: 'image', as: 'dataUrl' }
  );
  // numbered 与端点字段无关，仍然原样返回。
  assert.deepEqual(imageTemplateFor({ image: { numbered: 'input_image' } }, 'image', false), { numbered: 'input_image' });
  // JSON 端点上的 path[] 仍然原样（由 applyFields 追加），不受这次修复影响。
  assert.deepEqual(imageTemplateFor({ image: { path: 'image[]' } }, 'image[]', false), { path: 'image[]' });
});

/* ------------------------------------------------------ 请求体层：prepareEdit */

function openaiProvider(fields) {
  const provider = { adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3000/v1', key: 'k' };
  if (fields) provider.modelOptions = { 'flux-1-schnell': { fields } };
  return provider;
}

function editRequest(provider, field) {
  const model = 'flux-1-schnell';
  const adapter = resolveAdapter(provider, model);
  const input = { model, prompt: 'a cat', fitted: { omit: true, size: 'none' }, images: [IMAGE] };
  return prepareEdit(adapter, provider, input, new Set(), field).body;
}

function jsonEditBody(fields, field) {
  const provider = {
    adapter: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    key: 'k',
    modelOptions: { 'Qwen/Qwen-Image': { fields } }
  };
  const model = 'Qwen/Qwen-Image';
  const adapter = resolveAdapter(provider, model);
  const input = { model, prompt: 'a cat', fitted: { omit: true, size: 'none' }, images: [IMAGE] };
  return JSON.parse(prepareEdit(adapter, provider, input, new Set(), field).body);
}

test('prepareEdit（multipart）：fields.image 写成 path image[] 时请求体里有文件项', () => {
  const form = editRequest(openaiProvider({ image: { path: 'image[]' } }), 'image[]');
  assert.ok(form instanceof FormData);
  const file = form.get('image[]');
  assert.ok(file, '参考图不能凭空消失');
  assert.equal(file.name, 'ref.png');
  assert.equal(form.get('image'), null);
  assert.equal([...form.values()].filter((value) => typeof value !== 'string').length, 1);
});

test('prepareEdit（multipart）：image:null 时表单里没有 image 字段、没有文件项', () => {
  const form = editRequest(openaiProvider({ image: null }), 'image[]');
  assert.equal(form.get('image[]'), null);
  assert.equal(form.get('image'), null);
  assert.deepEqual([...form.values()].filter((value) => typeof value !== 'string'), []);
});

test('prepareEdit（JSON）：image:null 时 body 里不出现 image', () => {
  const body = jsonEditBody({ image: null }, 'image');
  assert.equal('image' in body, false);
  assert.equal(body.prompt, 'a cat');
});

test('对照：path / multipart / numbered 的现有请求体不变', () => {
  // path 名字与端点不同：仍然挂到端点的表单字段上。
  const remapped = editRequest(openaiProvider({ image: { path: 'image' } }), 'image[]');
  assert.ok(remapped.get('image[]'));

  // multipart 形状仍然按声明（或调用方点名）的字段名发送。
  const declared = editRequest(openaiProvider({ image: { multipart: 'image' } }), 'image');
  assert.ok(declared.get('image'));

  // 没有覆盖时仍然走默认模板（OpenAI 形状的 image[]）。
  const fallback = editRequest(openaiProvider(), 'image[]');
  assert.ok(fallback.get('image[]'));

  // numbered 仍然按序号展开进 JSON body。
  const numbered = jsonEditBody({ image: { numbered: 'input_image', as: 'dataUrl' } }, 'image');
  assert.match(numbered.input_image, /^data:image\/png;base64,/);
  assert.equal(numbered.image, undefined);

  // JSON 端点上普通的 path 模板照旧按 as 编码成 dataUrl。
  const plain = jsonEditBody({ image: { path: 'image', as: 'dataUrl' } }, 'image');
  assert.match(plain.image, /^data:image\/png;base64,/);
});

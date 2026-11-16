import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFields, resolveFields, multipartFields, promptParts
} from '../lib/field-templates.js';

/*
 * 字段模板：逻辑字段（prompt / negative / model / n / image）写进请求体的哪里。
 *
 * 能力就六种（外加编码形态 as），多一种都不加：
 *   1. 扁平 / 嵌套路径        { path: 'generationConfig.imageConfig.aspectRatio' }
 *   2. 数组追加               { path: 'input.messages[0].content[]' }
 *   3. 值包装                 { path: '...content[]', wrap: 'text' }
 *   4. 拼进提示词             { inPrompt: true } / { appendToPrompt: '\n\nAvoid: ' }
 *   5. 按序号展开             { numbered: 'input_image' }
 *   6. multipart 字段         { multipart: 'image[]' }
 * 红线：表达不了的网关单独做预设/协议，不往模板里加特性。
 *
 * values 的逻辑键是 { prompt, negative, model, n, image }；image 可以是单张
 * { buffer, contentType }，也可以是数组。promptParts 对额外逻辑键（如 size）同样
 * 生效——spec 里 openai-chat 的尺寸就是靠 appendToPrompt 拼进提示词的。
 */

const PNG = { buffer: Buffer.from('a'), contentType: 'image/png' };
const JPEG = { buffer: Buffer.from('b'), contentType: 'image/jpeg' };

/* --------------------------------------------------------------- 路径 */

test('扁平路径把值写进 body 顶层，数字不被转成字符串', () => {
  const body = {};
  const fields = { prompt: { path: 'prompt' }, model: { path: 'model' }, n: { path: 'n' } };
  const returned = applyFields(body, fields, { prompt: '一只猫', model: 'gpt-image-2.5-flare', n: 2 });
  assert.equal(returned, body);
  assert.deepEqual(body, { prompt: '一只猫', model: 'gpt-image-2.5-flare', n: 2 });
  assert.equal(typeof body.n, 'number');
});

test('嵌套路径 a.b.c 自动建出中间对象', () => {
  const body = {};
  applyFields(body, { model: { path: 'generationConfig.imageConfig.aspectRatio' } }, { model: '1:1' });
  assert.deepEqual(body, { generationConfig: { imageConfig: { aspectRatio: '1:1' } } });
});

test('嵌套写入复用已存在的中间对象，不动兄弟键', () => {
  const body = { generationConfig: { temperature: 0.9 } };
  applyFields(body, { model: { path: 'generationConfig.imageConfig.aspectRatio' } }, { model: '1:1' });
  assert.deepEqual(body, {
    generationConfig: { temperature: 0.9, imageConfig: { aspectRatio: '1:1' } }
  });
});

/* ----------------------------------------------------------- 数组追加 */

test('路径以 [] 结尾时追加到该数组末尾', () => {
  const body = {};
  applyFields(body, { image: { path: 'images[]', as: 'dataUrl' } }, { image: [PNG, JPEG] });
  assert.deepEqual(body, {
    images: ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg==']
  });
});

test('数组路径的中间段支持 [0] 下标，再调用一次继续追加', () => {
  const body = {};
  const fields = { prompt: { path: 'x[0].y[]' } };
  applyFields(body, fields, { prompt: '第一段' });
  applyFields(body, fields, { prompt: '第二段' });
  assert.deepEqual(body, { x: [{ y: ['第一段', '第二段'] }] });
});

test('数组路径缺省不包装，直接 push 值本身', () => {
  const body = {};
  applyFields(body, { negative: { path: 'negative[]' } }, { negative: '模糊' });
  assert.deepEqual(body, { negative: ['模糊'] });
});

/* ------------------------------------------------------------- 值包装 */

test('wrap 把追加项包成 { text: 值 }', () => {
  const body = {};
  const fields = { prompt: { path: 'input.messages[0].content[]', wrap: 'text' } };
  applyFields(body, fields, { prompt: '一只猫' });
  assert.deepEqual(body, { input: { messages: [{ content: [{ text: '一只猫' }] }] } });
});

/* ------------------------------------------------------- 拼进提示词 */

test('inPrompt 的字段不写进 body，由 promptParts 拼进提示词', () => {
  const fields = { prompt: { path: 'prompt' }, negative: { inPrompt: true } };
  const values = { prompt: '一只猫', negative: '模糊' };

  const body = {};
  applyFields(body, fields, values);
  assert.deepEqual(body, { prompt: '一只猫' });

  const { prompt, parts } = promptParts(fields, values);
  assert.equal(prompt, '一只猫\n模糊');
  assert.deepEqual(parts, [{ field: 'negative', text: '\n模糊' }]);
});

test('appendToPrompt 用给定前缀把值拼到提示词末尾', () => {
  const fields = { prompt: { path: 'prompt' }, size: { appendToPrompt: '\n\nSize: ' } };
  const { prompt, parts } = promptParts(fields, { prompt: '一只猫', size: '1024x1024' });
  assert.equal(prompt, '一只猫\n\nSize: 1024x1024');
  assert.deepEqual(parts, [{ field: 'size', text: '\n\nSize: 1024x1024' }]);
});

test('promptParts 跳过显式不发的字段，没有提示词时给空串', () => {
  const fields = { negative: { inPrompt: true } };
  assert.deepEqual(promptParts(fields, { prompt: '一只猫', negative: null }), {
    prompt: '一只猫', parts: []
  });
  assert.deepEqual(promptParts(fields, { prompt: '一只猫', negative: false }), {
    prompt: '一只猫', parts: []
  });
  assert.deepEqual(promptParts(fields, {}), { prompt: '', parts: [] });
});

/* --------------------------------------------------------- 按序号展开 */

test('numbered 把多图展开成 input_image / input_image_2 / input_image_3', () => {
  const body = {};
  const fields = { image: { numbered: 'input_image', as: 'url' } };
  applyFields(body, fields, { image: ['https://a/1.png', 'https://a/2.png', 'https://a/3.png'] });
  assert.deepEqual(body, {
    input_image: 'https://a/1.png',
    input_image_2: 'https://a/2.png',
    input_image_3: 'https://a/3.png'
  });
});

/* ------------------------------------------------------------ multipart */

test('multipart 字段不进 JSON body，由 multipartFields 返回 { name, value }', () => {
  const fields = {
    prompt: { path: 'prompt' },
    image: { multipart: 'image[]' },
    n: { multipart: 'num_images' }
  };

  const body = {};
  applyFields(body, fields, { prompt: '一只猫', image: [PNG, JPEG], n: 2 });
  assert.deepEqual(body, { prompt: '一只猫' }); // multipart 的两个都不进 body

  assert.deepEqual(multipartFields(fields, { n: 2 }, [PNG, JPEG]), [
    { name: 'image[]', value: PNG.buffer, contentType: 'image/png' },
    { name: 'image[]', value: JPEG.buffer, contentType: 'image/jpeg' },
    { name: 'num_images', value: '2' }
  ]);
});

test('multipartFields 不传 images 时退回 values.image', () => {
  assert.deepEqual(multipartFields({ image: { multipart: 'image' } }, { image: PNG }), [
    { name: 'image', value: PNG.buffer, contentType: 'image/png' }
  ]);
});

/* ----------------------------------------------------------- 编码形态 */

test("as:'dataUrl' 把图片编成 data:<contentType>;base64,…", () => {
  const body = {};
  applyFields(body, { image: { path: 'image', as: 'dataUrl' } }, { image: PNG });
  assert.deepEqual(body, { image: 'data:image/png;base64,YQ==' });

  const jpegBody = {};
  applyFields(jpegBody, { image: { path: 'image', as: 'dataUrl' } }, { image: JPEG });
  assert.deepEqual(jpegBody, { image: 'data:image/jpeg;base64,Yg==' });
});

test("as:'base64' 只给 base64 部分（A1111 的 init_images 是数组）", () => {
  const body = {};
  applyFields(body, { image: { path: 'init_images[]', as: 'base64' } }, { image: PNG });
  assert.deepEqual(body, { init_images: ['YQ=='] });
});

test("as:'base64' 收到裸 Buffer 时按它自己的字节编码", () => {
  // Buffer 自带 .buffer（那是 ArrayBuffer 池），不能被当成图片对象去读 .buffer，
  // 否则编出来的是整块 8KB 池，不是这两个字节。
  const body = {};
  applyFields(body, { image: { path: 'image', as: 'base64' } }, { image: Buffer.from('ab') });
  assert.deepEqual(body, { image: 'YWI=' });
});

test("as:'url' 原样透传字符串", () => {
  const body = {};
  applyFields(body, { image: { path: 'image_url', as: 'url' } }, { image: 'https://a/ref.png' });
  assert.deepEqual(body, { image_url: 'https://a/ref.png' });
});

test('非数组追加路径：单图写字符串，多图写数组', () => {
  const fields = { image: { path: 'image', as: 'dataUrl' } };

  const one = {};
  applyFields(one, fields, { image: [PNG] });
  assert.deepEqual(one, { image: 'data:image/png;base64,YQ==' });

  const two = {};
  applyFields(two, fields, { image: [PNG, JPEG] });
  assert.deepEqual(two, { image: ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='] });
});

/* ------------------------------------------------------- 三层合并 */

test('resolveFields 逐字段取 override → rule → preset 的第一层', () => {
  const preset = { prompt: { path: 'prompt' }, image: { path: 'image[]', as: 'dataUrl' } };
  const rule = { prompt: { path: 'input.prompt' }, negative: { path: 'negative_prompt' } };
  const override = { negative: { path: 'avoid' }, n: { path: 'batch' } };
  assert.deepEqual(resolveFields({ override, rule, preset }), {
    prompt: { path: 'input.prompt' },
    negative: { path: 'avoid' },
    n: { path: 'batch' },
    image: { path: 'image[]', as: 'dataUrl' }
  });
});

test('高优先级层没有这个键时才回落到低优先级层', () => {
  const preset = { prompt: { path: 'prompt' }, model: { path: 'model' } };
  const rule = { prompt: { path: 'input.prompt' } };
  assert.deepEqual(resolveFields({ override: {}, rule, preset }), {
    prompt: { path: 'input.prompt' },
    model: { path: 'model' }
  });
});

test('显式 null 表示不发，不会被规则层或预设层盖掉', () => {
  const preset = { image: { path: 'image[]', as: 'dataUrl' } };
  const rule = { image: { path: 'input_image' } };
  const fields = resolveFields({ override: { image: null }, rule, preset });
  assert.ok('image' in fields, '"不发"必须作为结果保留下来，不能消失');
  assert.equal(fields.image, null);

  const body = {};
  applyFields(body, fields, { image: PNG });
  assert.deepEqual(body, {});
});

test('显式 false 同样表示不发', () => {
  const fields = resolveFields({ override: { n: false }, rule: { n: { path: 'n' } } });
  assert.equal(fields.n, false);

  const body = {};
  applyFields(body, fields, { n: 2 });
  assert.deepEqual(body, {});
});

test('三层都没有或都是空层时返回空对象', () => {
  assert.deepEqual(resolveFields({}), {});
  assert.deepEqual(resolveFields(), {});
  assert.deepEqual(resolveFields({ override: {}, rule: {}, preset: {} }), {});
});

test('层里的条目既不是对象也不是 null/false 时抛错', () => {
  assert.throws(() => resolveFields({ rule: { prompt: 'prompt' } }), /字段模板/);
  assert.throws(() => resolveFields({ rule: { prompt: 42 } }), /字段模板/);
});

/* --------------------------------------------------------- 早失败 */

test('无法识别的模板形状一律抛错', () => {
  const bad = [
    ['空模板', {}],
    ['path 是空串', { path: '' }],
    ['wrap 没跟数组路径', { path: 'x', wrap: 'text' }],
    ['path 与 inPrompt 同时出现', { path: 'prompt', inPrompt: true }],
    ['[] 出现在路径中间', { path: 'x[].y' }],
    ['下标不是数字', { path: 'a[b]' }],
    ['未知编码形态', { path: 'image', as: 'hex' }],
    ['不认识的键', { path: 'a', frobnicate: true }],
    ['numbered 与 path 同时出现', { numbered: 'input_image', path: 'a' }],
    ['multipart 与 path 同时出现', { multipart: 'image[]', path: 'a' }],
    ['numbered 不是字符串', { numbered: 42 }],
    ['multipart 带 as', { multipart: 'image[]', as: 'base64' }]
  ];
  for (const [name, spec] of bad) {
    assert.throws(() => applyFields({}, { x: spec }, { x: 'v' }), /字段模板/, name);
  }
});

test('模板先校验再写入，出错的模板不会留下半个 body', () => {
  const body = {};
  const fields = { prompt: { path: 'prompt' }, n: { path: 'n', as: 'hex' } };
  assert.throws(() => applyFields(body, fields, { prompt: '一只猫', n: 2 }), /字段模板/);
  assert.deepEqual(body, {});
});

test('fields 为空时 body 原样返回', () => {
  const body = { prompt: '一只猫' };
  assert.equal(applyFields(body, {}, {}), body);
  assert.equal(applyFields(body, undefined, {}), body);
  assert.deepEqual(body, { prompt: '一只猫' });
});

test('values 里没有这个字段时跳过它，空数组也不发', () => {
  const body = {};
  applyFields(body, { prompt: { path: 'prompt' }, negative: { path: 'negative_prompt' } },
    { prompt: '一只猫' });
  assert.deepEqual(body, { prompt: '一只猫' });

  const set = {};
  applyFields(set, { image: { path: 'image', as: 'dataUrl' } }, { image: [] });
  assert.deepEqual(set, {});

  const appended = {};
  applyFields(appended, { image: { path: 'images[]', as: 'dataUrl' } }, { image: [] });
  assert.deepEqual(appended, {});
});

test('路径与已有 body 结构冲突时抛错', () => {
  assert.throws(() => applyFields({ a: [] }, { x: { path: 'a.b' } }, { x: 'v' }), /字段模板/);
  assert.throws(() => applyFields({ a: '标量' }, { x: { path: 'a.b' } }, { x: 'v' }), /字段模板/);
  assert.throws(() => applyFields({ a: '标量' }, { x: { path: 'a[]' } }, { x: 'v' }), /字段模板/);
});

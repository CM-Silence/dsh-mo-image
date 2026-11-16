/**
 * 异步四协议（bfl / fal / replicate / modelscope）的提交体快照。
 *
 * 这组断言是「改造前后 body 逐字节一致」的证据：它只看真正要发出去的 JSON，
 * 不看实现怎么拼。先对着旧实现跑绿，再改实现，改完必须还是同一份 body。
 *
 * 每个协议覆盖：
 *   - 提示词 / 负面词的落点（负面词在 BFL/fal/replicate 是拼进 prompt，在魔搭是独立字段）；
 *   - 参考图的落点与形状（BFL 按序号展开、fal 单图/多图、replicate 看 Input schema、
 *     魔搭一张发字符串多张发数组）；
 *   - 协议自己决定的常量（output_format / num_images / size）与张数上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, preparePhaseAsync } from '../lib/adapters.js';
import { resetAsyncSchemaCache } from '../lib/adapters/async.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const DATA_URL = 'data:image/png;base64,' + PNG_1PX;

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

function image(name = 'ref.png') {
  return { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: name };
}

function images(count) {
  return Array.from({ length: count }, (_, index) => image('ref-' + (index + 1) + '.png'));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** 真实提交体：走 preparePhaseAsync，body 是最终要 POST 出去的那串 JSON。 */
async function submitted(adapter, provider, input) {
  const built = await preparePhaseAsync(adapter, provider, input, new AbortController().signal);
  return { path: built.path, body: JSON.parse(String(built.body)), note: String(built.note || '') };
}

/* ------------------------------------------------------------------ BFL */

const bflProvider = () => ({ baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl', key: 'k' });

test('bfl 提交体：prompt 拼负面词，宽高与 output_format，参考图按序号展开', async () => {
  const provider = bflProvider();
  const adapter = resolveAdapter(provider, 'flux-2-pro');
  assert.equal(adapter.id, 'bfl');

  const out = await submitted(adapter, provider, {
    model: 'flux-2-pro',
    prompt: 'a fox',
    negativePrompt: 'blurry',
    seed: 42,
    fitted: { width: 1024, height: 768, size: '1024x768' },
    images: images(2)
  });

  assert.equal(out.path, '/flux-2-pro');
  assert.deepEqual(out.body, {
    prompt: 'a fox\n\nAvoid: blurry',
    width: 1024,
    height: 768,
    output_format: 'png',
    seed: 42,
    input_image: DATA_URL,
    input_image_2: DATA_URL
  });
  assert.equal(out.note, '');
});

test('bfl 提交体：参考图按序号展开，最多 8 张', async () => {
  const provider = bflProvider();
  const adapter = resolveAdapter(provider, 'flux-2-pro');

  const out = await submitted(adapter, provider, {
    model: 'flux-2-pro', prompt: 'a fox', fitted, images: images(10)
  });

  const keys = Object.keys(out.body).sort();
  assert.deepEqual(keys, [
    'height', 'input_image', 'input_image_2', 'input_image_3', 'input_image_4',
    'input_image_5', 'input_image_6', 'input_image_7', 'input_image_8',
    'output_format', 'prompt', 'width'
  ]);
  assert.equal(out.body.input_image, DATA_URL);
  assert.equal(out.body.input_image_8, DATA_URL);
});

test('bfl 提交体：kontext 只发比例、output_format 与最多 4 张参考图', async () => {
  const provider = bflProvider();
  const adapter = resolveAdapter(provider, 'flux-kontext-pro');

  const out = await submitted(adapter, provider, {
    model: 'flux-kontext-pro', prompt: 'make it blue',
    fitted: { width: 1344, height: 768, size: '1344x768' }, images: images(6)
  });

  assert.deepEqual(out.body, {
    prompt: 'make it blue',
    aspect_ratio: '16:9',
    output_format: 'png',
    input_image: DATA_URL,
    input_image_2: DATA_URL,
    input_image_3: DATA_URL,
    input_image_4: DATA_URL
  });
});

test('bfl 提交体：FLUX 3 用 images 数组、带 resolution，不发 width/height 与 input_image', async () => {
  const provider = bflProvider();
  const adapter = resolveAdapter(provider, 'flux-3-image');

  const out = await submitted(adapter, provider, {
    model: 'flux-3-image', prompt: 'a fox',
    fitted: { width: 1344, height: 768, size: '1344x768', aspect: '16:9', tier: '1k' },
    images: images(2)
  });

  assert.deepEqual(out.body, {
    prompt: 'a fox',
    aspect_ratio: '16:9',
    resolution: '1k',
    images: [DATA_URL, DATA_URL]
  });
});

test('bfl 提交体：FLUX 3 没有参考图时不发 images', async () => {
  const provider = bflProvider();
  const adapter = resolveAdapter(provider, 'flux-3-image');

  const out = await submitted(adapter, provider, {
    model: 'flux-3-image', prompt: 'a fox',
    fitted: { width: 1344, height: 768, size: '1344x768', aspect: '16:9', tier: '1k' }
  });

  assert.equal(out.body.images, undefined);
});

/* ------------------------------------------------------------------ fal */

const falProvider = () => ({ baseUrl: 'https://queue.fal.run', adapter: 'fal', key: 'k' });

test('fal 提交体：prompt + num_images + output_format + image_size', async () => {
  const provider = falProvider();
  const adapter = resolveAdapter(provider, 'fal-ai/flux-2-pro');
  assert.equal(adapter.id, 'fal');

  const out = await submitted(adapter, provider, {
    model: 'fal-ai/flux-2-pro', prompt: 'a fox',
    fitted: { width: 1024, height: 768, size: '1024x768' }
  });

  assert.equal(out.path, '/fal-ai/flux-2-pro');
  assert.deepEqual(out.body, {
    prompt: 'a fox',
    num_images: 1,
    output_format: 'jpeg',
    image_size: { width: 1024, height: 768 }
  });
});

test('fal 提交体：负面词拼进 prompt', async () => {
  const provider = falProvider();
  const adapter = resolveAdapter(provider, 'fal-ai/flux-2-pro');

  const out = await submitted(adapter, provider, {
    model: 'fal-ai/flux-2-pro', prompt: 'a fox', negativePrompt: ' blurry ', fitted
  });

  assert.equal(out.body.prompt, 'a fox\n\nAvoid: blurry');
});

test('fal 提交体：单图走 image_url', async () => {
  const provider = falProvider();
  const adapter = resolveAdapter(provider, 'fal-ai/flux-pro/kontext');

  const out = await submitted(adapter, provider, {
    model: 'fal-ai/flux-pro/kontext', prompt: 'watercolor', fitted, images: images(1)
  });

  assert.deepEqual(out.body, {
    prompt: 'watercolor',
    num_images: 1,
    output_format: 'jpeg',
    image_size: { width: 1024, height: 1024 },
    image_url: DATA_URL
  });
});

test('fal 提交体：多图走 image_urls 数组，不再发 image_url', async () => {
  const provider = falProvider();
  const adapter = resolveAdapter(provider, 'fal-ai/flux-pro/kontext');

  const out = await submitted(adapter, provider, {
    model: 'fal-ai/flux-pro/kontext', prompt: 'watercolor', fitted, images: images(3)
  });

  assert.equal(out.body.image_url, undefined);
  assert.deepEqual(out.body.image_urls, [DATA_URL, DATA_URL, DATA_URL]);
});

test('fal 提交体：没有尺寸时不发 image_size', async () => {
  const provider = falProvider();
  const adapter = resolveAdapter(provider, 'fal-ai/flux-2-pro');

  const out = await submitted(adapter, provider, { model: 'fal-ai/flux-2-pro', prompt: 'a fox' });

  assert.equal(out.body.image_size, undefined);
  assert.deepEqual(out.body, { prompt: 'a fox', num_images: 1, output_format: 'jpeg' });
});

/* ------------------------------------------------------------ Replicate */

const replicateProvider = () => ({ baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8' });

/** 按给定 Input schema properties 打桩模型 schema 接口。 */
function stubSchema(properties, t) {
  resetAsyncSchemaCache();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (/\/models\/[^/]+\/[^/]+$/.test(target)) {
      return jsonResponse({
        latest_version: { openapi_schema: { components: { schemas: { Input: { properties } } } } }
      });
    }
    throw new Error('unexpected url ' + target);
  };
}

test('replicate 提交体：prompt 在 input.prompt，参考图字段与宽高来自 Input schema', async (t) => {
  stubSchema({
    prompt: { type: 'string' },
    image: { type: 'string', format: 'uri' },
    width: { type: 'integer' },
    height: { type: 'integer' }
  }, t);

  const provider = replicateProvider();
  const adapter = resolveAdapter(provider, 'acme/edit-model');
  assert.equal(adapter.id, 'replicate');

  const out = await submitted(adapter, provider, {
    model: 'acme/edit-model', prompt: 'watercolor', fitted, images: images(1)
  });

  assert.equal(out.path, '/models/acme/edit-model/predictions');
  assert.deepEqual(out.body, {
    input: { prompt: 'watercolor', image: DATA_URL, width: 1024, height: 1024 }
  });
  assert.equal(out.note, '');
});

test('replicate 提交体：负面词拼进 input.prompt', async (t) => {
  stubSchema({ prompt: { type: 'string' } }, t);

  const provider = replicateProvider();
  const adapter = resolveAdapter(provider, 'acme/plain-model');

  const out = await submitted(adapter, provider, {
    model: 'acme/plain-model', prompt: 'a fox', negativePrompt: 'blurry'
  });

  assert.deepEqual(out.body, { input: { prompt: 'a fox\n\nAvoid: blurry' } });
});

test('replicate 提交体：schema 的图片字段是数组时按数组发', async (t) => {
  stubSchema({ prompt: { type: 'string' }, images: { type: 'array' } }, t);

  const provider = replicateProvider();
  const adapter = resolveAdapter(provider, 'acme/multi-model');

  const out = await submitted(adapter, provider, {
    model: 'acme/multi-model', prompt: 'a fox', images: images(2)
  });

  assert.deepEqual(out.body.input.images, [DATA_URL, DATA_URL]);
});

test('replicate 提交体：schema 只收一张时只用第一张并给出说明', async (t) => {
  stubSchema({ prompt: { type: 'string' }, image: { type: 'string', format: 'uri' } }, t);

  const provider = replicateProvider();
  const adapter = resolveAdapter(provider, 'acme/single-model');

  const out = await submitted(adapter, provider, {
    model: 'acme/single-model', prompt: 'a fox', images: images(2)
  });

  assert.deepEqual(out.body.input, { prompt: 'a fox', image: DATA_URL });
  assert.match(out.note, /只接受一张参考图/);
});

test('replicate 提交体：schema 只声明 aspect_ratio 时按比例发', async (t) => {
  stubSchema({ prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9'] } }, t);

  const provider = replicateProvider();
  const adapter = resolveAdapter(provider, 'acme/aspect-model');

  const out = await submitted(adapter, provider, {
    model: 'acme/aspect-model', prompt: 'a fox',
    fitted: { width: 1344, height: 768, size: '1344x768' }
  });

  assert.deepEqual(out.body.input, { prompt: 'a fox', aspect_ratio: '16:9' });
});

test('replicate 提交体：拿不到 schema 时只发 input.prompt', async (t) => {
  resetAsyncSchemaCache();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => jsonResponse({ detail: 'not found' }, 404);

  const provider = replicateProvider();
  const adapter = resolveAdapter(provider, 'acme/gone-model');

  const out = await submitted(adapter, provider, { model: 'acme/gone-model', prompt: 'a fox', fitted });

  assert.deepEqual(out.body, { input: { prompt: 'a fox' } });
});

/* ----------------------------------------------------------- ModelScope */

const msProvider = (baseUrl = 'https://api-inference.modelscope.cn') => ({ baseUrl, key: 'ms' });

test('modelscope 提交体：model / prompt / size', async () => {
  const provider = msProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-2.1');
  assert.equal(adapter.id, 'modelscope');

  const out = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a red fox in the snow', fitted
  });

  assert.equal(out.path, 'https://api-inference.modelscope.cn/v1/images/generations');
  assert.deepEqual(out.body, {
    model: 'Qwen/Qwen-Image-2.1',
    prompt: 'a red fox in the snow',
    size: '1024x1024'
  });
});

test('modelscope 提交体：负面词是独立字段，空负面词不发', async () => {
  const provider = msProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-2.1');

  const withNegative = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a fox', negativePrompt: ' blurry ', fitted
  });
  assert.deepEqual(withNegative.body, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a fox', negative_prompt: 'blurry', size: '1024x1024'
  });

  const blank = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a fox', negativePrompt: '   ', fitted
  });
  assert.equal('negative_prompt' in blank.body, false);
});

test('modelscope 提交体：一张参考图发字符串，多张发数组', async () => {
  const provider = msProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-Edit');

  const single = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-Edit', prompt: 'paint it blue', fitted, images: images(1)
  });
  assert.deepEqual(single.body, {
    model: 'Qwen/Qwen-Image-Edit', prompt: 'paint it blue', size: '1024x1024', image_url: DATA_URL
  });

  const several = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-Edit', prompt: 'paint it blue', fitted, images: images(3)
  });
  assert.deepEqual(several.body.image_url, [DATA_URL, DATA_URL, DATA_URL]);
});

test('modelscope 提交体：参考图最多 10 张', async () => {
  const provider = msProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-Edit');

  const out = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-Edit', prompt: 'paint it blue', fitted, images: images(12)
  });

  assert.equal(out.body.image_url.length, 10);
});

test('modelscope 提交体：没有尺寸时不发 size', async () => {
  const provider = msProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-2.1');

  const out = await submitted(adapter, provider, { model: 'Qwen/Qwen-Image-2.1', prompt: 'a fox' });

  assert.equal('size' in out.body, false);
});

/* ------------------------------------------- 字段名确实来自模板（改造后才绿） */

/**
 * 上面那些断言只证明「改造前后一样」。这两条反过来证明改造**不是死代码**：
 * 用户覆盖（modelOptions[model].fields）改字段名，提交体就跟着改。
 * 改造前协议把字段名写死在 build 里，这两条必然红。
 */
test('字段模板：用户覆盖 BFL 的参考图模板后，提交体跟着换字段名', async () => {
  const provider = Object.assign(bflProvider(), {
    modelOptions: { 'flux-2-pro': { fields: { image: { path: 'ref_images[]', as: 'dataUrl' } } } }
  });
  const adapter = resolveAdapter(provider, 'flux-2-pro');

  const out = await submitted(adapter, provider, {
    model: 'flux-2-pro', prompt: 'a fox', fitted, images: images(2)
  });

  assert.deepEqual(out.body.ref_images, [DATA_URL, DATA_URL]);
  assert.equal(out.body.input_image, undefined);
  assert.equal(out.body.prompt, 'a fox');
});

test('字段模板：用户覆盖魔搭的提示词路径后，提交体跟着嵌套', async () => {
  const provider = Object.assign(msProvider(), {
    modelOptions: { 'Qwen/Qwen-Image-2.1': { fields: { prompt: { path: 'input.prompt' } } } }
  });
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-2.1');

  const out = await submitted(adapter, provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a fox', fitted
  });

  assert.deepEqual(out.body, {
    input: { prompt: 'a fox' },
    model: 'Qwen/Qwen-Image-2.1',
    size: '1024x1024'
  });
});

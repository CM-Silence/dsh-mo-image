import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, prepareGenerate, prepareEdit, fitSize } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

test('dashscope qwen-image posts a native multimodality body and reads the output image url', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('multimodal-generation')) {
      captured = { url: target, init };
      return jsonResponse({ output: { choices: [{ message: { content: [{ image: 'https://cdn.test/qwen.png' }] } }] } });
    }
    if (target === 'https://cdn.test/qwen.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const provider = { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image', key: 'k' };
  const adapter = resolveAdapter(provider, 'qwen-image-3.0-pro');
  assert.equal(adapter.id, 'dashscope-qwen-image');

  const result = await adapter.execute('generate', provider, {
    model: 'qwen-image-3.0-pro', prompt: '一只猫',
    fitted: { width: 2048, height: 2048, size: '2048x2048' }
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/services/aigc/multimodal-generation/generation'));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'qwen-image-3.0-pro');
  assert.equal(body.input.messages[0].content[0].text, '一只猫');
  assert.equal(body.parameters.size, '2048*2048');
});

test('zhipu omits n and response_format', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/images/generations')) {
      captured = { url: target, init };
      return jsonResponse({ data: [{ url: 'https://cdn.test/zhipu.png' }] });
    }
    if (target === 'https://cdn.test/zhipu.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const provider = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'zhipu', key: 'k' };
  const adapter = resolveAdapter(provider, 'cogview-4');
  assert.equal(adapter.id, 'zhipu');

  const result = await adapter.execute('generate', provider, {
    model: 'cogview-4', prompt: '一座山', fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.n, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.model, 'cogview-4');
  assert.equal(body.size, '1024x1024');
});

test('ark sends preset sizes and puts reference images in the image field', () => {
  const provider = { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'volcengine-ark', key: 'k' };
  const adapter = resolveAdapter(provider, 'doubao-seedream-4-0-250828');
  assert.equal(adapter.id, 'volcengine-ark');

  const big = prepareGenerate(adapter, provider, {
    model: 'doubao-seedream-4-0-250828', prompt: 'x',
    fitted: fitSize(adapter, '2048x2048')
  }, new Set());
  assert.equal(JSON.parse(big.body).size, '2K');

  const edit = prepareEdit(adapter, provider, {
    model: 'doubao-seedream-4-0-250828', prompt: 'x', fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'a.png' }]
  }, new Set(), 'image');
  assert.ok(String(JSON.parse(edit.body).image).startsWith('data:image/png;base64,'));
});

test('siliconflow no longer sends batch_size', () => {
  const provider = { baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'siliconflow', key: 'k' };
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image');
  const built = prepareGenerate(adapter, provider, { model: 'Qwen/Qwen-Image', prompt: 'x', fitted }, new Set());
  const body = JSON.parse(built.body);
  assert.equal(body.batch_size, undefined);
  assert.equal(body.image_size, '1024x1024');
});

test('siliconflow edit omits image_size for Qwen-Image-Edit', () => {
  const provider = { baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'siliconflow', key: 'k' };
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-Edit-2509');
  const built = prepareEdit(adapter, provider, {
    model: 'Qwen/Qwen-Image-Edit-2509', prompt: 'x', fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'a.png' }]
  }, new Set(), 'image');
  const body = JSON.parse(built.body);
  assert.equal(body.image_size, undefined);
  assert.ok(String(body.image).startsWith('data:image/png;base64,'));
});

test('ideogram builds the endpoint from the model id', () => {
  const provider = { baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram', key: 'k' };
  const adapter = resolveAdapter(provider, 'ideogram-4');
  const built = prepareGenerate(adapter, provider, { model: 'ideogram-4', prompt: 'x', fitted }, new Set());
  assert.equal(built.path, '/v2/image/generate/ideogram-4');
});

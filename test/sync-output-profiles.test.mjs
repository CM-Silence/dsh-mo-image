/**
 * stability / openai-chat 迁到输出描述符的**端到端特征化基线**。
 *
 * 这两条是「响应侧最后两撮代码」：
 *   - stability 的二进制以前是**隐式**判出来的（safeJson 失败 → decodeImagePayload(null, buffer)），
 *     而且 `binary: true` 还兼任请求常量（output_format:'png'）。这里同时钉住：
 *     二进制 body、JSON `{image}` body、以及 multipart 表单里的 output_format；
 *   - openai-chat 是**四级级联**（images[] → content 里的 data URL → content 里的 http 链接 →
 *     任意位置扫描）。四条各一条用例，另加一条「多级同时命中时谁赢」的顺序用例。
 *
 * 迁移只许换写法，不许换行为：这个文件在迁移前必须全绿，迁移后必须原样全绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';
import { providerPresetManifest, resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
// 2x2 红：和 PNG_1PX 字节不同，用来证明「取到的是哪一级的图」。
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';
const FITTED = { width: 1024, height: 1024, size: '1024x1024' };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function imageResponse(headers = { 'content-type': 'image/png' }) {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: headers });
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

function stabilityInput() {
  return { model: 'core', prompt: 'a cat', fitted: FITTED };
}

function stabilityProvider() {
  const preset = providerPresetManifest().find((item) => item.id === 'stability');
  return { ...preset, presetId: preset.id, key: 'k' };
}

async function stabilityGenerate() {
  const provider = stabilityProvider();
  const adapter = resolveAdapter(provider, 'core');
  assert.equal(adapter.id, 'stability');
  return callImageApi('generate', adapter, provider, stabilityInput(), new AbortController().signal);
}

/* ------------------------------------------------------------ stability */

test('Stability Core requests a raw image with the required Accept header', async (t) => {
  let captured = null;
  stubFetch(t, async (url, init) => {
    captured = { url: String(url), init: init };
    const accept = new Headers(init.headers).get('accept') || '*/*';
    if (accept !== 'image/*') {
      return jsonResponse({ errors: ['accept: expected image/* or application/json, but received: ' + accept] }, 400);
    }
    return imageResponse();
  });

  const result = await stabilityGenerate();

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(result.contentType, 'image/png');

  assert.ok(captured.url.endsWith('/v2beta/stable-image/generate/core'));
  assert.equal(new Headers(captured.init.headers).get('authorization'), 'Bearer k');
  // multipart 表单：binary:true 这个请求常量必须还在（响应的二进制读法迁走，它不能跟着走）。
  const form = captured.init.body;
  assert.equal(form.get('output_format'), 'png');
  assert.equal(form.get('prompt'), 'a cat');
  assert.equal(form.has('model'), false);
});

test('stability：JSON {image:"<base64>"} 响应 → 同一份字节（今天两条路都能吃）', async (t) => {
  stubFetch(t, async () => jsonResponse({ image: PNG_1PX, finish_reason: 'SUCCESS', seed: 7 }));

  const result = await stabilityGenerate();

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(result.contentType, 'image/png');
});

test('stability 只对 SD3.5 启用编辑，并发送该模式要求的字段', async (t) => {
  const provider = stabilityProvider();
  const image = { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };
  const model = 'sd3.5-large';
  const calls = [];
  stubFetch(t, async (url, init) => {
    calls.push(init.body);
    assert.equal(new URL(url).pathname, '/v2beta/stable-image/generate/sd3');
    assert.equal(new Headers(init.headers).get('accept'), 'image/*');
    assert.equal(init.body.get('model'), model);
    return imageResponse();
  });
  const input = { ...stabilityInput(), model, images: [image] };
  const adapter = resolveAdapter(provider, model);
  await callImageApi('generate', adapter, provider, input);
  await callImageApi('edit', adapter, provider, input);
  await assert.rejects(callImageApi('edit', resolveAdapter(provider, 'core'), provider, { ...input, model: 'core' }), /不支持图生图/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].get('aspect_ratio'), '1:1');
  assert.equal(calls[1].has('aspect_ratio'), false);
  assert.equal(calls[1].get('mode'), 'image-to-image');
  assert.equal(calls[1].get('strength'), '0.5');
  assert.equal(calls[1].get('image').name, 'ref.png');
});

/* ----------------------------------------------------------- openai-chat */

const chatProvider = () => ({ baseUrl: 'https://relay.example/v1', adapter: 'openai-chat', key: 'k' });

function chatInput() {
  return { model: 'relay-chat-model', prompt: 'draw a cat', fitted: FITTED };
}

async function chatGenerate(payload, download = imageResponse) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    if (target.endsWith('/chat/completions')) return jsonResponse(payload);
    if (target === 'https://cdn.test/chat.png') return download();
    if (target === 'https://cdn.test/scanned.png') return download();
    if (target === 'https://cdn.test/first.png') return download();
    throw new Error('unexpected url ' + target);
  };
  try {
    const provider = chatProvider();
    const adapter = resolveAdapter(provider, 'relay-chat-model');
    assert.equal(adapter.id, 'openai-chat');
    return { result: await adapter.execute('generate', provider, chatInput(), new AbortController().signal), calls: calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** 第一级：`choices.0.message.images[]`，元素可以是 image_url.url / url / 字符串。 */
test('openai-chat 第 1 级：message.images[] 的 data URL 直接落成字节', async () => {
  const { result, calls } = await chatGenerate({
    choices: [{
      message: {
        images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG_RED } }]
      }
    }]
  });

  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(calls.length, 1, 'data URL 不需要再下载');
  // 请求形状也照旧：modalities 与 messages 都在。
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.modalities, ['image', 'text']);
  assert.equal(body.messages[0].role, 'user');
});

/** 第二级：`content` 是 parts[]，正则扒 data URL（字符串 content 也走同一级）。 */
test('openai-chat 第 2 级：content parts[].text 里的 data URL → 字节', async () => {
  const { result, calls } = await chatGenerate({
    choices: [{
      message: {
        content: [
          { type: 'text', text: 'here you go:' },
          { type: 'text', text: '![img](data:image/png;base64,' + PNG_RED + ')' }
        ]
      }
    }]
  });

  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(calls.length, 1, 'data URL 不需要再下载');
});

/** 第三级：`content` 里的 http 图片链接 → fetchResultImage 下载。 */
test('openai-chat 第 3 级：content 里的 http 图片链接 → 下载', async () => {
  const { result, calls } = await chatGenerate({
    choices: [{ message: { content: '![img](https://cdn.test/chat.png)' } }]
  });

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.ok(calls.some((call) => call.url === 'https://cdn.test/chat.png'), '链接必须真的被下载');
});

/** 第四级：前三级都没有 → 任意位置扫描（decodeImagePayload 的兜底）。 */
test('openai-chat 第 4 级：任意位置扫描兜底', async () => {
  const { result, calls } = await chatGenerate({
    data: [{ url: 'https://cdn.test/scanned.png' }]
  });

  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.ok(calls.some((call) => call.url === 'https://cdn.test/scanned.png'), '扫描出来的 URL 也要下载');
});

/**
 * 级联顺序：配置成「多级同时有图」也必须是低级先赢，
 * 否则一份正常响应会悄悄换成另一张图。
 */
test('openai-chat 级联顺序：images[] 赢过 content，content 的 data URL 赢过 http 链接', async () => {
  const imagesFirst = await chatGenerate({
    choices: [{
      message: {
        images: [{ url: 'data:image/png;base64,' + PNG_RED }],
        content: '![img](data:image/png;base64,' + PNG_1PX + ')'
      }
    }]
  });
  assert.deepEqual(imagesFirst.result.bytes, Buffer.from(PNG_RED, 'base64'), '第 1 级赢过第 2 级');
  assert.equal(imagesFirst.calls.length, 1);

  // 文本顺序里 http 链接在前、data URL 在后：今天先跑「所有文本找 data URL」，
  // 所以必须选 data URL——如果按「逐段文本依次试正则」就会选错。
  const dataUrlWins = await chatGenerate({
    choices: [{
      message: {
        content: [
          { type: 'text', text: 'https://cdn.test/first.png' },
          { type: 'text', text: 'data:image/png;base64,' + PNG_RED }
        ]
      }
    }]
  });
  assert.deepEqual(dataUrlWins.result.bytes, Buffer.from(PNG_RED, 'base64'), '第 2 级赢过第 3 级');
  assert.equal(dataUrlWins.calls.length, 1, '赢家是 data URL，不该去下载 first.png');
});

test('openai-chat 无图时的报错文案保持不变', async () => {
  const provider = chatProvider();
  const adapter = resolveAdapter(provider, 'relay-chat-model');
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '抱歉，我不能生成图片' } }] });
  try {
    await assert.rejects(
      () => adapter.execute('generate', provider, chatInput(), new AbortController().signal),
      (error) => {
        assert.equal(error.message, '该中转没有返回图片（检查 modalities 或换用 OpenRouter 专用接口）');
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';
import { resolveAdapter, fitSize, adapterManifest, providerPresetManifest } from '../lib/adapters.js';
import { canEditModel } from '../lib/status.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

function scopeProvider(baseUrl = 'https://api-inference.modelscope.cn') {
  return { id: 'modelscope', name: 'ModelScope', baseUrl: baseUrl, key: 'ms-key' };
}

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

test('modelscope hosts resolve to the modelscope adapter with or without /v1', () => {
  for (const baseUrl of [
    'https://api-inference.modelscope.cn',
    'https://api-inference.modelscope.cn/v1',
    'https://api-inference.modelscope.ai/v1'
  ]) {
    const adapter = resolveAdapter({ baseUrl: baseUrl }, 'Qwen/Qwen-Image-2.1');
    assert.equal(adapter.id, 'modelscope', baseUrl);
  }
});

test('modelscope submits an async task, polls with the task type header and downloads output_images', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const target = String(url);
    if (target === 'https://api-inference.modelscope.cn/v1/images/generations') {
      // 提交响应会提前回 SUCCEED，但这时还没有图片，必须继续轮询。
      return jsonResponse({ task_id: 'task-1', task_status: 'SUCCEED' });
    }
    if (target === 'https://api-inference.modelscope.cn/v1/tasks/task-1') {
      const seen = calls.filter((call) => call.url === target).length;
      if (seen === 1) return jsonResponse({ task_id: 'task-1', task_status: 'RUNNING' });
      return jsonResponse({ task_id: 'task-1', task_status: 'SUCCEED', output_images: ['https://cdn.test/out.png'] });
    }
    if (target === 'https://cdn.test/out.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const provider = scopeProvider('https://api-inference.modelscope.cn/v1');
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-2.1');
  const result = await callImageApi('generate', adapter, provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'a red fox in the snow', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const submit = calls[0];
  assert.equal(submit.init.method, 'POST');
  assert.equal(submit.init.headers['X-ModelScope-Async-Mode'], 'true');
  assert.equal(submit.init.headers.Authorization, 'Bearer ms-key');
  assert.deepEqual(JSON.parse(submit.init.body), {
    model: 'Qwen/Qwen-Image-2.1',
    prompt: 'a red fox in the snow',
    size: '1024x1024'
  });

  const poll = calls.find((call) => call.url.includes('/v1/tasks/'));
  assert.equal(poll.init.headers['X-ModelScope-Task-Type'], 'image_generation');
  assert.equal(poll.init.headers.Authorization, 'Bearer ms-key');

  const download = calls[calls.length - 1];
  assert.equal(download.url, 'https://cdn.test/out.png');
  assert.equal(download.init.headers, undefined, '下载结果图不带 API Key');
});

test('modelscope keeps a single /v1 when the base URL already ends with it', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    const target = String(url);
    if (target === 'https://api-inference.modelscope.cn/v1/images/generations') {
      return jsonResponse({ task_id: 'task-2' });
    }
    if (target === 'https://api-inference.modelscope.cn/v1/tasks/task-2') {
      return jsonResponse({ task_status: 'SUCCEED', output_images: ['https://cdn.test/out.png'] });
    }
    if (target === 'https://cdn.test/out.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const provider = scopeProvider('https://api-inference.modelscope.cn/v1');
  await callImageApi('generate', resolveAdapter(provider, 'Qwen/Qwen-Image-2.1'), provider, {
    model: 'Qwen/Qwen-Image-2.1', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.equal(urls[0], 'https://api-inference.modelscope.cn/v1/images/generations');
  assert.equal(urls[1], 'https://api-inference.modelscope.cn/v1/tasks/task-2');
});

test('modelscope surfaces the gateway failure message from a failed task', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/v1/images/generations')) return jsonResponse({ task_id: 'task-3' });
    if (target.endsWith('/v1/tasks/task-3')) {
      return jsonResponse({
        task_id: 'task-3',
        task_status: 'FAILED',
        errors: { code: 500, message: 'task not found' }
      });
    }
    throw new Error('unexpected url ' + target);
  };

  const provider = scopeProvider();
  await assert.rejects(
    () => callImageApi('generate', resolveAdapter(provider, 'Qwen/Qwen-Image-2.1'), provider, {
      model: 'Qwen/Qwen-Image-2.1', prompt: 'hi', fitted: fitted
    }, new AbortController().signal),
    /task not found/
  );
});

test('modelscope edit sends one reference as a string and several as an array', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/v1/images/generations')) {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ task_id: 'task-' + bodies.length });
    }
    if (target.includes('/v1/tasks/')) {
      return jsonResponse({ task_status: 'SUCCEED', output_images: ['https://cdn.test/out.png'] });
    }
    if (target === 'https://cdn.test/out.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const provider = scopeProvider();
  const adapter = resolveAdapter(provider, 'Qwen/Qwen-Image-Edit');
  const image = { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };

  await callImageApi('edit', adapter, provider, {
    model: 'Qwen/Qwen-Image-Edit', prompt: 'paint it blue', fitted: fitted, images: [image]
  }, new AbortController().signal);
  assert.ok(String(bodies[0].image_url).startsWith('data:image/png;base64,'));

  await callImageApi('edit', adapter, provider, {
    model: 'Qwen/Qwen-Image-Edit', prompt: 'paint it blue', fitted: fitted,
    images: [image, Object.assign({}, image, { filename: 'ref2.png' })]
  }, new AbortController().signal);
  assert.equal(bodies[1].image_url.length, 2);
  assert.ok(String(bodies[1].image_url[1]).startsWith('data:image/png;base64,'));
});

test('modelscope fits sizes inside the gateway per-side limits', () => {
  // 网关级的每边限制来自 modelscope 那条 `.*` 主机规则（模型族的更严上限另算）。
  const provider = scopeProvider();
  assert.equal(fitSize(provider, '4096x2304', 'stabilityai/stable-diffusion-xl').size, '2048x1152');
  assert.equal(fitSize(provider, '32x32', 'stabilityai/stable-diffusion-xl').size, '64x64');
  assert.equal(fitSize(provider, '1024x768', 'stabilityai/stable-diffusion-xl').size, '1024x768');
});

test('modelscope is a named adapter, preset and an editable model family', () => {
  const manifest = adapterManifest().find((item) => item.id === 'modelscope');
  assert.ok(manifest, 'adapter manifest is missing modelscope');
  assert.equal(manifest.label, '魔搭 ModelScope');

  const preset = providerPresetManifest().find((item) => item.id === 'modelscope');
  assert.ok(preset, 'provider presets are missing modelscope');
  assert.equal(preset.adapter, 'modelscope');
  assert.equal(preset.baseUrl, 'https://api-inference.modelscope.cn');
  assert.ok(preset.models.includes('Qwen/Qwen-Image-Edit'));

  const provider = scopeProvider();
  assert.equal(canEditModel(provider, 'Qwen/Qwen-Image-Edit', resolveAdapter(provider, 'Qwen/Qwen-Image-Edit')), true);
});

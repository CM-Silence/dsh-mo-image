import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';
import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

function gatewayProvider(baseUrl = 'https://gateway.test/v1', adapter = 'openai-images') {
  return { id: 'gw', name: 'gateway', baseUrl: baseUrl, key: 'gw-key', adapter: adapter };
}

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

/** 装一版 fetch：按 URL 表分发，顺便记下每次调用。 */
function mockFetch(t, routes) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init || {} });
    const handler = routes[target];
    if (!handler) throw new Error('unexpected url ' + target);
    return typeof handler === 'function' ? handler(calls.filter((call) => call.url === target).length) : handler;
  };
  return calls;
}

test('the generic adapter keeps working synchronously when the response already has an image', async (t) => {
  const calls = mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ id: 'img-1', data: [{ url: 'https://cdn.test/out.png' }] }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const adapter = resolveAdapter(provider, 'some-image-model');
  const result = await callImageApi('generate', adapter, provider, {
    model: 'some-image-model', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(calls.filter((call) => call.url.includes('/tasks/')).length, 0);
  assert.equal(calls.length, 2, '提交 + 下载，没有轮询');
});

test('a task_id envelope is polled until the task succeeds', async (t) => {
  const calls = mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ task_id: 'job-1' }),
    'https://gateway.test/v1/tasks/job-1': (seen) => {
      if (seen === 1) return jsonResponse({ task_status: 'RUNNING' });
      return jsonResponse({ task_status: 'SUCCEEDED', images: [{ url: 'https://cdn.test/out.png' }] });
    },
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const adapter = resolveAdapter(provider, 'some-image-model');
  assert.equal(adapter.id, 'openai-images');

  const result = await callImageApi('generate', adapter, provider, {
    model: 'some-image-model', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const poll = calls.find((call) => call.url.includes('/tasks/'));
  assert.equal(poll.init.method, 'GET');
  assert.equal(poll.init.headers.Authorization, 'Bearer gw-key');
});

test('a returned status URL wins over the derived task path', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ taskId: 'job-2', statusUrl: 'https://poll.test/status/job-2' }),
    'https://poll.test/status/job-2': jsonResponse({
      data: { status: 'completed' },
      result: { images: [{ url: 'https://cdn.test/out.png' }] }
    }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
});

test('a failed task surfaces the gateway message from an errors array', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ task_id: 'job-3' }),
    'https://gateway.test/v1/tasks/job-3': jsonResponse({
      status: 'failed',
      errors: [{ message: 'prompt rejected by moderation' }]
    })
  });

  const provider = gatewayProvider();
  await assert.rejects(
    () => callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
      model: 'm', prompt: 'hi', fitted: fitted
    }, new AbortController().signal),
    /prompt rejected by moderation/
  );
});

test('a 404 on the derived task path falls through to the next candidate', async (t) => {
  const calls = mockFetch(t, {
    'https://gateway.test/openai/images/generations': jsonResponse({ id: 'job-4' }),
    'https://gateway.test/openai/v1/tasks/job-4': jsonResponse({ errors: { message: 'not found' } }, 404),
    'https://gateway.test/openai/tasks/job-4': jsonResponse({
      status: 'SUCCEEDED', output_images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider('https://gateway.test/openai');
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const polls = calls.filter((call) => call.url.includes('/tasks/')).map((call) => call.url);
  assert.deepEqual(polls, [
    'https://gateway.test/openai/v1/tasks/job-4',
    'https://gateway.test/openai/tasks/job-4'
  ]);
});

test('a task envelope on the edit endpoint is polled as well', async (t) => {
  const calls = mockFetch(t, {
    'https://gateway.test/v1/images/edits': jsonResponse({ task_id: 'job-5' }),
    'https://gateway.test/v1/tasks/job-5': jsonResponse({
      task_status: 'SUCCEED', output_images: ['https://cdn.test/edit.png']
    }),
    'https://cdn.test/edit.png': pngResponse()
  });

  const provider = gatewayProvider();
  const image = { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' };
  const result = await callImageApi('edit', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'change it', fitted: fitted, images: [image]
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.ok(calls[0].init.body instanceof FormData, '编辑仍然走 multipart');
});

test('an unknown custom API host falls back to the auto sync/async adapter', () => {
  const provider = { id: 'p', baseUrl: 'https://new-vendor.test/v1', key: 'k', adapter: '' };
  const adapter = resolveAdapter(provider, 'whatever-model');
  assert.equal(adapter.id, 'openai-images');
  assert.equal(adapter.autoAsync, true);
});

test('a 202 with a Location header is followed without a task id', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': () => new Response('', {
      status: 202, headers: { location: 'https://poll.test/jobs/job-6' }
    }),
    'https://poll.test/jobs/job-6': jsonResponse({ status: 'done', images: ['https://cdn.test/out.png'] }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
});

test('an image in the poll payload wins even when the status word is not in the table', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ task_id: 'job-7' }),
    'https://gateway.test/v1/tasks/job-7': jsonResponse({
      status: 'GENERATING_DONE', output_images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
});

test('a task envelope that already carries an image URL returns it without polling', async (t) => {
  const calls = mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ task_id: 'job-8', url: 'https://cdn.test/out.png' }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(calls.filter((call) => call.url.includes('/tasks/')).length, 0);
});

test('a top-level url that is not an image falls back to polling', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ task_id: 'job-9', url: 'https://gateway.test/status' }),
    'https://gateway.test/status': jsonResponse({ status: 'running' }),
    'https://gateway.test/v1/tasks/job-9': jsonResponse({
      task_status: 'SUCCEEDED', images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
});

test('a nested task_id wins over a top-level generic id', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ id: 'generic-10', data: { task_id: 'real-10' } }),
    'https://gateway.test/v1/tasks/real-10': jsonResponse({
      task_status: 'SUCCEED', images: ['https://cdn.test/out.png']
    }),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
});

test('a nested task_status wins over an envelope-level status', async (t) => {
  mockFetch(t, {
    'https://gateway.test/v1/images/generations': jsonResponse({ task_id: 'job-11' }),
    'https://gateway.test/v1/tasks/job-11': (seen) => (seen === 1
      ? jsonResponse({ status: 'success', data: { task_status: 'RUNNING' } })
      : jsonResponse({ status: 'success', data: { task_status: 'SUCCEED' }, images: ['https://cdn.test/out.png'] })),
    'https://cdn.test/out.png': pngResponse()
  });

  const provider = gatewayProvider();
  const result = await callImageApi('generate', resolveAdapter(provider, 'm'), provider, {
    model: 'm', prompt: 'hi', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
});

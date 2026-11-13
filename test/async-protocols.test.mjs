import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';
import { resolveAdapter } from '../lib/adapters.js';
import { resetAsyncSchemaCache } from '../lib/adapters/async.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

function provider() {
  return { id: 'p', baseUrl: 'https://api.test', key: 'k', adapter: 'fake-async' };
}

function fakeAsyncAdapter(overrides = {}) {
  return Object.assign({
    id: 'fake-async',
    label: 'Fake asynchronous',
    endpoints: { generate: '/jobs', edit: '/jobs' },
    transport: { generate: 'json', edit: 'json' },
    editFields: ['image'],
    async: {
      edit: true,
      build: (input) => ({ prompt: input.prompt, ...(input.images && input.images.length ? { image: 'data:image/png;base64,' + input.images[0].buffer.toString('base64') } : {}) }),
      submitPath: () => '/jobs',
      pollUrl: (submission) => submission.status_url,
      pollHeaders: () => ({ 'x-key': 'k' }),
      statusOf: (payload) => (payload.status === 'done'
        ? { state: 'success', status: 'done' }
        : { state: 'pending', status: String(payload.status || '') }),
      resolve: async (payload) => ({ url: payload.image_url }),
      intervalMs: 1,
      timeoutMs: 5000
    }
  }, overrides);
}

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

test('async descriptor drives submit, poll and resolve', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const target = String(url);
    if (target === 'https://api.test/jobs') return jsonResponse({ status_url: 'https://poll.test/1', id: 'job-1' });
    if (target === 'https://poll.test/1') {
      const seen = calls.filter((call) => call.url === target).length;
      if (seen === 1) return jsonResponse({ status: 'running' });
      return jsonResponse({ status: 'done', image_url: 'https://cdn.test/out.png' });
    }
    if (target === 'https://cdn.test/out.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const result = await callImageApi('generate', fakeAsyncAdapter(), provider(), {
    model: 'm', prompt: 'hi', fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(JSON.parse(calls[0].init.body).prompt, 'hi');
  assert.equal(calls[1].url, 'https://poll.test/1');
  assert.equal(calls[1].init.headers['x-key'], 'k');
  assert.equal(calls[calls.length - 1].url, 'https://cdn.test/out.png');
});

test('async edit is allowed when the descriptor says so', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const target = String(url);
    if (target === 'https://api.test/jobs') return jsonResponse({ status_url: 'https://poll.test/2' });
    if (target === 'https://poll.test/2') return jsonResponse({ status: 'done', image_url: 'https://cdn.test/edit.png' });
    if (target === 'https://cdn.test/edit.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const result = await callImageApi('edit', fakeAsyncAdapter(), provider(), {
    model: 'm', prompt: 'change it', fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' }]
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const body = JSON.parse(calls[0].init.body);
  assert.ok(String(body.image).startsWith('data:image/png;base64,'));
});

test('async edit is rejected when the descriptor says it is unsupported', async (t) => {
  const adapter = fakeAsyncAdapter();
  adapter.async.edit = false;
  await assert.rejects(
    () => callImageApi('edit', adapter, provider(), {
      model: 'm', prompt: 'change it', fitted, images: []
    }, new AbortController().signal),
    /暂不支持参考图编辑/
  );
});

test('bfl submits, polls polling_url with x-key and downloads result.sample', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const target = String(url);
    if (target === 'https://api.bfl.ai/v1/flux-2-pro') {
      return jsonResponse({ id: 'job-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-1' });
    }
    if (target === 'https://api.bfl.ai/v1/get_result?id=job-1') {
      const seen = calls.filter((call) => call.url === target).length;
      if (seen === 1) return jsonResponse({ status: 'Pending' });
      return jsonResponse({ status: 'Ready', result: { sample: 'https://cdn.test/bfl.png' } });
    }
    if (target === 'https://cdn.test/bfl.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const adapter = resolveAdapter({ baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl', key: 'k' }, 'flux-2-pro');
  assert.equal(adapter.id, 'bfl');
  const result = await callImageApi('generate', adapter, { baseUrl: 'https://api.bfl.ai/v1', key: 'k' }, {
    model: 'flux-2-pro', prompt: 'a fox', fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(calls[0].init.headers['x-key'], 'k');
  assert.equal(JSON.parse(calls[0].init.body).width, 1024);
  const poll = calls.find((call) => call.url.includes('get_result'));
  assert.equal(poll.init.headers['x-key'], 'k');
  assert.equal(calls[calls.length - 1].url, 'https://cdn.test/bfl.png');
});

test('bfl FLUX 3 omits seed and uses aspect_ratio plus resolution', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitted = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === 'https://api.bfl.ai/v1/flux-3-image') {
      submitted = JSON.parse(init.body);
      return jsonResponse({ id: 'job-2', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-2' });
    }
    if (target.includes('get_result')) return jsonResponse({ status: 'Ready', result: { sample: 'https://cdn.test/f3.png' } });
    if (target === 'https://cdn.test/f3.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const adapter = resolveAdapter({ baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl', key: 'k' }, 'flux-3-image');
  await callImageApi('generate', adapter, { baseUrl: 'https://api.bfl.ai/v1', key: 'k' }, {
    model: 'flux-3-image', prompt: 'a fox', fitted: { width: 1344, height: 768, size: '1344x768' }
  }, new AbortController().signal);

  assert.equal(submitted.aspect_ratio, '16:9');
  assert.equal(submitted.resolution, '1k');
  assert.equal(submitted.seed, undefined);
  assert.equal(submitted.input_image, undefined);
});

test('fal polls status_url, checks error on COMPLETED and reads images from response_url', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const target = String(url);
    if (target === 'https://queue.fal.run/fal-ai/flux-2-pro') {
      return jsonResponse({ status: 'IN_QUEUE', request_id: 'r1', status_url: 'https://queue.test/s', response_url: 'https://queue.test/r' });
    }
    if (target === 'https://queue.test/s') {
      const seen = calls.filter((call) => call.url === target).length;
      if (seen === 1) return jsonResponse({ status: 'IN_PROGRESS' }, 202);
      return jsonResponse({ status: 'COMPLETED' });
    }
    if (target === 'https://queue.test/r') return jsonResponse({ images: [{ url: 'https://cdn.test/fal.png' }] });
    if (target === 'https://cdn.test/fal.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const adapter = resolveAdapter({ baseUrl: 'https://queue.fal.run', adapter: 'fal', key: 'k' }, 'fal-ai/flux-2-pro');
  assert.equal(adapter.id, 'fal');
  const result = await callImageApi('generate', adapter, { baseUrl: 'https://queue.fal.run', key: 'k' }, {
    model: 'fal-ai/flux-2-pro', prompt: 'a fox', fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(calls[0].init.headers.Authorization, 'Key k');
  assert.equal(calls[calls.length - 1].url, 'https://cdn.test/fal.png');
});

test('fal treats COMPLETED with an error as a failure', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === 'https://queue.fal.run/fal-ai/flux-2-pro') {
      return jsonResponse({ status_url: 'https://queue.test/s', response_url: 'https://queue.test/r' });
    }
    if (target === 'https://queue.test/s') {
      return jsonResponse({ status: 'COMPLETED', error: 'runner crashed', error_type: 'runner_server_error' });
    }
    throw new Error('unexpected url ' + target);
  };

  const adapter = resolveAdapter({ baseUrl: 'https://queue.fal.run', adapter: 'fal', key: 'k' }, 'fal-ai/flux-2-pro');
  await assert.rejects(
    () => callImageApi('generate', adapter, { baseUrl: 'https://queue.fal.run', key: 'k' },
      { model: 'fal-ai/flux-2-pro', prompt: 'x', fitted }, new AbortController().signal),
    /runner crashed/
  );
});

test('replicate polls urls.get and uses the model schema to pick the image field', async (t) => {
  resetAsyncSchemaCache();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const target = String(url);
    if (target === 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro') {
      return jsonResponse({
        latest_version: {
          openapi_schema: {
            components: {
              schemas: {
                Input: { properties: { prompt: { type: 'string' }, image: { type: 'string', format: 'uri' } } }
              }
            }
          }
        }
      });
    }
    if (target === 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions') {
      return jsonResponse({ id: 'p1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } });
    }
    if (target === 'https://api.replicate.com/v1/predictions/p1') {
      const seen = calls.filter((call) => call.url === target).length;
      if (seen === 1) return jsonResponse({ status: 'processing' });
      return jsonResponse({ status: 'succeeded', output: ['https://cdn.test/rep.png'] });
    }
    if (target === 'https://cdn.test/rep.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const providerDef = { baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8_test' };
  const adapter = resolveAdapter(providerDef, 'black-forest-labs/flux-2-pro');
  assert.equal(adapter.id, 'replicate');
  const result = await callImageApi('edit', adapter, providerDef, {
    model: 'black-forest-labs/flux-2-pro', prompt: 'watercolor', fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'a.png' }]
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const submit = calls.find((call) => call.url.endsWith('/predictions') && call.init.method === 'POST');
  const body = JSON.parse(submit.init.body);
  assert.ok(String(body.input.image).startsWith('data:image/png;base64,'));
});

test('replicate without a schema sends prompt only and reports the omission', async (t) => {
  resetAsyncSchemaCache();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let submitBody = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === 'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro') {
      return jsonResponse({ detail: 'not found' }, 404);
    }
    if (target.endsWith('/predictions')) {
      submitBody = JSON.parse(init.body);
      return jsonResponse({ id: 'p2', urls: { get: 'https://api.replicate.com/v1/predictions/p2' } });
    }
    if (target === 'https://api.replicate.com/v1/predictions/p2') {
      return jsonResponse({ status: 'succeeded', output: ['https://cdn.test/rep2.png'] });
    }
    if (target === 'https://cdn.test/rep2.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  const providerDef = { baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate', key: 'r8_test' };
  const adapter = resolveAdapter(providerDef, 'black-forest-labs/flux-2-pro');
  const result = await callImageApi('edit', adapter, providerDef, {
    model: 'black-forest-labs/flux-2-pro', prompt: 'watercolor', fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'a.png' }]
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(submitBody.input.image, undefined);
  assert.match(String(result.note || ''), /未识别模型输入字段/);
});

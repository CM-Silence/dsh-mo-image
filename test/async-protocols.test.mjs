import test from 'node:test';
import assert from 'node:assert/strict';

import { callImageApi } from '../lib/index.js';

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
    /不支持参考图编辑/
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { request, setNetworkLogger, resetNetworkState } from '../lib/net.js';

function stubFetch(t, handler) {
  resetNetworkState();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return handler(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const SYSTEM_PROXY = { https: 'http://127.0.0.1:7897', http: 'http://127.0.0.1:7897', bypass: [] };

test('attaches a proxy dispatcher when the system proxy is on', async (t) => {
  const calls = stubFetch(t, () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

  const response = await request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: SYSTEM_PROXY });

  assert.equal(response.status, 200);
  assert.equal(typeof calls[0].init.dispatcher.dispatch, 'function');
});

test('reuses the same dispatcher for the same proxy instead of rebuilding per call', async (t) => {
  const calls = stubFetch(t, () => new Response('{}', { status: 200 }));
  await request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: SYSTEM_PROXY });
  await request('https://api.sudocode.chat/v1/images/generations', { method: 'POST' }, { env: {}, systemProxy: SYSTEM_PROXY });

  assert.equal(calls[0].init.dispatcher, calls[1].init.dispatcher);
});

test('stays direct for loopback targets even with a system proxy configured', async (t) => {
  const calls = stubFetch(t, () => new Response('{}', { status: 200 }));

  await request('http://127.0.0.1:8188/prompt', { method: 'POST' }, { env: {}, systemProxy: SYSTEM_PROXY });

  assert.equal(calls[0].init.dispatcher, undefined);
});

test('stays direct when MO_IMAGE_PROXY turns proxying off', async (t) => {
  const calls = stubFetch(t, () => new Response('{}', { status: 200 }));

  await request('https://api.sudocode.chat/v1/models', {}, { env: { MO_IMAGE_PROXY: 'off' }, systemProxy: SYSTEM_PROXY });

  assert.equal(calls[0].init.dispatcher, undefined);
});

test('stays direct when nothing is configured', async (t) => {
  const calls = stubFetch(t, () => new Response('{}', { status: 200 }));

  await request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: null });

  assert.equal(calls[0].init.dispatcher, undefined);
});

test('turns fetch failures into a readable network error with the cause code', async (t) => {
  stubFetch(t, () => {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    throw error;
  });

  await assert.rejects(
    request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: null }),
    (error) => {
      assert.match(error.message, /api\.sudocode\.chat/);
      assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
      assert.match(error.message, /直连/);
      assert.match(error.message, /TCP 连接超时/);
      assert.doesNotMatch(error.message, /代理|HTTPS_PROXY/);
      assert.equal(error.localized.code, 'network.failed');
      assert.equal(error.localized.params.hint, 'timeout');
      assert.equal(error.cause && error.cause.message, 'fetch failed');
      return true;
    }
  );
});

test('marks proxy connections without exposing the proxy address', async (t) => {
  stubFetch(t, () => {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    throw error;
  });

  await assert.rejects(
    request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: SYSTEM_PROXY }),
    (error) => {
      assert.match(error.message, /经系统网络配置/);
      assert.doesNotMatch(error.message, /127\.0\.0\.1:7897/);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    }
  );
});

test('lets AbortError through untouched so timeouts keep their identity', async (t) => {
  stubFetch(t, () => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(
    request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: null }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    }
  );
});

test('logs proxy usage once per host so support can see what happened', async (t) => {
  const lines = [];
  setNetworkLogger((message) => lines.push(String(message)));
  t.after(() => setNetworkLogger(null));
  stubFetch(t, () => new Response('{}', { status: 200 }));

  await request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: SYSTEM_PROXY });
  await request('https://api.sudocode.chat/v1/models', {}, { env: {}, systemProxy: SYSTEM_PROXY });

  assert.equal(lines.filter((line) => line.includes('api.sudocode.chat')).length, 1);
});

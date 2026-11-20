import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { request, setNetworkLogger, resetNetworkState } from '../lib/net.js';
import { errorBody } from '../lib/localized-error.js';

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

  const options = {
    env: { HTTPS_PROXY: 'http://fixture-user:fixture%40pass@proxy.test:7897' },
    systemProxy: null
  };
  await request('https://api.sudocode.chat/v1/models', {}, options);
  await request('https://api.sudocode.chat/v1/models', {}, options);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /api\.sudocode\.chat.*http:\/\/proxy\.test:7897.*env/);
  assert.doesNotMatch(lines[0], /fixture-user|fixture%40pass/);
});

test('proxy failures retain cause codes without logging or returning private transport details', async (t) => {
  const lines = [];
  setNetworkLogger((message) => lines.push(String(message)));
  t.after(() => setNetworkLogger(null));
  const proxyUrl = 'http://fixture-user:fixture%40pass@proxy.test:7897';
  const authorization = 'Basic ' + Buffer.from('fixture-user:fixture@pass').toString('base64');
  stubFetch(t, () => {
    const cause = Object.assign(new Error('proxy rejected ' + authorization), { code: 'ECONNREFUSED' });
    throw Object.assign(new TypeError('fetch failed via ' + proxyUrl, { cause }), { input: proxyUrl });
  });

  await assert.rejects(
    request('https://api.sudocode.chat/v1/models', {}, { env: { HTTPS_PROXY: proxyUrl }, systemProxy: null }),
    (error) => {
      assert.equal(error.localized.code, 'network.failed');
      assert.equal(error.localized.params.cause, 'ECONNREFUSED');
      assert.equal(error.localized.params.hint, 'connection');
      assert.equal(error.cause.cause.code, 'ECONNREFUSED');
      const diagnostic = inspect([errorBody(error), error], { depth: null });
      assert.doesNotMatch(diagnostic, /fixture-user|fixture%40pass|fixture@pass/);
      assert.equal(diagnostic.includes(authorization), false);
      return true;
    }
  );
  assert.match(lines[1], /api\.sudocode\.chat.*http:\/\/proxy\.test:7897.*env.*ECONNREFUSED/);
  assert.doesNotMatch(lines.join('\n'), /fixture-user|fixture%40pass|fixture@pass/);
  assert.equal(lines.join('\n').includes(authorization), false);
});

test('invalid proxy configuration and proxied aborts preserve error classification without revealing credentials', async (t) => {
  const lines = [];
  setNetworkLogger((message) => lines.push(String(message)));
  t.after(() => setNetworkLogger(null));
  const proxyUrl = 'http://fixture-user:fixture-pass@proxy.test:7897';
  const calls = stubFetch(t, () => {
    throw Object.assign(new Error('cancelled ' + proxyUrl), { name: 'AbortError' });
  });
  await assert.rejects(
    request('https://api.sudocode.chat/v1/models', {}, {
      env: {},
      systemProxy: { https: 'https://fixture-user:fixture-pass@proxy.test:7897', bypass: [] }
    }),
    (error) => {
      assert.equal(error.localized.code, 'network.routeInvalid');
      assert.doesNotMatch(inspect(error), /fixture-user|fixture-pass/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    request('https://api.sudocode.chat/v1/models', {}, { env: { HTTPS_PROXY: proxyUrl }, systemProxy: null }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.localized.code, 'network.timeout');
      assert.doesNotMatch(inspect(error), /fixture-user|fixture-pass/);
      return true;
    }
  );
  assert.match(lines[0], /api\.sudocode\.chat.*proxy\.test:7897.*system/);
  assert.doesNotMatch(lines.join('\n'), /fixture-user|fixture-pass/);
});

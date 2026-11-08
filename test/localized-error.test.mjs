import test from 'node:test';
import assert from 'node:assert/strict';
import { localizedError, errorBody, SERVER_ERROR_CODES } from '../lib/localized-error.js';
import { networkFailure } from '../lib/net.js';

test('localizedError keeps the message and attaches code/params', () => {
  const error = localizedError(new Error('原始报错'), 'provider.notFound', { provider: 'p1' });
  assert.equal(error.message, '原始报错');
  assert.deepEqual(error.localized, { code: 'provider.notFound', params: { provider: 'p1' } });
});

test('errorBody forwards message, code and params without dropping anything', () => {
  const body = errorBody(localizedError(new Error('原始报错'), 'config.writeFailed', { message: 'disk full' }));
  assert.deepEqual(body, {
    ok: false,
    error: '原始报错',
    code: 'config.writeFailed',
    params: { message: 'disk full' }
  });
});

test('errorBody leaves unannotated errors as a plain message', () => {
  assert.deepEqual(errorBody(new Error('plain')), { ok: false, error: 'plain' });
});

test('networkFailure exposes a direct-connection payload with a timeout hint', () => {
  const error = networkFailure(
    Object.assign(new Error('fetch failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    'https://api.openai.com/v1/models',
    { proxyUrl: '' }
  );
  assert.match(error.message, /网络请求失败：api\.openai\.com/);
  assert.deepEqual(error.localized, {
    code: 'network.failed',
    params: {
      host: 'api.openai.com',
      cause: 'UND_ERR_CONNECT_TIMEOUT',
      via: 'direct',
      hint: 'timeout'
    }
  });
});

test('networkFailure marks proxy connections without exposing the proxy URL', () => {
  const error = networkFailure(
    Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    'https://api.example.com/v1',
    { proxyUrl: 'http://127.0.0.1:7897' }
  );
  assert.equal(error.localized.params.via, 'proxy');
  assert.equal(error.localized.params.hint, 'connection');
  assert.equal(error.localized.params.proxy, undefined);
  assert.doesNotMatch(error.message, /7897/);
});

test('network errors no longer advise using a proxy', () => {
  const direct = networkFailure(
    Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    'https://api.openai.com/v1/models',
    { proxyUrl: '' }
  );
  assert.doesNotMatch(direct.message, /代理|HTTPS_PROXY|proxy/i);
  assert.match(direct.message, /TCP 连接超时/);
});

test('every declared server-error code is a dedicated namespace', () => {
  for (const code of SERVER_ERROR_CODES) {
    assert.match(code, /^[a-z][A-Za-z0-9.]*$/);
    assert.ok(!code.startsWith('serverError.'), 'codes are suffixes: the client adds the serverError. prefix');
  }
});

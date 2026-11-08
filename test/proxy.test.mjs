import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProxyServer, parseBypassList, hostMatchesBypass, isLoopbackHost,
  resolveProxyForTarget, readSystemProxy
} from '../lib/proxy.js';

test('parseProxyServer accepts a bare host:port for both schemes', () => {
  assert.deepEqual(parseProxyServer('127.0.0.1:7897'), {
    http: 'http://127.0.0.1:7897',
    https: 'http://127.0.0.1:7897'
  });
});

test('parseProxyServer honours per-scheme entries and keeps the scheme prefix', () => {
  assert.deepEqual(parseProxyServer('http=127.0.0.1:7897;https=127.0.0.1:7898'), {
    http: 'http://127.0.0.1:7897',
    https: 'http://127.0.0.1:7898'
  });
  assert.deepEqual(parseProxyServer('https=proxy.corp.test:3128'), {
    http: undefined,
    https: 'http://proxy.corp.test:3128'
  });
});

test('parseProxyServer ignores socks-only settings instead of pretending to support them', () => {
  assert.deepEqual(parseProxyServer('socks=127.0.0.1:1080'), { http: undefined, https: undefined });
});

test('parseProxyServer keeps an explicit http:// prefix intact', () => {
  assert.equal(parseProxyServer('http://127.0.0.1:7897').https, 'http://127.0.0.1:7897');
});

test('isLoopbackHost catches the loopback shapes plugins use for local adapters', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'app.localhost', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), true, host + ' should be loopback');
  }
  for (const host of ['api.sudocode.chat', '192.168.1.9', 'example.test']) {
    assert.equal(isLoopbackHost(host), false, host + ' should not be loopback');
  }
});

test('hostMatchesBypass understands the Windows ProxyOverride dialect', () => {
  const list = parseBypassList('localhost;127.*;192.168.*;<local>;*.internal.test;.corp.test');
  assert.equal(hostMatchesBypass('127.0.0.1', list), true);
  assert.equal(hostMatchesBypass('192.168.3.4', list), true);
  assert.equal(hostMatchesBypass('intranet', list), true, '<local> means dotless hostnames');
  assert.equal(hostMatchesBypass('api.corp.test', list), true, '.corp.test is a suffix rule');
  assert.equal(hostMatchesBypass('svc.internal.test', list), true, '*.internal.test is a suffix rule');
  assert.equal(hostMatchesBypass('api.sudocode.chat', list), false);
});

test('resolveProxyForTarget prefers explicit env vars over the system proxy', () => {
  const target = resolveProxyForTarget('https://api.sudocode.chat/v1/models', {
    env: { HTTPS_PROXY: 'http://env-proxy.test:8080' },
    systemProxy: { http: 'http://127.0.0.1:7897', https: 'http://127.0.0.1:7897', bypass: [] }
  });
  assert.equal(target.proxyUrl, 'http://env-proxy.test:8080');
  assert.equal(target.source, 'env');
});

test('resolveProxyForTarget falls back to the system proxy when env is empty', () => {
  const target = resolveProxyForTarget('https://api.sudocode.chat/v1/models', {
    env: {},
    systemProxy: { https: 'http://127.0.0.1:7897', bypass: [] }
  });
  assert.equal(target.proxyUrl, 'http://127.0.0.1:7897');
  assert.equal(target.source, 'system');
});

test('resolveProxyForTarget uses ALL_PROXY for either scheme and lower-case spellings too', () => {
  assert.equal(resolveProxyForTarget('http://api.test/v1', { env: { ALL_PROXY: 'http://all.test:1' }, systemProxy: null }).proxyUrl, 'http://all.test:1');
  assert.equal(resolveProxyForTarget('https://api.test/v1', { env: { all_proxy: 'http://all.test:1' }, systemProxy: null }).proxyUrl, 'http://all.test:1');
  assert.equal(resolveProxyForTarget('https://api.test/v1', { env: { https_proxy: 'http://lower.test:1' }, systemProxy: null }).proxyUrl, 'http://lower.test:1');
});

test('resolveProxyForTarget never proxies loopback targets, even with env vars set', () => {
  const target = resolveProxyForTarget('http://127.0.0.1:7860/sdapi/v1/sd-models', {
    env: { HTTPS_PROXY: 'http://p.test:1', ALL_PROXY: 'http://p.test:1' },
    systemProxy: { https: 'http://127.0.0.1:7897', bypass: [] }
  });
  assert.equal(target.proxyUrl, null);
  assert.equal(target.reason, 'loopback');
});

test('resolveProxyForTarget honours NO_PROXY and the system bypass list', () => {
  assert.equal(resolveProxyForTarget('https://api.corp.test/v1', {
    env: { HTTPS_PROXY: 'http://p.test:1', NO_PROXY: '.corp.test' }, systemProxy: null
  }).proxyUrl, null);
  assert.equal(resolveProxyForTarget('https://api.corp.test/v1', {
    env: {}, systemProxy: { https: 'http://127.0.0.1:7897', bypass: parseBypassList('*.corp.test') }
  }).proxyUrl, null);
});

test('resolveProxyForTarget can be switched off explicitly', () => {
  const target = resolveProxyForTarget('https://api.sudocode.chat/v1/models', {
    env: { MO_IMAGE_PROXY: 'off', HTTPS_PROXY: 'http://p.test:1' },
    systemProxy: { https: 'http://127.0.0.1:7897', bypass: [] }
  });
  assert.equal(target.proxyUrl, null);
  assert.equal(target.reason, 'disabled');
});

test('resolveProxyForTarget accepts an explicit proxy override', () => {
  const target = resolveProxyForTarget('https://api.sudocode.chat/v1/models', {
    env: { MO_IMAGE_PROXY: 'http://explicit.test:9000' },
    systemProxy: null
  });
  assert.equal(target.proxyUrl, 'http://explicit.test:9000');
  assert.equal(target.source, 'override');
});

test('resolveProxyForTarget ignores non-http targets and malformed URLs', () => {
  assert.equal(resolveProxyForTarget('file:///tmp/x.png', { env: { HTTPS_PROXY: 'http://p.test:1' }, systemProxy: null }).proxyUrl, null);
  assert.equal(resolveProxyForTarget('not a url', { env: { HTTPS_PROXY: 'http://p.test:1' }, systemProxy: null }).proxyUrl, null);
});

test('resolveProxyForTarget reports no proxy when nothing is configured', () => {
  const target = resolveProxyForTarget('https://api.sudocode.chat/v1/models', { env: {}, systemProxy: null });
  assert.equal(target.proxyUrl, null);
  assert.equal(target.reason, 'none');
});

const REG_OUTPUT = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:7897',
  '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
  ''
].join('\r\n');

test('readSystemProxy parses the WinINET registry output', async () => {
  const value = await readSystemProxy({
    platform: 'win32', noCache: true,
    run: (command, args, options, callback) => callback(null, Buffer.from(REG_OUTPUT, 'latin1'))
  });
  assert.deepEqual(value, {
    http: 'http://127.0.0.1:7897',
    https: 'http://127.0.0.1:7897',
    bypass: ['localhost', '127.*', '<local>']
  });
});

test('readSystemProxy returns null when the system proxy is switched off', async () => {
  const value = await readSystemProxy({
    platform: 'win32', noCache: true,
    run: (command, args, options, callback) => callback(null, Buffer.from('ProxyEnable    REG_DWORD    0x0\r\n', 'latin1'))
  });
  assert.equal(value, null);
});

test('readSystemProxy never throws when spawning reg.exe is blocked', async () => {
  const value = await readSystemProxy({
    platform: 'win32', noCache: true,
    run: () => { const error = new Error('spawn EPERM'); error.code = 'EPERM'; throw error; }
  });
  assert.equal(value, null);
});

test('readSystemProxy returns null on non-Windows platforms', async () => {
  const value = await readSystemProxy({ platform: 'darwin', noCache: true });
  assert.equal(value, null);
});

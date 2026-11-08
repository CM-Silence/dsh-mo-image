import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createProxyDispatcher } from '../lib/proxy-dispatcher.js';

const KEY = readFileSync(fileURLToPath(new URL('./fixtures/localhost-key.pem', import.meta.url)));
const CERT = readFileSync(fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url)));
const TLS_OPTIONS = { rejectUnauthorized: false };   // fixture cert is self-signed by design

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const socketsByServer = new WeakMap();

function trackSockets(server) {
  const sockets = new Set();
  socketsByServer.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}

/**
 * CONNECT 的原始 socket 会被 http server 从连接跟踪里摘掉，单靠 server.close()
 * 会一直等下去；这里自己记 socket 并逐个销毁。
 */
function close(server) {
  const sockets = socketsByServer.get(server);
  if (sockets) for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    server.close(finish);
    setTimeout(finish, 1000).unref();
  });
}

/** 记录请求、回 JSON 的源站；https 开关决定是否走过 TLS 隧道。 */
async function startOrigin({ tls = false } = {}) {
  const seen = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] || '',
        host: req.headers.host || '',
        length: body.length,
        head: body.subarray(0, 40).toString('latin1')
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  };
  const server = tls ? https.createServer({ key: KEY, cert: CERT }, handler) : http.createServer(handler);
  trackSockets(server);
  const port = await listen(server);
  return { server, port, seen, origin: (tls ? 'https' : 'http') + '://127.0.0.1:' + port };
}

/** 标准 CONNECT 代理：只负责打洞，然后双向转发。 */
async function startConnectProxy() {
  const seen = [];
  const server = http.createServer((req, res) => { res.writeHead(501); res.end('use CONNECT'); });
  server.on('connect', (req, socket, head) => {
    seen.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  trackSockets(server);
  const port = await listen(server);
  return { server, port, seen, url: 'http://127.0.0.1:' + port };
}

/** 只回 502 的 CONNECT 代理，用来验证失败路径。 */
async function startRefusingProxy() {
  const server = http.createServer((req, res) => { res.writeHead(501); res.end(); });
  server.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  trackSockets(server);
  const port = await listen(server);
  return { server, port, url: 'http://127.0.0.1:' + port };
}

/** 支持 absolute-form 的普通 HTTP 代理（不加密时走这条）。 */
async function startForwardProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    let target;
    try { target = new URL(req.url); } catch (_error) { res.writeHead(400); res.end('bad request uri'); return; }
    const upstream = http.request({
      host: target.hostname,
      port: Number(target.port) || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: target.host })
    }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    req.pipe(upstream);
  });
  trackSockets(server);
  const port = await listen(server);
  return { server, port, seen, url: 'http://127.0.0.1:' + port };
}

test('tunnels an https request through a CONNECT proxy', { timeout: 10000 }, async (t) => {
  const origin = await startOrigin({ tls: true });
  const proxy = await startConnectProxy();
  t.after(async () => { await close(proxy.server); await close(origin.server); });

  const dispatcher = createProxyDispatcher({ proxyUrl: proxy.url, tlsOptions: TLS_OPTIONS });
  const response = await fetch(origin.origin + '/v1/models?pageSize=1000', { dispatcher });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.url, '/v1/models?pageSize=1000');
  assert.deepEqual(proxy.seen, ['127.0.0.1:' + origin.port]);
  assert.equal(origin.seen[0].host, '127.0.0.1:' + origin.port);
});

test('sends absolute-form requests for plain http targets', { timeout: 10000 }, async (t) => {
  const origin = await startOrigin({ tls: false });
  const proxy = await startForwardProxy();
  t.after(async () => { await close(proxy.server); await close(origin.server); });

  const dispatcher = createProxyDispatcher({ proxyUrl: proxy.url });
  const response = await fetch(origin.origin + '/echo?a=1', { dispatcher, method: 'POST', body: 'hello' });
  await response.arrayBuffer();

  assert.equal(proxy.seen[0], origin.origin + '/echo?a=1');
  assert.equal(origin.seen[0].url, '/echo?a=1');
  assert.equal(origin.seen[0].head, 'hello');
});

test('pumps a multipart body through the tunnel without mangling it', { timeout: 10000 }, async (t) => {
  const origin = await startOrigin({ tls: true });
  const proxy = await startConnectProxy();
  t.after(async () => { await close(proxy.server); await close(origin.server); });

  const form = new FormData();
  form.append('model', 'gpt-image-2.5-flare');
  form.append('prompt', 'make it blue');
  form.append('image', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'a.png');

  const dispatcher = createProxyDispatcher({ proxyUrl: proxy.url, tlsOptions: TLS_OPTIONS });
  const response = await fetch(origin.origin + '/v1/images/edits', { method: 'POST', body: form, dispatcher });
  await response.arrayBuffer();
  const seen = origin.seen[0];

  assert.equal(response.status, 200);
  assert.match(seen.contentType, /^multipart\/form-data; boundary=/);
  assert.ok(seen.length > 100, 'multipart body should carry the image bytes');
  assert.match(seen.head, /------formdata-undici-/);
});

test('surfaces a refused CONNECT as an actionable network error', { timeout: 10000 }, async (t) => {
  const origin = await startOrigin({ tls: true });
  const proxy = await startRefusingProxy();
  t.after(async () => { await close(proxy.server); await close(origin.server); });

  const dispatcher = createProxyDispatcher({ proxyUrl: proxy.url, tlsOptions: TLS_OPTIONS });
  await assert.rejects(
    fetch(origin.origin + '/v1/models', { dispatcher }),
    (error) => {
      assert.equal(error.name, 'TypeError');
      assert.match(String(error.cause && error.cause.message), /502/);
      return true;
    }
  );
});

test('applies the request headers it is given and keeps the path intact', { timeout: 10000 }, async (t) => {
  const origin = await startOrigin({ tls: true });
  const proxy = await startConnectProxy();
  t.after(async () => { await close(proxy.server); await close(origin.server); });

  const dispatcher = createProxyDispatcher({ proxyUrl: proxy.url, tlsOptions: TLS_OPTIONS });
  const response = await fetch(origin.origin + '/v1/images/generations', {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2.5-flare' }),
    dispatcher
  });
  await response.arrayBuffer();

  assert.equal(response.status, 200);
  assert.equal(origin.seen[0].method, 'POST');
  assert.equal(origin.seen[0].url, '/v1/images/generations');
  assert.equal(origin.seen[0].head, '{"model":"gpt-image-2.5-flare"}');
});

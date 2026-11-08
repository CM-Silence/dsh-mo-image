/**
 * 一个最小的 undici dispatcher：把 fetch() 的请求塞进 HTTP 代理。
 *
 * 为什么不用 undici 包：插件是零依赖的，而且跨副本的 FormData/Blob 会被
 * undici 的 brand check 静默绕过（multipart 会变成字符串 "[object FormData]"）。
 * 这里只接管传输层，请求体序列化仍然由宿主自带的 fetch 完成。
 *
 * 协议：https 目标走 CONNECT 隧道 + TLS；http 目标走 absolute-form。
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

const NO_BODY = Symbol('no-body');

function parseProxyUrl(proxyUrl) {
  let url;
  try { url = new URL(String(proxyUrl || '')); } catch (_error) { throw new Error('代理地址无效：' + proxyUrl); }
  if (url.protocol !== 'http:') throw new Error('只支持 http:// 代理：' + proxyUrl);
  const auth = url.username
    ? 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password || '')).toString('base64')
    : '';
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 80,
    auth: auth
  };
}

function rawHeaderPairs(response) {
  const out = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    out.push(response.rawHeaders[index], response.rawHeaders[index + 1]);
  }
  return out;
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('This operation was aborted', 'AbortError');
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function connectThroughProxy(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const headers = { host: host + ':' + port };
    if (proxy.auth) headers['proxy-authorization'] = proxy.auth;
    const request = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: host + ':' + port, headers: headers, agent: false, setHost: false
    });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const error = new Error('代理 CONNECT 失败：HTTP ' + response.statusCode);
        error.code = 'ERR_PROXY_CONNECT';
        reject(error);
        return;
      }
      resolve({ socket, head });
    });
    request.once('error', reject);
    request.end();
  });
}

function upgradeToTls(socket, host, tlsOptions) {
  const servername = net.isIP(host) ? undefined : host;
  const options = Object.assign({ socket: socket, ALPNProtocols: ['http/1.1'] }, tlsOptions || {});
  if (servername) options.servername = servername;
  const secure = tls.connect(options);
  return new Promise((resolve, reject) => {
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

/**
 * 已经拿到连接（隧道或代理直连）后，用一次性 Agent 把连接塞给 http.request。
 * 直接给 http.request 传 createConnection 会被默认 Agent 忽略，反而去连 host:80。
 */
function requestOverSocket(socket, options, onResponse) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  return http.request(Object.assign({}, options, { agent: agent }), onResponse);
}

function openTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * @param {{ proxyUrl: string, tlsOptions?: import('node:tls').ConnectionOptions, log?: (message: string) => void }} options
 */
export function createProxyDispatcher(options = {}) {
  const proxy = parseProxyUrl(options.proxyUrl);
  const log = typeof options.log === 'function' ? options.log : () => {};

  return {
    dispatch(opts, handler) {
      const target = new URL(opts.origin);
      const isTls = target.protocol === 'https:' || target.protocol === 'wss:';
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const port = Number(target.port) || (isTls ? 443 : 80);

      let settled = false;
      let socket = null;
      let rawSocket = null;
      let currentRequest = null;

      // TLS socket 被 destroy 时不保证把底层 TCP 也关掉，代理那侧会一直挂着，
      // 所以两个都显式销毁。
      const closeTunnel = () => {
        try { if (currentRequest) currentRequest.destroy(); } catch (_error) { /* ignore */ }
        try { if (socket) socket.destroy(); } catch (_error) { /* ignore */ }
        try { if (rawSocket && rawSocket !== socket) rawSocket.destroy(); } catch (_error) { /* ignore */ }
      };

      const finish = (error) => {
        if (settled) return;
        settled = true;
        closeTunnel();
        if (error) handler.onError(error);
      };

      if (typeof handler.onConnect === 'function') {
        handler.onConnect(() => finish(abortError()));
      }

      if (opts.signal) {
        if (opts.signal.aborted) { finish(abortError()); return; }
        opts.signal.addEventListener('abort', () => finish(abortError()), { once: true });
      }

      const headers = Object.assign({}, opts.headers);
      // 让上游别压缩：压缩是 fetch 那一层的事，这里透传会把 zlib 流打乱。
      headers['accept-encoding'] = 'identity';
      headers.connection = 'close';
      headers.host = host + (port === (isTls ? 443 : 80) ? '' : ':' + port);

      const sendPath = isTls ? opts.path : target.origin + opts.path;

      (async () => {
        if (isTls) {
          const tunnel = await connectThroughProxy(proxy, host, port);
          rawSocket = tunnel.socket;
          if (settled) { closeTunnel(); return; }
          if (tunnel.head && tunnel.head.length) rawSocket.unshift(tunnel.head);
          socket = await upgradeToTls(rawSocket, host, options.tlsOptions);
        } else {
          rawSocket = await openTunnel(proxy, host, port);
          socket = rawSocket;
          if (proxy.auth) headers['proxy-authorization'] = proxy.auth;
        }
        // 连接建立期间可能已经被 abort：别把刚拿到的 socket 漏掉。
        if (settled) { closeTunnel(); return; }

        currentRequest = requestOverSocket(socket, {
          host: host,
          port: port,
          method: opts.method,
          path: sendPath,
          headers: headers,
          setHost: false
        }, (response) => {
          let resumed = false;
          const resume = () => {
            if (resumed) return;
            resumed = true;
            response.resume();
          };
          handler.onHeaders(response.statusCode, rawHeaderPairs(response), resume, response.statusMessage);
          response.pause();
          setImmediate(() => { if (!settled) resume(); });

          response.on('data', (chunk) => {
            if (settled) return;
            handler.onData(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            handler.onComplete([]);
            closeTunnel();
            log('tunnel closed after response: ' + host + ':' + port);
          });
          response.on('error', finish);
          response.on('aborted', () => finish(new Error('响应被上游中断')));
        });

        currentRequest.on('error', finish);

        if (opts.body && opts.body !== NO_BODY) {
          for await (const chunk of opts.body) {
            if (settled) return;
            if (!currentRequest.write(chunk)) {
              await new Promise((resolve) => currentRequest.once('drain', resolve));
            }
          }
        }
        currentRequest.end();
      })().catch(finish);
    },
    close() { return Promise.resolve(); },
    destroy() { return Promise.resolve(); }
  };
}

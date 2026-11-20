/**
 * 统一的出站请求入口：先决定要不要走代理，再把 dispatcher 挂到 fetch 上。
 *
 * Node 自带的 fetch（undici）不读 Windows 系统代理，所以这里显式解析
 * （环境变量 → 系统代理，见 lib/proxy.js），回环地址永远直连。
 */
import { resolveProxyForTarget, readSystemProxy } from './proxy.js';
import { createProxyDispatcher } from './proxy-dispatcher.js';
import { localizedError } from './localized-error.js';

let logger = null;
const dispatchers = new Map();
const loggedHosts = new Set();

/** 由 apply() 注入宿主日志；传 null 关掉。 */
export function setNetworkLogger(fn) {
  logger = typeof fn === 'function' ? fn : null;
}

function logLine(message) {
  if (logger) {
    try { logger(message); } catch (_error) { /* ignore */ }
  }
}

function dispatcherFor(proxyUrl) {
  let dispatcher = dispatchers.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = createProxyDispatcher({ proxyUrl: proxyUrl, log: (message) => logLine('proxy: ' + message) });
    dispatchers.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

function hostOf(url) {
  try { return new URL(String(url)).host || '未知主机'; } catch (_error) { return '未知主机'; }
}

function proxyEndpointOf(proxyUrl) {
  try {
    const url = new URL(proxyUrl);
    if (url.host) return url.protocol + '//' + url.host;
  } catch (_error) { /* malformed input can contain credentials */ }
  return '代理地址不可用';
}

export async function resolveRequestProxy(url, options = {}) {
  const env = options.env || process.env;
  let systemProxy = options.systemProxy;
  if (systemProxy === undefined) {
    try { systemProxy = await readSystemProxy(); } catch (_error) { systemProxy = null; }
  }
  return resolveProxyForTarget(url, { env: env, systemProxy: systemProxy });
}

function causeCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code) return String(current.code);
    current = current.cause;
  }
  return '';
}

const PROXY_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'URIError', 'AbortError', 'TimeoutError']);

// Preserve metadata used for retry and timeout decisions. A proxy/transport can
// echo credentials in arbitrary messages or extra properties on the original error.
function safeProxyCause(error, depth = 0) {
  if (!error || depth >= 5) return undefined;
  const name = PROXY_ERROR_NAMES.has(error.name) ? error.name : 'Error';
  const code = error.code;
  const validCode = (typeof code === 'string' || typeof code === 'number') && /^[A-Z0-9_]{1,80}$/.test(String(code));
  const safe = new Error(validCode ? String(code) : name, { cause: safeProxyCause(error.cause, depth + 1) });
  safe.name = name;
  if (validCode) safe.code = code;
  return safe;
}

const HINTS = {
  UND_ERR_CONNECT_TIMEOUT: 'TCP 连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
  UND_ERR_BODY_TIMEOUT: '读取响应体超时',
  UND_ERR_SOCKET: '连接被上游关闭',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: 'DNS 暂时不可用',
  ECONNREFUSED: '连接被拒绝：端口未监听',
  ECONNRESET: '连接被重置',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书是自签名的，校验失败'
};

/** 网络错误的粗分类：客户端按 serverError.network.hint.<kind> 取本地化提示。 */
const HINT_KINDS = {
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
  UND_ERR_SOCKET: 'connection',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNREFUSED: 'connection',
  ECONNRESET: 'connection',
  EHOSTUNREACH: 'connection',
  ENETUNREACH: 'connection',
  CERT_HAS_EXPIRED: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls'
};

function networkDiagnostic(error, url, decision) {
  const host = hostOf(url);
  const proxied = Boolean(decision?.proxyUrl);
  const cause = proxied ? safeProxyCause(error) : error;
  const code = causeCode(cause);
  const detail = code || (proxied ? '代理请求失败' : cause?.message || '');
  return { host, proxied, cause, code, detail };
}

function describeDiagnostic({ host, proxied, code, detail }) {
  const hint = HINTS[code] || '';
  const via = proxied ? '经系统网络配置' : '直连';
  return '网络请求失败：' + host + ' ' + (detail || '未知错误') + '，' + via + '。' + (hint ? hint + '。' : '');
}

export function describeNetworkError(error, url, decision) {
  return describeDiagnostic(networkDiagnostic(error, url, decision));
}

/**
 * 把一次网络失败包成带 locale 信息的 Error：message 继续给工具/日志看，
 * code/params 让设置页按当前语言重写整句。
 */
export function networkFailure(error, url, decision) {
  const diagnostic = networkDiagnostic(error, url, decision);
  const wrapped = new Error(describeDiagnostic(diagnostic), { cause: diagnostic.cause });
  return localizedError(wrapped, 'network.failed', {
    host: diagnostic.host,
    cause: diagnostic.detail,
    via: diagnostic.proxied ? 'proxy' : 'direct',
    hint: HINT_KINDS[diagnostic.code] || ''
  });
}

/**
 * fetch 的替代品：一样的签名，外加按 URL 决定是否走代理。
 * 失败时把 cause.code 翻成人能看懂的话——原来的 "fetch failed" 什么信息都没有。
 */
export async function request(url, init = {}, options = {}) {
  const fetchInit = init || {};
  if (fetchInit.dispatcher) return fetch(url, fetchInit);

  const decision = await resolveRequestProxy(url, options);
  if (!decision.proxyUrl) {
    try {
      return await fetch(url, fetchInit);
    } catch (error) {
      if (error && error.name === 'AbortError') throw localizedError(error, 'network.timeout', { host: hostOf(url) });
      throw networkFailure(error, url, decision);
    }
  }

  const host = hostOf(url);
  const endpoint = proxyEndpointOf(decision.proxyUrl);
  const source = '（来源 ' + decision.source + '）';
  let dispatcher;
  try {
    dispatcher = dispatcherFor(decision.proxyUrl);
  } catch (error) {
    logLine('network: ' + host + ' 的代理配置无效 ' + endpoint + source);
    throw localizedError(new Error('网络连接配置无效：' + error.message), 'network.routeInvalid');
  }
  const key = endpoint + '|' + decision.source + '|' + host;
  if (!loggedHosts.has(key)) {
    loggedHosts.add(key);
    logLine('network: ' + host + ' 走代理 ' + endpoint + source);
  }

  try {
    return await fetch(url, Object.assign({}, fetchInit, { dispatcher: dispatcher }));
  } catch (error) {
    if (error?.name === 'AbortError') throw localizedError(safeProxyCause(error), 'network.timeout', { host });
    const failure = networkFailure(error, url, decision);
    logLine('network: ' + host + ' 经代理 ' + endpoint + source + ' 失败：' + failure.localized.params.cause);
    throw failure;
  }
}

/** 测试用：清掉 dispatcher / 去重缓存。 */
export function resetNetworkState() {
  dispatchers.clear();
  loggedHosts.clear();
}

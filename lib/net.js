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
  try { return new URL(String(url)).host || String(url); } catch (_error) { return String(url); }
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

export function describeNetworkError(error, url, decision) {
  const host = hostOf(url);
  const code = causeCode(error) || (error && error.code) || '';
  const hint = HINTS[code] || '';
  const via = decision && decision.proxyUrl ? '经系统网络配置' : '直连';
  const detail = [code || (error && error.message) || '未知错误', via].join('，');
  return '网络请求失败：' + host + ' ' + detail + '。' + (hint ? hint + '。' : '');
}

/**
 * 把一次网络失败包成带 locale 信息的 Error：message 继续给工具/日志看，
 * code/params 让设置页按当前语言重写整句。
 */
export function networkFailure(error, url, decision) {
  const host = hostOf(url);
  const code = causeCode(error) || (error && error.code) || '';
  const wrapped = new Error(describeNetworkError(error, url, decision), { cause: error });
  return localizedError(wrapped, 'network.failed', {
    host: host,
    cause: code || (error && error.message) || '',
    via: decision && decision.proxyUrl ? 'proxy' : 'direct',
    hint: HINT_KINDS[code] || ''
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

  const dispatcher = (() => {
    try {
      return dispatcherFor(decision.proxyUrl);
    } catch (error) {
      throw localizedError(new Error('网络连接配置无效：' + (error && error.message ? error.message : error)), 'network.routeInvalid');
    }
  })();
  const host = hostOf(url);
  const key = decision.proxyUrl + '|' + host;
  if (!loggedHosts.has(key)) {
    loggedHosts.add(key);
    logLine('network: ' + host + ' 走代理 ' + decision.proxyUrl + '（来源 ' + decision.source + '）');
  }

  try {
    return await fetch(url, Object.assign({}, fetchInit, { dispatcher: dispatcher }));
  } catch (error) {
    if (error && error.name === 'AbortError') throw localizedError(error, 'network.timeout', { host: hostOf(url) });
    logLine('network: ' + host + ' 经代理 ' + decision.proxyUrl + ' 失败：' + (causeCode(error) || error.message));
    throw networkFailure(error, url, decision);
  }
}

/** 测试用：清掉 dispatcher / 去重缓存。 */
export function resetNetworkState() {
  dispatchers.clear();
  loggedHosts.clear();
}

/**
 * 出站请求的凭据收敛：轮询与结果下载各自决定「能不能带鉴权头」。
 *
 * 为什么要单独一层：提交地址是用户配置的提供商，轮询地址和结果地址却常常来自上游响应
 * （polling_url / status_url / urls.get）或 CDN。把提交用的 Key 原样带到这些地址，
 * 等于把凭据发给任何上游指定过的主机。这里只按目标域判断，不看响应内容。
 *
 * 结果图下载**只有 fetchResultImage() 一个入口**：12 条走 execute() 的协议、
 * 异步轮询、通用 composeBody 路径全部走它。别在别处再写一个「拿 URL 直接 GET」的
 * 下载函数——同一个 data[0].url 在两条路径上带不带 Key 不一致，就是这么来的。
 */
import {
  MAX_IMAGE_BYTES, authenticatedUrl, authHeaderNameOf, authHeaders, authSpecOf, baseUrlOf, looksLikeImage, readResponseBytes,
  resolveHttpUrl, sniffType
} from './adapter-kit.js';
import { request } from './net.js';

function parseUrl(value) {
  const url = resolveHttpUrl(value);
  return url ? new URL(url) : null;
}

function baseUrlOfProvider(provider) {
  return baseUrlOf(provider) || String((provider && provider.baseUrl) || '');
}

function plainHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of Object.keys(value)) {
    const header = value[key];
    if (header === undefined || header === null) continue;
    out[key] = String(header);
  }
  return out;
}

/** 声明列表既接受 origin（https://poll.test），也接受 hostname（poll.test）。 */
function isDeclaredTarget(entries, target) {
  if (!Array.isArray(entries)) return false;
  const host = target.host.toLowerCase();
  const hostname = target.hostname.toLowerCase();
  for (const raw of entries) {
    let entry = String(raw || '').trim().toLowerCase();
    if (!entry) continue;
    if (/^https?:\/\//.test(entry)) {
      let parsed = null;
      try { parsed = new URL(entry); } catch (_error) { parsed = null; }
      if (parsed && parsed.origin === target.origin) return true;
      continue;
    }
    if (entry.startsWith('*.')) entry = entry.slice(2);
    else if (entry.startsWith('.')) entry = entry.slice(1);
    if (entry === host || entry === hostname) return true;
  }
  return false;
}

function pollTrustOrigins(adapter) {
  const out = [];
  if (adapter && Array.isArray(adapter.pollOrigins)) out.push(...adapter.pollOrigins);
  if (adapter && adapter.async && typeof adapter.async === 'object' && Array.isArray(adapter.async.trustedPollOrigins)) {
    out.push(...adapter.async.trustedPollOrigins);
  }
  return out;
}

function isTrusted(adapter, provider, url, stage) {
  const target = parseUrl(url);
  const base = parseUrl(baseUrlOfProvider(provider));
  if (!target || !base) return false;
  if (target.origin === base.origin || target.origin === adapter?.operationOrigin) return true;
  const origins = stage === 'poll' ? pollTrustOrigins(adapter) : adapter && adapter.resultAuthOrigins;
  return isDeclaredTarget(origins, target);
}

/**
 * 适配器自己声明的轮询头。新写法挂在适配器上（`taskPollHeaders`），老写法在 `async.pollHeaders`。
 * 描述符（output）**不许**带 headers：一旦允许，就是给「裸请求」开一扇门。
 */
function adapterPollHeaders(adapter, provider) {
  if (!adapter) return null;
  const source = typeof adapter.taskPollHeaders === 'function'
    ? adapter.taskPollHeaders
    : (adapter.async && typeof adapter.async === 'object' ? adapter.async.pollHeaders : null);
  if (typeof source !== 'function') return null;
  try {
    return plainHeaders(source(provider));
  } catch (_error) {
    return null;
  }
}

/**
 * 轮询一跳要带的头。
 *
 * 同源：描述符自己声明的轮询头优先，否则用提供商的默认鉴权头。
 * 跨源：只有适配器明确声明（pollOrigins / async.trustedPollOrigins）才带；
 * 未声明的跨源目标一律裸请求——轮询地址来自上游响应，可能是被篡改的
 * polling_url，描述符构造的 x-key/Bearer 同样不能跟着它走。
 * @returns {Record<string,string>}
 */
export function pollRequestHeaders(adapter, provider, url) {
  if (!isTrusted(adapter, provider, url, 'poll')) return {};
  const name = authHeaderNameOf(provider, adapter).toLowerCase();
  const extra = Object.fromEntries(Object.entries(adapter?.pollHeaders || {}).filter(([key]) => key.toLowerCase() !== name));
  return { ...extra, ...(adapterPollHeaders(adapter, provider) || authHeaders(provider, adapter)) };
}

/**
 * 下载结果图要带的头。
 *
 * 结果地址经常是带签名的 CDN（cdn.test、replicate.delivery…），默认不带任何凭据；
 * 同源则带上（本地 ComfyUI 的 /view 这类接口确实需要鉴权），跨源需适配器声明。
 * @returns {Record<string,string>}
 */
export function downloadRequestHeaders(adapter, provider, url) {
  return isTrusted(adapter, provider, url, 'result') ? authHeaders(provider, adapter) : {};
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A provider operation's configured URL is trusted. Only same-origin redirects inherit its auth. */
export function requestProvider(url, init, provider, adapter, follow = true) {
  const target = resolveHttpUrl(url);
  if (!target) throw new Error('提供商请求地址无效');
  const options = { ...init, redirect: 'manual' };
  const spec = authSpecOf(provider, adapter);
  // Submission redirects are returned to the executor. Following a redirect could replay a mutation.
  if (!follow || (options.method && options.method !== 'GET' && options.method !== 'HEAD')) {
    return request(authenticatedUrl(url, provider, adapter), options);
  }
  const origin = new URL(target).origin;
  return readWithRedirects(url, options, (next) => new URL(next).origin === origin
    ? { url: authenticatedUrl(next, provider, adapter), headers: options.headers }
    : { url: next }, spec.mode === 'query' ? spec.name : '');
}

async function readWithRedirects(url, init, authorize, credentialParam) {
  let next = url;
  for (let hop = 0; ; hop++) {
    const { url: target, headers } = authorize(next);
    const options = { ...init, redirect: 'manual' };
    if (headers && (Object.keys(headers).length || init.method === 'GET')) options.headers = headers;
    else delete options.headers;
    const response = await request(target, options);
    const location = REDIRECTS.has(response.status) && response.headers.get('location');
    if (!location) return response;
    try { await response.body?.cancel(); } catch (_error) { /* already closed */ }
    if (hop >= 4) throw new Error('上游请求重定向次数过多');
    next = resolveHttpUrl(location, next);
    if (!next) throw new Error('上游返回了无效的重定向地址');
    if (credentialParam) {
      const before = new URL(target);
      const after = new URL(next);
      if (before.origin !== after.origin && before.searchParams.has(credentialParam)) {
        after.searchParams.delete(credentialParam, before.searchParams.get(credentialParam));
        next = after.href;
      }
    }
  }
}

/** Re-evaluate authentication at each read-only hop. */
export function requestResult(url, signal, adapter, provider, stage) {
  if (!parseUrl(url)) throw downloadFailure('上游结果地址无效');
  const spec = authSpecOf(provider, adapter);
  return readWithRedirects(url, stage === 'poll' ? { signal, method: 'GET' } : { signal }, (next) => ({
    url: isTrusted(adapter, provider, next, stage) ? authenticatedUrl(next, provider, adapter) : next,
    headers: stage === 'poll' ? pollRequestHeaders(adapter, provider, next) : downloadRequestHeaders(adapter, provider, next)
  }), spec.mode === 'query' ? spec.name : '');
}

function downloadFailure(message, fields) {
  const error = new Error(message);
  error.code = (fields && fields.code) || 'download_failed';
  error.phase = 'download';
  if (fields && fields.status) error.status = fields.status;
  return error;
}

/**
 * 下载成图：与提交/轮询共用同一套凭据判断，并按字节上限与图片签名校验。
 * @returns {Promise<{bytes: Buffer, contentType: string}>}
 */
export async function fetchResultImage(url, signal, adapter, provider) {
  if (!parseUrl(url)) throw downloadFailure('下载生成图失败：结果地址无效');
  const response = await requestResult(url, signal, adapter, provider, 'result');
  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_error) { /* 已关闭 */ }
    throw downloadFailure('下载生成图失败：HTTP ' + response.status, { status: response.status });
  }
  const bytes = await readResponseBytes(response, MAX_IMAGE_BYTES);
  if (!bytes.length || !looksLikeImage(bytes)) {
    throw downloadFailure('下载生成图失败：返回内容不是有效图片');
  }
  return { bytes: bytes, contentType: sniffType(bytes) };
}

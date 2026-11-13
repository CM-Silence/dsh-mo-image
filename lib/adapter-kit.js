/**
 * 请求、解码与错误处理的公共工具。
 *
 * 原本长在 lib/adapters.js 里；协议变多以后拆出来，供 adapters.js 与
 * lib/adapters/*.js 共用，避免循环依赖。
 */
import { request } from './net.js';
import { localizedError } from './localized-error.js';

export const ASPECT_CHOICES = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

export function aspectLabel(width, height) {
  const g = gcd(width, height);
  return width / g + ':' + height / g;
}

export function nearestAspect(width, height, choices = ASPECT_CHOICES) {
  const w = Number(width) || 1024;
  const h = Number(height) || 1024;
  const target = Math.log(w / h);
  let best = choices[0];
  let bestScore = Infinity;
  for (const item of choices) {
    const parts = String(item).split(':');
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!a || !b) continue;
    const score = Math.abs(Math.log(a / b) - target);
    if (score < bestScore) { bestScore = score; best = item; }
  }
  return best;
}

export function resolutionFor(width, height) {
  const pixels = (Number(width) || 1024) * (Number(height) || 1024);
  if (pixels >= 2800 * 2800) return '4k';
  if (pixels >= 1800 * 1800) return '2k';
  return '1k';
}

export function baseUrlOf(provider) {
  return String((provider && provider.baseUrl) || '').replace(/\/+$/, '');
}

/** 按适配器声明的鉴权方式生成头；默认 Bearer。 */
export function authHeaders(provider, adapter) {
  const key = String((provider && provider.key) || '').trim();
  if (!key) return {};
  const type = String((adapter && adapter.authHeader) || 'bearer');
  if (type === 'api-key') return { 'api-key': key };
  if (type === 'x-key') return { 'x-key': key };
  if (type === 'fal-key') return { Authorization: 'Key ' + key };
  return { Authorization: 'Bearer ' + key };
}

export function headersFor(provider, multipart, extra, adapter) {
  const headers = Object.assign({}, extra || {}, authHeaders(provider, adapter));
  if (!multipart && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return headers;
}

export function keyedHeaders(provider, name, multipart) {
  const key = String((provider && provider.key) || '').trim();
  return headersFor(Object.assign({}, provider, { key: '' }), multipart, key ? { [name]: key } : {});
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 provider 的一张图编码成 data URL（编辑接口通用）。 */
export function dataUrlOf(image) {
  return 'data:' + image.contentType + ';base64,' + image.buffer.toString('base64');
}

export async function readJsonResponse(response, maxBytes = 10 * 1024 * 1024) {
  const buffer = await readResponseBytes(response, maxBytes);
  const text = buffer.toString('utf8');
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      detail = parsed && (parsed.error && (parsed.error.message || parsed.error) || parsed.message || parsed.detail) || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch (_error) {
      detail = text.slice(0, 300);
    }
    throw localizedError(
      new Error('本地生图服务返回 HTTP ' + response.status + (detail ? '：' + detail : '')),
      detail ? 'upstream.http' : 'upstream.httpNoDetail',
      { status: response.status, detail: detail }
    );
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw localizedError(new Error('本地生图服务返回的不是 JSON'), 'upstream.invalidJson');
  }
}

export function jsonRequest(adapter, provider, requestPath, body) {
  return { path: requestPath, headers: headersFor(provider, false, adapter.headers, adapter), body: JSON.stringify(body) };
}

export function getPath(node, path) {
  if (!path) return node;
  let current = node;
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined) return null;
    current = current[key];
  }
  return current === undefined ? null : current;
}

export function sniffType(buffer) {
  if (!buffer || buffer.length < 12) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/png';
}

export function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const type = sniffType(buffer);
  if (type === 'image/png') return buffer[0] === 0x89 && buffer[1] === 0x50;
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (type === 'image/webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  return buffer.slice(0, 3).toString('ascii') === 'GIF';
}

export function base64ToImage(text) {
  const raw = String(text || '');
  if (!raw || raw.length < 64) return null;
  const dataUrl = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(raw);
  const payload = dataUrl ? dataUrl[2] : raw;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(payload)) return null;
  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch (_error) {
    return null;
  }
  if (!looksLikeImage(buffer)) return null;
  return { bytes: buffer, contentType: dataUrl ? 'image/' + dataUrl[1].toLowerCase() : sniffType(buffer) };
}

function collectStrings(node, out, depth) {
  if (!node || depth > 6 || out.length > 80) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node)) collectStrings(node[key], out, depth + 1);
  }
}

/**
 * 从任意形状的回应里找出图片：二进制 / b64 / data-url / 外链，全都认。
 */
export function decodeImagePayload(payload, binary) {
  if (binary && looksLikeImage(binary)) return { bytes: binary, contentType: sniffType(binary) };
  if (!payload) throw new Error('生图接口没有返回图片');

  const strings = [];
  collectStrings(payload, strings, 0);

  for (const text of strings) {
    const image = base64ToImage(text);
    if (image) return image;
  }
  for (const text of strings) {
    if (!/^https?:\/\//i.test(text)) continue;
    if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(text)) return { url: text };
  }
  for (const text of strings) {
    if (/^https?:\/\//i.test(text)) return { url: text };
  }
  throw new Error('生图接口返回格式不认识');
}

/** 按上限读取响应体；有 Content-Length 时先拒绝明显超限的响应。 */
export async function readResponseBytes(response, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : Infinity;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
    throw localizedError(new Error('响应体超过大小限制'), 'upstream.tooLarge');
  }
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw localizedError(new Error('响应体超过大小限制'), 'upstream.tooLarge');
    return buffer;
  }
  // Content-Length 可信时直接写进预分配 buffer，避免 chunks + Buffer.concat 的 2 倍峰值。
  if (Number.isFinite(declared) && declared > 0) {
    const out = Buffer.allocUnsafe(Math.floor(declared));
    let offset = 0;
    let overflow = null;
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      if (offset + buffer.length > limit) {
        try { await body.cancel(); } catch (_error) { /* ignore */ }
        throw localizedError(new Error('响应体超过大小限制'), 'upstream.tooLarge');
      }
      if (!overflow && offset + buffer.length <= out.length) {
        buffer.copy(out, offset);
      } else {
        if (!overflow) overflow = [out.subarray(0, offset)];
        overflow.push(buffer);
      }
      offset += buffer.length;
    }
    if (overflow) return Buffer.concat(overflow, offset);
    return offset === out.length ? out : Buffer.from(out.subarray(0, offset));
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      try { await body.cancel(); } catch (_error) { /* ignore */ }
      throw localizedError(new Error('响应体超过大小限制'), 'upstream.tooLarge');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export async function fetchImageUrl(url, signal, maxBytes = MAX_IMAGE_BYTES) {
  const response = await request(url, { signal: signal });
  if (!response.ok) throw new Error('下载生成图失败：HTTP ' + response.status);
  const bytes = await readResponseBytes(response, maxBytes);
  if (!looksLikeImage(bytes)) throw new Error('下载生成图失败：返回内容不是有效图片');
  return { bytes: bytes, contentType: sniffType(bytes) };
}

export function extractMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) return String(parsed.error.message);
      if (typeof parsed.error === 'string') return parsed.error;
      if (parsed.message) return String(parsed.message);
      if (parsed.msg) return String(parsed.msg);
    }
  } catch (_error) {
    /* 不是 JSON，原样返回 */
  }
  return raw;
}

function detectDroppableField(message) {
  const token = "['\"]?([A-Za-z_][A-Za-z0-9_.-]*)['\"]?";
  const patterns = [
    new RegExp('unknown parameter:\\s*' + token, 'i'),
    new RegExp('unrecognized request argument supplied:\\s*' + token, 'i'),
    new RegExp('unknown (?:field|parameter|property)\\s*' + token, 'i'),
    new RegExp('(?:extra|unexpected|unsupported|not supported) (?:field|parameter|property)[^A-Za-z0-9_]*' + token, 'i')
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(message);
    if (hit && hit[1]) return hit[1].trim();
  }
  return null;
}

/** 从结构化错误里取 param 字段；不少兼容网关只在 error.param 里给字段名。 */
function extractErrorParam(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    const param = (parsed && parsed.error && parsed.error.param) || (parsed && parsed.param);
    return typeof param === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(param) ? param.trim() : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 把各家的错误归结成几类，调用方只按 kind 决策。
 */
export function classifyFailure(status, text) {
  const message = extractMessage(text) || ('HTTP ' + status);
  const drop = detectDroppableField(message) || extractErrorParam(text);
  if (drop) return { kind: 'param', drop: drop, message: message };
  if (/size/i.test(message) && /(invalid|unsupported|below|minimum|maximum|too small|too large|budget)/i.test(message)) {
    return { kind: 'size', message: message };
  }
  if (status === 401 || status === 403) return { kind: 'auth', message: message };
  if (status === 404) return { kind: 'endpoint', message: message };
  if (status === 413) return { kind: 'payload', message: message };
  if (status === 429) return { kind: 'rate', message: message, retryable: true };
  if (status >= 500) return { kind: 'upstream', message: message, retryable: true };
  return { kind: 'unknown', message: message };
}

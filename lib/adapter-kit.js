/**
 * 请求、解码与错误处理的公共工具。
 *
 * 原本长在 lib/adapters.js 里；协议变多以后拆出来，供 adapters.js 与
 * lib/adapters/*.js 共用，避免循环依赖。
 */
import { localizedError } from './localized-error.js';
import { isPng, pngHeaderOf } from './png-scale.js';

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

/** 统一成可安全读写的 Buffer；其它类型（包括 Uint8Array 视图）也兼容。 */
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function asciiAt(buffer, offset, text) {
  return buffer.length >= offset + text.length
    && buffer.toString('ascii', offset, offset + text.length) === text;
}

function pngSizeOf(buffer) {
  if (!isPng(buffer)) return null;
  const header = pngHeaderOf(buffer);
  return header ? { width: header.width, height: header.height } : null;
}

function gifSizeOf(buffer) {
  // 6 字节签名 + 7 字节逻辑屏幕描述符；不足就连宽高都读不到。
  if (buffer.length < 13) return null;
  if (!asciiAt(buffer, 0, 'GIF87a') && !asciiAt(buffer, 0, 'GIF89a')) return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width: width, height: height } : null;
}

function webpSizeOf(buffer) {
  // RIFF 头 12 字节 + 首块头 8 字节。
  if (buffer.length < 20) return null;
  if (!asciiAt(buffer, 0, 'RIFF') || !asciiAt(buffer, 8, 'WEBP')) return null;
  const riffSize = buffer.readUInt32LE(4);
  // 有些来源只写首块头、把 riffSize 留成 0，按未声明处理；
  // 一旦声明就必须让容器落在 buffer 内，截断的图不能再当有效图片。
  if (riffSize !== 0 && (riffSize < 12 || riffSize > buffer.length - 8)) return null;
  const chunkSize = buffer.readUInt32LE(16);
  if (chunkSize !== 0 && chunkSize > buffer.length - 20) return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buffer.length < 30) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width: width, height: height } : null;
  }
  if (chunk === 'VP8L') {
    if (buffer.length < 25) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    if (buffer.length < 30) return null;
    const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
    const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
    return { width: width, height: height };
  }
  return null;
}

function isSofMarker(marker) {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function jpegSizeOf(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset++; continue; } // 填充字节
    if (marker === 0x00) { offset += 2; continue; } // 扫描数据里的转义
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01
      || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xda) return null; // 都到扫描数据了还没见 SOF
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // 整段必须落在 buffer 内：只够读宽高、段尾却被截断的 JPEG 仍是坏图。
    const next = offset + 2 + length;
    if (next > buffer.length) return null;
    if (isSofMarker(marker)) {
      // SOF 段头至少要覆盖精度、高、宽和分量数；不足就当作截断。
      if (length < 8 || offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width: width, height: height } : null;
    }
    offset = next;
  }
  return null;
}

/**
 * 从文件头读出真实宽高（不解码整张图）。
 * PNG / JPEG / WebP / GIF 足够覆盖各家回图；结构不完整或认不出返回 null。
 */
export function imageSizeOf(buffer) {
  const bytes = asBuffer(buffer);
  if (!bytes) return null;
  try {
    if (isPng(bytes)) return pngSizeOf(bytes);
    const gif = gifSizeOf(bytes);
    if (gif) return gif;
    const webp = webpSizeOf(bytes);
    if (webp) return webp;
    return jpegSizeOf(bytes);
  } catch (_error) {
    return null;
  }
}

export function sniffType(buffer) {
  const bytes = asBuffer(buffer);
  if (!bytes) return 'image/png';
  if (isPng(bytes)) return 'image/png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif';
  return 'image/png';
}

/** 只有能读出合法宽高的文件头才算图片；截断内容不能混进参考图或下载结果。 */
export function looksLikeImage(buffer) {
  return imageSizeOf(buffer) !== null;
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

/* ---------------------------------------------------------- 结果图下载 */
/*
 * 结果图（data[0].url / output[].url / CDN 链接）**只有一个下载入口**：
 * lib/request-auth.js 的 fetchResultImage()。它按目标域决定带不带凭据——
 * 同源带、跨源默认不带、适配器声明过的 resultAuthOrigins 才带。
 *
 * 这里原本还有一个「裸下载」的 fetchImageUrl()，被 12 条走 execute() 的协议用着；
 * 同一个 data[0].url 在 execute() 路径上不带鉴权、在异步/通用路径上带，二义性就出在这。
 * 现在两条路径都走 fetchResultImage()，判定只有一份（downloadRequestHeaders）。 */

/** 从对象/数组里深挖第一句可读文本（message / detail / error / errors …）。 */
export function errorTextOf(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = errorTextOf(item, depth + 1);
      if (text) return text;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['message', 'msg', 'detail', 'error', 'errors', 'reason', 'logs', 'fail_reason', 'error_message']) {
    if (value[key] === undefined) continue;
    const text = errorTextOf(value[key], depth + 1);
    if (text) return text;
  }
  return '';
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

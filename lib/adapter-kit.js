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

/**
 * 从文件头读出真实宽高（不解码整张图）。
 * PNG / JPEG / WebP / GIF 足够覆盖各家回图；认不出返回 null。
 */
export function imageSizeOf(buffer) {
  if (!buffer || buffer.length < 16) return null;
  // PNG：IHDR 固定在 16/20 字节处。
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF：逻辑屏幕描述符里的宽高，小端。
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // WebP：RIFF 容器，按首块类型分别解析。
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buffer.slice(12, 16).toString('ascii');
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
      const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
      return { width: width, height: height };
    }
    return null;
  }
  // JPEG：一路扫到 SOF 段。
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return null;
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

/* ---------------------------------------------------------- 通用异步任务 */

/**
 * 通用「提交拿任务 → 轮询拿图」形状的识别与轮询辅助，不绑定任何厂商。
 *
 * 覆盖的是 OpenAI 兼容网关里最常见的那套约定：
 *   - 任务 id：task_id / taskId / job_id / request_id / generation_id / prediction_id / id
 *   - 轮询地址：polling_url / status_url / task_url / get_url / urls.get ...
 *   - 状态词：SUCCEEDED / SUCCESS / COMPLETED / READY ...；FAILED / ERROR / CANCELED ...
 *   - 结果图：output_images / images / data / output / result 里的 url / b64_json
 *
 * 认不出来时不猜：调用方按同步响应处理，或者报「格式不认识」。
 */
const TASK_ID_KEYS = [
  'task_id', 'taskId', 'job_id', 'jobId', 'request_id', 'requestId',
  'generation_id', 'generationId', 'prediction_id', 'predictionId', 'id'
];
const TASK_URL_KEYS = [
  'polling_url', 'pollingUrl', 'poll_url', 'pollUrl', 'status_url', 'statusUrl',
  'task_url', 'taskUrl', 'get_url', 'getUrl', 'result_url', 'resultUrl'
];
const TASK_IMAGE_KEYS = [
  'output_images', 'outputImages', 'images', 'image_urls', 'data', 'outputs', 'output',
  'result', 'results', 'artifacts', 'files', 'url', 'image_url', 'imageUrl', 'b64_json', 'base64', 'image'
];
const TASK_SUCCESS = new Set([
  'SUCCEED', 'SUCCEEDED', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'DONE', 'FINISHED', 'READY'
]);
const TASK_FAILURE = new Set([
  'FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'ABORTED', 'REJECTED', 'EXPIRED', 'MODERATED'
]);

/** 任务载荷的常见嵌套层：顶层、data、output、result（数组不算，避免把结果图当任务）。 */
function taskNodes(payload) {
  const nodes = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 2) return;
    nodes.push(node);
    for (const key of ['data', 'output', 'result']) visit(node[key], depth + 1);
  };
  visit(payload, 0);
  return nodes;
}

function firstTaskString(nodes, keys) {
  // 字段名的优先级高于层级：嵌套的 task_id 应该压过顶层的通用 id。
  for (const key of keys) {
    for (const node of nodes) {
      if (typeof node[key] === 'string' && node[key].trim()) return node[key].trim();
    }
  }
  return '';
}

function urlsGetOf(nodes) {
  for (const node of nodes) {
    if (node.urls && typeof node.urls.get === 'string' && node.urls.get.trim()) return node.urls.get.trim();
  }
  return '';
}

/** 从提交响应里认任务：只要拿到任务 id 或轮询地址，就当异步任务。 */
export function readTaskEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const nodes = taskNodes(payload);
  const pollUrl = firstTaskString(nodes, TASK_URL_KEYS) || urlsGetOf(nodes);
  const taskId = firstTaskString(nodes, TASK_ID_KEYS);
  if (!pollUrl && !taskId) return null;
  return { taskId: taskId, pollUrl: pollUrl };
}

function absoluteTaskUrl(value, base) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  try {
    return new URL(text, base.endsWith('/') ? base : base + '/').toString();
  } catch (_error) {
    return '';
  }
}

/**
 * 轮询候选地址：响应里给的优先；没给就按常见约定推两个，最后再试提交地址 + 任务 id。
 * base 以 /v1 结尾时是 /v1/tasks/{id}，只有站点根时补 /v1。
 */
export function taskPollUrls(provider, submission, submitUrl) {
  const base = baseUrlOf(provider);
  const nodes = taskNodes(submission || {});
  const raw = [];
  const direct = firstTaskString(nodes, TASK_URL_KEYS) || urlsGetOf(nodes);
  if (direct) raw.push(direct);
  const taskId = firstTaskString(nodes, TASK_ID_KEYS);
  if (taskId) {
    const id = encodeURIComponent(taskId);
    const root = base.replace(/\/v\d+[a-z0-9]*$/i, '');
    raw.push(root + '/v1/tasks/' + id);
    raw.push(base + '/tasks/' + id);
    if (submitUrl) raw.push(String(submitUrl).replace(/\/+$/, '') + '/' + id);
  }
  const urls = [];
  for (const item of raw) {
    const resolved = absoluteTaskUrl(item, base);
    if (resolved && !urls.includes(resolved)) urls.push(resolved);
  }
  return urls;
}

function statusTextOf(nodes) {
  // 任务专用状态词优先：顶层 status 可能只是「请求成功」，不能当成任务完成。
  for (const key of ['task_status', 'taskStatus', 'status', 'state']) {
    for (const node of nodes) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
      if (value && typeof value === 'object') {
        const nested = value.status || value.state;
        if (typeof nested === 'string' && nested.trim()) return nested.trim().toUpperCase();
      }
    }
  }
  return '';
}

function errorTextOf(value, depth = 0) {
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

/** 明确的错误字段；没有状态词时用它判断任务失败，不去猜普通的 message。 */
export function taskErrorOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const node of taskNodes(payload)) {
    for (const key of ['error', 'errors', 'fail_reason', 'error_message']) {
      if (node[key] === undefined || node[key] === null) continue;
      const text = errorTextOf(node[key]);
      if (text) return text;
    }
  }
  return '';
}

/** 失败任务的人话原因：先找错误字段，再退到 message / detail / logs。 */
export function taskMessageOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const error = taskErrorOf(payload);
  if (error) return error;
  for (const node of taskNodes(payload)) {
    for (const key of ['message', 'msg', 'detail', 'logs', 'reason']) {
      if (node[key] === undefined || node[key] === null) continue;
      const text = errorTextOf(node[key]);
      if (text) return text;
    }
  }
  return '';
}

function imageFromValue(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const decoded = base64ToImage(text);
    if (decoded) return { bytes: decoded.bytes, contentType: decoded.contentType };
    if (/^https?:\/\//i.test(text)) return { url: text };
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = imageFromValue(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of TASK_IMAGE_KEYS) {
      if (value[key] === undefined) continue;
      const hit = imageFromValue(value[key], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function containerImageOf(payload) {
  for (const key of ['output_images', 'outputImages', 'images', 'image_urls', 'data', 'outputs', 'output', 'result', 'results', 'artifacts', 'files']) {
    if (payload[key] === undefined) continue;
    const hit = imageFromValue(payload[key], 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 只看约定的结果字段，避免把回显的参考图或状态地址当结果。
 * containersOnly 用于「任务还在跑」的载荷：连顶层的 url / image 都不认，
 * 免得把任务详情地址当成生成图去下载。
 */
export function taskImageOf(payload, options) {
  if (!payload || typeof payload !== 'object') return null;
  if (options && options.containersOnly) return containerImageOf(payload);
  return imageFromValue(payload);
}

/** 任务已成功但形状不常见时，再按「任意位置的图片」兜底扫一遍。 */
export function looseImageOf(payload) {
  try {
    return decodeImagePayload(payload, null) || null;
  } catch (_error) {
    return null;
  }
}

/** 把任务载荷收敛成三态：成功词、失败词、其余都算进行中。 */
export function taskStatusOf(payload) {
  const nodes = taskNodes(payload);
  const status = statusTextOf(nodes);
  if (status) {
    if (TASK_SUCCESS.has(status)) return { state: 'success', status: status };
    if (TASK_FAILURE.has(status)) {
      return { state: 'failure', status: status, message: taskMessageOf(payload) || status };
    }
    return { state: 'pending', status: status };
  }
  const error = taskErrorOf(payload);
  if (error) return { state: 'failure', status: '', message: error };
  return { state: 'pending', status: '' };
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

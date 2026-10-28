/**
 * 生图请求适配层。
 *
 * 插件其余部分只认「规范形式」：
 *   { model, prompt, size: { width, height, text }, quality?, seed?, images? }
 *
 * 每个适配器声明四件事：
 *   send[]     —— 允许写到请求体里的字段（白名单，没列的一律不发）
 *   size       —— 尺寸怎么编码、该模型接受哪些尺寸
 *   quality    —— 规范 quality 如何映射成该提供商的值
 *   response   —— 怎么从回应里挖出图片字节
 *
 * 新增一个模型族 = 加一条描述符，不用改调用方。
 */

import { createRequire } from 'node:module';
import { decodePng, encodePng, resizeRgba } from './png-scale.js';

const require = createRequire(import.meta.url);
const DEFAULT_SIZE = '1024x1024';

/* ------------------------------------------------------------------ size */

export function parseSize(raw) {
  const text = String(raw || '').trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  if (!text || text === 'auto') return null;
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(text);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { width: width, height: height, text: width + 'x' + height };
}

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

function aspectLabel(width, height) {
  const g = gcd(width, height);
  return width / g + ':' + height / g;
}

function settle(size, adjusted, reason, requested) {
  const text = size && size.text ? size.text : String(size || DEFAULT_SIZE);
  const parsed = size && size.width ? size : parseSize(text);
  return {
    size: text,
    width: parsed ? parsed.width : 0,
    height: parsed ? parsed.height : 0,
    adjusted: !!adjusted,
    reason: reason || '',
    requested: requested || null
  };
}

function nearestAllowed(allowed, width, height) {
  const targetAspect = Math.log(width / height);
  const targetPixels = Math.log(width * height);
  let best = null;
  let bestScore = Infinity;
  for (const item of allowed) {
    if (item === 'auto') continue;
    const parsed = parseSize(item);
    if (!parsed) continue;
    const score = Math.abs(Math.log(parsed.width / parsed.height) - targetAspect) * 6
      + Math.abs(Math.log(parsed.width * parsed.height) - targetPixels) * 0.4;
    if (score < bestScore) {
      bestScore = score;
      best = parsed;
    }
  }
  return best;
}

function clampPixels(width, height, minPixels, maxPixels, multiple) {
  let w = width;
  let h = height;
  if (minPixels && w * h < minPixels) {
    const k = Math.sqrt(minPixels / (w * h));
    w = Math.ceil(w * k);
    h = Math.ceil(h * k);
  }
  if (maxPixels && w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    w = Math.floor(w * k);
    h = Math.floor(h * k);
  }
  w = Math.max(multiple, Math.round(w / multiple) * multiple);
  h = Math.max(multiple, Math.round(h / multiple) * multiple);
  return { width: w, height: h };
}

/**
 * 把用户要的尺寸落成该模型真正接受的尺寸。
 * 返回 { size, width, height, adjusted, reason, requested, rejected? }
 */
export function fitSize(adapter, rawSize) {
  const policy = adapter && adapter.size ? adapter.size : {};
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : null;
  const fallback = parseSize(policy.default || DEFAULT_SIZE) || parseSize(DEFAULT_SIZE);
  const requestedRaw = String(rawSize || '').trim();
  const requestedText = requestedRaw.toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  const requested = parseSize(requestedText);

  if (!requestedText || requestedText === 'none' || requestedText === 'auto') {
    // 用户选了「自动」：请求里干脆不带尺寸，让模型自己决定
    return { size: 'none', width: 0, height: 0, adjusted: false, reason: '', requested: null, omit: true };
  }

  if (!requested) {
    return settle(fallback, !!requestedRaw, requestedRaw ? '尺寸无法识别，改用 ' + fallback.text : '', null);
  }

  if (allowed && allowed.length) {
    if (allowed.includes(requested.text)) {
      return settle(requested, false, '', requested);
    }
    if (policy.onUnsupported === 'reject') {
      return Object.assign(settle(requested, false, '', requested), {
        rejected: true,
        reason: '该模型不支持 ' + requested.text + '，可用尺寸：' + allowed.join(' / ')
      });
    }
    const chosen = nearestAllowed(allowed, requested.width, requested.height) || fallback;
    return settle(chosen, true, requested.text + ' → ' + chosen.text, requested);
  }

  const multiple = Number(policy.multiple) || 1;
  const minPixels = Number(policy.minPixels) || 0;
  const maxPixels = Number(policy.maxPixels) || 0;
  const clamped = clampPixels(requested.width, requested.height, minPixels, maxPixels, multiple);
  const text = clamped.width + 'x' + clamped.height;
  return settle({ width: clamped.width, height: clamped.height, text: text }, text !== requested.text,
    text !== requested.text ? requested.text + ' → ' + text : '', requested);
}

/** 尺寸被上游拒了以后，往上抬一档再试。 */
export function escalateSize(adapter, fitted) {
  if (fitted && fitted.omit) return fitted;
  const policy = adapter && adapter.size ? adapter.size : {};
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : null;
  const currentPixels = (fitted.width || 0) * (fitted.height || 0);
  if (allowed && allowed.length) {
    let best = null;
    for (const item of allowed) {
      const parsed = parseSize(item);
      if (!parsed) continue;
      if (parsed.width * parsed.height > currentPixels && (!best || parsed.width * parsed.height < best.width * best.height)) best = parsed;
    }
    if (best) return settle(best, true, '上游拒绝 ' + fitted.size + '，抬到 ' + best.text, fitted.requested);
  }
  const width = Math.max(1, Math.round((fitted.width || 1024) * 1.5));
  const height = Math.max(1, Math.round((fitted.height || 1024) * 1.5));
  if ((fitted.width || 0) * (fitted.height || 0) < 1024 * 1024) {
    // 没有尺寸白名单时，常见的最小预算是 1MP，一步抬到位，省一次往返
    const k = Math.sqrt((1024 * 1024) / Math.max(1, (fitted.width || 1024) * (fitted.height || 1024)));
    const w = Math.round((fitted.width || 1024) * k);
    const h = Math.round((fitted.height || 1024) * k);
    return settle({ width: w, height: h, text: w + 'x' + h }, true, '上游拒绝 ' + fitted.size + '，抬到 ' + w + 'x' + h, fitted.requested);
  }
  return settle({ width: width, height: height, text: width + 'x' + height }, true, '上游拒绝 ' + fitted.size + '，抬到 ' + width + 'x' + height, fitted.requested);
}

/* -------------------------------------------------------------- adapters */

function encodeSize(adapter, fitted) {
  const policy = adapter.size || {};
  const field = policy.field || 'size';
  const style = policy.style || 'string';
  if (fitted.omit || fitted.size === 'none') return {};
  if (style === 'width-height') return { width: fitted.width, height: fitted.height };
  if (style === 'aspect') {
    const aspects = policy.aspects || ['1:1'];
    const label = aspectLabel(fitted.width || 1024, fitted.height || 1024);
    let chosen = aspects.includes(label) ? label : null;
    if (!chosen) {
      let bestScore = Infinity;
      for (const item of aspects) {
        const parts = String(item).split(':');
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        if (!a || !b) continue;
        const score = Math.abs(Math.log(a / b) - Math.log((fitted.width || 1024) / (fitted.height || 1024)));
        if (score < bestScore) {
          bestScore = score;
          chosen = item;
        }
      }
    }
    return { [field]: chosen || aspects[0] };
  }
  const separator = policy.separator || 'x';
  return { [field]: separator === 'x' ? fitted.size : fitted.size.split('x').join(separator) };
}

function mapQuality(adapter, quality) {
  const value = String(quality || '').trim().toLowerCase();
  // Off：按用户要求完全不发这个参数
  if (!value || value === 'off' || value === 'auto') return undefined;
  const spec = adapter.quality;
  if (!spec) return undefined;
  if (spec.map && spec.map[value]) return spec.map[value];
  if (Array.isArray(spec.allowed) && spec.allowed.includes(value)) return value;
  if (spec.fallback) return spec.fallback;
  return undefined;
}

const ADAPTERS = [
  {
    id: 'dall-e-3',
    label: 'OpenAI DALL·E 3',
    match: (provider, model) => /dall-?e-?3/i.test(model),
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'response_format', 'n'],
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: { map: { low: 'standard', medium: 'standard', high: 'hd', xhigh: 'hd', max: 'hd' } },
    responseFormat: 'b64_json',
    maxN: 1,
    editFields: ['image[]', 'image']
  },
  {
    id: 'gpt-image',
    label: 'OpenAI GPT-Image',
    match: (provider, model) => /gpt-?image/i.test(model),
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'n'],
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '1536x1024', '1024x1536', 'auto'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: { allowed: ['low', 'medium', 'high', 'auto'], map: { max: 'high' } },
    maxN: 10,
    editFields: ['image[]', 'image']
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    match: (provider, model) => /siliconflow/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/images/generations', edit: '/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'image_size', 'batch_size', 'num_inference_steps', 'guidance_scale', 'seed'],
    size: { style: 'string', field: 'image_size', allowed: ['1024x1024', '768x1024', '1024x768', '512x512'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: { map: { low: '8', medium: '20', high: '30', max: '40' } },
    maxN: 1,
    editFields: ['image']
  },
  {
    id: 'volcengine-ark',
    label: '火山方舟',
    match: (provider, model) => /volces\.com/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/images/generations', edit: '/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'size', 'response_format', 'watermark', 'n'],
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '864x1152', '1152x864'], default: '1024x1024', onUnsupported: 'nearest' },
    responseFormat: 'url',
    watermark: false,
    maxN: 1,
    editFields: ['image']
  },
  {
    id: 'stability',
    label: 'Stability AI',
    match: (provider, model) => /stability\.ai/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/v2beta/stable-image/generate/core', edit: '/v2beta/stable-image/generate/sd3' },
    transport: { generate: 'multipart', edit: 'multipart' },
    send: ['prompt', 'aspect_ratio', 'output_format', 'model'],
    size: { style: 'aspect', field: 'aspect_ratio', aspects: ['1:1', '16:9', '3:2', '4:3', '9:16', '2:3'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: null,
    binary: true,
    maxN: 1,
    editFields: ['image']
  },
  {
    // 异步入队型：提交拿 task_id → 轮询到 SUCCEEDED → 下载结果。
    // body 是嵌套结构，用 compose 把白名单字段折叠进去。
    id: 'dashscope-wanx',
    label: '阿里云百炼 · 通义万相',
    match: (provider, model) => /dashscope\.aliyuncs\.com/i.test(provider.baseUrl || '') || /(?:^|[/-])wanx/i.test(model),
    async: true,
    submit: '/services/aigc/text2image/image-synthesis',
    headers: { 'X-DashScope-Async': 'enable' },
    poll: {
      path: '/tasks/{taskId}',
      idPath: 'output.task_id',
      statusPath: 'output.task_status',
      resultPath: 'output.results',
      success: ['SUCCEEDED'],
      failure: ['FAILED', 'CANCELED', 'UNKNOWN'],
      intervalMs: 2000,
      timeoutMs: 300000
    },
    endpoints: { generate: '/services/aigc/text2image/image-synthesis', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'negative_prompt', 'size', 'n'],
    compose: (fields) => ({
      model: fields.model,
      input: { prompt: fields.prompt, negative_prompt: fields.negative_prompt },
      parameters: { size: fields.size, n: fields.n }
    }),
    size: {
      style: 'string', field: 'size', separator: '*',
      allowed: ['1024x1024', '1280x720', '720x1280', '1024x768', '768x1024'],
      default: '1024x1024', onUnsupported: 'nearest'
    },
    quality: null,
    maxN: 4,
    editFields: []
  },
  {
    id: 'openai-images',
    label: 'OpenAI Images 兼容',
    match: () => true,
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'n'],
    // 通用兼容族：尺寸原样透传（保持旧行为），被上游拒了再靠重试往上抬。
    size: { style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    quality: null,
    maxN: 4,
    editFields: ['image[]', 'image']
  }
];

export function listAdapters() {
  return ADAPTERS.map((item) => ({ id: item.id, label: item.label }));
}

export function resolveAdapter(provider, model) {
  const protocol = String((provider && provider.protocol) || '').trim().toLowerCase();
  if (protocol && protocol !== 'openai-images' && protocol !== 'auto' && protocol !== 'images') {
    const byProtocol = ADAPTERS.find((item) => item.id === protocol);
    if (!byProtocol) {
      throw new Error('暂不支持该生图协议：' + protocol + '（可用：' + ADAPTERS.map((item) => item.id).join(' / ') + '）');
    }
    return byProtocol;
  }
  const explicit = String((provider && provider.adapter) || '').trim().toLowerCase();
  if (explicit) {
    const hit = ADAPTERS.find((item) => item.id === explicit);
    if (hit) return hit;
    throw new Error('找不到生图适配器：' + explicit + '（可用：' + ADAPTERS.map((item) => item.id).join(' / ') + '）');
  }
  const modelId = String(model || '');
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match && adapter.match(provider || {}, modelId)) return adapter;
    } catch (_error) {
      /* 一个适配器的判定出错不应影响其它适配器 */
    }
  }
  return ADAPTERS[ADAPTERS.length - 1];
}

export function describeAdapter(adapter) {
  return adapter.id + ' (' + adapter.label + ')';
}

/* -------------------------------------------------------------- requests */

function baseUrlOf(provider) {
  return String((provider && provider.baseUrl) || '').replace(/\/+$/, '');
}

function headersFor(provider, multipart, extra) {
  const headers = Object.assign({ Authorization: 'Bearer ' + String((provider && provider.key) || '') }, extra || {});
  if (!multipart && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return headers;
}

function pickFields(adapter, candidate, drops) {
  const body = {};
  const blocked = drops || new Set();
  for (const key of adapter.send || []) {
    if (blocked.has(key)) continue;
    const value = candidate[key];
    if (value === undefined || value === null || value === '') continue;
    body[key] = value;
  }
  return body;
}

function buildFields(adapter, input) {
  const sizeFields = encodeSize(adapter, input.fitted);
  return Object.assign({
    model: input.model,
    prompt: input.prompt,
    negative_prompt: input.negativePrompt,
    n: adapter.maxN ? Math.min(input.n || 1, adapter.maxN) : undefined,
    quality: mapQuality(adapter, input.quality),
    seed: input.seed,
    response_format: adapter.responseFormat,
    watermark: adapter.watermark,
    output_format: adapter.binary ? 'png' : adapter.outputFormat
  }, sizeFields);
}

/** 白名单过滤 → 需要嵌套 body 的模型再用 compose 折叠。 */
function composeBody(adapter, input, drops) {
  const fields = pickFields(adapter, buildFields(adapter, input), drops);
  return adapter.compose ? adapter.compose(fields) : fields;
}

function jsonRequest(adapter, provider, requestPath, body) {
  return { path: requestPath, headers: headersFor(provider, false, adapter.headers), body: JSON.stringify(body) };
}

export function prepareGenerate(adapter, provider, input, drops) {
  const body = composeBody(adapter, input, drops);
  if (adapter.transport.generate === 'multipart') {
    const form = new FormData();
    for (const key of Object.keys(body)) form.append(key, String(body[key]));
    return { path: adapter.endpoints.generate, headers: headersFor(provider, true, adapter.headers), body: form };
  }
  return jsonRequest(adapter, provider, adapter.endpoints.generate, body);
}

export function prepareEdit(adapter, provider, input, drops, fieldName) {
  const body = composeBody(adapter, input, drops);
  if (adapter.transport.edit !== 'multipart') {
    return jsonRequest(adapter, provider, adapter.endpoints.edit, body);
  }
  const form = new FormData();
  for (const key of Object.keys(body)) form.append(key, String(body[key]));
  const field = fieldName || (adapter.editFields && adapter.editFields[0]) || 'image';
  for (const image of input.images || []) {
    form.append(field, new Blob([image.buffer], { type: image.contentType }), image.filename);
  }
  return { path: adapter.endpoints.edit, headers: headersFor(provider, true, adapter.headers), body: form };
}

/** 异步任务：先提交拿 task_id。 */
export function prepareAsync(adapter, provider, input, drops) {
  return jsonRequest(adapter, provider, adapter.submit, composeBody(adapter, input, drops));
}

export function pollUrlFor(adapter, provider, taskId) {
  const template = String((adapter.poll && adapter.poll.path) || '/tasks/{taskId}');
  return baseUrlOf(provider) + template.replace('{taskId}', encodeURIComponent(taskId));
}

export function pollHeaders(provider) {
  return { Authorization: 'Bearer ' + String((provider && provider.key) || '') };
}

function getPath(node, path) {
  if (!path) return node;
  let current = node;
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined) return null;
    current = current[key];
  }
  return current === undefined ? null : current;
}

export function readTaskId(adapter, payload) {
  const value = getPath(payload, (adapter.poll && adapter.poll.idPath) || 'output.task_id');
  return value ? String(value) : null;
}

/** 把不同平台的「排队中 / 成功 / 失败」收敛成一个三态。 */
export function readTaskState(adapter, payload) {
  const poll = adapter.poll || {};
  const status = String(getPath(payload, poll.statusPath || 'output.task_status') || '').toUpperCase();
  const success = poll.success || ['SUCCEEDED'];
  const failure = poll.failure || ['FAILED', 'CANCELED'];
  if (success.includes(status)) {
    return { state: 'success', status: status, node: getPath(payload, poll.resultPath || 'output') };
  }
  if (failure.includes(status)) {
    const message = String(getPath(payload, 'output.message') || getPath(payload, 'message') || status);
    return { state: 'failure', status: status, message: message };
  }
  return { state: 'pending', status: status };
}

export function adapterBase(provider) {
  return baseUrlOf(provider);
}

/* -------------------------------------------------------------- responses */

function sniffType(buffer) {
  if (!buffer || buffer.length < 12) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/png';
}

function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 100) return false;
  const type = sniffType(buffer);
  if (type === 'image/png') return buffer[0] === 0x89 && buffer[1] === 0x50;
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (type === 'image/webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF';
  return buffer.slice(0, 3).toString('ascii') === 'GIF';
}

function base64ToImage(text) {
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

export async function fetchImageUrl(url, signal) {
  const response = await fetch(url, { signal: signal });
  if (!response.ok) throw new Error('下载生成图失败：HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes: bytes, contentType: response.headers.get('content-type') || sniffType(bytes) };
}

/* ----------------------------------------------------------------- errors */

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
  const patterns = [
    /unknown parameter:\s*['"]([^'"]+)['"]/i,
    /unrecognized request argument supplied:\s*['"]([^'"]+)['"]/i,
    /unknown (?:field|parameter|property)\s*['"]([^'"]+)['"]/i,
    /(?:extra|unexpected|unsupported) (?:field|parameter|property)[^'"]*['"]([^'"]+)['"]/i
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(message);
    if (hit && hit[1]) return hit[1].trim();
  }
  return null;
}

/**
 * 把各家的错误归结成几类，调用方只按 kind 决策。
 */
export function classifyFailure(status, text) {
  const message = extractMessage(text) || ('HTTP ' + status);
  const drop = detectDroppableField(message);
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

/* ----------------------------------------------------------------- resize */

/**
 * 生成尺寸被抬大以后，把结果缩回用户要的尺寸。
 * PNG 走自带的纯 JS 面积平均缩放（无依赖、任何进程可用）；
 * 其它格式再试 Electron 的 nativeImage。
 */
export function resizeTo(bytes, width, height) {
  if (!bytes || !width || !height) return null;
  try {
    const image = decodePng(bytes);
    if (image) {
      if (image.width === width && image.height === height) return { bytes: bytes, contentType: 'image/png', resized: false };
      const rgba = resizeRgba(image.rgba, image.width, image.height, width, height);
      return { bytes: encodePng(rgba, width, height), contentType: 'image/png', resized: true };
    }
  } catch (_error) {
    /* 落到下面的 Electron 通路 */
  }
  try {
    const electron = require('electron');
    const nativeImage = electron && electron.nativeImage;
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
    const image = nativeImage.createFromBuffer(bytes);
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width === width && size.height === height) return { bytes: bytes, contentType: 'image/png', resized: false };
    const resized = image.resize({ width: width, height: height, quality: 'best' });
    const png = resized.toPNG();
    if (!png || !png.length) return null;
    return { bytes: png, contentType: 'image/png', resized: true };
  } catch (_error) {
    return null;
  }
}

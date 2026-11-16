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
import { request } from './net.js';
import { localizedError } from './localized-error.js';
import {
  ASPECT_CHOICES, aspectLabel, nearestAspect, resolutionFor, baseUrlOf, headersFor,
  keyedHeaders, sleep, readJsonResponse, jsonRequest, getPath, sniffType, looksLikeImage,
  base64ToImage, fetchImageUrl, decodeImagePayload, classifyFailure, extractMessage,
  readResponseBytes, MAX_IMAGE_BYTES, imageSizeOf,
  readTaskEnvelope, taskPollUrls, taskStatusOf, taskImageOf, looseImageOf, taskMessageOf
} from './adapter-kit.js';
import { OPENAI_ADAPTERS } from './adapters/openai.js';
import { ASYNC_ADAPTERS } from './adapters/async.js';
import { CN_ADAPTERS } from './adapters/cn.js';

export {
  ASPECT_CHOICES, aspectLabel, nearestAspect, resolutionFor, sniffType, looksLikeImage,
  fetchImageUrl, decodeImagePayload, classifyFailure, extractMessage, readResponseBytes, MAX_IMAGE_BYTES, imageSizeOf,
  readTaskEnvelope, taskPollUrls, taskStatusOf, taskImageOf, looseImageOf, taskMessageOf
};

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

/**
 * 合并出该模型真正适用的尺寸策略：基础策略 + sizeByModel 里第一个命中的覆盖。
 * 同一平台内部规则按模型分叉（Ark 5.5 只有 1K/1.5K/2K，魔搭 Qwen-Image 上限 1664），
 * 所以能力必须按模型算，不能只看适配器。
 */
export function sizePolicyFor(adapter, model) {
  const base = adapter && adapter.size && typeof adapter.size === 'object' ? adapter.size : {};
  const overrides = adapter && Array.isArray(adapter.sizeByModel) ? adapter.sizeByModel : [];
  const id = String(model || '');
  for (const entry of overrides) {
    if (!entry || !entry.size || !(entry.match instanceof RegExp)) continue;
    entry.match.lastIndex = 0;
    if (id && entry.match.test(id)) return Object.assign({}, base, entry.size);
  }
  return base;
}

/**
 * 下发给选择器的尺寸能力：控件形态 + 候选 + hint 代码。
 * 客户端只按这个渲染，不再自己判断"这个模型收不收宽高"。
 */
export function sizeSpecFor(adapter, model) {
  if (!adapter) return { control: 'wh', aspects: [], tiers: [], custom: true, wire: [], stitch: false, hint: '' };
  const policy = sizePolicyFor(adapter, model);
  const allowed = Array.isArray(policy.allowed) ? policy.allowed.filter(Boolean).map(String) : [];
  const control = String(policy.control || (allowed.length ? 'preset' : (policy.style === 'aspect' ? 'aspect' : 'wh')));
  const tiers = (Array.isArray(policy.tiers) ? policy.tiers : [])
    .filter((item) => item && item.value)
    .map((item) => ({ value: String(item.value), pixels: Number(item.pixels) || 0 }));
  return {
    control: control,
    aspects: Array.isArray(policy.aspects) ? policy.aspects.map(String) : [],
    tiers: tiers.length ? tiers : allowed.map((value) => ({ value: value, pixels: 0 })),
    custom: policy.custom === true,
    wire: Array.isArray(policy.wire) ? policy.wire.map(String) : [],
    stitch: policy.stitch === true,
    hint: String(policy.hint || '')
  };
}

/** 档位名（"2K"）解析成 {value, pixels}；不是档位就退成 WxH 像素。 */export function parseTier(adapter, raw, model) {
  const policy = sizePolicyFor(adapter, model);
  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  const text = String(raw || '').trim();
  if (text) {
    const wanted = text.toLowerCase();
    const hit = tiers.find((item) => item && String(item.value || '').toLowerCase() === wanted);
    const pixels = hit ? Number(hit.pixels) : 0;
    if (hit && pixels > 0) return { value: String(hit.value), pixels: pixels };
  }
  const parsed = parseSize(text);
  return parsed
    ? { value: parsed.text, pixels: parsed.width * parsed.height, width: parsed.width, height: parsed.height }
    : null;
}

/** 按像素预算挑最近的档位：只挑最近的可用档，不做阈值猜测。 */
export function nearestTier(tiers, pixels) {
  const list = Array.isArray(tiers) ? tiers : [];
  const target = Math.log(Math.max(1, Number(pixels) || 0));
  let best = null;
  let bestScore = Infinity;
  for (const item of list) {
    const value = Number(item && item.pixels);
    if (!(value > 0)) continue;
    const score = Math.abs(Math.log(value) - target);
    if (score < bestScore) { bestScore = score; best = item; }
  }
  return best;
}

function round8(value) {
  return Math.max(8, Math.round(Number(value) / 8) * 8);
}

/** 比例 + 像素预算 → 具体宽高（两侧对齐 8，会直接当成严格模式的落盘目标）。 */
export function sizeForAspect(aspect, budget) {
  const parts = String(aspect || '1:1').split(':');
  const a = Number(parts[0]) || 1;
  const b = Number(parts[1]) || 1;
  const total = Number(budget) > 0 ? Number(budget) : 1024 * 1024;
  return { width: round8(Math.sqrt((total * a) / b)), height: round8(Math.sqrt((total * b) / a)) };
}

function settle(size, adjusted, reason, requested, extra) {
  const text = size && size.text ? size.text : (size && size.size ? size.size : String(size || DEFAULT_SIZE));
  const width = size && Number(size.width) ? Math.round(Number(size.width)) : 0;
  const height = size && Number(size.height) ? Math.round(Number(size.height)) : 0;
  const parsed = width && height ? { width: width, height: height } : parseSize(text);
  return Object.assign({
    size: text,
    width: parsed ? parsed.width : 0,
    height: parsed ? parsed.height : 0,
    adjusted: !!adjusted,
    reason: reason || '',
    requested: requested || null,
    // 比例/档位/是否把尺寸写进提示词：编码器与严格模式都要用。
    aspect: '',
    tier: '',
    stitch: false
  }, extra || {});
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

function clampPixels(width, height, minPixels, maxPixels, multiple, minSide, maxSide) {
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
  // 有的网关只限制单边（魔搭是每边 [64, 2048]），按比例缩放到区间内，别把比例压扁。
  // 先补下限再收上限：两个方向打架时（极端长宽比）宁可不超上限，否则一定被网关拒。
  if (minSide && Math.min(w, h) < minSide) {
    const k = minSide / Math.min(w, h);
    w = Math.ceil(w * k);
    h = Math.ceil(h * k);
  }
  if (maxSide && Math.max(w, h) > maxSide) {
    const k = maxSide / Math.max(w, h);
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
export function fitSize(adapter, request, model) {
  const policy = sizePolicyFor(adapter, model);
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : null;
  // allowCustom：allowed 只是推荐值，白名单外照发（只受像素/倍数约束）。
  const allowCustom = policy.allowCustom === true;
  const fallback = parseSize(policy.default || DEFAULT_SIZE) || parseSize(DEFAULT_SIZE);
  const objectRequest = request && typeof request === 'object' ? request : null;
  const requestedRaw = String(objectRequest ? (objectRequest.text || '') : (request === undefined || request === null ? '' : request)).trim();
  const requestedText = requestedRaw.toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  const requested = parseSize(requestedText);
  // 档位与比例在这里补齐：编码器只要读 fitted.tier / fitted.aspect，不必自己查策略。
  const done = (value) => withTierAspect(policy, value);

  if (!requestedText || requestedText === 'none' || requestedText === 'auto') {
    // 用户选了「自动」：请求里干脆不带尺寸，让模型自己决定
    return Object.assign(settle('none', false, '', null), { size: 'none', width: 0, height: 0, omit: true });
  }

  // 档位名（"2K"）：size 保留档位名（编码要原样发上去），宽高取该档像素。
  const tier = parseTier(adapter, requestedText, model);
  if (tier && !requested && tier.value) {
    const side = Math.round(Math.sqrt(tier.pixels)) || 0;
    return done(settle({ text: tier.value, width: side, height: side }, false, '', null, { tier: tier.value }));
  }

  if (!requested) {
    return done(settle(fallback, !!requestedRaw, requestedRaw ? '尺寸无法识别，改用 ' + fallback.text : '', null));
  }

  if (allowed && allowed.length && !allowCustom) {
    if (allowed.includes(requested.text)) {
      return done(settle(requested, false, '', requested));
    }
    if (policy.onUnsupported === 'reject') {
      return done(Object.assign(settle(requested, false, '', requested), {
        rejected: true,
        reason: '该模型不支持 ' + requested.text + '，可用尺寸：' + allowed.join(' / ')
      }));
    }
    const chosen = nearestAllowed(allowed, requested.width, requested.height) || fallback;
    return done(settle(chosen, true, requested.text + ' → ' + chosen.text, requested));
  }

  const multiple = Number(policy.multiple) || 1;
  const minPixels = Number(policy.minPixels) || 0;
  const maxPixels = Number(policy.maxPixels) || 0;
  const minSide = Number(policy.minSide) || 0;
  const maxSide = Number(policy.maxSide) || 0;
  const clamped = clampPixels(requested.width, requested.height, minPixels, maxPixels, multiple, minSide, maxSide);
  const text = clamped.width + 'x' + clamped.height;
  return done(settle({ width: clamped.width, height: clamped.height, text: text }, text !== requested.text,
    text !== requested.text ? requested.text + ' → ' + text : '', requested));
}

/** 给落位后的尺寸补上档位与比例：编码器就不必自己再查一遍策略。 */
function withTierAspect(policy, fitted) {
  if (!fitted || fitted.omit || !fitted.width || !fitted.height) return fitted;
  if (!fitted.tier) {
    const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
    if (tiers.length) {
      const tier = nearestTier(tiers, fitted.width * fitted.height);
      if (tier) fitted.tier = String(tier.value);
    }
  }
  if (!fitted.aspect) {
    const aspects = Array.isArray(policy.aspects) ? policy.aspects : null;
    // 只处理冒号格式的比例表；Ideogram 这种 16x9 的由它自己的编码器转换。
    if (aspects && aspects.length && String(aspects[0]).includes(':')) {
      fitted.aspect = nearestAspect(fitted.width, fitted.height, aspects);
    }
  }
  return fitted;
}

function megapixels(value) {
  return (Number(value) / 1e6).toFixed(2);
}

/**
 * 上游拒绝了尺寸以后，告诉用户这个模型到底能吃什么。
 * 顺序：白名单 → 档位名 → 像素区间 → 单边区间 → 倍数 → 根本不收尺寸。
 */
export function sizeHintText(adapter, model) {
  const policy = sizePolicyFor(adapter, model);
  const allowed = Array.isArray(policy.allowed) ? policy.allowed.filter(Boolean) : [];
  if (allowed.length) return '支持的尺寸：' + allowed.join(' / ');
  const tiers = Array.isArray(policy.tiers) ? policy.tiers.filter((item) => item && item.value) : [];
  if (tiers.length) return '支持的档位：' + tiers.map((item) => item.value).join(' / ');
  const parts = [];
  const minPixels = Number(policy.minPixels) || 0;
  const maxPixels = Number(policy.maxPixels) || 0;
  const minSide = Number(policy.minSide) || 0;
  const maxSide = Number(policy.maxSide) || 0;
  const multiple = Number(policy.multiple) || 1;
  if (minPixels && maxPixels) parts.push('总像素 ' + megapixels(minPixels) + '–' + megapixels(maxPixels) + 'MP');
  else if (minPixels) parts.push('总像素不少于 ' + megapixels(minPixels) + 'MP');
  else if (maxPixels) parts.push('总像素不超过 ' + megapixels(maxPixels) + 'MP');
  if (minSide && maxSide) parts.push('每边 ' + minSide + '–' + maxSide + 'px');
  else if (minSide) parts.push('每边不少于 ' + minSide + 'px');
  else if (maxSide) parts.push('每边不超过 ' + maxSide + 'px');
  if (multiple > 1) parts.push('宽高需为 ' + multiple + ' 的倍数');
  const wire = Array.isArray(policy.wire) ? policy.wire : null;
  if (!parts.length) return wire && !wire.length ? '该模型不接受尺寸参数' : '该模型没有声明尺寸范围';
  return '支持的尺寸：' + parts.join('，');
}

/* -------------------------------------------------------------- adapters */

function encodeSize(adapter, fitted, model) {
  const policy = sizePolicyFor(adapter, model);
  const field = policy.field || 'size';
  const style = policy.style || 'string';
  if (fitted.omit || fitted.size === 'none') return {};
  // 少数平台只认档位名（火山方舟的 1K/1.5K/2K）；已经就是档位就原样发，
  // 是像素且贴近某一档才换成档位名，其余照发像素。
  // 只有"真的把档位名发上去"的平台才在 encode 时把像素换成档位；
  // 中转站 / 通用网关的 tiers 只是面板上的档位，线上仍然发 WxH。
  const tiers = policy.tierLabels === true
    ? (Array.isArray(policy.tiers) && policy.tiers.length
      ? policy.tiers
      : (Array.isArray(policy.presets) ? policy.presets : null))
    : null;
  if (tiers) {
    const parsed = parseSize(fitted.size);
    const isLabel = !parsed && String(fitted.size || '').trim() !== '';
    if (isLabel) return { [field]: fitted.size };
    const pixels = (fitted.width || 1024) * (fitted.height || 1024);
    for (const tier of tiers) {
      if (!tier || !tier.pixels) continue;
      if (Math.abs(pixels - tier.pixels) / tier.pixels <= 0.12) return { [field]: tier.value };
    }
    return { [field]: fitted.size };
  }
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

export function qualityOptionsFor(adapter, model) {
  const spec = adapter && adapter.quality;
  if (!spec) return null;
  const rawOptions = typeof spec.options === 'function' ? spec.options(model) : spec.options;
  if (!Array.isArray(rawOptions) || !rawOptions.length) return null;
  const options = rawOptions
    .map((item) => ({ value: String(item && item.value || '').trim().toLowerCase(), label: String(item && item.label || '') }))
    .filter((item) => item.value);
  if (!options.length) return null;
  const wanted = String(spec.default || '').trim().toLowerCase();
  const fallback = options.some((item) => item.value === wanted) ? wanted : options[0].value;
  return { label: spec.label || '质量', options, default: fallback };
}

export function qualityForAdapter(adapter, value, model) {
  const spec = qualityOptionsFor(adapter, model);
  if (!spec) return undefined;
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'off') return 'off';
  return spec.options.some((item) => item.value === raw) ? raw : spec.default;
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

const IMAGE_MODEL_KEYWORDS = [
  'image', 'imagen', 'gpt-image', 'gptimage', 'dall-e', 'dalle', 'flux',
  'stable-diffusion', 'sdxl', 'sd3', 'diffusion', 't2i',
  'seedream', 'seededit', 'qwen-image', 'wanx', 'kolors', 'cogview',
  'ideogram', 'recraft', 'grok-imagine', 'nano-banana',
  'midjourney', 'journey', 'playground', 'photon', 'krea', 'hidream',
  'janus', 'emu', 'sana', 'pixart', 'dreamshaper', 'realvis',
  'juggernaut', 'fibo', 'lumina', 'chroma', 'omnigen', 'bagel',
  'sprite', 'paint'
];
const NON_IMAGE_MODEL_KEYWORDS = [
  'embedding', 'embed', 'whisper', 'tts', 'audio', 'speech',
  'moderation', 'rerank', 'transcribe', 'ocr', 'llava', 'image-to-text'
];
const EXACT_IMAGE_MODEL_IDS = new Set(['core']);

const ASPECT_CHOICES_14 = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];

/** 这些主机有自己的适配器：模型名匹配不能抢在主机匹配前面。 */
const MAJOR_HOSTS = /(^|\.)openai\.azure\.com$|(^|\.)openrouter\.ai$|(^|\.)bfl\.ai$|(^|\.)queue\.fal\.run$|(^|\.)fal\.run$|(^|\.)falrun\.com$|(^|\.)api\.replicate\.com$/;

function hostOfBase(baseUrl) {
  return String(baseUrl || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

/** Ideogram 把模型写进路径：/v2/image/generate/{model}。 */
function ideogramPath(input) {
  const model = String((input && input.model) || 'ideogram-3').trim().replace(/^\/+/, '') || 'ideogram-3';
  return '/v2/image/generate/' + model;
}

function normalizeModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/[_\s./:]+/g, '-');
}

/** Generic OpenAI-compatible `/models` often returns chat, embedding and image models together. */
export function isLikelyImageModel(model) {
  const id = normalizeModelId(model);
  if (!id) return false;
  if (EXACT_IMAGE_MODEL_IDS.has(id)) return true;
  if (NON_IMAGE_MODEL_KEYWORDS.some((keyword) => id.includes(keyword))) return false;
  return IMAGE_MODEL_KEYWORDS.some((keyword) => id.includes(keyword));
}

export function filterImageModels(models) {
  return (Array.isArray(models) ? models : []).filter(isLikelyImageModel);
}

/* ------------------------------------------------------------ ComfyUI 工作流 */

import { parseWorkflow, uiToApi, analyzeWorkflow, injectByMapping, applyWorkflowParams } from './comfy-workflow.js';

const OBJECT_INFO_TTL = 5 * 60 * 1000;
// 装了很多自定义节点的 ComfyUI，一次 /object_info 就能到 20MB+。
// 缓存必须有条数与字节上限，否则在设置页来回切换就会把整份签名长期钉在内存里。
const OBJECT_INFO_LIMIT = 50;
const OBJECT_INFO_BUDGET = 4 * 1024 * 1024;

/** 已完成的签名：key -> { at, bytes, data }。 */
const objectInfoCache = new Map();
/** 进行中的签名：key -> Promise。并发的设置页解析、模型列表和工作流执行共用一次请求。 */
const objectInfoInflight = new Map();
let objectInfoBytes = 0;

/**
 * 凭据版本引用：换了 Key 就不能复用旧权限下取回的签名，所以凭据必须参与缓存键；
 * 但键会长期留在 Map 里，不能出现明文 Key。这里只用长度 + FNV-1a 哈希做版本引用。
 */
function credentialRef(provider) {
  const key = String((provider && provider.key) || '');
  if (!key) return 'anon';
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return key.length + ':' + hash.toString(16);
}

/** 缓存键：baseUrl + 节点 + 字段 + 凭据版本。全量读没有节点/字段，两段留空。 */
function objectInfoKey(base, provider, node, field) {
  return [String(base || ''), String(node || ''), String(field || ''), credentialRef(provider)].join('\u0000');
}

function evictObjectInfo(key) {
  const entry = objectInfoCache.get(key);
  if (!entry) return;
  objectInfoBytes -= entry.bytes;
  objectInfoCache.delete(key);
}

/** 过期项在每次读写时清掉；超容量时按写入顺序淘汰最旧的。 */
function pruneObjectInfo(now) {
  for (const [key, entry] of objectInfoCache) {
    if (now - entry.at >= OBJECT_INFO_TTL) evictObjectInfo(key);
  }
  // 留一格给马上要写入的条目，避免刚放进来的缓存立刻被自己挤掉。
  while (objectInfoCache.size >= OBJECT_INFO_LIMIT) {
    const oldest = objectInfoCache.keys().next().value;
    if (oldest === undefined) break;
    evictObjectInfo(oldest);
  }
}

function rememberObjectInfo(key, data) {
  let bytes = 0;
  try {
    // 只需要量级判断：按 JSON 字符长度估算，不做逐字节统计。
    bytes = JSON.stringify(data)?.length || 0;
  } catch (_error) {
    bytes = 0;
  }
  pruneObjectInfo(Date.now());
  // Map 的插入顺序就是淘汰顺序：重写同一个键时先删再加，让它回到队尾。
  evictObjectInfo(key);
  objectInfoCache.set(key, { at: Date.now(), bytes, data });
  objectInfoBytes += bytes;
  // 超预算先淘汰旧条目，但永远保留刚写入的一条，否则超大签名会一次都缓存不上。
  while (objectInfoBytes > OBJECT_INFO_BUDGET && objectInfoCache.size > 1) {
    const oldest = objectInfoCache.keys().next().value;
    if (oldest === undefined) break;
    evictObjectInfo(oldest);
  }
}

/** 同一个 key 的进行中请求只发一次；失败时占位也必须清掉（失败不缓存，下次还能重试）。 */
function trackObjectInfo(key, task) {
  const pending = objectInfoInflight.get(key);
  if (pending) return pending;
  let tracked;
  tracked = task.finally(() => {
    if (objectInfoInflight.get(key) === tracked) objectInfoInflight.delete(key);
  });
  objectInfoInflight.set(key, tracked);
  return tracked;
}

/** 测试用：清掉 ComfyUI 节点签名缓存和进行中占位。 */
export function resetComfyObjectInfoCache() {
  objectInfoCache.clear();
  objectInfoInflight.clear();
  objectInfoBytes = 0;
}

/** 拉全量节点签名并缓存；UI 格式工作流和模型列表都靠它。 */
async function comfyObjectInfo(base, provider, signal) {
  const key = objectInfoKey(base, provider, '', '');
  const hit = objectInfoCache.get(key);
  if (hit) {
    if (Date.now() - hit.at < OBJECT_INFO_TTL) return hit.data;
    evictObjectInfo(key);
  }
  const pending = objectInfoInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const response = await request(base + '/object_info', { headers: headersFor(provider, false), signal });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
      throw new Error('读不到 ComfyUI 的节点签名（/object_info），请确认服务在运行。');
    }
    const data = await readJsonResponse(response, 40 * 1024 * 1024);
    rememberObjectInfo(key, data);
    return data;
  })();
  return trackObjectInfo(key, task);
}

/**
 * 读某个 loader 节点可选的模型名。优先只取单节点，避免自定义节点很多时
 * /object_info 的 20MB+ 全量响应；节点级 404 时退回全量。
 *
 * 节点候选只合并进行中的相同请求，不做 TTL 缓存：用户往 models/ 里放个文件
 * 就该在下次拉列表时看到，这里必须保持「当下装了什么」的语义。
 */
async function comfyNodeOptions(base, provider, node, field, signal) {
  const key = objectInfoKey(base, provider, node, field);
  const pending = objectInfoInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    let response = await request(base + '/object_info/' + node, { headers: headersFor(provider, false), signal });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
      response = await request(base + '/object_info', { headers: headersFor(provider, false), signal });
      if (!response.ok) return [];
    }
    const payload = await readJsonResponse(response, 20 * 1024 * 1024);
    const entry = payload && payload[node];
    const inputs = entry && entry.input;
    const names = (inputs && inputs.required && inputs.required[field])
      || (inputs && inputs.optional && inputs.optional[field]);
    const list = Array.isArray(names) ? names[0] : null;
    return Array.isArray(list) ? list.map((name) => String(name)).filter(Boolean) : [];
  })();
  return trackObjectInfo(key, task);
}

const FLUX2_NAME = /flux[._\-\s]?2/i;
/** MOSS 的编码器/VAE 名字长得很像 FLUX 的，装在一起时必须靠这些特征排除。 */
const MOSS_CLIP_NAME = /qwen3?[._\-\s]?5|9b/i;
const MOSS_VAE_NAME = /_small/i;

/** FLUX.2 是单文本编码器架构：按名字挑 qwen 编码器和 flux2 VAE。 */
async function comfyFluxAssets(base, provider, model, signal) {
  if (!FLUX2_NAME.test(String(model || ''))) {
    throw new Error('ComfyUI 目前内置的是 FLUX.2 系列（diffusion_models）工作流；'
      + '其它架构（如 FLUX.1、Qwen-Image、Z-Image）请改用「其他 OpenAI 兼容网关」。');
  }
  const clips = await comfyNodeOptions(base, provider, 'CLIPLoader', 'clip_name', signal);
  const vaes = await comfyNodeOptions(base, provider, 'VAELoader', 'vae_name', signal);
  const clip = clips.find((name) => /qwen[._\-\s]?3[._\-\s]?4b/i.test(name))
    || clips.find((name) => /qwen/i.test(name) && !MOSS_CLIP_NAME.test(name))
    || (clips.length === 1 ? clips[0] : null);
  const vae = vaes.find((name) => FLUX2_NAME.test(name) && !MOSS_VAE_NAME.test(name))
    || (vaes.length === 1 ? vaes[0] : null);
  if (!clip) throw new Error('ComfyUI 里找不到 FLUX.2 的文本编码器（models/text_encoders/qwen_3_4b.safetensors）。');
  if (!vae) throw new Error('ComfyUI 里找不到 FLUX.2 的 VAE（models/vae/flux2-vae.safetensors）。');
  return { clip, vae };
}

async function comfyUploadImage(base, provider, image, signal) {
  const form = new FormData();
  form.append('image', new Blob([image.buffer], { type: image.contentType || 'image/png' }),
    image.filename || 'reference.png');
  form.append('overwrite', 'true');
  const response = await request(base + '/upload/image', {
    method: 'POST', headers: headersFor(provider, true), body: form, signal
  });
  const payload = await readJsonResponse(response, 2 * 1024 * 1024);
  const name = payload && payload.name;
  if (!name) throw new Error('ComfyUI 上传参考图失败');
  const subfolder = payload.subfolder ? String(payload.subfolder) + '/' : '';
  return subfolder + String(name);
}

function comfyCheckpointWorkflow({ kind, input, model, width, height, seed, imageName }) {
  const workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: (input && input.negativePrompt) || '', clip: ['1', 1] } }
  };
  if (kind === 'edit') {
    workflow['4'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    workflow['5'] = { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } };
    workflow['6'] = {
      class_type: 'KSampler',
      inputs: {
        seed, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0]
      }
    };
    workflow['7'] = { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } };
    workflow['8'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['7', 0] } };
    return workflow;
  }
  workflow['4'] = { class_type: 'EmptyLatentImage', inputs: { width: width, height: height, batch_size: 1 } };
  workflow['5'] = {
    class_type: 'KSampler',
    inputs: {
      seed: seed, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0]
    }
  };
  workflow['6'] = { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } };
  workflow['7'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['6', 0] } };
  return workflow;
}

async function comfyFluxWorkflow(base, provider, { kind, input, model, width, height, seed, signal }) {
  const assets = await comfyFluxAssets(base, provider, model, signal);
  const workflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: assets.clip, type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: assets.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
    '7': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '8': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '9': { class_type: 'Flux2Scheduler', inputs: { steps: 4, width: width, height: height } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['12', 0] } }
  };
  if (kind === 'edit') {
    const reference = input.images && input.images[0];
    if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
    const imageName = await comfyUploadImage(base, provider, reference, signal);
    workflow['20'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    workflow['21'] = {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: ['20', 0], upscale_method: 'nearest-exact', megapixels: 1.0, resolution_steps: 1 }
    };
    workflow['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['3', 0] } };
    workflow['23'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['4', 0], latent: ['22', 0] } };
    workflow['24'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['5', 0], latent: ['22', 0] } };
    workflow['10'] = {
      class_type: 'CFGGuider',
      inputs: { model: ['1', 0], positive: ['23', 0], negative: ['24', 0], cfg: 1 }
    };
  } else {
    workflow['10'] = {
      class_type: 'CFGGuider',
      inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], cfg: 1 }
    };
  }
  workflow['11'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['7', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['6', 0] }
  };
  return workflow;
}

const MOSS_NAME = /moss/i;

async function comfyMossAssets(base, provider, signal) {
  const clips = await comfyNodeOptions(base, provider, 'CLIPLoader', 'clip_name', signal);
  const vaes = await comfyNodeOptions(base, provider, 'VAELoader', 'vae_name', signal);
  const clip = clips.find((name) => /qwen3[._]5/i.test(name))
    || clips.find((name) => /9b/i.test(name))
    || null;
  const vae = vaes.find((name) => /flux2-vae_small/i.test(name))
    || vaes.find((name) => FLUX2_NAME.test(name))
    || null;
  if (!clip) throw new Error('ComfyUI 里找不到 MOSS-Image 的文本编码器（models/text_encoders/qwen3.5_9b*.safetensors）。');
  if (!vae) throw new Error('ComfyUI 里找不到 MOSS-Image 的 VAE（models/vae/flux2-vae_small.safetensors）。');
  return { clip, vae };
}

async function comfyMossWorkflow(base, provider, { input, model, width, height, seed, signal }) {
  if (!MOSS_NAME.test(String(model || ''))) {
    throw new Error('ComfyUI 目前内置的是 MOSS-Image（diffusion_models）文生图工作流。');
  }
  const assets = await comfyMossAssets(base, provider, signal);
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: assets.clip, type: 'moss_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: assets.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: (input && input.negativePrompt) || '', clip: ['2', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: seed, steps: 25, cfg: 2.5, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0]
      }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['8', 0] } }
  };
}

const MOSS_EDIT_NEGATIVE = 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact';

/**
 * MOSS-Image 编辑：编辑 LoRA 叠在 SFT 主干上，指令和参考图一起交给
 * TextEncodeMOSSImageEdit 编码，采样器在原画面上只重绘被描述的部分。
 * 参数取自官方 image_moss_image_edit 模板（30 步 / cfg 4 / euler / normal / denoise 1）。
 */
async function comfyMossEditWorkflow(base, provider, { input, model, seed, signal }) {
  const assets = await comfyMossAssets(base, provider, signal);
  const loras = await comfyNodeOptions(base, provider, 'LoraLoaderModelOnly', 'lora_name', signal);
  const lora = loras.find((name) => /moss/i.test(name) && /edit/i.test(name));
  if (!lora) {
    throw new Error('ComfyUI 里找不到 MOSS-Image 的编辑 LoRA（models/loras/moss_image_edit_lora_rank_64_bf16.safetensors），'
      + '图生图无法进行；请放入该文件后重试，或改用 FLUX.2 模型。');
  }
  const reference = input.images && input.images[0];
  if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
  const imageName = await comfyUploadImage(base, provider, reference, signal);
  return {
    '8': { class_type: 'LoadImage', inputs: { image: imageName } },
    '27': { class_type: 'GetImageSize', inputs: { image: ['8', 0] } },
    // 输出比例跟原图走
    '28': { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['27', 0], height: ['27', 1], batch_size: 1 } },
    '29': {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: ['8', 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 16 }
    },
    '30': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '31': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['30', 0], lora_name: lora, strength_model: 1 } },
    '32': {
      class_type: 'SkipLayerGuidanceDiTSimple',
      inputs: { model: ['31', 0], double_layers: '', single_layers: '22', start_percent: 0, end_percent: 1 }
    },
    '33': { class_type: 'CLIPLoader', inputs: { clip_name: assets.clip, type: 'moss_image', device: 'default' } },
    '34': { class_type: 'VAELoader', inputs: { vae_name: assets.vae } },
    '36': {
      class_type: 'TextEncodeMOSSImageEdit',
      inputs: {
        clip: ['33', 0], prompt: (input && input.negativePrompt) || MOSS_EDIT_NEGATIVE,
        edit_format: 'Moss-Image-Edit', image_strength: 1, 'images.image_0': ['29', 0], vae: ['34', 0]
      }
    },
    '39': {
      class_type: 'TextEncodeMOSSImageEdit',
      inputs: {
        clip: ['33', 0], prompt: input.prompt,
        edit_format: 'Moss-Image-Edit', image_strength: 1, 'images.image_0': ['29', 0], vae: ['34', 0]
      }
    },
    '37': {
      class_type: 'KSampler',
      inputs: {
        seed: seed, steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['32', 0], positive: ['39', 0], negative: ['36', 0], latent_image: ['28', 0]
      }
    },
    '38': { class_type: 'VAEDecode', inputs: { samples: ['37', 0], vae: ['34', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['38', 0] } }
  };
}

/**
 * ComfyUI 队列轮询的退避曲线。
 *
 * 固定 700ms 会在排队久的任务上把本地服务刷成每秒 1.4 次查询；本地接口虽然便宜，
 * 但 ComfyUI 单进程还要渲染，空转查询会抢它的时间片。改成 1s 起步、每次 ×1.15～1.3、
 * 5s 封顶：刚提交时反应快，跑久了自动降频。抖动是必要的——多会话同时提交时，
 * 没有抖动它们会一直同相位地一起打。
 */
const COMFY_POLL_START_MS = 1000;
const COMFY_POLL_MAX_MS = 5000;

function nextComfyPollDelay(current) {
  const factor = 1.15 + Math.random() * 0.15;
  return Math.min(COMFY_POLL_MAX_MS, Math.round(current * factor));
}

async function comfySubmitAndWait(base, provider, workflow, signal) {
  const submitted = await readJsonResponse(await request(base + '/prompt', {
    method: 'POST', headers: headersFor(provider, false),
    body: JSON.stringify({ prompt: workflow, client_id: 'dsh-mo-image' }), signal
  }), 2 * 1024 * 1024);
  const promptId = submitted && submitted.prompt_id;
  if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id');
  // 总超时不变（5 分钟），只是查询频率随等待变长而下降。
  const deadline = Date.now() + 300000;
  let history = null;
  let wait = COMFY_POLL_START_MS;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('已取消');
    // 最后一次等待不能越过 deadline，否则「5 分钟超时」会被退避悄悄拉长。
    await sleep(Math.min(wait, deadline - Date.now()));
    wait = nextComfyPollDelay(wait);
    const poll = await request(base + '/history/' + encodeURIComponent(promptId), {
      headers: headersFor(provider, false), signal
    });
    if (!poll.ok) {
      if (poll.status === 404) continue;
      throw new Error('ComfyUI 查询任务失败：HTTP ' + poll.status);
    }
    const payload = await readJsonResponse(poll, 10 * 1024 * 1024);
    if (payload && payload[promptId]) { history = payload[promptId]; break; }
  }
  if (!history) throw new Error('ComfyUI 生成超时，请检查队列和显存');
  const state = history.status || {};
  if (state.status_str === 'error') {
    let detail = '';
    for (const message of state.messages || []) {
      if (message && message[0] === 'execution_error') {
        const info = message[1] || {};
        detail = String(info.exception_message || info.exception_type || '').trim();
      }
    }
    throw new Error('ComfyUI 执行失败' + (detail ? '：' + detail : '，请检查 ComfyUI 控制台'));
  }
  const outputs = history.outputs || {};
  let image = null;
  for (const node of Object.values(outputs)) {
    if (node && Array.isArray(node.images) && node.images[0] && node.images[0].filename) {
      image = node.images[0];
      break;
    }
  }
  if (!image) throw new Error('ComfyUI 没有返回图片');
  const query = new URLSearchParams({
    filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output'
  });
  return fetchImageUrl(base + '/view?' + query.toString(), signal);
}

/* ------------------------------------------------------ 自定义工作流模板 */

/**
 * 用户可以在「模型选项」里粘一段 ComfyUI 导出的 API 格式工作流，
 * 用这些占位符把运行时参数填进去。这样任何架构都能接，不必等插件补代码。
 */
export const COMFY_WORKFLOW_PLACEHOLDERS = [
  'prompt', 'negative_prompt', 'width', 'height', 'seed', 'model', 'image'
];

const PLACEHOLDER_EXACT = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const PLACEHOLDER_ANY = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function placeholderError(key) {
  return new Error('自定义工作流里有未知占位符 {{' + key + '}}；可用：'
    + COMFY_WORKFLOW_PLACEHOLDERS.map((name) => '{{' + name + '}}').join('、'));
}

function fillString(text, values, lenient) {
  const exact = PLACEHOLDER_EXACT.exec(text);
  if (exact) {
    const key = exact[1];
    // 整个字段就是一个占位符时保留原始类型（seed/width 必须是数字）
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined) return values[key];
    if (lenient) return '';
    throw placeholderError(key);
  }
  return text.replace(PLACEHOLDER_ANY, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const value = values[key];
      return value === undefined || value === null ? '' : String(value);
    }
    if (lenient) return '';
    throw placeholderError(key);
  });
}

/** 深拷贝模板并替换占位符；源模板不会被改动。 */
export function applyWorkflowTemplate(template, values, options) {
  const lenient = !!(options && options.lenient);
  const walk = (node) => {
    if (typeof node === 'string') return fillString(node, values, lenient);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  return walk(template);
}

/**
 * 这个模型的尺寸能不能落到请求里。
 * 自定义工作流既没有 {{width}} 占位符、映射里也没有宽高时，尺寸写不进去——
 * 调用方据此改走「把尺寸写进提示词」，而不是静默丢掉。
 */
export function comfySizeWritable(provider, model) {
  const raw = comfyCustomWorkflow(provider, model);
  if (!raw) return true;
  if (/\{\{\s*width\s*\}\}/.test(raw) && /\{\{\s*height\s*\}\}/.test(raw)) return true;
  const entry = provider && provider.modelOptions ? provider.modelOptions[model] : null;
  const mapping = entry && entry.mapping ? entry.mapping : null;
  return !!(mapping && mapping.width && mapping.height);
}

/** 该模型有没有配置自定义工作流；没有就返回空串，走内置图。 */
function comfyCustomWorkflow(provider, model) {
  const options = provider && provider.modelOptions;
  if (!options || typeof options !== 'object') return '';
  const entry = options[model];
  if (!entry || typeof entry !== 'object') return '';
  return typeof entry.workflow === 'string' ? entry.workflow.trim() : '';
}

/**
 * 设置页解析用：把用户贴的工作流变成映射与候选。
 * UI 格式缺签名的节点会导致悬空连线，所以这里当硬错误处理。
 */
export async function analyzeComfyWorkflow({ base, provider, workflow, signal }) {
  const parsed = parseWorkflow(workflow);
  const info = await comfyObjectInfo(base, provider, signal);
  let graph = parsed.graph;
  if (parsed.format === 'ui') {
    const converted = uiToApi(parsed.ui, info);
    if (converted.missing.length) {
      throw new Error('工作流里的节点没有安装：' + converted.missing.join('、')
        + '。请在 ComfyUI 里装好它们，或改贴 API 格式的工作流。');
    }
    graph = converted.graph;
  }
  const analysis = analyzeWorkflow(graph, info);
  return { format: parsed.format, ...analysis };
}

async function comfyCustomGraph(base, provider, { kind, input, model, width, height, seed, raw, signal }) {
  const parsed = parseWorkflow(raw);
  let graph = parsed.graph;
  if (parsed.format === 'ui') {
    const info = await comfyObjectInfo(base, provider, signal);
    const converted = uiToApi(parsed.ui, info);
    if (converted.missing.length) {
      throw new Error('工作流里的节点没有安装：' + converted.missing.join('、')
        + '。请在 ComfyUI 里装好它们，或改贴 API 格式的工作流。');
    }
    graph = converted.graph;
  }

  const entry = provider && provider.modelOptions ? provider.modelOptions[model] : null;
  const mapping = entry && entry.mapping ? entry.mapping : null;
  const hasPlaceholder = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(raw);
  const values = {
    prompt: input.prompt || '',
    negative_prompt: input.negativePrompt || '',
    negativePrompt: input.negativePrompt || '',
    width, height, seed, model
  };

  if (kind === 'edit') {
    const hasImageSlot = /\{\{\s*image\s*\}\}/.test(raw);
    if (!hasImageSlot && !(mapping && mapping.image)) {
      throw new Error('这个自定义工作流里既没有 {{image}} 占位符，也没有可用的参考图映射，不能用于图生图；'
        + '请把参考图节点的 image 字段写成 {{image}}，或在模型选项里解析并确认映射。');
    }
    const reference = input.images && input.images[0];
    if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
    values.image = await comfyUploadImage(base, provider, reference, signal);
  }

  let out;
  if (hasPlaceholder) out = applyWorkflowTemplate(graph, values);
  else if (mapping) out = injectByMapping(graph, mapping, values).graph;
  else throw new Error('这个自定义工作流没有注入映射，请先在模型选项里解析并确认。');

  // 对话模型塞进来的可调参数：认得的写进去，认不得的记下来告诉它。
  const declared = entry && Array.isArray(entry.params) ? entry.params : [];
  const overrides = input && input.params && typeof input.params === 'object' ? input.params : null;
  if (overrides) {
    if (!declared.length) {
      return { graph: out, note: '当前模型没有暴露任何工作流参数，已忽略：' + Object.keys(overrides).join('、') };
    }
    const tuned = applyWorkflowParams(out, declared, overrides);
    const note = tuned.ignored.length
      ? '这些参数当前模型不支持或取值无效，已忽略：' + tuned.ignored.join('、')
      : '';
    return { graph: tuned.graph, note };
  }
  return { graph: out, note: '' };
}

/** A1111 的采样参数：默认全部不暴露，用户在模型选项里逐项打开。 */
export const A1111_PARAMS = [
  { name: 'steps', type: 'INT' },
  { name: 'cfg_scale', type: 'FLOAT' },
  { name: 'sampler_name', type: 'STRING' },
  { name: 'scheduler', type: 'STRING' },
  { name: 'seed', type: 'INT' },
  { name: 'denoising_strength', type: 'FLOAT' }
];

/** 只有图生图才认的参数。 */
const A1111_EDIT_ONLY = new Set(['denoising_strength']);

function coerceA1111Param(type, raw) {
  if (type === 'STRING') {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    return text ? text : undefined;
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return undefined;
  if (type === 'INT') return Number.isInteger(value) ? value : Math.round(value);
  return value;
}

const ADAPTERS = [
  {
    id: 'dall-e-3',
    label: 'OpenAI DALL·E 3',
    match: (provider, model) => /dall-?e-?3/i.test(model) && !MAJOR_HOSTS.test(hostOfBase(baseUrlOf(provider))),
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'response_format', 'n'],
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: {
      label: '质量', default: 'standard', fallback: 'standard',
      allowed: ['standard', 'hd'],
      options: [
        { value: 'off', label: 'Off' },
        { value: 'standard', label: 'Standard' },
        { value: 'hd', label: 'HD' }
      ]
    },
    responseFormat: 'b64_json',
    maxN: 1,
    editFields: ['image[]', 'image']
  },
  {
    id: 'gpt-image',
    label: 'OpenAI GPT-Image',
    match: (provider, model) => /gpt-?image/i.test(model) && !MAJOR_HOSTS.test(hostOfBase(baseUrlOf(provider))),
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'n'],
    // gpt-image 2.x 起支持任意 W×H：16 的倍数、比例 1:3–3:1、像素 655360–8294400。
    size: { style: 'string', field: 'size', multiple: 16, minPixels: 655360, maxPixels: 8294400, default: '1024x1024', onUnsupported: 'nearest' },
    quality: {
      label: '质量', default: 'high', fallback: 'high',
      allowed: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
      options: (model) => {
        const maxed = /2\.5-(sunburst|flare)/i.test(String(model || ''));
        return [
          { value: 'off', label: 'Off' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ].concat(maxed ? [{ value: 'xhigh', label: 'XHigh' }, { value: 'max', label: 'Max' }] : [])
          .concat([{ value: 'auto', label: 'Auto' }]);
      }
    },
    maxN: 10,
    editFields: ['image[]', 'image']
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini / Nano Banana',
    match: (provider) => /generativelanguage\.googleapis\.com/i.test(String((provider && provider.baseUrl) || '')),
    local: false,
    endpoints: { generate: '/models', edit: '/models' },
    transport: { generate: 'json', edit: 'json' },
    size: {
      control: 'aspect', style: 'aspect', field: 'aspect_ratio', default: '1024x1024', onUnsupported: 'nearest',
      aspects: ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
    },
    // imageSize 大小写敏感（必须大写 K），且 512 只有 3.1-flash-image 认。
    sizeByModel: [
      {
        match: /3\.1-flash-image/i,
        size: {
          tiers: [
            { value: '512', pixels: 262144 }, { value: '1K', pixels: 1048576 },
            { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
          ]
        }
      },
      {
        match: /nano-banana|3-pro-image/i,
        size: {
          tiers: [
            { value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
          ]
        }
      },
      { match: /2\.5-flash-image/i, size: { wire: [], hint: 'noSizeField' } }
    ],
    maxN: 1,
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models?pageSize=1000', {
        headers: keyedHeaders(provider, 'x-goog-api-key', false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload.models || [])
        .filter((item) => {
          const methods = item.supportedGenerationMethods;
          if (Array.isArray(methods) && !methods.includes('generateContent')) return false;
          return /gemini/i.test(String(item.name || ''))
            && (/image/i.test(String(item.name || '')) || /nano-banana/i.test(String(item.name || '')))
            && !/imagen/i.test(String(item.name || ''));
        })
        .map((item) => {
          const id = String(item.name || '').replace(/^models\//, '');
          const display = String(item.displayName || '').trim();
          return { id: id, name: display && display !== id ? display : '' };
        })
        .filter((entry) => entry.id)
        .slice(0, 100);
    },
    async execute(kind, provider, input, signal) {
      const model = String(input.model || '').replace(/^models\//, '').trim();
      if (!model) throw new Error('Gemini 模型 ID 不能为空');
      const images = input.images || [];
      const is25 = /gemini-2\.5-flash-image/i.test(model);
      const isFlash31 = /gemini-3\.1-flash-image/i.test(model);
      const isLite = /gemini-3\.1-flash-lite-image/i.test(model);
      const referenceLimit = is25 ? 3 : 14;
      if (images.length > referenceLimit) {
        throw new Error('Gemini 一次最多 ' + referenceLimit + ' 张参考图（该模型上限）');
      }
      const parts = [];
      for (const image of images) {
        if (!image || !image.buffer) continue;
        parts.push({
          inlineData: {
            mimeType: image.contentType || 'image/png',
            data: image.buffer.toString('base64')
          }
        });
      }
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      parts.push({ text: prompt });
      // 自动尺寸：不下发 imageConfig，让模型自己决定比例与档位。
      const explicit = !!(input.fitted && !input.fitted.omit);
      const width = explicit ? input.fitted.width : 0;
      const height = explicit ? input.fitted.height : 0;
      const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      if (explicit) {
        const aspect = input.fitted.aspect || nearestAspect(width, height, is25 ? ASPECT_CHOICES : ASPECT_CHOICES_14);
        const imageConfig = { aspectRatio: aspect };
        // 档位与大小写由策略给出（512 只有 3.1-flash 认，必须大写 K）。
        if (input.fitted.tier) imageConfig.imageSize = String(input.fitted.tier);
        generationConfig.imageConfig = imageConfig;
      }
      const response = await request(baseUrlOf(provider) + '/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: keyedHeaders(provider, 'x-goog-api-key', false),
        body: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: generationConfig }),
        signal: signal
      });
      const payload = await readJsonResponse(response, 48 * 1024 * 1024);
      const partsOut = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts;
      // thinking 模型会先返回 thought 中间草图，结果取最后一张非 thought 图。
      const ordered = Array.isArray(partsOut) ? partsOut.slice().reverse() : [];
      for (const part of ordered) {
        if (!part || part.thought === true) continue;
        const inline = part.inlineData || part.inline_data;
        if (!inline || !inline.data) continue;
        const decoded = base64ToImage(inline.data);
        if (!decoded) continue;
        return { bytes: decoded.bytes, contentType: inline.mimeType || inline.mime_type || decoded.contentType };
      }
      const finish = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].finishReason;
      throw new Error('Gemini 没有返回图片' + (finish ? '（finishReason=' + finish + '）' : ''));
    }
  },
  {
    id: 'xai-imagine',
    label: 'xAI Grok Imagine',
    match: (provider) => /(^|\.)api\.x\.ai$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]) || /xai-imagine/i.test(String((provider && provider.adapter) || '')),
    local: false,
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    size: {
      control: 'aspect', style: 'aspect', field: 'aspect_ratio', default: '1024x1024', onUnsupported: 'nearest',
      aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'],
      // xAI 的 resolution 是小写，而且只有两档；没有 4k。
      tiers: [{ value: '1k', pixels: 1048576 }, { value: '2k', pixels: 4194304 }]
    },
    maxN: 1,
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', { headers: headersFor(provider, false), signal });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload.data || [])
        .map((item) => String(item && item.id || ''))
        .filter((name) => /imagine/i.test(name))
        .slice(0, 100);
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('xAI Grok Imagine 原生编辑暂未支持；请改用支持编辑的模型或网关。');
      const width = input.fitted && !input.fitted.omit ? input.fitted.width : 1024;
      const height = input.fitted && !input.fitted.omit ? input.fitted.height : 1024;
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      const body = {
        model: input.model, prompt: prompt, n: 1,
        response_format: 'url'
      };
      // 自动尺寸：不下发比例与档位，让 Grok 自己决定。
      if (input.fitted && !input.fitted.omit) {
        body.aspect_ratio = input.fitted.aspect || nearestAspect(width, height);
        if (input.fitted.tier) body.resolution = String(input.fitted.tier);
      }
      const response = await request(baseUrlOf(provider) + '/images/generations', {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      });
      const payload = await readJsonResponse(response, 10 * 1024 * 1024);
      const decoded = decodeImagePayload(payload, null);
      if (decoded.bytes) return decoded;
      if (decoded.url) return fetchImageUrl(decoded.url, signal);
      throw new Error('xAI Grok Imagine 没有返回图片');
    }
  },
  {
    id: 'recraft',
    label: 'Recraft',
    match: (provider) => /external\.api\.recraft\.ai/i.test(String((provider && provider.baseUrl) || '')),
    local: false,
    endpoints: { generate: '/images/generations', edit: '/images/imageToImage' },
    transport: { generate: 'json', edit: 'multipart' },
    editFields: ['image'],
    editExtras: { strength: 0.5 },
    // size 只认「该模型表内的 WxH」或任意比例；三族像素表完全不同，表外值直接 400。
    size: {
      control: 'preset', style: 'string', field: 'size', allowCustom: false, onUnsupported: 'nearest',
      allowed: [
        '1024x1024', '1536x768', '768x1536', '1280x832', '832x1280', '1216x896', '896x1216',
        '1152x896', '896x1152', '832x1344', '1280x896', '896x1280', '1344x768', '768x1344'
      ]
    },
    sizeByModel: [
      {
        match: /_pro$/i,
        size: {
          control: 'preset', style: 'string', field: 'size', allowCustom: false,
          allowed: [
            '2048x2048', '3072x1536', '1536x3072', '2560x1664', '1664x2560', '2432x1792', '1792x2432',
            '2304x1792', '1792x2304', '1664x2688', '2560x1792', '1792x2560', '2688x1536', '1536x2688'
          ]
        }
      },
      {
        match: /recraftv[23]|v[23]_/i,
        size: {
          control: 'preset', style: 'string', field: 'size', allowCustom: false,
          allowed: [
            '1024x1024', '2048x1024', '1024x2048', '1536x1024', '1024x1536', '1365x1024', '1024x1365',
            '1280x1024', '1024x1280', '1024x1707', '1434x1024', '1024x1434', '1820x1024', '1024x1820'
          ]
        }
      },
      {
        match: /_vector/i,
        size: {
          control: 'aspect', style: 'string', field: 'size',
          aspects: ['1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16'],
          allowCustom: false
        }
      }
    ],
    maxN: 1,
    async listModels() {
      return ['recraftv4_1', 'recraftv4', 'recraftv3', 'recraftv2'];
    },
    async execute(kind, provider, input, signal) {
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      let response;
      if (kind === 'edit') {
        const form = new FormData();
        form.append('prompt', prompt);
        form.append('strength', '0.5');
        for (const image of input.images || []) {
          form.append('image', new Blob([image.buffer], { type: image.contentType }), image.filename);
        }
        response = await request(baseUrlOf(provider) + '/images/imageToImage', {
          method: 'POST', headers: headersFor(provider, true, null, this), body: form, signal: signal
        });
      } else {
        const body = {
          model: input.model, prompt: prompt, n: 1, response_format: 'url'
        };
        if (input.fitted && !input.fitted.omit && input.fitted.size) body.size = input.fitted.size;
        response = await request(baseUrlOf(provider) + '/images/generations', {
          method: 'POST', headers: headersFor(provider, false, null, this), body: JSON.stringify(body), signal: signal
        });
      }
      const payload = await readJsonResponse(response, 32 * 1024 * 1024);
      const decoded = decodeImagePayload(payload, null);
      if (decoded.bytes) return decoded;
      if (decoded.url) return fetchImageUrl(decoded.url, signal);
      throw new Error('Recraft 没有返回图片');
    }
  },
  {
    id: 'ideogram',
    label: 'Ideogram',
    match: (provider) => /(^|\.)api\.ideogram\.ai$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]),
    local: false,
    endpoints: { generate: (input) => ideogramPath(input), edit: '' },
    transport: { generate: 'multipart', edit: 'json' },
    // 三个模型三种协议：3 收比例（字母 x），4 只收 resolution 像素枚举，4-5 只收 size 宽高。
    size: {
      control: 'aspect', style: 'aspect', field: 'aspect_ratio', default: '1024x1024', onUnsupported: 'nearest',
      aspects: ['auto', '1x3', '3x1', '1x2', '2x1', '9x16', '16x9', '10x16', '16x10', '2x3', '3x2', '3x4', '4x3', '4x5', '5x4', '1x1']
    },
    sizeByModel: [
      {
        // 透明背景模型：比例 + 小写档位（v2 spec 是 1k/2k/4k/8k；v1 spec 写成大写，
        // 两边官方自相矛盾，这里按 v2 端点的小写来发）。
        match: /ideogram-4-transparent/i,
        size: {
          control: 'aspect', style: 'aspect', field: 'aspect_ratio',
          aspects: ['auto', '1x4', '1x3', '1x2', '9x16', '10x16', '2x3', '3x4', '4x5', '1x1', '5x4', '4x3', '3x2', '16x10', '16x9', '2x1', '3x1', '4x1'],
          tiers: [
            { value: '1k', pixels: 1048576 }, { value: '2k', pixels: 4194304 },
            { value: '4k', pixels: 16777216 }, { value: '8k', pixels: 67108864 }
          ]
        }
      },
      {
        match: /ideogram-4-5/i,
        size: {
          control: 'wh', style: 'string', field: 'size', allowCustom: true,
          multiple: 32, minSide: 256, maxPixels: 4194304
        }
      },
      {
        match: /ideogram-4/i,
        size: {
          control: 'preset', style: 'string', field: 'resolution', allowCustom: false,
          allowed: [
            '2048x2048', '1440x2880', '2880x1440', '1664x2496', '2496x1664', '1792x2240', '2240x1792',
            '1440x2560', '2560x1440', '1600x2560', '2560x1600', '1728x2304', '2304x1728', '1296x3168',
            '3168x1296', '1152x2944', '2944x1152', '1248x3328', '3328x1248', '1280x3072', '3072x1280',
            '1024x3072', '3072x1024', '1024x1024', '896x1120', '1120x896', '864x1152', '1152x864',
            '832x1248', '1248x832', '800x1280', '1280x800', '720x1280', '1280x720', '720x1440', '1440x720',
            '512x1536', '1536x512'
          ]
        }
      }
    ],
    quality: {
      label: '质量', default: 'default', fallback: 'default',
      allowed: ['turbo', 'default', 'quality'],
      map: { turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' },
      options: [
        { value: 'off', label: 'Off' },
        { value: 'turbo', label: 'Turbo' },
        { value: 'default', label: 'Default' },
        { value: 'quality', label: 'Quality' }
      ]
    },
    maxN: 1,
    async listModels() {
      return ['ideogram-3', 'ideogram-4', 'ideogram-4-5', 'ideogram-4-transparent'];
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('Ideogram 原生编辑暂未支持；请使用生成或换支持编辑的模型。');
      const model = String(input.model || 'ideogram-3');
      const fitted = input.fitted && !input.fitted.omit ? input.fitted : null;
      const prompt = String(input.prompt || '');
      const speed = input.quality && input.quality !== 'off'
        ? ({ turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' })[String(input.quality).toLowerCase()]
        : '';
      let response;
      const isTransparent = /ideogram-4-transparent/i.test(model);
      const is45 = /ideogram-4-5/i.test(model);
      const is4 = !isTransparent && !is45 && /ideogram-4/i.test(model);
      if (is4) {
        // ideogram-4 是 JSON，而且只有 resolution（像素枚举），没有 aspect_ratio。
        const body = { prompt: prompt, num_images: 1 };
        if (fitted && fitted.size) body.resolution = String(fitted.size);
        if (speed) body.rendering_speed = speed;
        response = await request(baseUrlOf(provider) + ideogramPath(input), {
          method: 'POST',
          headers: keyedHeaders(provider, 'Api-Key', false),
          body: JSON.stringify(body),
          signal: signal
        });
      } else {
        const form = new FormData();
        form.append('prompt', prompt);
        if (input.negativePrompt) form.append('negative_prompt', String(input.negativePrompt));
        if (speed) form.append('rendering_speed', speed);
        if (fitted) {
          if (is45) {
            // ideogram-4-5 只收 size：auto / source / WxH（32 的倍数）。
            form.append('size', String(fitted.size));
          } else {
            // ideogram-3 与 transparent 的比例是字母 x（16x9），不是冒号。
            const aspect = fitted.aspect || nearestAspect(fitted.width, fitted.height);
            form.append('aspect_ratio', String(aspect).replace(':', 'x'));
            if (isTransparent && fitted.tier) form.append('output_resolution', String(fitted.tier));
          }
        }
        form.append('num_images', '1');
        response = await request(baseUrlOf(provider) + ideogramPath(input), {
          method: 'POST',
          headers: keyedHeaders(provider, 'Api-Key', true),
          body: form,
          signal: signal
        });
      }
      const payload = await readJsonResponse(response, 32 * 1024 * 1024);
      const decoded = decodeImagePayload(payload, null);
      if (decoded.bytes) return decoded;
      if (decoded.url) return fetchImageUrl(decoded.url, signal);
      throw new Error('Ideogram 没有返回图片');
    }
  },
  {
    id: 'together',
    label: 'Together AI',
    match: (provider) => /(^|\.)api\.together\.xyz$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]),
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'width', 'height', 'n', 'response_format'],
    size: { style: 'width-height', default: '1024x1024', onUnsupported: 'nearest' },
    responseFormat: 'url',
    maxN: 1
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    match: (provider, model) => /siliconflow/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/images/generations', edit: '/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'negative_prompt', 'image_size', 'num_inference_steps', 'guidance_scale', 'seed'],
    // image_size 对 Kolors / Qwen-Image 必填；Qwen-Image-Edit 系列官方明确不收这个字段。
    size: {
      control: 'preset', custom: true, style: 'string', field: 'image_size', allowCustom: true,
      allowed: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280']
    },
    sizeByModel: [
      { match: /qwen-image-edit/i, size: { control: 'wh', wire: [], hint: 'noSizeField' } },
      {
        match: /qwen-image/i,
        size: {
          control: 'preset', custom: true, allowCustom: true,
          allowed: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584']
        }
      }
    ],
    maxN: 1,
    editFields: ['image'],
    // Qwen-Image-Edit 系列不接受 image_size，传了会 400。
    editDrops: (input) => (/qwen-image-edit/i.test(String((input && input.model) || '')) ? ['image_size'] : [])
  },
  {
    id: 'volcengine-ark',
    label: '火山方舟',
    match: (provider, model) => /volces\.com/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/images/generations', edit: '/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'size', 'response_format', 'watermark', 'n', 'image'],
    size: {
      control: 'preset', custom: true, tierLabels: true,
      style: 'string', field: 'size', default: '1024x1024', onUnsupported: 'nearest',
      tiers: [{ value: '2K', pixels: 2048 * 2048 }, { value: '3K', pixels: 3072 * 3072 }, { value: '4K', pixels: 4096 * 4096 }]
    },
    // 档位集合按模型分叉：5.x 是 1K/1.5K/2K（没有 4K），lite 是 2K/3K/4K，4.5 只有 2K/4K。
    // 顺序有意义：更具体的（lite）必须排在更宽的（5.x）前面。
    sizeByModel: [
      {
        match: /seedream-?5\.0-lite/i,
        size: {
          tiers: [{ value: '2K', pixels: 4194304 }, { value: '3K', pixels: 9437184 }, { value: '4K', pixels: 16777216 }],
          minPixels: 3686400, maxPixels: 16777216
        }
      },
      {
        match: /seedream-?5\.[05]/i,
        size: {
          tiers: [{ value: '1K', pixels: 1048576 }, { value: '1.5K', pixels: 2359296 }, { value: '2K', pixels: 4194304 }],
          minPixels: 921600, maxPixels: 4624220
        }
      },
      {
        match: /seedream-?4\.5/i,
        size: {
          tiers: [{ value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }],
          minPixels: 3686400, maxPixels: 16777216
        }
      },
      {
        match: /seedream-?4\.0/i,
        size: {
          tiers: [{ value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }],
          minPixels: 921600, maxPixels: 16777216
        }
      }
    ],
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
    send: ['prompt', 'negative_prompt', 'aspect_ratio', 'output_format', 'model'],
    size: {
      control: 'aspect', style: 'aspect', field: 'aspect_ratio', default: '1024x1024', onUnsupported: 'nearest',
      aspects: ['21:9', '16:9', '3:2', '5:4', '1:1', '4:5', '2:3', '9:16', '9:21'],
      // 三个端点都没有像素参数：core 固定 1.5MP，sd3/ultra 固定 1MP。
      hint: 'fixedPixels'
    },
    quality: null,
    binary: true,
    maxN: 1,
    editFields: ['image']
  },
  ...CN_ADAPTERS,
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
      control: 'preset', custom: true, tierLabels: true, style: 'string', field: 'size', separator: '*',
      // wan2.6 的总像素区间是 [1280², 1440²]；官方推荐的 1104×1472 反而比它自己写的下限小，
      // 所以只按推荐表走，不按 1638400 硬拒。
      allowed: ['1280x1280', '1696x960', '960x1696', '1472x1104', '1104x1472'],
      allowCustom: true, default: '1280x1280', hint: 'modelDecides'
    },
    // 万相里只有 wan2.7 认档位缩写；image-pro 的上限是 4096²，普通版是 2048²。
    sizeByModel: [
      {
        match: /wan2\.7.*pro/i,
        size: {
          control: 'preset', custom: true, allowCustom: true,
          tiers: [
            { value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
          ],
          minPixels: 589824, maxPixels: 16777216
        }
      },
      {
        match: /wan2\.7/i,
        size: {
          control: 'preset', custom: true, allowCustom: true,
          tiers: [
            { value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
          ],
          minPixels: 589824, maxPixels: 4194304
        }
      }
    ],
    quality: null,
    maxN: 4,
    editFields: []
  },
  {
    id: 'a1111',
    label: 'AUTOMATIC1111 / Forge / SD.Next / Draw Things',
    match: (provider) => /a1111|forge|sdnext|sd-next|drawthings/i.test(String((provider && provider.adapter) || '')),
    local: true,    endpoints: { generate: '/sdapi/v1/txt2img', edit: '/sdapi/v1/img2img' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/sdapi/v1/sd-models', {
        headers: headersFor(provider, false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      if (!Array.isArray(payload)) return [];
      return payload
        .map((item) => String((item && (item.title || item.model_name || item.name)) || '').trim())
        .filter(Boolean);
    },
    async execute(kind, provider, input, signal) {
      // 自动尺寸：请求里不带宽高，让 WebUI 用它自己的默认值。
      const size = input.fitted && !input.fitted.omit
        ? { width: input.fitted.width, height: input.fitted.height }
        : {};
      const body = {
        prompt: input.prompt,
        negative_prompt: input.negativePrompt || '',
        batch_size: 1,
        n_iter: 1,
        ...size
      };
      if (input.model) body.override_settings = { sd_model_checkpoint: input.model };
      let endpoint = '/sdapi/v1/txt2img';
      if (kind === 'edit') {
        const image = input.images && input.images[0];
        if (!image) throw new Error('A1111 编辑需要参考图');
        const dimensions = imageDimensions(image.buffer) || size;
        body.init_images = [image.buffer.toString('base64')];
        body.denoising_strength = 0.6;
        body.width = dimensions.width;
        body.height = dimensions.height;
        endpoint = '/sdapi/v1/img2img';
      }
      // 对话模型显式传入的采样参数：认得的覆盖，认不得的回报。
      const overrides = input.params && typeof input.params === 'object' ? input.params : null;
      let note = '';
      if (overrides) {
        const known = new Map(A1111_PARAMS.map((param) => [param.name, param]));
        const ignored = [];
        for (const [name, raw] of Object.entries(overrides)) {
          const param = known.get(name);
          if (!param || (kind !== 'edit' && A1111_EDIT_ONLY.has(name))) { ignored.push(name); continue; }
          const value = coerceA1111Param(param.type, raw);
          if (value === undefined) { ignored.push(name); continue; }
          body[name] = value;
        }
        if (ignored.length) note = '这些参数当前模型不支持或取值无效，已忽略：' + ignored.join('、');
      }
      const response = await request(baseUrlOf(provider) + endpoint, {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      });
      const payload = await readJsonResponse(response, 50 * 1024 * 1024);
      const first = payload && Array.isArray(payload.images) ? payload.images[0] : null;
      const decoded = base64ToImage(first);
      if (!decoded) throw new Error('A1111 没有返回图片');
      return note ? Object.assign({}, decoded, { note }) : decoded;
    }
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    match: (provider) => /comfyui/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/prompt', edit: '/prompt' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', multiple: 8, default: '1024x1024', onUnsupported: 'nearest' },
    async listModels(provider, signal) {
      const base = baseUrlOf(provider);
      const checkpoints = await comfyNodeOptions(base, provider, 'CheckpointLoaderSimple', 'ckpt_name', signal);
      const diffusion = await comfyNodeOptions(base, provider, 'UNETLoader', 'unet_name', signal);
      return Array.from(new Set(checkpoints.concat(diffusion)));
    },
    async execute(kind, provider, input, signal) {
      const base = baseUrlOf(provider);
      // 尺寸=自动且模型没指定宽高时不注入，把分辨率留给工作流自己的节点。
      const explicit = !!(input.fitted && !input.fitted.omit);
      const width = explicit ? input.fitted.width : undefined;
      const height = explicit ? input.fitted.height : undefined;
      // 内置模板由插件拼装，必须有具体数字，自动尺寸下退回 1024。
      const builtinWidth = explicit ? width : 1024;
      const builtinHeight = explicit ? height : 1024;
      const seed = Math.floor(Math.random() * 2147483647);
      const model = input.model;

      const custom = comfyCustomWorkflow(provider, model);
      if (custom) {
        const built = await comfyCustomGraph(base, provider, {
          kind, input, model, width, height, seed, raw: custom, signal
        });
        const result = await comfySubmitAndWait(base, provider, built.graph, signal);
        return built.note ? Object.assign({}, result, { note: built.note }) : result;
      }
      const diffusionModels = await comfyNodeOptions(base, provider, 'UNETLoader', 'unet_name', signal);
      let workflow;
      if (diffusionModels.includes(model) && /moss/i.test(model)) {
        workflow = kind === 'edit'
          ? await comfyMossEditWorkflow(base, provider, { input, model, seed, signal })
          : await comfyMossWorkflow(base, provider, { input, model, width: builtinWidth, height: builtinHeight, seed, signal });
      } else if (diffusionModels.includes(model)) {
        workflow = await comfyFluxWorkflow(base, provider, { kind, input, model, width: builtinWidth, height: builtinHeight, seed, signal });
      } else {
        let imageName = null;
        if (kind === 'edit') {
          const reference = input.images && input.images[0];
          if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
          imageName = await comfyUploadImage(base, provider, reference, signal);
        }
        workflow = comfyCheckpointWorkflow({ kind, input, model, width: builtinWidth, height: builtinHeight, seed, imageName });
      }
      return comfySubmitAndWait(base, provider, workflow, signal);
    }
  },
  {
    id: 'swarmui',
    label: 'SwarmUI',
    match: (provider) => /swarmui/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/API/GenerateText2Image', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', multiple: 8, default: '1024x1024', onUnsupported: 'nearest' },
    async newSession(provider, signal) {
      const payload = await readJsonResponse(await request(baseUrlOf(provider) + '/API/GetNewSession', {
        method: 'POST', headers: headersFor(provider, false), body: '{}', signal
      }), 2 * 1024 * 1024);
      const session = payload && payload.session_id;
      if (!session) throw localizedError(new Error('SwarmUI 没有返回 session_id'), 'upstream.invalidResponse', { service: 'SwarmUI', field: 'session_id' });
      return session;
    },
    async listModels(provider, signal) {
      const session = await this.newSession(provider, signal);
      const payload = await readJsonResponse(await request(baseUrlOf(provider) + '/API/ListModels', {
        method: 'POST', headers: headersFor(provider, false),
        body: JSON.stringify({ session_id: session, path: '', depth: 2, subtype: 'Stable-Diffusion' }), signal
      }), 5 * 1024 * 1024);
      const files = payload && Array.isArray(payload.files) ? payload.files : [];
      return files.map((item) => String((item && (item.name || item.id)) || '').trim()).filter(Boolean);
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('SwarmUI 原生编辑暂未支持；请改用支持 /images/edits 的 OpenAI 兼容网关');
      const base = baseUrlOf(provider);
      const session = await this.newSession(provider, signal);
      const body = {
        session_id: session, images: 1,
        prompt: input.prompt, negativeprompt: input.negativePrompt || '',
        model: input.model,
        cfgscale: 7, steps: 20, seed: -1
      };
      // 自动尺寸：不带宽高，让 SwarmUI 用它自己的默认值。
      if (input.fitted && !input.fitted.omit) {
        body.width = input.fitted.width;
        body.height = input.fitted.height;
      }
      const generated = await readJsonResponse(await request(base + '/API/GenerateText2Image', {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      }), 5 * 1024 * 1024);
      const image = generated && Array.isArray(generated.images) ? generated.images[0] : null;
      if (!image) throw new Error('SwarmUI 没有返回图片');
      if (String(image).startsWith('data:')) {
        const decoded = base64ToImage(image);
        if (!decoded) throw new Error('SwarmUI 返回的图片无法解码');
        return decoded;
      }
      if (/^https?:\/\//i.test(String(image))) return fetchImageUrl(String(image), signal);
      return fetchImageUrl(base + '/' + String(image).replace(/^\/+/, ''), signal);
    }
  },
  {
    id: 'localai',
    label: 'LocalAI',
    match: (provider) => /localai/i.test(String((provider && provider.adapter) || '')),
    local: true,
    // LocalAI 没有 /v1/images/edits：图生图要换成 generations + file/ref_images，
    // 语义和 OpenAI 不同，所以这里明确声明不支持编辑，让 UI 直接告诉用户换网关。
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'negative_prompt', 'size', 'quality', 'n'],
    size: { style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    quality: null,
    maxN: 4,
    editFields: [],
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', {
        headers: headersFor(provider, false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return openAiCompatibleEntries(payload);
    }
  },
  ...ASYNC_ADAPTERS,
  ...OPENAI_ADAPTERS,
  {
    id: 'openai-images',
    label: 'OpenAI Images 兼容（自动同步/异步）',
    match: () => true,
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    // 提交响应带任务 id / 轮询地址时自动跟着轮询；直接返回图片就照同步处理。
    autoAsync: true,
    send: ['model', 'prompt', 'negative_prompt', 'size', 'quality', 'n'],
    // 通用兼容族：尺寸原样透传；尺寸被拒会直接报错并给出该模型的合法范围。
    size: { control: 'wh', style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    // 中转站常把比例型模型（nano-banana / gemini image）包成 OpenAI Images：
    // 域名不认识、adapter 留空，但模型本身按比例+档位出图，面板要跟着变。
    sizeByModel: [
      {
        match: /gemini-3\.1-flash-image/i,
        size: {
          control: 'aspect', style: 'string', field: 'size',
          aspects: ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
          tiers: [
            { value: '512', pixels: 262144 }, { value: '1K', pixels: 1048576 },
            { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
          ]
        }
      },
      {
        match: /nano-banana|gemini-3-pro-image/i,
        size: {
          control: 'aspect', style: 'string', field: 'size',
          aspects: ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
          tiers: [
            { value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
          ]
        }
      }
    ],
    quality: null,
    maxN: 4,
    editFields: ['image[]', 'image'],
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', {
        headers: headersFor(provider, false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return openAiCompatibleEntries(payload);
    }
  }
];

export async function listProviderModels(adapter, provider, signal) {
  if (!adapter || typeof adapter.listModels !== 'function') {
    throw localizedError(new Error('该部署器不支持获取模型列表'), 'models.unsupported');
  }
  return adapter.listModels(provider, signal);
}

/** OpenAI 兼容的 `/models` 条目：id 是请求要用的标识，display_name / name 才是人类可读名。*/
function openAiCompatibleEntries(payload) {
  const data = payload && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const entries = [];
  for (const item of data) {
    // 没有 id 的网关常把模型名写在 name 里，这时 name 就是 id。
    const id = String((item && (item.id || item.name)) || '').trim();
    if (!id) continue;
    const display = String((item && (item.display_name || item.displayName || item.name)) || '').trim();
    entries.push({ id: id, name: display && display !== id ? display : '' });
  }
  return entries;
}

/**
 * 模型列表连同显示名一起取回。适配器只给 id 时显示名留空，由客户端退回 id；
 * 这样设置页「获取可用模型」之后能直接把名称填进模型行。
 */
export async function listProviderModelEntries(adapter, provider, signal) {
  if (adapter && typeof adapter.listModelEntries === 'function') {
    const entries = await adapter.listModelEntries(provider, signal);
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => ({ id: String((entry && entry.id) || '').trim(), name: String((entry && entry.name) || '').trim() }))
      .filter((entry) => entry.id);
  }
  const ids = await listProviderModels(adapter, provider, signal);
  return (Array.isArray(ids) ? ids : [])
    .map((id) => ({ id: String(id || '').trim(), name: '' }))
    .filter((entry) => entry.id);
}

export function listAdapters() {
  return ADAPTERS.map((item) => ({ id: item.id, label: item.label }));
}

/**
 * 该适配器是否支持某种操作（generate / edit）。
 * endpoints.edit 为空串表示原生不支持编辑——调用方据此直接报「不支持」，
 * 而不是偷偷换一个模型。
 */
export function adapterSupportsKind(adapter, kind) {
  if (!adapter || !adapter.endpoints) return false;
  return kind === 'edit' ? Boolean(adapter.endpoints.edit) : Boolean(adapter.endpoints.generate);
}

/** 本地部署入口的唯一数据源：客户端不再维护一份重复的 preset 表。 */
export function providerPresetManifest() {
  return PROVIDER_PRESETS.map((preset) => Object.assign({}, preset, { models: (preset.models || []).slice() }));
}

/** 云端内置提供商；和本地 preset 一样由宿主下发，客户端不再维护第二份。 */
export const PROVIDER_PRESETS = [
  {
    id: 'gemini', name: 'Google Gemini / Nano Banana',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini',
    website: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']
  },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '', website: 'https://platform.openai.com/api-keys', models: [] },
  {
    id: 'xai', name: 'xAI Grok Imagine',
    baseUrl: 'https://api.x.ai/v1', adapter: 'xai-imagine',
    website: 'https://console.x.ai/',
    models: ['grok-imagine-image']
  },
  {
    id: 'recraft', name: 'Recraft',
    baseUrl: 'https://external.api.recraft.ai/v1', adapter: 'recraft',
    website: 'https://www.recraft.ai/profile/api',
    models: ['recraftv4_1', 'recraftv4', 'recraftv3', 'recraftv2']
  },
  {
    id: 'ideogram', name: 'Ideogram',
    baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram',
    website: 'https://developer.ideogram.ai/',
    models: ['ideogram-3', 'ideogram-4']
  },
  {
    id: 'stability', name: 'Stability AI',
    baseUrl: 'https://api.stability.ai', adapter: 'stability',
    website: 'https://platform.stability.ai/account/keys',
    models: ['core']
  },
  {
    id: 'together', name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1', adapter: 'together',
    website: 'https://api.together.ai/settings/api-keys',
    models: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev']
  },
  {
    id: 'fireworks', name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1', adapter: 'openai-images',
    website: 'https://fireworks.ai/account/api-keys',
    models: ['accounts/fireworks/models/flux-1-schnell']
  },
  {
    id: 'novita', name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai', adapter: 'openai-images',
    website: 'https://novita.ai/settings/key-management',
    models: ['flux-1-schnell']
  },
  {
    id: 'openrouter', name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images',
    website: 'https://openrouter.ai/settings/keys',
    models: ['google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-flare', 'black-forest-labs/flux-2-pro']
  },
  {
    id: 'azure', name: 'Azure OpenAI',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', adapter: 'azure-openai',
    website: 'https://portal.azure.com/',
    models: []
  },
  {
    id: 'bfl', name: 'Black Forest Labs (FLUX)',
    baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl',
    website: 'https://dashboard.bfl.ai/',
    models: ['flux-2-pro', 'flux-2-max', 'flux-3-image', 'flux-kontext-pro']
  },
  {
    id: 'fal', name: 'fal.ai',
    baseUrl: 'https://queue.fal.run', adapter: 'fal',
    website: 'https://fal.ai/dashboard/keys',
    models: ['fal-ai/flux-2-pro', 'fal-ai/flux-pro/kontext']
  },
  {
    id: 'replicate', name: 'Replicate',
    baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate',
    website: 'https://replicate.com/account/api-tokens',
    models: ['black-forest-labs/flux-2-pro']
  },
  { id: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: '', website: 'https://console.volcengine.com/ark', models: [] },
  {
    id: 'volcengine-plan', name: '火山方舟 Agent Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', adapter: '',
    website: 'https://console.volcengine.com/ark',
    models: []
  },
  {
    id: 'dashscope', name: '阿里云百炼 · Qwen-Image',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image',
    website: 'https://bailian.console.aliyun.com/',
    models: ['qwen-image-3.0-pro', 'qwen-image-3.0']
  },
  {
    id: 'dashscope-wanx', name: '阿里云百炼 · 通义万相',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-wanx',
    website: 'https://bailian.console.aliyun.com/',
    models: ['wan2.6-t2i', 'wan2.7-image-pro', 'wan2.7-image', 'wanx2.1-t2i-turbo']
  },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', adapter: '', website: 'https://cloud.siliconflow.cn/account/ak', models: [] },
  { id: 'bigmodel', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'zhipu', website: 'https://bigmodel.cn/usercenter/apikeys', models: [] },
  {
    id: 'modelscope', name: '魔搭 ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn', adapter: 'modelscope',
    website: 'https://www.modelscope.cn/my/myaccesstoken',
    models: ['Qwen/Qwen-Image-2.1', 'Qwen/Qwen-Image-2.1-Turbo', 'Qwen/Qwen-Image-Edit']
  }
];

export const LOCAL_PRESETS = [
  {
    id: 'sd-server', name: 'stable-diffusion.cpp (sd-server)', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。',
    hint: '原生 OpenAI Images 接口，生成和 /images/edits 编辑都支持；模型名通常是 sd-cpp-local，可从 /v1/models 获取。'
  },
  {
    id: 'localai', name: 'LocalAI', adapter: 'localai',
    baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。',
    hint: 'OpenAI Images 兼容，生成可用；模型名填 LocalAI 模型 YAML 里的 name，可从 /v1/models 获取。LocalAI 没有 /images/edits，图生图需要走「其他 OpenAI 兼容网关」接一个支持编辑的后端。'
  },
  {
    id: 'a1111', name: 'AUTOMATIC1111 / Forge / SD.Next / Draw Things', adapter: 'a1111',
    baseUrl: 'http://127.0.0.1:7860', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /sdapi/v1；插件会拼 /sdapi/v1/txt2img、/img2img、/sd-models。',
    hint: '走 /sdapi/v1/txt2img 和 /sdapi/v1/img2img，模型列表来自 /sdapi/v1/sd-models；A1111 需要启动时加 --api。'
  },
  {
    id: 'comfyui', name: 'ComfyUI', adapter: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /prompt；插件会拼 /prompt、/upload/image、/history、/view。',
    hint: '支持 SD/SDXL 单文件 checkpoint、FLUX.2 系列和 MOSS-Image（含编辑 LoRA 的图生图），模型列表来自 /object_info。FLUX.1、Qwen-Image 等其它架构仍建议走 OpenAI 兼容网关。'
  },
  {
    id: 'swarmui', name: 'SwarmUI', adapter: 'swarmui',
    baseUrl: 'http://127.0.0.1:7801', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /API；插件会拼 /API/GetNewSession、/API/ListModels、/API/GenerateText2Image。',
    hint: '走 /API/GenerateText2Image，模型列表来自 /API/ListModels；生成可用，原生编辑暂不支持。'
  },
  {
    id: 'openai-gateway', name: '其他 OpenAI 兼容网关', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:3000/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填 OpenAI API 根地址（通常带 /v1）；插件会拼 /images/generations 和 /models。',
    hint: 'InvokeAI、Fooocus、复杂 ComfyUI 工作流或自建服务，只要暴露 /v1/images/generations 就选这个。'
  }
];

export function adapterManifest() {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    local: !!adapter.local,
    supportsModels: typeof adapter.listModels === 'function'
  }));
}

export function localPresetManifest() {
  return LOCAL_PRESETS.map((preset) => ({ ...preset }));
}

export function resolveAdapter(provider, model) {
  const protocol = String((provider && provider.protocol) || '').trim().toLowerCase();
  if (protocol && protocol !== 'openai-images' && protocol !== 'auto' && protocol !== 'images') {
    const byProtocol = ADAPTERS.find((item) => item.id === protocol);
    if (!byProtocol) {
      throw localizedError(
        new Error('暂不支持该生图协议：' + protocol + '（可用：' + ADAPTERS.map((item) => item.id).join(' / ') + '）'),
        'adapter.unknownProtocol',
        { protocol: protocol, available: ADAPTERS.map((item) => item.id).join(' / ') }
      );
    }
    return byProtocol;
  }
  const explicit = String((provider && provider.adapter) || '').trim().toLowerCase();
  if (explicit) {
    const hit = ADAPTERS.find((item) => item.id === explicit);
    if (hit) return hit;
    throw localizedError(
      new Error('找不到生图适配器：' + explicit + '（可用：' + ADAPTERS.map((item) => item.id).join(' / ') + '）'),
      'adapter.notFound',
      { adapter: explicit, available: ADAPTERS.map((item) => item.id).join(' / ') }
    );
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

/** A1111 img2img 需要原图尺寸；PNG/JPEG 足够覆盖常见参考图。 */
function imageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
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
  const sizeFields = encodeSize(adapter, input.fitted, input.model);
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

/** 端点既可以是固定字符串，也可以是按模型拼路径的函数（Ideogram、fal 这类）。 */
function endpointOf(value, input) {
  return typeof value === 'function' ? value(input || {}) : value;
}

export function prepareGenerate(adapter, provider, input, drops) {
  const body = composeBody(adapter, input, drops);
  if (adapter.transport.generate === 'multipart') {
    const form = new FormData();
    for (const key of Object.keys(body)) form.append(key, String(body[key]));
    return { path: endpointOf(adapter.endpoints.generate, input), headers: headersFor(provider, true, adapter.headers, adapter), body: form };
  }
  return jsonRequest(adapter, provider, endpointOf(adapter.endpoints.generate, input), body);
}

export function prepareEdit(adapter, provider, input, drops, fieldName) {
  const body = composeBody(adapter, input, drops);
  // 有些编辑端点不收尺寸（如硅基流动 Qwen-Image-Edit），由适配器逐个模型声明。
  if (typeof adapter.editDrops === 'function') {
    for (const key of adapter.editDrops(input) || []) delete body[key];
  }
  if (adapter.transport.edit !== 'multipart') {
    // 非 multipart 的编辑接口（如 SiliconFlow / 火山方舟）用 image 字段承载
    // 参考图；统一编码成 data URL，单张发字符串，多张发数组。
    const field = fieldName || (adapter.editFields && adapter.editFields[0]) || 'image';
    const images = input.images || [];
    if (images.length > 0) {
      const encoded = images
        .filter((image) => image && image.buffer && image.contentType)
        .map((image) => 'data:' + image.contentType + ';base64,' + image.buffer.toString('base64'));
      if (encoded.length > 0) body[field] = encoded.length === 1 ? encoded[0] : encoded;
    }
    return jsonRequest(adapter, provider, endpointOf(adapter.endpoints.edit, input), body);
  }
  const form = new FormData();
  for (const key of Object.keys(body)) form.append(key, String(body[key]));
  for (const [key, value] of Object.entries(adapter.editExtras || {})) form.append(key, String(value));
  const field = fieldName || (adapter.editFields && adapter.editFields[0]) || 'image';
  for (const image of input.images || []) {
    form.append(field, new Blob([image.buffer], { type: image.contentType }), image.filename);
  }
  return { path: endpointOf(adapter.endpoints.edit, input), headers: headersFor(provider, true, adapter.headers, adapter), body: form };
}

/** 异步任务：先提交拿 task_id。 */
export function prepareAsync(adapter, provider, input, drops) {
  return jsonRequest(adapter, provider, adapter.submit, composeBody(adapter, input, drops));
}

/**
 * 这些字段是请求的语义核心：少了提示词、模型或参考图，请求就不再是「同一个请求」，
 * 上游就算收下也只会生成一张不相干的图。兼容性重试只允许摘掉可选参数。
 */
const PHASE_PROTECTED_FIELDS = [
  'prompt', 'model',
  'input.prompt', 'input.model',
  'images', 'image', 'image_url', 'image_urls', 'input_image',
  'input.image', 'input.images', 'input.image_url', 'input.input_image'
];

/** BFL 的多图字段是 input_image_2/3/4，和 input_image 同类，删掉等于丢参考图。 */
const PHASE_PROTECTED_SIBLING = /^input_image_\d+$/i;

/**
 * drop 是否踩到必要字段。
 *
 * 除了同名字段，还要挡两个方向：删父对象（`input`）会连带删掉 `input.prompt`；
 * 删子路径（`input.prompt.text`）等价于改必要字段。两者都按「不生效」处理。
 */
function isProtectedPhaseDrop(path) {
  const text = String(path || '');
  if (!text) return false;
  if (PHASE_PROTECTED_SIBLING.test(text)) return true;
  for (const protectedPath of PHASE_PROTECTED_FIELDS) {
    if (text === protectedPath) return true;
    if (text.startsWith(protectedPath + '.')) return true;
    if (protectedPath.startsWith(text + '.')) return true;
  }
  return false;
}

/**
 * 从请求体对象里删掉一条点分路径（`input.width` 这种），返回是否真的删掉了。
 * 只支持对象层级，不支持数组下标：适配器声明的兼容性字段都是具名字段。
 *
 * 路径来自上游错误文本，不能让它摸到原型链：`__proto__.toString` 这种
 * 会删到 Object.prototype 上，直接把整个进程的字符串化打坏。
 */
const UNSAFE_PHASE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function ownValue(node, key) {
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return undefined;
  return Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined;
}

function dropPhaseField(body, path) {
  const segments = String(path || '').split('.').filter(Boolean);
  if (!segments.length) return false;
  let node = body;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (UNSAFE_PHASE_SEGMENTS.has(segment)) return false;
    const next = ownValue(node, segment);
    // 数组下标不在支持范围内：删元素会留下空洞（JSON 里变成 null），
    // 上游看到的还是一个坏数组，不如原样报回去。
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    node = next;
  }
  const leaf = segments[segments.length - 1];
  if (UNSAFE_PHASE_SEGMENTS.has(leaf)) return false;
  if (!node || (typeof node !== 'object' && typeof node !== 'function')) return false;
  if (!Object.prototype.hasOwnProperty.call(node, leaf)) return false;
  // 不存在的路径不算「删掉了」：调用方要按 dropped 判断请求是否真的变了，
  // 把无效路径报成 dropped 会骗它去做一次完全相同的重试。
  // 值为 undefined 的字段本来就进不了 JSON，同样不算真的删了东西。
  if (node[leaf] === undefined) return false;
  return delete node[leaf];
}

/**
 * build 失败时保留原始错误对象：调用方要按 kind/status/cause 决定重试与降级，
 * 直接包装成新错误会把这些分类和栈丢掉，所以原错误一律挂到 cause 上。
 * message 保持不变，用户看到的文案不变。
 */
function phaseBuildError(error) {
  if (!(error instanceof Error)) {
    return localizedError(new Error('构造异步请求体失败：' + String(error)), 'upstream.invalidResponse', { phase: 'prepare' });
  }
  if (error.cause && error.cause !== error) return error;
  const wrapped = new Error(error.message, { cause: error });
  wrapped.name = error.name;
  for (const key of ['status', 'code', 'kind', 'retryable', 'detail', 'localized']) {
    if (error[key] !== undefined) wrapped[key] = error[key];
  }
  return wrapped;
}

/**
 * 新式异步描述符：提交体与提交路径都由适配器自己决定；build 可以是异步的。
 *
 * drops 是兼容性重试前累积的「上游不认识/不接受」的字段路径（Set 或数组，点分路径）。
 * 删在对象上再序列化，而不是先 stringify 再 parse：body 里常有 base64 data URL，
 * 往返一次会多复制一份整张图。build 每次都返回新对象，直接在上面删是安全的。
 */
export async function preparePhaseAsync(adapter, provider, input, signal, drops) {
  const phase = adapter.async || {};
  // 有的平台提交路径依赖 baseUrl（魔搭带不带 /v1 都要能拼对），所以把 provider 也传进去。
  const path = String(phase.submitPath(input, provider) || '');
  let built;
  try {
    built = await phase.build(input, provider, signal);
  } catch (error) {
    throw phaseBuildError(error);
  }
  const body = built && built.body ? built.body : (built || {});
  const note = built && built.note ? String(built.note) : '';
  const dropped = [];
  const blockedDrops = [];
  const wanted = drops instanceof Set ? Array.from(drops) : (Array.isArray(drops) ? drops : []);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const raw of wanted) {
      const fieldPath = String(raw === undefined || raw === null ? '' : raw).trim();
      if (!fieldPath) continue;
      if (isProtectedPhaseDrop(fieldPath)) {
        if (!blockedDrops.includes(fieldPath)) blockedDrops.push(fieldPath);
        continue;
      }
      if (dropPhaseField(body, fieldPath) && !dropped.includes(fieldPath)) dropped.push(fieldPath);
    }
  }
  return {
    path: path,
    headers: headersFor(provider, false, adapter.headers, adapter),
    body: JSON.stringify(body),
    note: note,
    dropped: dropped,
    blockedDrops: blockedDrops
  };
}

export function pollUrlFor(adapter, provider, taskId) {
  const template = String((adapter.poll && adapter.poll.path) || '/tasks/{taskId}');
  return baseUrlOf(provider) + template.replace('{taskId}', encodeURIComponent(taskId));
}

export function pollHeaders(provider) {
  return { Authorization: 'Bearer ' + String((provider && provider.key) || '') };
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

/* ----------------------------------------------------------------- resize */

/** 居中裁切一段 RGBA（cover 用）：比例不符时裁掉多余的一边，而不是拉伸。 */
function cropRgba(rgba, width, height, left, top, cropWidth, cropHeight) {
  const out = new Uint8Array(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const from = ((top + y) * width + left) * 4;
    out.set(rgba.subarray(from, from + cropWidth * 4), y * cropWidth * 4);
  }
  return out;
}

function coverCrop(image, targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight;
  const ratio = image.width / image.height;
  if (Math.abs(ratio - targetRatio) <= 0.01) return null;
  let cropWidth = image.width;
  let cropHeight = Math.round(image.width / targetRatio);
  if (cropHeight > image.height) {
    cropHeight = image.height;
    cropWidth = Math.round(image.height * targetRatio);
  }
  if (cropWidth <= 0 || cropHeight <= 0) return null;
  const left = Math.max(0, Math.floor((image.width - cropWidth) / 2));
  const top = Math.max(0, Math.floor((image.height - cropHeight) / 2));
  return {
    width: cropWidth,
    height: cropHeight,
    rgba: cropRgba(image.rgba, image.width, image.height, left, top, cropWidth, cropHeight)
  };
}

/**
 * 生成尺寸被抬大以后，把结果缩回用户要的尺寸。
 * PNG 走自带的纯 JS 面积平均缩放（无依赖、任何进程可用）；
 * 'cover' 会先把比例裁成目标比例（平台无视比例时用），默认 'exact' 直接重采样。
 * 其它格式再试 Electron 的 nativeImage。
 *
 * 目标尺寸来自对话模型可填的 size：分配像素缓冲区前必须先挡住超大值，
 * 否则 `99999x99999` 会直接申请几十 GB 内存。上限与图片解码的 32MP 预算一致。
 */
const MAX_RESIZE_SIDE = 16384;
const MAX_RESIZE_PIXELS = 32 * 1024 * 1024;

export function resizeTo(bytes, width, height, mode) {
  if (!bytes || !width || !height) return null;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  if (width > MAX_RESIZE_SIDE || height > MAX_RESIZE_SIDE || width * height > MAX_RESIZE_PIXELS) return null;
  let cropped = false;
  try {
    const image = decodePng(bytes);
    if (image) {
      if (image.width === width && image.height === height) return { bytes: bytes, contentType: 'image/png', resized: false, cropped: false };
      let source = image;
      if (mode === 'cover') {
        const next = coverCrop(image, width, height);
        if (next) { source = next; cropped = true; }
      }
      const rgba = resizeRgba(source.rgba, source.width, source.height, width, height);
      return { bytes: encodePng(rgba, width, height), contentType: 'image/png', resized: true, cropped: cropped };
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
    if (size.width === width && size.height === height) return { bytes: bytes, contentType: 'image/png', resized: false, cropped: false };
    let source = image;
    if (mode === 'cover' && size.width && size.height) {
      const targetRatio = width / height;
      if (Math.abs(size.width / size.height - targetRatio) > 0.01) {
        let cropWidth = size.width;
        let cropHeight = Math.round(size.width / targetRatio);
        if (cropHeight > size.height) {
          cropHeight = size.height;
          cropWidth = Math.round(size.height * targetRatio);
        }
        if (cropWidth > 0 && cropHeight > 0) {
          const left = Math.max(0, Math.floor((size.width - cropWidth) / 2));
          const top = Math.max(0, Math.floor((size.height - cropHeight) / 2));
          source = image.crop({ x: left, y: top, width: cropWidth, height: cropHeight });
          cropped = true;
        }
      }
    }
    const resized = source.resize({ width: width, height: height, quality: 'best' });
    const png = resized.toPNG();
    if (!png || !png.length) return null;
    return { bytes: png, contentType: 'image/png', resized: true, cropped: cropped };
  } catch (_error) {
    return null;
  }
}

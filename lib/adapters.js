/**
 * 生图请求适配层。
 *
 * 插件其余部分只认「规范形式」：
 *   { model, prompt, size: { width, height, text }, quality?, seed?, images? }
 *
 * 每个适配器声明两件事：
 *   endpoints/transport —— 往哪个地址发、用什么编码
 *   response            —— 怎么从回应里挖出图片字节
 *
 * 请求体里「六个逻辑字段」（prompt / negative / model / n / image / quality）写在哪，
 * 归预设与模型规则的**字段模板**（lib/field-templates.js）：通用路径先
 * resolveFields(override > rule > preset)，再用 applyFields / multipartFields /
 * promptParts 写进 body。协议自己不再持有字段名。
 *
 * 协议上只剩三类东西，都不是「这家网关把提示词叫什么」：
 *   - output_format 这类真正的传输常量（response_format / watermark 已经搬进
 *     请求常量规则 CONSTANT_RULES，见 lib/model-rules.js）；
 *   - 尺寸「怎么发」的协议例外（属于请求形状而不是字段名）：
 *     openai-chat 把尺寸写进提示词（`size.control: 'prompt'`）；
 *   - 协议级选项：同一条地址/组装下按选项改写的端点（PROTOCOL_OPTIONS，现在只剩 `edit`）；
 *     鉴权方式不在协议上，它是提供商字段（provider.auth，见 lib/adapter-kit.js 的 AUTH_MODES）。
 * a1111 / comfyui / swarmui 的宽高由各自 execute() 直接拼进 sdapi 参数/工作流，不接规则表。
 *
 * 新增一个模型族 = 加一条描述符，不用改调用方。
 */

import { createRequire } from 'node:module';
import { decodePng, encodePng, resizeRgba } from './png-scale.js';
import { localizedError } from './localized-error.js';
import {
  ASPECT_CHOICES, aspectLabel, nearestAspect, baseUrlOf, headersFor, credentialRef, joinEndpoint,
  resolveHttpUrl, readJsonResponse, jsonRequest, getPath, sniffType, looksLikeImage,
  decodeImagePayload, classifyFailure, extractMessage,
  readResponseBytes, MAX_IMAGE_BYTES, imageSizeOf,
  AUTH_MODES, AUTH_HEADER_PATTERN, AUTH_PREFIX_MAX, authSpecOf, normalizeAuthSpec
} from './adapter-kit.js';
// 结果图只有 fetchResultImage 一个下载入口（同源带凭据、跨源默认不带），见 lib/request-auth.js。
import { requestProvider } from './request-auth.js';
import { executeImageRequest } from './image-request.js';
import { assertReferenceCount, operationOutputOf, providerOperationsOf, responseOverridesOf, validateOperationTransport } from './provider-operations.js';
import { OPENAI_ADAPTERS } from './adapters/openai.js';
import { ASYNC_ADAPTERS } from './adapters/async.js';
import { CN_ADAPTERS, wanMultimodalVariant } from './adapters/cn.js';
import {
  detectSizeRule, detectQualityRule, detectFieldRule, detectConstantRule, GEMINI_25_IMAGE, isGeminiImageModel,
  IDEOGRAM_45, IDEOGRAM_46, IDEOGRAM_EDIT, STABILITY_SD3_MODEL, WAN_26_T2I, WAN_27_IMAGE
} from './model-rules.js';
import { applyFields, multipartFields, promptParts, resolveFields } from './field-templates.js';
import {
  outputProfile, outputProfiles, taskPollTarget, taskSpecOf, taskStateOf
} from './output-profiles.js';

export {
  ASPECT_CHOICES, aspectLabel, nearestAspect, sniffType, looksLikeImage,
  decodeImagePayload, classifyFailure, extractMessage, readResponseBytes, MAX_IMAGE_BYTES, imageSizeOf,
  // 鉴权方式是提供商字段：三个常量与两个解析函数从这里转出去，调用方（index / config-store /
  // 测试）不用直接依赖 adapter-kit。
  AUTH_MODES, AUTH_HEADER_PATTERN, AUTH_PREFIX_MAX, authSpecOf, normalizeAuthSpec,
};

const require = createRequire(import.meta.url);
const DEFAULT_SIZE = '1024x1024';

/* ------------------------------------------------------------------ size */

/**
 * 内部 policy：规则（domain 值域 + size 形态）与用户覆盖（modelOptions[model].size）
 * 叠加以后的形状。规则和覆盖共用 `{ mode, field, separator, second }`，由
 * applySizeOverride() 统一翻译成 `control / style / wire / tierLabels`。
 *
 * 规则决定"这个模型认什么"，用户覆盖决定"这家网关怎么发"；覆盖最后叠。
 */
const NEUTRAL = { control: 'none', wire: [] };

/** 规则层：先把值域铺开，再按「怎么发」落形态。 */
function policyFromRule(rule) {
  if (!rule) return Object.assign({}, NEUTRAL);
  const domain = rule.domain && typeof rule.domain === 'object' ? rule.domain : {};
  return applySizeOverride(Object.assign({}, NEUTRAL, domain), rule.size || null, true);
}

/**
 * 协议里的两个例外之一：尺寸只能写进提示词（openai-chat）。
 *
 * 这属于"请求形状"而不是"字段名"，按设计留在协议上（`control: 'prompt'`），
 * 不进规则表——规则表按模型名匹配，而同一个模型在 openai-chat 与 gpt-image
 * 两条协议上要的形态完全不同。所以由调用方把适配器递进来，在这里叠一层。
 */
function protocolSizeOverride(adapter) {
  const size = adapter && adapter.size;
  if (!size || typeof size !== 'object') return null;
  if (String(size.control || '') !== 'prompt' && size.stitch !== true) return null;
  return { mode: 'prompt', field: typeof size.field === 'string' ? size.field : '' };
}

export function sizeRuleFor(provider, model, adapter) {
  const rule = detectSizeRule(model, provider && provider.baseUrl, adapter?.id);
  const protocol = protocolSizeOverride(adapter);
  return protocol ? { ...rule, size: protocol, generic: !rule || rule.generic === true } : rule;
}

/**
 * 这个模型真正适用的尺寸策略：规则表 + 用户覆盖。
 *
 * 按已解析的协议选规则，再应用协议级例外和用户覆盖。
 */
export function sizePolicyFor(provider, model, adapter) {
  return applySizeOverride(policyFromRule(sizeRuleFor(provider, model, adapter)), sizeOverrideOf(provider, model), false);
}

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

/** 模型选项里可选的编码方式；空字符串表示跟随适配器默认。 */
export const SIZE_MODES = ['wh-string', 'wh-fields', 'aspect', 'tier', 'prompt', 'none'];
/** 面板可用的控件形态（`control`）：只影响面板渲染，不决定线上写法。 */
export const SIZE_CONTROLS = ['wh', 'aspect', 'preset', 'prompt'];

const DEFAULT_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];
const DEFAULT_TIERS = [
  { value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }, { value: '4K', pixels: 16777216 }
];

/**
 * 从 provider.modelOptions[model].size 读用户覆盖。
 * 三个键各自独立生效：只填参数名就只换字段名，不动形态。
 * `control` 只决定面板给哪种控件（规则里也在用它），不影响线上写法。
 */
export function sizeOverrideOf(provider, model) {
  const options = provider && typeof provider === 'object' ? provider.modelOptions : null;
  const entry = options && typeof options === 'object' ? options[String(model || '')] : null;
  const size = entry && entry.size;
  if (!size || typeof size !== 'object' || Array.isArray(size)) return null;
  const mode = SIZE_MODES.includes(String(size.mode)) ? String(size.mode) : '';
  const field = typeof size.field === 'string' ? size.field.trim().slice(0, 120) : '';
  const separator = typeof size.separator === 'string' ? size.separator.trim().slice(0, 4) : '';
  const control = SIZE_CONTROLS.includes(String(size.control)) ? String(size.control) : '';
  const second = secondOverrideOf(size.second);
  if (!mode && !field && !separator && !second && !control) return null;
  return { mode: mode, field: field, separator: separator, second: second, control: control };
}

/** 第二个字段：把比例或档位另写一处（Gemini 的 aspectRatio + imageSize 就是这种）。 */
function secondOverrideOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const field = typeof raw.field === 'string' ? raw.field.trim().slice(0, 120) : '';
  if (!field) return null;
  return { from: raw.from === 'tier' ? 'tier' : 'aspect', field: field };
}

/** 有白名单说明这个模型按"预设像素"选，没有就是宽高输入框。 */
function derivedControl(policy) {
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : [];
  return allowed.length ? 'preset' : 'wh';
}

/**
 * 把 `{ mode, field, separator, second }` 叠成内部 policy：规则层与用户覆盖层共用。
 *
 * `fromRule = true` 表示这一层是规则表（设计说"这个模型认哪些值"）：
 *   - 控件形态按值域推导，不写死 'wh'（recraft / ideogram-4 / 硅基流动的
 *     基础声明是预设芯片，不是宽高输入框）；
 *   - 不往 policy 里塞默认比例表/默认档位表：规则没写就是没有，凭空补一套
 *     会让 wanx 这类"只给白名单、用户自己填 WxH"的模型变成发档位名。
 * `fromRule = false`（用户覆盖）保持原有脾气：用户明确说了怎么发，控件跟着变，
 * 缺比例表/档位表时补一套默认的，面板才不会是空的。
 */
function applySizeOverride(policy, override, fromRule) {
  const out = Object.assign({}, policy);
  if (!override || typeof override !== 'object') return out;
  if (override.second) out.second = override.second;
  const mode = override.mode;
  if (mode === 'prompt') {
    out.control = 'prompt';
    out.stitch = true;
    out.style = 'string';
    out.wire = [];
    if (override.field) out.field = override.field;
    return out;
  }
  if (mode === 'aspect') {
    const previousStyle = out.style;
    out.control = 'aspect';
    out.style = 'aspect';
    out.stitch = false;
    out.tierLabels = false;
    out.field = override.field || (previousStyle === 'aspect' ? out.field : '') || 'aspect_ratio';
    if (!fromRule && (!Array.isArray(out.aspects) || !out.aspects.length)) out.aspects = DEFAULT_ASPECTS.slice();
    // 比例型模型同样按档位决定像素预算；没有档位表就给一套默认的，第二个字段也才有值可发。
    if (!fromRule && (!Array.isArray(out.tiers) || !out.tiers.length)) out.tiers = DEFAULT_TIERS.slice();
    return out;
  }
  if (mode === 'tier') {
    out.control = 'preset';
    out.style = 'string';
    out.stitch = false;
    out.tierLabels = true;
    out.field = override.field || 'size';
    // 档位形态也可能带分隔符（百炼万相发 `1024*1024`），tier 分支不碰它就会退回默认的 x。
    if (override.separator) out.separator = override.separator;
    // 有白名单的模型（万相）按像素走，不能因为 tier 形态就凭空发档位名。
    const hasAllowed = Array.isArray(out.allowed) && out.allowed.length > 0;
    if (!fromRule && !hasAllowed && (!Array.isArray(out.tiers) || !out.tiers.length)) out.tiers = DEFAULT_TIERS.slice();
    return out;
  }
  if (mode === 'wh-fields') {
    out.control = 'wh';
    out.style = 'width-height';
    out.stitch = false;
    out.tierLabels = false;
    // 这个形态下 `field` 是「宽」的键名、`second.field` 是「高」的键名（缺省 width / height），
    // 所以 second 不再表示「另发一个比例/档位字段」——secondSizeField() 见到这个 style 就跳过。
    out.field = override.field || 'width';
    return out;
  }
  if (mode === 'wh-string') {
    // 规则层：控件形态按值域推导，规则自己也可以点名（recraft 的向量模型是"面板给比例、
    // 线上发像素"这种组合，单看 mode 说不清）。用户覆盖层：默认宽高，但覆盖里带了
    // control 就照它——一键配置把规则抄成覆盖时，面板控件不该因此退回宽高。
    out.control = String(override.control || '') || (fromRule ? derivedControl(out) : 'wh');
    out.style = 'string';
    out.stitch = false;
    out.tierLabels = false;
    out.field = override.field || out.field || 'size';
    if (override.separator) out.separator = override.separator;
    return out;
  }
  if (mode === 'none') {
    // 该模型不发尺寸字段：fitSize 返回 { omit: true }，encodeSize 直接空手返回。
    out.control = 'none';
    out.style = 'none';
    out.stitch = false;
    out.tierLabels = false;
    out.wire = [];
    if (override.field) out.field = override.field;
    return out;
  }
  // 只改了参数名 / 分隔符：形态仍然跟默认走。
  if (override.field) out.field = override.field;
  if (override.separator) out.separator = override.separator;
  return out;
}

/**
 * 下发给选择器的尺寸能力：控件形态 + 候选 + hint 代码。
 * 客户端只按这个渲染，不再自己判断"这个模型收不收宽高"。
 * `adapter` 只用于协议级例外（`control: 'prompt'`），可以不传。
 */
export function sizeSpecFor(provider, model, adapter) {
  const policy = sizePolicyFor(provider, model, adapter);
  const allowed = Array.isArray(policy.allowed) ? policy.allowed.filter(Boolean).map(String) : [];
  const control = String(policy.control || (allowed.length ? 'preset' : (policy.style === 'aspect' ? 'aspect' : 'wh')));
  const tiers = (Array.isArray(policy.tiers) ? policy.tiers : [])
    .filter((item) => item && item.value)
    .map((item) => ({ value: String(item.value), pixels: Number(item.pixels) || 0 }));
  const override = sizeOverrideOf(provider, model);
  return {
    control: control,
    aspects: Array.isArray(policy.aspects) ? policy.aspects.map(String) : [],
    tiers: tiers.length ? tiers : allowed.map((value) => ({ value: value, pixels: 0 })),
    custom: policy.custom === true,
    wire: Array.isArray(policy.wire) ? policy.wire.map(String) : [],
    stitch: policy.stitch === true,
    // 线上怎么写：参数名、分隔符、编码样式。选择器的占位符要用。
    field: String(policy.field || ''),
    separator: String(policy.separator || ''),
    style: String(policy.style || ''),
    mode: (override && override.mode) || '',
    second: (policy.second && policy.second.field) ? { from: policy.second.from === 'tier' ? 'tier' : 'aspect', field: String(policy.second.field) } : null,
    hint: String(policy.hint || '')
  };
}

/** 档位名（"2K"）解析成 {value, pixels}；不是档位就退成 WxH 像素。 */
export function parseTier(provider, raw, model) {
  return parseTierForPolicy(sizePolicyFor(provider, model), raw);
}

function parseTierForPolicy(policy, raw) {
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

function clampPixels(width, height, minPixels, maxPixels, multiple, minSide, maxSide, maxAspect) {
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
  // 先等比缩放，再给取整后的尺寸补齐硬边界。极端比例有时必须收窄长边。
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
  const alignDown = (value) => Math.floor(value / multiple) * multiple;
  const minAligned = Math.max(multiple, Math.ceil(minSide / multiple) * multiple);
  const maxAligned = maxSide ? Math.max(minAligned, alignDown(maxSide)) : Infinity;
  const align = (value) => Math.min(maxAligned, Math.max(minAligned, Math.round(value / multiple) * multiple));
  w = align(w);
  h = align(h);
  if (maxAspect) {
    w = Math.min(w, alignDown(h * maxAspect));
    h = Math.min(h, alignDown(w * maxAspect));
  }
  if (maxPixels && w * h > maxPixels) {
    if (w >= h) w = Math.max(minAligned, alignDown(maxPixels / h));
    else h = Math.max(minAligned, alignDown(maxPixels / w));
  }
  return { width: w, height: h };
}

/**
 * 把用户要的尺寸落成该模型真正接受的尺寸。
 * 返回 { size, width, height, adjusted, reason, requested, rejected? }
 */
export function fitSize(provider, request, model, adapter) {
  const policy = sizePolicyFor(provider, model, adapter);
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

  // 规则说了"不发尺寸字段"（mode:'none'）：和选了自动一样，不落任何尺寸。
  if (policy.control === 'none' || policy.style === 'none') {
    return Object.assign(settle('none', false, '', null), { size: 'none', width: 0, height: 0, omit: true });
  }

  if (!requestedText || requestedText === 'none' || requestedText === 'auto') {
    // 用户选了「自动」：请求里干脆不带尺寸，让模型自己决定
    return Object.assign(settle('none', false, '', null), { size: 'none', width: 0, height: 0, omit: true });
  }

  // 档位名（"2K"）：size 保留档位名（编码要原样发上去），宽高取该档像素。
  const tier = requested ? null : parseTierForPolicy(policy, requestedText);
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

    const chosen = nearestAllowed(allowed, requested.width, requested.height) || fallback;
    return done(settle(chosen, true, requested.text + ' → ' + chosen.text, requested));
  }

  const multiple = Number(policy.multiple) || 1;
  const minPixels = Number(policy.minPixels) || 0;
  const maxPixels = Number(policy.maxPixels) || 0;
  const minSide = Number(policy.minSide) || 0;
  const maxSide = Number(policy.maxSide) || 0;
  const clamped = clampPixels(requested.width, requested.height, minPixels, maxPixels, multiple, minSide, maxSide, policy.maxAspect);
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
export function sizeHintText(provider, model, adapter) {
  const policy = sizePolicyFor(provider, model, adapter);
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
  // 规则明确说了"不发尺寸"才叫不接受；只是没写取值域就别替上游下结论。
  if (!parts.length) return policy.control === 'none' ? '该模型不接受尺寸参数' : '该模型没有声明尺寸范围';
  return '支持的尺寸：' + parts.join('，');
}

/* -------------------------------------------------------------- adapters */

/** 模型选项里的第二个尺寸字段（例如比例写 aspectRatio、档位写 imageSize）。 */
function secondSizeField(policy, fitted) {
  const second = policy && policy.second;
  if (!second || !second.field) return null;
  // width + height 形态里 second 是「高」的键名，不是另发一个比例/档位字段。
  if (String(policy.style || '') === 'width-height') return null;
  const from = second.from === 'tier' ? 'tier' : 'aspect';
  let value = '';
  if (from === 'tier') {
    value = String(fitted.tier || '');
  } else {
    const aspects = Array.isArray(policy.aspects) ? policy.aspects : [];
    const fallback = aspectLabel(fitted.width || 1024, fitted.height || 1024);
    const wanted = String(fitted.aspect || '');
    value = wanted && (!aspects.length || aspects.includes(wanted)) ? wanted : fallback;
  }
  return value ? { field: String(second.field), value: value } : null;
}

function encodeSize(policy, fitted) {
  if (fitted.omit || fitted.size === 'none') return {};
  if (policy.control === 'prompt' || policy.stitch === true) return {};
  // 规则说了"不发尺寸字段"：手搓的 fitted（测试/降级路径）也不许漏出去。
  if (policy.control === 'none' || policy.style === 'none') return {};
  const out = encodeSizePrimary(policy, fitted);
  const second = secondSizeField(policy, fitted);
  return second ? Object.assign(out, fieldPatch(second.field, second.value)) : out;
}

function widthHeightFields(policy) {
  let width = String(policy.field || '') || 'width';
  let height = String(policy.second?.field || '') || 'height';
  if (height === width) height = 'height';
  if (height === width) width = 'width';
  return [width, height];
}

function sizeParamPaths(policy) {
  if (!policy || policy.control === 'none' || policy.control === 'prompt' || policy.stitch === true) return [];
  if (policy.style === 'width-height') return widthHeightFields(policy);
  return [policy.field || 'size', policy.second?.field].filter(Boolean);
}

function encodeSizePrimary(policy, fitted) {
  const field = policy.field || 'size';
  const style = policy.style || 'string';

  // 少数平台只认档位名（火山方舟的 1K/1.5K/2K）；已经就是档位就原样发，
  // 是像素且贴近某一档才换成档位名，其余照发像素。
  // 只有"真的把档位名发上去"的平台才在 encode 时把像素换成档位；
  // 中转站 / 通用网关的 tiers 只是面板上的档位，线上仍然发 WxH。
  const tiers = policy.tierLabels === true
    ? (Array.isArray(policy.tiers) && policy.tiers.length ? policy.tiers : null)
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
  if (style === 'width-height') {
    const [widthField, heightField] = widthHeightFields(policy);
    return { [widthField]: fitted.width, [heightField]: fitted.height };
  }
  if (style === 'aspect') {
    const aspects = policy.aspects || ['1:1'];
    if (aspects.includes(fitted.aspect)) return { [field]: fitted.aspect };
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

/* --------------------------------------------------------------- quality */

/** 质量档位给人看的名字；规则表只存值，标签在这里补。 */
const QUALITY_LABELS = {
  off: 'Off', very_low: 'Very Low', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', auto: 'Auto',
  standard: 'Standard', hd: 'HD', turbo: 'Turbo', default: 'Default', quality: 'Quality'
};

function qualityLabelOf(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (QUALITY_LABELS[key]) return QUALITY_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * 从 provider.modelOptions[model].quality 读用户覆盖：收不收 + 字段名 + 档位表。
 *
 * 结构校验与 sizeOverrideOf 一样走"有用才留"：一项都不合法就当没填。唯一的例外是
 * `supported: false`——那是用户明确关掉了质量，必须留下（否则下次读回来又被规则打开）。
 *
 * 档位两种写法都认：字符串（老配置）与 `{ value, label, default }`（「质量」方框）。
 * `options` 仍只返回值字符串（下游按值匹配），显示名单独放 `labels`，默认档放在 `default`。
 */
export function qualityOverrideOf(provider, model) {
  const options = provider && typeof provider === 'object' ? provider.modelOptions : null;
  const entry = options && typeof options === 'object' ? options[String(model || '')] : null;
  const quality = entry && entry.quality;
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) return null;
  const supported = quality.supported !== false;
  const field = typeof quality.field === 'string' ? quality.field.trim().slice(0, 120) : '';
  const raw = Array.isArray(quality.options) ? quality.options : [];
  const list = [];
  const labels = {};
  let flagged = '';
  for (const item of raw) {
    const object = Boolean(item) && typeof item === 'object' && !Array.isArray(item);
    const value = String(object
      ? (item.value === undefined || item.value === null ? '' : item.value)
      : (item === undefined || item === null ? '' : item))
      .trim().toLowerCase();
    // off 是全局固定档位，不进规则/覆盖的选项表。
    if (!value || value === 'off' || list.includes(value)) continue;
    list.push(value);
    if (object && typeof item.label === 'string' && item.label.trim()) labels[value] = item.label.trim();
    if (object && item.default === true && !flagged) flagged = value;
  }
  const map = quality.map && typeof quality.map === 'object' && !Array.isArray(quality.map) ? quality.map : null;
  if (!field && !list.length && !map && supported) return null;
  const declared = String(quality.default || '').trim().toLowerCase();
  const wanted = flagged || declared;
  const fallback = wanted && wanted !== 'off' ? wanted : '';
  return {
    supported: supported,
    field: field,
    options: list,
    labels: Object.keys(labels).length ? labels : null,
    map: map,
    default: fallback
  };
}

/** 规则 + 覆盖合并成一份质量说明；两边都没有就是"不发这个字段"。 */
function qualitySpecFor(provider, model, adapter) {
  // 有实际接收档位的请求字段才提供选择器。自定义操作可以分别声明或关闭质量参数。
  let field;
  if (adapter?.id === 'custom') {
    for (const kind of ['generate', 'edit']) {
      if (!adapterSupportsKind(adapter, kind)) continue;
      field = operationFieldsFor(adapter, provider, model, kind).quality;
      if (field) break;
    }
  } else {
    field = fieldsFor(adapter, provider, model).quality;
  }
  if (!field) return null;
  const rule = detectQualityRule(model, provider && provider.baseUrl, adapter?.id);
  const saved = qualityOverrideOf(provider, model);
  // 用户明确说了「这个模型不收质量参数」：这一票最靠前，规则说收也不算。
  if (saved && saved.supported === false) return null;
  // 旧版一键配置把 4.5/4.6 存成 rendering_speed；接新版原生接口时用新版规则。
  const override = adapter?.id === 'ideogram' && IDEOGRAM_EDIT.test(model) && saved?.field === 'rendering_speed' ? null : saved;
  const base = rule && rule.quality && typeof rule.quality === 'object' ? rule.quality : null;
  if (!base && !override) return null;
  const options = (override && override.options && override.options.length
    ? override.options
    : (base && Array.isArray(base.options) ? base.options : []))
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => item && item !== 'off');
  if (!options.length) return null;
  const map = Object.assign({}, base && base.map ? base.map : {}, override && override.map ? override.map : {});
  // 显示名只认覆盖层；规则表里本来就没有这一列。只留落在最终档位表里的那几条。
  const labels = {};
  if (override && override.labels) {
    for (const value of options) if (override.labels[value]) labels[value] = override.labels[value];
  }
  const wanted = String((override && override.default) || (base && base.default) || '').trim().toLowerCase();
  const fallback = options.includes(wanted) ? wanted : options[0];
  return {
    field: String((override && override.field) || (base && base.field) || field.path || field.multipart || 'quality'),
    options: options,
    labels: Object.keys(labels).length ? labels : null,
    map: Object.keys(map).length ? map : null,
    default: fallback
  };
}

export function qualityOptionsFor(provider, model, adapter) {
  const spec = qualitySpecFor(provider, model, adapter);
  if (!spec) return null;
  // off 固定在第一项：语义是"不发这个参数"（mapQuality 那一头负责翻译）。
  // 显示名：用户在「质量」方框里写了就用他的，没写才回落到词表/首字母大写。
  const options = [{ value: 'off', label: qualityLabelOf('off') }]
    .concat(spec.options.map((value) => ({
      value: value,
      label: (spec.labels && spec.labels[value]) || qualityLabelOf(value)
    })));
  const aliases = Object.fromEntries(Object.entries(spec.map || {}).filter(([value, target]) =>
    !spec.options.includes(value) && spec.options.includes(target)));
  return {
    label: '质量',
    options: options,
    default: spec.options.includes(spec.default) ? spec.default : 'off',
    ...(Object.keys(aliases).length ? { aliases } : {})
  };
}

export function qualityForAdapter(provider, model, value, adapter) {
  const spec = qualitySpecFor(provider, model, adapter);
  if (!spec) return undefined;
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (spec.options.includes(raw)) return raw;
  const alias = spec.map?.[raw];
  return spec.options.includes(alias) ? alias : spec.default;
}

/**
 * 规范质量档 → 该模型/该协议真正要发的值。
 * `off`（与 `auto`）的语义是"完全不发这个参数"，所以返回 undefined。
 */
export function mapQuality(provider, model, quality, adapter) {
  const value = String(quality || '').trim().toLowerCase();
  // Off：按用户要求完全不发这个参数
  if (!value || value === 'off' || value === 'auto') return undefined;
  const spec = qualitySpecFor(provider, model, adapter);
  if (!spec) return undefined;
  if (spec.map && spec.map[value]) return spec.map[value];
  if (spec.options.includes(value)) return value;
  if (spec.default) return spec.default;
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

function hostOfBase(baseUrl) {
  try { return new URL(baseUrl).host.toLowerCase(); } catch (_error) { return ''; }
}

/** Ideogram 把模型写进路径：/v2/image/generate/{model}。 */
function ideogramPath(input) {
  const model = String((input && input.model) || 'ideogram-3').trim().replace(/^\/+/, '') || 'ideogram-3';
  return '/v2/image/generate/' + encodeURIComponent(model);
}

const IDEOGRAM_ROUTE = '/v2/image/generate/{model}';
const IDEOGRAM_MODELS = ['ideogram-3', 'ideogram-4', 'ideogram-4-5', 'ideogram-4-6', 'ideogram-4-transparent'];
const IDEOGRAM_MAX_IMAGE_BYTES = 25_000_000;
const IDEOGRAM_EDIT_OPERATION = {
  maxImages: 5,
  imageTypes: ['image/jpeg', 'image/png', 'image/webp'],
  fields: { image: { multipart: 'images' } }
};

function ideogramPrompt(input, fields) {
  const prompt = String(input.prompt || '');
  const negative = input.negativePrompt;
  if (!negative || !fields.negative) return prompt;
  if (prompt.trimStart().startsWith('{')) {
    try {
      const structured = JSON.parse(prompt);
      if (typeof structured?.high_level_description === 'string') {
        structured.high_level_description += ' Avoid: ' + negative;
        return JSON.stringify(structured);
      }
    } catch (_error) { /* Ideogram also accepts natural-language prompts. */ }
  }
  return promptParts(fields, { prompt, negative }).prompt;
}

function fitIdeogram45Edit(fitted) {
  if (!fitted || fitted.omit) return fitted;
  const requested = fitted.requested || parseSize(fitted.size);
  if (!requested) return fitted;
  // 图生图允许预设表之外的尺寸，但边长仍须是 32 的倍数。
  const { width, height } = clampPixels(requested.width, requested.height, 0, 2048 ** 2, 32, 256, 0, 6);
  const size = width + 'x' + height;
  const adjusted = size !== requested.text;
  return { ...fitted, width, height, size, requested, adjusted, reason: adjusted ? requested.text + ' → ' + size : '' };
}

function executeIdeogramModern(kind, adapter, provider, input, signal, hooks) {
  const isEdit = kind === 'edit';
  const model = input.model;
  const is45 = IDEOGRAM_45.test(model);
  const fields = detectFieldRule(model, '', adapter.id).fields;
  const body = { prompt: ideogramPrompt(input, fields), num_images: 1 };
  const fitted = isEdit && is45 ? fitIdeogram45Edit(input.fitted) : input.fitted;
  if (fitted !== input.fitted) input = { ...input, fitted };
  const size = fitted && !fitted.omit ? fitted.size : '';
  if (size) body.size = size;
  const quality = isEdit && is45 && input.quality === 'very_low'
    ? 'very_low'
    : mapQuality(provider, model, input.quality, adapter);
  if (quality) body.quality = quality;
  if (IDEOGRAM_46.test(model) && quality === 'very_low'
    && (size === 'auto_4k' || fitted?.width * fitted?.height > 2048 ** 2 || Math.max(fitted?.width, fitted?.height) > 4608)) {
    throw new Error('Ideogram 4.6 的 Very Low 档最高支持 2K、单边最多 4608 像素。请调低尺寸或换一个质量档。');
  }
  const protectedPaths = ['images', 'negative_prompt', 'rendering_speed', 'resolution', 'quality', 'num_images', 'async', 'webhook_url'];
  const path = ideogramPath(input);
  if (!isEdit) return executeBuiltImage(kind, adapter, provider, input, path, body, signal, { protectedPaths }, hooks);
  const operation = IDEOGRAM_EDIT_OPERATION;
  const images = input.images || [];
  if (!images.length) throw new Error('Ideogram 编辑需要至少一张参考图。');
  assertReferenceCount(operation, images.length);
  for (const image of images) {
    if (!operation.imageTypes.includes(image?.contentType)) throw new Error('Ideogram 参考图只支持 JPEG、PNG 或 WebP。');
    if (image.buffer?.length > IDEOGRAM_MAX_IMAGE_BYTES) throw new Error('Ideogram 单张参考图不能超过 25 MB。');
    const dimensions = imageSizeOf(image.buffer);
    if (!dimensions) throw new Error('Ideogram 无法读取参考图尺寸。');
    const { width, height } = dimensions;
    if (Math.max(width, height) > 6 * Math.min(width, height)) throw new Error('Ideogram 参考图宽高比必须在 1:6 和 6:1 之间。');
  }
  applyHttpParams(body, provider, input, { protectedPaths });
  const form = formOf(body);
  for (const image of images) {
    form.append(operation.fields.image.multipart, new Blob([image.buffer], { type: image.contentType }), image.filename);
  }
  return executeBuiltImage(kind, adapter, provider, input, path, form, signal, undefined, hooks);
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

import {
  parseWorkflow, uiToApi, analyzeWorkflow, injectByMapping, applyWorkflowParams, listWorkflowInputs,
  PROMPT_ROLE_NAMES
} from './comfy-workflow.js';

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

function rememberObjectInfo(key, data, bytes) {
  if (bytes > OBJECT_INFO_BUDGET) return;
  pruneObjectInfo(Date.now());
  // Map 的插入顺序就是淘汰顺序：重写同一个键时先删再加，让它回到队尾。
  evictObjectInfo(key);
  objectInfoCache.set(key, { at: Date.now(), bytes, data });
  objectInfoBytes += bytes;
  while (objectInfoBytes > OBJECT_INFO_BUDGET) {
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
async function comfyObjectInfo(base, provider, signal, fresh = false) {
  const key = objectInfoKey(base, provider, '', '');
  const hit = objectInfoCache.get(key);
  if (hit) {
    if (!fresh && Date.now() - hit.at < OBJECT_INFO_TTL) return hit.data;
    if (Date.now() - hit.at >= OBJECT_INFO_TTL) evictObjectInfo(key);
  }
  const pending = objectInfoInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const response = await requestProvider(joinEndpoint(base, '/object_info'), { headers: headersFor(provider, false), signal }, provider);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch (_error) { /* already closed */ }
      const error = localizedError(new Error('读不到 ComfyUI 的节点签名（/object_info 返回 HTTP ' + response.status + '）'),
        'upstream.httpNoDetail', { status: response.status });
      error.status = response.status;
      throw error;
    }
    const bytes = await readResponseBytes(response, 40 * 1024 * 1024);
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch (_error) {
      throw localizedError(new Error('本地生图服务返回的不是 JSON'), 'upstream.invalidJson');
    }
    rememberObjectInfo(key, data, bytes.length);
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
function comfyOptionReader(base, provider, signal) {
  let fallback;
  const getFull = () => (fallback ||= comfyObjectInfo(base, provider, signal, true).catch((error) => {
    if ([404, 405].includes(error.status)) return {};
    throw error;
  }));
  return (node, field) => comfyNodeOptions(base, provider, node, field, signal, getFull);
}

async function comfyNodeOptions(base, provider, node, field, signal, getFull) {
  const key = objectInfoKey(base, provider, node, field);
  const pending = objectInfoInflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    const response = await requestProvider(joinEndpoint(base, '/object_info/' + node), { headers: headersFor(provider, false), signal }, provider);
    let payload;
    if ([404, 405].includes(response.status)) {
      try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
      payload = await getFull();
    } else {
      payload = await readJsonResponse(response, 20 * 1024 * 1024, provider);
    }
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
async function comfyFluxAssets(options, model) {
  if (!FLUX2_NAME.test(String(model || ''))) {
    throw new Error('ComfyUI 目前内置的是 FLUX.2 系列（diffusion_models）工作流；'
      + '其它架构（如 FLUX.1、Qwen-Image、Z-Image）请改用「其他 OpenAI 兼容网关」。');
  }
  const [clips, vaes] = await Promise.all([options('CLIPLoader', 'clip_name'), options('VAELoader', 'vae_name')]);
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
  const response = await requestProvider(joinEndpoint(base, '/upload/image'), {
    method: 'POST', headers: headersFor(provider, true), body: form, signal
  }, provider);
  const payload = await readJsonResponse(response, 2 * 1024 * 1024, provider);
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

async function comfyFluxWorkflow(base, provider, { kind, input, model, width, height, seed, signal, options }) {
  const assets = await comfyFluxAssets(options, model);
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

async function comfyMossAssets(options) {
  const [clips, vaes] = await Promise.all([options('CLIPLoader', 'clip_name'), options('VAELoader', 'vae_name')]);
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

async function comfyMossWorkflow({ input, model, width, height, seed, options }) {
  if (!MOSS_NAME.test(String(model || ''))) {
    throw new Error('ComfyUI 目前内置的是 MOSS-Image（diffusion_models）文生图工作流。');
  }
  const assets = await comfyMossAssets(options);
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
async function comfyMossEditWorkflow(base, provider, { input, model, seed, signal, options }) {
  const assets = await comfyMossAssets(options);
  const loras = await options('LoraLoaderModelOnly', 'lora_name');
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

function comfySubmitAndWait(provider, adapter, kind, input, graph, signal, hooks, note) {
  return executeImageRequest(kind, adapter, provider, input, () => ({
    ...jsonRequest(adapter, provider, '/prompt', { prompt: graph, client_id: 'dsh-mo-image' }),
    allowFieldDrops: false, note
  }), signal, hooks);
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
const COMFY_MANAGED_ROLES = ['prompt', 'negative_prompt', 'model', 'width', 'height', 'image'];

function workflowPlaceholders(text) {
  return new Set(Array.from(text.matchAll(PLACEHOLDER_ANY), (match) =>
    match[1] === 'negativePrompt' ? 'negative_prompt' : match[1]));
}

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
  const placeholders = workflowPlaceholders(raw);
  const mapping = provider?.modelOptions?.[model]?.mapping;
  return ['width', 'height'].every((role) => placeholders.has(role) || Boolean(mapping?.[role]));
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

/**
 * 「解析参数」：把工作流里所有原始值输入摊成候选，给设置页勾选。
 *
 * 和 analyzeComfyWorkflow 分开：那个是找落点（映射），这个是找可挂参数的输入。
 * API 格式不需要 /object_info（类型按值推断）；UI 格式丢了值，只能先转成 API 格式，
 * 所以要求地址可用——转不了就把原因原样抛给面板显示。
 */
export async function listComfyParams({ base, provider, workflow, signal }) {
  const parsed = parseWorkflow(workflow);
  let graph = parsed.graph;
  if (parsed.format === 'ui') {
    if (!String(base || '').trim()) {
      throw new Error('这是 UI 格式的工作流：解析参数要先把服务地址填好，或者改贴「导出（API）」的 JSON。');
    }
    const info = await comfyObjectInfo(base, provider, signal);
    const converted = uiToApi(parsed.ui, info);
    if (converted.missing.length) {
      throw new Error('工作流里的节点没有安装：' + converted.missing.join('、')
        + '。请在 ComfyUI 里装好它们，或改贴 API 格式的工作流。');
    }
    graph = converted.graph;
  }
  const params = listWorkflowInputs(graph);
  return { format: parsed.format, params: params, count: params.length };
}

/** Protect a bound input even when the workflow parameter is listed under an alias. */
export function isManagedComfyParam(param, mapping, graph) {
  if (PROMPT_ROLE_NAMES.has(param?.name)) return true;
  if (param?.role && COMFY_MANAGED_ROLES.includes(param.name)) return true;
  if (COMFY_MANAGED_ROLES.some((role) => {
    const mapped = mapping?.[role];
    return mapped && String(mapped.node) === String(param?.node) && mapped.input === param?.input;
  })) return true;
  const literal = graph?.[param?.node]?.inputs?.[param?.input];
  if (typeof literal !== 'string') return false;
  const placeholders = workflowPlaceholders(literal);
  return COMFY_MANAGED_ROLES.some((role) => placeholders.has(role));
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
  const placeholders = workflowPlaceholders(raw);
  const activeMapping = mapping && Object.fromEntries(Object.entries(mapping).filter(([role]) => !placeholders.has(role)));
  const values = {
    prompt: input.prompt || '',
    negative_prompt: input.negativePrompt || '',
    negativePrompt: input.negativePrompt || '',
    width, height, seed, model
  };

  if (kind === 'edit') {
    if (!placeholders.has('image') && !activeMapping?.image) {
      throw new Error('这个自定义工作流里既没有 {{image}} 占位符，也没有可用的参考图映射，不能用于图生图；'
        + '请把参考图节点的 image 字段写成 {{image}}，或在模型选项里解析并确认映射。');
    }
    const reference = input.images && input.images[0];
    if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
    values.image = await comfyUploadImage(base, provider, reference, signal);
  }

  if (!placeholders.size && !activeMapping) throw new Error('这个自定义工作流没有注入映射，请先在模型选项里解析并确认。');
  // 占位符必须有值，自动尺寸时使用和内置工作流一致的默认。映射仍可保留原图中的数值。
  let out = placeholders.size ? applyWorkflowTemplate(graph, { ...values, width: width ?? 1024, height: height ?? 1024 }) : graph;
  if (activeMapping && Object.values(activeMapping).some(Boolean)) out = injectByMapping(out, activeMapping, values).graph;

  // 对话模型塞进来的可调参数：认得的写进去，认不得的记下来告诉它。
  // 只认带节点落点的行（HTTP 参数行属于通用路径，不该在这里被当成工作流参数）；
  // 映射和占位符已经由顶层选项写入，离散参数不能再次覆盖同一个节点输入。
  const declared = (entry && Array.isArray(entry.params) ? entry.params : [])
    .filter((param) => param && param.node && param.input && !isManagedComfyParam(param, activeMapping, graph));
  const overrides = input && input.params && typeof input.params === 'object' ? input.params : null;
  if (overrides) {
    const exposed = new Map(declared.map((param) => [param.name, param.expose === true || entry?.expose?.[param.name] === true]));
    const allowed = Object.fromEntries(Object.entries(overrides).filter(([name]) => exposed.get(name)));
    const tuned = applyWorkflowParams(out, declared, allowed);
    const ignored = Object.keys(overrides).filter((name) => !exposed.get(name)).concat(tuned.ignored);
    const note = ignored.length
      ? '这些参数当前模型不支持或取值无效，已忽略：' + ignored.join('、')
      : '';
    return { graph: tuned.graph, note };
  }
  return { graph: out, note: '' };
}

/**
 * A1111 的采样参数：字段名 / 类型 / 建议默认值。
 *
 * 这份清单同时是三样东西的种子：
 *   - 设置页第一次展开某个模型时，往离散参数表里塞的行（客户端按这张表生成行，
 *     描述文案是 i18n 的，留在客户端）；
 *   - 老配置（只有 expose 开关表、没有 params 行）的兜底清单；
 *   - 协议自己拼 body 时，哪些字段算「采样参数」。
 *
 * type 用参数表的四个值（text / number / boolean / enum），和工作流行的类型词表一致。
 */
export const A1111_PARAMS = [
  { name: 'steps', type: 'number', default: '20' },
  { name: 'cfg_scale', type: 'number', default: '7' },
  { name: 'sampler_name', type: 'text', default: 'euler' },
  { name: 'scheduler', type: 'text', default: 'normal' },
  { name: 'seed', type: 'number', default: '-1' },
  { name: 'denoising_strength', type: 'number', default: '0.6' }
];

/** 只有图生图才认的参数。 */
const A1111_EDIT_ONLY = new Set(['denoising_strength']);

/** 这些字段由 execute() 自己决定，参数表里的同名行不许覆盖（尺寸/提示词/参考图三块不许动）。 */
const A1111_RESERVED = new Set(['prompt', 'negative_prompt', 'width', 'height', 'batch_size', 'n_iter', 'init_images', 'override_settings']);

/**
 * 某个模型的 A1111 参数行。
 *
 * 新配置直接读离散参数表的行（HTTP 行，name 就是 sdapi 字段名）；老配置没有行，
 * 就用内置清单 + `expose` 开关表兜底——这时默认值是空的，等价于「不勾选就沿用
 * WebUI 的设置」，升级不会凭空开始发参数。
 */
export function a1111ParamRows(provider, model) {
  const rows = paramTableOf(provider, model);
  if (rows.length) return rows;
  const options = provider && provider.modelOptions;
  const entry = options && typeof options === 'object' ? options[String(model || '')] : null;
  const expose = entry && entry.expose && typeof entry.expose === 'object' ? entry.expose : null;
  return A1111_PARAMS.map((param) => ({
    name: param.name, type: param.type, default: '',
    expose: expose ? expose[param.name] === true : false
  }));
}

/**
 * 把参数表的行写进 A1111 的请求体。
 *
 * 和通用路径同一套规矩：默认值非空就写、`expose: true` 的行允许这次调用用 input.params
 * 覆盖。区别是尺寸/提示词/参考图那几项由 execute 自己放，行里有同名也跳过。
 * @returns {{ applied: string[], ignored: string[] }} ignored 是这次没写进去的调用方键
 */
function applyA1111Rows(body, provider, model, input, kind) {
  const table = a1111ParamRows(provider, model);
  const params = input && input.params && typeof input.params === 'object' && !Array.isArray(input.params)
    ? input.params
    : null;
  const accepted = new Set();
  for (const row of table) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const [root, child] = name.split('.').map((part) => part.trim()).filter(Boolean);
    if (A1111_RESERVED.has(root) && (root !== 'override_settings' || !child || child === 'sd_model_checkpoint')) continue;
    if (kind !== 'edit' && A1111_EDIT_ONLY.has(name)) continue;
    const fallback = String(row.default === undefined || row.default === null ? '' : row.default).trim();
    let raw = fallback;
    let present = fallback !== '';
    let overridden = false;
    if (row.expose === true && params && Object.prototype.hasOwnProperty.call(params, name)) {
      const given = params[name];
      if (given !== undefined && given !== null) { raw = given; present = true; overridden = true; }
    }
    if (!present) continue;
    const value = paramValueOf(row.type, raw, row.options);
    if (value === undefined) continue;
    mergeFields(body, fieldPatch(name, value));
    if (overridden) accepted.add(name);
  }
  const ignored = Object.keys(params || {}).filter((name) => !accepted.has(name));
  return { applied: [...accepted], ignored: ignored };
}

/* ------------------------------------------------ 协议级选项（合并后的差异） */

/**
 * 协议级选项的规范表：`name → { values, default }`，`values[0]` 就是默认值。
 *
 * 选项存在 `provider.protocolOptions` 里；**没写 = 默认值**，所以老配置（这个字段
 * 还不存在）行为不变，新配置也只存「与默认不同」的那几项。
 *
 * 这是「协议收敛」的落点：合并前的 dall-e-3 / gpt-image / together / localai /
 * siliconflow / volcengine-ark / azure-openai / xai-imagine / zhipu 地址与组装完全一样，
 * 差异只有编辑端点与鉴权头，现在由这里表达，不再各占一条协议 id。
 *
 * 只剩 `edit` 是协议属性。**鉴权方式不在这里**：它是提供商自己的字段（`provider.auth`，
 * 见 lib/adapter-kit.js 的 AUTH_MODES / authSpecOf），因为「这个地址怎么认证」与
 * 「说哪种协议」是两件事——切到 ComfyUI / 百炼 / Gemini 时鉴权照样要能设。
 */
export const PROTOCOL_OPTIONS = {
  'openai-images': {
    // 编辑走哪里：/images/edits、同一个 generations、或者没有编辑。
    edit: {
      values: ['edits', 'same', 'none'],
      default: 'edits',
      // 这个选项会改掉显示用的 edit 地址，客户端按当前取值算真实地址。
      routes: (base, value) => Object.assign({}, base, { edit: EDIT_MODES[value].routes.edit })
    }
  }
};

/** 编辑端点的三种形态：地址 / 传输编码 / 参考图字段。 */
const EDIT_MODES = {
  edits: { endpoints: { edit: '/images/edits' }, routes: { edit: '/images/edits' }, transport: { edit: 'multipart' }, editFields: ['image[]', 'image'] },
  same: { endpoints: { edit: '/images/generations' }, routes: { edit: '/images/generations' }, transport: { edit: 'json' }, editFields: ['image'] },
  none: { endpoints: { edit: '' }, routes: { edit: '' }, transport: { edit: 'json' }, editFields: [] }
};

/**
 * 只留规范表里认得的选项名与取值。返回的是「显式写下来的」那几项：
 * 与默认值相同的也留着（用户点过就是点过），空对象表示全走默认。
 */
export function normalizeProtocolOptions(adapterId, raw) {
  const schema = PROTOCOL_OPTIONS[String(adapterId || '').trim().toLowerCase()];
  if (!schema) return {};
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [name, spec] of Object.entries(schema)) {
    const value = String(source[name] || '').trim().toLowerCase();
    if (spec.values.includes(value)) out[name] = value;
  }
  return out;
}

/**
 * 已知的 **OpenAI 兼容**主机：一张表两处用，别维护两份。
 *
 *   1. `protocolOptionsOf()`：老配置没有显式 `protocolOptions` 时，按主机补默认值
 *      （together 只有 generations、方舟的编辑也在 generations 上、Azure 只认 api-key）；
 *   2. `detectProtocolStart()`：这些地址**不用探测**就知道是 `openai-images`。
 *      合并之后 `openai-images` 既是识别结果又是兜底，只看「有没有匹配到具体协议」会把
 *      它误判成「没认出来」，于是去 GET /models —— 方舟的 /api/plan/v3/models 大概率 404，
 *      一个本来就能用的地址就被切成「自定义」了。
 *
 * `options` 是该主机的协议级选项默认值（与 PROTOCOL_OPTIONS 同一套取值），识别成功时
 * 一并回给客户端，避免「协议对了、选项还是默认」。
 *
 * 只收「确定性够高」的主机：官方端点、内置预设里的 OpenAI 兼容网关。中转站/自建网关
 * 仍然走 GET /models 的兜底，因为它们的主机名无法事先枚举。
 */
const KNOWN_OPENAI_HOSTS = [
  // OpenAI 官方（gpt-image / dall-e 由模型规则再收窄）。
  { host: /(^|\.)api\.openai\.com$/, options: {} },
  // Azure OpenAI：鉴权是 api-key，路径与官方一致。鉴权形态不再进 options——它是
  // provider.auth 的默认值，识别协议时由 detectProtocolStart() 单独带回去。
  {
    host: /(^|\.)openai\.azure\.com$|(^|\.)services\.ai\.azure\.com$/,
    path: /^(?!\/mai\/v1(?:\/|$))/i,
    options: {},
    auth: 'api-key'
  },
  // Together：只有 /images/generations。
  { host: /(^|\.)api\.together\.xyz$/, options: { edit: 'none' } },
  // 硅基流动：编辑走同一个 generations。
  { host: /(^|\.)api\.siliconflow\.cn$/, options: { edit: 'same' } },
  // 火山方舟：ark.*.volces.com（含 /api/v3 与 /api/plan/v3 两个入口），编辑也在 generations。
  { host: /(^|\.)volces\.com$/, options: { edit: 'same' } },
  // xAI Grok Imagine：只有 /images/generations，没有原生编辑。
  { host: /(^|\.)api\.x\.ai$/, options: { edit: 'none' } },
  // 智谱 BigModel：形状像 OpenAI，同样只有 /images/generations。
  { host: /(^|\.)bigmodel\.cn$/, options: { edit: 'none' } },
  // MiniMax：国际站 .io 与中国站 .cn 是同一套 OpenAI Images 形状的接口，
  // 编辑端点、鉴权头都是默认值，所以 options 是空对象。
  // 登记在这里主要是让「自动检测」不发探测请求——MiniMax 的 /v1/models 要鉴权，
  // 没贴 Key 时探回来是 401，会被当成"这个地址不像任何协议"。
  { host: /(^|\.)api\.minimax\.io$|(^|\.)api\.minimax\.cn$/, options: {} },
  // 其余内置的 OpenAI 兼容网关：形状与官方一致。
  { host: /(^|\.)api\.deepseek\.com$/, options: {} }
];

/** 地址命中哪条已知主机；认不出返回 null。 */
function knownOpenAiHostOf(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch (_error) { return null; }
  const host = url.host.toLowerCase();
  const known = KNOWN_OPENAI_HOSTS.find((entry) => entry.host.test(host) && (!entry.path || entry.path.test(url.pathname)));
  if (known) return known;
  const preset = OPENAI_PRESETS_BY_HOST.get(host);
  return preset ? { options: preset.protocolOptions || {}, auth: preset.auth } : null;
}

/**
 * provider 上当前生效的协议选项。
 *
 * `adapterId` 是**解析出来的**协议 id（不是 provider.adapter）：老配置里很多提供商的
 * adapter 是空串（靠主机自动识别），那些也要拿到按主机给的默认值。
 *
 * 三层：显式写下来的 > 已知主机给的默认（KNOWN_OPENAI_HOSTS）> 协议默认值。
 * 主机默认是「这条协议在这个地址上的脾气」：Azure 只认 api-key、Together 没有编辑端点。
 * 少了这一层，一条手填 azure 地址的老配置会从 api-key 悄悄退回 Bearer。
 */
export function protocolOptionsOf(provider, adapterId) {
  const id = String(adapterId === undefined ? (provider && provider.adapter) : adapterId)
    .trim().toLowerCase();
  const schema = PROTOCOL_OPTIONS[id];
  if (!schema) return {};
  const chosen = normalizeProtocolOptions(id, provider && provider.protocolOptions);
  const known = knownOpenAiHostOf(provider && provider.baseUrl);
  const hostDefaults = known && known.options && typeof known.options === 'object' ? known.options : {};
  for (const [name, value] of Object.entries(hostDefaults)) {
    if (chosen[name] !== undefined) continue;
    if (!schema[name] || !Array.isArray(schema[name].values) || !schema[name].values.includes(value)) continue;
    chosen[name] = value;
  }
  return chosen;
}

/** 把选项落到适配器上：返回按选项改写过端点/传输/参考图字段/鉴权的副本。 */
function withProtocolOptions(adapter, provider) {
  const schema = PROTOCOL_OPTIONS[adapter.id];
  if (!schema) return adapter;
  const chosen = protocolOptionsOf(provider, adapter.id);
  // 这条协议在某台已知主机上的默认鉴权形态（Azure 只认 api-key）：它只是适配器上的
  // **默认值**——provider.auth 没设时 authHeaders 才会用到它。
  const known = knownOpenAiHostOf(provider && provider.baseUrl);
  const authDefault = typeof known?.auth === 'string' ? known.auth : normalizeAuthSpec(known?.auth);
  if (!Object.keys(chosen).length && !authDefault) return adapter;
  const next = Object.assign({}, adapter, {
    endpoints: Object.assign({}, adapter.endpoints),
    routes: Object.assign({}, adapter.routes),
    transport: Object.assign({}, adapter.transport)
  });
  if (Object.keys(chosen).length) next.protocolOptions = chosen;
  if (chosen.edit && EDIT_MODES[chosen.edit]) {
    const mode = EDIT_MODES[chosen.edit];
    next.endpoints.edit = mode.endpoints.edit;
    next.routes.edit = mode.routes.edit;
    next.transport.edit = mode.transport.edit;
    next.editFields = mode.editFields.slice();
  }
  if (typeof authDefault === 'string') next.authHeader = authDefault;
  else if (authDefault) next.defaultAuth = authDefault;
  return next;
}

/**
 * 合并前的协议 id → 合并后的协议 + 选项。
 *
 * 只用于**读老配置**：老版本把这几条写成不同的 adapter / protocol，
 * 升级后要能原样继续跑（`normalizeConfig` 会按它改写一次并落盘）。
 * 新写入的配置一律是 `openai-images`，项目里没有第二个消费者。
 */
export const LEGACY_PROTOCOL_ALIASES = {
  'dall-e-3': { adapter: 'openai-images', protocolOptions: {} },
  'gpt-image': { adapter: 'openai-images', protocolOptions: {} },
  together: { adapter: 'openai-images', protocolOptions: { edit: 'none' } },
  localai: { adapter: 'openai-images', protocolOptions: { edit: 'none' } },
  siliconflow: { adapter: 'openai-images', protocolOptions: { edit: 'same' } },
  'volcengine-ark': { adapter: 'openai-images', protocolOptions: { edit: 'same' } },
  // Azure 与官方只差鉴权头形态（api-key 而不是 Bearer）：地址三元组、传输方式、字段模板
  // 全都与 openai-images 一致，所以它是「同一条协议 + 一个 provider.auth」，不单独占一条协议。
  // 注意 auth 落在 `auth` 而不是 protocolOptions：鉴权是提供商字段（见 AUTH_MODES）。
  'azure-openai': { adapter: 'openai-images', protocolOptions: {}, auth: { mode: 'api-key' } },
  // xAI / 智谱：地址三元组（generations / 无编辑 / models）与 OpenAI Images 完全一样，
  // 请求体也全是声明式的——xai 的 response_format 在 CONSTANT_RULES、resolution 在
  // SIZE_RULES.second、字段在 FIELD_RULES；智谱的 body 本来就和通用 composeBody 一致。
  // 差别只剩「没有编辑端点」，所以是 { edit: 'none' }。
  'xai-imagine': { adapter: 'openai-images', protocolOptions: { edit: 'none' } },
  zhipu: { adapter: 'openai-images', protocolOptions: { edit: 'none' } }
};

/**
 * 把老协议 id 换成合并后的写法；已经是新值就原样返回（幂等）。
 * 显式写下来的选项优先于迁移表给的（那是用户的选择，别覆盖）。
 *
 * 迁移表里的 `auth` 落到 `providers[].auth`（迁移前的协议级 `auth` 选项也是这么读的）：
 * 老配置升级上来时「Azure 用 api-key」这条信息不能丢，只是换了存放位置。
 */
export function upgradeLegacyProtocol(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  const aliased = (value) => {
    const id = String(value || '').trim().toLowerCase();
    return LEGACY_PROTOCOL_ALIASES[id] || null;
  };
  const byAdapter = aliased(provider.adapter);
  const byProtocol = aliased(provider.protocol);
  if (!byAdapter && !byProtocol) return provider;
  const target = byAdapter || byProtocol;
  const next = Object.assign({}, provider, { adapter: target.adapter });
  // protocol 只在它自己就是老 id 时才改写：正常配置里这一栏是 openai-images / custom。
  if (byProtocol) next.protocol = byProtocol.adapter;
  const merged = Object.assign({}, target.protocolOptions, normalizeProtocolOptions(target.adapter, provider.protocolOptions));
  if (Object.keys(merged).length) next.protocolOptions = merged;
  // 鉴权默认值：provider.auth 显式写过就不动；老配置里的 protocolOptions.auth
  // （用户在旧面板里点过的 api-key）比迁移表更贴近用户意图，排在它前面。
  if (target.auth && !next.auth) {
    const legacy = normalizeAuthSpec({ mode: provider.protocolOptions && provider.protocolOptions.auth });
    next.auth = legacy || Object.assign({}, target.auth);
  }
  return next;
}

/* ------------------------------------------------ 协议选择的唯一判据 */

/**
 * `protocol` 里那些「说不出具体协议」的值：它们的意思是「看 adapter」。
 *
 * `openai-images` 曾经是一条真协议（现在它是通用兼容那一档），但它也是老客户端给
 * 所有提供商无条件写的默认值——所以它**不是**「用户选过协议」的证据。
 */
const GENERIC_PROTOCOL_IDS = new Set(['', 'auto', 'images', 'openai-images']);

/**
 * `protocol` 里的具体协议 id；`openai-images` / `auto` / `images` 这类回空。
 *
 * 老配置把协议 id 记在 `protocol` 一栏（和 adapter 是同一个 id 空间），读取时用它补
 * adapter，见 normalizeConfig。「自定义」也认（它不在 ADAPTERS 里）。
 */
export function concreteProtocolId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (GENERIC_PROTOCOL_IDS.has(id)) return '';
  if (id === 'custom') return 'custom';
  return ADAPTERS.some((adapter) => adapter.id === id) ? id : '';
}

/**
 * 这个提供商究竟选了哪条协议；没选返回 ''（设置页里显示「未选择」）。
 *
 * **adapter 是唯一凭据**，`protocol` 里留着的具体 id 也算（那是真的选过）。返回 '' 时
 * 调用方不该发请求：路径、字段名和响应解析全由协议决定，猜一个只会把请求发错
 * （以前是拿协议表的最后一条 openai-images 兜底，而界面写着「自动」）。
 */
export function selectedProtocolOf(provider) {
  const upgraded = upgradeLegacyProtocol(provider || {});
  const adapter = String(upgraded.adapter || '').trim().toLowerCase();
  if (adapter) return adapter;
  return concreteProtocolId(upgraded.protocol);
}

/* ------------------------------- 通用网关（openai-images）的输出候选列表 */
/*
 * 一条 OpenAI 兼容网关的提交响应可能是四样东西，**顺序就是行为**：
 *   1. 直接出图（`data[0].url` / `data[0].b64_json`）；
 *   2. 任务包络（`task_id` / `polling_url` / `urls.get` …）；
 *   3. 202/302 + `Location`（没有任务体）；
 *   4. 都不是时，任意位置的图片（`decodeImagePayload` 的三轮扫描）。
 *
 * 迁移前这四步写死在 `image-execution.js` 的 `if (adapter.autoAsync)` 里；现在全在数据里。
 * 下面的键表与顺序**照抄** `adapter-kit.js` 的原常量，一个都没改；改动顺序就是行为变更。
 */

/** 任务包络的探测层：迁移前 taskNodes() 的访问顺序（顶层 → data → output → result）。 */
const TASK_NODE_PREFIXES = ['', 'data.', 'output.', 'result.'];
/** 键优先于层级：`data.task_id` 压过顶层的 `id`。 */
const taskPaths = (keys, suffixes) => keys.flatMap((key) => TASK_NODE_PREFIXES.flatMap(
  (prefix) => (suffixes || ['']).map((suffix) => prefix + key + suffix)
));

const GENERIC_TASK_ID_KEYS = [
  'task_id', 'taskId', 'job_id', 'jobId', 'request_id', 'requestId',
  'generation_id', 'generationId', 'prediction_id', 'predictionId', 'id'
];
const GENERIC_TASK_URL_KEYS = [
  'polling_url', 'pollingUrl', 'poll_url', 'pollUrl', 'status_url', 'statusUrl',
  'task_url', 'taskUrl', 'get_url', 'getUrl', 'result_url', 'resultUrl'
];
const GENERIC_STATUS_KEYS = ['task_status', 'taskStatus', 'status', 'state'];
const GENERIC_RESULT_KEYS = [
  'output_images', 'outputImages', 'images', 'image_urls', 'data', 'outputs', 'output',
  'result', 'results', 'artifacts', 'files', 'url', 'image_url', 'imageUrl', 'b64_json', 'base64', 'image'
];
const GENERIC_ERROR_KEYS = ['error', 'errors', 'fail_reason', 'error_message'];
const GENERIC_MESSAGE_KEYS = GENERIC_ERROR_KEYS.concat(['message', 'msg', 'detail', 'logs', 'reason']);
// 迁移前是三个 Set：成功 9 个词、失败 9 个词（比较时统一大写）。
const GENERIC_SUCCESS_WORDS = [
  'SUCCEED', 'SUCCEEDED', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'DONE', 'FINISHED', 'READY'
];
const GENERIC_FAILURE_WORDS = [
  'FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'ABORTED', 'REJECTED', 'EXPIRED', 'MODERATED'
];

/**
 * 读轮询载荷的那一半（状态词 / 失败文案 / 结果图 / 退避），两条任务候选共用。
 * 包络从哪来（响应体 vs Location 头）不影响怎么读它。
 */
const GENERIC_TASK_READING = {
  // 状态词：键优先序 = task_status → taskStatus → status → state；每个键先看标量，
  // 再看它自己的 .status / .state（迁移前 statusTextOf 的嵌套分支）。
  statusPath: taskPaths(GENERIC_STATUS_KEYS, ['', '.status', '.state']),
  success: GENERIC_SUCCESS_WORDS.slice(),
  failure: GENERIC_FAILURE_WORDS.slice(),
  // 没有状态词但带错误字段也算失败（迁移前 taskErrorOf 的那条判断）。
  errorPath: taskPaths(GENERIC_ERROR_KEYS),
  // 失败文案：先错误字段，再 message / msg / detail / logs / reason，逐层深挖。
  failureMessagePath: taskPaths(GENERIC_MESSAGE_KEYS),
  // 结果字段：键表顺序（url 在 b64_json 之前），按层展开；最后 scan 兜底。
  resultPath: taskPaths(GENERIC_RESULT_KEYS),
  scan: true,
  intervalMs: 2000,
  timeoutMs: 300000,
  maxBytes: 32 * 1024 * 1024,
  emptyMessage: '生图接口没有返回图片'
};

/**
 * `openai-images` 的输出候选列表。**这不是「几种写法」，是一份判定顺序**：
 * 先认现成的图，再认任务包络，再认 Location，最后才是「随便哪儿找一张」。
 *
 * 两处与直觉不同的地方（都是迁移前的事实，不是笔误）：
 *   - 第一项**没有** `scan`：`scan` 一旦提前，带任务包络的响应里只要有个图片链接就会被当成
 *     最终结果，轮询再也不会发生（`generic-async` 的「顶层 url 不是图片要退回轮询」就是这条）；
 *   - `pick` 里 url 在 b64_json **之前**：同一份 `data[0]` 两样都有时，迁移前选的是 url
 *     （`taskImageOf` 的键表顺序），不是 base64（`decodeImagePayload` 的扫描顺序）。
 */
const GENERIC_GATEWAY_OUTPUT = outputProfiles([
  {
    kind: 'json',
    pick: [{ path: 'data.0.url', as: 'url' }, { path: 'data.0.b64_json', as: 'base64' }],
    maxBytes: 32 * 1024 * 1024,
    emptyMessage: '生图接口没有返回图片'
  },
  {
    kind: 'task',
    // 轮询地址的三种来源按「响应里给的 → 按 id 拼」排；派生规则的三条顺序照抄 taskPollUrls()。
    idPath: taskPaths(GENERIC_TASK_ID_KEYS),
    pollUrlPath: taskPaths(GENERIC_TASK_URL_KEYS.concat(['urls.get'])),
    path: ['{root}/v1/tasks/{taskId}', '/tasks/{taskId}', '{submitUrl}/{taskId}'],
    ...GENERIC_TASK_READING
  },
  {
    kind: 'task',
    // 202 + Location：任务体是空的，地址只在响应头里。放在包络之后、兜底扫描之前——
    // 迁移前就是这个顺序（先认包络，再认 Location，最后才扫描）。
    pollUrlFrom: 'location',
    ...GENERIC_TASK_READING
  },
  {
    kind: 'json',
    scan: true,
    maxBytes: 32 * 1024 * 1024,
    emptyMessage: '生图接口没有返回图片'
  }
], 'openai-images');

const STABILITY_CORE_PATH = '/v2beta/stable-image/generate/core';
const STABILITY_SD3_PATH = '/v2beta/stable-image/generate/sd3';

const ADAPTERS = [
  {
    id: 'google-gemini',
    label: 'protocol.google-gemini',
    match: (provider) => hostOfBase(provider?.baseUrl) === 'generativelanguage.googleapis.com',
    local: false,
    endpoints: { generate: '/models', edit: '/models' },
    routes: { generate: '/models/{model}:generateContent', edit: '/models/{model}:generateContent', models: '/models' },
    transport: { generate: 'json', edit: 'json' },
    defaultAuth: { mode: 'custom', header: 'x-goog-api-key' },
    acceptsHttpParams: true,
    // 输出格式描述符：图片在 candidates.0.content.parts[]，读法有四条不能丢的细节：
    //   1. **逆序**扫：thinking 模型把草图放在前面，结果在后面（`select:'last'`）；
    //   2. 跳过 `thought === true`（`notEquals` 而不是 `equals:false`：没有 thought 字段的 part
    //      必须保留，迁移前就是 `part.thought === true` 才跳）；
    //   3. `inlineData` / `inline_data` 是**按 part 交错**判定的（一个 pick 里的 `any`），
    //      拆成两条候选会变成「先全表驼峰、再全表蛇形」，选出的 part 会不一样；
    //   4. contentType 取同级的 mimeType / mime_type，缺失时按字节签名兜底（`contentTypePath`）。
    output: outputProfile({
      kind: 'json',
      pick: [{
        path: 'candidates.0.content.parts[]',
        as: 'base64',
        select: 'last',
        where: [{ path: 'thought', notEquals: true }],
        any: ['inlineData.data', 'inline_data.data'],
        contentTypePath: ['inlineData.mimeType', 'inline_data.mime_type']
      }],
      maxBytes: 48 * 1024 * 1024,
      emptyMessage: 'Gemini 没有返回图片',
      // 迁移前的报错会带 finishReason（有才带）：描述符只声明「从哪读、怎么标」。
      emptyDetail: { path: 'candidates.0.finishReason', label: 'finishReason' }
    }, 'google-gemini'),
    maxN: 1,
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await requestProvider(joinEndpoint(baseUrlOf(provider), '/models?pageSize=1000'), {
        headers: headersFor(provider, false, null, this), signal
      }, provider, this);
      const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider, this);
      return (payload.models || [])
        .filter((item) => {
          const methods = item.supportedGenerationMethods;
          if (Array.isArray(methods) && !methods.includes('generateContent')) return false;
          const name = String(item.name || '');
          return isGeminiImageModel(name) && !/imagen/i.test(name);
        })
        .map((item) => {
          const id = String(item.name || '').replace(/^models\//, '');
          const display = String(item.displayName || '').trim();
          return { id: id, name: display && display !== id ? display : '' };
        })
        .filter((entry) => entry.id)
        .slice(0, 100);
    },
    async execute(kind, provider, input, signal, hooks) {
      const model = String(input.model || '').replace(/^models\//, '').trim();
      if (!model) throw new Error('Gemini 模型 ID 不能为空');
      const images = input.images || [];
      const is25 = GEMINI_25_IMAGE.test(model);
      const referenceLimit = is25 ? 3 : 14;
      if (images.length > referenceLimit) {
        throw new Error('Gemini 一次最多 ' + referenceLimit + ' 张参考图（该模型上限）');
      }
      // 字段名来自模板（用户覆盖 > 模型规则 > 预设）：提示词追加到 contents[0].parts[] 并包成
      // { text }，负面词拼不拼进提示词也由模板说（预设与规则里是 appendToPrompt: '\n\nAvoid: '）。
      // 参考图是 { inlineData: { mimeType, data } } 这种带额外键的对象，六种能力表达不了，
      // 留在协议里（红线见设计文档「字段模板」）；模型名在 URL 的 :generateContent 前，张数固定 1。
      const fields = fieldsFor(this, provider, model);
      const body = { contents: [{ role: 'user', parts: [] }] };
      for (const image of images) {
        if (!image || !image.buffer) continue;
        body.contents[0].parts.push({
          inlineData: {
            mimeType: image.contentType || 'image/png',
            data: image.buffer.toString('base64')
          }
        });
      }
      // 没给负面词时按「不发这个字段」处理：空串不该把 '\n\nAvoid: ' 粘到提示词尾巴上。
      const folded = promptParts(fields, { prompt: input.prompt, negative: input.negativePrompt || undefined });
      applyFields(body, fields, { prompt: folded.prompt });
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
      body.generationConfig = generationConfig;
      return executeBuiltImage(kind, this, provider, input, '/models/' + encodeURIComponent(model) + ':generateContent', body, signal, {
        protectedPaths: ['generationConfig.imageConfig.aspectRatio', 'generationConfig.imageConfig.imageSize']
      }, hooks);
    }
  },
  {
    id: 'recraft',
    label: 'protocol.recraft',
    match: (provider) => /external\.api\.recraft\.ai/i.test(String((provider && provider.baseUrl) || '')),
    local: false,
    endpoints: { generate: '/images/generations', edit: '/images/imageToImage' },
    routes: { generate: '/images/generations', edit: '/images/imageToImage', models: '' },
    transport: { generate: 'json', edit: 'multipart' },
    editFields: ['image'],
    editExtras: { strength: 0.5 },
    acceptsHttpParams: true,
    // 输出格式描述符：今天就是 decodeImagePayload 的任意位置扫描（先全表 base64、
    // 再带图片后缀的 URL、再任意 URL），没有一条固定路径可收紧——收紧就是行为变化。
    // 所以这里是「纯兜底」形状：只把体积上限与文案显式写下来。
    // emptyMessage 今天其实到不了（scan 的报错先抛），写它是为了以后关掉 scan 时文案不变。
    output: outputProfile({
      kind: 'json',
      scan: true,
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: 'Recraft 没有返回图片'
    }, 'recraft'),
    maxN: 1,
    forModel(model) {
      if (!/recraftv2(?!\d)|recraftv4_1_flash_v2(?!\d)/i.test(String(model || ''))) return this;
      return { ...this, endpoints: { ...this.endpoints, edit: '' } };
    },
    async listModels() {
      return ['recraftv4_1', 'recraftv4', 'recraftv3', 'recraftv2'];
    },
    async execute(kind, provider, input, signal, hooks) {
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      if (kind === 'edit') {
        const images = input.images || [];
        if (images.length !== 1 || !images[0]?.buffer) throw new Error('Recraft 图生图需要且只接受一张参考图。');
        const body = { model: input.model, prompt, strength: 0.5 };
        applyHttpParams(body, provider, input, { adjustable: ['strength'], protectedPaths: ['image'] });
        const form = formOf(body);
        const image = images[0];
        form.append('image', new Blob([image.buffer], { type: image.contentType }), image.filename);
        return executeBuiltImage(kind, this, provider, input, '/images/imageToImage', form, signal, undefined, hooks);
      }
      const body = { model: input.model, prompt, n: 1, response_format: 'url' };
      if (input.fitted && !input.fitted.omit && input.fitted.size) body.size = input.fitted.size;
      return executeBuiltImage(kind, this, provider, input, '/images/generations', body, signal, { adjustable: ['response_format'] }, hooks);
    }
  },
  {
    id: 'ideogram',
    label: 'protocol.ideogram',
    defaultAuth: { mode: 'custom', header: 'Api-Key' },
    acceptsHttpParams: true,
    match: (provider) => /(^|\.)api\.ideogram\.ai$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]),
    local: false,
    endpoints: { generate: ideogramPath, edit: '' },
    routes: { generate: IDEOGRAM_ROUTE, edit: '', models: '' },
    transport: { generate: 'multipart', edit: 'json' },
    maxN: 1,
    forModel(model) {
      if (!IDEOGRAM_EDIT.test(model)) return this;
      return {
        ...this,
        endpoints: { generate: ideogramPath, edit: ideogramPath },
        routes: { ...this.routes, edit: IDEOGRAM_ROUTE },
        transport: { generate: 'json', edit: 'multipart' },
        operations: { edit: IDEOGRAM_EDIT_OPERATION }
      };
    },
    // 输出格式描述符：两个候选 + 任意位置扫描兜底。
    // 候选顺序照抄 decodeImagePayload 的扫描顺序（先 base64、再 URL）：同一份响应里
    // 两样都有时它选的是 base64，反过来排也能跑，但边角输入会选出不同的图。
    // scan 兜底保留——它现在就是「任意位置扫描」，收紧成 data.0 会变成行为变化。
    output: outputProfile({
      kind: 'json',
      pick: [
        { path: 'data.0.b64_json', as: 'base64' },
        { path: 'data.0.url', as: 'url' }
      ],
      scan: true,
      maxBytes: 32 * 1024 * 1024,
      // 无图时 scan 先抛 decodeImagePayload 自己的两句话；这里显式写下默认值，
      // 免得以后关掉 scan 时文案悄悄变了。
      emptyMessage: '生图接口没有返回图片'
    }, 'ideogram'),
    async listModels() {
      return IDEOGRAM_MODELS.slice();
    },
    async execute(kind, provider, input, signal, hooks) {
      const model = String(input.model || 'ideogram-3');
      if (IDEOGRAM_EDIT.test(model)) return executeIdeogramModern(kind, this, provider, input, signal, hooks);
      if (kind === 'edit') throw new Error('此 Ideogram 模型的原生编辑暂未支持，可选择 Ideogram 4.5 或 4.6。');
      const fitted = input.fitted && !input.fitted.omit ? input.fitted : null;
      const speed = input.quality && input.quality !== 'off'
        ? ({ turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' })[String(input.quality).toLowerCase()]
        : '';
      const isTransparent = /ideogram-4-transparent/i.test(model);
      const is4 = !isTransparent && /ideogram-4/i.test(model);
      // 提示词 / 负面词 / 张数的字段名来自模板（用户覆盖 > 模型规则 > 预设）：ideogram 的张数叫
      // num_images，ideogram-4 的 JSON 体连负面词都没有（模型规则里 negative: null），
      // 两边都不用协议自己判断。模型名进的是路径、参考图不支持编辑，两条模板都是 null。
      //
      // 仍留在协议里的三样，都不是「这家网关把提示词叫什么」：
      //   - rendering_speed：质量字段名由 QUALITY_RULES 给，预设里的 fields.quality 只说明
      //     「收质量」（`{ path: 'quality' }`），取模板名会写成 quality，所以档位映射留在这里；
      //   - aspect_ratio / output_resolution / resolution：尺寸的收发形态，属请求形状；
      //   - 比例用字母 x（16x9）、4 收像素枚举：模型分支，模板不表达条件。
      const fields = fieldsFor(this, provider, model);
      const body = applyFields({}, fields, {
        prompt: String(input.prompt || ''),
        negative: input.negativePrompt || undefined,
        n: 1
      });
      const protectedPaths = ['rendering_speed', 'resolution', 'aspect_ratio', 'output_resolution'];
      if (is4) {
        // ideogram-4 是 JSON，而且只有 resolution（像素枚举），没有 aspect_ratio。
        if (fitted && fitted.size) body.resolution = String(fitted.size);
        if (speed) body.rendering_speed = speed;
        return executeBuiltImage(kind, this, provider, input, ideogramPath(input), body, signal, { protectedPaths }, hooks);
      }
      if (speed) body.rendering_speed = speed;
      if (fitted) {
        const aspect = fitted.aspect || nearestAspect(fitted.width, fitted.height);
        body.aspect_ratio = String(aspect).replace(':', 'x');
        if (isTransparent && fitted.tier) body.output_resolution = String(fitted.tier);
      }
      applyHttpParams(body, provider, input, { protectedPaths });
      return executeBuiltImage(kind, this, provider, input, ideogramPath(input), formOf(body), signal, undefined, hooks);
    }
  },
  {
    id: 'stability',
    label: 'protocol.stability',
    match: (provider, model) => /stability\.ai/i.test(provider.baseUrl || ''),
    endpoints: { generate: STABILITY_CORE_PATH, edit: STABILITY_SD3_PATH },
    routes: { generate: STABILITY_CORE_PATH, edit: STABILITY_SD3_PATH, models: '' },
    transport: { generate: 'multipart', edit: 'multipart' },
    // 这个 `binary: true` 是**请求常量**（protocolConstants 据此发 output_format:'png'），
    // 不是响应读法——响应侧由下面的 output 描述符负责。两者同名但不是同一件事。
    binary: true,
    // 响应体通常是图片字节（application/octet-stream / image/*），但 stability 也允许
    // Accept: application/json 回 `{image:"<base64>"}`；描述符两种都吃，见 readBinaryOutput。
    output: outputProfile({
      kind: 'binary',
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: '生图接口没有返回图片'
    }, 'stability'),
    maxN: 1,
    editFields: ['image'],
    forModel(model) {
      if (!model) return this;
      if (!STABILITY_SD3_MODEL.test(model)) return { ...this, endpoints: { generate: STABILITY_CORE_PATH, edit: '' } };
      return {
        ...this,
        endpoints: { generate: STABILITY_SD3_PATH, edit: STABILITY_SD3_PATH },
        editExtras: { mode: 'image-to-image', strength: 0.5 },
        editDrops: () => ['aspect_ratio'],
        maxEditImages: 1
      };
    }
  },
  ...CN_ADAPTERS,
  {
    // 异步入队型：提交拿 task_id → 轮询到 SUCCEEDED → 下载结果。
    // body 是嵌套结构（input.prompt / parameters.n），由字段模板直接写到位，不再折叠。
    id: 'dashscope-wanx',
    label: 'protocol.dashscope-wanx',
    match: (provider, model) => {
      const host = hostOfBase(provider.baseUrl).replace(/:\d+$/, '');
      if (/^dashscope(?:-intl)?\.aliyuncs\.com$/i.test(host) || /(?:^|[/-])wanx/i.test(model)) return true;
      return /\.maas\.aliyuncs\.com$/i.test(host) && (WAN_26_T2I.test(model) || WAN_27_IMAGE.test(model));
    },
    forModel(model) { return wanMultimodalVariant(this, model); },
    async: true,
    submit: '/services/aigc/text2image/image-synthesis',
    headers: { 'X-DashScope-Async': 'enable' },
    // 输出格式描述符：轮询地址 + 提交响应里的任务 id + 轮询响应里的状态与结果图。
    // 字段名就是原来 poll 里的名字（纯搬运），这一步不改任何解析行为。
    output: outputProfile({
      kind: 'task',
      path: '/tasks/{taskId}',
      idPath: 'output.task_id',
      statusPath: 'output.task_status',
      resultPath: 'output.results',
      success: ['SUCCEEDED'],
      failure: ['FAILED', 'CANCELED', 'UNKNOWN'],
      intervalMs: 2000,
      // §7.3-11：timeoutMs 现在没有读取方（超时统一由 TOTAL_BUDGET_MS 决定）。
      // 保留原值是「纯搬运」的一部分；把它接上是另一件事，别照抄进后面的协议。
      timeoutMs: 300000,
      // 轮询响应沿用执行器原来的 32MB 上限；无图文案与 decodeImagePayload 的默认一致。
      maxBytes: 32 * 1024 * 1024,
      emptyMessage: '生图接口没有返回图片'
    }, 'dashscope-wanx'),
    endpoints: { generate: '/services/aigc/text2image/image-synthesis', edit: '' },
    routes: { generate: '/services/aigc/text2image/image-synthesis', edit: '', models: '' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 4,
    editFields: []
  },
  {
    id: 'a1111',
    label: 'protocol.a1111',
    match: (provider) => /a1111|forge|sdnext|sd-next|drawthings/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/sdapi/v1/txt2img', edit: '/sdapi/v1/img2img' },
    routes: { generate: '/sdapi/v1/txt2img', edit: '/sdapi/v1/img2img', models: '/sdapi/v1/sd-models' },
    transport: { generate: 'json', edit: 'json' },
    // 输出格式描述符：images[0] 是裸 base64（容忍 data: 前缀，前缀里的类型优先）。
    // 只看第一张——解不出就报错，不会去读 images[1]。
    output: outputProfile({
      kind: 'json',
      pick: [{ path: 'images.0', as: 'base64' }],
      maxBytes: 50 * 1024 * 1024,
      emptyMessage: 'A1111 没有返回图片'
    }, 'a1111'),
    async listModels(provider, signal) {
      const response = await requestProvider(joinEndpoint(baseUrlOf(provider), '/sdapi/v1/sd-models'), {
        headers: headersFor(provider, false), signal
      }, provider, this);
      const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider, this);
      if (!Array.isArray(payload)) return [];
      return payload
        .map((item) => String((item && (item.title || item.model_name || item.name)) || '').trim())
        .filter(Boolean);
    },
    async execute(kind, provider, input, signal, hooks) {
      // 参数表的行先写进去，下面数组体里的核心字段再覆盖一遍：
      // 提示词 / 尺寸 / 张数 / 模型 / 参考图这几样由这里说了算，同名行不许动它们。
      const body = {};
      const tuned = applyA1111Rows(body, provider, input.model, input, kind);
      // 自动尺寸：请求里不带宽高，让 WebUI 用它自己的默认值。
      const size = input.fitted && !input.fitted.omit
        ? { width: input.fitted.width, height: input.fitted.height }
        : {};
      Object.assign(body, {
        prompt: input.prompt,
        negative_prompt: input.negativePrompt || '',
        batch_size: 1,
        n_iter: 1,
        ...size
      });
      if (input.model) (body.override_settings ??= {}).sd_model_checkpoint = input.model;
      let endpoint = '/sdapi/v1/txt2img';
      if (kind === 'edit') {
        const image = input.images && input.images[0];
        if (!image) throw new Error('A1111 编辑需要参考图');
        const dimensions = size.width && size.height ? size : imageDimensions(image.buffer) || {};
        body.init_images = [image.buffer.toString('base64')];
        // 行里没写 denoising_strength 时用 0.6：以前只有 edit 才带上它。
        if (body.denoising_strength === undefined) body.denoising_strength = 0.6;
        body.width = dimensions.width;
        body.height = dimensions.height;
        endpoint = '/sdapi/v1/img2img';
      }
      const note = tuned.ignored.length
        ? '这些参数当前模型不支持或取值无效，已忽略：' + tuned.ignored.join('、')
        : '';
      return executeBuiltImage(kind, this, provider, input, endpoint, body, signal, { note, paramsApplied: true }, hooks);
    }
  },
  {
    id: 'comfyui',
    label: 'protocol.comfyui',
    match: (provider) => /comfyui/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/prompt', edit: '/prompt' },
    routes: { generate: '/prompt', edit: '/prompt', models: '/object_info' },
    transport: { generate: 'json', edit: 'json' },
    async listModels(provider, signal) {
      const options = comfyOptionReader(baseUrlOf(provider), provider, signal);
      const [checkpoints, diffusion] = await Promise.all([
        options('CheckpointLoaderSimple', 'ckpt_name'), options('UNETLoader', 'unet_name')
      ]);
      return Array.from(new Set(checkpoints.concat(diffusion)));
    },
    taskSubmission: true,
    pollNotFoundPending: true,
    pollErrorsAreTerminal: true,
    waitForTaskSuccess: true,
    /**
     * 输出格式描述符：ComfyUI 的两跳 + 运行时动态键 + 「键出现即完成」+ 退避曲线。
     *
     * 迁移前这四样在 `comfySubmitAndWait()` 里写死；现在描述符说明「怎么读」，
     * 只剩「发请求 + 消息文案」留在协议代码里（本地服务的文案是行为的一部分）。
     *
     *   - `idPath` / `path`：`POST /prompt` 拿 `prompt_id` → `GET /history/{promptId}`（第一跳）；
     *   - `dynamicKey`：history 的载荷是 `{<promptId>: {status, outputs}}`，那层键是运行时值；
     *     声明之后 `statusPath` / `resultPath` / `failureMessagePath` 都**相对那一层**算；
     *   - `completeWhen:'key'`：没有状态词可等——那一层键出现就已经完成（`{}` 就是还没好，
     *     轮询里 404 也是还没好）；`failure:['error']` 只用来把「完成了但执行失败」认出来；
     *   - `resultPath`：`outputs.<节点>.images[0]`——节点号是工作流生成的，`*` 表示每个值；
     *   - `thenUrl`：结果不是 URL，是 `{filename, subfolder, type}` 三个字段拼出来的
     *     `/view?…`（第二跳）；查询串走 URLSearchParams，缺 subfolder 保留空值、缺 type 退 output。
     */
    output: outputProfile({
      kind: 'task',
      idPath: 'prompt_id',
      path: '/history/{taskId}',
      completeWhen: 'key',
      dynamicKey: { from: 'taskId' },
      statusPath: 'status.status_str',
      // 完成与否不看状态词（见 completeWhen）；这里只认「执行失败」那一个词。
      success: [],
      failure: ['error'],
      failureMessagePath: [
        'status.messages.*.1.exception_message',
        'status.messages.*.1.exception_type'
      ],
      resultPath: 'outputs.*.images.0',
      thenUrl: {
        template: '/view?filename={filename}&subfolder={subfolder}&type={type}',
        // 迁移前是 `image.subfolder || ''` / `image.type || 'output'`。
        defaults: { subfolder: '', type: 'output' }
      },
      // 1s 起步、每次 ×1.15～1.3、5s 封顶（迁移前这里是 COMFY_POLL_* + nextComfyPollDelay）。
      backoff: { startMs: 1000, maxMs: 5000, jitter: true },
      // 超时仍是 5 分钟（本地队列可能排很久），由 comfyui 的驱动读取。
      timeoutMs: 300000,
      // 迁移前 readJsonResponse(poll, 10MB)。
      maxBytes: 10 * 1024 * 1024,
      emptyMessage: 'ComfyUI 没有返回图片'
    }, 'comfyui'),
    async execute(kind, provider, input, signal, hooks) {
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
        return comfySubmitAndWait(provider, this, kind, input, built.graph, signal, hooks, built.note);
      }
      const options = comfyOptionReader(base, provider, signal);
      const diffusionModels = await options('UNETLoader', 'unet_name');
      let workflow;
      if (diffusionModels.includes(model) && /moss/i.test(model)) {
        workflow = kind === 'edit'
          ? await comfyMossEditWorkflow(base, provider, { input, model, seed, signal, options })
          : await comfyMossWorkflow({ input, model, width: builtinWidth, height: builtinHeight, seed, options });
      } else if (diffusionModels.includes(model)) {
        workflow = await comfyFluxWorkflow(base, provider, {
          kind, input, model, width: builtinWidth, height: builtinHeight, seed, signal, options
        });
      } else {
        let imageName = null;
        if (kind === 'edit') {
          const reference = input.images && input.images[0];
          if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
          imageName = await comfyUploadImage(base, provider, reference, signal);
        }
        workflow = comfyCheckpointWorkflow({ kind, input, model, width: builtinWidth, height: builtinHeight, seed, imageName });
      }
      return comfySubmitAndWait(provider, this, kind, input, workflow, signal, hooks);
    }
  },
  {
    id: 'swarmui',
    label: 'protocol.swarmui',
    match: (provider) => /swarmui/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/API/GenerateText2Image', edit: '' },
    routes: { generate: '/API/GenerateText2Image', edit: '', models: '/API/ListModels' },
    transport: { generate: 'json', edit: 'json' },
    acceptsHttpParams: true,
    // 输出格式描述符：images.0 的三条分支（data URL / 绝对 URL / 相对路径）用有序级联表达，
    // 顺序就是迁移前 if/else 的顺序；相对路径由 readOutput 的 baseUrl 拼到 provider 站点根上。
    output: outputProfile({
      kind: 'json',
      from: [
        { path: 'images.0', as: 'dataUrl' },
        { path: 'images.0', as: 'url' },
        { path: 'images.0', as: 'relative' }
      ],
      maxBytes: 5 * 1024 * 1024,
      emptyMessage: 'SwarmUI 没有返回图片'
    }, 'swarmui'),
    async newSession(provider, signal) {
      const payload = await readJsonResponse(await requestProvider(joinEndpoint(baseUrlOf(provider), '/API/GetNewSession'), {
        method: 'POST', headers: headersFor(provider, false), body: '{}', signal
      }, provider, this), 2 * 1024 * 1024);
      const session = payload && payload.session_id;
      if (!session) throw localizedError(new Error('SwarmUI 没有返回 session_id'), 'upstream.invalidResponse', { service: 'SwarmUI', field: 'session_id' });
      return session;
    },
    async listModels(provider, signal) {
      const session = await this.newSession(provider, signal);
      const payload = await readJsonResponse(await requestProvider(joinEndpoint(baseUrlOf(provider), '/API/ListModels'), {
        method: 'POST', headers: headersFor(provider, false),
        body: JSON.stringify({ session_id: session, path: '', depth: 2, subtype: 'Stable-Diffusion' }), signal
      }, provider, this), 5 * 1024 * 1024);
      const files = payload && Array.isArray(payload.files) ? payload.files : [];
      return files.map((item) => String((item && (item.name || item.id)) || '').trim()).filter(Boolean);
    },
    async execute(kind, provider, input, signal, hooks) {
      if (kind === 'edit') throw new Error('SwarmUI 原生编辑暂未支持；请改用支持 /images/edits 的 OpenAI 兼容网关');
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
      return executeBuiltImage(kind, this, provider, input, '/API/GenerateText2Image', body, signal, {
        adjustable: ['cfgscale', 'steps', 'seed']
      }, hooks);
    }
  },
  ...ASYNC_ADAPTERS,
  ...OPENAI_ADAPTERS,
  {
    /**
     * OpenAI Images 家族唯一的一条协议。
     *
     * 合并前的九条（dall-e-3 / gpt-image / together / localai / siliconflow /
     * volcengine-ark / azure-openai / xai-imagine / zhipu）地址与组装本来就一样，差别只剩两处，
     * 现在分别用协议级选项与提供商字段表达：
     *
     *   edit —— 协议级选项（见 PROTOCOL_OPTIONS，存在 provider.protocolOptions 里）；
     *   auth —— 提供商字段（provider.auth，见 adapter-kit 的 AUTH_MODES）：
     *           鉴权回答的是「这个地址怎么认证」，和协议是两件事。
     *
     * 不在协议里的三样：
     *   - 字段名：预设 + 模型规则（fieldsFor）；
     *   - 尺寸/质量：模型规则（detectSizeRule / detectQualityRule）；
     *   - response_format / watermark：请求常量规则（detectConstantRule）——
     *     它们原本是各协议上的静态属性，合并后没有 id 可挂，按模型+主机判断。
     * 协议只剩「地址 + 组装 + 响应解码」，这就是这次收敛的目标。
     */
    id: 'openai-images',
    label: 'protocol.openai-images',
    match: () => true,
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    routes: { generate: '/images/generations', edit: '/images/edits', models: '/models' },
    transport: { generate: 'json', edit: 'multipart' },
    // 提交响应带任务 id / 轮询地址时自动跟着轮询；直接返回图片就照同步处理。
    // 「怎么认」全在 output 候选列表里（见 GENERIC_GATEWAY_OUTPUT），这里只剩一个开关：
    // 提交响应可能不是图，而是任务书。
    autoAsync: true,
    output: GENERIC_GATEWAY_OUTPUT,
    maxN: 4,
    editFields: ['image[]', 'image'],
    // Qwen-Image-Edit 系列不接受 image_size，传了会 400。原来写在 siliconflow 协议上，
    // 现在 siliconflow 只是「同一个主机 + edit:'same'」，所以按模型名留在协议里。
    editDrops: (input) => (/qwen-image-edit/i.test(String((input && input.model) || '')) ? ['image_size'] : []),
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await requestProvider(joinEndpoint(baseUrlOf(provider), '/models'), {
        headers: headersFor(provider, false, null, this), signal
      }, provider, this);
      const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider, this);
      return openAiCompatibleEntries(payload);
    }
  }
];

export async function listProviderModels(adapter, provider, signal) {
  return (await listProviderModelEntries(adapter, provider, signal)).map((entry) => entry.id);
}

async function listModelRoute(adapter, provider, signal) {
  // 没有专用实现的协议，按自己声明的 models 路由拉一次——形状默认按 OpenAI 兼容解析。
  const route = String((adapter && adapter.routes && adapter.routes.models) || '');
  if (!route || route.includes('{')) {
    throw localizedError(new Error('该部署器不支持获取模型列表'), 'models.unsupported');
  }
  const options = adapter.operations?.models || {};
  const method = options.method || 'GET';
  const headers = headersFor(provider, false, options.headers, adapter);
  const response = await requestProvider(joinEndpoint(baseUrlOf(provider), route), {
    method, headers, signal, body: method === 'GET' ? undefined : JSON.stringify(options.body || {})
  }, provider, adapter);
  const payload = await readJsonResponse(response, 5 * 1024 * 1024, provider, adapter);
  if (!options.output) return openAiCompatibleEntries(payload);
  const list = getPath(payload, options.output.path);
  if (!Array.isArray(list)) throw new Error('模型列表响应与配置的数组路径不符');
  const entries = [];
  const seen = new Set();
  for (const item of list) {
    const value = options.output.idPath === undefined
      ? typeof item === 'object' ? item?.id : item
      : getPath(item, options.output.idPath);
    const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = options.output.namePath ? getPath(item, options.output.namePath) : '';
    entries.push({ id, name: typeof name === 'string' ? name.trim() : '' });
  }
  return entries;
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
  if (typeof adapter?.listModels !== 'function') return listModelRoute(adapter, provider, signal);
  const ids = await adapter.listModels(provider, signal);
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
  if (kind === 'edit' && typeof adapter.async === 'object' && !adapter.async?.edit) return false;
  return kind === 'edit' ? Boolean(adapter.endpoints.edit) : Boolean(adapter.endpoints.generate);
}

const OPENAI_PRESET_FIELDS = {
  prompt: { path: 'prompt' }, negative: { path: 'negative_prompt' }, model: { path: 'model' },
  n: { path: 'n' }, image: { multipart: 'image[]' }, quality: null
};

function definePresets(entries) {
  return entries.map((entry) => ({
    ...entry,
    fields: { ...OPENAI_PRESET_FIELDS, ...entry.fields }
  }));
}

function presetManifest(presets) {
  return presets.map((preset) => {
    const adapter = resolveAdapter(preset, '');
    return {
      ...preset,
      // 协议要写在清单里：预设表里 `adapter` 空着的那条（OpenAI 官方）就是 OpenAI 兼容那一档，
      // 客户端拿它填好协议。「未选择」只属于用户自配、还没选协议的状态。
      adapter: String(preset.adapter || 'openai-images'),
      models: (preset.models || []).slice(),
      supportsModels: adapterCanListModels(adapter),
      defaultAuth: authSpecOf(preset, adapter)
    };
  });
}

/**
 * 这条预设自己声明的协议与协议级选项；预设不存在返回 null。
 *
 * 预设表里 `adapter` 空着的那几条（OpenAI 官方）按 OpenAI 兼容那一档算——它们本来就是
 * 靠通用网关解析跑的。协议级选项照抄预设：协议换了，它同一套的选项也得跟上
 * （火山方舟 Agent Plan 的编辑走同一个 generations，选项是 `edit:'same'`）。
 */
export function presetProtocolOf(presetId) {
  const id = String(presetId || '').trim();
  if (!id) return null;
  const preset = PROVIDER_PRESETS.concat(LOCAL_PRESETS).find((item) => item.id === id);
  if (!preset) return null;
  return {
    adapter: String(preset.adapter || 'openai-images').trim().toLowerCase(),
    protocolOptions: { ...(preset.protocolOptions || {}) }
  };
}

export function providerPresetManifest() {
  return presetManifest(PROVIDER_PRESETS);
}

/** 云端内置提供商；和本地 preset 一样由宿主下发，客户端不再维护第二份。 */
export const PROVIDER_PRESETS = definePresets([
  {
    id: 'gemini', name: 'Google Gemini / Nano Banana',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini',
    website: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'],
    // 照抄 google-gemini 的 execute()：内容追加进 contents[].parts[]，负面词拼进提示词；
    // 模型名在 URL 的 :generateContent 前，参考图是 inlineData 对象（模板表达不了，留在协议里）。
    // 没有质量参数。
    fields: {
      prompt: { path: 'contents[0].parts[]', wrap: 'text' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: null,
      image: null,
      quality: null
    }
  },
  {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '', website: 'https://platform.openai.com/api-keys', models: [],
    // 落到 openai-images；gpt-image / dall-e-3 这种自家模型由 model-rules 的 fields 再收窄
    // （官方端点没有 negative prompt 这个参数）。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' },
      quality: { path: 'quality' }
    }
  },
  {
    id: 'xai', name: 'xAI Grok Imagine',
    baseUrl: 'https://api.x.ai/v1', adapter: 'openai-images',
    // 预设接入文生图。xAI 的编辑需要单独的 JSON 请求形状。
    protocolOptions: { edit: 'none' },
    website: 'https://console.x.ai/',
    models: ['grok-imagine-image-2.0'],
    // 负面词拼进提示词；没有参考图字段、没有质量参数。
    // response_format:'url' 与 resolution（档位）由请求常量规则 / 尺寸规则按主机给。
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: null,
      quality: null
    }
  },
  {
    id: 'recraft', name: 'Recraft',
    baseUrl: 'https://external.api.recraft.ai/v1', adapter: 'recraft',
    website: 'https://www.recraft.ai/profile/api',
    models: ['recraftv4_1', 'recraftv4', 'recraftv3', 'recraftv2'],
    // 生成是 JSON、图生图是 multipart；负面词按 execute() 的做法拼进提示词。
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image' },
      quality: null
    }
  },
  {
    id: 'ideogram', name: 'Ideogram',
    baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram',
    website: 'https://developer.ideogram.ai/',
    models: IDEOGRAM_MODELS,
    // 模型名在路径里（不是 body 字段），张数字段叫 num_images；
    // ideogram-4 的 JSON 体没有 negative_prompt，由 model-rules 的 fields 收窄。
    // 按模型版本使用 rendering_speed 或 quality；具体字段由模型规则决定。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: null,
      n: { path: 'num_images' },
      image: null,
      quality: { path: 'quality' }
    }
  },
  {
    id: 'stability', name: 'Stability AI',
    baseUrl: 'https://api.stability.ai', adapter: 'stability',
    website: 'https://platform.stability.ai/account/keys',
    models: ['core', 'sd3.5-large'],
    // Core 只支持文生图，模型由路径选定；SD3.5 的模型名由字段规则写入表单。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: null,
      n: null,
      image: { multipart: 'image' },
      quality: null
    }
  },
  {
    id: 'together', name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1', adapter: 'openai-images',
    // 只有 /images/generations：编辑要去掉（合并前的 together 协议就是这样）。
    protocolOptions: { edit: 'none' },
    website: 'https://api.together.ai/settings/api-keys',
    models: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev'],
    // 只有宽高两个尺寸字段，没有 negative prompt；编辑端点为空，所以没有参考图字段。
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: null,
      quality: null
    }
  },
  {
    id: 'fireworks', name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1', adapter: 'custom',
    website: 'https://fireworks.ai/account/api-keys',
    models: ['flux-1-schnell-fp8'],
    fields: { negative: { inPrompt: true }, model: null, n: null, image: null },
    operations: { version: 1, generate: {
      path: 'workflows/accounts/fireworks/models/flux-1-schnell-fp8/text_to_image',
      input: 'explicit',
      fields: { prompt: { path: 'prompt' }, negative: { inPrompt: true }, aspect: { path: 'aspect_ratio' } },
      headers: { Accept: 'image/png' },
      output: 'binary'
    } }
  },
  {
    id: 'novita', name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3beta', adapter: 'custom',
    website: 'https://novita.ai/settings/key-management',
    models: ['flux-1-schnell'],
    fields: { negative: { inPrompt: true }, model: null, n: null, image: null },
    operations: { version: 1, generate: {
      path: 'flux-1-schnell',
      input: 'explicit',
      body: { response_image_format: 'png' },
      fields: {
        prompt: { path: 'prompt' }, negative: { inPrompt: true },
        width: { path: 'width' }, height: { path: 'height' }, n: { path: 'image_num' }
      },
      output: { kind: 'json', pick: [{ path: 'images.0.image_url', as: 'url' }] }
    } }
  },
  /* ---- MiniMax：H3-Image 的图片接口就是 OpenAI Images 形状，直接用 openai-images ----
   *
   * 官方 OpenAPI 里 `servers: https://api.minimax.io`，三个 path 与 OpenAI 一字不差：
   *   POST /v1/images/generations（JSON）  POST /v1/images/edits（1–16 张参考图，JSON 的
   *   images[].image_url 或 OpenAI SDK 的 multipart image[]）  GET /v1/models，鉴权 Bearer。
   * 所以这两条只差一个 baseUrl，一条协议不用改；尺寸按 H3 的真实参数走 model-rules 的
   * SIZE_RULES（aspect_ratio + area 档位，不发 size）。
   *
   * 两个 baseUrl 都实测过（GET/POST 到 /v1/models、/v1/images/generations、
   * /v1/images/edits 都是 401「请带 API Key」，说明路径存在）：
   *   - api.minimax.io   国际站，文档 platform.minimax.io；
   *   - api.minimax.cn   中国站，文档 platform.minimax.cn（当前官方域名）。
   *
   * H3 **没有** negative_prompt（负面词只能拼进提示词）、没有质量档位枚举
   * （只有 output_compression 0–100 的压缩率，不是 low/medium/high）。
   */
  {
    id: 'minimax', name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1', adapter: 'openai-images',
    website: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    models: ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'],
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' },
      quality: null
    }
  },
  {
    id: 'minimax-cn', name: 'MiniMax 中国',
    baseUrl: 'https://api.minimax.cn/v1', adapter: 'openai-images',
    website: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    models: ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'],
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' },
      quality: null
    }
  },
  {
    id: 'openrouter', name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images',
    website: 'https://openrouter.ai/settings/keys',
    models: ['google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-flare', 'black-forest-labs/flux.2-pro'],
    // 照抄 openrouter-images 的 execute()：负面词拼进提示词；参考图是 input_references[] 里的
    // { type: 'image_url', image_url: { url } } 对象，六种能力表达不了，留在协议里。
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: null,
      quality: null
    }
  },
  {
    id: 'azure', name: 'Azure OpenAI',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', adapter: 'openai-images',
    // 与官方同一条协议，只换鉴权方式（api-key 而不是 Bearer）：provider.auth，不是协议选项。
    auth: { mode: 'api-key' },
    website: 'https://portal.azure.com/',
    models: [],
    // 路径与官方一致、鉴权不同，字段一致：没有 negative prompt，参考图走 /images/edits 的 image[]。
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' },
      quality: { path: 'quality' }
    }
  },
  {
    id: 'azure-mai', name: 'Microsoft Foundry (MAI-Image)',
    baseUrl: 'https://YOUR-RESOURCE.services.ai.azure.com/mai/v1', adapter: 'custom',
    auth: { mode: 'api-key' },
    website: 'https://ai.azure.com/',
    models: [],
    fields: { prompt: { path: 'prompt' }, negative: { inPrompt: true }, model: { path: 'model' },
      n: null, image: { multipart: 'image' }, quality: null },
    operations: {
      version: 1,
      generate: {
        path: 'images/generations', input: 'explicit',
        fields: {
          prompt: { path: 'prompt' }, negative: { inPrompt: true }, model: { path: 'model' },
          width: { path: 'width' }, height: { path: 'height' }
        },
        output: 'openai'
      },
      edit: {
        path: 'images/edits', input: 'explicit', transport: 'multipart',
        maxImages: 5, imageTypes: ['image/jpeg', 'image/png'],
        fields: {
          prompt: { multipart: 'prompt' }, negative: { inPrompt: true }, model: { multipart: 'model' },
          image: { multipart: 'image' }
        },
        output: 'openai'
      }
    }
  },
  {
    id: 'bfl', name: 'Black Forest Labs (FLUX)',
    baseUrl: 'https://api.bfl.ai/v1', adapter: 'bfl',
    website: 'https://dashboard.bfl.ai/',
    models: ['flux-2-pro', 'flux-2-max', 'flux-3-image', 'flux-kontext-pro'],
    // 照抄 async.build()：模型名在提交路径 /v1/<model> 里；FLUX.2 的参考图是
    // input_image / input_image_2..N，FLUX 3 换成 images 数组（由 model-rules 按模型收窄）。
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: null,
      image: { numbered: 'input_image', as: 'dataUrl' },
      quality: null
    }
  },
  {
    id: 'fal', name: 'fal.ai',
    baseUrl: 'https://queue.fal.run', adapter: 'fal',
    website: 'https://fal.ai/dashboard/keys',
    models: ['fal-ai/flux-2-pro', 'fal-ai/flux-pro/kontext'],
    // 照抄 falBuild()：模型名在提交路径里，张数叫 num_images；参考图单图用 image_url、
    // 多图用 image_urls，选哪个由端点决定（模板不表达条件），留在协议里。
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: { path: 'num_images' },
      image: null,
      quality: null
    }
  },
  {
    id: 'replicate', name: 'Replicate',
    baseUrl: 'https://api.replicate.com/v1', adapter: 'replicate',
    website: 'https://replicate.com/account/api-tokens',
    models: ['black-forest-labs/flux-2-pro'],
    // 照抄 replicateBuild()：提交体只有 input.prompt 是固定的，参考图与尺寸字段都由
    // 模型的 Input schema 决定（表达不了，留在协议里）。
    fields: {
      prompt: { path: 'input.prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: null,
      n: null,
      image: null,
      quality: null
    }
  },
  {
    id: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'openai-images', website: 'https://console.volcengine.com/ark', models: [],
    // 方舟的编辑也走 /images/generations，所以 edit:'same'；seedream 一族不收负面词，
    // 参考图是 data URL 的 image。response_format / watermark 由请求常量规则按主机给。
    protocolOptions: { edit: 'same' },
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: { path: 'image', as: 'dataUrl' },
      quality: null
    }
  },
  {
    id: 'volcengine-plan', name: '火山方舟 Agent Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', adapter: 'openai-images',
    website: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan',
    models: [],
    protocolOptions: { edit: 'same' },
    fields: {
      prompt: { path: 'prompt' },
      negative: null,
      model: { path: 'model' },
      n: { path: 'n' },
      image: { path: 'image', as: 'dataUrl' },
      quality: null
    }
  },
  {
    id: 'dashscope', name: '阿里云百炼 · Qwen-Image',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-qwen-image',
    website: 'https://bailian.console.aliyun.com/',
    models: ['qwen-image-3.0-pro', 'qwen-image-3.0'],
    // 照抄 dashscope-qwen-image 的 execute()：提示词与参考图都追加到 input.messages[0].content[]，
    // 负面词与张数在 parameters 里；参考图要用 wrap 包成 { image: dataUrl } 项。
    fields: {
      prompt: { path: 'input.messages[0].content[]', wrap: 'text' },
      negative: { path: 'parameters.negative_prompt' },
      model: { path: 'model' },
      n: { path: 'parameters.n' },
      image: { path: 'input.messages[0].content[]', wrap: 'image', as: 'dataUrl' },
      quality: null
    }
  },
  {
    id: 'dashscope-wanx', name: '阿里云百炼 · 通义万相',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapter: 'dashscope-wanx',
    website: 'https://bailian.console.aliyun.com/',
    models: ['wan2.6-t2i', 'wan2.7-image-pro', 'wan2.7-image', 'wanx2.1-t2i-turbo'],
    // 老模型使用 input.prompt。2.6 文生图与 2.7 图像模型由协议按模型切换成多模态消息。
    fields: {
      prompt: { path: 'input.prompt' },
      negative: { path: 'input.negative_prompt' },
      model: { path: 'model' },
      n: { path: 'parameters.n' },
      image: null,
      quality: null
    }
  },
  {
    id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', adapter: 'openai-images', website: 'https://cloud.siliconflow.cn/account/ak', models: [],
    // 硅基流动的编辑也走 /images/generations，所以 edit:'same'；扁平字段、
    // 没有张数声明（一次一张），参考图是 data URL 的 image。
    protocolOptions: { edit: 'same' },
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: null,
      image: { path: 'image', as: 'dataUrl' },
      quality: null
    }
  },
  {
    id: 'bigmodel', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: 'openai-images', website: 'https://bigmodel.cn/usercenter/apikeys', models: [],
    // 地址三元组与 OpenAI Images 一样（只有 /images/generations，没有编辑端点）。
    // 它的 body 本来就和通用 composeBody 一致：不收 n / response_format，负面词拼进提示词。
    protocolOptions: { edit: 'none' },
    fields: {
      prompt: { path: 'prompt' },
      negative: { appendToPrompt: '\n\nAvoid: ' },
      model: { path: 'model' },
      n: null,
      image: null,
      quality: null
    }
  },
  {
    id: 'modelscope', name: '魔搭 ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn', adapter: 'modelscope',
    website: 'https://www.modelscope.cn/my/myaccesstoken',
    models: ['Qwen/Qwen-Image-2.1', 'Qwen/Qwen-Image-2.1-Turbo', 'Qwen/Qwen-Image-Edit'],
    // 照抄 modelscopeBuild()：参考图字段是 image_url（一张发字符串、多张发数组，正好是 path 的语义）。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: null,
      image: { path: 'image_url', as: 'dataUrl' },
      quality: null
    }
  }
]);

const OPENAI_PRESETS_BY_HOST = new Map(PROVIDER_PRESETS
  .filter((preset) => preset.adapter === 'openai-images')
  .map((preset) => [hostOfBase(preset.baseUrl), preset]));

export const LOCAL_PRESETS = definePresets([
  {
    id: 'sd-server', name: 'stable-diffusion.cpp (sd-server)', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。',
    hint: '原生 OpenAI Images 接口，生成和 /images/edits 编辑都支持；模型名通常是 sd-cpp-local，可从 /v1/models 获取。',
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' },
      quality: null
    }
  },
  {
    id: 'localai', name: 'LocalAI', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。',
    hint: '生成模型名来自 LocalAI 的模型配置或 /v1/models。局部重绘需要图像与蒙版，Flux Kontext 的编辑参数由后端决定。',
    // LocalAI 的 /images/edits 需要蒙版，通用参考图入口无法满足。
    protocolOptions: { edit: 'none' },
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: null,
      quality: null
    }
  },
  {
    id: 'a1111', name: 'AUTOMATIC1111 / Forge / SD.Next / Draw Things', adapter: 'a1111',
    baseUrl: 'http://127.0.0.1:7860', optionalKey: true, supportsModels: true,
    auth: { mode: 'basic' },
    urlHint: '只填服务根地址，不要带 /sdapi/v1；插件会拼 /sdapi/v1/txt2img、/img2img、/sd-models。',
    hint: '走 /sdapi/v1/txt2img 和 /sdapi/v1/img2img，模型列表来自 /sdapi/v1/sd-models；A1111 需要启动时加 --api。',
    // 照抄 activate() 里拼的 body：模型走 override_settings，参考图是 init_images 的 base64 数组，
    // 张数是硬编码的 batch_size / n_iter（不接 n）。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'override_settings.sd_model_checkpoint' },
      n: null,
      image: { path: 'init_images[]', as: 'base64' },
      quality: null
    }
  },
  {
    id: 'comfyui', name: 'ComfyUI', adapter: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /prompt；插件会拼 /prompt、/upload/image、/history、/view。',
    hint: '支持 SD/SDXL 单文件 checkpoint、FLUX.2 系列和 MOSS-Image（含编辑 LoRA 的图生图），模型列表来自 /object_info。FLUX.1、Qwen-Image 等其它架构仍建议走 OpenAI 兼容网关。',
    // 这里的名字不是 JSON body 的键，而是工作流占位符 {{prompt}} / {{negative_prompt}} /
    // {{model}} / {{image}} 的名字（COMFY_WORKFLOW_PLACEHOLDERS）；注入走 execute() 的
    // applyWorkflowTemplate，尺寸由 {{width}}/{{height}} 或映射管。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: null,
      image: { path: 'image' },
      quality: null
    }
  },
  {
    id: 'swarmui', name: 'SwarmUI', adapter: 'swarmui',
    baseUrl: 'http://127.0.0.1:7801', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /API；插件会拼 /API/GetNewSession、/API/ListModels、/API/GenerateText2Image。',
    hint: '走 /API/GenerateText2Image，模型列表来自 /API/ListModels；生成可用，原生编辑暂不支持。',
    // 照抄 execute() 的 body：负面词的键没有下划线（negativeprompt），张数的键叫 images
    // （现在硬编码 1）；编辑端点为空，所以没有参考图字段。
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negativeprompt' },
      model: { path: 'model' },
      n: { path: 'images' },
      image: null,
      quality: null
    }
  },
  {
    id: 'openai-gateway', name: '其他 OpenAI 兼容网关', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:3000/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填 OpenAI API 根地址（通常带 /v1）；插件会拼 /images/generations 和 /models。',
    hint: 'InvokeAI、Fooocus、复杂 ComfyUI 工作流或自建服务，只要暴露 /v1/images/generations 就选这个。',
    fields: {
      prompt: { path: 'prompt' },
      negative: { path: 'negative_prompt' },
      model: { path: 'model' },
      n: { path: 'n' },
      image: { multipart: 'image[]' },
      quality: null
    }
  }
]);

/**
 * 协议下拉的展示顺序与分组。
 *
 * 只决定 adapterManifest() 的输出顺序与 `group` 字段（设置页下拉用），**不参与解析**：
 * pickAdapter() 仍按 ADAPTERS 的声明顺序找第一条 match，openai-images（match: () => true）
 * 必须留在最后当兜底。所以这里另开一张表，而不是直接重排 ADAPTERS。
 *
 * 顺序按「人会怎么找」排：通用 / 官方 → 兼容网关 → 各家原生 → 本地部署 → 异步任务；
 * `group` 同时是客户端展开「更多协议…」时的分段依据，文案键是 protocolGroup.<id>。
 */
export const PROTOCOL_GROUPS = [
  { id: 'general', adapters: ['openai-images', 'openai-responses'] },
  { id: 'gateway', adapters: ['openai-chat', 'openrouter-images'] },
  {
    id: 'native',
    adapters: [
      'google-gemini', 'recraft', 'ideogram', 'stability',
      'dashscope-qwen-image', 'dashscope-wanx'
    ]
  },
  { id: 'local', adapters: ['a1111', 'comfyui', 'swarmui'] },
  { id: 'async', adapters: ['bfl', 'fal', 'replicate', 'modelscope'] }
];

/**
 * 按展示顺序铺开 [{ adapter, group }]。
 * 表里漏写的协议按声明顺序补在最后并标成 other——漏项由 test/protocol-labels.test.mjs 挡住，
 * 运行时宁可多显示一条，也不让它从下拉里消失（配置里可能正存着这个 id）。
 */
function orderedAdapters() {
  const byId = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));
  const placed = new Set();
  const ordered = [];
  for (const group of PROTOCOL_GROUPS) {
    for (const id of group.adapters) {
      const adapter = byId.get(id);
      if (!adapter || placed.has(id)) continue;
      placed.add(id);
      ordered.push({ adapter: adapter, group: group.id });
    }
  }
  for (const adapter of ADAPTERS) {
    if (!placed.has(adapter.id)) ordered.push({ adapter: adapter, group: 'other' });
  }
  return ordered;
}

/**
 * 协议清单（客户端下拉与设置页都读它），按展示顺序输出。
 *
 * `label` 是 i18n key（protocol.<id>），客户端按当前语言翻译；`group` 是展开后的分段。
 * `options` 只在协议声明了协议级选项时出现：每个选项给出取值、默认值，
 * 以及（会改地址的选项）每个取值下的三条展示地址——客户端按当前选择查表，
 * 不自己复制一份「edit=same 就是 generations」的知识。
 */
export function adapterManifest() {
  return orderedAdapters().map(({ adapter, group }) => {
    const entry = {
      id: adapter.id,
      label: adapter.label,
      group: group,
      local: !!adapter.local,
      supportsModels: adapterCanListModels(adapter),
      defaultAuth: authSpecOf(null, adapter),
      acceptsHttpParams: adapterTakesParamRows(adapter),
      routes: routesOf(adapter)
    };
    const options = optionManifestOf(adapter);
    if (options.length) entry.options = options;
    return entry;
  });
}

/** 协议选项的「给客户端看的那一半」：取值、默认值、每个取值对应的地址。 */
function optionManifestOf(adapter) {
  const schema = PROTOCOL_OPTIONS[adapter.id];
  if (!schema) return [];
  const base = routesOf(adapter);
  return Object.entries(schema).map(([name, spec]) => {
    const entry = { name: name, values: spec.values.slice(), default: spec.default };
    if (typeof spec.routes === 'function') {
      entry.routes = {};
      for (const value of spec.values) entry.routes[value] = spec.routes(base, value);
    }
    return entry;
  });
}

/** 能拉模型列表：要么适配器自己实现了 listModels，要么声明了不含占位符的 models 路由。 */
export function adapterCanListModels(adapter) {
  if (!adapter) return false;
  if (typeof adapter.listModels === 'function') return true;
  const route = String((adapter.routes && adapter.routes.models) || '');
  return Boolean(route) && !route.includes('{');
}

/**
 * 模型列表来自通用 `/models` 时，同一份列表里混着聊天、向量模型，要按图像模型过滤；
 * 各家自己的列表接口（/sd-models、/object_info、/models?pageSize=… 之外的）本来就只有图像模型。
 */
export function listsOpenAiCompatibleModels(adapter) {
  if (!adapter) return false;
  if (adapter.operations?.models?.output) return false;
  if (adapter.id === 'openai-images') return true;
  return String((adapter.routes && adapter.routes.models) || '') === '/models';
}

/**
 * 展示用的三条地址。它们是给人看和给测试对照的，不参与拼请求——
 * 请求走 endpoints，两者对不上由 test/adapter-routes.test.mjs 挡住。
 */
function routesOf(adapter) {
  const routes = adapter.routes || {};
  const pick = (kind) => String(routes[kind] || '');
  return { generate: pick('generate'), edit: pick('edit'), models: pick('models') };
}

export function localPresetManifest() {
  return presetManifest(LOCAL_PRESETS);
}

/**
 * 每个协议「零配置时该有哪些参数行」。
 *
 * 只给 A1111：它有一份固定的 sdapi 采样参数清单，用户在设置页第一次展开模型时，
 * 客户端照这张表把行塞进离散参数表（默认值在表里可改，清空就不发）。
 * ComfyUI 的行来自解析工作流，没有可预置的清单。
 */
export function paramDefaultsManifest() {
  return {
    a1111: A1111_PARAMS.map((param) => ({ name: param.name, type: param.type, default: param.default }))
  };
}

/** Compile provider defaults and model overrides into the standard adapter interface. */
function customAdapter(provider, model) {
  const endpoints = (provider && provider.customEndpoints) || {};
  const pick = (kind) => String(endpoints[kind] || '').trim();
  const operations = providerOperationsOf(provider, model);
  const generate = operations.generate?.path ?? pick('generate');
  const edit = operations.edit?.path ?? pick('edit');
  const models = operations.models?.path ?? pick('models');
  const prepareScope = (kind, fallback) => {
    const operation = operations[kind] || {};
    const method = operation.method || 'POST';
    const transport = operation.transport || (method === 'GET' ? 'query' : fallback);
    validateOperationTransport(kind, operation, transport);
    return { ...operation, method, transport, output: operationOutputOf(operation.output, GENERIC_GATEWAY_OUTPUT) };
  };
  const generateSpec = prepareScope('generate', 'json');
  const editSpec = prepareScope('edit', 'multipart');
  return {
    id: 'custom',
    label: '自定义',
    transport: { generate: generateSpec.transport, edit: editSpec.transport },
    routes: { generate: generate, edit: edit, models: models },
    endpoints: { generate: routeWithModel(generate), edit: routeWithModel(edit) },
    operations: { generate: generateSpec, edit: editSpec, models: operations.models },
    output: GENERIC_GATEWAY_OUTPUT,
    autoAsync: true,
    maxN: 4,
    editFields: editSpec.fields?.image ? [] : editSpec.transport === 'multipart' ? ['image[]', 'image'] : ['image']
  };
}

function routeWithModel(path) {
  if (!path.includes('{model}')) return path;
  return (input) => path.replace(/\{model\}/g, encodeURIComponent(input.model));
}

export function resolveAdapter(provider, model) {
  return resolveAdapterBase(provider, model);
}

/**
 * 解析协议：先换掉老协议 id（老配置也能直接跑，落盘由 normalizeConfig 负责），
 * 再把协议级选项落到端点/传输/鉴权上。
 */
function resolveAdapterBase(provider, model) {
  const effective = upgradeLegacyProtocol(provider);
  const base = pickAdapter(effective, model);
  const adapter = withProtocolOptions(base.forModel?.(model) || base, effective);
  if (adapter.id === 'custom') return adapter;
  const responseOverrides = responseOverridesOf(effective, model);
  return responseOverrides ? { ...adapter, responseOverrides } : adapter;
}

function pickAdapter(provider, model) {
  const protocol = String((provider && provider.protocol) || '').trim().toLowerCase();
  if (protocol === 'custom') return customAdapter(provider, model);
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
    // 自定义协议不是清单里的一条，按 provider 上的地址现场生成。
    if (explicit === 'custom') return customAdapter(provider, model);
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

/**
 * 日志里的协议名。label 现在是 i18n key（客户端按当前语言翻），宿主日志只写 id：
 * 日志是给排查用的，写 key 反而看不清是哪条协议。
 */
export function describeAdapter(adapter) {
  return adapter.id;
}

/* ------------------------------------------------------- 识别协议：探测表 */

/**
 * 单个探针的超时。
 *
 * 只按「一条只读 GET 最多等多久」算，**没有整轮总预算**：一次识别要探几条，取决于
 * 这个地址上有几条候选路径（最坏 4 条），客户端每条都会把「正在尝试访问 xxx」写出来，
 * 所以慢是看得见的，不会像整轮预算那样把后面几条悄悄吞掉。
 */
const DETECT_PROBE_MS = 15000;
/**
 * 探针只读回来的前缀上限。
 * `/object_info` 在装了很多自定义节点的 ComfyUI 上能到 20MB+，判形状不需要整份；
 * 读满就掐断流，按前缀判（见 probeShapeOfText）。1MB 是「常见 /models 一定读得完、
 * 又不至于为了判个形状把设置页拖住」的折中。
 */
const DETECT_BODY_BYTES = 1024 * 1024;

/**
 * 地址是不是本机 / 内网？
 *
 * 只影响**探测表的先后**，不影响任何请求组装：内网地址先问本地那三条协议
 * （ComfyUI / A1111 / SwarmUI 各自有自己的模型端点），公网地址先问 `/models`。
 * 除了回环与 RFC1918，还认 `.local`（mDNS）和单标签主机名——带点的公网域名之外的
 * 主机名只能是内网名字。
 */
export function isLocalBaseUrl(baseUrl) {
  const host = hostOnly(baseUrl);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return false;
  const [a, b] = octets;
  if (a === 127) return true;                       // 回环
  if (a === 10) return true;                        // RFC1918
  if (a === 192 && b === 168) return true;          // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true;          // 链路本地
  return false;
}

/** 只取主机名（去协议 / 账号 / 端口），IPv6 去方括号。`hostOfBase` 保留端口，别混用。 */
function hostOnly(baseUrl) {
  let rest = String(baseUrl || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  rest = rest.split('/')[0].split('?')[0].split('#')[0];
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = rest.slice(at + 1);
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    return end > 0 ? rest.slice(1, end).toLowerCase() : '';
  }
  // 不带方括号的 IPv6（::1 / fe80::…）直接原样交给下面的判断。
  if ((rest.match(/:/g) || []).length > 1) return rest.toLowerCase();
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) rest = rest.slice(0, colon);
  return rest.toLowerCase();
}

/**
 * 探测表：**一条协议一行**，探针路径取该协议自己的 `routes.models`（`adapterManifest()`
 * 下发的那份），不在这里重复写路径。没有模型端点的协议（recraft / stability / bfl / fal …）
 * 进不来，只能靠主机表或用户手选——这本身就是「它没有可探测的只读端点」这个事实。
 *
 * `accepts` 是这条协议的模型端点**返回什么形状**（判定见 probeShapeOf）：
 *   - `openai-data`：`{ data: [...] }`，OpenAI 兼容网关 / LocalAI / sd-server；
 *   - `gemini-models`：`{ models: [...] }`，Gemini 原生；
 *   - `array`：裸数组，A1111 的 `/sdapi/v1/sd-models`；
 *   - `object`：任意 JSON 对象，ComfyUI 的 `/object_info` 与 SwarmUI 的 `/API/ListModels`。
 *
 * 顺序就是「同一个地址上先问谁」，两条规矩：
 *   1. **本地服务排前面**（内网地址才探），它们的端点彼此不重叠，谁先无所谓，
 *      按「谁最可能被本地部署的用户填进来」排：ComfyUI → A1111 → SwarmUI；
 *   2. **`/models` 上通用协议排在窄协议前面**：`{data:[...]}` 只能证明「OpenAI 兼容」，
 *      证明不了「这是 Responses / Chat 接口」，所以先给 `openai-images`；
 *      `{models:[...]}` 才是 Gemini。混淆时宁可给通用那条（用户随时能在下拉里改窄）。
 */
const PROBE_ROWS = [
  { protocol: 'comfyui', accepts: ['object'] },
  { protocol: 'a1111', accepts: ['array'] },
  { protocol: 'swarmui', accepts: ['object'] },
  { protocol: 'openai-images', accepts: ['openai-data'] },
  { protocol: 'google-gemini', accepts: ['gemini-models'] },
  { protocol: 'openai-chat', accepts: ['openai-data'] },
  { protocol: 'openai-responses', accepts: ['openai-data'] },
  { protocol: 'openrouter-images', accepts: ['openai-data'] }
];

/**
 * 成品的探测表（导出版）：`protocol` / `path` / `accepts` / `local`。
 *
 * `path` 与 `local` 是从 ADAPTERS 现场取回来的，不是抄的——协议改了端点，探测跟着改。
 * 表里写了但协议不存在（改名/删除）的行直接丢掉，不让它在运行期指向一个空地址。
 */
export const PROTOCOL_PROBES = PROBE_ROWS.map((row) => {
  const adapter = ADAPTERS.find((item) => item.id === row.protocol) || null;
  const path = String((adapter && adapter.routes && adapter.routes.models) || '');
  return {
    protocol: row.protocol,
    path: path,
    accepts: row.accepts.slice(),
    local: Boolean(adapter && adapter.local)
  };
}).filter((row) => row.path);

/**
 * 探针回来的东西算哪一类形状。
 *
 * `data` 先于 `models` 判：真有网关两个都返回时，`{data:[...]}` 是 OpenAI 的招牌。
 * `object` 是兜底类，只给 ComfyUI / SwarmUI 那种「是个 JSON 对象就说明走对了门」的端点。
 */
function probeShapeOf(payload) {
  if (Array.isArray(payload)) return 'array';
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.data)) return 'openai-data';
  if (Array.isArray(payload.models)) return 'gemini-models';
  return 'object';
}

/**
 * 截断的前缀版判形状：读满上限就不解析了，只看开头。
 *
 * 故意**不猜键名**（`"data": [` / `"models": [`）：装了几个自定义节点的 ComfyUI，
 * `/object_info` 里完全可能出现叫 `data` / `models` 的输入项，按键名猜会把本地 ComfyUI
 * 误判成 Gemini。截断时只认最不会错的两件事——开头是 `[` 还是 `{`；真读不完的大响应
 * （巨型 /models）就让它退到自定义，用户手选一次即可。
 */
function probeShapeOfText(text) {
  const trimmed = String(text || '').trimStart();
  if (trimmed.startsWith('[')) return 'array';
  if (trimmed.startsWith('{')) return 'object';
  return '';
}

/** 探针的 signal：调用方的（如果有）与自己的超时合一；合不了就用自己的。 */
function probeSignalOf(callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeout;
  try {
    return AbortSignal.any([callerSignal, timeout]);
  } catch (_error) {
    return timeout;
  }
}

/** 把没人要的响应体（流）取消掉，别让连接吊在那里。 */
async function cancelStream(body) {
  if (!body) return;
  try { await body.cancel(); } catch (_error) { /* 已经读完 / 已经取消 */ }
}

/**
 * 读回响应体的前缀（最多 cap 字节）；返回 `{ text, truncated, failed }`。
 * 超限就主动掐断流：判形状只要开头，没必要把 20MB 的 /object_info 读进内存。
 * 读的过程中断了（超时 / 连接被掐）算 `failed`——半截响应不该拿来判协议。
 */
async function readProbePrefix(response, cap) {
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { text: buffer.toString('utf8'), truncated: buffer.length >= cap, failed: false };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= cap) { truncated = true; break; }
    }
  } catch (_error) {
    await cancelStream(body);
    return { text: '', truncated: false, failed: true };
  }
  if (truncated) await cancelStream(body);
  return { text: Buffer.concat(chunks).toString('utf8'), truncated, failed: false };
}

/**
 * 探针失败归到哪一类：超时和连不上要分开——界面上一个说「超时」、一个说「连不上」。
 *
 * `request()` 会把 fetch 的错误再包一层（localized + `cause` 链），所以两个位置都要看：
 * 直接抛出的 AbortError 带 `network.timeout`，真超时（AbortSignal.timeout）是 cause 里的
 * `TimeoutError` 被包成 `network.failed`。
 */
function probeFailureReasonOf(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.localized && current.localized.code === 'network.timeout') return 'timeout';
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return 'timeout';
    current = current.cause;
  }
  return 'network';
}

/**
 * 发一个探针：**只发 GET**，只读，绝不打 `/images/*`、`/prompt` 这类会干活或花钱的端点。
 *
 * 返回 `{ shape, status, reason }`，**绝不往外抛**：识别按钮不该因为某个候选不通就整体失败。
 *   - `status`：真拿到响应就是 HTTP 状态码；超时 / 连不上是 0；
 *   - `reason`：读出形状时为空，否则是 `timeout` / `network` / `unreadable` / `invalid`。
 *
 * **不回传响应体或异常原文**：上游的错误体完全可能把 Authorization 头原样回显，
 * 识别提示只需要「状态 + 类别」，没理由把 Key 带进返回值。
 */
async function probeOnce(url, provider, callerSignal, timeoutMs, adapter) {
  let response;
  try {
    response = await requestProvider(url, {
      method: 'GET',
      headers: headersFor(provider || {}, false, null, adapter),
      signal: probeSignalOf(callerSignal, timeoutMs)
    }, provider, adapter);
  } catch (error) {
    return { shape: '', status: 0, reason: probeFailureReasonOf(error) };
  }
  if (!response) return { shape: '', status: 0, reason: 'network' };
  const status = Number(response.status) || 0;
  if (!response.ok) {
    await cancelStream(response.body);
    return { shape: '', status: status, reason: '' };
  }
  let read;
  try {
    read = await readProbePrefix(response, DETECT_BODY_BYTES);
  } catch (_error) {
    return { shape: '', status: status, reason: 'unreadable' };
  }
  if (read.failed) return { shape: '', status: status, reason: 'unreadable' };
  if (!read.truncated) {
    try {
      return { shape: probeShapeOf(JSON.parse(read.text)), status: status, reason: '' };
    } catch (_error) {
      return { shape: '', status: status, reason: 'invalid' };
    }
  }
  const shape = probeShapeOfText(read.text);
  return { shape: shape, status: status, reason: shape ? '' : 'invalid' };
}

/**
 * 探测顺序：一张表按「先问谁」排好。
 *
 * 内网地址：本地三条在前（ComfyUI → A1111 → SwarmUI），`/models` 收尾——本地服务各自
 * 的模型端点彼此不重叠，`/models` 是通用兜底，放最后。
 *
 * 公网地址：**`/models` 在前**（一个请求就能试 5 种形状：openai-images / Gemini / chat /
 * responses / openrouter），它不中之后才按同样的顺序试本地那三条。公网自托管的 ComfyUI
 * （`https://comfy.example.com`）没有 `/models`，不放开这三条就只能落自定义。
 *
 * **公网最坏 4 个请求**（`/models` + 三条）。这个上限可以接受，因为整条路只在用户
 * **手动点「识别协议」按钮**时才走，不在页面加载/保存路径上；而且每条都是只读 GET、
 * 命中即停，客户端还会把「正在尝试访问 xxx」实时显示出来——用户看得见代价，也能随时
 * 关掉设置页（客户端那条请求有自己的 20 秒超时，单探针在宿主侧封顶 15 秒）。
 */
function probeOrderOf(baseUrl) {
  const local = PROTOCOL_PROBES.filter((row) => row.local);
  const remote = PROTOCOL_PROBES.filter((row) => !row.local);
  return isLocalBaseUrl(baseUrl) ? local.concat(remote) : remote.concat(local);
}

/**
 * 一份地址该按什么顺序探哪些**路径**（同一路径只出来一次：`/models` 上压着 5 条协议，
 * 它们只能靠返回形状区分，问一遍就够）。
 *
 * `first` 用于校验模式：用户手选的那条协议的路径排在最前面，先回答「像不像它」，
 * 剩下的路径只用来给「看起来像谁」的提示。
 */
function probePathsOf(baseUrl, first) {
  const paths = [];
  for (const row of probeOrderOf(baseUrl)) {
    if (!paths.includes(row.path)) paths.push(row.path);
  }
  const lead = String(first || '');
  if (!lead || !paths.includes(lead)) return paths;
  return [lead].concat(paths.filter((path) => path !== lead));
}

/** 用户已经手选的那条协议：只在它真是一条协议时才进校验模式（`custom` 不算）。 */
function expectedProtocolOf(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id) return '';
  return ADAPTERS.some((adapter) => adapter.id === id) ? id : '';
}

/**
 * 地址 / 模型名能不能**静态**证明这条协议（零请求）。
 *
 * `openai-images` 是个 catch-all（`match: () => true`），靠它自己认不出来，只能看主机表；
 * 反过来 comfyui / a1111 / swarmui 的 `match` 只看 `provider.adapter` 文本，光有地址
 * 永远匹配不到——它们只能靠探测表认，这正是本次要修的毛病。
 */
function staticallyProves(provider, baseUrl, model, protocol) {
  if (protocol === 'openai-images') return Boolean(knownOpenAiHostOf(baseUrl));
  let matched = null;
  try {
    matched = resolveAdapter({ baseUrl: baseUrl }, String(model || ''));
  } catch (_error) {
    matched = null;
  }
  return Boolean(matched && matched.id === protocol);
}

/**
 * 识别的第一步（**零上游请求**）：能静态认出来就给答案，否则给出这份地址的探测顺序。
 *
 * 判定顺序（能不发请求就不发）：
 *   1. 本地静态判定（`resolveAdapter` 的主机 + 模型名）认出具体协议 → 直接返回；
 *   2. 地址命中「已知的 OpenAI 兼容主机」（KNOWN_OPENAI_HOSTS：官方 / Azure / Together /
 *      硅基流动 / 火山方舟 …）→ 直接判定 `openai-images`，并按主机给出协议级选项。
 *      这一步必须**先于**探测：合并后 `openai-images` 既是识别结果又是兜底，只看
 *      「有没有匹配到具体协议」会把方舟这类地址当成没认出来，去 GET /models 反而 404；
 *   3. 其余主机 → 返回 `probes`（见 probeOrderOf），由客户端按顺序一条条问
 *      probeProtocolPath()：每问一条就能把「正在尝试访问 xxx」写出来。
 *
 * `options.expected` 是用户已经手选的那条协议：给了就进**校验模式**——探测顺序以它自己的
 * 路径打头，客户端拿 probeProtocolPath() 的 `protocols` 判断「像不像它」，不换协议。
 * 客户端只在「用户自己选过某条协议」时才传它。
 *
 * 返回 `{ done: true, answer }` 或 `{ done: false, probes }`：
 *   - `answer.protocol: ''` 表示连地址都没有（客户端自己会拦）；
 *   - `answer.verified` 只在校验模式出现；`answer.probed: false` 表示一个请求都没发；
 *   - `answer.protocolOptions` 只在有非默认选项时出现（客户端据此写 provider.protocolOptions）。
 */
export function detectProtocolStart(provider, model, options = {}) {
  // 末尾斜杠在这里统一去掉：探针是 baseUrl + 协议自己的路径拼出来的，多一个斜杠
  // 就是 `//object_info`（有些服务不认）。
  const baseUrl = baseUrlOf(provider || {});
  if (!baseUrl) return { done: true, answer: { protocol: '', matched: false, probed: false } };
  const expected = expectedProtocolOf(options.expected);
  if (expected) {
    if (staticallyProves(provider, baseUrl, model, expected)) {
      return { done: true, answer: { protocol: expected, matched: true, probed: false, verified: true } };
    }
    const row = PROTOCOL_PROBES.find((item) => item.protocol === expected) || null;
    // 没有模型端点的协议（recraft / ideogram / stability / bfl / fal …）没法用只读探针
    // 验证：静态没认出来就只报告「不像」，不再发请求——发出去也只能看到一个 404。
    if (!row) return { done: true, answer: { protocol: expected, matched: false, probed: false, verified: false } };
    return { done: false, probes: probePathsOf(baseUrl, row.path) };
  }
  // 只喂地址与模型：配置里显式选中的协议不参与——按钮问的是「这个地址像谁」。
  let local = null;
  try {
    local = resolveAdapter({ baseUrl: baseUrl }, String(model || ''));
  } catch (_error) {
    local = null;
  }
  if (local && local.id !== 'openai-images') {
    return { done: true, answer: { protocol: local.id, matched: true, probed: false } };
  }
  // 已知的 OpenAI 兼容主机：不发探测请求（很多网关的 /models 是 404，探测只会误伤）。
  const known = knownOpenAiHostOf(baseUrl);
  if (known) {
    const answer = { protocol: 'openai-images', matched: true, probed: false };
    const chosen = known.options && typeof known.options === 'object' ? known.options : {};
    if (Object.keys(chosen).length) answer.protocolOptions = chosen;
    // 鉴权是提供商字段，单独带回去（客户端写 provider.auth.mode）；老配置靠主机默认值兜着。
    const authMode = normalizeAuthSpec(typeof known.auth === 'string' ? { mode: known.auth } : known.auth);
    if (authMode) answer.auth = authMode;
    return { done: true, answer: answer };
  }
  return { done: false, probes: probePathsOf(baseUrl) };
}

/**
 * 第二步：只探**一条**路径，绝不抛异常。
 *
 * 客户端每发一次就把「正在尝试访问 xxx」写出来——进度是真的；命中即停也由客户端做，
 * 宿主这里只回答「这条路径回来的是什么形状、这个形状能证明哪些协议、失败又是哪一类」。
 *
 * 返回 `{ probe, shape, protocols, status, reason }`：
 *   - `protocols` 只在读出形状时非空——**判定不放宽**：401 / 404 / 超时 / 连不上都不是命中；
 *   - `status` 是 HTTP 状态（没拿到响应时为 0），`reason` 补状态说不出来的类别
 *     （`timeout` / `network` / `unreadable` / `invalid`）。客户端靠这两个字段把
 *     「401 → Key」「404 → 这个地址没有该接口」「超时 → 请检查网络」分成不同的提示。
 *
 * `protocols` 按探测表顺序给出：`/models` 上的 `{data:[...]}` 是通用兜底（openai-images
 * 打头，旁边还可能是 chat / responses / openrouter），`{models:[...]}` 只证明 Gemini；
 * `/object_info`、`/sdapi/v1/sd-models`、`/API/ListModels` 各自只有一条。
 *
 * 计划外的 `probe` 直接返回 null：这条路由是「按计划探一个」，不做任意路径的 GET 代理。
 */
export async function probeProtocolPath(provider, probe, options = {}) {
  const baseUrl = baseUrlOf(provider || {});
  const path = String(probe || '').trim();
  if (!baseUrl || !path) return null;
  if (!probePathsOf(baseUrl).includes(path)) return null;
  const perProbe = Number(options.probeTimeoutMs) > 0 ? Number(options.probeTimeoutMs) : DETECT_PROBE_MS;
  const expected = ADAPTERS.find((adapter) => adapter.id === options.expected);
  const chosen = expected ? withProtocolOptions(expected, provider) : resolveAdapter(provider, '');
  const outcome = await probeOnce(joinEndpoint(baseUrl, path), provider, options.signal, perProbe, chosen);
  const shape = outcome.shape || '';
  const protocols = shape
    ? PROTOCOL_PROBES.filter((row) => row.path === path && row.accepts.includes(shape)).map((row) => row.protocol)
    : [];
  return { probe: path, shape: shape, protocols: protocols, status: outcome.status, reason: outcome.reason };
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

/* --------------------------------------------------------------- fields */

/**
 * 通用路径的兜底模板：既没命中预设、也没命中字段规则的网关按 OpenAI Images 的形状发
 * （openai-images / custom 这类「只要 OpenAI 兼容就能接」的入口）。
 *
 * 故意**不带 quality**：收不收质量是预设/规则说了算，没声明的网关不发。
 * 参考图写 multipart 的 image[]，因为兜底服务的正是 openai-images 的编辑端点。
 */
const GENERIC_FIELDS = {
  prompt: { path: 'prompt' },
  negative: { path: 'negative_prompt' },
  model: { path: 'model' },
  n: { path: 'n' },
  image: { multipart: 'image[]' }
};

/**
 * 这个协议是不是自己在 execute() / async.build() 里拼 body。
 * 是的话 prepare* 这条路根本走不到（image-execution 先分派给它），所以字段模板也不参与——
 * 别让模板往一个永远不会发出去的 body 里塞字段。`async: true` 是旧式异步入队（提交体仍然
 * 来自 composeBody），不在此列。
 */
function ownsOwnBody(adapter) {
  if (!adapter) return false;
  if (typeof adapter.execute === 'function') return true;
  return Boolean(adapter.async) && typeof adapter.async === 'object';
}

/** Whether the adapter accepts additional HTTP parameters from the model's table. */
export function adapterTakesParamRows(adapter) {
  if (!adapter || typeof adapter !== 'object') return false;
  if (adapter.id === 'a1111' || adapter.acceptsHttpParams === true) return true;
  return !ownsOwnBody(adapter);
}

const ALL_PRESETS = [...PROVIDER_PRESETS, ...LOCAL_PRESETS];
const PRESETS_BY_ID = new Map(ALL_PRESETS.map((preset) => [preset.id, preset]));

/**
 * provider 落在哪份预设上：**同一个模型、同一条协议**的那一份。
 *
 * provider 里没有存预设 id（表单只抄了名字 / 地址 / 协议），所以按「这份预设会选中哪条
 * 协议」反查。比按地址匹配可靠：openai-chat / openai-responses 这类自己拼 body 的协议
 * 没有预设，就不能因为它们挂在 api.openai.com 上白拿一份 OpenAI 的字段模板（那会让面板
 * 凭空多出质量档位）。
 */
function presetForProvider(adapter, provider, model) {
  if (!adapter || !adapter.id) return null;
  const declared = PRESETS_BY_ID.get(provider?.presetId);
  if (declared && resolveAdapterBase(declared, model).id === adapter.id) return declared;
  const host = hostOfBase(baseUrlOf(provider));
  const wantedAdapter = String((provider && provider.adapter) || '').trim().toLowerCase();
  const candidates = [];
  for (const preset of ALL_PRESETS) {
    let resolved;
    try {
      resolved = resolveAdapterBase(preset, model);
    } catch (_error) {
      continue; // 预设自己的地址/协议有问题：跳过它，不影响别的预设
    }
    if (resolved && resolved.id === adapter.id) candidates.push(preset);
  }
  if (!candidates.length) return null;
  // 同一个协议可能对应多份预设（几个 OpenAI 兼容网关、火山方舟的两个入口）：
  // 先按主机收窄，再按 provider 自己填的 adapter 收窄，都没有就取第一份（同协议的模板一致）。
  const sameHost = candidates.filter((preset) => presetMatchesHost(preset, host));
  // 主机命中多份同协议预设时（127.0.0.1:8080 上就有 sd-server 与 LocalAI，方舟也有两个入口），
  // 协议选项可以再消歧一次：选了 edit:'none' 的提供商对应声明 edit:'none' 的那份。
  // 主机一个都没命中说明是自配网关：只挑「没有网关专属声明」的预设，别让排在前面的
  // together / 方舟条目（它们声明了 edit 形态、模板也不一样）被当成通用网关的模板。
  let shortlist;
  if (sameHost.length > 1) shortlist = narrowByOptions(sameHost, provider, adapter.id);
  else if (sameHost.length === 1) shortlist = sameHost;
  else if (adapter.id === 'openai-images') {
    // Preserve the default quality template for automatically selected OpenAI-compatible relays.
    return PRESETS_BY_ID.get(wantedAdapter === 'openai-images' ? 'openai-gateway' : 'openai');
  }
  else shortlist = genericPresets(candidates, adapter.id);
  const sameAdapter = shortlist.filter((preset) => String(preset.adapter || '').trim().toLowerCase() === wantedAdapter);
  return sameAdapter[0] || shortlist[0];
}

/** 自配网关用的候选：先只留「没声明协议选项」的预设（它们描述的是通用 OpenAI 形状）。 */
function genericPresets(presets, adapterId) {
  const plain = presets.filter((preset) => !Object.keys(normalizeProtocolOptions(adapterId, preset.protocolOptions)).length);
  return plain.length ? plain : presets;
}

/**
 * 预设的主机族：baseUrl 带占位符的预设按主机族认领。
 *
 * Azure 的预设地址写着 `YOUR-RESOURCE.openai.azure.com`（给用户改），真实主机名永远
 * 对不上；协议并进 openai-images 之后又不能再靠 `adapter: 'azure-openai'` 反查，
 * 于是这里单独登记一行。Azure 的 fields 与通用形状的差别只有「收质量」这一项，
 * 认不回来面板就凭空少一档质量、线上 body 也少一个 quality。
 *
 * 其它预设的 baseUrl 都是真实地址，不需要登记。
 */
export const PRESET_HOST_FAMILIES = [
  { preset: 'azure', host: /(^|\.)(openai\.azure\.com|services\.ai\.azure\.com)$/ }
];

/** 这份预设属于这个主机吗：先比 baseUrl 主机，再看主机族登记。 */
function presetMatchesHost(preset, host) {
  if (!host) return false;
  if (hostOfBase(preset.baseUrl) === host) return true;
  const family = PRESET_HOST_FAMILIES.find((entry) => entry.preset === preset.id);
  return Boolean(family && family.host.test(host));
}

/**
 * 同一主机上的多份同协议预设，按协议选项收窄：
 * 先取「声明值与 provider 一致」条数最多的，再取「声明得最少」的（越特殊越像特定网关）。
 */
function narrowByOptions(presets, provider, adapterId) {
  const wanted = protocolOptionsOf(upgradeLegacyProtocol(provider), adapterId);
  const declaredOf = (preset) => normalizeProtocolOptions(adapterId, preset.protocolOptions);
  let best = -1;
  let tied = [];
  for (const preset of presets) {
    const declared = declaredOf(preset);
    const score = Object.keys(declared).filter((name) => wanted[name] === declared[name]).length;
    if (score > best) { best = score; tied = [preset]; } else if (score === best) tied.push(preset);
  }
  const fewest = Math.min(...tied.map((preset) => Object.keys(declaredOf(preset)).length));
  return tied.filter((preset) => Object.keys(declaredOf(preset)).length === fewest);
}

/** 用户覆盖：`modelOptions[model].fields`；结构与 size/quality 一样「有用才留」。 */
function fieldOverrideOf(provider, model) {
  const options = provider && typeof provider === 'object' ? provider.modelOptions : null;
  const entry = options && typeof options === 'object' ? options[String(model || '')] : null;
  const fields = entry && entry.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return fields;
}

/**
 * 三层字段模板合并：用户覆盖 > 模型规则 > 预设。
 *
 * 两个出口共用它：通用路径（composeBody）拿它写扁平 body；自己在 execute() / async.build()
 * 里拼 body 的协议也从这里拿字段名——协议决定**用哪条模板**、怎么组装，字段名本身不写字面量。
 * 那些协议要留意两层：
 *   - 三层都没有时**不套用** `GENERIC_FIELDS`（`ownsOwnBody()` 为真），免得凭模型名给它们
 *     发出并不存在的字段；认不出的中转站因此仍然是 OpenAI 兼容行为。
 *   - 命中的可能只有规则层（没有预设的协议，比如 openai-chat），甚至一条都没有 → `{}`；
 *     字段值也可能是 `null`（显式不发），applyFields 会跳过它，别当成「模板丢了」。
 *
 * @returns {object} 逻辑字段 → 模板对象（或 null = 显式不发）
 */
export function fieldsFor(adapter, provider, model) {
  const rule = detectFieldRule(model, provider && provider.baseUrl, adapter?.id || '');
  const preset = presetForProvider(adapter, provider, model);
  const fallback = preset ? preset.fields : (ownsOwnBody(adapter) ? null : GENERIC_FIELDS);
  return resolveFields({
    override: fieldOverrideOf(provider, model),
    rule: rule && rule.fields ? rule.fields : null,
    preset: fallback || null
  });
}

/** Effective wire mappings for either operation, including operation-level overrides. */
export function operationFieldsFor(adapter, provider, model, kind) {
  const operation = adapter.operations?.[kind];
  const fallback = operation?.input === 'explicit' ? null : fieldsFor(adapter, provider, model);
  return resolveFields({ override: operation?.fields, preset: fallback });
}

/**
 * 五个逻辑字段当前的值（参考图不在这里：它只在编辑方向有，由 prepareEdit 单独按模板写，
 * 这样生成体里永远不会多出 image / image_url）。
 */
function fieldValues(adapter, provider, input) {
  return {
    prompt: input.prompt,
    negative: input.negativePrompt,
    model: input.model,
    n: adapter.maxN ? Math.min(input.n || 1, adapter.maxN) : undefined,
    quality: mapQuality(provider, input.model, input.quality, adapter)
  };
}

/**
 * 协议常量：响应形态、输出格式与水印。它们是传输约定，不是「这家网关把提示词叫什么」，
 * 所以不进字段模板。
 *
 * 协议合并成 `openai-images` 之后没有协议 id 能区分「谁要 URL、谁要 png、谁关水印」，
 * 于是改由请求常量规则按「模型 + 主机」给（lib/model-rules.js 的 CONSTANT_RULES）。
 * 规则没命中时回落到协议自己声明的静态值（stability 的 binary 这类还带着）。
 */
function protocolConstants(adapter, provider, input) {
  const rule = detectConstantRule(input && input.model, baseUrlOf(provider));
  const fixed = rule && rule.constants && typeof rule.constants === 'object' ? rule.constants : null;
  const picked = (name, fallback) => (fixed && fixed[name] !== undefined ? fixed[name] : fallback);
  return {
    response_format: picked('response_format', adapter.responseFormat),
    watermark: picked('watermark', adapter.watermark),
    output_format: picked('output_format', adapter.binary ? 'png' : adapter.outputFormat)
  };
}

/**
 * 上游说过不认识的字段（兼容性重试累积的 drops，点分路径）：写在那个位置上的逻辑字段也跳过。
 * 只看首段：`input.negative_prompt` 也会被 `input` 这条挡住，和 preparePhaseAsync 的口径一致。
 */
function withoutDropped(fields, blocked) {
  if (!blocked.size) return fields;
  const kept = {};
  for (const [name, spec] of Object.entries(fields)) {
    const path = spec?.path || spec?.multipart || spec?.numbered || '';
    const head = path ? path.split(/[.[]/)[0] : '';
    if (path && (blocked.has(path) || (head && blocked.has(head)))) continue;
    kept[name] = spec;
  }
  return kept;
}

/** 参数名可以是 a.b.c：逐层建对象，末层放值。 */
function fieldPatch(field, value) {
  const name = String(field || 'size');
  const path = name.split('.').map((part) => part.trim()).filter(Boolean);
  if (path.some((part) => BLOCKED_PATH_KEYS.has(part))) return {};
  if (path.length <= 1) return { [name]: value };
  const root = {};
  let node = root;
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index];
    if (index === path.length - 1) node[key] = value;
    else {
      node[key] = {};
      node = node[key];
    }
  }
  return root;
}

function mergeFields(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeFields(Object.assign({}, target[key] || {}), value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

/* --------------------------------------------------- 参数表（离散行） */

/**
 * 「常规」方框的离散参数表：一行一个参数，存在 `modelOptions[m].params`。
 *
 * 形状与 ComfyUI / A1111 的工作流参数同键不同义：那边每一项都有节点落点
 * （node / input / candidates），语义是「工作流里哪个节点的哪个输入」；这边的行是
 * 「请求体里哪个参数、什么类型、默认值多少」，带 role 的四行还与字段模板对应。
 * 只看形状区分，和 config-store 的 sanitizeParams 用同一个判据。
 */
const PARAM_TABLE_ROLES = ['prompt', 'negative', 'model', 'n'];
const PARAM_VALUE_TYPES = ['text', 'number', 'boolean', 'enum', 'json'];

/** 这一项算不算离散参数行（有节点落点的是工作流参数，不进这张表）。 */
function isParamTableRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (row.node !== undefined || row.input !== undefined || row.candidates !== undefined) return false;
  return typeof row.name === 'string' && row.name.trim() !== '';
}

/** 这个模型的离散参数表；没配 / 存的是工作流参数时返回空数组。 */
function paramTableOf(provider, model) {
  const options = provider && typeof provider === 'object' ? provider.modelOptions : null;
  const entry = options && typeof options === 'object' ? options[String(model || '')] : null;
  const rows = entry && Array.isArray(entry.params) ? entry.params : [];
  return rows.filter(isParamTableRow);
}

/**
 * 参数值按行类型转型：number → 数字、boolean → 布尔、text / enum → 字符串。
 * 转不出来（number 的 "abc"、boolean 的 "maybe"）返回 undefined，调用方当这一行没写。
 */
function paramValueOf(type, raw, options) {
  const kind = PARAM_VALUE_TYPES.includes(String(type || '').toLowerCase())
    ? String(type).toLowerCase()
    : 'text';
  if (kind === 'number') {
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return undefined;
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isFinite(value) ? value : undefined;
  }
  if (kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
    return undefined;
  }
  if (kind === 'enum' && Array.isArray(options) && options.length) {
    return options.some((option) => String(option?.value ?? option) === String(raw)) ? String(raw) : undefined;
  }
  if (kind === 'json') {
    try { return typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw)); } catch (_error) { return undefined; }
  }
  return typeof raw === 'object' ? undefined : String(raw);
}

const BLOCKED_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MANAGED_PARAM_KEYS = ['prompt', 'negative_prompt', 'model', 'image', 'image[]', 'size', 'width', 'height', 'n'];

function safeParamPath(name) {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name)
    && !name.split('.').some((key) => BLOCKED_PATH_KEYS.has(key));
}

function conflictsAt(target, path) {
  const segments = path.split('.');
  let current = target;
  for (const key of segments) {
    if (Array.isArray(current) || current === null || typeof current !== 'object') return true;
    if (!Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

/** HTTP rows with no role are extra parameters. Mapped fields take precedence over additions. */
export function applyHttpParams(body, provider, input, {
  blocked = new Set(), protectedPaths = [], adjustable = [], strict = true
} = {}) {
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  for (const row of paramTableOf(provider, input.model)) {
    const name = row.name.trim();
    if (row.role || !safeParamPath(name) || blocked.has(name) || blocked.has(name.split('.')[0])) continue;
    const overridden = row.expose === true && Object.hasOwn(params, name) && params[name] !== null && params[name] !== undefined;
    const fallback = row.default === undefined || row.default === null ? '' : row.default;
    const raw = overridden ? params[name] : fallback;
    if (!overridden && String(raw).trim() === '') continue;
    const collision = MANAGED_PARAM_KEYS.includes(name) || protectedPaths.some((path) => path === name
      || path.startsWith(name + '.') || path.startsWith(name + '[') || name.startsWith(path + '.'));
    if (collision || (conflictsAt(body, name) && !adjustable.includes(name))) {
      if (strict && overridden) throw new Error('参数 ' + name + ' 已由模型设置或协议管理');
      continue;
    }
    const value = paramValueOf(row.type, raw, row.options);
    if (value === undefined) {
      if (strict && overridden) throw new Error('参数 ' + name + ' 的值不符合 ' + row.type + ' 定义');
      continue;
    }
    // Only the path is merged. A JSON-valued parameter replaces its leaf as a unit.
    let node = body;
    const keys = name.split('.');
    for (const key of keys.slice(0, -1)) node = node[key] ||= {};
    node[keys.at(-1)] = value;
  }
  return body;
}

function formOf(body) {
  const form = new FormData();
  for (const [field, value] of Object.entries(body)) {
    form.append(field, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

export function executeBuiltImage(kind, adapter, provider, input, path, body, signal, options = {}, hooks) {
  const multipart = body instanceof FormData;
  if (!multipart && !options.paramsApplied) applyHttpParams(body, provider, input, options);
  const built = multipart
    ? { path, headers: headersFor(provider, true, adapter.headers, adapter), body }
    : jsonRequest(adapter, provider, path, body);
  return executeImageRequest(kind, adapter, provider, input, () => ({ ...built, note: options.note, allowFieldDrops: false }),
    signal, { ...hooks, sizeHint: () => sizeHintText(provider, input.model, adapter) });
}

/** Legacy role rows mirror the core mappings and fill only unoccupied fields. */
function applyRoleRows(body, fields, values, provider, input, blocked) {
  const rows = paramTableOf(provider, input && input.model);
  if (!rows.length) return;
  for (const row of rows) {
    const name = row.name.trim();
    if (!safeParamPath(name)) continue;
    const head = name.split(/[.[]/)[0];
    if (blocked.has(name) || (head && blocked.has(head))) continue;
    const role = PARAM_TABLE_ROLES.includes(String(row.role || '').toLowerCase())
      ? String(row.role).toLowerCase()
      : '';
    if (!role) continue;
    const spec = fields[role];
    const target = typeof spec?.path === 'string' ? spec.path : spec?.numbered;
    if (!target || conflictsAt(body, name)) continue;
    const value = values[role];
    if (value === undefined || value === null || value === false) continue;
    mergeFields(body, fieldPatch(name, value));
  }
}

/**
 * 通用请求体组装（生成与编辑共用）。
 *
 *   1. 字段模板（override > 规则 > 预设）写 prompt / negative / model / n / quality 五个——
 *      参考图的模板留到 prepareEdit 用，它还要处理「换一个表单字段重试」的 fieldName；
 *   2. 协议常量（response_format / watermark 来自请求常量规则，output_format 来自协议）；
 *   3. 参数表的离散行（内置四行的值与第 1 步同源，用户新增行按默认值注入）；
 *   4. 尺寸字段：不走模板，参数名与嵌套路径由尺寸规则 / 用户覆盖决定。
 *
 * 每一步都过一遍 drops；自己拼 body 的协议只剩第 4 步（保持那条死路径原来的形状）。
 *
 * @returns {{ body: object, fields: object }} fields 是这次实际用到的模板（prepareEdit 要用）
 */
function composeBody(adapter, provider, input, drops, kind) {
  const blocked = drops instanceof Set ? drops : new Set(drops || []);
  const ownBody = ownsOwnBody(adapter);
  const operation = adapter.operations?.[kind];
  const body = operation?.body ? structuredClone(operation.body) : {};
  const explicit = operation?.input === 'explicit';
  const declaredFields = ownBody ? {} : operationFieldsFor(adapter, provider, input.model, kind);
  const fields = withoutDropped(declaredFields, blocked);
  if (!ownBody) {
    const values = { ...fieldValues(adapter, provider, input) };
    if (operation && input.fitted && !input.fitted.omit) {
      const { size, width, height, aspect, tier } = input.fitted;
      Object.assign(values, { size, width, height, aspect: aspect || (width && height ? aspectLabel(width, height) : undefined), tier });
    }
    // 负面词这类可能不是独立字段，而是拼进提示词（模板写 inPrompt / appendToPrompt）；
    // promptParts 负责把它接到提示词后面，再交给 applyFields 写进真正的字段。
    const folded = promptParts(fields, values);
    const written = Object.assign({}, values, { prompt: folded.prompt });
    applyFields(body, fields, written);
    for (const [key, value] of Object.entries(explicit ? {} : protocolConstants(adapter, provider, input))) {
      if (blocked.has(key)) continue;
      if (value === undefined || value === null) continue;
      if (Object.hasOwn(operation?.body || {}, key)) continue;
      body[key] = value;
    }
    if (!explicit) applyRoleRows(body, fields, written, provider, input, blocked);
  }
  // 尺寸字段不走字段模板：用户可以在「模型选项」里把它改成任意参数名（含嵌套路径）。
  const boundSize = operation && ['size', 'width', 'height', 'aspect', 'tier'].some((key) => Object.hasOwn(operation.fields || {}, key));
  const sizePolicy = explicit || boundSize ? null : sizePolicyFor(provider, input.model, adapter);
  for (const [key, value] of Object.entries(sizePolicy ? encodeSize(sizePolicy, input.fitted) : {})) {
    // drops 里是上游点名的线上字段名（`size`），未必等于我们的嵌套路径（`parameters.size`）：
    // 全路径和末段都算命中，别让嵌套尺寸漏掉兼容性重试。
    if (blocked.has(key) || blocked.has(String(key).split('.').pop())) continue;
    mergeFields(body, fieldPatch(key, value));
  }
  if (!ownBody) {
    const protectedPaths = Object.values(declaredFields).flatMap((spec) => [spec?.path, spec?.numbered, spec?.multipart].filter(Boolean))
      .concat(sizeParamPaths(sizePolicy));
    applyHttpParams(body, provider, input, {
      blocked, protectedPaths, adjustable: ['response_format', 'watermark', 'output_format']
    });
  }
  return { body, fields };
}

/**
 * 参考图字段的模板。预设/规则说发到哪；调用方点名要换字段（编辑端点 400 后换一个表单
 * 字段重试）时以它为准。既没有模板也没有点名的老协议仍然挂到 image——这一轮不动
 * `editFields`（见任务 8'），那些本来就不支持编辑的端点要保住原来的（发不出去的）编辑体。
 *
 * 返回 null = 显式不发参考图（`fields.image` 写成 null / false），调用方两个出口都要跳过。
 */
export function imageTemplateFor(fields, requested, multipart) {
  const hasSpec = !!fields && typeof fields === 'object' && Object.prototype.hasOwnProperty.call(fields, 'image');
  const spec = hasSpec ? fields.image : undefined;
  // 显式「不发」：resolveFields 保证 null / false 不被后面的层盖掉，这里必须翻译成
  // 「没有参考图字段」；当成「没配」回落默认字段，用户关掉的图会照样发出去。
  if (hasSpec && (spec === null || spec === false)) return null;
  const fallback = multipart ? { multipart: requested || 'image' } : { path: requested || 'image', as: 'dataUrl' };
  if (!spec || typeof spec !== 'object') return fallback;
  const declared = spec.multipart !== undefined
    ? String(spec.multipart)
    : (typeof spec.path === 'string' ? spec.path : '');
  // 模板说「表单字段」但端点收 JSON：两者对不上时按端点来，别让参考图静默消失
  // （协议合并后同一个主机可能有多份预设，取错预设不能变成「少发一张图」）。
  if (spec.multipart !== undefined && !multipart) return fallback;
  // multipart 端点只认 { multipart }。path 形状的名字里带 []（image[] 这类表单字段）或
  // 正好等于端点字段名的，说明写的本来就是表单字段——换形状，别让文件项在 multipartFields
  // 里消失。multipart 形状自己仍按原逻辑处理（点名别的字段时以点名为准）。
  if (multipart && spec.multipart === undefined && (declared.includes('[]') || declared === requested)) {
    return { multipart: requested || declared };
  }
  if (!requested || !declared || requested === declared) return spec;
  // 嵌套路径（input.image 这类）没法跟表单字段名比对，按模板走。
  if (/[.[]/.test(declared)) return spec;
  return multipart ? { multipart: requested } : { path: requested, as: 'dataUrl' };
}

/** 端点既可以是固定字符串，也可以是按模型拼路径的函数（Ideogram、fal 这类）。 */
function endpointOf(value, input) {
  return typeof value === 'function' ? value(input || {}) : value;
}

function buildConfiguredRequest(adapter, provider, input, kind, body, images, fields, imageFields = {}) {
  const operation = adapter.operations[kind];
  const { method, transport, output } = operation;
  let path = endpointOf(adapter.endpoints[kind], input);
  const headers = headersFor(provider, transport !== 'json', operation.headers, adapter);
  const values = { image: images };
  if (transport === 'multipart') {
    const form = formOf(body);
    const { image: _image, ...mappings } = fields;
    const inputs = { ...fieldValues(adapter, provider, input), ...values };
    if (input.fitted && !input.fitted.omit) {
      const { width, height } = input.fitted;
      Object.assign(inputs, input.fitted, { aspect: input.fitted.aspect || (width && height ? aspectLabel(width, height) : undefined) });
    }
    inputs.prompt = promptParts(fields, inputs).prompt;
    let imageIndex = 0;
    for (const entry of multipartFields({ ...mappings, ...imageFields }, inputs, images)) {
      if (entry.contentType) form.append(entry.name, new Blob([entry.value], { type: entry.contentType }), images[imageIndex++]?.filename || 'image.png');
      else form.append(entry.name, entry.value);
    }
    if (images.length && imageFields.image && !imageFields.image.multipart) {
      throw new Error('multipart 编辑的参考图需要 multipart 字段映射');
    }
    return { path, method, body: form, headers, output, operation };
  }
  if (images.length && imageFields.image) {
    if (imageFields.image.multipart) throw new Error('当前传输方式需要 JSON 或文本形式的参考图映射');
    applyFields(body, imageFields, values);
  }
  if (transport === 'json') return { path, method, body: JSON.stringify(body), headers, output, operation };
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    params.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (transport === 'query') {
    const url = new URL(joinEndpoint(baseUrlOf(provider), path));
    for (const [name, value] of params) url.searchParams.set(name, value);
    path = url.href;
    return { path, method, headers, output, operation };
  }
  headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  return { path, method, body: params.toString(), headers, output, operation };
}

export function prepareGenerate(adapter, provider, input, drops) {
  const { body, fields } = composeBody(adapter, provider, input, drops, 'generate');
  if (adapter.operations?.generate) return buildConfiguredRequest(adapter, provider, input, 'generate', body, [], fields);
  if (adapter.transport.generate === 'multipart') {
    const form = new FormData();
    for (const key of Object.keys(body)) form.append(key, String(body[key]));
    return { path: endpointOf(adapter.endpoints.generate, input), headers: headersFor(provider, true, adapter.headers, adapter), body: form };
  }
  return jsonRequest(adapter, provider, endpointOf(adapter.endpoints.generate, input), body);
}

export function prepareEdit(adapter, provider, input, drops, fieldName) {
  const { body, fields } = composeBody(adapter, provider, input, drops, 'edit');
  // 有些编辑端点不收尺寸（如硅基流动 Qwen-Image-Edit），由适配器逐个模型声明。
  if (typeof adapter.editDrops === 'function') {
    for (const key of adapter.editDrops(input) || []) delete body[key];
  }
  const multipart = adapter.transport.edit === 'multipart';
  const images = (input.images || []).filter((image) => image?.url || (image?.buffer && image.contentType));
  if (adapter.maxEditImages && images.length !== adapter.maxEditImages) {
    throw new Error('该编辑接口需要 ' + adapter.maxEditImages + ' 张参考图。');
  }
  const operation = adapter.operations?.edit;
  const ownImage = Object.hasOwn(operation?.fields || {}, 'image');
  let imageTemplate = ownImage ? fields.image : operation?.input === 'explicit' ? null : imageTemplateFor(fields, fieldName, multipart);
  // 显式「不发参考图」到这里就是空的参考图字段：JSON 与 multipart 两个出口都跳过。
  // 例外只剩「端点本来就没有编辑」（endpoints.edit 为空）：那条路在线上走不到（callImageApi
  // 先报不支持编辑），保住老实现拼出来的那份发不出去的编辑体，别让行为基线跟着变。
  if (!imageTemplate && !adapterSupportsKind(adapter, 'edit')) {
    imageTemplate = imageTemplateFor(null, fieldName, multipart);
  }
  const imageFields = imageTemplate ? { image: imageTemplate } : {};
  if (operation) return buildConfiguredRequest(adapter, provider, input, 'edit', body, images, fields, imageFields);
  if (!multipart) {
    // 非 multipart 的编辑接口（如 SiliconFlow / 火山方舟）用 image 字段承载参考图；
    // 编码形态由模板的 as 决定（dataUrl），单张发字符串，多张发数组。
    if (images.length) applyFields(body, imageFields, { image: images });
    return jsonRequest(adapter, provider, endpointOf(adapter.endpoints.edit, input), body);
  }
  const form = new FormData();
  for (const key of Object.keys(body)) form.append(key, String(body[key]));
  for (const [key, value] of Object.entries(adapter.editExtras || {})) form.append(key, String(value));
  // 参考图是文件项：multipartFields 只负责算出「字段名 + 字节 + 类型」，文件名还得从原图拿。
  const entries = multipartFields(imageFields, { image: images }, images);
  entries.forEach((entry, index) => {
    const image = images[index];
    form.append(entry.name, new Blob([entry.value], { type: entry.contentType }), (image && image.filename) || 'image.png');
  });
  return { path: endpointOf(adapter.endpoints.edit, input), headers: headersFor(provider, true, adapter.headers, adapter), body: form };
}

/** 异步任务：先提交拿 task_id。 */
export function prepareAsync(adapter, provider, input, drops) {
  return jsonRequest(adapter, provider, adapter.submit || endpointOf(adapter.endpoints.generate, input),
    composeBody(adapter, provider, input, drops, 'generate').body);
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
    if (adapter.acceptsHttpParams) applyHttpParams(body, provider, input, { blocked: new Set(wanted) });
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
  const spec = taskSpecOf(adapter) || {};
  // 新描述符可能带 {root}（魔搭）或 pollUrlPath（地址在响应里，这里拼不出来就返回空）；
  // 拼不出来时退回老模板，行为与迁移前一致。
  const target = taskPollTarget(spec, provider, null, taskId);
  if (target) return target;
  const template = String(spec.path || '/tasks/{taskId}');
  return baseUrlOf(provider) + template.replace('{taskId}', encodeURIComponent(taskId));
}

export function pollHeaders(provider) {
  return { Authorization: 'Bearer ' + String((provider && provider.key) || '') };
}

export function readTaskId(adapter, payload) {
  const value = getPath(payload, (taskSpecOf(adapter) || {}).idPath || 'output.task_id');
  return value ? String(value) : null;
}

/** 把不同平台的「排队中 / 成功 / 失败」收敛成一个三态（字段由输出描述符决定）。 */
export function readTaskState(adapter, payload) {
  return taskStateOf(taskSpecOf(adapter) || {}, payload);
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

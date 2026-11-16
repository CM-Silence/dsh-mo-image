/**
 * 配置域：归一化、按 mtime 的读写缓存、凭据解析、当前模型快照与任务级配置快照。
 *
 * 从 lib/index.js 拆出来后，配置读写和工具/路由注册分开；这个模块只依赖
 * adapters 的纯函数与 status 的模型能力判断，不 import index，避免循环依赖。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import {
  resolveAdapter, parseSize, sizePolicyFor, sizeSpecFor, nearestTier, nearestAspect, sizeForAspect,
  qualityOptionsFor, A1111_PARAMS, SIZE_CONTROLS
} from './adapters.js';
import { MAPPING_KEYS, PROMPT_ROLE_NAMES } from './comfy-workflow.js';
import { applyFields } from './field-templates.js';
import { buildImageStatus, editCapableModels, normalizeKeySource } from './status.js';
import { localizedError } from './localized-error.js';

export function emptyConfig() {
  return {
    version: 1, providers: [], active: { providerId: '', model: '' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  };
}
/** 质量值由适配器的 options 决定；这里只保留旧配置里的合法字符串，具体对齐交给 adapter。 */
const QUALITY_VALUES = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'standard', 'hd', 'default', 'quality', 'turbo']);
export function normalizeQuality(value) {
  const raw = String(value || '').trim().toLowerCase();
  // 档位不再锁死在白名单里：模型选项支持自定义档位，合法性在发送时按解析出的 options 判断。
  if (!raw) return 'high';
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(raw)) return 'high';
  return raw;
}
export function normalizeDefaults(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const side = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(4096, Math.max(64, Math.round(number)));
  };
  let width = side(source.width, 0);
  let height = side(source.height, 0);
  if (!width || !height) {
    // 兼容上一版的 { size: "1024x1024" }
    const legacy = /^(\d{2,5})x(\d{2,5})$/.exec(String(source.size || '').trim().toLowerCase().replace(/[×*]/g, 'x'));
    if (legacy) { width = side(legacy[1], 1024); height = side(legacy[2], 1024); }
  }
  const finalWidth = width || 1024;
  const finalHeight = height || 1024;
  return {
    quality: normalizeQuality(source.quality),
    auto: source.auto === undefined ? true : !!source.auto,
    width: finalWidth,
    height: finalHeight,
    // 比例/档位/白名单值：与 width/height 并存，谁生效由适配器的 control 决定。
    // 档位在这里只做字符串清洗（要按模型就近取档得有 adapter，那是 resolveSizeRequest 的事）。
    aspect: String(source.aspect || '').trim() || nearestAspect(finalWidth, finalHeight),
    tier: String(source.tier || '').trim(),
    preset: String(source.preset || '').trim() || (finalWidth + 'x' + finalHeight),
    strict: !!source.strict,
    promptOptimization: source.promptOptimization === undefined ? true : !!source.promptOptimization
  };
}
/** 质量、尺寸都只取选择器默认值；工具不再接受模型传入的参数。 */
export function resolveQuality(defaults) {
  return normalizeQuality(defaults && defaults.quality);
}
export function resolveSizeArg(defaults) {
  if (defaults && defaults.auto === false) return (defaults.width || 1024) + 'x' + (defaults.height || 1024);
  return 'none';
}
/**
 * 尺寸请求：控件的形态决定用户的选择怎么变成一次具体的请求。
 *
 * - wh / prompt：两个宽高输入框直接拼 WxH；
 * - aspect：比例 + 档位合成像素（16:9 + 1K → 1368×768），编码器另外发比例与档位；
 * - preset：档位名原样发（"2K"），custom 时允许直接写 WxH。
 *
 * 自动尺寸下一切交给对话模型：它传了 size 就用它，没传就不带尺寸。
 * @returns {{arg:string, nominal:{width:number,height:number}|null, control:string, aspect:string, tier:string, note:string, stitch:boolean}}
 */
export function resolveSizeRequest(provider, model, defaults, args, adapter) {
  const policy = sizePolicyFor(provider, model, adapter);
  const allowed = Array.isArray(policy.allowed) ? policy.allowed.filter(Boolean) : [];
  const control = String(policy.control
    || (allowed.length ? 'preset' : (policy.style === 'aspect' ? 'aspect' : 'wh')));
  const auto = !(defaults && defaults.auto === false);
  const asked = String((args && args.size) || '').trim();
  const out = {
    arg: 'none', nominal: null, control: control,
    aspect: '', tier: '', note: '', stitch: policy.stitch === true
  };

  if (auto) {
    if (!asked) return out;
    out.arg = asked;
    const parsed = parseSize(asked);
    if (parsed) out.nominal = { width: parsed.width, height: parsed.height };
    return out;
  }

  const width = Number(defaults && defaults.width) || 1024;
  const height = Number(defaults && defaults.height) || 1024;

  if (control === 'aspect') {
    const aspects = Array.isArray(policy.aspects) && policy.aspects.length ? policy.aspects : ['1:1'];
    const wantedAspect = String((defaults && defaults.aspect) || '');
    const aspect = aspects.includes(wantedAspect) ? wantedAspect : nearestAspect(width, height, aspects);
    const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
    const wantedTier = String((defaults && defaults.tier) || '');
    const tier = tiers.find((item) => String(item && item.value) === wantedTier)
      || (tiers.length ? nearestTier(tiers, width * height) : null);
    if (wantedTier && tier && String(tier.value) !== wantedTier) {
      out.note = '档位 ' + wantedTier + ' 不在当前模型的合法档位里，已改用 ' + tier.value;
    }
    const budget = tier ? Number(tier.pixels) : 1024 * 1024;
    const size = sizeForAspect(aspect, budget);
    out.arg = size.width + 'x' + size.height;
    out.nominal = size;
    out.aspect = aspect;
    out.tier = tier ? String(tier.value) : '';
    return out;
  }

  if (control === 'preset') {
    const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
    const candidates = tiers.length ? tiers.map((item) => String(item && item.value)) : allowed;
    const custom = policy.custom === true;
    const wanted = String((defaults && defaults.preset) || '')
      || (width + 'x' + height);
    let value = candidates.includes(wanted) ? wanted : '';
    if (!value && custom && parseSize(wanted)) value = wanted;
    if (!value) {
      const tier = tiers.length ? nearestTier(tiers, width * height) : null;
      value = tier ? String(tier.value) : (candidates[0] || (width + 'x' + height));
      if (wanted && wanted !== value) {
        out.note = '尺寸 ' + wanted + ' 不在当前模型的可选范围里，已改用 ' + value;
      }
    }
    out.arg = value;
    const tier = tiers.find((item) => String(item && item.value) === value);
    if (tier) {
      out.tier = value;
      const side = Math.round(Math.sqrt(Number(tier.pixels))) || 0;
      if (side) out.nominal = { width: side, height: side };
    } else {
      const parsed = parseSize(value);
      if (parsed) out.nominal = { width: parsed.width, height: parsed.height };
    }
    return out;
  }

  out.arg = width + 'x' + height;
  out.nominal = { width: width, height: height };
  if (asked) out.note = '尺寸已由选择器固定为 ' + out.arg + '，已忽略 size：' + asked;
  return out;
}
/** 每个模型的可选配置（目前只有自定义工作流），只保留仍存在的模型，限制体积。 */
const MODEL_WORKFLOW_MAX = 2000000;
/**
 * 映射要么完整，要么没有：任何一项形状不对就整体丢弃，
 * 免得生成时一半注入一半不注入，产出用户看不懂的图。
 */
function sanitizeMapping(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const key of MAPPING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === null) { out[key] = null; continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const node = typeof value.node === 'string' ? value.node.trim() : '';
    const input = typeof value.input === 'string' ? value.input.trim() : '';
    if (!node || !input) return undefined;
    out[key] = { node, input };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 可调参数清单来自解析结果，形状固定：name/node/input/type/default[/options]。
 * 任何一项不合法就整体丢弃——宁可不让模型看到，也不要报一个假的默认值。
 */
function sanitizeParams(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const node = typeof item.node === 'string' ? item.node.trim() : '';
    const input = typeof item.input === 'string' ? item.input.trim() : '';
    // ComfyUI 的参数必须带节点位置；A1111 的参数只是 sdapi 字段名，没有节点。
    if (!name) return undefined;
    if ((node && !input) || (!node && input)) return undefined;
    const param = { name, type: String(item.type || 'string') };
    if (node && input) { param.node = node; param.input = input; }
    if (Array.isArray(item.options)) param.options = item.options.map(String).slice(0, 64);
    if (item.role === true) param.role = true;
    if (item.expose === false) param.expose = false;
    if (Array.isArray(item.candidates)) {
      const seen = new Set();
      param.candidates = [];
      for (const candidate of item.candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const node = typeof candidate.node === 'string' ? candidate.node.trim() : '';
        const input = typeof candidate.input === 'string' ? candidate.input.trim() : '';
        const key = node + '::' + input;
        if (!node || !input || seen.has(key)) continue;
        seen.add(key);
        param.candidates.push({ node, input });
      }
      if (!param.candidates.length) delete param.candidates;
    }
    out.push(param);
  }
  return out.length ? out : undefined;
}

/** 逐项暴露开关：只存布尔值，未出现的项按角色/可调参数各自默认。 */
function sanitizeExpose(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || '').trim();
    if (!name || typeof value !== 'boolean') continue;
    out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 「尺寸参数」覆盖：编码方式 / 参数名 / 分隔符 / 面板控件，全空就当没设。 */
export function sanitizeSizeOption(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mode = ['wh-string', 'wh-fields', 'aspect', 'tier', 'prompt'].includes(String(raw.mode)) ? String(raw.mode) : '';
  const field = typeof raw.field === 'string' ? raw.field.trim().slice(0, 120) : '';
  // 分隔符允许自定义（`|`、`,`、`_` 之类），但只收 1-4 个可见字符，且不能带空白。
  const separator = typeof raw.separator === 'string'
    ? raw.separator.trim().replace(/\s+/g, '').slice(0, 4)
    : '';
  // 面板控件形态（向量模型那种「面板给比例、线上发像素」）：只影响 UI，不影响 body。
  const control = SIZE_CONTROLS.includes(String(raw.control)) ? String(raw.control) : '';
  // 第二个字段：让一个模型同时收到比例和档位（Gemini 的 aspectRatio + imageSize）。
  let second = null;
  if (raw.second && typeof raw.second === 'object' && !Array.isArray(raw.second)) {
    const secondField = typeof raw.second.field === 'string' ? raw.second.field.trim().slice(0, 120) : '';
    if (secondField) {
      second = { from: raw.second.from === 'tier' ? 'tier' : 'aspect', field: secondField };
    }
  }
  if (!mode && !field && !separator && !second && !control) return null;
  const out = {};
  if (mode) out.mode = mode;
  if (field) out.field = field;
  if (separator) out.separator = separator;
  if (second) out.second = second;
  if (control) out.control = control;
  return out;
}

/**
 * 字段模板覆盖：六个逻辑字段各写「发到哪儿」。形状由 field-templates 认，
 * 认不出来的整条丢掉（发送时还会再校验一次，坏模板宁可在这里就没掉）。
 */
export function sanitizeFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, spec] of Object.entries(raw)) {
    const name = String(key || '').trim();
    if (!name) continue;
    if (spec === null || spec === false) { out[name] = null; continue; }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    try {
      applyFields({}, { [name]: spec }, {}); // 只编译，不写值：形状不对会抛
    } catch (_error) {
      continue;
    }
    out[name] = spec;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 模型选项里可上锁的七个键。锁状态只存「与默认不同」的那几个，默认值由客户端按
 * 提供商来源算（预设全锁 / 自定义不锁），所以这里只做形状校验，不猜默认。
 */
export const LOCK_KEYS = ['size', 'quality', 'prompt', 'negative', 'model', 'n', 'image'];

/** 键锁：只认七个已知键上的布尔值；一个都不剩就当没设。 */
function sanitizeLocked(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  for (const key of LOCK_KEYS) {
    if (typeof raw[key] !== 'boolean') continue;
    out[key] = raw[key];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 「质量参数」覆盖：字段名 + 档位表 + 值映射 + 默认档，形状与 qualityOverrideOf() 读到的一致。
 * 档位小写化、`off` 不落盘（它是全局固定档，说了"不发"）；一项都不剩就当没设。
 */
export function sanitizeQualityOption(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const field = typeof raw.field === 'string' ? raw.field.trim().slice(0, 120) : '';
  const options = [];
  for (const item of Array.isArray(raw.options) ? raw.options : []) {
    const value = String(item && item.value !== undefined ? item.value : (item === undefined || item === null ? '' : item))
      .trim().toLowerCase();
    if (!value || value === 'off' || options.includes(value)) continue;
    options.push(value);
  }
  const map = {};
  if (raw.map && typeof raw.map === 'object' && !Array.isArray(raw.map)) {
    for (const [key, value] of Object.entries(raw.map)) {
      const name = String(key || '').trim().toLowerCase();
      if (!name || name === 'off') continue;
      if (typeof value !== 'string') continue;
      map[name] = value;
    }
  }
  const wanted = String(raw.default || '').trim().toLowerCase();
  if (!field && !options.length && !Object.keys(map).length) return null;
  const out = {};
  if (field) out.field = field;
  if (options.length) out.options = options;
  if (Object.keys(map).length) out.map = map;
  if (wanted && wanted !== 'off') out.default = wanted;
  return out;
}

export function normalizeModelOptions(raw, models, adapter) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = new Set(Array.isArray(models) ? models : []);
  // A1111 只有参数开关，没有工作流；其它适配器仍然要求工作流。
  const paramsOnly = adapter === 'a1111';
  for (const model of Object.keys(raw)) {
    if (!allowed.has(model)) continue;
    const entry = raw[model];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const workflow = typeof entry.workflow === 'string' ? entry.workflow.trim() : '';
    if (workflow.length > MODEL_WORKFLOW_MAX) continue;
    const size = sanitizeSizeOption(entry.size);
    const fields = sanitizeFields(entry.fields);
    const quality = sanitizeQualityOption(entry.quality);
    const locked = sanitizeLocked(entry.locked);
    // 只填了「尺寸/质量/字段参数」或只改了锁的模型也要留下（云端中转常见），不强制要求工作流。
    if (!workflow && !paramsOnly && !size && !fields && !quality && !locked) continue;
    const mapping = sanitizeMapping(entry.mapping);
    const params = sanitizeParams(entry.params);
    const expose = sanitizeExpose(entry.expose);
    const next = {};
    if (workflow) next.workflow = workflow;
    if (mapping) next.mapping = mapping;
    if (params) next.params = params;
    if (expose) next.expose = expose;
    if (size) next.size = size;
    if (fields) next.fields = fields;
    if (quality) next.quality = quality;
    if (locked) next.locked = locked;
    if (!Object.keys(next).length) continue;
    out[model] = next;
  }
  return out;
}

export function normalizeConfig(raw) {
  const out = emptyConfig();
  if (!raw || typeof raw !== 'object') return out;
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  for (const item of providers) {
    if (!item || typeof item !== 'object') continue;    const models = Array.from(new Set((Array.isArray(item.models) ? item.models : [])
      .map((m) => String(m || '').trim()).filter(Boolean)));
    const names = {};
    if (item.names && typeof item.names === 'object') for (const model of models) if (typeof item.names[model] === 'string') names[model] = item.names[model];
    const modelOptions = normalizeModelOptions(item.modelOptions, models, item.adapter);
    const key = String(item.key || '');
    const adapterId = String(item.adapter || '');
    const trimmed = (value) => String(value || '').trim();
    const rawEndpoints = item.customEndpoints && typeof item.customEndpoints === 'object' ? item.customEndpoints : {};
    const customEndpoints = {
      generate: trimmed(rawEndpoints.generate),
      edit: trimmed(rawEndpoints.edit),
      models: trimmed(rawEndpoints.models)
    };
    let baseUrl = String(item.baseUrl || '').replace(/\/+$/, '');
    // 自定义协议可以直接填完整地址：baseUrl 空着就取文生图地址的源，鉴权和代理判断还要用它。
    if (!baseUrl && adapterId === 'custom') {
      const origin = /^(https?:\/\/[^/]+)/i.exec(customEndpoints.generate);
      if (origin) baseUrl = origin[1];
    }
    const provider = {
      id: String(item.id || randomUUID()), name: String(item.name || ''),
      baseUrl: baseUrl,
      apiKeyEnv: validKeyRef(item.apiKeyEnv),
      optionalKey: !!item.optionalKey,
      protocol: String(item.protocol || 'openai-images'), adapter: adapterId, models, names
    };
    if (adapterId === 'custom') provider.customEndpoints = customEndpoints;
    // 预设来源：从提供商/本地预设创建时客户端记下的 id（开箱即用的那批）。
    // 它是「这个提供商的字段模板与锁都来自预设」的唯一凭据——没有它就算用户自配，
    // 所以老配置（这个字段还不存在）一律按自配处理，不锁。
    const presetId = typeof item.presetId === 'string' ? item.presetId.trim() : '';
    if (presetId && PRESET_ID.test(presetId)) provider.presetId = presetId;
    // Responses API 需要一个能调工具的主模型；只有这个适配器要留。
    if (provider.adapter === 'openai-responses') {
      const hostModel = String(item.hostModel || '').trim();
      if (hostModel) provider.hostModel = hostModel;
    }
    // 工作流与映射只有 ComfyUI 读，参数开关只有 A1111 读；尺寸/质量这类通用选项谁都要留。
    const keepsWorkflow = provider.adapter === 'comfyui';
    const keepsParams = keepsWorkflow || provider.adapter === 'a1111';
    for (const model of Object.keys(modelOptions)) {
      const entry = modelOptions[model];
      if (!keepsWorkflow) { delete entry.workflow; delete entry.mapping; }
      if (!keepsParams) { delete entry.params; delete entry.expose; }
      if (!Object.keys(entry).length) delete modelOptions[model];
    }
    if (Object.keys(modelOptions).length > 0) provider.modelOptions = modelOptions;
    if (key) provider.key = key;
    out.providers.push(provider);
  }
  const wanted = raw.active && typeof raw.active === 'object' ? raw.active : {};
  const provider = out.providers.find((p) => p.id === wanted.providerId);
  // "auto" 是选择器里的特殊行：允许对话模型在提供商列表内自选模型。
  const wantedModel = String(wanted.model || '').trim();
  const keepModel = wantedModel === 'auto' || (provider && provider.models.includes(wantedModel));
  out.active = { providerId: provider ? provider.id : '', model: keepModel ? wantedModel : '' };
  out.defaults = normalizeDefaults(raw.defaults);
  return out;
}
/** DSH 凭据库（ctx.credentials）里的引用名；只允许我们自己的 MO_IMAGE_ 命名空间。 */
const KEY_REF_PREFIX = 'MO_IMAGE_';
const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 预设 id：与 adapters.js 里的 PROVIDER_PRESETS / LOCAL_PRESETS id 同一套字符集。 */
const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function createConfigStore(options) {
  return {
    configFile: options.configFile,
    ensureDirs: options.ensureDirs,
    logHost: options.logHost,
    credentialsAccessor: options.credentialsAccessor,
    cache: null,
    stamp: '',
    webOriginHost: '',
    keyMigration: null,
    writeQueue: Promise.resolve()
  };
}
export function credentialsService(store) {
  if (!store || typeof store.credentialsAccessor !== 'function') return undefined;
  try { return store.credentialsAccessor(); } catch (_error) { return undefined; }
}
export function validKeyRef(value) {
  const ref = String(value || '').trim();
  return KEY_REF_PATTERN.test(ref) && ref.startsWith(KEY_REF_PREFIX) ? ref : '';
}
/** 按 provider id 生成稳定的环境变量名，例如 MO_IMAGE_P_ABC_API_KEY。 */
export function deriveKeyRef(id, used) {
  const stem = String(id || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PROVIDER';
  const base = KEY_REF_PREFIX + stem + '_API_KEY';
  let ref = base;
  for (let n = 2; used && used.has(ref); n++) ref = base.replace(/_API_KEY$/, '_' + n + '_API_KEY');
  return ref;
}
export function hasLegacyKeys(config) {
  return (config.providers || []).some((provider) => provider.key || !validKeyRef(provider.apiKeyEnv));
}
/** describe() 的 configured 也可能来自环境变量；只有不是 env fallback 才算已存进凭据库。 */
export function credentialIsStored(info) {
  if (!info || !info.configured) return false;
  const source = String(info.source || '');
  return source !== 'env' && source !== 'project-env' && source !== 'user-env';
}

function requestHostName(req) {
  const raw = String((req.headers && req.headers.host) || '').trim().toLowerCase();
  if (!raw) return '';
  const withoutPort = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return withoutPort;
}
/**
 * 配置写接口是本插件自己的本地 HTTP 路由，不走 DSH 的 remote 权限层，所以
 * 至少挡掉跨站浏览器请求和 DNS rebinding：Host 必须是回环、IP 字面量或
 * DSH_WEB_URL 公布的域名；Origin 必须同源；POST 必须是 application/json。
 * 同一 OS 用户的进程本来就能读凭据文件，这里不是对抗同 UID 进程的边界。
 */
export function assertLocalRequest(store, req, write) {
  const hostName = requestHostName(req);
  if (!hostName) {
    const error = new Error('missing Host header'); error.status = 403; throw error;
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  for (const value of [process.env.DSH_WEB_URL, store && store.webOriginHost]) {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.hostname) allowed.add(parsed.hostname.toLowerCase());
    } catch (_error) { /* ignore */ }
  }
  if (!allowed.has(hostName) && isIP(hostName) === 0) {
    const error = new Error('unexpected Host header'); error.status = 403; throw error;
  }
  const origin = req.headers && req.headers.origin;
  if (origin !== undefined) {
    let originUrl;
    try { originUrl = new URL(String(origin)); } catch (_error) {
      const error = new Error('invalid Origin'); error.status = 403; throw error;
    }
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (originUrl.host.toLowerCase() !== hostHeader) {
      const error = new Error('cross-origin request rejected'); error.status = 403; throw error;
    }
  }
  const site = req.headers && req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    const error = new Error('cross-site request rejected'); error.status = 403; throw error;
  }
  if (write) {
    const type = String((req.headers && req.headers['content-type']) || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      const error = new Error('content-type must be application/json'); error.status = 415; throw error;
    }
  }
}
/** 系统提示词节是同步渲染的，这里用 mtime 缓存一份配置副本。 */
export function rememberConfig(store, config) {
  store.cache = config;
  store.stamp = '';
}
export function readConfigSync(store) {
  try {
    const info = statSync(store.configFile);
    const stamp = info.mtimeMs + ':' + info.size;
    if (!store.cache || stamp !== store.stamp) {
      store.cache = normalizeConfig(JSON.parse(readFileSync(store.configFile, 'utf8')));
      store.stamp = stamp;
    }
  } catch (_error) {
    if (!store.cache) store.cache = emptyConfig();
  }
  return store.cache;
}
/** 当前选中的生图模型；编辑也用同一个（严格模式，不做任何回退）。 */
export function activeImageState(store, snapshot) {
  const config = snapshot || readConfigSync(store);
  const provider = (config.providers || []).find((item) => item.id === config.active.providerId);
  const model = String((config.active && config.active.model) || '').trim();
  if (!provider || !model) return null;
  let adapter = null;
  try { adapter = resolveAdapter(provider, model); } catch (_error) { adapter = null; }
  const models = provider.models || [];
  const editModels = editCapableModels(provider, models);
  // 尺寸能力来自模型规则（+ 用户覆盖），不再读协议上的 size 声明。
  const sizePolicy = adapter ? sizePolicyFor(provider, model, adapter) : null;
  const fixedSize = config.defaults.auto === false;
  const sizeRequest = adapter ? resolveSizeRequest(provider, model, config.defaults, {}, adapter) : null;
  const sizeTiers = sizePolicy && Array.isArray(sizePolicy.tiers) ? sizePolicy.tiers : [];
  const sizeAllowed = sizePolicy && Array.isArray(sizePolicy.allowed) ? sizePolicy.allowed : [];
  const sizeOptions = sizeTiers.length
    ? sizeTiers.map((tier) => String(tier.value))
    : sizeAllowed.map(String);
  return {
    provider, model, adapter, models, editModels,
    canEdit: model === 'auto' ? editModels.length > 0 : editCapableModels(provider, [model]).length > 0,
    editModel: model, editAdapter: adapter,
    // 只有 ComfyUI 部署才有工作流参数；用户关掉暴露时不返回。
    workflowParams: workflowParamsOf(provider, model, adapter),
    // 自动尺寸下模型可以自己填 size；固定尺寸下选择器说了算。
    sizeMode: fixedSize ? 'fixed' : 'auto',
    size: fixedSize ? (sizeRequest ? sizeRequest.arg : resolveSizeArg(config.defaults)) : undefined,
    strict: config.defaults.strict === true,
    control: sizeRequest ? sizeRequest.control : '',
    sizeOptions: sizeOptions.length ? sizeOptions : undefined,
    promptOptimization: config.defaults.promptOptimization !== false, defaults: config.defaults
  };
}

/** 凭据解析：状态服务与配置页共用同一套“哪里算有 Key”的口径。 */
export async function resolveStatusKey(store, provider) {
  if (!provider) return { ok: false, source: '', ref: '' };
  if (provider.optionalKey) return { ok: true, source: 'optional', ref: '' };
  const ref = validKeyRef(provider.apiKeyEnv);
  const credentials = credentialsService(store);
  if (ref && credentials && typeof credentials.describe === 'function') {
    try {
      const info = await credentials.describe(ref);
      if (info && info.configured) return { ok: true, source: normalizeKeySource(info.source || 'credentials'), ref };
    } catch (error) {
      store.logHost('status credential describe failed for ' + ref + ': ' + String(error && error.message ? error.message : error));
    }
  }
  if (ref && String(process.env[ref] || '').trim()) return { ok: true, source: 'env', ref };
  if (provider.key) return { ok: true, source: 'config', ref };
  return { ok: false, source: '', ref };
}

/** 只读状态快照：ctx.provide('moImageStatus').describe() 的实现。 */
export async function describeImageStatus(store, version = "0.0.0") {
  const config = await readConfig(store);
  const active = config.active && typeof config.active === 'object' ? config.active : {};
  const provider = (config.providers || []).find((item) => item && item.id === active.providerId) || null;
  const key = await resolveStatusKey(store, provider);
  return buildImageStatus({ config, version: version, key });
}

/** 当前模型的工作流可调参数；非 ComfyUI 或用户逐项关闭时不返回。 */
export function workflowParamsOf(provider, model, adapter) {
  try {
    if (!adapter) return undefined;
    const options = provider && provider.modelOptions ? provider.modelOptions : null;
    if (!options || typeof options !== 'object') return undefined;
    if (adapter.id === 'a1111') {
      // A1111 没有工作流，参数清单固定；默认全关，只返回用户勾上的。
      const own = options[model];
      const source = own && own.expose ? own : Object.values(options).find((entry) => entry && entry.expose);
      const expose = (source && source.expose) || {};
      const exposed = A1111_PARAMS.filter((param) => expose[param.name] === true);
      return exposed.length ? exposed : undefined;
    }
    if (adapter.id !== 'comfyui') return undefined;
    const entry = options[model];
    if (!entry || !Array.isArray(entry.params)) return undefined;
    const expose = entry.expose && typeof entry.expose === 'object' ? entry.expose : {};
    const exposed = entry.params.filter((param) => {
      if (!param) return false;
      // 提示词和负面词由工具参数直接注入，永远不进 params（旧配置里可能还存着它们）。
      if (PROMPT_ROLE_NAMES.has(param.name)) return false;
      return expose[param.name] === true;
    });
    return exposed.length ? exposed : undefined;
  } catch (_error) { return undefined; }
}
export function canUseCredentials(store) {
  const credentials = credentialsService(store);
  return !!(credentials && typeof credentials.describe === 'function' && typeof credentials.resolve === 'function' && typeof credentials.set === 'function');
}
/** 浏览器只拿 hasKey/keySource，永远拿不到明文密钥。 */
export async function publicConfig(store, config) {
  const credentials = credentialsService(store);
  const providers = await Promise.all((config.providers || []).map(async (provider) => {
    const copy = Object.assign({}, provider);
    delete copy.key;
    const ref = validKeyRef(provider.apiKeyEnv);
    let hasKey = false;
    let keySource = '';
    if (ref && credentials && typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(ref);
        hasKey = !!info.configured;
        keySource = info.source || '';
      } catch (error) { store.logHost('credential describe failed for ' + ref + ': ' + String(error && error.message ? error.message : error)); }
    }
    if (!hasKey && ref && process.env[ref]) { hasKey = true; keySource = 'env'; }
    if (!hasKey && provider.key) { hasKey = true; keySource = 'config'; }
    return Object.assign(copy, { hasKey: hasKey, keySource: keySource });
  }));
  return Object.assign({}, config, { providers: providers });
}
/** 选择器用的模型能力表：每个模型可用哪些质量档、尺寸控件长什么样。 */
export function capabilityManifest(config) {
  return (config.providers || []).map((provider) => ({
    providerId: provider.id,
    models: (provider.models || []).map((model) => {
      let adapter = null;
      let quality = null;
      try { adapter = resolveAdapter(provider, model); quality = qualityOptionsFor(provider, model, adapter); } catch (_error) { adapter = null; quality = null; }
      return { model: model, quality: quality, size: sizeSpecFor(provider, model, adapter) };
    })
  }));
}
/**
 * 把旧版 config.json 里的明文 key 迁到 DSH 凭据库，并在配置里只留下 apiKeyEnv 引用。
 * 凭据服务不存在（自定义 composition）时保持旧字段，避免把用户锁死。
 */
export async function migrateConfigKeys(store, input) {
  if (!canUseCredentials(store)) return input;
  const credentials = credentialsService(store);
  const config = normalizeConfig(input);
  const used = new Set();
  let migrated = 0;
  let changed = false;
  for (const provider of config.providers) {
    let ref = validKeyRef(provider.apiKeyEnv);
    if (!ref) {
      ref = deriveKeyRef(provider.id, used);
      provider.apiKeyEnv = ref;
      changed = true;
    } else if (used.has(ref)) {
      ref = deriveKeyRef(provider.id, used);
      provider.apiKeyEnv = ref;
      changed = true;
    }
    used.add(ref);
    if (!provider.key) continue;
    try {
      const info = await credentials.describe(ref);
      if (!credentialIsStored(info)) {
        await credentials.set(ref, provider.key);
        migrated++;
      }
      delete provider.key;
      changed = true;
    } catch (error) {
      store.logHost('credential migration failed for provider ' + provider.id + ': ' + String(error && error.message ? error.message : error));
    }
  }
  if (!changed) return config;
  const saved = await writeConfig(store, config);
  if (migrated > 0) store.logHost('migrated ' + migrated + ' API key(s) to credentials store');
  return saved;
}
export function migrateKeysOnce(store, config) {
  if (!store.keyMigration) store.keyMigration = migrateConfigKeys(store, config).finally(() => { store.keyMigration = null; });
  return store.keyMigration;
}
export async function readConfig(store) {
  try {
    if (!existsSync(store.configFile)) {
      const empty = emptyConfig();
      rememberConfig(store, empty);
      return empty;
    }
    let config = normalizeConfig(JSON.parse(await readFile(store.configFile, 'utf8')));
    if (hasLegacyKeys(config) && canUseCredentials(store)) {
      try { config = await migrateKeysOnce(store, config); } catch (error) { store.logHost('config key migration failed: ' + String(error && error.message ? error.message : error)); }
    }
    rememberConfig(store, config);
    return config;
  } catch (_error) { return emptyConfig(); }
}
export async function writeConfig(store, config) {
  const next = normalizeConfig(config);
  const task = store.writeQueue.then(async () => {
    store.ensureDirs();
    const tempFile = store.configFile + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8);
    try {
      await writeFile(tempFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tempFile, store.configFile);
    } finally {
      try { await unlink(tempFile); } catch (_error) { /* rename 成功后临时文件已不存在 */ }
    }
    rememberConfig(store, next);
    return next;
  });
  store.writeQueue = task.catch(() => {});
  return task;
}
/** 每次请求才解析一次密钥；不在内存里长期缓存，轮换后下一请求生效。 */
export async function resolveProviderCredential(store, provider) {
  const ref = validKeyRef(provider.apiKeyEnv);
  const credentials = credentialsService(store);
  if (ref) {
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(ref);
        if (hit && typeof hit.value === 'string' && hit.value.trim().length > 0) {
          return Object.assign({}, provider, { key: hit.value.trim() });
        }
      } catch (error) { store.logHost('credential resolve failed for ' + ref + ': ' + String(error && error.message ? error.message : error)); }
    }
    const env = process.env[ref];
    if (env && env.trim()) return Object.assign({}, provider, { key: env.trim() });
  }
  if (provider.key) return provider;
  if (provider.optionalKey) return provider;
  throw localizedError(
    new Error('生图提供商「' + (provider.name || provider.id) + '」缺少 API Key，请到 DSH 设置 → 生图模型填写'
      + (ref ? '（凭据 ' + ref + '）' : '') + '。'),
    ref ? 'provider.missingKeyWithRef' : 'provider.missingKey',
    { provider: provider.name || provider.id, ref: ref }
  );
}
/** 保存配置前先把每个 provider 的新 key 写进凭据库，配置文件只保留 apiKeyEnv。 */
export async function saveConfigWithCredentials(store, raw) {
  const incoming = normalizeConfig(raw);
  const current = await readConfig(store);
  const credentials = credentialsService(store);
  const canStore = !!(credentials && typeof credentials.set === 'function');
  const canDescribe = !!(credentials && typeof credentials.describe === 'function');
  const currentById = new Map(current.providers.map((provider) => [provider.id, provider]));
  const used = new Set();
  const providers = [];
  for (const provider of incoming.providers) {
    const old = currentById.get(provider.id);
    let ref = validKeyRef(provider.apiKeyEnv) || validKeyRef(old && old.apiKeyEnv) || deriveKeyRef(provider.id, used);
    if (used.has(ref)) ref = deriveKeyRef(provider.id, used);
    used.add(ref);
    provider.apiKeyEnv = ref;
    const newKey = String(provider.key || '').trim();
    delete provider.key;
    if (newKey) {
      if (!canStore) throw localizedError(new Error('DSH 凭据服务未挂载，无法安全保存 API Key；请确认 base composition 包含 dsh-credentials-local。'), 'config.credentialsUnavailable');
      try {
        await credentials.set(ref, newKey);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        throw localizedError(new Error('保存 API Key 失败：' + message), 'config.credentialSaveFailed', { message: message });
      }
    } else if (old && old.key) {
      if (canStore && canDescribe) {
        try {
          const info = await credentials.describe(ref);
          if (!credentialIsStored(info)) await credentials.set(ref, old.key);
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          throw localizedError(new Error('旧 API Key 迁移失败：' + message), 'config.legacyKeyMigrationFailed', { message: message });
        }
      } else {
        provider.key = old.key;
      }
    }
    providers.push(provider);
  }
  if (credentials && typeof credentials.unset === 'function') {
    const kept = new Set(providers.map((provider) => provider.id));
    for (const old of current.providers) {
      if (kept.has(old.id)) continue;
      const ref = validKeyRef(old.apiKeyEnv);
      if (!ref || used.has(ref)) continue;
      try { await credentials.unset(ref); } catch (error) { store.logHost('credential removal failed for ' + ref + ': ' + String(error && error.message ? error.message : error)); }
    }
  }
  incoming.providers = providers;
  try {
    return await writeConfig(store, incoming);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    throw localizedError(new Error('保存生图配置失败：' + message), 'config.writeFailed', { message: message });
  }
}

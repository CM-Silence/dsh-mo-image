/**
 * 配置域：归一化、按 mtime 的读写缓存、凭据解析、当前模型快照与任务级配置快照。
 *
 * 从 lib/index.js 拆出来后，配置读写和工具/路由注册分开；这个模块只依赖
 * adapters 的纯函数与 status 的模型能力判断，不 import index，避免循环依赖。
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import {
  resolveAdapter, parseSize, sizePolicyFor, sizeSpecFor, nearestTier, nearestAspect, sizeForAspect,
  qualityOptionsFor, fieldsFor, A1111_PARAMS, SIZE_CONTROLS, adapterTakesParamRows,
  upgradeLegacyProtocol, normalizeProtocolOptions, PROVIDER_PRESETS, LOCAL_PRESETS,
  PRESET_HOST_FAMILIES
} from './adapters.js';
import { normalizeAuthSpec, resolveHttpUrl } from './adapter-kit.js';
import { normalizeOperations, normalizeResponseOverrides } from './provider-operations.js';
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

/* ── 一张参数表，两种绑定 ──────────────────────────────────────────────
 *
 * 行有两种绑定，**只看形状**区分（没有顶层判别键，也不新增键）：
 *
 *   工作流行  { node, input, type, default?, description?, expose?, options?, role?, name?, locked? }
 *              `node` + `input` 指向工作流里哪个节点的哪个输入（ComfyUI）；
 *              `name` 是给对话模型用的参数键，省略时等于 `input`。
 *   HTTP 行   { name, type, default?, description?, expose?, options?, role?, locked? }
 *              `name` 是请求体里的路径（A1111 的 sdapi 字段名也走这条）。
 *
 * `locked: true` 是行级锁：一键配置/自动检测不会改写这一行（不写 = 未锁）。
 *
 * 两张表共用同一个数组（`modelOptions[m].params`），所以 `sanitizeParams` 逐行分派：
 * 有节点落点的按工作流行校验，其余按参数表校验。坏行逐条丢掉——宁可少一行，
 * 也不要留一条默认值/落点说不清的行。
 *
 * 类型词表也统一成四个值（text / number / boolean / enum）。老的 ComfyUI 配置里
 * 写的 INT / FLOAT / STRING 在这里折过来，读一次就完成迁移。
 */

/** 内置四行的 role（只有这四行跟 fields 里的逻辑字段对应）。 */
const PARAM_ROLES = ['prompt', 'negative', 'model', 'n'];
/** 老工作流参数的类型词表：读进来折成参数表的四个值（text / number / boolean / enum）。 */
const LEGACY_PARAM_TYPES = {
  int: 'number', integer: 'number', float: 'number', double: 'number', number: 'number',
  string: 'text', str: 'text', text: 'text',
  bool: 'boolean', boolean: 'boolean',
  enum: 'enum', json: 'json'
};
const PARAM_ROWS_MAX = 64;
const PARAM_NAME_MAX = 64;
const PARAM_DEFAULT_MAX = 120;
const PARAM_DESCRIPTION_MAX = 200;
const PARAM_OPTION_MAX = 40;
const PARAM_OPTIONS_MAX = 64;

/** 这一项是不是工作流行（有节点落点）。 */
function isWorkflowParamShape(item) {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    && (Object.prototype.hasOwnProperty.call(item, 'node')
      || Object.prototype.hasOwnProperty.call(item, 'input')
      || Object.prototype.hasOwnProperty.call(item, 'candidates'));
}

/** 选项：数组或逗号分隔的字符串都收；去空、去重、限长限量。 */
function sanitizeParamOptions(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(/[,，]/);
  else return [];
  const out = [];
  for (const item of list) {
    const value = String(item === undefined || item === null ? '' : item).trim().slice(0, PARAM_OPTION_MAX);
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= PARAM_OPTIONS_MAX) break;
  }
  return out;
}

/** 四个值以外的类型（INT / FLOAT / STRING …）按老词表折；认不出的当文本。 */
function paramTypeOf(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return LEGACY_PARAM_TYPES[text] || 'text';
}

function paramDescriptionOf(raw) {
  return typeof raw === 'string' ? raw.trim().slice(0, PARAM_DESCRIPTION_MAX) : '';
}

function paramDefaultOf(raw, maxLength = PARAM_DEFAULT_MAX) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'object') {
    try { return JSON.stringify(raw).slice(0, maxLength); } catch (_error) { return ''; }
  }
  return String(raw).trim().slice(0, maxLength);
}

/**
 * 工作流行：`node` + `input` 是落点，`name` 是给对话模型看的键。
 *
 * `name` 缺省时等于 `input`（解析出来的候选就是这样）；显式写了空名字算坏行，
 * 免得一条没有键的行悄悄占住位置。
 */
function sanitizeWorkflowRow(item) {
  const node = typeof item.node === 'string' ? item.node.trim() : '';
  const input = typeof item.input === 'string' ? item.input.trim() : '';
  if (!node || !input) return null;
  let name = input;
  if (item.name !== undefined) {
    if (typeof item.name !== 'string') return null;
    name = item.name.trim().slice(0, PARAM_NAME_MAX);
    if (!name) return null;
  }
  const row = {
    name: name,
    node: node,
    input: input,
    type: paramTypeOf(item.type)
  };
  if (Object.prototype.hasOwnProperty.call(item, 'default')) row.default = paramDefaultOf(item.default);
  const description = paramDescriptionOf(item.description);
  if (description) row.description = description;
  if (item.expose === true) row.expose = true;
  else if (item.expose === false) row.expose = false;
  // 行级锁：只存 true（不写 = 未锁）。一键配置/自动检测只改未锁的行。
  if (item.locked === true) row.locked = true;
  if (item.role === true) row.role = true;
  const options = sanitizeParamOptions(item.options);
  if (options.length) row.options = options;
  if (Array.isArray(item.candidates)) {
    const seen = new Set();
    const candidates = [];
    for (const candidate of item.candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const cNode = typeof candidate.node === 'string' ? candidate.node.trim() : '';
      const cInput = typeof candidate.input === 'string' ? candidate.input.trim() : '';
      const key = cNode + '::' + cInput;
      if (!cNode || !cInput || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ node: cNode, input: cInput });
    }
    if (candidates.length) row.candidates = candidates;
  }
  return row;
}

/**
 * 离散参数表（HTTP 行）：一行一个参数。坏行逐条丢掉（名字为空），其余字段尽量归一。
 * 提示词行是固定行：无论存成什么样，落盘都必须是 text / 空默认 / 暴露。
 */
function sanitizeTableRow(item, roles) {
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, PARAM_NAME_MAX) : '';
  if (!name) return null;
  const role = PARAM_ROLES.includes(String(item.role || '').toLowerCase())
    ? String(item.role).toLowerCase()
    : '';
  // 内置 role 只允许一行：重复的当用户行处理会把它变成「假的内置行」，干脆丢掉。
  if (role && roles.has(role)) return null;
  if (role) roles.add(role);
  const type = role === 'prompt' ? 'text' : paramTypeOf(item.type);
  const param = {
    name,
    type,
    default: role === 'prompt' ? '' : paramDefaultOf(item.default, type === 'json' ? 8192 : PARAM_DEFAULT_MAX),
    description: paramDescriptionOf(item.description)
  };
  // 模型行的暴露是运行时按「选择器是不是自动」推导的（modelRowExposed），行上的值没人读；
  // 写进来只会在 config.json 里留下「看着生效其实无效」的字段（expose:false 尤其误导）。
  if (role !== 'model') param.expose = role === 'prompt' ? true : item.expose === true;
  // 行级锁：只存 true（不写 = 未锁）。一键配置/自动检测只改未锁的行。
  if (item.locked === true) param.locked = true;
  if (role) param.role = role;
  const options = sanitizeParamOptions(item.options);
  if (options.length) param.options = options;
  return param;
}

function validateAdvancedRows(provider) {
  const table = provider.modelOptions;
  if (!table || typeof table !== 'object') return;
  for (const [model, entry] of Object.entries(table)) {
    if (!Array.isArray(entry?.params)) continue;
    for (const row of entry.params) {
      if (row?.type !== 'json' || row.default === undefined || row.default === null) continue;
      const value = typeof row.default === 'string' ? row.default.trim() : JSON.stringify(row.default);
      if (value === '') continue;
      try {
        if (value.length > 8192) throw new Error('too large');
        JSON.parse(value);
      } catch (_error) {
        throw new Error(model + ' 的参数 ' + row.name + ' 需要有效的 JSON 默认值，长度至多 8192 字符');
      }
    }
  }
}

/** 行序：四个内置 role 按固定顺序排在前面（提示词永远第一），其余保持原序。 */
function sortParamRows(rows) {
  const rank = (param) => (param.role ? PARAM_ROLES.indexOf(param.role) : PARAM_ROLES.length);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/** 只收 HTTP 行的那张表（老入口，行为不变）。 */
export function sanitizeParamTable(raw) {
  if (!Array.isArray(raw)) return undefined;
  const roles = new Set();
  const out = [];
  for (const item of raw) {
    if (out.length >= PARAM_ROWS_MAX) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (isWorkflowParamShape(item)) continue; // 工作流行不属于这张表
    const row = sanitizeTableRow(item, roles);
    if (row) out.push(row);
  }
  return out.length ? sortParamRows(out) : undefined;
}

/**
 * params 的入口：逐行按形状分派，两种绑定混在同一个数组里，保持用户的行序
 * （只有内置 role 行会被提到最前，提示词永远第一）。
 */
function sanitizeParams(raw) {
  if (!Array.isArray(raw)) return undefined;
  const roles = new Set();
  const out = [];
  for (const item of raw) {
    if (out.length >= PARAM_ROWS_MAX) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (isWorkflowParamShape(item)) {
      const row = sanitizeWorkflowRow(item);
      if (row) out.push(row);
      continue;
    }
    const row = sanitizeTableRow(item, roles);
    if (row) out.push(row);
  }
  const names = new Set();
  const unique = sortParamRows(out).filter((row) => {
    if (isWorkflowParamShape(row)) return true;
    if (names.has(row.name)) return false;
    names.add(row.name);
    return true;
  });
  return unique.length ? unique : undefined;
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
    if (!['prompt', 'negative', 'model', 'n', 'image', 'quality'].includes(name)) continue;
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
 * 「质量参数」覆盖：收不收 + 字段名 + 档位表 + 值映射 + 默认档。
 *
 * 形状（与 qualityOverrideOf() 读到的一致）：
 *   { supported: boolean, field?, options?: [{ label, value, default }], map?, default? }
 *
 * 两种输入都收，输出一律是新形状——老配置（`options: ['low']` + 顶层 `default: 'low'`）
 * 读进来按 `supported: true` + 空显示名处理，档位小写化、`off` 不落盘（它是全局固定档，
 * 语义是"不发"）。
 *
 * `supported` 永远写出来（哪怕 true）：草稿与落盘的形状一致，回读才不会把「勾着」变成
 * 「没配」。只有 `supported: false` 一项也算一份有效配置——那是用户明确说了「这个模型
 * 不发质量参数」，丢了它下次就会被规则重新打开。
 */
export function sanitizeQualityOption(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const field = typeof raw.field === 'string' ? raw.field.trim().slice(0, 120) : '';
  const options = [];
  for (const item of Array.isArray(raw.options) ? raw.options : []) {
    const object = Boolean(item) && typeof item === 'object' && !Array.isArray(item);
    const value = String(object
      ? (item.value === undefined || item.value === null ? '' : item.value)
      : (item === undefined || item === null ? '' : item))
      .trim().toLowerCase();
    if (!value || value === 'off' || options.some((option) => option.value === value)) continue;
    const label = object && typeof item.label === 'string' ? item.label.trim().slice(0, 40) : '';
    options.push({ label: label, value: value, default: object && item.default === true });
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
  // 默认档只有一处：新形状挂在某一条上，老形状在顶层。两处打架时以标了 default 的那条
  // 为准（那是用户在面板里点过单选的），而且必须落在自己的档位表里。
  const flagged = options.find((option) => option.default);
  const declared = String(raw.default || '').trim().toLowerCase();
  const wanted = flagged ? flagged.value : declared;
  const chosen = wanted && wanted !== 'off' && options.some((option) => option.value === wanted) ? wanted : '';
  for (const option of options) option.default = Boolean(chosen) && option.value === chosen;
  const supported = raw.supported === false ? false : true;
  if (!field && !options.length && !Object.keys(map).length && raw.supported !== false) return null;
  const out = { supported: supported };
  if (field) out.field = field;
  if (options.length) out.options = options;
  if (Object.keys(map).length) out.map = map;
  if (chosen) out.default = chosen;
  return out;
}

export function normalizeModelOptions(raw, models, adapter) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = new Set(Array.isArray(models) ? models : []);
  // A1111 没有工作流；其它适配器只要有尺寸/质量/字段模板/参数表就不强制要求工作流。
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
    // 参数表也属于「只填了它」的合法配置（云端中转常见），不强制要求工作流。
    const params = sanitizeParams(entry.params);
    const operations = readOperations(entry.operations, true, adapter === 'custom');
    // 只填了「尺寸/质量/字段参数/参数表」或只改了锁的模型也要留下。
    if (!workflow && !paramsOnly && !size && !fields && !quality && !locked && !params && !operations) continue;
    const mapping = sanitizeMapping(entry.mapping);
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
    if (operations) next.operations = operations;
    if (!Object.keys(next).length) continue;
    out[model] = next;
  }
  return out;
}

/**
 * 提供商的鉴权方式（`provider.auth`）——「协议 / 鉴权 / 输入 / 输出」四条里的第二条。
 *
 * 读的顺序（先写的赢）：
 *   1. 显式写下来的 `provider.auth`（新配置只有这一条路）；
 *   2. 老配置的 `protocolOptions.auth`（当年只有 bearer / api-key 两个取值）；
 *   3. 老协议 id 迁移表给的（azure-openai → api-key，见 upgradeLegacyProtocol）。
 *
 * 写回只写 `provider.auth`：`protocolOptions` 那一层不再出现 auth，但同层的其它选项
 * （`edit`）原样留着——那些仍然是协议属性，不该被这次搬家带走。
 *
 * 认不出（mode 不在白名单、custom 没有合法头名、形状不对）就返回 null，等于没设：
 * 请求时按协议默认（adapter.authHeader）回落，缺省 bearer。
 */
function normalizeProviderAuth(item, upgraded) {
  const legacy = item && item.protocolOptions && typeof item.protocolOptions === 'object'
    ? item.protocolOptions.auth
    : undefined;
  return normalizeAuthSpec(item && item.auth)
    || normalizeAuthSpec({ mode: legacy })
    || normalizeAuthSpec(upgraded && upgraded.auth)
    || null;
}

export function invalidProviderOperations(error) {
  const message = error.message || String(error);
  const wrapped = localizedError(new Error(message), 'provider.invalidOperations', { message });
  wrapped.status = 400;
  return wrapped;
}

function readOperations(raw, modelOnly, custom) {
  // Keep invalid stored data visible for correction. Resolution will fail before submitting.
  try { return (custom ? normalizeOperations : normalizeResponseOverrides)(raw, modelOnly); } catch (_error) { return raw; }
}

/* ── 预设身份推断（presetId 回填） ───────────────────────────────────────
 *
 * `provider.presetId` 记的是「这个提供商是从哪份预设建的」，客户端据此判「预设来源」：
 * 协议设置整块不渲染、键默认全锁、一键配置不出现。这个字段是后加的，升级前建的
 * 配置里没有它 —— 老用户于是被当成「自定义 API」，协议设置的折叠区又冒了出来，
 * 与预设带来的字段模板、锁默认值都不一致。
 *
 * 回填只有一个证据：**地址就是这个预设的地址**。地址被手改过（换域名、换路径、加查询串）
 * 说明用户换了一家网关，一概不填 —— 补错了会把他正要用的协议设置重新藏起来。
 * 地址命中多份预设（百炼两条预设共用一个地址、127.0.0.1:8080 上同时有 sd-server 与
 * LocalAI）也不填：光凭地址分不出来，猜一个不如不猜。
 */

/** 预设地址里留给用户改的那一段（azure 的 `YOUR-RESOURCE`）：这类预设只能比主机后缀。 */
const PRESET_PLACEHOLDER = /^your-|[{<>}]/;

/**
 * 预设地址的身份键：主机 + 路径，小写、去尾斜杠、末尾 `/v1` 视为可省。
 *
 * 只归一化「同一个地址的写法差异」：大小写、尾部斜杠、带不带 /v1 —— 这几样是手抄地址
 * 时最常见的偏差，不代表换了服务。带查询串 / 片段的一律不算预设地址（预设里没有这些，
 * 出现它只能是用户手改过的）。
 */
function presetBaseKey(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch (_error) { return ''; }
  if (url.search || url.hash) return '';
  const path = url.pathname.replace(/\/+$/, '').toLowerCase().replace(/\/v1$/, '');
  return url.host.toLowerCase() + path;
}

/** 只取主机（含端口，小写）：本地部署按「同一台机器」认。 */
function hostOfUrl(baseUrl) {
  try { return new URL(String(baseUrl || '').trim()).host.toLowerCase(); } catch (_error) { return ''; }
}

/** 占位符预设的主机后缀：把占位标签（`YOUR-RESOURCE`）去掉之后剩下的部分。 */
function placeholderHostSuffix(preset) {
  const host = hostOfUrl(preset.baseUrl);
  if (!host) return '';
  const labels = host.split('.');
  if (!labels.some((label) => PRESET_PLACEHOLDER.test(label))) return '';
  const fixed = labels.filter((label) => !PRESET_PLACEHOLDER.test(label));
  return fixed.length >= 2 ? fixed.join('.') : '';
}

/** 这份预设认这个主机吗：登记过的主机族（azure 的另一个域名）或占位符预设的主机后缀。 */
function presetClaimsHost(preset, host) {
  if (!host) return false;
  const family = PRESET_HOST_FAMILIES.find((entry) => entry.preset === preset.id);
  if (family && family.host.test(host)) return true;
  const suffix = placeholderHostSuffix(preset);
  return Boolean(suffix) && (host === suffix || host.endsWith('.' + suffix));
}

/**
 * 预设身份的索引（模块级只算一次）：地址键 / 本地主机 → preset id 列表。
 *
 * 值是列表而不是单值：撞车本来就存在（百炼两条预设同一个地址），由调用方判唯一。
 */
let presetIndexCache = null;
function presetIndex() {
  if (presetIndexCache) return presetIndexCache;
  const byKey = new Map();
  const byHost = new Map();
  const claims = [];
  const add = (map, key, id) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(id); else map.set(key, [id]);
  };
  for (const preset of PROVIDER_PRESETS) {
    add(byKey, presetBaseKey(preset.baseUrl), preset.id);
    const family = PRESET_HOST_FAMILIES.find((entry) => entry.preset === preset.id);
    if (family || placeholderHostSuffix(preset)) claims.push(preset);
  }
  // 本地部署只认主机（含端口）：本地服务的路径常被反向代理改掉，默认端口才是它的身份。
  for (const preset of LOCAL_PRESETS) add(byHost, hostOfUrl(preset.baseUrl), preset.id);
  presetIndexCache = { byKey: byKey, byHost: byHost, claims: claims };
  return presetIndexCache;
}

/**
 * 按地址反查预设 id：唯一命中才返回，否则返回空串（= 不回填）。
 *
 *   - 云端预设：整条地址归一化后完全相同；地址带占位符的（azure）按主机后缀认；
 *   - 本地预设：主机（含端口）等于它的默认地址。
 *
 * 只给「老配置补来源」用；已经有 presetId 的提供商不许用地址推翻它。
 */
export function presetIdForBaseUrl(baseUrl) {
  const key = presetBaseKey(baseUrl);
  const host = hostOfUrl(baseUrl);
  if (!key || !host) return '';
  const index = presetIndex();
  const hits = new Set(index.byKey.get(key) || []);
  for (const preset of index.claims) if (presetClaimsHost(preset, host)) hits.add(preset.id);
  for (const id of index.byHost.get(host) || []) hits.add(id);
  return hits.size === 1 ? hits.values().next().value : '';
}

export function normalizeConfig(raw) {
  const out = emptyConfig();
  if (!raw || typeof raw !== 'object') return out;
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  for (const item of providers) {
    if (!item || typeof item !== 'object') continue;
    const models = Array.from(new Set((Array.isArray(item.models) ? item.models : [])
      .map((m) => String(m || '').trim()).filter(Boolean)));
    const names = {};
    if (item.names && typeof item.names === 'object') for (const model of models) if (typeof item.names[model] === 'string') names[model] = item.names[model];
    // 协议序：老版本的六条 OpenAI Images 家族协议已经合并成 openai-images，
    // 这里按 upgradeLegacyProtocol（迁移表 LEGACY_PROTOCOL_ALIASES）改写一次，
    // 连同它们的编辑形态选项。
    // 幂等：改写后的值不再命中迁移表，再跑一遍什么都不会变。
    // 改写只动 adapter / protocol / protocolOptions，presetId 与 modelOptions 原样留下。
    const upgraded = upgradeLegacyProtocol({
      adapter: String(item.adapter || ''),
      protocol: String(item.protocol || ''),
      protocolOptions: item.protocolOptions
    });
    const adapterId = String(upgraded.protocol).trim().toLowerCase() === 'custom' ? 'custom' : upgraded.adapter;
    const protocolOptions = normalizeProtocolOptions(adapterId, upgraded.protocolOptions);
    const auth = normalizeProviderAuth(item, upgraded);
    const modelOptions = normalizeModelOptions(item.modelOptions, models, adapterId);
    const key = String(item.key || '');
    const trimmed = (value) => String(value || '').trim();
    const rawEndpoints = item.customEndpoints && typeof item.customEndpoints === 'object' ? item.customEndpoints : {};
    const customEndpoints = {
      generate: trimmed(rawEndpoints.generate),
      edit: trimmed(rawEndpoints.edit),
      models: trimmed(rawEndpoints.models)
    };
    let baseUrl = trimmed(item.baseUrl).replace(/\/+$/, '');
    // A fully qualified endpoint is also enough to establish the provider origin.
    if (!baseUrl && adapterId === 'custom') {
      const candidates = ['generate', 'edit', 'models'].map((kind) => item.operations?.[kind]?.path ?? customEndpoints[kind]);
      const endpoint = candidates.map((value) => resolveHttpUrl(value)).find(Boolean);
      if (endpoint) baseUrl = new URL(endpoint).origin;
    }
    const provider = {
      id: String(item.id || randomUUID()), name: String(item.name || ''),
      baseUrl: baseUrl,
      apiKeyEnv: validKeyRef(item.apiKeyEnv),
      optionalKey: !!item.optionalKey,
      protocol: String(upgraded.protocol || 'openai-images'), adapter: adapterId, models, names
    };
    // 协议级选项（edit）：只存用户真的选过的值，没写 = 协议默认。
    // 鉴权方式不在这一层：它是 provider.auth（见 normalizeProviderAuth），跟着提供商走。
    if (Object.keys(protocolOptions).length) provider.protocolOptions = protocolOptions;
    if (auth) provider.auth = auth;
    if (adapterId === 'custom') provider.customEndpoints = customEndpoints;
    const operations = readOperations(item.operations, false, adapterId === 'custom');
    if (operations) provider.operations = operations;
    // 预设来源：从提供商/本地预设创建时客户端记下的 id（开箱即用的那批）。
    // 它是「这个提供商的字段模板与锁都来自预设」的唯一凭据——没有它就算用户自配。
    //
    // 老配置（这个字段还不存在）按地址身份补一次：地址就是某份预设的地址才算数。
    // 手改过地址、地址命中多份预设的一律不补（presetIdForBaseUrl 只认唯一命中）。
    // 补上的只是来源——adapter、协议选项、地址、鉴权全都原样保留，请求行为一字不变；
    // 变的只是 UI 判据与锁的默认值。
    // 自定义协议不推断：它本来就不是从预设来的，而且它的请求格式编辑器正住在
    // 「协议设置」里——补一个来源会把用户自己写的 JSON 藏起来。
    // 幂等：已有合法 presetId 的提供商一律不动，补过的再跑一遍读到的是同一个值。
    const declaredPresetId = typeof item.presetId === 'string' ? item.presetId.trim() : '';
    const presetId = declaredPresetId && PRESET_ID.test(declaredPresetId)
      ? declaredPresetId
      : (adapterId === 'custom' ? '' : presetIdForBaseUrl(baseUrl));
    if (presetId) provider.presetId = presetId;
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
      if (!keepsParams) {
        delete entry.expose;
        // 一张表两种绑定：工作流行只属于 ComfyUI / A1111，云端只留 HTTP 行。
        if (Array.isArray(entry.params) && entry.params.length) {
          const kept = entry.params.filter((row) => !isWorkflowParamShape(row));
          if (kept.length) entry.params = kept; else delete entry.params;
        }
      }
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
    activeStates: new WeakMap(),
    stamp: '',
    webOriginHost: '',
    keyMigration: null,
    writeQueue: Promise.resolve(),
    saveQueue: Promise.resolve()
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
export function rememberConfig(store, config, stamp = '') {
  store.cache = config;
  store.stamp = stamp;
}
const configStampOf = (info) => [info.mtimeMs, info.ctimeMs, info.size, info.ino].join(':');
export function readConfigSync(store) {
  try {
    const info = statSync(store.configFile);
    const stamp = configStampOf(info);
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
  const cache = store?.activeStates;
  if (cache?.has(config)) return cache.get(config);
  const provider = (config.providers || []).find((item) => item.id === config.active.providerId);
  const model = String((config.active && config.active.model) || '').trim();
  if (!provider || !model) {
    cache?.set(config, null);
    return null;
  }
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
  const state = {
    provider, model, adapter, models, editModels,
    canEdit: model === 'auto' ? editModels.length > 0 : editModels.includes(model),
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
  cache?.set(config, state);
  return state;
}

/** 凭据解析：状态服务与配置页共用同一套“哪里算有 Key”的口径。 */
export async function resolveStatusKey(store, provider) {
  if (!provider) return { ok: false, source: '', ref: '' };
  if (provider.optionalKey || provider.auth?.mode === 'none') return { ok: true, source: 'optional', ref: '' };
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

/**
 * 模型行（`role:'model'`）是否暴露给对话模型。
 *
 * 模型是特殊值：只有选择器停在「自动」时才需要它出现在参数清单里（这时模型还没定，
 * 由对话模型挑）；选了一个具体模型，它就是选择器里那个，不该再被 `params` 改。
 * 所以这条判断只由选择器决定——行上存的 `expose`（老版本让用户点过眼睛）读进来也不认。
 *
 * @param {string} model 当前选择里的模型（`active.model`，可能是 'auto'）
 */
function modelRowExposed(model) {
  return String(model || '').trim() === 'auto';
}

/** 内置行里模型那一行的 role（`role:'model'` 与工作流行上的 `role:true` 不是一回事）。 */
const MODEL_PARAM_ROLE = 'model';

/**
 * 「自动」模式下没有固定的模型条目，模型行却住在每个模型自己的条目里：
 * 取第一个带模型行的条目把那一行补进清单（模型行是内置固定行，各条目只差一个可改的名字）。
 * 只补模型行——其它参数行各归各的模型，不跟过来。
 */
function autoModelRowOf(options, adapter, takesHttpRows) {
  for (const entry of Object.values(options)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.params)) continue;
    for (const row of entry.params) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (String(row.role || '').trim().toLowerCase() !== MODEL_PARAM_ROLE) continue;
      if (typeof row.name !== 'string' || !row.name.trim()) continue;
      if (isWorkflowParamShape(row)) {
        if (adapter.id !== 'comfyui' || !row.node || !row.input) continue;
      } else if (!takesHttpRows) continue;
      return Object.assign({}, row, { expose: true });
    }
  }
  return null;
}

/**
 * 这个模型能交给对话模型的参数清单。两处来源合成一张：
 *
 *   - 工作流行（有 node/input）：只有 ComfyUI 会按落点写进工作流；
 *   - HTTP 行（name 是请求体路径）：通用路径与 A1111 会写进请求体。
 *
 * 暴露口径统一成「行的 expose 为 true」或「老配置的 expose 开关表里为 true」——
 * 老配置（A1111 只有开关表、ComfyUI 只有整表开关）升级后行为不变。
 * **模型行例外**：它不看行上的值，只按选择器推导（见 modelRowExposed）。
 * 提示词与负面词永远不出现：它们走工具自己的参数。
 */
export function workflowParamsOf(provider, model, adapter) {
  try {
    if (!adapter) return undefined;
    const options = provider && provider.modelOptions ? provider.modelOptions : null;
    if (!options || typeof options !== 'object') return undefined;
    const modelAuto = modelRowExposed(model);
    // A1111 的老行为允许「换一个模型行」兜底：WebUI 的参数开关本来就是整个部署的。
    let source = options[model] && typeof options[model] === 'object' ? options[model] : null;
    if (!source && adapter.id === 'a1111') {
      source = Object.values(options).find((item) => item && typeof item === 'object'
        && (Array.isArray(item.params) || (item.expose && typeof item.expose === 'object'))) || null;
    }
    const expose = source && source.expose && typeof source.expose === 'object' ? source.expose : {};
    const rows = source && Array.isArray(source.params) ? source.params : [];
    const takesHttpRows = adapterTakesParamRows(adapter);
    const exposed = [];
    let sawModelRow = false;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!name || PROMPT_ROLE_NAMES.has(name)) continue;
      const modelRow = String(row.role || '').trim().toLowerCase() === MODEL_PARAM_ROLE;
      if (modelRow) {
        // 模型行不看行上的 expose，也不看老开关表：暴露只由选择器推导。
        sawModelRow = true;
        if (!modelAuto) continue;
      } else if (row.expose !== true && expose[name] !== true) continue;
      // 推导出来的行把结论写进输出的 expose：下游按 expose 过滤时不会把这一行再滤掉。
      const out = modelRow ? Object.assign({}, row, { expose: true }) : row;
      if (isWorkflowParamShape(row)) {
        // 工作流行只对 ComfyUI 有意义；落点不全的行写不进去，别报给模型。
        if (adapter.id !== 'comfyui' || !row.node || !row.input) continue;
        exposed.push(out);
        continue;
      }
      if (!takesHttpRows) continue;
      exposed.push(out);
    }
    // A1111 老配置只有开关表、没有行：按内置清单兜底（默认值此时是空的，等于「不勾就不发」）。
    if (adapter.id === 'a1111' && !rows.length) {
      const legacy = A1111_PARAMS
        .filter((param) => expose[param.name] === true)
        .map((param) => ({ name: param.name, type: param.type }));
      if (legacy.length) return legacy;
    }
    if (modelAuto && !sawModelRow) {
      const fallback = autoModelRowOf(options, adapter, takesHttpRows);
      if (fallback) exposed.push(fallback);
    }
    return exposed.length ? exposed : undefined;
  } catch (_error) { return undefined; }
}

/**
 * `params` 里哪些键这次真的用不上，翻成一句要回报给对话模型的话（没有就返回空串）。
 *
 * 有暴露行的模型不再说「不支持工作流参数」——那是上一轮的误报：A1111 与通用路径
 * 都认参数行，只有真的没暴露/不认识的键才需要提。
 *
 * 自己拼 body 的 ComfyUI / A1111 在 `execute()` 里已经逐一核对并回报，这里不再重复
 * （同一句话出现两次比不说更糟）。
 */
const SELF_REPORTING_ADAPTERS = new Set(['comfyui', 'a1111']);

export function paramNoticeOf(provider, model, adapter, names) {
  try {
    if (!adapter || !Array.isArray(names) || !names.length) return '';
    if (SELF_REPORTING_ADAPTERS.has(String(adapter.id || ''))) return '';
    const exposed = new Set((workflowParamsOf(provider, model, adapter) || []).map((param) => param.name));
    const ignored = names.filter((name) => !exposed.has(name));
    if (!ignored.length) return '';
    return (exposed.size
      ? '这些参数没有暴露给当前模型，已忽略：'
      : '当前模型没有暴露任何可调参数，已忽略：') + ignored.join('、');
  } catch (_error) { return ''; }
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
/**
 * 参考图的「宿主声明」：预设 + 模型规则算出来的那条模板，**不含用户覆盖**。
 *
 * 面板拿它当「支持参考图」的默认勾选值，所以必须只看声明层：用户取消勾选时写的是
 * `fields.image = null`（显式不发），要是把覆盖层也算进来，取消一次就再也没法继承回
 * 预设的模板了。读声明层最省事的办法就是把 modelOptions 摘掉再走一遍 fieldsFor——
 * 预设与规则挑哪一条只看协议与主机，和 modelOptions 无关。
 *
 * 认不出的形状（数组、null）一律当「没有声明」：面板只需要「有模板 / 没模板」。
 */
function imageCapabilityOf(provider, model, adapter) {
  if (!adapter) return null;
  try {
    const declared = fieldsFor(adapter, Object.assign({}, provider, { modelOptions: {} }), model);
    const spec = declared && declared.image;
    return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  } catch (_error) { return null; }
}

/** 选择器用的模型能力表：每个模型可用哪些质量档、尺寸控件长什么样、参考图默认发到哪。 */
export function capabilityManifest(config) {
  return (config.providers || []).map((provider) => ({
    providerId: provider.id,
    models: (provider.models || []).map((model) => {
      let adapter = null;
      let quality = null;
      try { adapter = resolveAdapter(provider, model); quality = qualityOptionsFor(provider, model, adapter); } catch (_error) { adapter = null; quality = null; }
      return {
        model: model,
        quality: quality,
        size: sizeSpecFor(provider, model, adapter),
        image: imageCapabilityOf(provider, model, adapter)
      };
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
    const stamp = configStampOf(await stat(store.configFile));
    let config = store.stamp === stamp && store.cache
      ? store.cache
      : normalizeConfig(JSON.parse(await readFile(store.configFile, 'utf8')));
    if (hasLegacyKeys(config) && canUseCredentials(store)) {
      try {
        config = await migrateKeysOnce(store, config);
        if (store.cache === config && store.stamp !== stamp) return config;
      } catch (error) { store.logHost('config key migration failed: ' + String(error && error.message ? error.message : error)); }
    }
    rememberConfig(store, config, stamp);
    return config;
  } catch (error) {
    if (error?.code !== 'ENOENT') return store.cache || emptyConfig();
    if (store.stamp !== 'missing') rememberConfig(store, emptyConfig(), 'missing');
    return store.cache;
  }
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
    let stamp = '';
    try { stamp = configStampOf(await stat(store.configFile)); } catch (_error) { /* refresh on next read */ }
    rememberConfig(store, next, stamp);
    return next;
  });
  store.writeQueue = task.catch(() => {});
  return task;
}
/** 每次请求才解析一次密钥；不在内存里长期缓存，轮换后下一请求生效。 */
export async function resolveProviderCredential(store, provider) {
  if (provider.auth?.mode === 'none') return provider;
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
export function validateProviderDraft(provider, { resolve = true } = {}) {
  if (!provider || typeof provider !== 'object') return;
  if (provider.auth?.mode && !normalizeAuthSpec(provider.auth)) {
    const error = localizedError(new Error('检查鉴权方式、请求头名或查询参数名。'), 'provider.invalidAuth');
    error.status = 400;
    throw error;
  }
  const custom = provider.adapter === 'custom' || provider.protocol === 'custom';
  const validate = custom ? normalizeOperations : normalizeResponseOverrides;
  try {
    validateAdvancedRows(provider);
    const { operations, modelOptions, customEndpoints, baseUrl } = provider;
    validate(operations);
    for (const model of Object.values(modelOptions || {})) validate(model?.operations, true);
    if (!custom) return;
    if (baseUrl && !resolveHttpUrl(String(baseUrl).trim())) throw new Error('API 地址需要使用 HTTP(S)');
    const normalized = normalizeConfig({ providers: [provider] }).providers[0];
    if (resolve) {
      for (const model of new Set(['', ...Object.keys(modelOptions || {})])) resolveAdapter(normalized, model);
    }
    for (const value of Object.values(customEndpoints || {})) {
      if (!value || !String(value).trim()) continue;
      const path = String(value).trim();
      if (/^\/\//.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) && !resolveHttpUrl(path)) {
        throw new Error('端点需要 HTTP(S) 地址或相对于 API 地址的路径');
      }
    }
  } catch (error) {
    throw invalidProviderOperations(error);
  }
}

export function saveConfigWithCredentials(store, raw) {
  const task = store.saveQueue.then(() => persistConfigWithCredentials(store, raw));
  store.saveQueue = task.catch(() => {});
  return task;
}

async function persistConfigWithCredentials(store, raw) {
  for (const provider of Array.isArray(raw?.providers) ? raw.providers : []) {
    validateProviderDraft(provider);
  }
  const incoming = normalizeConfig(raw);
  const current = await readConfig(store);
  const credentials = credentialsService(store);
  const canStore = !!(credentials && typeof credentials.set === 'function');
  const canDescribe = !!(credentials && typeof credentials.describe === 'function');
  const currentById = new Map(current.providers.map((provider) => [provider.id, provider]));
  const used = new Set();
  const originals = new Map();
  const credentialChanges = [];
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
      credentialChanges.push({ ref, value: newKey, legacy: false });
    } else if (old && old.key) {
      if (canStore && canDescribe) {
        try {
          const info = await credentials.describe(ref);
          if (!credentialIsStored(info)) credentialChanges.push({ ref, value: old.key, legacy: true });
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
  incoming.providers = providers;
  let saved;
  try {
    for (const { ref, value, legacy } of credentialChanges) {
      try {
        const description = canDescribe ? await credentials.describe(ref) : null;
        const existing = credentialIsStored(description);
        const previous = existing && typeof credentials.resolve === 'function' ? await credentials.resolve(ref) : null;
        if (previous?.value === value) continue;
        originals.set(ref, { existing, value: previous?.value });
        await credentials.set(ref, value);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        throw localizedError(new Error('保存 API Key 失败：' + message),
          legacy ? 'config.legacyKeyMigrationFailed' : 'config.credentialSaveFailed', { message });
      }
    }
    try {
      saved = await writeConfig(store, incoming);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      throw localizedError(new Error('保存生图配置失败：' + message), 'config.writeFailed', { message });
    }
  } catch (error) {
    for (const [ref, previous] of [...originals].reverse()) {
      try {
        if (typeof previous.value === 'string') await credentials.set(ref, previous.value);
        else if (!previous.existing && canDescribe && typeof credentials.unset === 'function') await credentials.unset(ref);
      } catch (_rollbackError) { store.logHost('credential rollback failed for ' + ref); }
    }
    throw error;
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
  return saved;
}

/**
 * 输出格式描述符：响应侧「图在哪、怎么落地」的唯一词汇表。
 *
 * 描述符只回答一个问题：**从响应里的哪里读图**。它不碰请求、不碰凭据：
 *   - 请求体仍由字段模板 / 参数表 / 常量规则产出，改描述符不会改请求
 *     （test/fixtures/adapter-bodies.baseline.json 就是这条的守门人）；
 *   - 结果图只产出 `{ url }` 或 `{ bytes, contentType }`。下载永远由执行器调
 *     fetchResultImage()（同源带凭据、跨源默认不带），见 lib/request-auth.js。
 *
 * 三条铁律写进 validateOutputProfile()，不靠约定：
 *   1. `kind` 只认 json / task / binary；
 *   2. `maxBytes` / `emptyMessage` 必填——各协议体积上限不同、报错文案是行为的一部分。
 *      两者的默认值分别来自 readJsonResponse（10MB）与 decodeImagePayload，但每个协议
 *      都要显式写出它今天的值，否则迁移就是静默行为变更；
 *   3. 描述符里出现 headers / 凭据字段直接拒绝：一旦允许，就是给「裸下载」开一扇门。
 *
 * 迁移期两套写法并存：新写法是 `adapter.output`，老写法是 `adapter.poll`
 * （迁移到一半的适配器与自定义适配器都可能还是后者）。taskSpecOf() 把两者收敛成
 * 同一个读取面，所以执行器只认字段、不认来源。
 *
 * 词汇表按批次长大，每个字段都有唯一的真实消费方：
 *   第一批（ideogram / wanx / 四条异步）: kind + pick + scan + task 扁平字段 + via；
 *   第二批（stability / openai-chat）: kind:binary、from 级联、text 正则；
 *   第三批（gemini / swarmui / recraft / 其余三条同步）: select:last、where、any 交错、
 *     contentTypePath、emptyDetail、as:relative、纯 scan 兜底。
 * `comfyui` 明确留在协议代码里（两跳 + 运行时动态键 + 完成信号 + 退避曲线，见适配器注释）。
 */
import {
  base64ToImage, baseUrlOf, decodeImagePayload, errorTextOf, getPath, looksLikeImage, sniffType
} from './adapter-kit.js';

/** 与 decodeImagePayload() 的「没有图片」文案一致。 */
export const DEFAULT_EMPTY_MESSAGE = '生图接口没有返回图片';

const KINDS = new Set(['json', 'task', 'binary']);
const PICK_AS = new Set(['base64', 'url', 'auto', 'dataUrl', 'relative']);
// 正则扒出来的片段没有「相对谁」的上下文，relative 只对路径取值有意义。
const TEXT_AS = new Set(['base64', 'url', 'auto', 'dataUrl']);
const JSON_KEYS = new Set(['kind', 'pick', 'from', 'scan', 'maxBytes', 'emptyMessage', 'emptyDetail']);
const BINARY_KEYS = new Set(['kind', 'maxBytes', 'emptyMessage']);
const TASK_KEYS = new Set([
  'kind', 'path', 'pollUrlPath', 'idPath', 'statusPath', 'resultPath',
  'success', 'failure', 'failureMessagePath', 'errorPath',
  'intervalMs', 'timeoutMs', 'maxBytes', 'emptyMessage', 'via'
]);
const VIA_KEYS = new Set(['kind', 'urlPath', 'maxBytes']);
const PICK_KEYS = new Set(['path', 'as', 'select', 'any', 'text', 'where', 'contentTypePath']);
const TEXT_KEYS = new Set(['regex', 'as', 'flags']);
const WHERE_KEYS = new Set(['path', 'equals', 'notEquals']);
const EMPTY_DETAIL_KEYS = new Set(['path', 'label']);

/* ------------------------------------------------------------------ 校验 */

/** header / 凭据类键名：命中就拒绝，递归检查。 */
function isCredentialKey(key) {
  const text = String(key || '').toLowerCase().replace(/[-_\s]/g, '');
  if (!text) return false;
  if (text === 'header' || text === 'headers') return true;
  if (text.endsWith('header') || text.endsWith('headers')) return true;
  return ['authorization', 'auth', 'key', 'apikey', 'token', 'secret', 'credential', 'credentials'].includes(text);
}

function assertNoCredentials(node, trail, label) {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (isCredentialKey(key)) {
      throw new Error('输出描述符里不许出现凭据字段' + label + '：' + trail + key
        + '（只产出 { url }，下载统一走 fetchResultImage）');
    }
    assertNoCredentials(node[key], trail + key + '.', label);
  }
}

function positiveNumber(value, key, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('输出描述符缺少有效的 ' + key + '（必填）' + label);
  }
  return number;
}

function nonEmptyText(value, key, label) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) throw new Error('输出描述符缺少 ' + key + '（必填）' + label);
  return text;
}

function pathText(profile, key, label) {
  return nonEmptyText(profile[key], key, label);
}

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 非空字符串数组：状态词表、失败文案路径表都用它。 */
function textList(value, key, label) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('输出描述符的 ' + key + ' 必须是非空字符串数组' + label);
  }
  return value.map((item) => {
    const text = optionalText(item);
    if (!text) throw new Error('输出描述符的 ' + key + ' 里有空值' + label);
    return text;
  });
}

/**
 * 结果图路径可以写一条，也可以写一列候选（有序）：魔搭先看 output_images，
 * 老网关回的是 data.0.url。第一个「有值」的赢，空数组按没有处理。
 */
function resultPathList(profile, label) {
  const raw = profile.resultPath;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) throw new Error('task 描述符需要非空的 resultPath' + label);
  return list.map((item) => {
    const text = optionalText(item);
    if (!text) throw new Error('task 描述符的 resultPath 里有空值' + label);
    return text;
  });
}

/**
 * 字段白名单：拼错的键（`statisPath` / `scanning`）不能静默落到默认值，
 * 否则「写了但没生效」比报错更难查。
 */
function assertKnownKeys(profile, allowed, label) {
  for (const key of Object.keys(profile)) {
    if (allowed.has(key)) continue;
    throw new Error('输出描述符里有不认识的字段 ' + key + label
      + '（认识的：' + Array.from(allowed).join(' / ') + '）');
  }
}

/**
 * 校验一份输出描述符；不合法直接抛错（在适配器定义时调用，坏描述符进不了运行时）。
 * `where` 只用于把报错定位到某个协议，例如 'ideogram'。
 */
export function validateOutputProfile(profile, where) {
  const label = where ? '（' + where + '）' : '';
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('输出描述符必须是一个对象' + label);
  }
  assertNoCredentials(profile, '', label);
  const kind = String(profile.kind || '');
  if (!KINDS.has(kind)) {
    throw new Error('输出描述符的 kind 只认 json / task / binary' + label + '：' + (kind || '（空）'));
  }
  positiveNumber(profile.maxBytes, 'maxBytes', label);
  nonEmptyText(profile.emptyMessage, 'emptyMessage', label);
  if (kind === 'json') validateJson(profile, label);
  else if (kind === 'binary') validateBinary(profile, label);
  else validateTask(profile, label);
  return profile;
}

/**
 * binary：响应体本身就是图片（stability）。没有 pick / from / scan——
 * 但读法仍要吃 JSON `{image:"<base64>"}` 形态（见 readBinaryOutput）。
 */
function validateBinary(profile, label) {
  assertKnownKeys(profile, BINARY_KEYS, label);
}

/**
 * json：一条 pick 或一个 from 级联。
 *
 * `from` 是有序多来源（openai-chat）：每一项本身都是一个 pick，
 * 逐项试，第一项产出图就停；全部落空且 `scan:true` 才兜底扫描。
 * `text` 让 pick 从文本里正则扒图（{regex, as, flags?}），
 * 正则按声明顺序**跨全部文本**执行（先所有文本找第一条正则，再第二条）——
 * 这是 openai-chat 迁移前的真实循环顺序，逐段文本依次试会选出不同的图。
 *
 * `scan:true` 也可以单独出现（recraft）：今天就是 decodeImagePayload 的任意位置扫描，
 * 收紧成一条路径是行为变化，所以允许「纯兜底」形状。
 */
function validateJson(profile, label) {
  const picks = profile.pick === undefined ? [] : profile.pick;
  const from = profile.from === undefined ? [] : profile.from;
  if (!Array.isArray(picks)) throw new Error('json 描述符的 pick 必须是数组' + label);
  if (!Array.isArray(from)) throw new Error('json 描述符的 from 必须是数组' + label);
  if (profile.pick !== undefined && !picks.length) {
    throw new Error('json 描述符的 pick 不能是空数组' + label);
  }
  if (profile.from !== undefined && !from.length) {
    throw new Error('json 描述符的 from 不能是空数组' + label);
  }
  if (!picks.length && !from.length && profile.scan !== true) {
    throw new Error('json 描述符需要非空的 pick 或 from（或 scan:true 的纯兜底形状）' + label);
  }
  if (profile.scan !== undefined && typeof profile.scan !== 'boolean') {
    throw new Error('json 描述符的 scan 只能是布尔值' + label);
  }
  if (profile.emptyDetail !== undefined) validateEmptyDetail(profile.emptyDetail, label);
  picks.forEach((pick, index) => validatePick(pick, '（pick[' + index + ']）' + label));
  from.forEach((pick, index) => validatePick(pick, '（from[' + index + ']）' + label));
  assertKnownKeys(profile, JSON_KEYS, label);
}

/**
 * `emptyDetail`：无图时把上游给的原因拼进报错（Gemini 的 `finishReason=SAFETY`）。
 * 值缺失时**整段括号都不出现**——迁移前就是 `finish ? '（…）' : ''`。
 */
function validateEmptyDetail(detail, label) {
  const at = '（emptyDetail）' + label;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error('emptyDetail 必须是对象' + label);
  }
  nonEmptyText(detail.path, 'emptyDetail.path', label);
  nonEmptyText(detail.label, 'emptyDetail.label', label);
  assertKnownKeys(detail, EMPTY_DETAIL_KEYS, at);
}

/** 一个 pick / from 条目：位置（path）+ 动作（as / any / where / text）。 */
function validatePick(pick, label) {
  if (!pick || typeof pick !== 'object' || Array.isArray(pick)) {
    throw new Error('pick 必须是对象' + label);
  }
  pathText(pick, 'path', label);
  if (pick.text !== undefined) {
    // 文本条目自己带 as，条目级的 as / any / select / where / contentTypePath 没有读取方，直接拒绝。
    for (const key of ['as', 'any', 'select', 'where', 'contentTypePath']) {
      if (pick[key] !== undefined) {
        throw new Error('带 text 的 pick 不能再写 ' + key + '（动作写在 text[].as 里）' + label);
      }
    }
    validateText(pick.text, label);
  } else {
    const as = pick.as === undefined ? 'auto' : String(pick.as);
    if (!PICK_AS.has(as)) {
      throw new Error('pick.as 只认 ' + Array.from(PICK_AS).join(' / ') + label + '：' + as);
    }
    if (pick.select !== undefined && pick.select !== 'first' && pick.select !== 'last') {
      throw new Error('pick.select 只认 first / last（all 还没有消费者）' + label + '：' + pick.select);
    }
    if (pick.any !== undefined) {
      if (!Array.isArray(pick.any) || !pick.any.length) {
        throw new Error('pick.any 必须是非空字符串数组' + label);
      }
      for (const path of pick.any) {
        if (typeof path !== 'string') {
          throw new Error('pick.any 的每一项都必须是字符串（"" = 元素本身）' + label);
        }
      }
    }
    if (pick.where !== undefined) validateWhere(pick, label);
    if (pick.contentTypePath !== undefined) validateContentTypePath(pick.contentTypePath, label);
  }
  assertKnownKeys(pick, PICK_KEYS, label);
}

/**
 * `where`：过滤 `[]` 产出的元素。只支持列表路径——单值路径上写它就是静默不生效。
 * 条件必须恰有一个 `equals` 或 `notEquals`（`notEquals` 保留「没有这个字段」的元素，
 * gemini 的 `part.thought === true` 才跳就是这么来的）。
 */
function validateWhere(pick, label) {
  if (!String(pick.path).includes('[]')) {
    throw new Error('pick.where 只能用在 [] 路径上（单值路径没有候选可过滤）' + label);
  }
  if (!Array.isArray(pick.where) || !pick.where.length) {
    throw new Error('pick.where 必须是非空数组' + label);
  }
  pick.where.forEach((condition, index) => {
    const at = '（where[' + index + ']）' + label;
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
      throw new Error('pick.where 的每一项必须是对象' + at);
    }
    pathText(condition, 'path', at);
    // 先把拼错的键（equal / 不等于 …）报出来，再谈「恰有一个」——否则一个拼写错误会变成一句
    // 让人去数条件的报错。
    assertKnownKeys(condition, WHERE_KEYS, at);
    const hasEquals = condition.equals !== undefined;
    const hasNotEquals = condition.notEquals !== undefined;
    if (hasEquals === hasNotEquals) {
      throw new Error('pick.where 的每一项要恰有一个 equals 或 notEquals' + at);
    }
  });
}

/**
 * `contentTypePath`：contentType 覆盖，可写多条候选（驼峰 / 蛇形）。
 * 相对「命中元素」：path 以 `[]` 结尾时就是元素本身（gemini 的 part），
 * 否则是 path 的父对象（openrouter 的 `data.0`）。
 */
function validateContentTypePath(value, label) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) throw new Error('pick.contentTypePath 必须是非空字符串或数组' + label);
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error('pick.contentTypePath 的每一项都必须是非空字符串' + label);
    }
  }
}

/** 文本正则条目：regex 必须能编译，as 只认四种图片解释方式，flags 缺省 i。 */
function validateText(rules, label) {
  if (!Array.isArray(rules) || !rules.length) {
    throw new Error('pick.text 必须是非空数组' + label);
  }
  rules.forEach((rule, index) => {
    const at = '（text[' + index + ']）' + label;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('pick.text 的每一项必须是对象' + at);
    }
    const regex = nonEmptyText(rule.regex, 'regex', at);
    const flags = rule.flags === undefined ? 'i' : String(rule.flags);
    try {
      new RegExp(regex, flags);
    } catch (error) {
      throw new Error('pick.text 的正则编译失败' + at + '：' + error.message);
    }
    const as = rule.as === undefined ? 'auto' : String(rule.as);
    if (!TEXT_AS.has(as)) {
      throw new Error('pick.text.as 只认 ' + Array.from(TEXT_AS).join(' / ') + at + '：' + as);
    }
    assertKnownKeys(rule, TEXT_KEYS, at);
  });
}

/**
 * task 分支：扁平字段（照 dashscope-wanx 现有的 poll 形状搬过来，字段名一字不改）。
 *
 * 轮询地址两种来源，二选一：
 *   - `pollUrlPath`：地址在**提交响应**里（BFL 的 polling_url、Replicate 的 urls.get、fal 的 status_url）；
 *   - `path`：按任务 id 拼（`/tasks/{taskId}`；`{root}` = 去掉末尾 /v1 的站点根）。
 * 其余字段缺省即保持迁移前的行为，见各字段旁的注释。
 */
function validateTask(profile, label) {
  const path = optionalText(profile.path);
  const pollUrlPath = optionalText(profile.pollUrlPath);
  if (!path && !pollUrlPath) {
    throw new Error('task 描述符需要 path（按任务 id 拼轮询地址）或 pollUrlPath（轮询地址在提交响应里）' + label);
  }
  if (profile.idPath !== undefined) pathText(profile, 'idPath', label);
  else if (path.includes('{taskId}')) pathText(profile, 'idPath', label);
  pathText(profile, 'statusPath', label);
  resultPathList(profile, label);
  if (!Array.isArray(profile.success) || !profile.success.length) {
    throw new Error('task 描述符需要非空的 success' + label);
  }
  textList(profile.success, 'success', label);
  if (!Array.isArray(profile.failure)) {
    throw new Error('task 描述符需要 failure 数组' + label);
  }
  // 允许空数组：fal 的失败信号在 error 字段里，不在状态词里（见 errorPath）。
  if (profile.failure.length) textList(profile.failure, 'failure', label);
  if (profile.failureMessagePath !== undefined) {
    textList(profile.failureMessagePath, 'failureMessagePath', label);
  }
  if (profile.errorPath !== undefined) pathText(profile, 'errorPath', label);
  positiveNumber(profile.intervalMs, 'intervalMs', label);
  // timeoutMs 现在没有读取方（超时统一由 TOTAL_BUDGET_MS 决定），保留字段以免预设数据丢值。
  if (profile.timeoutMs !== undefined) positiveNumber(profile.timeoutMs, 'timeoutMs', label);
  if (profile.via !== undefined) validateVia(profile.via, label);
  for (const key of ['submit', 'poll', 'result']) {
    if (profile[key] !== undefined) {
      throw new Error('task 描述符是扁平字段，不支持嵌套的 ' + key + '（字段名与 wanx 的 poll 一致）' + label);
    }
  }
  assertKnownKeys(profile, TASK_KEYS, label);
}

/** fal 那类：轮询结束还要再 GET 一次结果 JSON。描述符只说「GET 哪个地址」，请求头由适配器侧决定。 */
function validateVia(via, label) {
  if (!via || typeof via !== 'object' || Array.isArray(via)) {
    throw new Error('task 描述符的 via 必须是对象' + label);
  }
  const kind = optionalText(via.kind);
  if (kind !== 'json-get') {
    throw new Error('task 描述符的 via.kind 只认 json-get' + label + '：' + (kind || '（空）'));
  }
  textList(via.urlPath, 'via.urlPath', label);
  // 结果 JSON 的体积上限与轮询响应不同（fal 是 64MB，轮询是 32MB），必须显式写，避免静默落回默认值。
  positiveNumber(via.maxBytes, 'via.maxBytes', label);
  assertKnownKeys(via, VIA_KEYS, '（via）' + label);
}

/** 定义时调用：校验 + 冻结。适配器写 `output: outputProfile({...}, 'ideogram')`。 */
export function outputProfile(definition, where) {
  validateOutputProfile(definition, where);
  return Object.freeze(definition);
}

/* ------------------------------------------------------------------ 读取 */

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** 一个 pick 命中的值 → 图；解释不了就返回 null（继续下一个候选）。 */
function imageOfPick(value, pick, options) {
  if (value === undefined || value === null) return null;
  const as = pick.as === undefined ? 'auto' : String(pick.as);
  if (as === 'url') return isHttpUrl(value) ? { url: value } : null;
  if (as === 'dataUrl') {
    return typeof value === 'string' && /^data:image\//i.test(value) ? base64ToImage(value) : null;
  }
  if (as === 'base64') return base64ToImage(value);
  if (as === 'relative') {
    // 「相对路径」= 既不是 data URL 也不是 http(s)：拼到 provider 站点根上再交给 fetchResultImage。
    const text = optionalText(value);
    const base = optionalText(options && options.baseUrl).replace(/\/+$/, '');
    if (!text || !base || /^data:/i.test(text) || isHttpUrl(text)) return null;
    return { url: base + '/' + text.replace(/^\/+/, '') };
  }
  // auto：先当 base64（含 data URL）解，再认 http(s)——与 decodeImagePayload 的扫描顺序一致。
  return base64ToImage(value) || (isHttpUrl(value) ? { url: value } : null);
}

/**
 * 从响应载荷里取图。只产出 `{ bytes, contentType }` 或 `{ url }`，**不发请求**。
 *
 * json：
 *   - 按 `pick` → `from` 的顺序逐项试，第一项产出图就停；
 *   - 每一项默认是一个位置；`any` 给同一逻辑位置的多种拼写（按元素交错判定），
 *     `text` 则把命中的值当文本、按正则扒图；
 *   - `path` 里的 `[]` 表示「数组每元素」，产出列表（`images[]` / `parts[].text`）；
 *     `where` 过滤这些元素，`select:'last'` 把候选列反过来（每个候选仍然试到底）；
 *   - `contentTypePath` 覆盖 contentType（相对命中元素，见 validateContentTypePath）；
 *   - 全部落空且 `scan:true` 时交给 decodeImagePayload() 兜底扫描
 *     （「先全表 base64 → 再带图片后缀的 URL → 再任意 URL」的顺序与迁移前一致）。
 *     带 `from` 的级联把 scan 当最后一级：它再落空就抛 emptyMessage——openai-chat
 *     迁移前就是吞掉扫描错误再报自己的文案；只有 pick 的描述符保持 decode 的原文案。
 *   - `emptyDetail` 在有值时给 emptyMessage 补一句 `（label=值）`（Gemini 的 finishReason）。
 *
 * binary（stability）：响应体本身就是图片，但 JSON `{image:"<base64>"}` 形态也要照吃。
 * `options.binary` 是 readResponseBytes() 读回来的 Buffer，`options.contentType` 是响应头；
 * 后者是图片类型就用它，否则按图片签名（sniffType）兜底。
 * `options.baseUrl` 只给 `as:'relative'` 用（按 provider 站点根拼相对路径）。
 */
export function readOutput(payload, profile, options) {
  const output = profile || {};
  const opts = options || {};
  if (output.kind === 'binary') return readBinaryOutput(payload, opts.binary, output, opts);
  if (output.kind !== 'json') {
    throw new Error('readOutput 只处理 kind:json / kind:binary；task 的结果用 readTaskImage()');
  }
  for (const pick of (output.pick || []).concat(output.from || [])) {
    const found = readPick(payload, pick, opts);
    if (found) return found;
  }
  if (output.scan) {
    try {
      return decodeImagePayload(payload, null);
    } catch (error) {
      if (!Array.isArray(output.from) || !output.from.length) throw error;
      throw new Error(emptyMessageOf(output, payload));
    }
  }
  throw new Error(emptyMessageOf(output, payload));
}

/** 无图文案：`emptyDetail` 有值就补「（label=值）」，缺值整段括号都不出现。 */
function emptyMessageOf(profile, payload) {
  const base = profile.emptyMessage || DEFAULT_EMPTY_MESSAGE;
  const detail = profile.emptyDetail;
  if (!detail) return base;
  const value = optionalText(getPath(payload, detail.path));
  return value ? base + '（' + detail.label + '=' + value + '）' : base;
}

/** binary：JSON 形态优先（与迁移前 safeJson → decodeImagePayload 的顺序一致），否则认 body 本身。 */
function readBinaryOutput(payload, binary, profile, options) {
  if (payload) return decodeImagePayload(payload, null);
  if (binary && looksLikeImage(binary)) {
    return { bytes: binary, contentType: imageContentTypeOf(options.contentType) || sniffType(binary) };
  }
  throw new Error(profile.emptyMessage || DEFAULT_EMPTY_MESSAGE);
}

/** 响应头里的 contentType：只认 image/*，参数（; charset=…）丢掉，其余交给签名兜底。 */
function imageContentTypeOf(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(type) ? type : '';
}

/**
 * 路径取值。带 `[]` 的段（`a[].b`）表示「数组每元素」，结果是有序列表；
 * 没有 `[]` 时保留 getPath 的老语义（返回单值）。
 */
function valuesOfPath(payload, path) {
  const raw = optionalText(path);
  if (!raw) return [];
  if (!raw.includes('[]')) {
    const value = getPath(payload, raw);
    return value === undefined || value === null ? [] : [value];
  }
  let nodes = [payload];
  for (const segment of raw.split('.')) {
    const list = segment.endsWith('[]');
    const key = list ? segment.slice(0, -2) : segment;
    const next = [];
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const value = node[key];
      if (value === undefined || value === null) continue;
      if (list) {
        if (Array.isArray(value)) for (const item of value) next.push(item);
      } else {
        next.push(value);
      }
    }
    nodes = next;
  }
  return nodes;
}

/**
 * `any`：同一个元素上的多种拼写，返回第一个「有值」的。
 * `''` 表示元素本身（openai-chat 的 images[] 元素可以是字符串）。
 * 与迁移前的 `a || b || string` 一致：空串按没有处理，且不因为解不出图而换下一种拼写。
 */
function anyValueOf(value, any) {
  if (!Array.isArray(any) || !any.length) return value;
  for (const path of any) {
    if (!path) return value;
    const candidate = getPath(value, path);
    if (candidate === undefined || candidate === null || candidate === '') continue;
    return candidate;
  }
  return null;
}

/** 文本条目：一个值可能是字符串，也可能是 parts[]（元素是字符串或 {text}）。 */
function textsOf(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const part of value) {
    if (typeof part === 'string') out.push(part);
    else if (part && typeof part.text === 'string') out.push(part.text);
  }
  return out;
}

/**
 * 一个 pick / from 条目 → 图。
 *
 * `text` 的循环顺序照抄 openai-chat 迁移前的实现：**先拿第一条正则扫全部文本，再第二条**。
 * 反过来（逐段文本依次试所有正则）在同一条 content 里同时存在 http 链接与 data URL 时会选错。
 *
 * `where` 先过滤（只对 `[]` 元素有效，校验里挡住单值路径），`select:'last'` 再把候选列
 * 反过来；反过来之后仍然是「逐个试、第一个解得出图的赢」——迁移前 gemini 的
 * `parts.slice().reverse()` 循环就是这条语义（最后一个坏 base64 会退到前一个）。
 */
function readPick(payload, pick, options) {
  let values = valuesOfPath(payload, pick.path);
  if (Array.isArray(pick.where) && pick.where.length) {
    values = values.filter((value) => matchesWhere(value, pick.where));
  }
  if (pick.select === 'last') values = values.slice().reverse();
  if (pick.text !== undefined) {
    const texts = [];
    for (const value of values) texts.push(...textsOf(value));
    for (const rule of pick.text) {
      const pattern = new RegExp(rule.regex, rule.flags === undefined ? 'i' : String(rule.flags));
      for (const text of texts) {
        const hit = pattern.exec(text);
        if (!hit) continue;
        const found = imageOfPick(hit[0], { as: rule.as === undefined ? 'auto' : rule.as });
        if (found) return found;
      }
    }
    return null;
  }
  for (const value of values) {
    const found = imageOfPick(anyValueOf(value, pick.any), pick, options);
    if (!found) continue;
    return withContentType(found, value, payload, pick);
  }
  return null;
}

/** 一条 where 条件是否成立；`getPath` 取不到时是 null（不是 undefined），notEquals 因此放行。 */
function matchesWhere(value, conditions) {
  for (const condition of conditions) {
    const actual = getPath(value, condition.path);
    if (condition.equals !== undefined) {
      if (actual !== condition.equals) return false;
    } else if (actual === condition.notEquals) {
      return false;
    }
  }
  return true;
}

/** `data.0.b64_json` → `data.0`；没有点号的路径返回空串（取不到父对象）。 */
function parentPathOf(path) {
  const text = optionalText(path);
  const at = text.lastIndexOf('.');
  return at > 0 ? text.slice(0, at) : '';
}

/**
 * contentType 覆盖：相对「命中元素」——值是对象（`[]` 产出的元素）就相对它本身，
 * 否则相对 path 的父对象。多条候选按顺序取第一条非空。
 */
function withContentType(image, value, payload, pick) {
  if (!pick.contentTypePath || !image.bytes) return image;
  const context = value && typeof value === 'object' ? value : getPath(payload, parentPathOf(pick.path));
  if (!context) return image;
  const candidates = Array.isArray(pick.contentTypePath) ? pick.contentTypePath : [pick.contentTypePath];
  for (const path of candidates) {
    const type = optionalText(getPath(context, path));
    if (type) return { bytes: image.bytes, contentType: type };
  }
  return image;
}

/**
 * 适配器的 task 描述符。新写法 `output:{kind:'task'}` 优先；
 * 老写法 `poll` 原样返回（迁移期两套并存，执行器只认字段不认来源）。
 */
export function taskSpecOf(adapter) {
  const output = adapter && adapter.output;
  if (output && output.kind === 'task') return output;
  const legacy = adapter && adapter.poll;
  return legacy && typeof legacy === 'object' ? legacy : null;
}

/**
 * 任务成功载荷里的结果节点 → 图。节点缺失时用描述符的 emptyMessage，
 * 节点存在但读不出图时保留 decodeImagePayload 的「格式不认识」。
 *
 * 铁律（§7.2.6-3）：`emptyMessage` 只覆盖「没有结果节点」，**不覆盖** scan/decode
 * 自己的文案——否则一份形状变了的上游响应会变成一句什么也看不出来的报错。
 */
export function readTaskImage(node, spec) {
  if (node === undefined || node === null) {
    throw new Error((spec && spec.emptyMessage) || DEFAULT_EMPTY_MESSAGE);
  }
  return decodeImagePayload(node, null);
}

/* -------------------------------------------------------------- task 读取 */

/** resultPath 的候选列（有序）；没写就沿用老 poll 形状的默认值 'output'。 */
function resultPathsOf(spec) {
  const raw = (spec && spec.resultPath);
  const list = Array.isArray(raw) ? raw : [raw];
  const paths = list.map((item) => optionalText(item)).filter(Boolean);
  return paths.length ? paths : ['output'];
}

/**
 * 成功载荷里「结果图」所在的那个节点：按 resultPath 的顺序取第一个有值的。
 * 空数组按「没有」处理（魔搭的 output_images: [] 要继续退到 data.0.url；
 * Replicate 的 output: [] 则是「任务成功但没有图」，交给 emptyMessage）。
 */
export function resultNodeOf(payload, spec) {
  for (const path of resultPathsOf(spec)) {
    const value = getPath(payload, path);
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

/** 失败文案：有序路径，取第一个非空值；对象/数组按 errorTextOf 深挖（魔搭的 errors.message）。 */
function failureTextOf(profile, payload) {
  const declared = Array.isArray(profile.failureMessagePath) && profile.failureMessagePath.length
    ? profile.failureMessagePath
    // 老 poll 形状没有这个字段，那时候的读法就是这两个路径。
    : ['output.message', 'message'];
  for (const path of declared) {
    const text = errorTextOf(getPath(payload, path));
    if (text) return text;
  }
  return '';
}

/**
 * 轮询载荷 → 三态。状态词比较统一大写（Replicate 是小写状态，描述符照它自己的写法写即可）。
 *
 * `errorPath` 是 fal 的形状：状态说 COMPLETED、但载荷里带 error 字段 → 失败。
 * 迁移前 resolve() 里的那条判断，不收进来就是静默行为变更（会一直轮询到预算耗尽）。
 */
export function taskStateOf(spec, payload) {
  const profile = spec || {};
  const status = String(getPath(payload, profile.statusPath || 'output.task_status') || '').toUpperCase();
  const upper = (list, fallback) => (Array.isArray(list) && list.length ? list : fallback)
    .map((item) => String(item).toUpperCase());
  const success = upper(profile.success, ['SUCCEEDED']);
  const failure = upper(profile.failure, ['FAILED', 'CANCELED']);
  if (success.includes(status)) {
    if (profile.errorPath) {
      const message = errorTextOf(getPath(payload, profile.errorPath));
      if (message) return { state: 'failure', status: status, message: message };
    }
    return { state: 'success', status: status, node: resultNodeOf(payload, profile) };
  }
  if (failure.includes(status)) {
    return { state: 'failure', status: status, message: failureTextOf(profile, payload) || status };
  }
  return { state: 'pending', status: status };
}

/**
 * 轮询地址。`pollUrlPath` 优先（地址在响应里）；否则按 `path` 模板拼：
 * `{taskId}` 换成 idPath 取到的值（没写 idPath 就用执行器认出来的 task id），
 * `{root}` 换成站点根（去掉末尾 /v1，魔搭的接口在 /v1 下但任务查询要自己拼）。
 * 拼不出来返回空串，由执行器报「没有拿到轮询地址」。
 */
export function taskPollTarget(spec, provider, submission, taskId) {
  const profile = spec || {};
  if (profile.pollUrlPath) {
    const direct = optionalText(getPath(submission, profile.pollUrlPath));
    if (direct) return direct;
  }
  const template = optionalText(profile.path);
  if (!template) return '';
  const rawId = profile.idPath ? getPath(submission, profile.idPath) : taskId;
  const id = optionalText(rawId);
  if (!id) return '';
  const base = baseUrlOf(provider);
  const target = template
    .replace(/\{root\}/g, base.replace(/\/v\d+[a-z0-9]*$/i, ''))
    .replace(/\{taskId\}/g, encodeURIComponent(id));
  // 模板里带 {root} 就已经是绝对地址；否则按「相对 provider 的路径」拼上去。
  if (/^https?:\/\//i.test(target)) return target;
  return base + (target.startsWith('/') ? target : '/' + target);
}

/**
 * `via.urlPath` 的取值：条目前缀 `submission.` / `payload.` 指明从哪一侧取，
 * 没有前缀按轮询载荷算。只产出 URL 字符串，请求由执行器自己发（描述符不碰请求）。
 */
export function viaUrlOf(via, submission, payload) {
  const paths = Array.isArray(via && via.urlPath) ? via.urlPath : [];
  for (const entry of paths) {
    const path = optionalText(entry);
    if (!path) continue;
    let value;
    if (path.startsWith('submission.')) value = getPath(submission, path.slice('submission.'.length));
    else if (path.startsWith('payload.')) value = getPath(payload, path.slice('payload.'.length));
    else value = getPath(payload, path);
    const text = optionalText(value);
    if (text) return text;
  }
  return '';
}

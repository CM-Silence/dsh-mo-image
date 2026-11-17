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
 *   1. `kind` 只认 json / task（binary 留到 stability 迁移时再加）；
 *   2. `maxBytes` / `emptyMessage` 必填——各协议体积上限不同、报错文案是行为的一部分。
 *      两者的默认值分别来自 readJsonResponse（10MB）与 decodeImagePayload，但每个协议
 *      都要显式写出它今天的值，否则迁移就是静默行为变更；
 *   3. 描述符里出现 headers / 凭据字段直接拒绝：一旦允许，就是给「裸下载」开一扇门。
 *
 * 迁移期两套写法并存：新写法是 `adapter.output`，老写法是 `adapter.poll`
 * （迁移到一半的适配器与自定义适配器都可能还是后者）。taskSpecOf() 把两者收敛成
 * 同一个读取面，所以执行器只认字段、不认来源。
 */
import {
  base64ToImage, decodeImagePayload, getPath
} from './adapter-kit.js';

/** 与 decodeImagePayload() 的「没有图片」文案一致。 */
export const DEFAULT_EMPTY_MESSAGE = '生图接口没有返回图片';

const KINDS = new Set(['json', 'task']);
const PICK_AS = new Set(['base64', 'url', 'auto', 'dataUrl']);
const JSON_KEYS = new Set(['kind', 'pick', 'scan', 'maxBytes', 'emptyMessage']);
const TASK_KEYS = new Set([
  'kind', 'path', 'idPath', 'statusPath', 'resultPath',
  'success', 'failure', 'intervalMs', 'timeoutMs', 'maxBytes', 'emptyMessage'
]);
const PICK_KEYS = new Set(['path', 'as', 'select']);

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
    throw new Error('输出描述符的 kind 只认 json / task' + label + '：' + (kind || '（空）'));
  }
  positiveNumber(profile.maxBytes, 'maxBytes', label);
  nonEmptyText(profile.emptyMessage, 'emptyMessage', label);
  if (kind === 'json') validateJson(profile, label);
  else validateTask(profile, label);
  return profile;
}

/** 这一批只实现 json 的 pick + scan；其余字段等对应协议迁移时再加，先拒绝，免得静默不生效。 */
function validateJson(profile, label) {
  if (profile.from !== undefined) {
    throw new Error('输出描述符的 from 级联尚未实现（openai-chat 迁移时再加）' + label);
  }
  if (!Array.isArray(profile.pick) || !profile.pick.length) {
    throw new Error('json 描述符需要非空的 pick' + label);
  }
  if (profile.scan !== undefined && typeof profile.scan !== 'boolean') {
    throw new Error('json 描述符的 scan 只能是布尔值' + label);
  }
  profile.pick.forEach((pick, index) => {
    const at = '（pick[' + index + ']）';
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) {
      throw new Error('pick 必须是对象' + at + label);
    }
    pathText(pick, 'path', at + label);
    const as = pick.as === undefined ? 'auto' : String(pick.as);
    if (!PICK_AS.has(as)) {
      throw new Error('pick.as 只认 ' + Array.from(PICK_AS).join(' / ') + at + label + '：' + as);
    }
    if (pick.select !== undefined && pick.select !== 'first') {
      throw new Error('pick.select 目前只认 first（last / all 留到 gemini 迁移时再加）' + at + label);
    }
    for (const key of ['text', 'where', 'any', 'contentTypePath']) {
      if (pick[key] !== undefined) {
        throw new Error('pick.' + key + ' 尚未实现' + at + label);
      }
    }
    assertKnownKeys(pick, PICK_KEYS, at + label);
  });
  assertKnownKeys(profile, JSON_KEYS, label);
}

/** task 分支：扁平字段（照 dashscope-wanx 现有的 poll 形状搬过来，字段名一字不改）。 */
function validateTask(profile, label) {
  pathText(profile, 'path', label);
  pathText(profile, 'idPath', label);
  pathText(profile, 'statusPath', label);
  pathText(profile, 'resultPath', label);
  if (!Array.isArray(profile.success) || !profile.success.length) {
    throw new Error('task 描述符需要非空的 success' + label);
  }
  if (!Array.isArray(profile.failure)) {
    throw new Error('task 描述符需要 failure 数组' + label);
  }
  positiveNumber(profile.intervalMs, 'intervalMs', label);
  for (const key of ['submit', 'poll', 'result', 'via', 'pollUrlPath', 'failureMessagePath']) {
    if (profile[key] !== undefined) {
      throw new Error('task 描述符暂不支持嵌套的 ' + key + '（当前是扁平字段，字段名与 wanx 的 poll 一致）' + label);
    }
  }
  assertKnownKeys(profile, TASK_KEYS, label);
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
function imageOfPick(value, pick) {
  if (value === undefined || value === null) return null;
  const as = pick.as === undefined ? 'auto' : String(pick.as);
  if (as === 'url') return isHttpUrl(value) ? { url: value } : null;
  if (as === 'dataUrl') {
    return typeof value === 'string' && /^data:image\//i.test(value) ? base64ToImage(value) : null;
  }
  if (as === 'base64') return base64ToImage(value);
  // auto：先当 base64（含 data URL）解，再认 http(s)——与 decodeImagePayload 的扫描顺序一致。
  return base64ToImage(value) || (isHttpUrl(value) ? { url: value } : null);
}

/**
 * 从响应载荷里取图。只产出 `{ bytes, contentType }` 或 `{ url }`，**不发请求**。
 *
 * 按 pick 顺序逐个试；全部落空且 scan 为真时，交给 decodeImagePayload() 做兜底扫描
 * （完全照搬它「先全表 base64 → 再带图片后缀的 URL → 再任意 URL」的顺序，
 * 所以同一份响应选出的图和迁移前一致）。
 *
 * 二进制响应（body 就是图片）等 stability 迁移时再加一个 kind，别把它塞进 json。
 */
export function readOutput(payload, profile) {
  const output = profile || {};
  if (output.kind !== 'json') {
    throw new Error('readOutput 只处理 kind:json；task 的结果用 readTaskImage()');
  }
  for (const pick of output.pick || []) {
    const found = imageOfPick(getPath(payload, pick.path), pick);
    if (found) return found;
  }
  if (output.scan) return decodeImagePayload(payload, null);
  throw new Error(output.emptyMessage || DEFAULT_EMPTY_MESSAGE);
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
 */
export function readTaskImage(node, spec) {
  if (node === undefined || node === null) {
    throw new Error((spec && spec.emptyMessage) || DEFAULT_EMPTY_MESSAGE);
  }
  return decodeImagePayload(node, null);
}

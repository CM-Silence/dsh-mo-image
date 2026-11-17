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
  base64ToImage, baseUrlOf, decodeImagePayload, errorTextOf, getPath
} from './adapter-kit.js';

/** 与 decodeImagePayload() 的「没有图片」文案一致。 */
export const DEFAULT_EMPTY_MESSAGE = '生图接口没有返回图片';

const KINDS = new Set(['json', 'task']);
const PICK_AS = new Set(['base64', 'url', 'auto', 'dataUrl']);
const JSON_KEYS = new Set(['kind', 'pick', 'scan', 'maxBytes', 'emptyMessage']);
const TASK_KEYS = new Set([
  'kind', 'path', 'pollUrlPath', 'idPath', 'statusPath', 'resultPath',
  'success', 'failure', 'failureMessagePath', 'errorPath',
  'intervalMs', 'timeoutMs', 'maxBytes', 'emptyMessage', 'via'
]);
const VIA_KEYS = new Set(['kind', 'urlPath', 'maxBytes']);
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

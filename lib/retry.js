/**
 * 重试策略与可取消等待的单一实现。
 *
 * 这里只放纯函数（不读时钟以外的全局状态、不发请求），让「等多久」「该不该重试」
 * 只有一处答案：各入口只管把 signal 和剩余预算传进来。
 */

/** Retry-After 的上限：再长也没有意义，调用方总预算比它小。 */
export const MAX_RETRY_AFTER_MS = 60 * 1000;

/** 默认指数退避参数：600ms 起、5s 封顶。 */
export const DEFAULT_BASE_MS = 600;
export const DEFAULT_MAX_MS = 5000;

/** 退避抖动的范围：结果落在基准值的 [0.8, 1.2]。 */
const JITTER_FLOOR = 0.8;
const JITTER_SPREAD = 0.4;

const ABORT_NAMES = new Set(['AbortError']);
const ABORT_CODES = new Set(['ABORT_ERR', 'ERR_ABORTED', 'UND_ERR_ABORTED']);
const TIMEOUT_NAMES = new Set(['TimeoutError']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_TIMEOUT'
]);

function abortError() {
  // 不用 DOMException：有的运行时没有，测试里也不好断言 name。
  const error = new Error('等待已被取消');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function walkCauses(error, visit) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (visit(current) === true) return true;
    current = current.cause;
  }
  return false;
}

/**
 * 可被 AbortSignal 中断的 sleep。
 *
 * 取消要「立刻」结束等待：不能等定时器到点再判断，否则用户点了取消、工具还挂几十秒。
 * @param {number} ms 等待毫秒数，负数按 0 处理。
 * @param {AbortSignal|undefined} signal 取消信号。
 * @returns {Promise<void>}
 */
export function sleepWithSignal(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (signal && signal.aborted) return Promise.reject(abortError());
  if (!signal || typeof signal.addEventListener !== 'function') {
    return new Promise((resolve) => { setTimeout(resolve, delay); });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function headerValue(headers, name) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get(name) || '');
  } catch (_error) {
    // 有的 Headers 实现在非法字符上会抛：当成没有这个头。
    return '';
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === name.toLowerCase()) return String(pair[1] || '');
    }
    return '';
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== name.toLowerCase()) continue;
      const value = headers[key];
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }
  return '';
}

/**
 * 解析 `Retry-After`（秒数或 HTTP 日期）成毫秒。
 * 非法/缺失返回 0，超出上限截到 60s：调用方据此等待，不能无限拖长一次工具调用。
 * @param {Headers|Record<string,string>|undefined} headers
 * @returns {number}
 */
export function parseRetryAfter(headers) {
  const raw = headerValue(headers, 'retry-after').trim();
  if (!raw) return 0;
  let ms = 0;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    ms = Math.round(Number(raw) * 1000);
  } else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) ms = at - Date.now();
  }
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

/**
 * 一次重试该等多久：优先用服务端给的 Retry-After，否则指数退避 + 抖动。
 *
 * Retry-After 不受 maxMs 压缩：服务端明确要求的等待如果被缩短，下一跳只会再撞一次限流；
 * 真正约束它的是调用方的总预算（调用方会把等待截到剩余时间内）。
 * @param {number} attempt 第几次重试，从 1 开始。
 * @param {{baseMs?:number,maxMs?:number,retryAfterMs?:number,random?:()=>number}} [options]
 * @returns {number} 非负整数毫秒。
 */
export function retryDelayMs(attempt, options = {}) {
  const source = options || {};
  const retryAfterMs = Number(source.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.round(retryAfterMs), MAX_RETRY_AFTER_MS);
  }
  const baseMs = Number.isFinite(Number(source.baseMs)) && Number(source.baseMs) > 0
    ? Number(source.baseMs) : DEFAULT_BASE_MS;
  const maxMs = Number.isFinite(Number(source.maxMs)) && Number(source.maxMs) > 0
    ? Number(source.maxMs) : DEFAULT_MAX_MS;
  const step = Math.max(1, Math.floor(Number(attempt) || 1)) - 1;
  const raw = baseMs * Math.pow(2, Math.min(step, 16));
  const random = typeof source.random === 'function' ? source.random : Math.random;
  let ratio = 0.5;
  try {
    ratio = Number(random());
  } catch (_error) {
    ratio = 0.5;
  }
  if (!Number.isFinite(ratio)) ratio = 0.5;
  const jittered = raw * (JITTER_FLOOR + JITTER_SPREAD * Math.min(1, Math.max(0, ratio)));
  return Math.max(0, Math.round(Math.min(jittered, maxMs)));
}

/** 用户取消/超时导致的中断；走 cause 链，兼容 fetch、undici 与宿主包装过的错误。 */
export function isAbortError(error) {
  return walkCauses(error, (current) => ABORT_NAMES.has(String(current.name || ''))
    || ABORT_CODES.has(String(current.code || '')));
}

/** 超时（AbortSignal.timeout / undici 的各种 header 超时）。 */
export function isTimeoutError(error) {
  return walkCauses(error, (current) => TIMEOUT_NAMES.has(String(current.name || ''))
    || TIMEOUT_CODES.has(String(current.code || '')));
}

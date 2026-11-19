import { createHash } from 'node:crypto';
import { classifyFailure, credentialText, decodeImagePayload, joinEndpoint, looksLikeImage, MAX_IMAGE_BYTES,
  readJsonResponse, readResponseBytes, resolveHttpUrl, baseUrlOf, authSpecOf } from './adapter-kit.js';
import { fetchResultImage, requestProvider, requestResult } from './request-auth.js';
import {
  DEFAULT_EMPTY_MESSAGE, backoffOf, nextBackoff, outputCandidatesOf, readOutput,
  readTaskImage, resultNodeOf, taskPlanOf, taskResultCandidates, taskSpecOf, taskStateOf, viaUrlOf
} from './output-profiles.js';
import { isAbortError, isTimeoutError, parseRetryAfter, retryDelayMs, sleepWithSignal } from './retry.js';

let logHost = () => {};
/** apply() 注入宿主日志；传 null 关掉。 */
export function setImageExecutionLogger(fn) {
  logHost = typeof fn === 'function' ? fn : () => {};
}

/* ------------------------------------ 提交/轮询的时间预算与错误契约（B2/B3/B4） */

// 工具超时是 360s；这里留 20s 给落盘、宿主渲染和网络抖动，避免边界上被宿主先杀掉。
export const TOTAL_BUDGET_MS = 340 * 1000;
const MAX_SUBMIT_ATTEMPTS = 5;
const MAX_RATE_LIMIT_RETRIES = 2;
// 只读阶段（查任务状态）连续瞬时错误的上限；读到一次有效状态就清零。
const MAX_POLL_ERRORS = 3;
/**
 * 这些字段就是请求本身：为了「让它过去」而摘掉它们，发出去的已经不是用户要的请求了。
 * 尺寸类字段单独由 size 分类处理，也不允许被当作可选参数摘除。
 */
const PROTECTED_DROP_FIELDS = new Set([
  'prompt', 'model', 'images', 'image', 'image_url', 'image_urls', 'input', 'input_image',
  'init_image', 'mask', 'size', 'width', 'height'
]);
/** 连接都没建立起来的错误：请求肯定没到上游，重发是安全的。 */
const NETWORK_NOT_SENT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'
]);

/**
 * 把结构化字段挂到错误上（B2 契约）：只加属性，不动 message，也不改工具返回结构。
 * 上层据此判断阶段、是否已受理、能不能重试，而不是去正则匹配错误文案。
 */
export function attachFailure(error, fields) {
  const target = error instanceof Error ? error : new Error(String(error));
  const source = fields || {};
  for (const key of ['code', 'phase', 'jobId', 'submissionState', 'retryAfterMs', 'status', 'resumable']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  if (source.cause !== undefined && target.cause === undefined) target.cause = source.cause;
  return target;
}

/** 分类结果 → 稳定的错误类别；rate 单独叫 rate_limit，免得和「参数错误」混在一起。 */
function failureCode(failure) {
  const kind = String((failure && failure.kind) || 'unknown');
  return kind === 'rate' ? 'rate_limit' : kind;
}

function cancelledFailure(phase, signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) {
    const error = new Error(reason.message, { cause: reason });
    error.name = reason.name;
    return attachFailure(error, { code: isTimeoutError(reason) ? 'timeout' : 'cancelled', phase });
  }
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return attachFailure(error, { code: 'cancelled', phase: phase });
}

/** 预算耗尽：单独的 TimeoutError，和用户取消（AbortError）区分开。 */
function timeoutFailure(phase, detail, fields) {
  const error = new Error('生图超时：' + (detail || '本次调用已用完全部时间预算')
    + '。');
  error.name = 'TimeoutError';
  return attachFailure(error, Object.assign({ code: 'timeout', phase: phase }, fields || {}));
}

function ensureBudget(deadline, phase, signal) {
  if (signal && signal.aborted) throw cancelledFailure(phase, signal);
  if (Date.now() >= deadline) throw timeoutFailure(phase);
}

/** 本次请求可用的时间 = 总预算剩余时间与阶段超时的较小值；取消信号照样生效。 */
function budgetSignal(deadline, signal) {
  const remaining = Math.max(1, deadline - Date.now());
  const signals = [];
  if (signal) signals.push(signal);
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signals.push(AbortSignal.timeout(remaining));
    }
  } catch (_error) { /* 余量非法时不加阶段定时器 */ }
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
}

/** Keep only a digest between attempts, including multipart file content and order. */
async function requestFingerprint(method, url, body) {
  const hash = createHash('sha256').update(method).update('\n').update(url);
  if (typeof body === 'string') hash.update('\n').update(body);
  else if (body && typeof body.entries === 'function') {
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') hash.update(JSON.stringify([name, value]));
      else {
        hash.update(JSON.stringify([name, value.name, value.type, value.size]));
        hash.update(Buffer.from(await value.arrayBuffer()));
      }
    }
  }
  return hash.digest('hex');
}

function isProtectedDropField(field) {
  const full = String(field || '').trim().toLowerCase();
  if (!full) return true;
  if (PROTECTED_DROP_FIELDS.has(full)) return true;
  return PROTECTED_DROP_FIELDS.has(full.split('.').pop());
}

/** 放弃响应体，把连接还给连接池（切候选地址、非 2xx 时都要做）。 */
async function cancelBody(response) {
  try { await response.body?.cancel(); } catch (_error) { /* 已读完或没有 body */ }
}

function networkErrorCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code) return String(current.code);
    current = current.cause;
  }
  return '';
}

function networkNotSent(error) {
  return NETWORK_NOT_SENT_CODES.has(networkErrorCode(error));
}

/**
 * 受理状态未知的提交：文案必须让上层「先查再决定重发」，而不是直接重试。
 *
 * 扫到上游的任务标识就直接报出来：这时上游极可能已经建了任务，
 * 让用户拿着 id 去供应商侧核实，比一句「状态未知」有用得多。
 */
function submissionUnknownText(detail, taskId) {
  const head = '生图任务提交失败' + (detail ? '（' + detail + '）' : '') + '。';
  if (taskId) {
    return head + '上游可能已创建任务 ' + taskId
      + '，请先在供应商侧核实任务或账单，确认未受理后再重新提交。';
  }
  return head + '这种情况无法确认上游是否已经受理，请不要直接重复提交（可能重复计费）；先查询任务状态，确认没有任务后再重试。';
}

function submissionUnknownFailure(detail, cause, fields, taskId) {
  return attachFailure(new Error(submissionUnknownText(detail, taskId)), Object.assign({
    code: 'submission_unknown', phase: 'submit', submissionState: 'unknown', cause: cause
  }, fields || {}));
}

/** 下载阶段的失败归类：超时/取消要保留自己的语义，其余归到 download。 */
function downloadFailureOf(error, signal, deadline, fields) {
  if (signal && signal.aborted) return attachFailure(cancelledFailure('download', signal), fields);
  if (isTimeoutError(error) || (isAbortError(error) && Date.now() >= deadline)) {
    const timeout = timeoutFailure('download', '下载结果图超过本次调用的时间预算',
      Object.assign({ cause: error }, fields || {}));
    return timeout;
  }
  return attachFailure(error, Object.assign({
    code: (error && error.code) || 'download_failed',
    phase: (error && error.phase) || 'download'
  }, fields || {}));
}

/** 日志只写脱敏后的结构化字段：不带 prompt、不带完整 URL、不带 Key。 */
function logFailure(kind, error, fallbackPhase) {
  const fields = ['code=' + String((error && error.code) || 'unknown')];
  fields.push('phase=' + String((error && error.phase) || fallbackPhase || 'unknown'));
  if (error && error.jobId) fields.push('job=' + String(error.jobId).slice(0, 64));
  if (error && error.submissionState) fields.push('submission=' + error.submissionState);
  if (error && error.retryAfterMs !== undefined) fields.push('retryAfter=' + error.retryAfterMs);
  logHost(kind + ' failure ' + fields.join(' '));
}

function safeJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); } catch (_error) { return null; }
}
/**
 * 顺序稳定的 JSON：对象键排序后再序列化。
 *
 * 调用参数来自宿主，键顺序不保证稳定；如果直接 JSON.stringify，同一份请求
 * 可能算出两个不同指纹，去重就失效了。
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}
/**
 * 尺寸被上游拒了：不再偷偷抬档，直接把这次要的尺寸和该模型的合法范围说清楚。
 */
function sizeRejectedText(failure, fitted, hint) {
  const wanted = fitted && !fitted.omit ? String(fitted.size || '') : '（自动）';
  const detail = String((failure && failure.message) || '').slice(0, 200);
  return '上游拒绝尺寸 ' + wanted + (detail ? '：' + detail : '')
    + (hint ? '。' + hint() : '') + '。换一个尺寸，或换一个支持它的模型。';
}

function imageErrorText(failure) {
  const text = '生图接口失败：' + failure.message;
  const suffix = '（模型与提供商只能由用户在选择器里切换）';
  if (failure.kind === 'size') return text + '（该模型对尺寸有最小/最大像素限制，换一个尺寸或换支持该尺寸的模型）' + suffix;
  if (failure.kind === 'auth') return text + '（检查 API Key 与地址是否正确）' + suffix;
  if (failure.kind === 'param') return text + '（请求参数与模型不兼容）' + suffix;
  return text + suffix;
}
/**
 * 上游说「这个模型不支持这类操作」时，翻译成统一说法，
 * 免得对话模型把「模型不支持」当成临时故障去换模型重试。
 */
function unsupportedModelMessage(kind, failure) {
  const text = String((failure && failure.message) || '');
  if (!/(model|模型)/i.test(text)) return '';
  if (!/(not support|does not support|unsupported|不支持|cannot|无法)/i.test(text)) return '';
  return '该模型不支持' + (kind === 'edit' ? '图生图' : '文生图') + '：' + text;
}
const ERROR_BODY_LIMIT = 128 * 1024;
// 5xx/408 的正文可能是「任务已经建好」的信封，值得多读一点；但只取任务标识，正文一律不进消息。
const AMBIGUOUS_BODY_LIMIT = 2 * 1024 * 1024;
const TASK_ID_KEYS = ['task_id', 'taskId', 'id', 'request_id'];

function submittedFields(job, resumable = false) {
  return { submissionState: 'accepted', jobId: job?.id, resumable: Boolean(job?.id && resumable) };
}

function describeOutcome(error, fields) {
  const failure = attachFailure(error, fields);
  if (failure.resumable && failure.jobId) {
    failure.message += '。可用 resume_job_id=' + failure.jobId + ' 继续同一个任务。';
  } else if (failure.jobId && failure.submissionState === 'accepted' && failure.code !== 'task_failed') {
    failure.message += '。上游已受理，请先检查原任务。';
  } else if (failure.submissionState === 'unknown' && failure.code !== 'submission_unknown') {
    failure.message += '。上游受理状态未知，请先查询原任务。';
  }
  return failure;
}

function sanitizeTaskUrl(url, provider, adapter) {
  const spec = authSpecOf(provider, adapter);
  if (spec.mode !== 'query') return url;
  const target = new URL(url);
  if (provider.key) target.searchParams.delete(spec.name, String(provider.key).trim());
  return target.href;
}

async function readErrorBody(response) {
  try {
    return (await readResponseBytes(response, ERROR_BODY_LIMIT)).toString('utf8');
  } catch (_error) {
    // HTTP status is still available if an error body is truncated, too large, or unreadable.
    return '';
  }
}

/** 从一层对象里挑任务标识；键的顺序就是可信度顺序。 */
function taskIdOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  for (const key of TASK_ID_KEYS) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * 5xx / 408 的提交响应：上游可能已经受理了，正文里常带着 task_id / id / request_id。
 *
 * 读一次正文，只把任务标识挑出来（顶层，或 data.* / output.* 一层内）拼进错误消息。
 * 正文本身绝不进消息——可能很大，也可能带敏感信息；读不到就返回空串，保持原文案。
 */
async function ambiguousServerResponse(response) {
  let buffer;
  try {
    buffer = await readResponseBytes(response, AMBIGUOUS_BODY_LIMIT);
  } catch (_error) {
    return '';
  }
  if (!buffer.length) return '';
  const payload = safeJson(buffer);
  if (!payload || typeof payload !== 'object') return '';
  return taskIdOf(payload) || taskIdOf(payload.data) || taskIdOf(payload.output);
}

function protectedDrop(path, built, bindings) {
  if (isProtectedDropField(path)) return true;
  const fields = built.protectedFields || bindings?.() || {};
  const paths = Array.isArray(fields) ? fields : ['prompt', 'model', 'image'].flatMap((role) => {
    const field = fields[role];
    return [field?.path, field?.multipart, field?.numbered].filter(Boolean);
  });
  const canonical = (key) => key.replace(/\[(\d*)\]/g, '.$1').replace(/\.$/, '');
  const name = canonical(path);
  return paths.map(canonical).some((key) => key === name || key.startsWith(name + '.')
    || name.startsWith(key + '.') || key.split('.').pop() === name);
}

function submissionInit(built, method, deadline, signal) {
  return { method, body: built.body, headers: built.headers, signal: budgetSignal(deadline, signal) };
}

async function submitImage(kind, adapter, provider, input, build, deadline, signal, job, hooks) {
  const editFields = kind === 'edit' && adapter.editFields?.length ? adapter.editFields : ['image'];
  const drops = new Set();
  let fieldIndex = 0;
  let fingerprint = '';
  let lastFailure;
  let rateRetries = 0;
  let networkRetries = 0;
  let built;
  let rebuild = true;
  const jobFields = { jobId: job?.id };
  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    try { ensureBudget(deadline, 'submit', signal); } catch (error) {
      throw attachFailure(error, { ...jobFields, submissionState: 'rejected' });
    }
    if (rebuild) {
      try {
        built = await build(drops, editFields[fieldIndex], budgetSignal(deadline, signal));
      } catch (error) {
        if (signal?.aborted || isTimeoutError(error)) {
          throw describeOutcome(signal?.aborted ? cancelledFailure('prepare', signal) : timeoutFailure('prepare'), {
            ...jobFields, submissionState: 'rejected', cause: error
          });
        }
        throw attachFailure(error, { ...jobFields, phase: 'prepare', submissionState: 'rejected' });
      }
    }
    const target = joinEndpoint(baseUrlOf(provider), built.path);
    if (!built.path || !resolveHttpUrl(target)) {
      throw attachFailure(new Error('提供商提交地址无效'), {
        ...jobFields, code: 'invalid_endpoint', phase: 'prepare', submissionState: 'rejected'
      });
    }
    const method = built.method || 'POST';
    ensureBudget(deadline, 'submit', signal);
    if (rebuild && (editFields.length > 1 || built.allowFieldDrops !== false)) {
      const next = await requestFingerprint(method, target, built.body);
      if (next === fingerprint) {
        throw attachFailure(new Error(imageErrorText(lastFailure) + '（参数调整未改变请求，已停止）'), {
          ...jobFields, code: 'duplicate_request', phase: 'submit', submissionState: 'rejected'
        });
      }
      fingerprint = next;
    }
    rebuild = false;

    let response;
    try {
      response = await requestProvider(target, submissionInit(built, method, deadline, signal), provider, adapter, false);
    } catch (error) {
      if (signal?.aborted || Date.now() >= deadline || (isTimeoutError(error) && !networkNotSent(error))) {
        throw describeOutcome(signal?.aborted ? cancelledFailure('submit', signal) : timeoutFailure('submit'), {
          ...jobFields, submissionState: 'unknown', cause: error
        });
      }
      if (networkNotSent(error)) {
        if (networkRetries < MAX_RATE_LIMIT_RETRIES && attempt + 1 < MAX_SUBMIT_ATTEMPTS) {
          await sleepWithSignal(retryDelayMs(++networkRetries), budgetSignal(deadline, signal));
          continue;
        }
        throw attachFailure(error, { ...jobFields, code: 'network', phase: 'submit', submissionState: 'rejected' });
      }
      throw submissionUnknownFailure(networkErrorCode(error) || '网络中断', error, jobFields);
    }
    const output = built.output || adapter.responseOverrides?.[kind] || adapter.output;
    if (response.ok || ([302, 303].includes(response.status) && response.headers.get('location')
      && outputCandidatesOf(output).some((profile) => profile.pollUrlFrom === 'location'))) {
      return { response, built, submitUrl: resolveHttpUrl(response.url, target) || target };
    }

    // 5xx 与 408 都不等于「上游没执行」：请求可能已经被受理、任务已经建好。
    // 这两种一律只发一次 POST，绝不重试；正文只读一遍，用来找任务标识。
    if (response.status >= 500 || response.status === 408) {
      const status = response.status;
      const taskId = await ambiguousServerResponse(response);
      logFailure(kind, { ...jobFields, code: 'upstream', phase: 'submit', status, submissionState: 'unknown' }, 'submit');
      throw submissionUnknownFailure('HTTP ' + status, undefined, { ...jobFields, status }, taskId);
    }

    const failure = classifyFailure(response.status, credentialText(await readErrorBody(response), provider, adapter));
    const retryAfterMs = parseRetryAfter(response.headers);
    const fields = { ...jobFields, code: failureCode(failure), phase: 'submit', status: response.status, submissionState: 'rejected' };
    lastFailure = failure;
    logFailure(kind, fields, 'submit');
    if (failure.kind === 'rate') {
      const wait = retryDelayMs(rateRetries + 1, { retryAfterMs });
      if (rateRetries >= MAX_RATE_LIMIT_RETRIES || Date.now() + wait >= deadline || attempt + 1 === MAX_SUBMIT_ATTEMPTS) {
        throw attachFailure(new Error(imageErrorText(failure)), { ...fields, retryAfterMs });
      }
      rateRetries++;
      await sleepWithSignal(wait, budgetSignal(deadline, signal));
      continue;
    }
    // 兜底：分类器以后若把别的状态标成 retryable（或来了不可跟随的 3xx），
    // 同样按「受理状态未知」处理，绝不因为「可重试」就再发一次 POST。
    if (failure.retryable || (response.status >= 300 && response.status < 400)) {
      throw submissionUnknownFailure('HTTP ' + response.status, new Error(failure.message), {
        ...jobFields, status: response.status
      });
    }
    const capability = unsupportedModelMessage(kind, failure);
    if (capability) throw attachFailure(new Error(capability), { ...fields, code: 'unsupported_model' });
    if (failure.kind === 'size') {
      throw attachFailure(new Error(sizeRejectedText(failure, input.fitted, hooks.sizeHint)), fields);
    }
    const canAdjust = attempt + 1 < MAX_SUBMIT_ATTEMPTS && [400, 422].includes(response.status);
    if (canAdjust && built.allowFieldDrops !== false && failure.drop && !drops.has(failure.drop)) {
      if (protectedDrop(failure.drop, built, hooks.bindings)) {
        throw attachFailure(new Error(imageErrorText(failure) + '（上游要求移除必要字段 ' + failure.drop + '）'), fields);
      }
      drops.add(failure.drop);
      rebuild = true;
      continue;
    }
    if (canAdjust && /image/i.test(failure.message) && fieldIndex + 1 < editFields.length) {
      fieldIndex++;
      rebuild = true;
      continue;
    }
    throw attachFailure(new Error(imageErrorText(failure)), fields);
  }
}

async function createJob(journal, kind, adapter, provider, input) {
  if (!journal) return null;
  try {
    return await journal.create({
      status: 'submitting', kind, providerId: provider.id, providerName: provider.name || '',
      model: input.model, adapterId: adapter.id
    });
  } catch (error) {
    logHost('job journal create failed: ' + error.message);
    return null;
  }
}

async function updateJob(journal, job, patch) {
  if (!journal || !job?.id) return false;
  try {
    return Boolean(await journal.update(job.id, patch));
  } catch (error) {
    logHost('job journal update failed: ' + error.message);
    return false;
  }
}

/** Resolve and fetch each distinct image candidate at most once per completed response. */
async function downloadCandidate(image, base, tried, adapter, provider, signal) {
  if (image.bytes) return image;
  const url = resolveHttpUrl(image.url, base);
  if (!url) throw new Error('上游返回了无效的图片地址');
  if (tried.has(url)) throw tried.get(url);
  try {
    return await fetchResultImage(url, signal, adapter, provider);
  } catch (error) {
    tried.set(url, error);
    throw error;
  }
}

function pollError(adapter, status, failure) {
  if (adapter.id === 'comfyui') return new Error('ComfyUI 查询任务失败：HTTP ' + status);
  return new Error(imageErrorText(failure));
}

function taskError(adapter, state) {
  if (adapter.id === 'comfyui') {
    return new Error('ComfyUI 执行失败' + (state.message && state.message !== state.status
      ? '：' + state.message : '，请检查 ComfyUI 控制台'));
  }
  return new Error('生图任务失败' + (state.status ? '（' + state.status + '）' : '') + '：' + state.message);
}

async function readPollBody(response, maxBytes) {
  const buffer = await readResponseBytes(response, maxBytes);
  if (!buffer.length) return null;
  const json = safeJson(buffer);
  if (json === null) throw attachFailure(new Error('生图任务查询返回的不是 JSON（HTTP ' + response.status + '）'), {
    code: 'protocol_mismatch', phase: 'poll'
  });
  return json;
}

async function readTaskResult(spec, payload, submission, taskId, state, target, adapter, provider, tried, signal, submitUrl = target) {
  let source = payload;
  if (spec.via) {
    if (state.state !== 'success') return null;
    const url = resolveHttpUrl(viaUrlOf(spec.via, submission, null), submitUrl)
      || resolveHttpUrl(viaUrlOf(spec.via, {}, payload), target);
    if (!url) throw new Error(spec.emptyMessage || DEFAULT_EMPTY_MESSAGE);
    const response = await requestResult(url, signal, adapter, provider, 'result');
    source = await readJsonResponse(response, spec.via.maxBytes, provider, adapter);
    const actual = resolveHttpUrl(response.url, url) || url;
    const candidate = taskResultCandidates(spec, source, {
      taskId, baseUrl: baseUrlOf(provider), responseUrl: adapter.id === 'custom' ? actual : undefined, done: true
    }).next().value;
    if (candidate) return downloadCandidate(candidate, actual, tried, adapter, provider, signal);
    const node = resultNodeOf(source, spec, taskId);
    if (spec.resultAs) throw new Error(spec.emptyMessage || DEFAULT_EMPTY_MESSAGE);
    return downloadCandidate(readTaskImage(node, spec), actual, tried, adapter, provider, signal);
  }
  let lastError;
  for (const image of taskResultCandidates(spec, source, {
    taskId, baseUrl: baseUrlOf(provider), responseUrl: adapter.id === 'custom' ? target : undefined,
    done: state.state === 'success'
  })) {
    try {
      return await downloadCandidate(image, target, tried, adapter, provider, signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || isTimeoutError(error)) throw error;
      lastError = error;
    }
  }
  if (state.state === 'success' && lastError) throw lastError;
  return null;
}

/** The same read-only driver is used by gateways, native task providers and local workflows. */
async function pollImage(adapter, provider, task, deadline, signal) {
  const { spec, submission, taskId, submitUrl, pollTargets, tried, onTarget } = task;
  const backoff = backoffOf(spec);
  const limit = Math.min(deadline, Date.now() + (Number(spec.timeoutMs) || TOTAL_BUDGET_MS));
  const pollSignal = budgetSignal(limit, signal);
  let delay = backoff.startMs;
  let index = 0;
  let failures = 0;
  while (true) {
    ensureBudget(limit, 'poll', signal);
    await sleepWithSignal(Math.min(delay, Math.max(1, limit - Date.now())), pollSignal);
    ensureBudget(limit, 'poll', signal);
    const target = pollTargets[index];
    let response;
    let payload;
    try {
      response = await requestResult(target, pollSignal, adapter, provider, 'poll');
      if (response.ok && !(response.status === 202 && (adapter.id === 'fal' || spec.pollOutput === 'binary'))) {
        if (spec.pollOutput === 'binary') {
          const bytes = await readResponseBytes(response, spec.maxBytes || MAX_IMAGE_BYTES);
          if (looksLikeImage(bytes)) return readOutput(null, { kind: 'binary' }, {
            binary: bytes, contentType: response.headers.get('content-type')
          });
          if (bytes.length) throw attachFailure(new Error('轮询结果不是有效的二进制图片'), { code: 'protocol_mismatch', phase: 'poll' });
        } else {
          payload = await readPollBody(response, spec.maxBytes || MAX_IMAGE_BYTES);
        }
      }
    } catch (error) {
      if (pollSignal?.aborted || error.code === 'protocol_mismatch') throw error;
      if (error.localized?.code === 'upstream.tooLarge') {
        throw attachFailure(error, { code: 'payload', phase: 'poll' });
      }
      if (++failures > MAX_POLL_ERRORS) throw attachFailure(error, { code: 'network', phase: 'poll' });
      delay = nextBackoff(delay, spec);
      continue;
    }
    if ([404, 405].includes(response.status) && index + 1 < pollTargets.length) {
      await cancelBody(response);
      index++;
      if (onTarget) await onTarget(pollTargets.slice(index));
      delay = backoff.startMs;
      continue;
    }
    if (response.status === 404 && adapter.pollNotFoundPending) {
      await cancelBody(response);
      delay = nextBackoff(delay, spec);
      continue;
    }
    if (!response.ok) {
      const failure = classifyFailure(response.status, credentialText(await readErrorBody(response), provider, adapter));
      const retryAfterMs = parseRetryAfter(response.headers);
      if (failure.retryable && ++failures <= MAX_POLL_ERRORS && !adapter.pollErrorsAreTerminal) {
        delay = Math.max(nextBackoff(delay, spec), retryAfterMs);
        continue;
      }
      throw attachFailure(pollError(adapter, response.status, failure), {
        code: failureCode(failure), phase: 'poll', status: response.status, retryAfterMs
      });
    }
    failures = 0;
    delay = Math.max(nextBackoff(delay, spec), parseRetryAfter(response.headers));
    if (!payload) {
      await cancelBody(response);
      continue;
    }
    const state = typeof adapter.async?.statusOf === 'function' && !spec.statusPath
      ? adapter.async.statusOf(payload)
      : taskStateOf(spec, payload, taskId);
    if (state.state === 'failure') throw attachFailure(taskError(adapter, { ...state,
      message: credentialText(state.message, provider, adapter) }), { code: 'task_failed', phase: 'poll' });
    if (state.state !== 'success' && !(adapter.autoAsync && !adapter.waitForTaskSuccess)) continue;
    try {
      if (!spec.statusPath && typeof adapter.async?.resolve === 'function') {
        const image = await adapter.async.resolve(payload, provider, pollSignal, submission);
        if (image) return await downloadCandidate(image, target, tried, adapter, provider, pollSignal);
      }
      const image = await readTaskResult(spec, payload, submission, taskId, state,
        resolveHttpUrl(response.url, target) || target, adapter, provider, tried, pollSignal, submitUrl);
      if (image) return image;
    } catch (error) {
      throw downloadFailureOf(error, signal, limit);
    }
    if (state.state === 'success') {
      throw attachFailure(new Error(spec.emptyMessage || DEFAULT_EMPTY_MESSAGE), { code: 'image_invalid', phase: 'download' });
    }
  }
}

export async function followTask(kind, adapter, provider, submission, submitUrl, plan, fitted, model, signal, deadlineAt, hooks = {}) {
  const spec = plan.spec;
  const taskId = plan.taskId || '';
  const pollTargets = [...new Set((plan.pollTargets || []).map((url) => resolveHttpUrl(url, submitUrl)).filter(Boolean))];
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + TOTAL_BUDGET_MS;
  const job = hooks.job || hooks.resume;
  if (!pollTargets.length) {
    throw describeOutcome(new Error('生图接口返回了任务，但没有可用的轮询地址'), {
      ...submittedFields(job), code: 'protocol_mismatch', phase: 'poll'
    });
  }
  // Only values required to recover a task are persisted. A submission can include full image bytes.
  const viaUrl = spec.via ? resolveHttpUrl(viaUrlOf(spec.via, submission, null), submitUrl) : '';
  const retained = viaUrl ? { response_url: sanitizeTaskUrl(viaUrl, provider, adapter) } : {};
  const resumeSpec = spec.via && retained.response_url
    ? { ...spec, via: { ...spec.via, urlPath: ['submission.response_url', ...spec.via.urlPath.filter((path) => !path.startsWith('submission.'))] } }
    : spec;
  const pollRecord = (targets) => ({
    pollTarget: sanitizeTaskUrl(targets[0], provider, adapter),
    pollTargets: targets.map((url) => sanitizeTaskUrl(url, provider, adapter))
  });
  const record = {
    status: 'submitted', taskId, ...pollRecord(pollTargets),
    submitUrl: sanitizeTaskUrl(submitUrl, provider, adapter), taskSpec: resumeSpec,
    submission: retained, fitted, note: hooks.note || '',
    providerOrigin: new URL(submitUrl).origin,
    baseOrigin: resolveHttpUrl(baseUrlOf(provider)) ? new URL(baseUrlOf(provider)).origin : '',
    pollNotFoundPending: Boolean(adapter.pollNotFoundPending),
    waitForTaskSuccess: Boolean(adapter.waitForTaskSuccess),
    pollOrigins: adapter.pollOrigins || [],
    resultAuthOrigins: adapter.resultAuthOrigins || [],
    pollHeaders: adapter.pollHeaders || {}
  };
  const resumable = Boolean(hooks.resume) || await updateJob(hooks.journal, job, record);
  const fields = submittedFields(job, resumable);
  try {
    const image = await pollImage(adapter, provider, {
      spec, submission, taskId, submitUrl, pollTargets, tried: hooks.tried || new Map(),
      onTarget: resumable && hooks.journal ? (targets) => updateJob(hooks.journal, job, pollRecord(targets)) : null
    }, deadline, signal);
    return { ...image, fitted, jobId: job?.id, resumable, note: hooks.note || undefined };
  } catch (cause) {
    const failure = cause.code === 'task_failed';
    const error = signal?.aborted ? cancelledFailure(cause.phase || 'poll', signal)
      : isTimeoutError(cause) || isAbortError(cause) ? timeoutFailure(cause.phase || 'poll') : cause;
    if (failure && hooks.resume) await updateJob(hooks.journal, job, { status: 'failed', failure: error.message });
    throw describeOutcome(error, {
      ...fields, resumable: fields.resumable && !failure,
      phase: error.phase || 'poll', code: error.code || 'network', cause: error === cause ? undefined : cause
    });
  }
}

function responseLimit(output, asyncOnly) {
  if (asyncOnly) return 2 * 1024 * 1024;
  const candidates = outputCandidatesOf(output);
  return candidates.length ? Math.max(...candidates.map((item) => item.maxBytes || MAX_IMAGE_BYTES)) : MAX_IMAGE_BYTES;
}

async function materializeSubmission(kind, adapter, provider, input, submitted, deadline, signal, hooks) {
  const { response, built, submitUrl } = submitted;
  if (built.operation) {
    adapter = {
      ...adapter, operationOrigin: new URL(submitUrl).origin,
      pollOrigins: built.operation.pollOrigins, resultAuthOrigins: built.operation.resultOrigins,
      pollHeaders: built.operation.pollHeaders,
      pollNotFoundPending: built.operation.pollNotFoundPending === true,
      waitForTaskSuccess: built.operation.output === adapter.output ? false : true
    };
  }
  const override = adapter.responseOverrides?.[kind];
  if (override) adapter = { ...adapter, waitForTaskSuccess: true };
  const legacy = adapter.async && !built.output && !override && !adapter.output && !adapter.poll ? adapter.async : null;
  const output = built.output || override || adapter.output || taskSpecOf(adapter) || (legacy ? {
    kind: 'task', intervalMs: legacy.intervalMs, timeoutMs: legacy.timeoutMs, idPath: ['id', 'task_id']
  } : null);
  const fields = submittedFields(hooks.job);
  let buffer;
  const hopSignal = budgetSignal(deadline, signal);
  try {
    buffer = await readResponseBytes(response, responseLimit(output, !override && Boolean(adapter.async || adapter.taskSubmission)));
  } catch (error) {
    throw describeOutcome(downloadFailureOf(error, signal, deadline), fields);
  }
  const contentType = response.headers.get('content-type');
  const payload = buffer.length && !looksLikeImage(buffer) ? safeJson(buffer) : null;
  const tried = new Map();
  let lastError;
  let downloadError;
  const candidates = outputCandidatesOf(output);
  for (const candidate of candidates) {
    if (candidate.kind === 'task' || candidate === taskSpecOf(adapter)) {
      const profile = candidate.kind ? candidate : { ...candidate, kind: 'task' };
      const plan = taskPlanOf(profile, payload, {
        provider, submitUrl, location: response.headers.get('location')
      });
      const task = plan?.pollTargets.length ? plan : (legacy && typeof legacy.pollUrl === 'function' && payload ? {
        spec: profile, taskId: plan?.taskId || '', pollTargets: [legacy.pollUrl(payload, provider)]
      } : plan);
      if (!task) continue;
      if (!task.taskId && adapter.async) task.taskId = String(payload?.id || payload?.task_id || '');
      const state = taskStateOf(profile, payload, task.taskId);
      if (state.state === 'failure') {
        const message = credentialText(state.message, provider, adapter);
        throw describeOutcome(taskError(adapter, { ...state, message }), { ...fields, code: 'task_failed', phase: 'poll' });
      }
      if (!candidate.via && (state.state === 'success' || (adapter.autoAsync && !adapter.waitForTaskSuccess))) {
        try {
          const image = await readTaskResult(candidate, payload, null, task.taskId, state,
            submitUrl, adapter, provider, tried, hopSignal);
          if (image) return { ...image, fitted: input.fitted, note: built.note };
        } catch (error) {
          if (hopSignal?.aborted) throw describeOutcome(downloadFailureOf(error, signal, deadline), fields);
          downloadError = error;
        }
      }
      if (task.pollTargets.length) {
        return followTask(kind, adapter, provider, payload, submitUrl, task, input.fitted, input.model,
          signal, deadline, { ...hooks, note: built.note, tried });
      }
      lastError = new Error('上游返回了任务 ID，但缺少轮询地址');
      continue;
    }
    let candidateImage;
    try {
      candidateImage = readOutput(payload, candidate, {
        binary: buffer, contentType, baseUrl: baseUrlOf(provider),
        responseUrl: adapter.id === 'custom' ? submitUrl : undefined
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      const image = await downloadCandidate(candidateImage, submitUrl, tried, adapter, provider, hopSignal);
      return { ...image, fitted: input.fitted, note: built.note };
    } catch (error) {
      if (hopSignal?.aborted || isTimeoutError(error) || isAbortError(error)) {
        throw describeOutcome(downloadFailureOf(error, signal, deadline), fields);
      }
      downloadError = error;
    }
  }
  if (downloadError) throw describeOutcome(downloadFailureOf(downloadError, signal, deadline), fields);
  if (!adapter.autoAsync && !adapter.async && !adapter.taskSubmission && !payload?.data && (payload?.task_id || payload?.task_status)) {
    lastError = new Error('该接口返回异步任务。请选择可自动识别的协议，或在自定义返回格式中设置任务轮询。');
  }
  if (!candidates.length) {
    let image;
    try {
      image = decodeImagePayload(payload, buffer);
    } catch (error) {
      lastError = error;
    }
    if (image) {
      try {
        const result = await downloadCandidate(image, submitUrl, tried, adapter, provider, hopSignal);
        return { ...result, fitted: input.fitted, note: built.note };
      } catch (error) {
        throw describeOutcome(downloadFailureOf(error, signal, deadline), fields);
      }
    }
  }
  if (!lastError && candidates.some((profile) => profile.kind === 'task')) {
    lastError = new Error(adapter.id === 'comfyui' ? 'ComfyUI 没有返回 prompt_id' : '上游任务响应缺少可识别的任务 ID 或轮询地址');
  }
  throw describeOutcome(lastError || new Error(DEFAULT_EMPTY_MESSAGE), {
    ...fields, code: 'protocol_mismatch', phase: 'download'
  });
}

/** Adapter builds may prepare uploads or session data. The submission policy is shared here. */
export async function executeImageRequest(kind, adapter, provider, input, build, signal, hooks = {}) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const operationOutput = adapter.operations?.[kind]?.output || adapter.responseOverrides?.[kind];
  const mayQueue = adapter.async || adapter.taskSubmission
    || (operationOutput ? outputCandidatesOf(operationOutput).some((profile) => profile.kind === 'task') : adapter.autoAsync);
  const job = mayQueue ? await createJob(hooks.journal, kind, adapter, provider, input) : null;
  let outcome;
  try {
    const submitted = await submitImage(kind, adapter, provider, input, build, deadline, signal, job, hooks);
    outcome = await materializeSubmission(kind, adapter, provider, input, submitted, deadline, signal, { ...hooks, job });
  } catch (error) {
    if (provider?.key) error.message = credentialText(error.message, provider, adapter);
    if (job && !error.resumable && ['rejected', 'accepted'].includes(error.submissionState)) {
      await updateJob(hooks.journal, job, {
        status: error.submissionState === 'rejected' ? 'rejected' : 'failed', failure: error.message
      });
    }
    throw error;
  }
  if (job && !outcome.jobId) {
    await updateJob(hooks.journal, job, { status: 'received' });
    return { ...outcome, jobId: job.id };
  }
  return outcome;
}

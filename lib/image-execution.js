/**
 * 生图执行器：请求构造、提交边界、轮询、下载与错误契约。
 *
 * 从 lib/index.js 拆出来以后，执行器只依赖适配器层、net、retry 和 request-auth；
 * 不读配置、不碰工具注册。index.js 负责把 logger 注入进来，测试可以直接调用
 * callImageApi，不必先 apply 整个插件。
 */
import {
  prepareGenerate, prepareEdit, prepareAsync, preparePhaseAsync, pollUrlFor,
  readTaskId, readTaskState, decodeImagePayload, classifyFailure,
  fetchImageUrl, adapterBase, readResponseBytes, MAX_IMAGE_BYTES,
  adapterSupportsKind, readTaskEnvelope, taskPollUrls, taskStatusOf, taskImageOf, looseImageOf,
  sizeHintText
} from './adapters.js';
import { request } from './net.js';
import { fetchResultImage, pollRequestHeaders } from './request-auth.js';
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
  for (const key of ['code', 'phase', 'jobId', 'submissionState', 'retryAfterMs', 'status']) {
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
  if (reason instanceof Error) return attachFailure(reason, { code: 'cancelled', phase: phase });
  const error = new Error('操作已取消');
  error.name = 'AbortError';
  return attachFailure(error, { code: 'cancelled', phase: phase });
}

/** 预算耗尽：单独的 TimeoutError，和用户取消（AbortError）区分开。 */
function timeoutFailure(phase, detail, fields) {
  const error = new Error('生图超时：' + (detail || '本次调用已用完全部时间预算')
    + '。可以稍后用同样的提示词重试；若已拿到任务信息，先查询任务状态更稳妥。');
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

/** 语义指纹：方法 + URL + body。multipart 的 boundary 只在序列化时生成，天然不进指纹。 */
function requestFingerprint(method, url, body) {
  let payload = '';
  if (typeof body === 'string') {
    payload = body;
  } else if (body && typeof body.entries === 'function') {
    const parts = [];
    for (const [key, value] of body.entries()) {
      const file = value && typeof value === 'object' && 'size' in value;
      parts.push(key + '=' + (file ? '[file ' + (value.type || '') + '/' + value.size + ']' : String(value)));
    }
    payload = parts.join('&');
  } else if (body && typeof body === 'object') {
    try { payload = JSON.stringify(body); } catch (_error) { payload = ''; }
  }
  return String(method || 'GET').toUpperCase() + ' ' + String(url) + '\n' + payload;
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

/** 受理状态未知的提交：文案必须让上层「先查再决定重发」，而不是直接重试。 */
function submissionUnknownText(detail) {
  return '生图任务提交失败' + (detail ? '（' + detail + '）' : '')
    + '。这种情况无法确认上游是否已经受理，请不要直接重复提交（可能重复计费）；先查询任务状态，确认没有任务后再重试。';
}

function submissionUnknownFailure(detail, cause, fields) {
  return attachFailure(new Error(submissionUnknownText(detail)), Object.assign({
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
function sizeRejectedText(kind, adapter, input, failure, fitted) {
  const wanted = fitted && !fitted.omit ? String(fitted.size || '') : '（自动）';
  const detail = String((failure && failure.message) || '').slice(0, 200);
  const model = String((input && input.model) || '');
  return '上游拒绝尺寸 ' + wanted + (detail ? '：' + detail : '')
    + '。' + sizeHintText(adapter, model) + '。换一个尺寸，或换一个支持它的模型。';
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
/**
 * 真正发请求的地方：按适配器组装 → 发 → 解码。
 * 上游报错时只在三类情况下自愈：字段不认识（摘掉重试）、尺寸被拒（往上抬一档）、限流/5xx（退避重试）。
 */
/**
 * 异步入队型：提交任务 → 轮询到 SUCCEEDED → 下载图片。
 *
 * 提交、轮询、下载共用一份总预算，任何一段都不会把整次工具调用拖过宿主超时；
 * 提交失败时先判断「上游是否可能已受理」，受理状态不明就不重发。
 */
export async function callAsyncImage(kind, adapter, provider, input, signal, hooks) {
  const phase = adapter.async && typeof adapter.async === 'object' ? adapter.async : null;
  if (kind === 'edit' && !(phase && phase.edit)) {
    throw new Error('该模型（' + adapter.label + '）暂不支持参考图编辑，请到设置里换一个编辑模型。');
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const journal = hooks && hooks.journal && typeof hooks.journal.create === 'function' ? hooks.journal : null;
  // 恢复模式：不再提交，直接从已落盘的 submission/taskId/pollTarget 继续轮询。
  const resume = hooks && hooks.resume && typeof hooks.resume === 'object' ? hooks.resume : null;
  const drops = new Set();
  let fitted = (resume && resume.fitted) || input.fitted;
  let submission = resume ? resume.submission : null;
  let lastFailure = null;
  let lastNote = resume && resume.note ? String(resume.note) : '';
  let lastPrint = '';
  let job = resume ? { id: String(resume.jobId || '') } : null;
  // 429 是上游明确说「没有入队」，此时才允许原样重发（而且有次数上限）。
  let allowRepeat = false;
  let rateRetries = 0;
  let pollErrors = 0;

  // 提交前先落一条记录：进程在提交途中崩掉时，至少能看到「有一次提交状态未知」。
  if (journal && !resume) {
    try {
      job = await journal.create({
        status: 'submitting', kind: kind, providerId: provider.id, providerName: provider.name || '',
        model: input.model, adapterId: adapter.id
      });
    } catch (error) {
      logHost('job journal create failed: ' + String(error && error.message ? error.message : error));
    }
  }

  if (!resume) {
  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    ensureBudget(deadline, 'submit', signal);
    const attemptInput = Object.assign({}, input, { fitted: fitted });
    // 第 5 个参数是「可摘除字段」：适配器还没支持时会被忽略，
    // 这时重发同一份请求会被下面的指纹检查拦下，不会白建第二个任务。
    const built = phase
      ? await preparePhaseAsync(adapter, provider, attemptInput, signal, drops)
      : prepareAsync(adapter, provider, attemptInput, drops);
    if (built.note) lastNote = built.note;
    const submitUrl = /^https?:\/\//i.test(built.path) ? built.path : adapterBase(provider) + built.path;
    const fingerprint = requestFingerprint('POST', submitUrl, built.body);
    if (fingerprint === lastPrint && !allowRepeat) {
      // 与上一次完全相同的请求：重发不会得到不同结果，还可能在上游建出第二个任务。
      logHost(kind + ' async submit stop: identical request after [' + failureCode(lastFailure) + ']');
      throw attachFailure(new Error(imageErrorText(lastFailure || { kind: 'unknown', message: '任务提交失败' })
        + '（重试会原样重发同一个请求，已停止）'), {
        code: 'duplicate_request', phase: 'submit',
        submissionState: lastFailure ? 'rejected' : 'unknown'
      });
    }
    allowRepeat = false;
    lastPrint = fingerprint;

    let response;
    try {
      response = await request(submitUrl, {
        method: 'POST', headers: built.headers, body: built.body, signal: budgetSignal(deadline, signal)
      });
    } catch (error) {
      if (signal && signal.aborted) {
        // 用户取消：请求可能已经上路，受理状态按未知记，但取消本身要原样抛出。
        throw attachFailure(cancelledFailure('submit', signal), { submissionState: 'unknown', cause: error });
      }
      if (isTimeoutError(error) || Date.now() >= deadline) {
        throw timeoutFailure('submit', '提交请求超过本次调用的时间预算', { submissionState: 'unknown', cause: error });
      }
      logFailure(kind, { code: 'network', phase: 'submit' }, 'submit');
      // 提交阶段断连/超时时无法确认上游是否已受理：不盲目重发，把判断交给上层。
      throw submissionUnknownFailure(networkErrorCode(error) || '网络中断', error);
    }
    const buffer = await readResponseBytes(response, 2 * 1024 * 1024);
    if (response.ok) {
      submission = safeJson(buffer);
      break;
    }
    const failure = classifyFailure(response.status, buffer.toString('utf8'));
    lastFailure = failure;
    logHost(kind + ' async submit ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));
    const capability = unsupportedModelMessage(kind, failure);
    if (capability) {
      throw attachFailure(new Error(capability), {
        code: 'unsupported_model', phase: 'submit', submissionState: 'rejected', status: response.status
      });
    }

    // 429：上游明确没有入队，按 Retry-After 等待，最多两次，且受总预算约束。
    if (failure.kind === 'rate') {
      const retryAfterMs = parseRetryAfter(response.headers);
      if (rateRetries >= MAX_RATE_LIMIT_RETRIES) {
        throw attachFailure(new Error(imageErrorText(failure)), {
          code: 'rate_limit', phase: 'submit', submissionState: 'rejected',
          retryAfterMs: retryAfterMs, status: response.status
        });
      }
      rateRetries++;
      const waitMs = Math.min(retryDelayMs(rateRetries, { retryAfterMs: retryAfterMs }),
        Math.max(0, deadline - Date.now()));
      logHost(kind + ' async submit rate limited, retry #' + rateRetries + ' in ' + waitMs + 'ms');
      await sleepWithSignal(waitMs, signal);
      allowRepeat = true;
      continue;
    }

    if (failure.kind === 'param' && failure.drop) {
      if (isProtectedDropField(failure.drop)) {
        // 必要字段被上游点名：不能摘掉它去「凑」一次成功，保留原来的错误类别。
        logHost(kind + ' async submit refused to drop a protected field');
        throw attachFailure(new Error(imageErrorText(failure)
          + '（上游要求移除必要字段 ' + failure.drop + '；这属于请求与模型不兼容，不能自动摘除）'), {
          code: 'param', phase: 'submit', submissionState: 'rejected', status: response.status
        });
      }
      if (!drops.has(failure.drop)) {
        drops.add(failure.drop);
        logHost(kind + ' async drop param "' + failure.drop + '"');
        continue;
      }
      // 已经摘过一次还是同一个错误：不发第三次同样的请求。
      throw attachFailure(new Error(imageErrorText(failure)), {
        code: 'param', phase: 'submit', submissionState: 'rejected', status: response.status
      });
    }
    if (failure.kind === 'size') {
      throw attachFailure(new Error(sizeRejectedText(kind, adapter, input, failure, fitted)), {
        code: 'size', phase: 'submit', submissionState: 'rejected', status: response.status
      });
    }
    if (failure.retryable) {
      // 5xx 等：网关报错不代表上游没建任务（「已入队但网关 503」很常见），一律按未确认处理。
      logFailure(kind, { code: 'submission_unknown', phase: 'submit', status: response.status }, 'submit');
      throw submissionUnknownFailure('HTTP ' + response.status, Object.assign(
        new Error(failure.message || ('HTTP ' + response.status)), { status: response.status }
      ), { status: response.status });
    }
    // 其余 4xx（参数、鉴权、尺寸、限流以外的拒绝）是明确未受理，按现有分类直接报错。
    throw attachFailure(new Error(imageErrorText(failure)), {
      code: failureCode(failure), phase: 'submit', submissionState: 'rejected', status: response.status
    });
  }
  if (!submission) {
    throw attachFailure(new Error(imageErrorText(lastFailure || { kind: 'unknown', message: '任务提交失败' })), {
      code: failureCode(lastFailure), phase: 'submit',
      submissionState: lastFailure ? 'rejected' : 'unknown'
    });
  }
  }

  // 各家的任务 id 字段不一样：BFL/Replicate 是 id，魔搭是 task_id。
  const taskId = resume
    ? String(resume.taskId || '')
    : (phase
      ? String((submission && (submission.id || submission.task_id)) || '')
      : readTaskId(adapter, submission));
  if (!phase && !resume && !taskId) throw new Error('任务提交后没有拿到 task_id：' + JSON.stringify(submission).slice(0, 200));
  logHost(kind + ' async task=' + (taskId || 'unknown') + (resume ? ' resumed' : ' submitted'));

  const poll = adapter.poll || {};
  // 轮询地址只由提交响应和 baseUrl 决定（BFL 的 polling_url、Replicate 的 urls.get、
  // 魔搭的 /v1/tasks/{task_id}），提交后就能算死；算不出来说明提交响应不对，立刻报错。
  const pollTarget = resume
    ? String(resume.pollTarget || '')
    : (phase
      ? String(phase.pollUrl(submission, provider) || '')
      : pollUrlFor(adapter, provider, taskId));
  if (!pollTarget) throw new Error('任务提交后没有拿到轮询地址：' + JSON.stringify(submission).slice(0, 200));
  // 任务 id / 轮询地址已经拿到：马上落盘，后面进程重启也能从这里继续。
  if (job && !resume) {
    await journal.update(job.id, {
      status: 'submitted', taskId: taskId || '', pollTarget: pollTarget,
      submission: submission, fitted: fitted, note: lastNote
    }).catch((error) => logHost('job journal submit update failed: ' + String(error && error.message ? error.message : error)));
  }
  let interval = phase ? (Number(phase.intervalMs) || 2000) : (Number(poll.intervalMs) || 2000);
  let state = null;
  const pollFields = { jobId: taskId || undefined, submissionState: 'accepted' };
  const pollTimeout = () => timeoutFailure('poll',
    '任务轮询超过本次调用的时间预算' + (state && state.status ? '（最后状态 ' + state.status + '）' : ''),
    pollFields);
  const checkPollBudget = () => {
    if (signal && signal.aborted) throw attachFailure(cancelledFailure('poll', signal), pollFields);
    if (Date.now() >= deadline) throw pollTimeout();
  };

  while (true) {
    checkPollBudget();
    await sleepWithSignal(Math.min(interval, Math.max(1, deadline - Date.now())), signal);
    checkPollBudget();
    // 每一跳都按目标域重算头：轮询地址可能来自响应，不能默认继承提交用的凭据。
    const headers = pollRequestHeaders(adapter, provider, pollTarget);
    const hopSignal = budgetSignal(deadline, signal);
    let response;
    try {
      response = await request(pollTarget, { method: 'GET', headers: headers, signal: hopSignal });
    } catch (error) {
      if (signal && signal.aborted) throw attachFailure(cancelledFailure('poll', signal), pollFields);
      if (isTimeoutError(error) || Date.now() >= deadline) throw attachFailure(pollTimeout(), { cause: error });
      // 读状态是只读操作：瞬时网络错误退避重试几次，读到有效状态后计数清零。
      pollErrors++;
      logFailure(kind, { code: 'network', phase: 'poll' }, 'poll');
      if (pollErrors > MAX_POLL_ERRORS) {
        throw attachFailure(error, Object.assign({ code: 'network', phase: 'poll' }, pollFields));
      }
      interval = Math.min(Math.round(interval * 1.15), 5000);
      continue;
    }
    // 状态码优先于「空响应体」：空 401/403/500 不是「还在跑」。
    if (response.status === 404 || response.status === 405) {
      await cancelBody(response);
      throw attachFailure(new Error('生图任务查询地址不可用（HTTP ' + response.status + '）'), Object.assign({
        code: 'endpoint', phase: 'poll', status: response.status
      }, pollFields));
    }
    // fal 用 202 表示「还在跑」，不能当成错误。
    if (phase && response.status === 202) {
      await cancelBody(response);
      pollErrors = 0;
      interval = Math.min(Math.round(interval * 1.15), 5000);
      continue;
    }
    if (!response.ok) {
      const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);
      const failure = classifyFailure(response.status, buffer.toString('utf8'));
      logHost(kind + ' async poll ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));
      const fields = Object.assign({
        code: failureCode(failure), phase: 'poll', status: response.status,
        retryAfterMs: parseRetryAfter(response.headers)
      }, pollFields);
      if (failure.retryable && pollErrors < MAX_POLL_ERRORS) {
        pollErrors++;
        interval = Math.min(Math.round(interval * 1.15), 5000);
        continue;
      }
      throw attachFailure(new Error(imageErrorText(failure)), fields);
    }
    const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);
    if (!buffer.length) {
      // 只有空的 2xx（含 202）才是「还在跑」。
      pollErrors = 0;
      interval = Math.min(Math.round(interval * 1.15), 5000);
      continue;
    }
    const payload = safeJson(buffer);
    if (!payload) {
      throw attachFailure(new Error('生图任务查询返回的不是 JSON（HTTP ' + response.status + '）'),
        Object.assign({ code: 'protocol_mismatch', phase: 'poll' }, pollFields));
    }
    state = phase ? phase.statusOf(payload) : readTaskState(adapter, payload);
    pollErrors = 0;
    if (state.state === 'success') {
      try {
        if (phase) {
          const resolved = await phase.resolve(payload, provider, signal, submission);
          if (!resolved) throw new Error('生图任务没有返回图片');
          const image = resolved.bytes ? resolved : await fetchResultImage(resolved.url, hopSignal, adapter, provider);
          logHost(kind + ' async task=' + (taskId || 'unknown') + ' done');
          return { fitted: fitted, bytes: image.bytes, contentType: image.contentType, note: lastNote, jobId: job ? job.id : undefined };
        }
        const decoded = decodeImagePayload(state.node, null);
        const image = decoded.bytes ? decoded : await fetchResultImage(decoded.url, hopSignal, adapter, provider);
        logHost(kind + ' async task=' + taskId + ' done');
        return { fitted: fitted, bytes: image.bytes, contentType: image.contentType, jobId: job ? job.id : undefined };
      } catch (error) {
        throw downloadFailureOf(error, signal, deadline, pollFields);
      }
    }
    if (state.state === 'failure') {
      throw attachFailure(new Error('生图任务失败（' + state.status + '）：' + state.message),
        Object.assign({ code: 'task_failed', phase: 'poll' }, pollFields));
    }
    interval = Math.min(Math.round(interval * 1.15), 5000);
  }
}
/** 试着把候选结果落成图片；取不到就返回 null，交给后续逻辑（例如继续轮询）。 */
async function imageOrNull(image, signal, adapter, provider) {
  if (!image) return null;
  try {
    return image.bytes ? image : await fetchResultImage(image.url, signal, adapter, provider);
  } catch (error) {
    // 用户取消/工具超时不能被当成「这个地址不是图」，否则会继续轮询到预算耗尽。
    if (signal && signal.aborted) throw error;
    if (isAbortError(error) || isTimeoutError(error)) throw error;
    return null;
  }
}
/**
 * 通用异步入队：同步协议收到「任务包络」时，跟着轮询到出图。
 *
 * 轮询地址优先用响应里给的（polling_url / status_url / urls.get / Location），
 * 没给就按常见约定推：/v1/tasks/{id}、/tasks/{id}、提交地址/{id}；
 * 前一个 404/405 就换下一个候选，不要求用户配路径。
 * 轮询地址可能指向另一个域，所以每一跳都按目标域重新算凭据（见 pollRequestHeaders）。
 */
export async function followTask(kind, adapter, provider, submission, submitUrl, headers, fitted, model, signal, deadlineAt, hooks) {
  const task = readTaskEnvelope(submission);
  const taskId = (task && task.taskId) || '';
  const candidates = taskPollUrls(provider, submission, submitUrl);
  if (!candidates.length) {
    throw new Error('生图接口返回了异步任务，但没有可用的轮询地址：'
      + JSON.stringify(submission || {}).slice(0, 200));
  }
  logHost(kind + ' auto-task=' + (taskId || 'unknown') + ' submitted; poll=' + candidates.join(' | '));
  // 提交已经花掉的时间也要算进总预算：不能提交用 5 分钟、轮询再给 5 分钟。
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + TOTAL_BUDGET_MS;
  const resume = hooks && hooks.resume && typeof hooks.resume === 'object' ? hooks.resume : null;
  const journal = hooks && hooks.journal && typeof hooks.journal.create === 'function' ? hooks.journal : null;
  let job = resume ? { id: String(resume.jobId || '') } : null;
  if (journal && !resume) {
    try {
      job = await journal.create({
        status: 'submitted', kind: kind, providerId: provider.id, providerName: provider.name || '',
        model: String(model || ''), adapterId: adapter.id, taskId: taskId || '',
        submitUrl: submitUrl, submission: submission, pollTarget: candidates[0], fitted: fitted
      });
    } catch (error) {
      logHost('job journal auto-task create failed: ' + String(error && error.message ? error.message : error));
    }
  }
  let interval = 2000;
  let index = 0;
  let lastStatus = '';
  let pollErrors = 0;
  const probed = new Set();
  const pollFields = { jobId: taskId || undefined, submissionState: 'accepted' };
  const pollTimeout = () => timeoutFailure('poll',
    '任务轮询超过本次调用的时间预算' + (lastStatus ? '（最后状态 ' + lastStatus + '）' : ''),
    pollFields);
  const checkPollBudget = () => {
    if (signal && signal.aborted) throw attachFailure(cancelledFailure('poll', signal), pollFields);
    if (Date.now() >= deadline) throw pollTimeout();
  };

  while (true) {
    checkPollBudget();
    await sleepWithSignal(Math.min(interval, Math.max(1, deadline - Date.now())), signal);
    checkPollBudget();
    const target = candidates[index];
    // 提交头（可能是提交专用的头 + Key）不能直接带到轮询地址上。
    const pollTargetHeaders = pollRequestHeaders(adapter, provider, target);
    const hopSignal = budgetSignal(deadline, signal);
    let response;
    try {
      response = await request(target, { method: 'GET', headers: pollTargetHeaders, signal: hopSignal });
    } catch (error) {
      if (signal && signal.aborted) throw attachFailure(cancelledFailure('poll', signal), pollFields);
      if (isTimeoutError(error) || Date.now() >= deadline) throw attachFailure(pollTimeout(), { cause: error });
      pollErrors++;
      logFailure(kind, { code: 'network', phase: 'poll' }, 'poll');
      if (pollErrors > MAX_POLL_ERRORS) {
        throw attachFailure(error, Object.assign({ code: 'network', phase: 'poll' }, pollFields));
      }
      interval = Math.min(Math.round(interval * 1.15), 5000);
      continue;
    }
    if (response.status === 404 || response.status === 405) {
      // 切候选地址前先放掉响应体，否则连接会一直占着。
      await cancelBody(response);
      if (index + 1 < candidates.length) {
        index++;
        logHost(kind + ' auto-task poll 404, next: ' + candidates[index]);
        interval = Math.min(interval, 2000);
        continue;
      }
      throw attachFailure(new Error('生图任务查询地址都不可用（最后一个 ' + target + ' 返回 HTTP ' + response.status + '）'),
        Object.assign({ code: 'endpoint', phase: 'poll', status: response.status }, pollFields));
    }
    if (!response.ok) {
      const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);
      const failure = classifyFailure(response.status, buffer.toString('utf8'));
      logHost(kind + ' auto-task poll ' + response.status + ' [' + failure.kind + ']');
      const fields = Object.assign({
        code: failureCode(failure), phase: 'poll', status: response.status,
        retryAfterMs: parseRetryAfter(response.headers)
      }, pollFields);
      if (failure.retryable && pollErrors < MAX_POLL_ERRORS) {
        pollErrors++;
        interval = Math.min(Math.round(interval * 1.15), 5000);
        continue;
      }
      throw attachFailure(new Error(imageErrorText(failure)), fields);
    }
    const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);
    // 只有空的 2xx（含 202）才是「还在跑」：空 401/403/500 已经在上面按错误处理。
    if (!buffer.length) {
      pollErrors = 0;
      interval = Math.min(Math.round(interval * 1.15), 5000);
      continue;
    }
    const payload = safeJson(buffer);
    if (!payload) {
      throw attachFailure(new Error('生图任务查询返回的不是 JSON（HTTP ' + response.status + '）'),
        Object.assign({ code: 'protocol_mismatch', phase: 'poll' }, pollFields));
    }
    const state = taskStatusOf(payload);
    pollErrors = 0;
    lastStatus = state.status || (state.state === 'success' ? 'SUCCEEDED' : lastStatus);
    if (state.state === 'failure') {
      throw attachFailure(new Error('生图任务失败' + (state.status ? '（' + state.status + '）' : '') + '：' + state.message),
        Object.assign({ code: 'task_failed', phase: 'poll' }, pollFields));
    }
    // 结果图：明确的结果字段优先。成功或没有状态词时，顶层 url 也可能就是图，
    // 先探一次（同一个地址只探一次），不是图就继续等。
    let image = null;
    try {
      const container = taskImageOf(payload, { containersOnly: true });
      if (container) image = await imageOrNull(container, hopSignal, adapter, provider);
      if (!image && (state.state === 'success' || !state.status)) {
        const top = taskImageOf(payload);
        if (top && (top.bytes || !probed.has(top.url))) {
          if (!top.bytes) probed.add(top.url);
          image = await imageOrNull(top, hopSignal, adapter, provider);
        }
      }
      if (!image && state.state === 'success') {
        const loose = looseImageOf(payload);
        if (loose && (loose.bytes || !probed.has(loose.url))) {
          if (!loose.bytes) probed.add(loose.url);
          image = await imageOrNull(loose, hopSignal, adapter, provider);
        }
      }
    } catch (error) {
      if (signal && signal.aborted) throw attachFailure(cancelledFailure('poll', signal), pollFields);
      if (isTimeoutError(error) || (isAbortError(error) && Date.now() >= deadline)) {
        throw attachFailure(pollTimeout(), { cause: error });
      }
      throw error;
    }
    if (image) {
      logHost(kind + ' auto-task=' + (taskId || 'unknown') + ' done');
      return { fitted: fitted, bytes: image.bytes, contentType: image.contentType, jobId: job ? job.id : undefined };
    }
    if (state.state === 'success') {
      throw attachFailure(new Error('生图任务完成了但没有返回图片'),
        Object.assign({ code: 'image_invalid', phase: 'download' }, pollFields));
    }
    interval = Math.min(Math.round(interval * 1.15), 5000);
  }
  throw new Error('生图任务超时（' + (taskId || 'job') + '，最后轮询 ' + candidates[index]
    + (lastStatus ? '，最后状态 ' + lastStatus : '') + '）');
}
export async function callImageApi(kind, adapter, provider, input, signal, hooks) {
  if (!adapterSupportsKind(adapter, kind)) {
    throw new Error('该模型不支持' + (kind === 'edit' ? '图生图' : '文生图')
      + '（' + String(input.model || adapter.label) + '）。请到设置 → 生图模型换一个支持它的模型。');
  }
  if (adapter.async) return callAsyncImage(kind, adapter, provider, input, signal, hooks);
  if (typeof adapter.execute === 'function') {
    const out = await adapter.execute(kind, provider, input, signal);
    return { fitted: input.fitted, bytes: out.bytes, contentType: out.contentType, note: out.note };
  }
  const fieldNames = (adapter.editFields && adapter.editFields.length) ? adapter.editFields : ['image'];
  // 同步入口也有预算：429 的等待与重试同样不能把一次工具调用拖过超时。
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const drops = new Set();
  let fitted = input.fitted;
  let fieldIndex = 0;
  let retries = 0;
  let rateRetries = 0;
  let lastFailure = null;

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    ensureBudget(deadline, 'submit', signal);
    const built = kind === 'edit'
      ? prepareEdit(adapter, provider, Object.assign({}, input, { fitted: fitted }), drops, fieldNames[fieldIndex])
      : prepareGenerate(adapter, provider, Object.assign({}, input, { fitted: fitted }), drops);
    const submitUrl = adapterBase(provider) + built.path;
    let response;
    try {
      response = await request(submitUrl, {
        method: 'POST', headers: built.headers, body: built.body, signal: budgetSignal(deadline, signal)
      });
    } catch (error) {
      if (signal && signal.aborted) {
        throw attachFailure(cancelledFailure('submit', signal), { submissionState: 'unknown', cause: error });
      }
      if (isTimeoutError(error) || Date.now() >= deadline) {
        throw timeoutFailure('submit', '提交请求超过本次调用的时间预算', { submissionState: 'unknown', cause: error });
      }
      // 连接都没建立起来（DNS/拒连/TLS）时请求肯定没到上游，重发是安全的；
      // 其它网络错误（连接被重置、等响应头超时）可能已经送达，按受理未知处理。
      if (networkNotSent(error) && retries < MAX_RATE_LIMIT_RETRIES) {
        retries++;
        logHost(kind + ' submit network retry #' + retries + ' code=' + (networkErrorCode(error) || 'network'));
        await sleepWithSignal(retryDelayMs(retries), signal);
        continue;
      }
      logFailure(kind, { code: 'network', phase: 'submit' }, 'submit');
      // 同步入口不改原有错误文案（上层靠它定位网络问题），只补结构化字段：
      // submission=unknown 表示这次提交可能已经被上游处理，不能直接重发。
      throw attachFailure(error, {
        code: 'submission_unknown', phase: 'submit', submissionState: 'unknown'
      });
    }
    const buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);

    if (response.ok) {
      const parsed = safeJson(buffer);
      // 通用兼容族：响应里已经有图就直接返回；只有任务包络时才转异步轮询。
      if (adapter.autoAsync) {
        const envelope = parsed ? readTaskEnvelope(parsed) : null;
        // 有任务信号时先只认明确的结果字段；顶层 url 可能指向任务详情，
        // 但也可能就是现成图片，所以再试一次，失败才按任务轮询。
        const direct = parsed ? taskImageOf(parsed, envelope ? { containersOnly: true } : undefined) : null;
        const candidate = direct || (parsed && envelope ? taskImageOf(parsed) : null);
        const image = await imageOrNull(candidate, budgetSignal(deadline, signal), adapter, provider);
        if (image) return { fitted: fitted, bytes: image.bytes, contentType: image.contentType };
        if (envelope) {
          return await followTask(kind, adapter, provider, parsed, submitUrl, built.headers, fitted, input.model, signal, deadline, hooks);
        }
        // 202 + Location 也是常见的「任务已受理」形状。
        const headerPoll = String(response.headers.get('location') || '').trim();
        if (headerPoll) {
          return await followTask(kind, adapter, provider, { poll_url: headerPoll }, submitUrl, built.headers, fitted, input.model, signal, deadline, hooks);
        }
      }
      // 同步协议收到异步任务：先说清是协议没对上，别让模型以为是图片格式问题去重试。
      if (parsed && !parsed.data && (parsed.task_id || parsed.task_status)) {
        throw new Error('这个接口返回的是异步任务（task_id='
          + String(parsed.task_id || '未给出')
          + '），当前「API 协议」按同步方式调用，拿不到图片。请到设置 → 生图模型把「API 协议」改成「自动识别」，或选对应平台的异步适配器（例如魔搭选 modelscope）。');
      }
      const decoded = parsed ? decodeImagePayload(parsed, null) : decodeImagePayload(null, buffer);
      const image = decoded.bytes ? decoded : await fetchImageUrl(decoded.url, signal);
      return { fitted: fitted, bytes: image.bytes, contentType: image.contentType };
    }

    const failure = classifyFailure(response.status, buffer.toString('utf8'));
    lastFailure = failure;
    logHost(kind + ' upstream ' + response.status + ' [' + failure.kind + '] ' + failure.message.slice(0, 200));

    const capability = unsupportedModelMessage(kind, failure);
    if (capability) {
      throw attachFailure(new Error(capability), {
        code: 'unsupported_model', phase: 'submit', submissionState: 'rejected', status: response.status
      });
    }

    if (failure.kind === 'param' && failure.drop && !drops.has(failure.drop)) {
      if (isProtectedDropField(failure.drop)) {
        logHost(kind + ' refused to drop a protected field');
        throw attachFailure(new Error(imageErrorText(failure)
          + '（上游要求移除必要字段 ' + failure.drop + '；这属于请求与模型不兼容，不能自动摘除）'), {
          code: 'param', phase: 'submit', submissionState: 'rejected', status: response.status
        });
      }
      drops.add(failure.drop);
      logHost(kind + ' drop param "' + failure.drop + '" for adapter ' + adapter.id);
      continue;
    }
    if (kind === 'edit' && response.status === 400 && /image/i.test(failure.message) && fieldIndex + 1 < fieldNames.length) {
      fieldIndex++;
      logHost(kind + ' retry with form field "' + fieldNames[fieldIndex] + '"');
      continue;
    }
    if (failure.kind === 'size') {
      throw attachFailure(new Error(sizeRejectedText(kind, adapter, input, failure, fitted)), {
        code: 'size', phase: 'submit', submissionState: 'rejected', status: response.status
      });
    }
    // 429：上游明确没有入队，按 Retry-After 等待，最多两次。
    if (failure.kind === 'rate') {
      const retryAfterMs = parseRetryAfter(response.headers);
      if (rateRetries >= MAX_RATE_LIMIT_RETRIES) {
        throw attachFailure(new Error(imageErrorText(failure)), {
          code: 'rate_limit', phase: 'submit', submissionState: 'rejected',
          retryAfterMs: retryAfterMs, status: response.status
        });
      }
      rateRetries++;
      const waitMs = Math.min(retryDelayMs(rateRetries, { retryAfterMs: retryAfterMs }),
        Math.max(0, deadline - Date.now()));
      logHost(kind + ' rate limited, retry #' + rateRetries + ' in ' + waitMs + 'ms');
      await sleepWithSignal(waitMs, signal);
      continue;
    }
    if (failure.retryable && retries < 2) {
      retries++;
      logHost(kind + ' upstream retry #' + retries + ' after HTTP ' + response.status);
      await sleepWithSignal(retryDelayMs(retries, { retryAfterMs: parseRetryAfter(response.headers) }), signal);
      continue;
    }
    // 5xx 重试用尽后「上游是否已受理」仍然不明；4xx 则是明确拒绝。
    throw attachFailure(new Error(imageErrorText(failure)), {
      code: failureCode(failure), phase: 'submit',
      submissionState: failure.retryable ? 'unknown' : 'rejected',
      retryAfterMs: parseRetryAfter(response.headers), status: response.status
    });
  }
  throw attachFailure(new Error(imageErrorText(lastFailure || { kind: 'unknown', message: '重试次数用尽' })), {
    code: failureCode(lastFailure), phase: 'submit', submissionState: 'unknown'
  });
}
/**
 * 模型不接收尺寸参数时的降级：把尺寸写进提示词。
 * 生图模型对英文尺寸句最稳，所以这句固定英文。
 */

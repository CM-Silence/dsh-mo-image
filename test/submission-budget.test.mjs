/**
 * 提交边界、轮询凭据与时间预算的回归测试。
 *
 * 全部用可控的 fake adapter + stub fetch：不发真实网络请求，不断言 mock 自身，
 * 只看「发出去了什么」「发了几次」「错误上挂了什么字段」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sleepWithSignal, parseRetryAfter, retryDelayMs, isAbortError, isTimeoutError } from '../lib/retry.js';
import { pollRequestHeaders, downloadRequestHeaders, fetchResultImage } from '../lib/request-auth.js';
import { callImageApi } from '../lib/index.js';
import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/* --------------------------------------------------------------- retry.js */

test('sleepWithSignal waits out the delay when nothing cancels it', async () => {
  const started = Date.now();
  await sleepWithSignal(20, new AbortController().signal);
  assert.ok(Date.now() - started >= 10);
});

test('sleepWithSignal rejects with an AbortError as soon as the signal aborts', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = sleepWithSignal(5000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.ok(Date.now() - started < 2000, 'the wait must end on cancel, not run to completion');
});

test('an already aborted signal rejects without waiting at all', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(sleepWithSignal(5000, controller.signal), (error) => error.name === 'AbortError');
  assert.ok(Date.now() - started < 1000);
});

test('sleepWithSignal also accepts no signal at all', async () => {
  await sleepWithSignal(5);
});

test('parseRetryAfter reads seconds and HTTP dates, and ignores junk', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '3' })), 3000);
  assert.equal(parseRetryAfter({ 'Retry-After': '2' }), 2000);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '0' })), 0);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '-5' })), 0);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': 'soon' })), 0);
  assert.equal(parseRetryAfter(undefined), 0);
  const date = new Date(Date.now() + 4000).toUTCString();
  const fromDate = parseRetryAfter(new Headers({ 'retry-after': date }));
  assert.ok(fromDate > 1000 && fromDate <= 4000, 'a HTTP date becomes a positive delay: ' + fromDate);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '600' })), 60000, 'the delay is capped at a minute');
});

test('retryDelayMs backs off exponentially, stays in bounds and honours Retry-After', () => {
  assert.equal(retryDelayMs(2, { baseMs: 100, maxMs: 1000, random: () => 0 }), 160, 'jitter floor is 0.8');
  assert.equal(retryDelayMs(2, { baseMs: 100, maxMs: 1000, random: () => 1 }), 240, 'jitter ceiling is 1.2');
  assert.equal(retryDelayMs(9, { baseMs: 100, maxMs: 300, random: () => 1 }), 300, 'capped by maxMs');
  assert.equal(retryDelayMs(2, { retryAfterMs: 2500, random: () => 0.5 }), 2500, 'Retry-After wins over backoff');
  assert.equal(retryDelayMs(1, { retryAfterMs: 120000 }), 60000, 'a server asking for too long is capped');
  for (let attempt = 1; attempt <= 6; attempt++) {
    const value = retryDelayMs(attempt, { random: () => 0.3 });
    assert.ok(Number.isInteger(value) && value >= 0, 'always a non-negative integer: ' + value);
    assert.ok(value <= 5000);
  }
});

test('isAbortError and isTimeoutError recognise the shapes the network stack throws', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const abortCode = new Error('aborted');
  abortCode.code = 'UND_ERR_ABORTED';
  const legacyAbort = new Error('aborted');
  legacyAbort.code = 'ERR_ABORTED';
  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  const wrapped = new Error('network failure', { cause: abortCode });

  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(abortCode), true);
  assert.equal(isAbortError(legacyAbort), true);
  assert.equal(isAbortError(wrapped), true, 'the cause chain is inspected too');
  assert.equal(isAbortError(timeout), false);
  assert.equal(isAbortError(new Error('nope')), false);
  assert.equal(isTimeoutError(timeout), true);
  assert.equal(isTimeoutError(new Error('nope')), false);
  assert.equal(isTimeoutError(abort), false);
});

/* ---------------------------------------------------------- request-auth.js */

function authAdapter(extra = {}) {
  return Object.assign({ id: 'fake', label: 'Fake', authHeader: 'bearer' }, extra);
}

test('poll headers stay with the provider origin and follow the adapter own headers there', () => {
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  const adapter = authAdapter({ async: { pollHeaders: () => ({ 'x-key': 'k' }) } });
  assert.deepEqual(pollRequestHeaders(adapter, provider, 'https://api.test/v1/tasks/1'), { 'x-key': 'k' });

  const plain = authAdapter();
  assert.deepEqual(pollRequestHeaders(plain, provider, 'https://api.test/v1/tasks/1'), {
    Authorization: 'Bearer k'
  }, 'the default poll credential is a Bearer header limited to the provider origin');
});

test('an undeclared cross-origin poll target gets no credentials at all', () => {
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  assert.deepEqual(pollRequestHeaders(authAdapter(), provider, 'https://poll.test/1'), {});
  assert.deepEqual(pollRequestHeaders(authAdapter(), provider, 'not a url'), {});
  assert.deepEqual(pollRequestHeaders(authAdapter(), { baseUrl: 'not a url', key: 'k' }, 'https://poll.test/1'), {});
});

test('a declared trusted poll origin gets the credentials again', () => {
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  const byOrigin = authAdapter({ pollOrigins: ['https://poll.test'] });
  assert.deepEqual(pollRequestHeaders(byOrigin, provider, 'https://poll.test/1'), { Authorization: 'Bearer k' });
  assert.deepEqual(pollRequestHeaders(byOrigin, provider, 'https://elsewhere.test/1'), {},
    'only the declared origin is trusted');

  const byHostname = authAdapter({ async: { trustedPollOrigins: ['poll.test'] } });
  assert.deepEqual(pollRequestHeaders(byHostname, provider, 'https://poll.test/1'), { Authorization: 'Bearer k' });
});

test('result downloads authenticate on the provider origin but never on a CDN', () => {
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  const adapter = authAdapter();
  assert.deepEqual(downloadRequestHeaders(adapter, provider, 'https://api.test/view?filename=a.png'), {
    Authorization: 'Bearer k'
  }, 'a protected ComfyUI-style /view on the provider origin needs the key');

  assert.deepEqual(downloadRequestHeaders(adapter, provider, 'https://cdn.test/a.png'), {},
    'a signed CDN address must not receive the key');

  const declared = authAdapter({ resultAuthOrigins: ['https://files.test'] });
  assert.deepEqual(downloadRequestHeaders(declared, provider, 'https://files.test/a.png'), {
    Authorization: 'Bearer k'
  }, 'an adapter may declare a result host that needs the key');
  assert.deepEqual(downloadRequestHeaders(declared, provider, 'https://cdn.test/a.png'), {});
});

test('fetchResultImage downloads with the scoped headers and validates the bytes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return pngResponse();
  };
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };

  const same = await fetchResultImage('https://api.test/view?filename=a.png', new AbortController().signal, authAdapter(), provider);
  assert.equal(same.contentType, 'image/png');
  assert.ok(same.bytes.length > 0);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');

  await fetchResultImage('https://cdn.test/a.png', new AbortController().signal, authAdapter(), provider);
  assert.equal(calls[1].init.headers, undefined, 'a CDN download carries no headers at all');
});

test('fetchResultImage reports the status of a rejected download and refuses non-images', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  let reply = () => new Response(null, { status: 403 });
  globalThis.fetch = async () => reply();

  await assert.rejects(
    () => fetchResultImage('https://api.test/out.png', new AbortController().signal, authAdapter(), provider),
    (error) => {
      assert.equal(error.status, 403);
      assert.match(String(error.message), /403/);
      return true;
    }
  );

  reply = () => new Response('<html>not an image</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    () => fetchResultImage('https://cdn.test/a.png', new AbortController().signal, authAdapter(), provider),
    /不是有效图片/
  );
});

/* -------------------------------------------------- lib/index.js 提交边界 */

const fitted = { width: 1024, height: 1024, size: '1024x1024' };

/** 旧式（描述符之前的）异步适配器：提交体走通用组装（字段模板），便于观察参数摘除。 */
function legacyAsyncAdapter(overrides = {}) {
  return Object.assign({
    id: 'fake-legacy-async',
    label: 'Fake legacy async',
    endpoints: { generate: '/jobs', edit: '/jobs' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 1,
    async: true,
    poll: {
      path: '/tasks/{taskId}',
      idPath: 'task_id',
      statusPath: 'status',
      success: ['SUCCEEDED'],
      failure: ['FAILED'],
      resultPath: 'output',
      intervalMs: 1,
      timeoutMs: 5000
    }
  }, overrides);
}

function gatewayProvider(baseUrl = 'https://api.test/v1', key = 'k') {
  return { id: 'p', name: 'p', baseUrl: baseUrl, key: key };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

test('a rejected optional field is dropped once, and an identical resend is refused', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || '').toUpperCase() === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return jsonResponse({ error: { message: 'unknown parameter: negative_prompt' } }, 400);
    }
    return jsonResponse({ task_id: 'job', status: 'RUNNING' });
  };

  await assert.rejects(
    () => callImageApi('generate', legacyAsyncAdapter(), gatewayProvider(), {
      model: 'm', prompt: 'p', negativePrompt: 'blurry', fitted: fitted
    }, new AbortController().signal),
    /unknown parameter: negative_prompt/
  );

  assert.equal(posts.length, 2, 'one retry after dropping the field, never a third identical POST');
  assert.equal(posts[0].negative_prompt, 'blurry');
  assert.equal(posts[1].negative_prompt, undefined, 'the rejected field is gone from the retried request');
  assert.equal(posts[1].prompt, 'p', 'the rest of the request is untouched');
});

test('a rejected protected field is reported instead of being removed', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || '').toUpperCase() === 'POST') posts.push(String(init.body));
    return jsonResponse({ error: { message: 'unknown parameter: prompt' } }, 400);
  };

  await assert.rejects(
    () => callImageApi('generate', legacyAsyncAdapter(), gatewayProvider(), {
      model: 'm', prompt: 'p', fitted: fitted
    }, new AbortController().signal),
    (error) => {
      assert.equal(error.phase, 'submit');
      assert.match(String(error.message), /prompt/);
      return true;
    }
  );
  assert.equal(posts.length, 1, 'the necessary field is never dropped to force a retry');
});

test('a submit network failure marks the submission unknown and posts only once', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let posts = 0;
  globalThis.fetch = async () => {
    posts++;
    const error = new Error('socket hang up');
    error.cause = Object.assign(new Error('socket'), { code: 'ECONNRESET' });
    throw error;
  };

  await assert.rejects(
    () => callImageApi('generate', legacyAsyncAdapter(), gatewayProvider(), {
      model: 'm', prompt: 'p', fitted: fitted
    }, new AbortController().signal),
    (error) => {
      assert.equal(error.submissionState, 'unknown');
      assert.equal(error.phase, 'submit');
      assert.ok(error.cause, 'the original network error stays available as cause');
      assert.match(String(error.message), /无法确认上游是否已经受理|不要直接重复提交/);
      return true;
    }
  );
  assert.equal(posts, 1, 'an unknown submission is never blindly resent');
});

test('a 5xx submit is not resent and is reported as an unknown submission', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let posts = 0;
  globalThis.fetch = async () => {
    posts++;
    return jsonResponse({ error: 'overloaded' }, 503);
  };

  await assert.rejects(
    () => callImageApi('generate', legacyAsyncAdapter(), gatewayProvider(), {
      model: 'm', prompt: 'p', fitted: fitted
    }, new AbortController().signal),
    (error) => {
      assert.equal(error.submissionState, 'unknown');
      assert.equal(error.phase, 'submit');
      return true;
    }
  );
  assert.equal(posts, 1);
});

/* ---------------------------------------- 5xx / 408 / 429 的提交分支 */

/** 同步适配器：没有任务包络，POST 之后直接读响应体。 */
function syncAdapter(overrides = {}) {
  return Object.assign({
    id: 'fake-sync',
    label: 'Fake sync',
    endpoints: { generate: '/images', edit: '/images' },
    transport: { generate: 'json', edit: 'json' },
    maxN: 1
  }, overrides);
}

const submitInput = { model: 'm', prompt: 'p', fitted: fitted };

/** 装一个只数 POST 的 fetch 桩，返回「发了几次」。 */
function stubSubmit(reply) {
  const state = { posts: 0 };
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || '').toUpperCase() === 'POST') state.posts++;
    return reply(url, init);
  };
  return () => state.posts;
}

test('a 5xx submit is posted once for sync and async adapters alike', async () => {
  const original = globalThis.fetch;
  try {
    for (const make of [syncAdapter, legacyAsyncAdapter]) {
      const adapter = make();
      const posts = stubSubmit(() => jsonResponse({ error: 'overloaded' }, 503));
      await assert.rejects(
        () => callImageApi('generate', adapter, gatewayProvider(), submitInput, new AbortController().signal),
        (error) => {
          assert.equal(error.code, 'submission_unknown');
          assert.equal(error.submissionState, 'unknown');
          assert.equal(error.phase, 'submit');
          assert.equal(error.status, 503);
          return true;
        }
      );
      assert.equal(posts(), 1, adapter.id + ' must not post a 5xx submit twice');
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('a 408 submit is an unknown submission and is posted once', async () => {
  const original = globalThis.fetch;
  try {
    for (const make of [syncAdapter, legacyAsyncAdapter]) {
      const adapter = make();
      // 408 走的就是 5xx 那条路：正文里的任务标识同样要被报出来。
      const posts = stubSubmit(() => jsonResponse({ task_id: 'pending-408', error: 'request timeout' }, 408));
      await assert.rejects(
        () => callImageApi('generate', adapter, gatewayProvider(), submitInput, new AbortController().signal),
        (error) => {
          assert.equal(error.code, 'submission_unknown');
          assert.equal(error.submissionState, 'unknown',
            '408 means the upstream may already own the request, so it is never "rejected"');
          assert.equal(error.phase, 'submit');
          assert.equal(error.status, 408);
          assert.ok(String(error.message).includes('pending-408'),
            'a 408 takes the same path as a 5xx and reports the task id it found');
          return true;
        }
      );
      assert.equal(posts(), 1, adapter.id + ' must not post a 408 submit twice');
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('a 5xx body that names a task id reports it and never dumps the body', async () => {
  const original = globalThis.fetch;
  try {
    const cases = [
      { body: { task_id: 'task-top-1', debug: 'SENSITIVE-MARKER' }, id: 'task-top-1' },
      { body: { data: { id: 'task-data-2' }, debug: 'SENSITIVE-MARKER' }, id: 'task-data-2' },
      { body: { output: { request_id: 'req-3' }, debug: 'SENSITIVE-MARKER' }, id: 'req-3' },
      { body: { taskId: 987654, debug: 'SENSITIVE-MARKER' }, id: '987654' }
    ];
    for (const item of cases) {
      const posts = stubSubmit(() => jsonResponse(item.body, 503));
      await assert.rejects(
        () => callImageApi('generate', syncAdapter(), gatewayProvider(), submitInput, new AbortController().signal),
        (error) => {
          assert.equal(error.submissionState, 'unknown');
          assert.match(String(error.message), /上游可能已创建任务/);
          assert.ok(String(error.message).includes(item.id), 'the message must name ' + item.id);
          assert.doesNotMatch(String(error.message), /SENSITIVE-MARKER/,
            'the body itself must never be copied into the message');
          return true;
        }
      );
      assert.equal(posts(), 1, 'the 5xx is still never resent after reading its body');
    }

    // 扫不到 id 就退回原文案：状态未知、不许直接重发。
    const posts = stubSubmit(() => jsonResponse({ error: 'overloaded', debug: 'SENSITIVE-MARKER' }, 503));
    await assert.rejects(
      () => callImageApi('generate', syncAdapter(), gatewayProvider(), submitInput, new AbortController().signal),
      (error) => {
        assert.equal(error.submissionState, 'unknown');
        assert.match(String(error.message), /无法确认上游是否已经受理/);
        assert.doesNotMatch(String(error.message), /上游可能已创建任务|SENSITIVE-MARKER/);
        return true;
      }
    );
    assert.equal(posts(), 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a 429 submit still retries on the sync path', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const posts = stubSubmit(() => new Response(JSON.stringify({ error: 'rate limited' }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' }
  }));
  await assert.rejects(
    () => callImageApi('generate', syncAdapter(), gatewayProvider(), submitInput, new AbortController().signal),
    (error) => {
      assert.equal(error.code, 'rate_limit');
      assert.equal(error.phase, 'submit');
      assert.equal(error.submissionState, 'rejected');
      assert.equal(error.retryAfterMs, 0);
      return true;
    }
  );
  assert.equal(posts(), 3, 'the first submit plus at most two rate-limit retries');
});

test('an empty 401 while polling is an auth failure, not a pending task', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let polls = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || '').toUpperCase() === 'POST') return jsonResponse({ task_id: 'job-1' });
    polls++;
    return new Response(null, { status: 401 });
  };

  await assert.rejects(
    () => callImageApi('generate', legacyAsyncAdapter(), gatewayProvider(), {
      model: 'm', prompt: 'p', fitted: fitted
    }, new AbortController().signal),
    (error) => {
      assert.equal(error.phase, 'poll');
      assert.equal(error.code, 'auth');
      return true;
    }
  );
  assert.equal(polls, 1, 'the empty body is not interpreted as "still running"');
});

test('a 429 submit honours Retry-After within a bounded number of attempts', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(init.method || '').toUpperCase() === 'POST') {
      posts++;
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' }
      });
    }
    return jsonResponse({ task_id: 'job', status: 'RUNNING' });
  };

  await assert.rejects(
    () => callImageApi('generate', legacyAsyncAdapter(), gatewayProvider(), {
      model: 'm', prompt: 'p', fitted: fitted
    }, new AbortController().signal),
    (error) => {
      assert.equal(error.code, 'rate_limit');
      assert.equal(error.phase, 'submit');
      assert.equal(error.submissionState, 'rejected');
      assert.equal(error.retryAfterMs, 0);
      return true;
    }
  );
  assert.equal(posts, 3, 'the first submit plus at most two rate-limit retries');
});

test('polling a cross-origin task URL never carries the provider key', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    if (String(init.method || '').toUpperCase() === 'POST') {
      return jsonResponse({ task_id: 'job-1', polling_url: 'https://poll.test/job-1' });
    }
    if (target === 'https://poll.test/job-1') {
      return jsonResponse({ status: 'SUCCEEDED', images: ['https://cdn.test/out.png'] });
    }
    if (target === 'https://cdn.test/out.png') return pngResponse();
    throw new Error('unexpected url ' + target);
  };

  // 用真的 openai-images 协议，不再手搓一个 `{autoAsync:true}` 的空壳适配器：
  // 「认任务包络」现在全在 `adapter.output` 候选列表里（描述符数据），手搓的空壳没有它，
  // 就等于关掉了通用网关的任务识别。这条测的是**轮询凭据**，与协议形状无关。
  const adapter = resolveAdapter({ id: 'gateway', name: 'Gateway', baseUrl: 'https://gateway.test/v1' }, 'm');
  assert.equal(adapter.id, 'openai-images');
  assert.equal(adapter.autoAsync, true);
  const provider = gatewayProvider('https://gateway.test/v1', 'super-secret');

  const result = await callImageApi('generate', adapter, provider, {
    model: 'm', prompt: 'p', fitted: fitted
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  const submit = calls.find((call) => call.url === 'https://gateway.test/v1/images/generations');
  assert.equal(submit.init.headers.Authorization, 'Bearer super-secret');
  const poll = calls.find((call) => call.url === 'https://poll.test/job-1');
  assert.ok(poll, 'the cross-origin poll URL is still followed');
  assert.equal(poll.init.headers.Authorization, undefined, 'the key never follows the task to another origin');
  assert.equal(poll.init.headers['x-key'], undefined);
  const download = calls.find((call) => call.url === 'https://cdn.test/out.png');
  assert.equal(download.init.headers, undefined, 'the CDN download carries no credentials');
});

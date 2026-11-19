import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

/* 一次工具调用的生命周期：同 callId 去重、不同 callId 各自执行、上游并发有上限。 */

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-call-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1',
      apiKeyEnv: 'MO_IMAGE_CALL_KEY', optionalKey: true, protocol: 'openai-images',
      adapter: '', models: ['some-image-model'], names: {}
    }],
    active: { providerId: 'p1', model: 'some-image-model' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  }), 'utf8');
  return home;
}

function fakeContext(tools) {
  const credentials = {
    async resolve() { return { value: 'sk-test', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; },
    async set() {}, async unset() {}
  };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; }, guard() { return () => {}; } },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

async function harness(t, options = {}) {
  const home = makeHome();
  const work = mkdtempSync(path.join(os.tmpdir(), 'mo-image-call-cwd-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tools = [];
  const mod = await import('../lib/index.js?call-lifecycle-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools), { update: { skipCheck: true }, ...options.applyOptions });

  const originalFetch = globalThis.fetch;
  const calls = [];
  let active = 0;
  let peak = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, Number(options.delayMs) || 10));
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    } finally {
      active -= 1;
    }
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const settings = tools.find((tool) => tool.name === 'mo_image_settings');
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const session = { header: { id: 'session-1', cwd: work } };
  const exec = { callId: 'call-1', signal: new AbortController().signal, agent: { session } };
  await settings.execute({}, exec);

  return {
    generate, session, exec, calls,
    peak: () => peak,
    posts: () => calls.filter((call) => String(call.init.method || '').toUpperCase() === 'POST')
  };
}

test('the same callId and request run once and both callers get the same result', async (t) => {
  const { generate, exec, posts } = await harness(t, { delayMs: 40 });

  const [first, second] = await Promise.all([
    generate.execute({ prompt: 'a cat' }, exec),
    generate.execute({ prompt: 'a cat' }, exec)
  ]);

  assert.equal(posts().length, 1, 'only one paid POST for one call identity');
  assert.equal(first.path, second.path);
  assert.equal(first.model, 'some-image-model');
});

test('the same callId with a different request is a conflict, not a silent reuse', async (t) => {
  const { generate, exec, posts } = await harness(t);

  await generate.execute({ prompt: 'a cat' }, exec);
  await assert.rejects(
    () => generate.execute({ prompt: 'a dog' }, exec),
    (error) => {
      assert.equal(error.code, 'call_conflict');
      return true;
    }
  );
  assert.equal(posts().length, 1, 'the conflicting call must not submit again');
});

test('a new callId is a new task even when the prompt is identical', async (t) => {
  const { generate, exec, posts } = await harness(t);

  await generate.execute({ prompt: 'a cat' }, exec);
  exec.callId = 'call-2';
  const second = await generate.execute({ prompt: 'a cat' }, exec);

  assert.equal(posts().length, 2);
  assert.ok(second.path);
});

test('upstream calls respect the queue concurrency limit', async (t) => {
  const { generate, session, calls, peak } = await harness(t, {
    delayMs: 60,
    applyOptions: { queue: { concurrency: 2, maxWaiting: 8 } }
  });

  const callsToMake = [1, 2, 3].map((index) => {
    const exec = { callId: 'queue-' + index, signal: new AbortController().signal, agent: { session } };
    return generate.execute({ prompt: 'cat ' + index }, exec);
  });
  const results = await Promise.all(callsToMake);

  assert.equal(calls.length, 3);
  assert.equal(results.length, 3);
  assert.ok(peak() <= 2, 'never more than two upstream calls in flight: ' + peak());
});

/* ------------------------------------------------------- 异步任务日志 */

function makeBflHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-bfl-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'BFL', baseUrl: 'https://api.bfl.ai/v1',
      apiKeyEnv: 'MO_IMAGE_BFL_KEY', optionalKey: true, adapter: 'bfl',
      models: ['flux-2-pro'], names: {}
    }],
    active: { providerId: 'p1', model: 'flux-2-pro' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  }), 'utf8');
  return home;
}

async function bflHarness(t) {
  const home = makeBflHome();
  const work = mkdtempSync(path.join(os.tmpdir(), 'mo-image-bfl-cwd-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tools = [];
  const mod = await import('../lib/index.js?bfl-journal-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools), { queue: { concurrency: 2, maxWaiting: 8 }, update: { skipCheck: true } });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, method: String((init && init.method) || 'GET').toUpperCase() });
    if (target === 'https://api.bfl.ai/v1/flux-2-pro') {
      return new Response(JSON.stringify({ id: 'job-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-1' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (target.startsWith('https://api.bfl.ai/v1/get_result')) {
      return new Response(JSON.stringify({ status: 'Ready', result: { sample: 'https://cdn.test/bfl.png' } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (target === 'https://cdn.test/bfl.png') {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected url ' + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const settings = tools.find((tool) => tool.name === 'mo_image_settings');
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const session = { header: { id: 'bfl-session', cwd: work } };
  const exec = { callId: 'bfl-call-1', signal: new AbortController().signal, agent: { session } };
  await settings.execute({}, exec);

  return { home, work, generate, exec, calls };
}

test('an async generate writes a resumable job record', async (t) => {
  const { home, generate, exec, calls } = await bflHarness(t);

  const result = await generate.execute({ prompt: 'a fox' }, exec);

  assert.ok(result.jobId, 'the tool reports the task journal id');
  assert.match(result.jobId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(calls.some((call) => call.url.includes('/get_result')));

  const jobsDir = path.join(home, 'mo-image', 'jobs');
  const files = readdirSync(jobsDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(path.join(jobsDir, files[0]), 'utf8'));
  assert.equal(record.id, result.jobId);
  assert.equal(record.status, 'saved');
  assert.equal(record.taskId, 'job-1');
  assert.equal(record.file, result.path);
  assert.equal(record.model, 'flux-2-pro');
  assert.ok(record.pollTarget.includes('/get_result'));
  const rendered = generate.output.render({}, result).map((block) => block.text || '').join('\n');
  assert.match(rendered, new RegExp(result.jobId), 'the model must be able to see the resume id');
});

async function restartPlugin(tools) {
  const mod = await import('../lib/index.js?restart-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools), { queue: { concurrency: 2, maxWaiting: 8 }, update: { skipCheck: true } });
  return tools;
}

function pollOnlyFetch(t) {
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'POST') {
      posts += 1;
      throw new Error('resume must never submit again');
    }
    if (target.includes('/get_result')) {
      return new Response(JSON.stringify({ status: 'Ready', result: { sample: 'https://cdn.test/bfl.png' } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (target === 'https://cdn.test/bfl.png') {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected url ' + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return () => posts;
}

test('a submitted async job survives a restart and resumes by jobId', async (t) => {
  const { home, work, generate, exec } = await bflHarness(t);
  const first = await generate.execute({ prompt: 'a fox' }, exec);

  // 模拟「提交成功后、保存前」崩溃：日志仍是 submitted，成品文件不存在。
  const jobsDir = path.join(home, 'mo-image', 'jobs');
  const journalFile = path.join(jobsDir, readdirSync(jobsDir).find((name) => name.endsWith('.json')));
  const record = JSON.parse(readFileSync(journalFile, 'utf8'));
  record.status = 'submitted';
  delete record.file;
  writeFileSync(journalFile, JSON.stringify(record, null, 2), 'utf8');
  rmSync(first.path, { force: true });

  const posts = pollOnlyFetch(t);
  const tools = await restartPlugin([]);
  const generateAfterRestart = tools.find((tool) => tool.name === 'mo_image_generate');
  const execAfterRestart = {
    callId: 'resume-call', signal: new AbortController().signal,
    agent: { session: { header: { id: 'resume-session', cwd: work } } }
  };

  const resumed = await generateAfterRestart.execute({ resume_job_id: first.jobId }, execAfterRestart);
  assert.equal(posts(), 0, 'resume polls the existing task instead of submitting');
  assert.equal(resumed.jobId, first.jobId);
  assert.ok(existsSync(resumed.path));

  const after = JSON.parse(readFileSync(journalFile, 'utf8'));
  assert.equal(after.status, 'saved');
  assert.equal(after.file, resumed.path);
});

test('resuming a saved job returns the existing file without touching the network', async (t) => {
  const { work, generate, exec } = await bflHarness(t);
  const first = await generate.execute({ prompt: 'a fox' }, exec);

  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('saved resume must not fetch'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tools = await restartPlugin([]);
  const generateAfterRestart = tools.find((tool) => tool.name === 'mo_image_generate');
  const execAfterRestart = {
    callId: 'resume-saved', signal: new AbortController().signal,
    agent: { session: { header: { id: 'resume-saved-session', cwd: work } } }
  };

  const resumed = await generateAfterRestart.execute({ resume_job_id: first.jobId }, execAfterRestart);
  assert.equal(fetched, 0);
  assert.equal(resumed.path, first.path);
  assert.equal(resumed.jobId, first.jobId);
});

test('an unknown resume id is a clear error, not a new submission', async (t) => {
  const { generate, exec } = await bflHarness(t);
  await assert.rejects(
    () => generate.execute({ resume_job_id: 'missing-job' }, exec),
    (error) => {
      assert.equal(error.code, 'job_not_found');
      return true;
    }
  );
});

/* ------------------------------------------- 通用 autoAsync 网关的恢复路径 */

function makeGatewayHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-gw-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'gw', name: 'Gateway', baseUrl: 'https://gateway.test/v1',
      apiKeyEnv: 'MO_IMAGE_GW_KEY', optionalKey: true, protocol: 'openai-images',
      adapter: '', models: ['gateway-model'], names: {}
    }],
    active: { providerId: 'gw', model: 'gateway-model' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  }), 'utf8');
  return home;
}

async function gatewayHarness(t) {
  const home = makeGatewayHome();
  const work = mkdtempSync(path.join(os.tmpdir(), 'mo-image-gw-cwd-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tools = [];
  const mod = await import('../lib/index.js?gw-journal-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools), { queue: { concurrency: 2, maxWaiting: 8 } });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, method: String((init && init.method) || 'GET').toUpperCase() });
    if (target === 'https://gateway.test/v1/images/generations') {
      return new Response(JSON.stringify({ task_id: 'gw-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://gateway.test/v1/tasks/gw-1') {
      return new Response(JSON.stringify({ task_status: 'SUCCEEDED', images: [{ url: 'https://cdn.test/gw.png' }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (target === 'https://cdn.test/gw.png') {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected url ' + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const settings = tools.find((tool) => tool.name === 'mo_image_settings');
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const session = { header: { id: 'gw-session', cwd: work } };
  const exec = { callId: 'gw-call-1', signal: new AbortController().signal, agent: { session } };
  await settings.execute({}, exec);

  return { home, work, generate, exec, calls };
}

test('a generic autoAsync gateway job can resume after a restart', async (t) => {
  const { home, work, generate, exec } = await gatewayHarness(t);
  const first = await generate.execute({ prompt: 'a cat' }, exec);
  assert.ok(first.jobId);
  const firstPost = exec.callId;

  const jobsDir = path.join(home, 'mo-image', 'jobs');
  const journalFile = path.join(jobsDir, readdirSync(jobsDir).find((name) => name.endsWith('.json')));
  const record = JSON.parse(readFileSync(journalFile, 'utf8'));
  record.status = 'submitted';
  delete record.file;
  writeFileSync(journalFile, JSON.stringify(record, null, 2), 'utf8');
  rmSync(first.path, { force: true });

  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (String((init && init.method) || 'GET').toUpperCase() === 'POST') {
      posts += 1;
      throw new Error('resume must not submit again');
    }
    if (target === 'https://gateway.test/v1/tasks/gw-1') {
      return new Response(JSON.stringify({ task_status: 'SUCCEEDED', images: [{ url: 'https://cdn.test/gw.png' }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (target === 'https://cdn.test/gw.png') {
      return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected url ' + target);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const tools = await restartPlugin([]);
  const generateAfterRestart = tools.find((tool) => tool.name === 'mo_image_generate');
  const execAfterRestart = {
    callId: 'gw-resume', signal: new AbortController().signal,
    agent: { session: { header: { id: 'gw-resume-session', cwd: work } } }
  };
  const resumed = await generateAfterRestart.execute({ resume_job_id: first.jobId }, execAfterRestart);

  assert.equal(posts, 0);
  assert.equal(resumed.jobId, first.jobId);
  assert.ok(existsSync(resumed.path));
  assert.ok(firstPost);
});




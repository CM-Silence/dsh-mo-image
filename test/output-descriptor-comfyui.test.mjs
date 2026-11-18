/**
 * `comfyui`：先当「保留为内置 profile」的特征化基线，再迁成输出描述符。
 *
 * 上一轮（计划 §7.7.3）的结论是「不迁」：它的响应侧有四件词汇表当时表达不了的事：
 *   1. **两跳**：`/prompt` 拿 `prompt_id` → 轮询 `/history/{prompt_id}` → 结果不是 URL，
 *      是 `{filename, subfolder, type}` 三个字段再拼 `/view?…`（相对 URL + 查询串默认值）；
 *   2. **路径里的运行时动态键**：`payload[promptId]`（结果路径的键来自提交响应）；
 *   3. **完成信号是「键出现」而不是状态词**：轮询中 404 = 继续，其它非 2xx = 立即失败；
 *   4. **退避曲线**：1s 起步、×1.15–1.3 抖动、5s 封顶（`task` 只有固定 `intervalMs`）。
 * 另外执行失败时要从 `status.messages` 里挖 `execution_error` 的人话原因。
 *
 * 这一轮把 1/2/3/4 都做成了**词汇表里有人读的字段**（`thenUrl` / `dynamicKey` /
 * `completeWhen:'key'` / `backoff`），并把失败原因交给既有的 `failureMessagePath`
 * （路径写到 `status.messages.*.1.exception_message`，`*` 表示每个值）。`comfyui`
 * 保留了它自己的驱动（`comfySubmitAndWait`），因为「404 继续」与三条本地文案
 * 不是「图在哪」的问题——描述符只说明怎么读，不含请求头。
 *
 * 本节先钉住**迁移前**的行为（这些断言迁移前后都必须绿），最后再钉迁移后的描述符形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';
import { taskResultImagesOf, taskStateOf, thenUrlOf } from '../lib/output-profiles.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const PROVIDER = () => ({ baseUrl: 'http://127.0.0.1:8188', adapter: 'comfyui', optionalKey: true });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/**
 * 打桩 fetch：`/prompt` → prompt_id；`/history/{id}` → 依次弹出 historyResponses；
 * `/view?…` → PNG。返回 calls，断言「拼出来的 /view 地址」用。
 */
function withStub(t, historyResponses) {
  const calls = [];
  const queue = historyResponses.slice();
  const original = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(() => { globalThis.fetch = original; globalThis.setTimeout = originalSetTimeout; });
  // 轮询退避是 1s 起步：为了让这个文件不拖长整套测试，把 sleep 压到 1ms。
  // 只压缩等待时长，不改变「先等再问」的顺序与退避逻辑（这里也不断言时序）。
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, Math.min(Number(ms) || 0, 1), ...args);
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    // 组装内置工作流前会先拉对象信息（模型可选值）；这里让 checkpoint 路径成立即可。
    if (target.endsWith('/object_info/CheckpointLoaderSimple')) {
      return jsonResponse({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } } });
    }
    if (target.endsWith('/object_info/UNETLoader')) {
      return jsonResponse({ UNETLoader: { input: { required: { unet_name: [[]] } } } });
    }
    if (target.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (target.endsWith('/history/prompt-1')) {
      const next = queue.shift();
      if (next === undefined) throw new Error('history 被多问了一次');
      return typeof next === 'function' ? next() : jsonResponse(next);
    }
    if (target.includes('/view?')) return pngResponse();
    throw new Error('unexpected url ' + target);
  };
  return calls;
}

function history(outputs, status) {
  return { 'prompt-1': status ? { status: status, outputs: outputs } : { outputs: outputs } };
}

async function generate() {
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, '');
  assert.equal(adapter.id, 'comfyui');
  return adapter.execute('generate', provider, {
    model: 'sdxl.safetensors', prompt: 'a cat', fitted: { width: 512, height: 512, size: '512x512' }
  }, new AbortController().signal);
}

/* ---------------------------------------------------- 今天的行为（迁移前后都不许变） */

test('comfyui：history 的 outputs.<节点>.images[0] → /view?filename&subfolder&type 再下载', async (t) => {
  const calls = withStub(t, [history({
    '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] }
  })]);
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  const view = calls.find((call) => call.url.includes('/view?'));
  assert.ok(view, '结果图不是 URL，是三个字段拼出来的 /view 地址');
  // subfolder 为空也要出现在查询串里（URLSearchParams 的默认值），迁移时不是「顺手去掉空参数」。
  assert.equal(view.url, 'http://127.0.0.1:8188/view?filename=out.png&subfolder=&type=output');
});

test('comfyui：subfolder / type 经过 URLSearchParams 编码，缺失的 type 默认 output', async (t) => {
  const calls = withStub(t, [history({
    '9': { images: [{ filename: 'out 1.png', subfolder: 'sub dir' }] }
  })]);
  await generate();
  const view = calls.find((call) => call.url.includes('/view?'));
  assert.equal(view.url, 'http://127.0.0.1:8188/view?filename=out+1.png&subfolder=sub+dir&type=output');
});

test('comfyui：多个输出节点时取第一个有 filename 的（对象插入顺序）', async (t) => {
  const calls = withStub(t, [history({
    '3': { images: [] },
    '4': { images: [{ filename: 'no-this-one.png', subfolder: '', type: 'output' }] },
    '5': { images: [{ filename: 'second.png', subfolder: '', type: 'output' }] }
  })]);
  await generate();
  assert.ok(calls.some((call) => call.url.includes('filename=no-this-one.png')), '第一个有图的是 4 号节点');
});

test('comfyui：images[0] 没有 filename 的节点被跳过', async (t) => {
  const calls = withStub(t, [history({
    '7': { images: [{}] },
    '8': { images: [{ filename: 'real.png', subfolder: '', type: 'output' }] }
  })]);
  await generate();
  assert.ok(calls.some((call) => call.url.includes('filename=real.png')));
});

test('comfyui：status_str === "error" 时把 execution_error 的原因带出来', async (t) => {
  withStub(t, [history({}, {
    status_str: 'error',
    messages: [['execution_error', { exception_message: 'CUDA out of memory', exception_type: 'RuntimeError' }]]
  })]);
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'ComfyUI 执行失败：CUDA out of memory');
    return true;
  });
});

test('comfyui：执行失败但没有 detail 时给固定提示', async (t) => {
  withStub(t, [history({}, { status_str: 'error', messages: [] })]);
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'ComfyUI 执行失败，请检查 ComfyUI 控制台');
    return true;
  });
});

test('comfyui：history 里没有可用的图片时报固定文案', async (t) => {
  withStub(t, [history({})]);
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'ComfyUI 没有返回图片');
    return true;
  });
});

test('comfyui：提交响应没有 prompt_id 时报固定文案', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => jsonResponse({});
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'ComfyUI 没有返回 prompt_id');
    return true;
  });
});

test('comfyui：轮询 404 视为「还没好」继续问，不是失败', async (t) => {
  const calls = withStub(t, [
    () => jsonResponse({ error: 'not found' }, 404),
    history({ '7': { images: [{ filename: 'late.png', subfolder: '', type: 'output' }] } })
  ]);
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.equal(calls.filter((call) => call.url.endsWith('/history/prompt-1')).length, 2, '404 之后又问了一次');
});

test('comfyui：轮询非 404 的 HTTP 错误立即失败', async (t) => {
  withStub(t, [() => jsonResponse({ error: 'boom' }, 500)]);
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'ComfyUI 查询任务失败：HTTP 500');
    return true;
  });
});

/* ------------------- 迁移后：两跳 / 动态键 / 完成信号 / 退避都在描述符里 */

test('comfyui：output 是 task 描述符，四个新字段逐个钉住', () => {
  const adapter = resolveAdapter(PROVIDER(), '');
  const output = adapter.output;
  assert.ok(output, '迁移后 comfyui 必须带 output 描述符');
  assert.equal(output.kind, 'task');

  // 第一跳：POST /prompt 拿 prompt_id，再 GET /history/{promptId}。
  assert.equal(output.idPath, 'prompt_id');
  assert.equal(output.path, '/history/{taskId}');
  // 完成信号：不是状态词，是「那一层运行时键出现」。
  assert.equal(output.completeWhen, 'key');
  assert.deepEqual(output.dynamicKey, { from: 'taskId' });
  assert.equal(output.statusPath, 'status.status_str', '状态词只用来认「完成但失败」');
  assert.deepEqual(output.success, [], '没有成功词可等');
  assert.deepEqual(output.failure, ['error']);
  // 失败原因：既有的 failureMessagePath，路径写到 status.messages 里的 execution_error。
  assert.deepEqual(output.failureMessagePath, [
    'status.messages.*.1.exception_message',
    'status.messages.*.1.exception_type'
  ]);
  // 第二跳：结果节点 → /view?…
  assert.equal(output.resultPath, 'outputs.*.images.0');
  assert.deepEqual(output.thenUrl, {
    template: '/view?filename={filename}&subfolder={subfolder}&type={type}',
    defaults: { subfolder: '', type: 'output' }
  });
  // 退避曲线：1s 起步、×1.15～1.3 抖动、5s 封顶。
  assert.deepEqual(output.backoff, { startMs: 1000, maxMs: 5000, jitter: true });
  assert.equal(output.intervalMs, undefined, '固定间隔与退避曲线二选一');
  assert.equal(output.timeoutMs, 300000);
  assert.equal(output.maxBytes, 10 * 1024 * 1024, '迁移前 readJsonResponse(poll, 10MB)');
  assert.equal(output.emptyMessage, 'ComfyUI 没有返回图片');
  // 描述符不碰请求头与凭据。
  assert.doesNotMatch(JSON.stringify(output), /"(headers|authorization|apiKey|token|secret)"/i);
});

test('comfyui：第二跳模板单独可测（编码用 URLSearchParams，缺值走 defaults）', () => {
  const spec = resolveAdapter(PROVIDER(), '').output;
  assert.equal(
    thenUrlOf(spec, { filename: 'out 1.png', subfolder: 'sub dir', type: 'temp' }, 'http://127.0.0.1:8188'),
    'http://127.0.0.1:8188/view?filename=out+1.png&subfolder=sub+dir&type=temp'
  );
  assert.equal(
    thenUrlOf(spec, { filename: 'a.png' }, 'http://h'),
    'http://h/view?filename=a.png&subfolder=&type=output',
    '缺 subfolder / type 时就是迁移前的「空串 / output」默认值'
  );
  assert.equal(thenUrlOf(spec, {}, 'http://h'), '', '没有 filename 的节点不可用（今天会跳过它）');
});

test('comfyui：结果读取相对运行时动态键；键不在时既不算完成也没有结果', () => {
  const spec = resolveAdapter(PROVIDER(), '').output;
  assert.deepEqual(
    taskResultImagesOf(spec, { p1: { outputs: { 7: { images: [{ filename: 'o.png' }] } } } }, { taskId: 'p1', baseUrl: 'http://h' }),
    [{ url: 'http://h/view?filename=o.png&subfolder=&type=output' }]
  );
  assert.deepEqual(taskResultImagesOf(spec, { p1: {} }, { taskId: 'p2', baseUrl: 'http://h' }), [], 'taskId 对不上就没有结果');
  assert.equal(taskStateOf(spec, { p1: { outputs: {} } }, 'p1').state, 'success', '键出现即完成');
  assert.equal(taskStateOf(spec, {}, 'p1').state, 'pending', '{} 是还没好');
  assert.equal(taskStateOf(spec, { p1: { status: { status_str: 'error' } } }, 'p1').state, 'failure');
  assert.equal(taskStateOf(spec, { p1: { status: { status_str: 'success' } } }, 'p1').state, 'success');
});

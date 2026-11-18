/**
 * `comfyui`：**保留为代码里的内置 profile**（不迁描述符）的特征化基线。
 *
 * 结论先说：`comfyui` 的响应侧不是「一个形状」，而是四件词汇表表达不了的事：
 *   1. **两跳**：`/prompt` 拿 `prompt_id` → 轮询 `/history/{prompt_id}` → 结果不是 URL，
 *      是 `{filename, subfolder, type}` 三个字段再拼 `/view?…`（相对 URL + 查询串默认值）；
 *   2. **路径里的运行时动态键**：`payload[promptId]`（`resultPath` 的键来自提交响应）；
 *   3. **完成信号是「键出现」而不是状态词**：`taskStateOf` 只认状态词，没有「拿到 history 就算成功」；
 *      轮询中 404 = 继续，其它非 2xx = 立即失败；
 *   4. **退避曲线**：1s 起步、×1.15–1.3 抖动、5s 封顶（`task` 描述符只有固定 `intervalMs`）。
 * 另外执行失败时要从 `status.messages` 里挖 `execution_error` 的人话原因——那是错误分支，不是图的位置。
 *
 * 硬塞进 `kind:'task'` 会给词汇表加 4–5 个字段，其中 3 个只服务这一家；按计划 §7.3-6/8 的
 * 判断口径，这属于「该保留为内置 profile」的合法用例。所以这里钉住**今天的行为**，
 * 迁移（其他协议）不允许悄悄改动它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

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

/* --------------------------------------- 决定：不迁描述符（把理由钉成断言，别悄悄变） */

test('comfyui：没有 output 描述符——两跳 / 动态键 / 完成信号 / 退避都表达不了', () => {
  const adapter = resolveAdapter(PROVIDER(), '');
  assert.equal(
    adapter.output,
    undefined,
    'comfyui 保留为代码里的内置 profile（计划 §7.3-6/8）：kind:task 需要再加「结果节点带运行时键」'
      + '「成功 = 键出现」「轮询 404 继续」「退避曲线」「查询串模板」五个字段，其中三个只服务这一家。'
  );
});

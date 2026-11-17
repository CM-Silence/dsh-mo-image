/**
 * 结果图下载的凭据范围：**同一个 data[0].url，不论走哪条协议路径，请求头必须一样**。
 *
 * 背景：20 条协议里有 12 条走 execute() 自己拼请求，其余走异步轮询 / 通用 composeBody。
 * 两条路径过去各自下载：execute() 那条用裸 fetch（一律不带鉴权），异步/通用那条按目标域
 * 判断（同源带、跨源不带、声明过的 resultAuthOrigins 才带）。于是同一个结果地址在两条
 * 路径上行为不一致——要么该带的凭据没带（本地 /view 这类需要鉴权的接口读不出图），
 * 要么反过来把 Key 发给上游响应里随便指定的主机（凭据泄漏）。
 *
 * 现在只有一个入口：lib/request-auth.js 的 fetchResultImage()，判定函数是
 * downloadRequestHeaders(adapter, provider, url)。这组用例守三件事：
 *   1. 同源带 Key、跨源默认不带、声明过的跨源带；
 *   2. execute() 协议与通用/异步路径产出的请求头逐字段相同；
 *   3. 绝不出现「任何 URL 都带 Key」——伪造的第三方域名必须裸奔。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';
import { callImageApi } from '../lib/image-execution.js';
import { downloadRequestHeaders, fetchResultImage } from '../lib/request-auth.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const fitted = { width: 1024, height: 1024, size: '1024x1024' };
const signal = () => new AbortController().signal;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/** 按 URL 精确分发的 fetch 桩：记下每次调用的 url / init。 */
function stubFetch(t, routes) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init || {} });
    const handler = routes[target];
    if (!handler) throw new Error('unexpected url ' + target);
    return typeof handler === 'function' ? handler() : handler;
  };
  return calls;
}

const downloadsOf = (calls) => calls.filter((call) => call.init.method !== 'POST');

/* ------------------------------------------------ 走 execute() 的协议（openai-chat） */

/** openai-chat 走 execute()，中转把图回成 markdown 链接；这条路径过去用裸 fetch 下载。 */
function chatProvider(baseUrl = 'https://relay.example/v1') {
  return { id: 'relay', name: 'relay', baseUrl: baseUrl, key: 'k', adapter: 'openai-chat' };
}

async function executeChatDownload(t, link, baseUrl = 'https://relay.example/v1') {
  const provider = chatProvider(baseUrl);
  const calls = stubFetch(t, {
    [baseUrl + '/chat/completions']: jsonResponse({
      choices: [{ message: { content: '![img](' + link + ')' } }]
    }),
    [link]: () => pngResponse()
  });
  const adapter = resolveAdapter(provider, 'relay-image-model');
  assert.equal(adapter.id, 'openai-chat', '这条用例要看的就是 execute() 那条路径');
  const result = await adapter.execute('generate', provider, {
    model: 'relay-image-model', prompt: 'draw a cat', fitted: fitted
  }, signal());
  assert.ok(result.bytes.length > 0);
  const [download] = downloadsOf(calls);
  assert.ok(download, '结果链接要被下载');
  return download;
}

test('execute() 路径：结果地址与提供商同源时带 Key', async (t) => {
  const download = await executeChatDownload(t, 'https://relay.example/v1/out.png');
  assert.equal(download.url, 'https://relay.example/v1/out.png');
  assert.deepEqual(download.init.headers, { Authorization: 'Bearer k' });
});

test('execute() 路径：未声明的跨源 CDN 一个头都不带', async (t) => {
  const download = await executeChatDownload(t, 'https://cdn.test/out.png');
  assert.equal(download.init.headers, undefined, '跨源 CDN 必须保持「完全不带 headers」');
});

test('execute() 路径：伪造的第三方域名拿不到 Key（哪怕域名前缀像提供商）', async (t) => {
  const download = await executeChatDownload(t, 'https://relay.example.v1.evil.test/out.png');
  assert.equal(download.init.headers, undefined, '按 origin 精确比对，别被前缀骗了');
});

/* ------------------------------------------------------------ 声明过的跨源 */

test('声明过的跨源结果域带 Key，没声明的跨源不带', async (t) => {
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  const calls = stubFetch(t, {
    'https://files.test/a.png': () => pngResponse(),
    'https://cdn.test/a.png': () => pngResponse()
  });
  const declaring = { id: 'declared', authHeader: 'bearer', resultAuthOrigins: ['https://files.test'] };

  await fetchResultImage('https://files.test/a.png', signal(), declaring, provider);
  await fetchResultImage('https://cdn.test/a.png', signal(), declaring, provider);

  assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer k' }, '声明过的结果域才带凭据');
  assert.equal(calls[1].init.headers, undefined, '同一份声明不该顺手放行别的域');
});

test('同源 / 跨源 / 声明跨源三档判定（downloadRequestHeaders）', () => {
  const provider = { baseUrl: 'https://api.test/v1', key: 'k' };
  const plain = { id: 'plain', authHeader: 'bearer' };
  assert.deepEqual(downloadRequestHeaders(plain, provider, 'https://api.test/view?a=1'), {
    Authorization: 'Bearer k'
  });
  assert.deepEqual(downloadRequestHeaders(plain, provider, 'https://cdn.test/a.png'), {});
  assert.deepEqual(
    downloadRequestHeaders({ resultAuthOrigins: ['files.test'] }, provider, 'https://files.test/a.png'),
    { Authorization: 'Bearer k' }
  );
  assert.deepEqual(downloadRequestHeaders(plain, provider, 'https://api.test.evil.test/a.png'), {},
    '跨源就是跨源：前缀相同不算同源');
  // 鉴权头形态跟着适配器走：api-key / x-key / fal 的 Key 也是这套判定。
  assert.deepEqual(
    downloadRequestHeaders({ authHeader: 'api-key' }, provider, 'https://api.test/view'),
    { 'api-key': 'k' }
  );
});

/* ------------------------------------------- 两条路径对同一个 URL 产出同样的头 */

/**
 * 同一个结果地址分别经 execute() 协议（openai-chat）与通用路径（openai-images）下载，
 * 两次请求的 headers 必须逐字段相同。这是这次统一的验收条件。
 *
 * 两条路径的提供商都是 https://api.test/v1；结果地址由调用方给（同源或跨源）。
 */
async function headersFromBothPaths(t, downloadUrl) {
  const baseUrl = 'https://api.test/v1';
  const calls = stubFetch(t, {
    // execute() 那条：中转的 chat 响应里给链接。
    [baseUrl + '/chat/completions']: jsonResponse({
      choices: [{ message: { content: '![img](' + downloadUrl + ')' } }]
    }),
    // 通用那条：openai-images 的 data[0].url。
    [baseUrl + '/images/generations']: jsonResponse({ id: 'img-1', data: [{ url: downloadUrl }] }),
    [downloadUrl]: () => pngResponse()
  });

  const chat = { id: 'relay', name: 'relay', baseUrl: baseUrl, key: 'k', adapter: 'openai-chat' };
  const chatAdapter = resolveAdapter(chat, 'relay-image-model');
  assert.equal(chatAdapter.id, 'openai-chat');
  await chatAdapter.execute('generate', chat, {
    model: 'relay-image-model', prompt: 'draw a cat', fitted: fitted
  }, signal());

  const gateway = { id: 'gw', name: 'gateway', baseUrl: baseUrl, key: 'k', adapter: 'openai-images' };
  const genericAdapter = resolveAdapter(gateway, 'flux-1-schnell');
  assert.equal(genericAdapter.id, 'openai-images');
  const result = await callImageApi('generate', genericAdapter, gateway, {
    model: 'flux-1-schnell', prompt: 'hi', fitted: fitted
  }, signal());
  assert.ok(result.bytes.length > 0);

  const downloads = calls.filter((call) => call.url === downloadUrl);
  assert.equal(downloads.length, 2, '两条路径各下载一次同一个结果地址');
  return { executeDownload: downloads[0], genericDownload: downloads[1] };
}

test('同一个同源 URL：execute() 与通用路径的下载头完全一致', async (t) => {
  const { executeDownload, genericDownload } = await headersFromBothPaths(t, 'https://api.test/v1/out.png');
  assert.deepEqual(executeDownload.init.headers, genericDownload.init.headers);
  assert.deepEqual(genericDownload.init.headers, { Authorization: 'Bearer k' },
    '同源结果地址在两条路径上都要带 Key');
});

test('同一个跨源 URL：execute() 与通用路径的下载头完全一致（都不带）', async (t) => {
  const { executeDownload, genericDownload } = await headersFromBothPaths(t, 'https://cdn.test/out.png');
  assert.deepEqual(executeDownload.init.headers, genericDownload.init.headers);
  assert.equal(genericDownload.init.headers, undefined, '跨源默认不带：两条路径都一样');
});

/* -------------------------------------------------------- 其它 execute() 协议 */

test('ComfyUI 的 /view 在提供商自己源上会带 Key（反代加了鉴权时读得出来）', async (t) => {
  const provider = { id: 'comfy', baseUrl: 'http://127.0.0.1:8188', key: 'k', adapter: 'comfyui' };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init || {} });
    if (target.endsWith('/object_info/UNETLoader')) return jsonResponse({});
    if (target.endsWith('/prompt')) return jsonResponse({ prompt_id: 'prompt-1' });
    if (target.endsWith('/history/prompt-1')) {
      return jsonResponse({
        'prompt-1': { outputs: { 7: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } }
      });
    }
    if (target.includes('/view?')) return pngResponse();
    throw new Error('unexpected url ' + target);
  };
  t.after(() => { globalThis.fetch = original; });

  const adapter = resolveAdapter(provider, 'sdxl.safetensors');
  assert.equal(adapter.id, 'comfyui');
  const result = await adapter.execute('generate', provider, {
    model: 'sdxl.safetensors', prompt: 'a cat', fitted: fitted
  }, signal());
  assert.ok(result.bytes.length > 0);
  const view = calls.find((call) => call.url.includes('/view?'));
  assert.ok(view, 'ComfyUI 的结果图从 /view 下载');
  assert.deepEqual(view.init.headers, { Authorization: 'Bearer k' });
});

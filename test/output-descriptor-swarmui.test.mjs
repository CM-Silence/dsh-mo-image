/**
 * `swarmui` 迁到输出描述符：迁移前的特征化基线 + 迁移后的字段钉住。
 *
 * 今天的读法对 `images.0` 分三条分支：
 *   1. `data:` 开头 → base64 直解；
 *   2. `http(s)://` 开头 → 下载；
 *   3. 其余 → `base + '/' + 去前导斜杠` 再下载。
 *
 * 描述符用一个 `from` 级联表达同样的顺序（dataUrl → url → relative），
 * `relative` 由 `readOutput(..., { baseUrl })` 拼到 provider 站点根上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR42mP4z8DwnwGMgRQAH+4D/a+/4gQAAAAASUVORK5CYII=';

const PROVIDER = () => ({ baseUrl: 'http://127.0.0.1:7801', adapter: 'swarmui', optionalKey: true });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status: status, headers: { 'content-type': 'application/json' } });
}

function pngResponse() {
  return new Response(Buffer.from(PNG_1PX, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
}

/**
 * 打桩 fetch：先回 session，再回 generation payload，最后回 `downloads` 里声明的地址。
 * 返回 calls，方便断言「相对路径拼成了哪个 URL」。
 */
function withStub(t, payload, downloads) {
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init });
    if (target.endsWith('/API/GetNewSession')) return jsonResponse({ session_id: 'session-1' });
    if (target.endsWith('/API/GenerateText2Image')) return jsonResponse(payload);
    if (downloads && downloads[target]) return downloads[target]();
    throw new Error('unexpected url ' + target);
  };
  return calls;
}

async function generate() {
  const provider = PROVIDER();
  const adapter = resolveAdapter(provider, '');
  assert.equal(adapter.id, 'swarmui');
  return adapter.execute('generate', provider, {
    model: 'OfficialStableDiffusion/sdxl', prompt: 'a cat', fitted: { width: 512, height: 512, size: '512x512' }
  }, new AbortController().signal);
}

/* -------------------------------------------- 迁移前：今天吃得下的每种响应形态 */

test('swarmui：images.0 是 data URL → base64 直解，不下载', async (t) => {
  const calls = withStub(t, { images: ['data:image/webp;base64,' + PNG_RED] });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_RED, 'base64'));
  assert.equal(result.contentType, 'image/webp', 'data URL 前缀里的类型优先');
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://127.0.0.1:7801/API/GetNewSession', 'http://127.0.0.1:7801/API/GenerateText2Image'],
    '没有第三次请求'
  );
});

test('swarmui：images.0 是绝对 URL → 下载', async (t) => {
  const remote = 'http://127.0.0.1:7801/View/local/raw/abs.png';
  const calls = withStub(t, { images: [remote] }, { [remote]: pngResponse });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  const download = calls.find((call) => call.url === remote);
  assert.ok(download, '绝对 URL 原样交给 fetchResultImage');
  assert.equal(download.init.headers, undefined, '没配 key 的本地服务不带凭据（空头连对象都不写）');
});

test('swarmui：images.0 是相对路径 → base + "/" + 去前导斜杠后再下载', async (t) => {
  const calls = withStub(t, { images: ['View/local/raw/out.png'] }, {
    'http://127.0.0.1:7801/View/local/raw/out.png': pngResponse
  });
  const result = await generate();
  assert.deepEqual(result.bytes, Buffer.from(PNG_1PX, 'base64'));
  assert.ok(calls.some((call) => call.url === 'http://127.0.0.1:7801/View/local/raw/out.png'));
});

test('swarmui：相对路径以斜杠开头时不会拼出双斜杠', async (t) => {
  const calls = withStub(t, { images: ['/View/local/raw/out.png'] }, {
    'http://127.0.0.1:7801/View/local/raw/out.png': pngResponse
  });
  await generate();
  assert.ok(calls.some((call) => call.url === 'http://127.0.0.1:7801/View/local/raw/out.png'));
});

test('swarmui：images 是空数组时报固定文案', async (t) => {
  withStub(t, { images: [] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'SwarmUI 没有返回图片');
    return true;
  });
});

test('swarmui：没有 images 字段时同样报固定文案', async (t) => {
  withStub(t, {});
  await assert.rejects(() => generate(), /SwarmUI 没有返回图片/);
});

/* ------------------------------------------------------ 迁移后：描述符的字段钉住 */

test('swarmui：output 描述符钉住三分支级联 + 5MB', () => {
  const adapter = resolveAdapter(PROVIDER(), '');
  assert.ok(adapter.output, '迁移后适配器必须带 output 描述符');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'from', 'kind', 'maxBytes']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.maxBytes, 5 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(adapter.output.emptyMessage, 'SwarmUI 没有返回图片');
  // 顺序就是迁移前的三条分支：data URL → 绝对 URL → 相对路径。
  assert.deepEqual(adapter.output.from, [
    { path: 'images.0', as: 'dataUrl' },
    { path: 'images.0', as: 'url' },
    { path: 'images.0', as: 'relative' }
  ]);
});

/* --------------------------------------------------------- 迁移后的已知差异（如实钉住） */

/**
 * 迁移前 `data:` 开头但解不出图的响应会报「SwarmUI 返回的图片无法解码」；
 * 描述符只有一个 emptyMessage，且 `as:'relative'` 不接手 `data:` 串，所以文案变成
 * 「SwarmUI 没有返回图片」。差异只在这一种坏响应上，单独钉住。
 */
test('swarmui 已知差异：坏 data URL 的文案从「无法解码」变成「没有返回图片」', async (t) => {
  withStub(t, { images: ['data:image/png;base64,AAAA'] });
  await assert.rejects(() => generate(), (error) => {
    assert.equal(error.message, 'SwarmUI 没有返回图片');
    return true;
  });
});

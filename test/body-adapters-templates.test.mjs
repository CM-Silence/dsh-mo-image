/**
 * 任务 8' A 组：google-gemini / ideogram 的**真实**请求体（docs/…/2026-11-16-model-size-quality-rules.md）。
 *
 * 这两条协议自己在 execute() 里拼 body，`test/adapter-body-regression.test.mjs` 的基线只录到
 * 「通用 composeBody 会产出什么」，根本碰不到它们真正发出去的字节（那条基线里写着
 * covers: 'execute'）。所以在改实现之前，先把 execute() 的请求体用 fetch 打桩抓下来锁住：
 *
 *   - google-gemini：contents[0].parts[]（参考图 inlineData 对象 + 文本追加）、
 *     generationConfig.imageConfig（比例 / 档位）、自动尺寸时不发 imageConfig；
 *   - ideogram：4 是 JSON（resolution，没有负面词），4.5 和 4.6 文生图使用 JSON（size、quality），
 *     4-transparent 多一个 output_resolution，3 与透明模型走 multipart
 *     （aspect_ratio 用字母 x，张数 num_images，质量渲染成 rendering_speed）。
 *
 * 下面这一节（「改造前」）要求**改造前后逐条一样**：它是这次搬迁的判据，不要在实现改完之后
 * 顺手改这里的期望值——红了先分辨是「行为真的变了」还是「只是键顺序变了」（multipart 用
 * FormData.get 逐字段比，不比顺序；JSON 用 deepEqual，键顺序无关）。
 *
 * 最后一节（「模板接线」）是改造后才成立的新能力：字段名不再是协议里的字面量，模型选项里
 * 改了模板，execute() 发出去的字段就跟着换。这一节在改造前应当是红的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const image = (filename) => ({
  buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: filename || 'ref.png'
});

/** 截获 execute() 打出去的那一次请求（返回的数组按调用顺序累积）。 */
function capture(t, respond) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return respond(String(url), init || {});
  };
  return calls;
}

/** gemini 的成功响应：一张非 thought 的 inlineData 图。 */
function geminiImageResponse() {
  return jsonResponse({ candidates: [{ content: { parts: [
    { inlineData: { mimeType: 'image/png', data: PNG_1PX } }
  ] } }] });
}

function geminiProvider(extra) {
  return Object.assign({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'test-key'
  }, extra || {});
}

function ideogramProvider(extra) {
  return Object.assign({
    baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram', key: 'test-key'
  }, extra || {});
}

/** ideogram 的成功响应：/v2/image/generate 的 data[].b64_json。 */
const IDEOGRAM_RESPONSE = () => jsonResponse({ data: [{ b64_json: PNG_1PX }] });

/* ============================== 改造前：google-gemini ============================== */

test('gemini 生成：提示词追加进 contents[0].parts[]，负面词拼进提示词，模型名在 URL 里', async (t) => {
  const calls = capture(t, geminiImageResponse);
  const provider = geminiProvider();
  const adapter = resolveAdapter(provider, 'gemini-2.5-flash-image');
  assert.equal(adapter.id, 'google-gemini');

  const result = await adapter.execute('generate', provider, {
    model: 'gemini-2.5-flash-image',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent'
  );
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'gemini 用 x-goog-api-key，不是 Bearer');

  // 工具段没有字段：模型名在 URL 里，参考图是 inlineData 对象，张数固定 1。
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    contents: [{ role: 'user', parts: [{ text: 'a cat\n\nAvoid: blurry' }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' }
    }
  });
});

test('gemini 编辑：参考图是 inlineData 对象，排在文本之前；档位是大写 K', async (t) => {
  const calls = capture(t, geminiImageResponse);
  const provider = geminiProvider();
  const adapter = resolveAdapter(provider, 'gemini-3.1-flash-image');

  await adapter.execute('edit', provider, {
    model: 'gemini-3.1-flash-image',
    prompt: 'replace the background',
    fitted: { width: 2048, height: 2048, size: '2048x2048', aspect: '1:1', tier: '2K' },
    images: [image('a.png'), image('b.png')]
  }, new AbortController().signal);

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.contents, [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'image/png', data: PNG_1PX } },
      { inlineData: { mimeType: 'image/png', data: PNG_1PX } },
      { text: 'replace the background' }
    ]
  }]);
  assert.deepEqual(body.generationConfig, {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: '1:1', imageSize: '2K' }
  });
});

test('gemini 自动尺寸：不下发 imageConfig，但 responseModalities 保留', async (t) => {
  const calls = capture(t, geminiImageResponse);
  const provider = geminiProvider();
  const adapter = resolveAdapter(provider, 'gemini-2.5-flash-image');

  await adapter.execute('generate', provider, {
    model: 'gemini-2.5-flash-image',
    prompt: 'a cat',
    fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'a cat' }] }]);
  assert.deepEqual(body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'] });
  assert.equal(body.generationConfig.imageConfig, undefined);
});

test('gemini 的模型名带 models/ 前缀时照样只进 URL，不进 body', async (t) => {
  const calls = capture(t, geminiImageResponse);
  const provider = geminiProvider();

  await resolveAdapter(provider, 'gemini-2.5-flash-image').execute('generate', provider, {
    model: 'models/gemini-2.5-flash-image',
    prompt: 'a cat',
    fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);

  assert.ok(calls[0].url.endsWith('/models/gemini-2.5-flash-image:generateContent'), '前缀要被剥掉');
  assert.equal('model' in JSON.parse(calls[0].init.body), false, 'gemini 的模型名不在 body 里');
});

test('gemini 的参考图上限按模型分：2.5-flash 是 3 张，超了在发请求之前就报错', async (t) => {
  const calls = capture(t, geminiImageResponse);
  const provider = geminiProvider();

  await assert.rejects(
    () => resolveAdapter(provider, 'gemini-2.5-flash-image').execute('edit', provider, {
      model: 'gemini-2.5-flash-image',
      prompt: 'merge these',
      fitted: { omit: true, size: 'none' },
      images: [image('1.png'), image('2.png'), image('3.png'), image('4.png')]
    }, new AbortController().signal),
    /最多 3 张/
  );
  assert.equal(calls.length, 0, '超上限时不该打上游');
});

/* ============================== 改造前：ideogram ============================== */

test('ideogram-3 multipart：prompt / negative_prompt / rendering_speed / aspect_ratio / num_images', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();
  const adapter = resolveAdapter(provider, 'ideogram-3');

  const result = await adapter.execute('generate', provider, {
    model: 'ideogram-3',
    prompt: 'a typographic poster',
    negativePrompt: 'blurry, watermark',
    quality: 'quality',
    fitted: { width: 1344, height: 768, size: '1344x768' }
  }, new AbortController().signal);

  assert.ok(result.bytes.length > 0);
  assert.equal(calls[0].url, 'https://api.ideogram.ai/v2/image/generate/ideogram-3');
  assert.equal(calls[0].init.headers['Api-Key'], 'test-key');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'ideogram 用 Api-Key，不是 Bearer');

  const form = calls[0].init.body;
  assert.equal(form.get('prompt'), 'a typographic poster');
  assert.equal(form.get('negative_prompt'), 'blurry, watermark');
  assert.equal(form.get('rendering_speed'), 'QUALITY');
  assert.equal(form.get('aspect_ratio'), '16x9', 'ideogram 的比例是字母 x，不是冒号');
  assert.equal(form.get('num_images'), '1');
  assert.equal(form.get('size'), null, 'ideogram-3 只收 aspect_ratio');
});

test('ideogram-4 JSON：resolution 而不是 aspect_ratio，而且没有负面词字段', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();
  const adapter = resolveAdapter(provider, 'ideogram-4');

  await adapter.execute('generate', provider, {
    model: 'ideogram-4',
    prompt: 'a poster',
    negativePrompt: 'blurry',
    quality: 'default',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);

  assert.equal(calls[0].url, 'https://api.ideogram.ai/v2/image/generate/ideogram-4');
  assert.equal(calls[0].init.headers['Api-Key'], 'test-key');
  assert.equal(typeof calls[0].init.body, 'string', 'ideogram-4 是 JSON 体，不是表单');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    prompt: 'a poster',
    num_images: 1,
    resolution: '1024x1024',
    rendering_speed: 'DEFAULT'
  });
});

test('ideogram-4-transparent：比例 + 透明模型多一个 output_resolution', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();
  const adapter = resolveAdapter(provider, 'ideogram-4-transparent');

  await adapter.execute('generate', provider, {
    model: 'ideogram-4-transparent',
    prompt: 'a sticker',
    quality: 'turbo',
    fitted: { width: 1024, height: 1024, size: '1024x1024', aspect: '1:1', tier: '2K' }
  }, new AbortController().signal);

  const form = calls[0].init.body;
  assert.equal(form.get('prompt'), 'a sticker');
  assert.equal(form.get('rendering_speed'), 'TURBO');
  assert.equal(form.get('aspect_ratio'), '1x1');
  assert.equal(form.get('output_resolution'), '2K');
  assert.equal(form.get('size'), null, 'transparent 和 3 一样只发比例');
});

test('ideogram-4-5 文生图使用 JSON size，未选择质量时省略 quality', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();
  const adapter = resolveAdapter(provider, 'ideogram-4-5');

  await adapter.execute('generate', provider, {
    model: 'ideogram-4-5',
    prompt: 'a poster',
    fitted: { width: 1024, height: 1024, size: '1024x1024', tier: '2K' }
  }, new AbortController().signal);

  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'a poster', num_images: 1, size: '1024x1024' });
});

test('ideogram 自动尺寸：比例与 size 都不发，提示词和质量照发', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();
  const adapter = resolveAdapter(provider, 'ideogram-3');

  await adapter.execute('generate', provider, {
    model: 'ideogram-3',
    prompt: 'a poster',
    quality: 'turbo',
    fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);

  const form = calls[0].init.body;
  assert.equal(form.get('prompt'), 'a poster');
  assert.equal(form.get('rendering_speed'), 'TURBO');
  assert.equal(form.get('num_images'), '1');
  assert.equal(form.get('aspect_ratio'), null, 'Auto 表示让上游自己决定比例');
  assert.equal(form.get('size'), null);
});

test('ideogram 质量档是 off：rendering_speed 整个字段都不出现', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();
  const adapter = resolveAdapter(provider, 'ideogram-3');

  await adapter.execute('generate', provider, {
    model: 'ideogram-3',
    prompt: 'a poster',
    quality: 'off',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);

  assert.equal(calls[0].init.body.get('rendering_speed'), null);
  assert.equal(calls[0].init.body.get('prompt'), 'a poster', '提示词照发');
});

test('ideogram-3 编辑直接报错', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider();

  await assert.rejects(
    () => resolveAdapter(provider, 'ideogram-3').execute('edit', provider, {
      model: 'ideogram-3', prompt: 'x', fitted: { omit: true, size: 'none' }
    }, new AbortController().signal),
    /暂未支持/
  );
  assert.equal(calls.length, 0);
});

/* ============================ 模板接线（改造后才成立） ============================ */

test('gemini 的负面词粘合符来自模板，而不是协议里的字面量', async (t) => {
  const calls = capture(t, geminiImageResponse);
  const provider = geminiProvider({
    modelOptions: { 'gemini-2.5-flash-image': { fields: { negative: { appendToPrompt: '\nAvoid: ' } } } }
  });
  const adapter = resolveAdapter(provider, 'gemini-2.5-flash-image');

  await adapter.execute('generate', provider, {
    model: 'gemini-2.5-flash-image', prompt: 'a cat', negativePrompt: 'blurry',
    fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);

  assert.equal(JSON.parse(calls[0].init.body).contents[0].parts[0].text, 'a cat\nAvoid: blurry');
});

test('ideogram 的张数字段名来自模板，模型选项里改了就跟到表单上', async (t) => {
  const calls = capture(t, IDEOGRAM_RESPONSE);
  const provider = ideogramProvider({
    modelOptions: { 'ideogram-3': { fields: { n: { path: 'number_of_images' } } } }
  });
  const adapter = resolveAdapter(provider, 'ideogram-3');

  await adapter.execute('generate', provider, {
    model: 'ideogram-3', prompt: 'a poster', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);

  const form = calls[0].init.body;
  assert.equal(form.get('number_of_images'), '1');
  assert.equal(form.get('num_images'), null, '旧的字段名不该还留着');
});

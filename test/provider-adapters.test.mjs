import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, adapterManifest, providerPresetManifest, prepareGenerate, prepareEdit, fitSize, qualityOptionsFor, qualityForAdapter, mapQuality, filterImageModels } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('gpt-image accepts arbitrary 16-multiple sizes and xhigh quality', () => {
  const provider = { baseUrl: 'https://api.openai.com/v1' };
  const gpt = resolveAdapter(provider, 'gpt-image-2.5-flare');
  const fitted = fitSize(provider, '2048x1152', 'gpt-image-2.5-flare');
  assert.equal(fitted.size, '2048x1152');
  const options = qualityOptionsFor(provider, 'gpt-image-2.5-flare', gpt);
  assert.deepEqual(options.options.map((item) => item.value), ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
});

test('gemini model list keeps nano-banana names and drops imagen', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => jsonResponse({ models: [
    { name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/imagen-4.0-generate', supportedGenerationMethods: ['predict'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }
  ] });

  const provider = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'k' };
  const adapter = resolveAdapter(provider, 'gemini-3.1-flash-image');
  assert.deepEqual(await adapter.listModels(provider, new AbortController().signal), [
    'gemini-nano-banana-2.1', 'gemini-3.1-flash-image'
  ]);
});

test('gemini sizes images per model and skips thought parts', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { mimeType: 'image/png', data: PNG_1PX } },
      { inlineData: { mimeType: 'image/png', data: PNG_1PX } }
    ] } }] });
  };

  const provider = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'k' };

  await resolveAdapter(provider, 'gemini-3.1-flash-image').execute('generate', provider, {
    model: 'gemini-3.1-flash-image', prompt: 'a cat', fitted: { width: 2048, height: 2048, size: '2048x2048', aspect: '1:1', tier: '2K' }
  }, new AbortController().signal);
  let body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.generationConfig.imageConfig.imageSize, '2K');
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '1:1');

  await resolveAdapter(provider, 'gemini-2.5-flash-image').execute('generate', provider, {
    model: 'gemini-2.5-flash-image', prompt: 'a cat', fitted: { width: 2048, height: 2048, size: '2048x2048' }
  }, new AbortController().signal);
  body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.generationConfig.imageConfig.imageSize, undefined);

  await assert.rejects(
    () => resolveAdapter(provider, 'gemini-2.5-flash-image').execute('edit', provider, {
      model: 'gemini-2.5-flash-image', prompt: 'x', fitted: { width: 1024, height: 1024, size: '1024x1024' },
      images: [1, 2, 3, 4].map((index) => ({ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: index + '.png' }))
    }, new AbortController().signal),
    /最多 3 张/
  );
});

test('gemini leaves the image config out while the size is Auto', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1PX } }] } }] });
  };
  const provider = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'k' };
  await resolveAdapter(provider, 'gemini-3.1-flash-image').execute('generate', provider, {
    model: 'gemini-3.1-flash-image', prompt: 'a cat', fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.generationConfig.imageConfig, undefined, 'Auto means the endpoint picks the shape');
  assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE'], 'the modalities stay');
});

test('xai imagine leaves the aspect ratio out while the size is Auto', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
  };
  const provider = { baseUrl: 'https://api.x.ai/v1', adapter: 'xai-imagine', key: 'k' };
  await resolveAdapter(provider, 'grok-imagine-1').execute('generate', provider, {
    model: 'grok-imagine-1', prompt: 'a cat', fitted: { omit: true, size: 'none' }
  }, new AbortController().signal);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.aspect_ratio, undefined, 'Auto means the endpoint picks the shape');
  assert.equal(body.resolution, undefined);
});

test('host-specific adapters win over model-only matches', () => {
  assert.equal(resolveAdapter({ baseUrl: 'https://res.openai.azure.com/openai/v1' }, 'gpt-image-2.5-flare').id, 'azure-openai');
  assert.equal(resolveAdapter({ baseUrl: 'https://openrouter.ai/api/v1' }, 'openai/gpt-image-2.5-flare').id, 'openrouter-images');
  // GPT-Image / DALL·E 3 不再各占一条协议：官方端点与中转站都落到合并后的 openai-images。
  assert.equal(resolveAdapter({ baseUrl: 'https://api.openai.com/v1' }, 'gpt-image-2.5-flare').id, 'openai-images');
  assert.equal(resolveAdapter({ baseUrl: 'https://api.openai.com/v1' }, 'dall-e-3').id, 'openai-images');
});

test('xhigh stays a first-class quality value', () => {
  const provider = { baseUrl: 'https://api.openai.com/v1' };
  const gpt = resolveAdapter(provider, 'gpt-image-2.5-flare');
  assert.equal(qualityForAdapter(provider, 'gpt-image-2.5-flare', 'xhigh', gpt), 'xhigh');
});

test('recraft routes edits to imageToImage', () => {
  const provider = { baseUrl: 'https://external.api.recraft.ai/v1', adapter: 'recraft', key: 'k' };
  const adapter = resolveAdapter(provider, 'recraftv4_1');
  const built = prepareEdit(adapter, provider, {
    model: 'recraftv4_1', prompt: 'watercolor', fitted: { width: 1024, height: 1024, size: '1024x1024' },
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'a.png' }]
  }, new Set(), 'image');
  assert.equal(built.path, '/images/imageToImage');
  assert.ok(built.body.get('image'));
  assert.equal(built.body.get('strength'), '0.5');
});

test('volcengine agent plan preset uses the merged openai-images protocol', () => {
  const preset = providerPresetManifest().find((item) => item.id === 'volcengine-plan');
  assert.ok(preset, 'expected the volcengine-plan preset');
  assert.equal(preset.name, '火山方舟 Agent Plan');
  assert.equal(preset.baseUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3');
  assert.equal(preset.adapter, 'openai-images');
  assert.deepEqual(preset.protocolOptions, { edit: 'same' });
  const adapter = resolveAdapter(preset, 'doubao-seedream-4-0-250828');
  assert.equal(adapter.id, 'openai-images');
  assert.equal(adapter.endpoints.edit, '/images/generations');
});

test('provider manifests include hot image providers and native capabilities', () => {
  const presets = providerPresetManifest();
  const adapters = adapterManifest();
  for (const id of ['gemini', 'xai', 'recraft', 'ideogram', 'stability', 'together', 'fireworks', 'novita']) {
    assert.ok(presets.some((preset) => preset.id === id), id);
  }
  assert.ok(presets.find((preset) => preset.id === 'gemini').models.includes('gemini-2.5-flash-image'));
  assert.ok(presets.find((preset) => preset.id === 'xai').models.includes('grok-imagine-image'));
  assert.ok(adapters.some((adapter) => adapter.id === 'google-gemini' && adapter.supportsModels));
  assert.ok(adapters.some((adapter) => adapter.id === 'xai-imagine' && adapter.supportsModels));
  assert.ok(adapters.some((adapter) => adapter.id === 'recraft' && adapter.supportsModels));
  assert.ok(adapters.some((adapter) => adapter.id === 'ideogram' && adapter.supportsModels));
  for (const preset of presets) {
    assert.match(preset.website, /^https:\/\//, preset.id);
  }
});

test('generic gateways can be filtered to likely image models', () => {
  assert.deepEqual(filterImageModels([
    'gpt-image-1',
    'dall-e-3',
    'gpt-4o',
    'text-embedding-3-small',
    'flux-1-schnell',
    'qwen-image',
    'wanx2.1-t2i-turbo',
    'cogview-4',
    'some-chat-model'
  ]), ['gpt-image-1', 'dall-e-3', 'flux-1-schnell', 'qwen-image', 'wanx2.1-t2i-turbo', 'cogview-4']);
});

test('filter recognizes the built-in image model families', () => {
  const builtIn = [
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'dall-e-3',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image-preview',
    'grok-imagine-image',
    'recraftv4_1',
    'ideogram-3',
    'core',
    'black-forest-labs/FLUX.1-schnell',
    'accounts/fireworks/models/flux-1-schnell',
    'flux-1-schnell',
    'Qwen/Qwen-Image',
    'Kwai-Kolors/Kolors',
    'wanx2.1-t2i-turbo',
    'doubao-seedream-4-0-250828',
    'cogview-4-250304'
  ];
  assert.deepEqual(filterImageModels(builtIn), builtIn);
  assert.deepEqual(filterImageModels(['gpt-4o', 'text-embedding-3-small', 'whisper-1']), []);
});

test('quality capabilities are per adapter and unsupported models hide quality', () => {
  const openai = { baseUrl: 'https://api.openai.com/v1' };
  const gpt = resolveAdapter(openai, 'gpt-image-2.5-flare');
  const gptQuality = qualityOptionsFor(openai, 'gpt-image-1.5', gpt);
  assert.deepEqual(gptQuality.options.map((item) => item.value), ['off', 'low', 'medium', 'high', 'auto']);
  assert.equal(qualityForAdapter(openai, 'gpt-image-1.5', 'max', gpt), 'high');

  const dalle = resolveAdapter(openai, 'dall-e-3');
  const dalleQuality = qualityOptionsFor(openai, 'dall-e-3', dalle);
  assert.deepEqual(dalleQuality.options.map((item) => item.value), ['off', 'standard', 'hd']);
  assert.equal(qualityForAdapter(openai, 'dall-e-3', 'high', dalle), 'standard');

  const geminiProvider = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' };
  const gemini = resolveAdapter(geminiProvider, 'gemini-2.5-flash-image');
  assert.equal(qualityOptionsFor(geminiProvider, 'gemini-2.5-flash-image', gemini), null);

  const ideogramProvider = { baseUrl: 'https://api.ideogram.ai' };
  const ideogram = resolveAdapter(ideogramProvider, 'ideogram-3');
  assert.deepEqual(qualityOptionsFor(ideogramProvider, 'ideogram-3', ideogram).options.map((item) => item.value), ['off', 'turbo', 'default', 'quality']);
  assert.equal(qualityForAdapter(ideogramProvider, 'ideogram-3', 'max', ideogram), 'default');

  const localProvider = { baseUrl: 'http://127.0.0.1:7860' };
  const local = resolveAdapter(localProvider, 'anything');
  assert.equal(qualityOptionsFor(localProvider, 'anything', local), null);
});

test('quality off means the field is not sent at all', () => {
  const openai = { baseUrl: 'https://api.openai.com/v1' };
  const gpt = resolveAdapter(openai, 'gpt-image-2.5-flare');
  // off 是全局固定档位：翻译成"不发这个参数"，不能变成 quality:"off" 发上去。
  assert.equal(mapQuality(openai, 'gpt-image-2.5-flare', 'off', gpt), undefined);
  assert.equal(mapQuality(openai, 'gpt-image-2.5-flare', 'auto', gpt), undefined);
  assert.equal(mapQuality(openai, 'gpt-image-2.5-flare', '', gpt), undefined);

  const ideogramProvider = { baseUrl: 'https://api.ideogram.ai' };
  const ideogram = resolveAdapter(ideogramProvider, 'ideogram-4');
  assert.equal(mapQuality(ideogramProvider, 'ideogram-4', 'off', ideogram), undefined);
  assert.equal(mapQuality(ideogramProvider, 'ideogram-4', 'quality', ideogram), 'QUALITY');

  // 端到端：档位是 off 时，组装出来的 body 里连 quality 这个键都不该有。
  const body = JSON.parse(prepareGenerate(gpt, openai, {
    model: 'gpt-image-2.5-flare', prompt: 'p', quality: 'off', fitted: fitSize(openai, '1024x1024', 'gpt-image-2.5-flare')
  }, new Set()).body);
  assert.equal(body.quality, undefined);
  assert.equal(body.size, '1024x1024');
});

test('Google Gemini lists image models and sends generateContent image parts', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/models?')) return jsonResponse({ models: [
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }
    ] });
    return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1PX } }] } }] });
  };
  const provider = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini', key: 'test-key' };
  const adapter = resolveAdapter(provider, 'gemini-2.5-flash-image');
  assert.equal(adapter.id, 'google-gemini');
  assert.deepEqual(await adapter.listModels(provider, new AbortController().signal), ['gemini-2.5-flash-image']);
  const result = await adapter.execute('generate', provider, {
    model: 'gemini-2.5-flash-image', prompt: 'a cat', negativePrompt: 'blur',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.ok(result.bytes.length > 0);
  const generation = calls.find((call) => call.url.includes(':generateContent'));
  assert.ok(generation.url.endsWith('/models/gemini-2.5-flash-image:generateContent'));
  assert.equal(generation.init.headers['x-goog-api-key'], 'test-key');
  assert.equal(generation.init.headers.Authorization, undefined);
  const body = JSON.parse(generation.init.body);
  assert.equal(body.contents[0].parts[0].text, 'a cat\n\nAvoid: blur');
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '1:1');

  const editResult = await adapter.execute('edit', provider, {
    model: 'gemini-2.5-flash-image', prompt: 'replace the background', images: [
      { buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' }
    ],
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.ok(editResult.bytes.length > 0);
  const editBody = JSON.parse(calls[calls.length - 1].init.body);
  assert.equal(editBody.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.ok(editBody.contents[0].parts[0].inlineData.data.length > 0);
});

test('Together AI uses width/height rather than OpenAI size', () => {
  const provider = { baseUrl: 'https://api.together.xyz/v1', adapter: 'together', key: 'test-key' };
  const adapter = resolveAdapter(provider, 'black-forest-labs/FLUX.1-schnell');
  const built = prepareGenerate(adapter, provider, {
    model: 'black-forest-labs/FLUX.1-schnell', prompt: 'a tree',
    fitted: { width: 1024, height: 768, size: '1024x768' }
  }, new Set());
  const body = JSON.parse(built.body);
  assert.equal(built.path, '/images/generations');
  assert.equal(body.width, 1024);
  assert.equal(body.height, 768);
  assert.equal(body.size, undefined);
});

test('xAI Grok Imagine sends aspect/resolution and decodes image output', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
  };
  const provider = { baseUrl: 'https://api.x.ai/v1', adapter: 'xai-imagine', key: 'test-key' };
  const adapter = resolveAdapter(provider, 'grok-imagine-image');
  const result = await adapter.execute('generate', provider, {
    model: 'grok-imagine-image', prompt: 'a robot',
    fitted: { width: 1024, height: 1024, size: '1024x1024', aspect: '1:1', tier: '1k' }
  }, new AbortController().signal);
  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/images/generations'));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.aspect_ratio, '1:1');
  assert.equal(body.resolution, '1k');
});

test('Recraft uses the OpenAI-shaped generation endpoint', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
  };
  const provider = { baseUrl: 'https://external.api.recraft.ai/v1', adapter: 'recraft', key: 'test-key' };
  const adapter = resolveAdapter(provider, 'recraftv4_1');
  const result = await adapter.execute('generate', provider, {
    model: 'recraftv4_1', prompt: 'a landscape',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/v1/images/generations'));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'recraftv4_1');
  assert.equal(body.size, '1024x1024');
});

test('Ideogram sends an Api-Key multipart generation request', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
  };
  const provider = { baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram', key: 'test-key' };
  const adapter = resolveAdapter(provider, 'ideogram-3');
  const result = await adapter.execute('generate', provider, {
    model: 'ideogram-3', prompt: 'a typographic poster', quality: 'quality',
    fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new AbortController().signal);
  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/v2/image/generate/ideogram-3'));
  assert.equal(captured.init.headers['Api-Key'], 'test-key');
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.equal(captured.init.body.get('prompt'), 'a typographic poster');
  assert.equal(captured.init.body.get('rendering_speed'), 'QUALITY');
  assert.equal(captured.init.body.get('aspect_ratio'), '1x1');
});

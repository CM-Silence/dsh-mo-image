import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, prepareGenerate } from '../lib/adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const fitted = { width: 1024, height: 1024, size: '1024x1024' };
const signal = () => new AbortController().signal;

test('responses sends tools and reads image_generation_call result', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ output: [{ type: 'image_generation_call', status: 'completed', result: PNG_1PX }] });
  };

  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  assert.equal(adapter.id, 'openai-responses');

  const result = await adapter.execute('generate', provider, {
    model: 'gpt-image-2.5-flare', prompt: 'a cat', fitted
  }, signal());

  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/responses'));
  assert.equal(captured.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.tools[0].type, 'image_generation');
  assert.equal(body.tools[0].model, 'gpt-image-2.5-flare');
  assert.equal(body.tools[0].size, '1024x1024');
  assert.equal(body.tool_choice.type, 'image_generation');
});

test('responses edit puts reference images into input content parts', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ output: [{ type: 'image_generation_call', result: PNG_1PX }] });
  };

  const provider = { baseUrl: 'https://api.openai.com/v1', adapter: 'openai-responses', hostModel: 'gpt-5.2', key: 'k' };
  const adapter = resolveAdapter(provider, 'gpt-image-2.5-flare');
  await adapter.execute('edit', provider, {
    model: 'gpt-image-2.5-flare',
    prompt: 'replace the background',
    fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'ref.png' }]
  }, signal());

  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.input[0].content[1].type, 'input_image');
  assert.ok(String(body.input[0].content[1].image_url).startsWith('data:image/png;base64,'));
});

test('openrouter-images posts to /images and reads b64_json with media_type', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ data: [{ b64_json: PNG_1PX, media_type: 'image/png' }] });
  };

  const provider = { baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images', key: 'k' };
  const adapter = resolveAdapter(provider, 'google/gemini-3.1-flash-image');
  assert.equal(adapter.id, 'openrouter-images');

  const result = await adapter.execute('generate', provider, {
    model: 'google/gemini-3.1-flash-image', prompt: 'a red panda',
    fitted: { width: 1344, height: 768, size: '1344x768' }
  }, signal());

  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/images'));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'google/gemini-3.1-flash-image');
  assert.equal(body.aspect_ratio, '16:9');
});

test('openrouter-images sends input_references for edits', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ data: [{ b64_json: PNG_1PX, media_type: 'image/png' }] });
  };

  const provider = { baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images', key: 'k' };
  const adapter = resolveAdapter(provider, 'x');
  await adapter.execute('edit', provider, {
    model: 'openai/gpt-image-2',
    prompt: 'watercolor',
    fitted,
    images: [{ buffer: Buffer.from(PNG_1PX, 'base64'), contentType: 'image/png', filename: 'a.png' }]
  }, signal());

  const body = JSON.parse(captured.init.body);
  assert.equal(body.input_references[0].type, 'image_url');
  assert.ok(String(body.input_references[0].image_url.url).startsWith('data:image/png;base64,'));
});

test('azure images uses the api-key header and the deployment name as model', () => {
  const provider = { baseUrl: 'https://res.openai.azure.com/openai/v1', adapter: 'azure-openai', key: 'k' };
  const adapter = resolveAdapter(provider, 'my-deployment');
  assert.equal(adapter.id, 'azure-openai');

  const built = prepareGenerate(adapter, provider, { model: 'my-deployment', prompt: 'a bear', fitted }, new Set());
  assert.equal(built.path, '/images/generations');
  assert.equal(built.headers['api-key'], 'k');
  assert.equal(built.headers.Authorization, undefined);
  assert.equal(JSON.parse(built.body).model, 'my-deployment');
});

test('openai-chat reads message.images data urls', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({
      choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG_1PX } }] } }]
    });
  };

  const provider = { baseUrl: 'https://relay.example/v1', adapter: 'openai-chat', key: 'k' };
  const adapter = resolveAdapter(provider, 'gemini-3.1-flash-image');
  const result = await adapter.execute('generate', provider, {
    model: 'gemini-3.1-flash-image', prompt: 'draw a cat', fitted
  }, signal());

  assert.ok(result.bytes.length > 0);
  assert.ok(captured.url.endsWith('/chat/completions'));
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.modalities, ['image', 'text']);
});

test('openai-chat throws instead of returning text when the relay sends no image', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: '抱歉，我不能生成图片' } }] });

  const provider = { baseUrl: 'https://relay.example/v1', adapter: 'openai-chat', key: 'k' };
  const adapter = resolveAdapter(provider, 'x');
  await assert.rejects(
    () => adapter.execute('generate', provider, { model: 'x', prompt: 'draw', fitted }, signal()),
    /没有返回图片/
  );
});

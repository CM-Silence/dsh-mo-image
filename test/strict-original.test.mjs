import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../lib/png-scale.js';
import { imageSizeOf } from '../lib/adapter-kit.js';

/* 严格模式缩过图时，上游那张原图要留在旁边，别被覆盖掉。 */

function png(width, height) {
  return encodePng(new Uint8Array(width * height * 4).fill(200), width, height);
}

const PNG_256 = png(256, 256).toString('base64');

async function harness(t, defaults) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-original-'));
  const work = mkdtempSync(path.join(os.tmpdir(), 'mo-image-cwd-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Local', baseUrl: 'https://api.test/v1', apiKeyEnv: 'MO_IMAGE_ORIGINAL_KEY',
      optionalKey: true, protocol: 'openai-images', adapter: 'openai-images', models: ['some-image-model'], names: {}
    }],
    active: { providerId: 'p1', model: 'some-image-model' },
    defaults: Object.assign({ quality: 'high', auto: false, width: 128, height: 128, promptOptimization: true }, defaults)
  }), 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });

  const tools = [];
  const credentials = {
    async resolve() { return { value: 'sk-test', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; }
  };
  const ctx = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(ctx); },
    tools: { register(def) { tools.push(def); return () => {}; }, guard() { return () => {}; } },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  const mod = await import('../lib/index.js?original-' + Math.random().toString(36).slice(2));
  mod.apply(ctx);

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_256 }] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  t.after(() => { globalThis.fetch = original; });

  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: work } } } };
  const tool = (name) => tools.find((item) => item.name === name);
  return { work, exec, settings: tool('mo_image_settings'), generate: tool('mo_image_generate') };
}

const imagesIn = (dir) => readdirSync(path.join(dir, 'generated-images')).sort();

test('strict mode keeps the upstream original next to the resized image', async (t) => {
  const { work, exec, settings, generate } = await harness(t, { strict: true, width: 128, height: 128 });
  await settings.execute({}, exec);
  const result = await generate.execute({ prompt: '一只猫', size: '256x256' }, exec);

  const files = imagesIn(work);
  assert.equal(files.length, 2, 'the resized image and the original');
  const originalFile = files.find((name) => name.includes('-original'));
  assert.ok(originalFile, 'the original keeps a -original suffix');
  assert.ok(result.original && result.original.endsWith(originalFile), 'the tool reports where the original went');

  const saved = readFileSync(path.join(work, 'generated-images', files.find((name) => !name.includes('-original'))));
  const kept = readFileSync(path.join(work, 'generated-images', originalFile));
  assert.deepEqual(imageSizeOf(saved), { width: 128, height: 128 });
  assert.deepEqual(imageSizeOf(kept), { width: 256, height: 256 }, 'the original is untouched');
  assert.equal(result.size, '128x128');
  assert.equal(result.generated, '256x256');
});

test('without strict mode nothing extra is written', async (t) => {
  const { work, exec, settings, generate } = await harness(t, { strict: false, width: 128, height: 128 });
  await settings.execute({}, exec);
  const result = await generate.execute({ prompt: '一只猫' }, exec);

  const files = imagesIn(work);
  assert.equal(files.length, 1);
  assert.equal(result.original, undefined);
  assert.equal(result.generated, '256x256');
});
test('strict mode resizes a prompt-only model to the selector size', async (t) => {
  // 模型不收 size（尺寸写进提示词）时，严格模式仍然按选择器的宽高锁分辨率。
  const { work, exec, settings, generate } = await harness(t, { strict: true, width: 128, height: 128 });
  const state = path.join(process.env.DSH_HOME, 'mo-image', 'config.json');
  const config = JSON.parse(readFileSync(state, 'utf8'));
  config.providers[0].modelOptions = { 'some-image-model': { size: { mode: 'prompt' } } };
  writeFileSync(state, JSON.stringify(config), 'utf8');
  await settings.execute({}, exec);
  const result = await generate.execute({ prompt: '一只猫' }, exec);

  assert.equal(result.size, '128x128');
  assert.equal(result.generated, '256x256');
  const files = imagesIn(work);
  assert.equal(files.length, 2, 'resized image plus the kept original');
});

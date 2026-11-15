import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { comfySizeWritable } from '../lib/adapters.js';

/* 模型不收尺寸参数时：把尺寸写进提示词，并在 note 里说清楚。 */

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function harness(t, provider, defaults) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-stitch-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [Object.assign({ apiKeyEnv: 'MO_IMAGE_STITCH_KEY', optionalKey: true, names: {} }, provider)],
    active: { providerId: provider.id, model: provider.models[0] },
    defaults: Object.assign({ quality: 'high', auto: false, width: 1024, height: 1024, strict: false }, defaults)
  }), 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
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
  const mod = await import('../lib/index.js?stitch-' + Math.random().toString(36).slice(2));
  mod.apply(ctx);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: os.tmpdir() } } } };
  const tool = (name) => tools.find((item) => item.name === name);
  return { calls, exec, settings: tool('mo_image_settings'), generate: tool('mo_image_generate') };
}

test('a prompt-only model gets the size appended to the prompt', async (t) => {
  const { calls, exec, settings, generate } = await harness(t, {
    id: 'relay', name: 'Relay', baseUrl: 'https://relay.test/v1', adapter: 'openai-chat', models: ['some-chat-image']
  }, { width: 1024, height: 1536 });
  await settings.execute({}, exec);
  const result = await generate.execute({ prompt: '一只橘猫' }, exec);
  const body = JSON.parse(calls[0].init.body);
  const text = JSON.stringify(body.messages);
  assert.match(text, /Output size: 1024x1536/);
  assert.match(result.note, /写进提示词/);
  assert.equal(result.size, '1024x1536');
});

test('comfySizeWritable knows whether the workflow can take width/height', () => {
  const provider = {
    modelOptions: {
      mapped: { workflow: '{"1":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}}}', mapping: { width: { node: '1', input: 'width' }, height: { node: '1', input: 'height' } } },
      unmapped: { workflow: '{"1":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}}}' },
      templated: { workflow: '{"1":{"class_type":"EmptyLatentImage","inputs":{"width":"{{width}}","height":"{{height}}"}}}' }
    }
  };
  assert.equal(comfySizeWritable(provider, 'mapped'), true);
  assert.equal(comfySizeWritable(provider, 'templated'), true);
  assert.equal(comfySizeWritable(provider, 'unmapped'), false);
  assert.equal(comfySizeWritable(provider, 'builtin'), true, 'no custom workflow means the built-in graph is used');
});

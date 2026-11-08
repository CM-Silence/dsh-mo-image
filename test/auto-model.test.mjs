import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { promptSectionText } from '../lib/prompt-profiles.js';
import { configWriteReason } from '../lib/config-guard.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function makeHome(activeModel) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-auto-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1',
      apiKeyEnv: 'MO_IMAGE_P1_API_KEY', protocol: 'openai-images', adapter: '',
      models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], names: {}
    }],
    active: { providerId: 'p1', model: activeModel },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }), 'utf8');
  return home;
}

const guards = [];

function fakeContext(tools) {
  const credentials = {
    async resolve() { return { value: 'sk-test-key', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; },
    async set() {},
    async unset() {}
  };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: {
      register(def) { tools.push(def); return () => {}; },
      guard(def) { guards.push(def); return () => {}; }
    },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

async function generateWith(t, activeModel, args) {
  const home = makeHome(activeModel);
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?auto-' + activeModel + '-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools));
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { generate, edit, calls, home, reference };
}

test('auto mode lets the model pick any model from the active provider', async (t) => {
  const { generate, calls } = await generateWith(t, 'auto', {});
  await generate.execute({ prompt: 'a cat', model: 'gpt-image-2.5-sunburst' },
    { signal: new AbortController().signal, agent: { session: { header: { cwd: os.tmpdir() } } } });
  assert.equal(JSON.parse(calls[0].init.body).model, 'gpt-image-2.5-sunburst');
});

test('auto mode without a model argument is an error, not a silent guess', async (t) => {
  const { generate } = await generateWith(t, 'auto', {});
  await assert.rejects(
    generate.execute({ prompt: 'a cat' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: os.tmpdir() } } } }),
    /Auto/
  );
});

test('auto mode rejects models outside the active provider list', async (t) => {
  const { generate } = await generateWith(t, 'auto', {});
  await assert.rejects(
    generate.execute({ prompt: 'a cat', model: 'not-in-list' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: os.tmpdir() } } } }),
    /不在|列表/
  );
});

test('outside auto mode a model argument is refused', async (t) => {
  const { generate } = await generateWith(t, 'gpt-image-2.5-flare', {});
  await assert.rejects(
    generate.execute({ prompt: 'a cat', model: 'gpt-image-2.5-sunburst' }, { signal: new AbortController().signal, agent: { session: { header: { cwd: os.tmpdir() } } } }),
    /Auto/
  );
});

test('auto mode is described in the prompt section with the available models', () => {
  const text = promptSectionText({ model: 'auto', models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], promptOptimization: true });
  assert.match(text, /Auto/);
  assert.match(text, /gpt-image-2\.5-flare/);
  assert.match(text, /gpt-image-2\.5-sunburst/);
  assert.match(text, /model/);
});

test('the config guard refuses direct edits of the plugin config', () => {
  assert.match(configWriteReason({ path: 'C:\\Users\\x\\.dsh\\mo-image\\config.json', content: '{}' }), /配置/);
  assert.match(configWriteReason({ command: 'echo {} > ~/.dsh/mo-image/config.json' }), /配置/);
  assert.match(configWriteReason({ url: 'http://127.0.0.1:54003/api/mo-image/config', body: '{}' }), /配置/);
  assert.equal(configWriteReason({ path: 'C:\\repo\\dsh-mo-image\\lib\\index.js' }), undefined);
  assert.equal(configWriteReason({ path: 'lib/index.js', content: "route '/api/mo-image/config'" }), undefined);
  assert.equal(configWriteReason({ prompt: '画一只猫' }), undefined);
});

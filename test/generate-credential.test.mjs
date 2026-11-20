import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('generation resolves the key from the credentials service without a config key', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-generate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  const worktree = path.join(home, '项目 images #1 (review) %');
  mkdirSync(worktree);
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1',
      // 真机上这就是从 OpenAI 预设建的提供商：来源（presetId）在，协议是 OpenAI Images。
      apiKeyEnv: 'MO_IMAGE_P1_API_KEY', protocol: 'openai-images', adapter: 'openai-images', presetId: 'openai',
      models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'max', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const credentials = {
    async resolve(ref) {
      return ref === 'MO_IMAGE_P1_API_KEY' ? { value: 'sk-test-key', source: 'file' } : undefined;
    },
    async describe(ref) {
      return ref === 'MO_IMAGE_P1_API_KEY'
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true };
    },
    async set() {},
    async unset() {}
  };
  const tools = [];
  const routes = [];
  let currentDirectory = worktree;
  let maxImageBytes;
  const projections = { stateOf(_session, key) { return key === 'workingDirectory' ? currentDirectory : null; } };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
      getOrigin() { return 'http://127.0.0.1:1'; }
    },
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'sessionProjections') return projections;
      if (name === 'attachments') return { imageLimits: { maxImageBytes } };
    }
  };
  const mod = await import('../lib/index.js?generate-credential-test');
  mod.apply(fake);
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const settings = tools.find((tool) => tool.name === 'mo_image_settings');
  assert.ok(generate);
  assert.ok(settings);
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: home } } }
  };
  await settings.execute({}, exec);

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await generate.execute({ prompt: 'a small test image', model: 'gpt-image-2.5-flare', quality: 'low', size: '2048x2048' }, exec);
  assert.ok(result.path);
  assert.equal(path.dirname(result.path), path.join(worktree, 'generated-images'));
  assert.equal(existsSync(path.join(state, 'out', path.basename(result.path))), false);
  assert.deepEqual(readFileSync(result.path), Buffer.from(PNG_1PX, 'base64'));
  assert.ok(captured);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.quality, 'max');
  assert.equal(body.size, '2048x2048', 'with the size on Auto the chat model may pick the shape');
  const headers = captured.init.headers;
  const auth = typeof headers.get === 'function' ? headers.get('authorization') : (headers.Authorization || headers.authorization);
  assert.equal(auth, 'Bearer sk-test-key');

  const markdown = generate.output.render({}, result)[0].text;
  const destination = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(markdown)?.[1];
  assert.ok(destination);
  assert.match(destination, /%20.*%23.*%28review%29.*%25/);
  assert.equal(path.normalize(decodeURIComponent(destination)), result.path, 'chat receives a local file path');

  currentDirectory = null;
  maxImageBytes = 1;
  const oversized = await generate.execute({ prompt: 'keep preview on a host with a lower size limit' }, exec);
  assert.equal(path.dirname(oversized.path), path.join(home, 'generated-images'));
  assert.match(generate.output.render({}, oversized)[0].text, /\(http[^)]+\/api\/mo-image\/preview\//);

  const script = await generate.execute({ prompt: 'output outside a chat session' }, { signal: exec.signal });
  assert.equal(path.dirname(script.path), path.join(state, 'out'));
  const url = /!\[[^\]]*\]\((http[^)]+)\)/.exec(generate.output.render({}, script)[0].text);
  assert.ok(url, 'calls without a workspace retain signed previews');
  const previewRoute = routes.find((route) => route.path === '/api/mo-image/preview');
  assert.ok(previewRoute);
  const res = {
    status: 0, body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; }
  };
  await previewRoute.handler({ method: 'GET', url: new URL(url[1]).pathname }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, Buffer.from(PNG_1PX, 'base64'));
});

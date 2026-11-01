import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('generation resolves the key from the credentials service without a config key', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-generate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1',
      apiKeyEnv: 'MO_IMAGE_P1_API_KEY', protocol: 'openai-images',
      models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'max', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');

  process.env.DSH_HOME = home;
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
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
      getOrigin() { return 'http://127.0.0.1:1'; }
    },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  const mod = await import('../lib/index.js?generate-credential-test');
  mod.apply(fake);
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  assert.ok(generate);

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await generate.execute({ prompt: 'a small test image', quality: 'low', size: '2048x2048' }, {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: home } } }
  });
  assert.ok(result.path);
  assert.equal(path.dirname(result.path), path.join(home, 'generated-images'));
  assert.equal(existsSync(path.join(state, 'out', path.basename(result.path))), false);
  assert.ok(captured);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.quality, 'high');
  assert.equal(body.size, undefined);
  const headers = captured.init.headers;
  const auth = typeof headers.get === 'function' ? headers.get('authorization') : (headers.Authorization || headers.authorization);
  assert.equal(auth, 'Bearer sk-test-key');

  const rendered = generate.output.render({}, result);
  const markdown = rendered.map((block) => block.text || '').join('\n');
  const url = /!\[[^\]]*\]\((http[^)]+)\)/.exec(markdown);
  assert.ok(url);
  const previewRoute = routes.find((route) => route.path === '/api/mo-image/preview');
  assert.ok(previewRoute);
  const res = {
    status: 0, body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; }
  };
  await previewRoute.handler({ method: 'GET', url: new URL(url[1]).pathname }, res);
  assert.equal(res.status, 200);
  assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0);
});

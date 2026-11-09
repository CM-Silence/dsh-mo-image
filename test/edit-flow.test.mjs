import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('edit flow reads a local reference and sends a JSON image payload', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-edit-flow-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
      apiKeyEnv: 'MO_IMAGE_P1_API_KEY', protocol: 'openai-images', adapter: '',
      models: ['kwai-kolors/kolors'], names: {}
    }],
    active: { providerId: 'p1', model: 'kwai-kolors/kolors' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }, null, 2), 'utf8');
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));

  process.env.DSH_HOME = home;
  const credentials = {
    async resolve() { return { value: 'sk-test-key', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; },
    async set() {},
    async unset() {}
  };
  const tools = [];
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: {
      register(route) { return () => route; },
      getOrigin() { return 'http://127.0.0.1:1'; }
    },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  const mod = await import('../lib/index.js?edit-flow-test');
  mod.apply(fake);
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');
  assert.ok(edit);

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await edit.execute({
    prompt: '只把背景换成浅灰色，其他保持不变',
    model: 'kwai-kolors/kolors',
    images: [reference]
  }, { signal: new AbortController().signal, agent: { session: { header: { cwd: home } } } });

  assert.ok(result.path);
  assert.equal(path.dirname(result.path), path.join(home, 'generated-images'));
  assert.ok(captured);
  assert.ok(captured.url.endsWith('/images/generations'));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'kwai-kolors/kolors');
  assert.match(String(body.image), /^data:image\/png;base64,/);
});

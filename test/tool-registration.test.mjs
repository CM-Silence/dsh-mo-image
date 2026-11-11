import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-tools-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Local ComfyUI', baseUrl: 'http://127.0.0.1:8188', key: '',
      protocol: 'openai-images', adapter: 'comfyui', optionalKey: true,
      models: ['flux-2-klein-4b.safetensors'], names: { 'flux-2-klein-4b.safetensors': 'FLUX.2 Klein 4B' }
    }],
    active: { providerId: 'p1', model: 'flux-2-klein-4b.safetensors' },
    defaults: { quality: 'high', auto: false, width: 1024, height: 1024 }
  }, null, 2), 'utf8');
  return home;
}

/** A registry that enforces the DSH tool contract, so a missing output fails loudly. */
function strictContext(tools, registered) {
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
      register(definition) {
        // Mirrors @deepseek-ai/dsh-tools ToolsService.register.
        const output = definition.output;
        if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
        }
        assert.equal(typeof output.schema, 'object', `${definition.name}: output.schema must be an object`);
        assert.ok(definition.parameters && typeof definition.parameters === 'object', `${definition.name}: parameters missing`);
        registered.push(definition);
        return () => {};
      }
    },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

test('every image tool registers under the DSH output contract', async (t) => {
  const home = makeHome();
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const registered = [];
  const mod = await import('../lib/index.js?tool-registration-test');
  mod.apply(strictContext([], registered));

  assert.deepEqual(
    registered.map((tool) => tool.name).sort(),
    ['mo_image_edit', 'mo_image_generate', 'mo_image_settings']
  );
});

test('the settings output schema matches the payload and renders the same json', async (t) => {
  const home = makeHome();
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const registered = [];
  const mod = await import('../lib/index.js?tool-registration-schema');
  mod.apply(strictContext([], registered));

  const tool = registered.find((item) => item.name === 'mo_image_settings');
  assert.ok(tool);
  const value = await tool.execute({}, {});
  const schema = tool.output.schema;
  assert.deepEqual([...schema.required].sort(), Object.keys(value).sort(), 'schema.required must describe the payload');
  assert.equal(schema.properties.models.type, 'array', 'only auto mode adds a model list');

  const blocks = tool.output.render({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, JSON.stringify(value));
  assert.match(blocks[0].text, /"model":"flux-2-klein-4b\.safetensors"/);
});


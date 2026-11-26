import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function config(overrides = {}) {
  return Object.assign({
    version: 1,
    providers: [
      {
        id: 'p1', name: 'Local', baseUrl: 'https://api.test/v1',
        apiKeyEnv: 'MO_IMAGE_P1_API_KEY', optionalKey: true, protocol: 'openai-images',
        adapter: '',
        models: ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors'],
        names: {}
      }
    ],
    active: { providerId: 'p1', model: 'flux-2-klein-4b.safetensors' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  }, overrides);
}

function makeHome(cfg) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-marker-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify(cfg), 'utf8');
  return home;
}

/** systemPrompt 的替身：记下插件注册的提示词节和变量。 */
function fakeContext(tools, prompt, options = {}) {
  const credentials = {
    async resolve() { return { value: 'sk-test-key', source: 'file' }; },
    async describe() { return { configured: true, source: 'file', writable: true }; },
    async set() {},
    async unset() {}
  };
  const systemPrompt = {
    section(definition) { prompt.section = definition; return () => {}; }
  };
  if (options.variables !== false) {
    systemPrompt.variable = options.variableThrows
      ? () => { throw new Error('duplicate prompt variable'); }
      : (name, provider) => { prompt.variables[name] = provider; return () => {}; };
  }
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: {
      register(definition) {
        if (options.rejectSettings && definition.name === 'mo_image_settings') throw new Error('settings unavailable');
        tools.push(definition);
        return () => {};
      },
      get(name, _scope, toolSet) {
        return toolSet?.has(name) === false ? undefined : tools.find((tool) => tool.name === name);
      },
      guard() { return () => {}; }
    },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    systemPrompt,
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

async function harness(t, options = {}) {
  const home = makeHome(options.config || config());
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const prompt = { section: null, variables: {} };
  const mod = await import('../lib/index.js?marker-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools, prompt, options));

  const session = {};
  const exec = { signal: new AbortController().signal, agent: { session } };
  const marker = prompt.variables.mo_image_config;
  return {
    home, prompt, session, exec, marker,
    settings: tools.find((item) => item.name === 'mo_image_settings'),
    generate: tools.find((item) => item.name === 'mo_image_generate')
  };
}

test('the prompt section carries the config-state placeholder and its provider', async (t) => {
  const { prompt, marker } = await harness(t);
  assert.ok(prompt.section, 'the prompt section is registered');
  const text = prompt.section.text();
  assert.match(text, /\{\{mo_image_config\}\}/, 'the host interpolates the marker, so the section stays current');
  assert.equal(typeof marker, 'function', 'the variable provider is registered next to the section');
});

test('the marker follows this session only, and clears once the settings were read', async (t) => {
  const { marker, exec, session, settings, home } = await harness(t);

  assert.match(marker({ agent: { session } }), /还没读过/, 'a session that never read must read first');
  assert.match(marker({ agent: { session: {} } }), /还没读过/, 'another session is not helped by a read elsewhere');

  await settings.execute({}, exec);
  assert.match(marker({ agent: { session } }), /一致/, 'reading once clears the marker');
  assert.match(marker({ agent: { session: {} } }), /还没读过/, 'and does not clear it for other sessions');

  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = config();
  next.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');
  assert.match(marker({ agent: { session } }), /改过/, 'a config change makes the old read stale again');
});

test('the unread marker uses the image tool when settings is absent from the current tool set', async (t) => {
  const { marker, exec } = await harness(t);
  assert.match(marker(exec), /unknown tool.*直接调用生图/);
  const unavailable = marker({ ...exec, toolSet: new Set(['mo_image_generate']) });
  assert.match(unavailable, /直接调用生图\/改图工具接收配置/);
  assert.doesNotMatch(unavailable, /mo_image_settings/);
});

test('a failed settings registration still leaves the image tool and its fallback guidance', async (t) => {
  const { marker, exec, settings, generate } = await harness(t, { rejectSettings: true });
  assert.equal(settings, undefined);
  assert.doesNotMatch(marker(exec), /mo_image_settings/);
  assert.equal((await generate.execute({ prompt: 'a harbor' }, exec)).needsSettings, true);
});

test('a host without prompt variables gets the same state computed inline', async (t) => {
  const { prompt, marker, settings, exec } = await harness(t, { variables: false });
  assert.equal(marker, undefined, 'nothing is registered when the host cannot interpolate it');
  const session = exec.agent.session;
  const text = prompt.section.text({ agent: { session } });
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /\{\{/, 'an unresolved placeholder would break the whole prompt assembly');
  assert.match(text, /配置状态：本会话还没读过/);

  await settings.execute({}, exec);
  assert.match(prompt.section.text({ agent: { session } }), /配置状态：和上次读到的一致/);
});

test('after compaction the marker leads directly to a full image-tool handoff', async (t) => {
  const { marker, session, exec, settings, generate } = await harness(t);
  session.surface = { contentGeneration: 0 };
  const first = await settings.execute({}, exec);
  session.surface.contentGeneration++;
  const update = marker({ agent: { session } });
  assert.match(update, /直接调用生图\/改图工具接收完整配置/);
  assert.doesNotMatch(update, /mo_image_settings/);

  const handoff = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(handoff.needsSettings, true);
  assert.deepEqual(handoff.settings, first);
  assert.match(marker({ agent: { session } }), /一致/);
});

test('a failed variable registration falls back to the inline state', async (t) => {
  const { prompt, exec } = await harness(t, { variableThrows: true });
  const text = prompt.section.text({ agent: { session: exec.agent.session } });
  assert.doesNotMatch(text, /\{\{/, 'a placeholder without a registered variable breaks prompt assembly');
  assert.match(text, /配置状态：本会话还没读过/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function config(overrides = {}) {
  return Object.assign({
    version: 1,
    providers: [
      {
        id: 'p1', name: 'Local', baseUrl: 'https://api.test/v1',
        apiKeyEnv: 'MO_IMAGE_P1_API_KEY', optionalKey: true, protocol: 'openai-images',
        adapter: 'openai-images',
        models: ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors'],
        names: {}
      }
    ],
    active: { providerId: 'p1', model: 'flux-2-klein-4b.safetensors' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: true }
  }, overrides);
}

function makeHome(cfg) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-two-step-'));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify(cfg), 'utf8');
  return home;
}

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
    tools: { register(def) { tools.push(def); return () => {}; }, guard() { return () => {}; } },
    webServer: { register(route) { return () => route; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    get(name) { return name === 'credentials' ? credentials : undefined; }
  };
  return fake;
}

/** 一个稳定的会话：读取配置的那次调用和随后的生图必须落在同一个 session 上。 */
async function harness(t, cfg = config()) {
  const home = makeHome(cfg);
  const previousHome = process.env.DSH_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = home;

  const tools = [];
  const mod = await import('../lib/index.js?two-step-' + Math.random().toString(36).slice(2));
  mod.apply(fakeContext(tools));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: os.tmpdir() } } }
  };
  const tool = (name) => tools.find((item) => item.name === name);
  return {
    home, calls, exec, tool,
    settings: tool('mo_image_settings'),
    generate: tool('mo_image_generate'),
    edit: tool('mo_image_edit')
  };
}

test('the settings tool returns a minimal json with the model and a one-line hint', async (t) => {
  const { settings, exec } = await harness(t);
  assert.ok(settings, 'mo_image_settings must be registered');
  assert.equal(settings.parameters.required, undefined, 'the settings tool takes no arguments');

  const result = await settings.execute({}, exec);
  assert.deepEqual(Object.keys(result).sort(), ['canEdit', 'control', 'hint', 'model', 'promptOptimization', 'provider', 'qualityMode', 'sizeMode', 'strict']);
  assert.equal(result.provider, 'p1', 'the provider is reported by id only');
  assert.equal(result.model, 'flux-2-klein-4b.safetensors');
  assert.equal(result.promptOptimization, true);
  assert.match(result.hint, /30–80 词/, 'the FLUX word budget must be in the hint');
  assert.doesNotMatch(result.hint, /加载|skill/, 'the settings result carries the dialect, not a second skill instruction');
});

test('prompt optimization off only says to use the user wording', async (t) => {
  const cfg = config();
  cfg.defaults.promptOptimization = false;
  const { settings, exec } = await harness(t, cfg);

  const result = await settings.execute({}, exec);
  assert.equal(result.promptOptimization, false);
  assert.match(result.hint, /用户原话/);
  assert.doesNotMatch(result.hint, /30–80 词/, 'no dialect coaching while optimization is off');
  assert.doesNotMatch(result.hint, /skill/, 'nothing to read while optimization is off');
});

test('auto mode lists the model ids to pick from', async (t) => {
  const cfg = config();
  cfg.active = { providerId: 'p1', model: 'auto' };
  const { settings, exec } = await harness(t, cfg);

  const result = await settings.execute({}, exec);
  assert.equal(result.model, 'auto');
  assert.deepEqual(result.models, ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors']);
  assert.deepEqual(result.editModels, ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors'],
    'Auto mode also reports which models can edit');
  const rendered = JSON.parse(settings.output.render({}, result)[0].text);
  assert.deepEqual(rendered.models, result.models);
  assert.equal(rendered.editModelIndexes, 'all');
  assert.equal(rendered.editModels, undefined, 'IDs appear only in the model-facing catalog');
});

test('Auto candidate details are scoped, reusable and refreshed when size or params change', async (t) => {
  const cfg = config();
  cfg.active = { providerId: 'p1', model: 'auto' };
  cfg.defaults = { ...cfg.defaults, auto: false, width: 1024, height: 1024 };
  const model = cfg.providers[0].models[0];
  cfg.providers[0].modelOptions = {
    [model]: {
      params: [{ name: 'steps', type: 'number', expose: true, default: '12', description: 'Sampling steps' }]
    }
  };
  const { settings, exec, home, calls } = await harness(t, cfg);

  assert.equal((await settings.execute({ model: 'missing' }, exec)).model, undefined);
  const detail = await settings.execute({ model }, exec);
  assert.equal(detail.model, model);
  assert.equal(detail.size, '1024x1024');
  assert.equal(detail.canEdit, true);
  assert.equal(detail.models, undefined);
  assert.deepEqual(detail.params, [{ name: 'steps', type: 'number', description: 'Sampling steps', default: '12' }]);
  assert.equal((await settings.execute({ model }, exec)).unchanged, true);
  assert.deepEqual(await settings.execute({ model, refresh: true }, exec), detail);
  assert.equal((await settings.execute({}, exec)).model, 'auto', 'the candidate read does not consume the catalog');
  assert.equal((await settings.execute({}, exec)).unchanged, true);

  const file = path.join(home, 'mo-image', 'config.json');
  cfg.providers[0].models.push('another-candidate');
  writeFileSync(file, JSON.stringify(cfg), 'utf8');
  const expanded = await settings.execute({}, exec);
  assert.ok(expanded.models.includes('another-candidate'));
  assert.equal((await settings.execute({ model }, exec)).unchanged, true, 'an unrelated catalog change does not repeat these details');

  cfg.defaults.height = 1536;
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  const reloaded = await settings.execute({}, exec);
  assert.equal(reloaded.model, 'auto', 'fixed dimension changes invalidate the Auto catalog read');
  const resized = await settings.execute({ model }, exec);
  assert.equal(resized.size, '1024x1536');
  cfg.providers[0].modelOptions[model].params[0].default = '24';
  writeFileSync(file, JSON.stringify(cfg, null, 4), 'utf8');
  const changed = await settings.execute({ model }, exec);
  assert.equal(changed.params[0].default, '24');
  assert.equal(calls.length, 0);
});

test('selector guards fixed model, size and quality while automatic settings permit validated choices', async (t) => {
  const cfg = config();
  cfg.providers[0].models = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
  cfg.providers[0].baseUrl = 'https://api.openai.com/v1';
  cfg.providers[0].presetId = 'openai';
  cfg.active.model = cfg.providers[0].models[0];
  cfg.defaults = { ...cfg.defaults, quality: 'auto' };
  const { settings, generate, edit, exec, calls, home } = await harness(t, cfg);
  const first = await settings.execute({}, exec);
  assert.equal(first.qualityMode, 'auto');
  assert.equal(first.sizeMode, 'auto');
  assert.ok(first.qualityOptions.includes('low'));
  assert.ok(generate.parameters.properties.quality);
  assert.ok(edit.parameters.properties.quality);
  await assert.rejects(() => generate.execute({ prompt: 'test', model: cfg.providers[0].models[1] }, exec), /只能由用户/);
  await assert.rejects(() => generate.execute({ prompt: 'test', quality: 'unsupported-tier' }, exec), /不支持质量档位/);
  assert.equal(calls.length, 0);

  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
  await generate.execute({ prompt: 'test', quality: 'low', size: '1024x1536' }, exec);
  await edit.execute({ prompt: 'edit', images: [reference], quality: 'medium', size: '1536x1024' }, exec);
  await generate.execute({ prompt: 'use API default' }, exec);
  const automatic = JSON.parse(calls[0].init.body);
  assert.equal(automatic.model, cfg.active.model);
  assert.equal(automatic.quality, 'low');
  assert.equal(automatic.size, '1024x1536');
  assert.equal(calls[1].init.body.get('quality'), 'medium');
  assert.equal(calls[1].init.body.get('size'), '1536x1024');
  assert.equal(JSON.parse(calls[2].init.body).quality, undefined);

  cfg.defaults = { ...cfg.defaults, auto: false, quality: 'high', width: 1024, height: 1024 };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(cfg, null, 2));
  const fixed = await settings.execute({}, exec);
  assert.equal(fixed.qualityMode, 'fixed');
  assert.equal(fixed.quality, 'high');
  assert.equal(fixed.sizeMode, 'fixed');
  await generate.execute({ prompt: 'keep picker settings', quality: 'low', size: '1024x1536' }, exec);
  const pinned = JSON.parse(calls[3].init.body);
  assert.equal(pinned.quality, 'high');
  assert.equal(pinned.size, '1024x1024');
});

test('generating without reading the settings hands over the config instead of failing', async (t) => {
  const { generate, calls, exec } = await harness(t);

  const handoff = await generate.execute({ prompt: 'a city at dusk' }, exec);
  assert.equal(calls.length, 0, 'nothing is sent while the settings are unknown');
  assert.equal(handoff.path, '', 'no image is produced by the handoff');
  assert.equal(handoff.needsSettings, true, 'the model is told what is missing');
  assert.equal(handoff.settings.model, 'flux-2-klein-4b.safetensors', 'the handoff carries the config');
  assert.match(handoff.note, /没有生成/, 'the note says nothing was generated');

  // 模型看到的是 render 出来的内容块：整份 handoff 必须作为 JSON 交出去，settings 才到得了模型手里。
  const seen = JSON.parse(generate.output.render({ prompt: 'x' }, handoff)[0].text);
  assert.equal(seen.settings.model, 'flux-2-klein-4b.safetensors');
  assert.match(seen.settings.hint, /30–80 词/);
  assert.match(seen.note, /没有生成/);

  // 宿主会拿 output.schema 校验 value：交接形状必须始终在 schema 里。
  const schema = generate.output.schema;
  for (const key of schema.required) assert.ok(key in handoff, 'required field present: ' + key);
  for (const key of Object.keys(handoff)) assert.ok(schema.properties[key], 'declared field: ' + key);

  // 配置已经随结果交回来了，同一个会话可以直接重试。
  await generate.execute({ prompt: 'a city at dusk, warm dusk light' }, exec);
  assert.equal(calls.length, 1);
});

test('generating after reading the settings uses the picked model', async (t) => {
  const { settings, generate, calls, exec } = await harness(t);

  await settings.execute({}, exec);
  await generate.execute({ prompt: 'a city at dusk' }, exec);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).model, 'flux-2-klein-4b.safetensors');
});

test('an exposed parameter row is sent and never reported as "unsupported workflow parameters"', async (t) => {
  const cfg = config();
  cfg.providers[0].modelOptions = {
    'flux-2-klein-4b.safetensors': {
      params: [
        { name: 'steps', type: 'number', default: '20', expose: true },
        { name: 'cfg_scale', type: 'number', default: '7' }
      ]
    }
  };
  const { settings, generate, calls, exec } = await harness(t, cfg);
  await settings.execute({}, exec);

  const first = await generate.execute({ prompt: 'a city at dusk', params: { steps: 30 } }, exec);
  const body = JSON.parse(calls[calls.length - 1].init.body);
  assert.equal(body.steps, 30, 'an exposed row takes the model value');
  assert.equal(body.cfg_scale, 7, 'an unexposed row still sends its default');
  assert.equal(first.note, undefined, 'nothing to report when the parameter really landed');

  // 认不出的键才提，而且不再说「不支持工作流参数」（A1111 / 通用路径都认这张表）。
  const second = await generate.execute({ prompt: 'a city at dusk', params: { steps: 30, mystery: 1 } }, exec);
  assert.match(String(second.note), /mystery/);
  assert.doesNotMatch(String(second.note), /不支持工作流参数/);
});

test('editing hands the config over the same way as generating', async (t) => {
  const { edit, calls, exec, home } = await harness(t);
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));

  const handoff = await edit.execute({ prompt: '改成夜景', images: [reference] }, exec);
  assert.equal(calls.length, 0);
  assert.equal(handoff.needsSettings, true);
  assert.equal(handoff.settings.model, 'flux-2-klein-4b.safetensors');

  await edit.execute({ prompt: '改成夜景', images: [reference] }, exec);
  assert.equal(calls.length, 1);
});

test('switching the model after reading hands over the new config', async (t) => {
  const { settings, generate, exec, home } = await harness(t);
  await settings.execute({}, exec);

  // 用户在选择器里换了模型：上一次读到的配置已经不作数。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = config();
  next.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');

  const handoff = await generate.execute({ prompt: 'a classroom' }, exec);
  assert.equal(handoff.needsSettings, true);
  assert.equal(handoff.settings.model, 'moss_image_sft_int8_convrot.safetensors', 'the handoff carries the new model');

  await generate.execute({ prompt: 'a classroom' }, exec);
});

test('reading again while nothing changed answers with the unchanged marker only', async (t) => {
  const { settings, exec } = await harness(t);
  const first = await settings.execute({}, exec);
  assert.equal(first.model, 'flux-2-klein-4b.safetensors');

  const again = await settings.execute({}, exec);
  assert.deepEqual(Object.keys(again).sort(), ['hint', 'unchanged'], 'the unchanged read carries no payload again');
  assert.equal(again.unchanged, true);
  assert.match(again.hint, /一致|没变/, 'and says why it is empty');
});

test('a later generation reuses the read instead of asking for another', async (t) => {
  const { settings, generate, exec, calls } = await harness(t);
  await settings.execute({}, exec);
  await generate.execute({ prompt: 'a city at dusk' }, exec);
  // 下一轮对话：配置没变，就不要再拦一次。
  await generate.execute({ prompt: 'a forest at dawn' }, exec);
  assert.equal(calls.length, 2);
});

test('a config change reverted before the next step still counts as unchanged', async (t) => {
  const { settings, generate, exec, home, calls } = await harness(t);
  await settings.execute({}, exec);

  const changed = config();
  changed.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(changed, null, 2), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(config(), null, 2), 'utf8');

  // 中间没有对话：改回原值等于没变，这次生图不该被拦。
  await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(calls.length, 1);
});

test('a read made after a config change returns the new payload', async (t) => {
  const { settings, exec, home } = await harness(t);
  await settings.execute({}, exec);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = config();
  next.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');

  const result = await settings.execute({}, exec);
  assert.equal(result.model, 'moss_image_sft_int8_convrot.safetensors');
  assert.equal(result.unchanged, undefined, 'a changed config is reported in full');
});

test('refresh brings the full payload back when the conversation lost it', async (t) => {
  const { settings, exec } = await harness(t);
  await settings.execute({}, exec);

  const again = await settings.execute({ refresh: true }, exec);
  assert.equal(again.unchanged, undefined, 'an explicit refresh skips the unchanged marker');
  assert.equal(again.model, 'flux-2-klein-4b.safetensors');
  assert.match(again.hint, /30–80 词/, 'the full writing hint comes back');
});

test('a handoff in one session does not unlock another session', async (t) => {
  const { generate, exec, calls } = await harness(t);

  const handoff = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(handoff.needsSettings, true);

  const other = { signal: new AbortController().signal, agent: { session: {} } };
  const otherHandoff = await generate.execute({ prompt: 'a harbor' }, other);
  assert.equal(otherHandoff.needsSettings, true, 'the config handed to one session is not visible to another');
  assert.equal(calls.length, 0);

  await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(calls.length, 1, 'the session that got the handoff can generate');
});

test('a failed request keeps the settings read valid', async (t) => {
  const { settings, generate, calls, exec } = await harness(t);
  await settings.execute({}, exec);

  // 网络挂一次：请求失败，但已经读到过的配置不该被作废。
  const healthy = globalThis.fetch;
  let down = true;
  globalThis.fetch = async (...args) => {
    if (down) { down = false; throw new Error('network down'); }
    return healthy(...args);
  };
  t.after(() => { globalThis.fetch = healthy; });

  await assert.rejects(generate.execute({ prompt: 'a harbor' }, exec));
  const retry = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(retry.needsSettings, undefined, 'a failed request must not consume the read');
  assert.equal(calls.length, 1);
});

test('a config change between the handoff and the retry hands over again', async (t) => {
  const { generate, exec, home, calls } = await harness(t);

  const first = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(first.settings.model, 'flux-2-klein-4b.safetensors');

  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = config();
  next.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');

  const second = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(second.needsSettings, true, 'the config moved again before the retry');
  assert.equal(second.settings.model, 'moss_image_sft_int8_convrot.safetensors');

  await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(calls.length, 1);
});

test('the handoff explains a missing model instead of failing', async (t) => {
  const cfg = config();
  cfg.active = { providerId: '', model: '' };
  const { generate, exec, calls } = await harness(t, cfg);

  const handoff = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(handoff.needsSettings, true);
  assert.match(handoff.settings.hint, /还没有选择生图模型/);
  assert.match(handoff.note, /让用户先在设置/, 'the model is told to ask the user, not to retry the tool');
  assert.equal(calls.length, 0);
});

test('a missing model hands over even after the settings were read', async (t) => {
  const cfg = config();
  cfg.active = { providerId: '', model: '' };
  const { settings, generate, exec, calls } = await harness(t, cfg);

  // 读过一次配置（里面就写着没有选模型），再调用生图也必须是交接，而不是撞进 generate() 的报错。
  await settings.execute({}, exec);
  const handoff = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(handoff.needsSettings, true);
  assert.match(handoff.note, /还没有选择生图模型/);
  assert.equal(calls.length, 0);
});

test('editing a model that cannot edit reports the capability error, not a handoff', async (t) => {
  const cfg = config();
  // 协议写明：不能图生图是这条协议 + 这个模型的事，跟「猜哪条协议」无关。
  cfg.providers[0].adapter = 'dashscope-wanx';
  cfg.providers[0].models = ['wanx2.1-t2i-turbo'];
  cfg.active = { providerId: 'p1', model: 'wanx2.1-t2i-turbo' };
  const { edit, exec, calls, home } = await harness(t, cfg);
  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));

  // 交接会把“重写提示词再调用”塞给模型，但重试还是同一个能力错误：直接报错更诚实。
  await assert.rejects(
    edit.execute({ prompt: '改成夜景', images: [reference] }, exec),
    /该模型不支持图生图/
  );
  assert.equal(calls.length, 0, 'no request is attempted for a model that cannot edit');
});

test('the handoff carries the Auto model lists', async (t) => {
  const cfg = config();
  cfg.active = { providerId: 'p1', model: 'auto' };
  const { generate, exec } = await harness(t, cfg);

  const handoff = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.deepEqual(handoff.settings.models, ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors']);
  assert.deepEqual(handoff.settings.editModels, ['flux-2-klein-4b.safetensors', 'moss_image_sft_int8_convrot.safetensors']);
});

test('a config change while a request is in flight invalidates the next call', async (t) => {
  const { settings, generate, exec, home, calls } = await harness(t);
  await settings.execute({}, exec);

  const healthy = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await healthy(...args);
    // 图片已经在路上时，用户改了模型：这次请求用旧配置完成，下一次必须重读。
    const next = config();
    next.active = { providerId: 'p1', model: 'moss_image_sft_int8_convrot.safetensors' };
    writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');
    return response;
  };
  t.after(() => { globalThis.fetch = healthy; });

  await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(calls.length, 1);

  const handoff = await generate.execute({ prompt: 'a harbor' }, exec);
  assert.equal(handoff.needsSettings, true, 'the in-flight change is noticed on the next call');
  assert.equal(handoff.settings.model, 'moss_image_sft_int8_convrot.safetensors');
});

test('configuration handed off once per step blocks sibling generation and editing', async (t) => {
  const { settings, generate, edit, exec, home, calls } = await harness(t);
  await settings.execute({}, exec);
  const next = config();
  next.defaults.promptOptimization = false;
  writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');

  const reference = path.join(home, 'reference.png');
  writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
  const toolSet = {};
  const results = await Promise.all([
    generate.execute({ prompt: '一座港口' }, { ...exec, toolSet, callId: 'stale-generate' }),
    edit.execute({ prompt: '改成夜景', images: [reference] }, { ...exec, toolSet, callId: 'stale-edit' })
  ]);
  assert.ok(results.every((result) => result.needsSettings && result.path === ''));
  const handedOff = results.filter((result) => result.settings);
  assert.equal(handedOff.length, 1);
  assert.equal(handedOff[0].settings.promptOptimization, false);
  assert.match(handedOff[0].note, /沿用用户原话/);
  assert.equal(calls.length, 0);
  assert.equal((await settings.execute({}, exec)).unchanged, true);

  await generate.execute({ prompt: '一座港口' }, { ...exec, toolSet: {}, callId: 'fresh-generate' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).prompt, '一座港口');
});

test('image tools do not use settings read by a sibling call in the same step', async (t) => {
  const { settings, generate, exec, calls } = await harness(t);
  const step = { ...exec, toolSet: {} };
  const snapshot = await settings.execute({}, step);
  assert.equal(snapshot.model, 'flux-2-klein-4b.safetensors');
  const wait = await generate.execute({ prompt: 'a harbor' }, step);
  assert.equal(wait.needsSettings, true);
  assert.equal(wait.settings, undefined);
  assert.equal(calls.length, 0);
  await generate.execute({ prompt: 'a harbor' }, { ...exec, toolSet: {} });
  assert.equal(calls.length, 1);
});

for (const kind of ['generate', 'edit']) {
  test(`${kind} replays a handoff without submitting and forwards the prepared prompt on a new call`, async (t) => {
    const harnessResult = await harness(t);
    const { settings, exec, home, calls } = harnessResult;
    const tool = harnessResult[kind];
    const prompt = 'A lighthouse at dusk with a sign reading "Måke".';
    const args = { prompt };
    if (kind === 'edit') {
      const reference = path.join(home, 'reference.png');
      writeFileSync(reference, Buffer.from(PNG_1PX, 'base64'));
      args.images = [reference];
    }
    const first = { ...exec, callId: 'read' };
    const handoff = await tool.execute(args, first);
    assert.equal(handoff.settings.promptOptimization, true);
    assert.match(handoff.note, /沿用上下文里仍适用的写法和成稿/);
    assert.deepEqual(await tool.execute(args, first), handoff);
    await assert.rejects(tool.execute({ ...args, prompt: 'different' }, first), { code: 'call_conflict' });
    assert.equal((await settings.execute({}, exec)).unchanged, true);
    assert.equal(calls.length, 0);

    const actual = { ...exec, callId: 'submit' };
    const image = await tool.execute(args, actual);
    assert.ok(image.path);
    assert.deepEqual(await tool.execute(args, actual), image);
    assert.equal(calls.length, 1);
    const body = calls[0].init.body;
    assert.equal(typeof body === 'string' ? JSON.parse(body).prompt : body.get('prompt'), prompt);

    const next = config();
    next.active.model = next.providers[0].models[1];
    writeFileSync(path.join(home, 'mo-image', 'config.json'), JSON.stringify(next, null, 2), 'utf8');
    await assert.rejects(tool.execute(args, actual), { code: 'call_conflict' });
    assert.equal(calls.length, 1);
    const changed = await tool.execute(args, { ...exec, callId: 'changed' });
    assert.equal(changed.settings.model, next.active.model);
    assert.equal(calls.length, 1);
  });
}

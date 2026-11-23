import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('apply registers tools, the prompt section and runtime skills', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-apply-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1', key: 'k',
      protocol: 'openai-images', adapter: '',
      models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  }), 'utf8');
  process.env.DSH_HOME = home;

  const tools = [];
  const sections = [];
  const skills = [];
  const routes = [];
  const provided = new Map();
  const fake = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject(_deps, callback) { callback(fake); },
    tools: { register(def) { tools.push(def); return () => {}; } },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
      getOrigin() { return ''; }
    },
    systemPrompt: { section(def) { sections.push(def); return () => {}; } },
    skills: { register(def) { skills.push(def); return () => {}; } },
    provide(name, value) { provided.set(name, value); return () => {}; },
    get(name) { return provided.get(name); }
  };

  const mod = await import('../lib/index.js?apply-test');
  mod.apply(fake, { update: { skipCheck: true } });

  const service = provided.get('moImageStatus');
  assert.ok(service, 'other plugins read the status through ctx.get("moImageStatus")');
  assert.equal(service.contract, 1);
  const status = await service.describe();
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(status.version, pkg.version);
  assert.equal(status.provider.id, 'p1');
  assert.equal(status.configured, true);
  assert.equal(status.key.source, 'config');
  assert.equal(status.capabilities.maxRefs, 16);

  assert.equal(tools.length, 3);
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');
  const settings = tools.find((tool) => tool.name === 'mo_image_settings');
  assert.ok(generate);
  assert.ok(edit);
  assert.ok(settings, 'the model needs a tool that reads the current settings');
  assert.match(settings.description, /配置状态/, 'the description ties the read to the per-session marker');
  assert.match(settings.description, /let the image tool return updates via needsSettings/);
  assert.match(settings.description, /Apply changes to baseRevision, delete keys in removed/);
  assert.match(settings.description, /unchanged/, 'the description says an unchanged read answers briefly');
  assert.match(generate.description, /needsSettings/, 'the description says an outdated read gets a config handoff instead of an image');
  assert.ok(generate.parameters.properties.negative_prompt);
  assert.match(generate.parameters.properties.quality.description, /qualityMode is "auto"/);
  assert.ok(generate.parameters.properties.size, 'the model may ask for a shape while size is Auto');
  assert.match(String(generate.parameters.properties.size.description), /auto/i);
  assert.equal(generate.parameters.properties.provider.type, 'string');
  assert.match(String(generate.parameters.properties.provider.description), /validated/);
  assert.match(String(generate.parameters.properties.model.description), /Auto/);
  // 模型由选择器决定，工具参数只是可选的一致性核对：让模型复述环境状态，
  // 用户中途切换模型时它就会复读历史里的旧 id，每次都白失败一轮。
  assert.ok(!(generate.parameters.required || []).includes('model'), 'model must be optional');
  assert.ok(!(edit.parameters.required || []).includes('model'), 'model must be optional for edits too');
  assert.ok(edit.parameters.properties.negative_prompt);
  assert.match(edit.parameters.properties.quality.description, /qualityMode is "auto"/);
  assert.ok(edit.parameters.properties.size, 'edits can pick a shape too');
  assert.match(generate.description, /Fixed selections take precedence/);
  assert.match(generate.description, /Size Auto/);
  assert.match(generate.description, /dialect/);
  assert.doesNotMatch(generate.description, /only when optimization is On/);
  assert.match(generate.description, /mo-image-generation skill/);
  assert.match(edit.description, /图1\/图2/);
  assert.match(edit.description, /Off: use the user/);
  assert.equal(edit.output.schema.properties.model.type, 'string', 'edit reports the model it actually used');
  assert.equal(edit.output.schema.properties.needsSettings.type, 'boolean', 'an outdated read returns the config handoff');
  assert.equal(edit.output.schema.properties.settings.type, 'object', 'the handoff carries the settings payload');
  const handoffBlocks = generate.output.render({}, {
    path: '', needsSettings: true, settings: { model: 'x' }, note: '配置改过了，这次没有生成。'
  });
  assert.equal(handoffBlocks.length, 1);
  assert.doesNotMatch(handoffBlocks[0].text, /!\[/, 'a handoff has no image to render');
  const handoff = JSON.parse(handoffBlocks[0].text);
  assert.equal(handoff.needsSettings, true, 'the whole handoff is JSON, not a bare sentence');
  assert.equal(handoff.settings.model, 'x', 'the model sees the settings in the result it reads');
  assert.match(handoff.note, /没有生成/);
  assert.equal(settings.output.schema.properties.editModels.type, 'array', 'Auto mode reports edit-capable models');

  const section = sections.find((item) => item.name === 'mo-image:prompt-recipe');
  assert.ok(section);
  const text = section.text();
  assert.match(text, /gpt-image-2\.5-flare/);
  assert.doesNotMatch(text, /gpt-image-2\.5-sunburst/, 'strict mode must not advertise a different edit model');
  assert.match(text, /生成公式/);
  assert.match(text, /无 negative prompt/);

  assert.equal(skills.length, 2);
  const generationSkill = skills.find((item) => item.name === 'mo-image-generation');
  const editingSkill = skills.find((item) => item.name === 'mo-image-editing');
  assert.ok(generationSkill);
  assert.ok(editingSkill);
  assert.match(generationSkill.content, /主体 \+ 动作 \+ 环境/);
  assert.match(editingSkill.content, /五类高权重约束词/);
  for (const word of ['保持', '修改', '添加', '删除', '替换']) {
    assert.ok(editingSkill.content.includes(word));
  }
  assert.match(generationSkill.description, /提示词/);
  assert.equal(routes.length, 8);
  assert.ok(routes.some((route) => route.path === '/api/mo-image/comfy/analyze'),
    'the settings page needs the analyze route to confirm a workflow mapping');
  assert.ok(routes.some((route) => route.path === '/api/mo-image/comfy/params'),
    'the settings page needs the params route to list literal inputs as parameter candidates');
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/api/mo-image/comfy/analyze', '/api/mo-image/comfy/params', '/api/mo-image/config', '/api/mo-image/detect-model-rule', '/api/mo-image/detect-protocol', '/api/mo-image/models', '/api/mo-image/preview', '/api/mo-image/update']);

  await t.test('all HTTP routes require DSH admission before entering their handlers', async () => {
    const rejected = {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      get url() { assert.fail('rejected requests must not resolve preview paths'); },
      [Symbol.asyncIterator]() { assert.fail('rejected requests must not read the body'); }
    };
    const enter = async (route, request, peer) => {
      const response = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { this.body = JSON.parse(body); }
      };
      await route.handler(request, response, peer);
      return response;
    };
    const configRoute = routes.find((route) => route.path === '/api/mo-image/config');
    for (const route of routes) {
      assert.equal(route.auth, 'required', route.path);
      assert.equal((await enter(route, rejected)).status, 503, route.path);
    }
    for (const status of [401, 403]) {
      provided.set('connection', {
        requestRejection(req) {
          assert.equal(req, rejected);
          return status;
        }
      });
      for (const route of routes) {
        const response = await enter(route, rejected);
        assert.equal(response.status, status, route.path);
        assert.equal(response.headers['Cache-Control'], 'no-store');
        assert.equal(response.body.ok, false);
      }
    }
    provided.set('connection', { requestRejection() { throw new Error('service offline'); } });
    assert.equal((await enter(configRoute, rejected)).status, 503);

    // 0.2.3 already authenticates the request before the handler and supplies its live Peer.
    provided.delete('connection');
    const owner = { principal: { kind: 'owner' }, signal: new AbortController().signal };
    const guest = { ...owner, principal: { kind: 'guest' } };
    assert.equal((await enter(configRoute, rejected, guest)).status, 403);
    assert.equal((await enter(configRoute, rejected, { ...owner, signal: AbortSignal.abort() })).status, 401);
    const response = await enter(configRoute, { method: 'GET', headers: { host: 'localhost' } }, owner);
    assert.equal(response.status, 200);
    assert.equal(response.body.config.providers[0].key, undefined);
  });
});

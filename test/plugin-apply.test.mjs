import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
    get() { return undefined; }
  };

  const mod = await import('../lib/index.js?apply-test');
  mod.apply(fake, { update: { skipCheck: true } });

  assert.equal(tools.length, 3);
  const generate = tools.find((tool) => tool.name === 'mo_image_generate');
  const edit = tools.find((tool) => tool.name === 'mo_image_edit');
  const settings = tools.find((tool) => tool.name === 'mo_image_settings');
  assert.ok(generate);
  assert.ok(edit);
  assert.ok(settings, 'the model needs a tool that reads the current settings');
  assert.match(settings.description, /before every generation/i, 'the description says when to call it');
  assert.match(settings.description, /rejected/i, 'the description says generation is gated on it');
  assert.ok(generate.parameters.properties.negative_prompt);
  assert.equal(generate.parameters.properties.quality, undefined);
  assert.equal(generate.parameters.properties.size, undefined);
  assert.equal(generate.parameters.properties.provider.type, 'string');
  assert.match(String(generate.parameters.properties.provider.description), /validated/);
  assert.match(String(generate.parameters.properties.model.description), /Auto/);
  // 模型由选择器决定，工具参数只是可选的一致性核对：让模型复述环境状态，
  // 用户中途切换模型时它就会复读历史里的旧 id，每次都白失败一轮。
  assert.ok(!(generate.parameters.required || []).includes('model'), 'model must be optional');
  assert.ok(!(edit.parameters.required || []).includes('model'), 'model must be optional for edits too');
  assert.ok(edit.parameters.properties.negative_prompt);
  assert.equal(edit.parameters.properties.quality, undefined);
  assert.match(generate.description, /Model, size, and quality come from the picker/);
  assert.match(generate.description, /dialect/);
  assert.doesNotMatch(generate.description, /only when optimization is On/);
  assert.match(generate.description, /mo-image-generation skill/);
  assert.match(edit.description, /图1\/图2/);
  assert.match(edit.description, /optimization is Off/);

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
  assert.equal(routes.length, 5);
  assert.ok(routes.some((route) => route.path === '/api/mo-image/comfy/analyze'),
    'the settings page needs the analyze route to confirm a workflow mapping');
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/api/mo-image/comfy/analyze', '/api/mo-image/config', '/api/mo-image/models', '/api/mo-image/preview', '/api/mo-image/update']);
});

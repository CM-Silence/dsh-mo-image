import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('prompt optimization off reaches the system prompt section', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-prompt-off-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'p1', name: 'Test', baseUrl: 'https://api.test/v1',
      apiKeyEnv: 'MO_IMAGE_P1_API_KEY', protocol: 'openai-images', adapter: '',
      models: ['gpt-image-2.5-flare'], names: {}
    }],
    active: { providerId: 'p1', model: 'gpt-image-2.5-flare' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024, promptOptimization: false }
  }, null, 2), 'utf8');

  process.env.DSH_HOME = home;
  const sections = [];
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register() { return () => {}; } },
    webServer: { register() { return () => {}; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    systemPrompt: { section(def) { sections.push(def); return () => {}; } },
    skills: { register() { return () => {}; } },
    get() { return undefined; }
  };
  const mod = await import('../lib/index.js?prompt-off-flow-test');
  mod.apply(fake);
  const section = sections.find((item) => item.name === 'mo-image:prompt-recipe');
  assert.ok(section);
  const text = section.text();
  assert.match(text, /提示词优化：Off/);
  assert.match(text, /用户原话/);
  assert.match(text, /尺寸、质量、提供商、模型由用户选择器控制/);
  assert.doesNotMatch(text, /生成公式/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeImageState, createConfigStore, normalizeConfig, normalizeDefaults, resolveSizeRequest
} from '../lib/config-store.js';

/* E：配置域拆出后的公开契约。 */

test('normalizeDefaults keeps quality, strict and prompt optimization rules', () => {
  const defaults = normalizeDefaults({ quality: 'xhigh', strict: 'yes', promptOptimization: false, width: 1024, height: 1536 });
  assert.equal(defaults.quality, 'xhigh');
  assert.equal(defaults.strict, true);
  assert.equal(defaults.promptOptimization, false);
  assert.equal(defaults.width, 1024);
  assert.equal(defaults.height, 1536);
});

test('normalizeConfig keeps the active model and drops unknown provider fields', () => {
  const config = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'P', baseUrl: 'https://api.test/v1/', apiKeyEnv: 'KEY',
      optionalKey: true, protocol: 'openai-images', adapter: '', models: ['m', 'm', 'n'],
      names: { m: 'Model M' }, unknown: 'drop me'
    }],
    active: { providerId: 'p1', model: 'm' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  assert.equal(config.providers.length, 1);
  assert.equal(config.providers[0].baseUrl, 'https://api.test/v1');
  assert.deepEqual(config.providers[0].models, ['m', 'n']);
  assert.equal(config.providers[0].unknown, undefined);
  assert.equal(config.active.model, 'm');
});

test('resolveSizeRequest keeps the fixed-size contract', () => {
  // 形态来自模型规则（认不出的模型走 OpenAI 兼容兜底：宽高输入框）。
  const out = resolveSizeRequest({ baseUrl: 'https://gateway.example/v1' }, 'm', { auto: false, width: 768, height: 1024 }, {});
  assert.equal(out.control, 'wh');
  assert.equal(out.arg, '768x1024');
});

test('activeImageState uses the passed snapshot instead of reading the file', () => {
  const store = createConfigStore({
    configFile: 'definitely-does-not-exist.json',
    ensureDirs() {},
    logHost() {},
    credentialsAccessor() { return undefined; }
  });
  const snapshot = normalizeConfig({
    version: 1,
    providers: [{
      id: 'p1', name: 'P', baseUrl: 'https://api.test/v1', apiKeyEnv: 'KEY',
      optionalKey: true, protocol: 'openai-images', adapter: '', models: ['m'], names: {}
    }],
    active: { providerId: 'p1', model: 'm' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });

  const state = activeImageState(store, snapshot);
  assert.equal(state.model, 'm');
  assert.equal(state.provider.id, 'p1');
  assert.equal(state.sizeMode, 'auto');
});

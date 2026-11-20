import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fitSize, prepareGenerate, resolveAdapter } from '../lib/adapters.js';

import {
  activeImageState, capabilityManifest, createConfigStore, normalizeConfig, normalizeDefaults, readConfig, resolveSizeRequest,
  saveConfigWithCredentials
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

test('official OpenRouter migrates the old FLUX.2 ID and preserves model settings', () => {
  const old = 'black-forest-labs/flux-2-pro';
  const current = 'black-forest-labs/flux.2-pro';
  const provider = {
    id: 'p1', name: 'OpenRouter', adapter: 'openrouter-images',
    baseUrl: 'https://openrouter.ai/api/v1', models: [old, current],
    names: { [old]: 'FLUX.2 Pro' },
    modelOptions: { [old]: { size: { mode: 'aspect' } }, [current]: { locked: { size: true } } }
  };
  const active = { providerId: 'p1', model: old };
  const config = normalizeConfig({ providers: [provider], active });
  assert.deepEqual(config.providers[0].models, [current]);
  assert.equal(config.active.model, current);
  assert.equal(config.providers[0].names[current], 'FLUX.2 Pro');
  assert.equal(config.providers[0].modelOptions[current].size.mode, 'aspect');
  assert.equal(config.providers[0].modelOptions[current].locked.size, true);
  assert.deepEqual(normalizeConfig(config), config);

  const gateway = normalizeConfig({ providers: [{ ...provider, baseUrl: 'https://gateway.test/v1' }], active });
  assert.equal(gateway.active.model, old);
  assert.deepEqual(gateway.providers[0].models, [old, current]);
});

test('a tool aspect in Size Auto is kept for the wire without inventing a strict pixel target', () => {
  const model = 'gemini-3.1-flash-image';
  const provider = { adapter: 'google-gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' };
  const adapter = resolveAdapter(provider, model);
  const plan = resolveSizeRequest(provider, model, { auto: true }, { size: '3:4' }, adapter);
  assert.equal(plan.aspect, '3:4');
  assert.equal(plan.nominal, null);
  const [width, height] = plan.arg.split('x').map(Number);
  assert.ok(width > 0 && height > width, 'the derived wire dimensions retain portrait orientation');
});

test('OpenAI Images drops the legacy locked Gemini input pair and preserves manual mappings', () => {
  const model = 'relay/gemini-3.1-flash-image:latest';
  const fields = {
    prompt: { path: 'contents[0].parts[]', wrap: 'text' },
    negative: { appendToPrompt: '\n\nAvoid: ' },
    image: null
  };
  const locked = { prompt: true, size: true, quality: true, negative: true, model: true, n: true, image: true };
  const providerFor = (adapter, entry, id = model) => normalizeConfig({
    providers: [{
      id: 'gateway', baseUrl: 'https://images.example.test/v1', adapter, presetId: '',
      models: [id], modelOptions: { [id]: entry }
    }]
  }).providers[0];
  const nativeSize = {
    mode: 'aspect', field: 'generationConfig.imageConfig.aspectRatio',
    second: { from: 'tier', field: 'generationConfig.imageConfig.imageSize' }
  };
  const prompt = 'Draw a lighthouse';
  const wire = (provider, id = model) => {
    const adapter = resolveAdapter(provider, id);
    const fitted = fitSize(provider, '1024x1536', id, adapter);
    return JSON.parse(prepareGenerate(adapter, provider, { model: id, prompt, fitted }).body);
  };
  for (const size of [nativeSize, { mode: 'aspect', field: 'aspect_ratio' }]) {
    const saved = { size, fields, locked, quality: { supported: false } };
    const provider = providerFor('openai-images', saved);
    const body = wire(provider);
    assert.equal(body.prompt, prompt);
    assert.equal(body.size, '1024x1536');
    assert.equal(body.contents, undefined);
    assert.equal(body.generationConfig, undefined);
    assert.equal(body.aspect_ratio, undefined);
    const options = provider.modelOptions[model];
    assert.equal(options.locked.prompt, undefined);
    assert.equal(options.locked.size, undefined);
    assert.equal(options.locked.image, true);
    assert.equal(options.fields.image, null);
    assert.deepEqual(options.quality, { supported: false });
    assert.equal(saved.fields.prompt.path, 'contents[0].parts[]');
    assert.deepEqual(providerFor('google-gemini', saved).modelOptions[model].size, size);
  }
  const older = 'relay/gemini-2.5-flash-image:latest';
  assert.equal(wire(providerFor('openai-images', { fields, locked }, older), older).prompt, prompt);
  const manual = providerFor('openai-images', {
    size: { mode: 'aspect', field: 'aspect_ratio' },
    fields: { prompt: { path: 'request.user_prompt' } },
    locked
  });
  const body = wire(manual);
  assert.equal(body.request.user_prompt, prompt);
  assert.equal(body.aspect_ratio, '2:3');
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

test('reference image capability follows provider and model edit mappings', () => {
  const config = normalizeConfig({ providers: [{
    id: 'custom', adapter: 'custom', baseUrl: 'https://gateway.example/v1', models: ['default', 'override'],
    operations: {
      edit: { path: 'retouch', input: 'explicit', transport: 'multipart', fields: { image: { multipart: 'reference_image' } } }
    },
    modelOptions: {
      default: { fields: { image: null } },
      override: { operations: { edit: { fields: { image: { multipart: 'source_image' } } } } }
    }
  }] });
  assert.deepEqual(capabilityManifest(config)[0].models.map(({ image }) => image), [
    { multipart: 'reference_image' }, { multipart: 'source_image' }
  ]);
});

test('migration and save do not reassign another provider’s existing credential reference', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mo-image-reserved-keys-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const provider = (id, properties = {}) => ({
    id, name: id, baseUrl: 'https://' + id + '.example/v1', adapter: 'openai-images', models: ['m'], ...properties
  });
  const secrets = new Map([
    ['MO_IMAGE_LEGACY_API_KEY', 'existing-key'],
    ['MO_IMAGE_DRAFT_API_KEY', 'other-key']
  ]);
  const credentials = {
    async describe(ref) { return { configured: secrets.has(ref), source: 'file' }; },
    async resolve(ref) { return { value: secrets.get(ref) }; },
    async set(ref, key) { secrets.set(ref, key); },
    async unset(ref) { secrets.delete(ref); }
  };
  const store = createConfigStore({ configFile, ensureDirs() {}, logHost() {}, credentialsAccessor: () => credentials });
  await writeFile(configFile, JSON.stringify({ providers: [
    provider('legacy', { key: 'legacy-key' }),
    provider('existing', { apiKeyEnv: 'MO_IMAGE_LEGACY_API_KEY' }),
    provider('other', { apiKeyEnv: 'MO_IMAGE_DRAFT_API_KEY' })
  ] }));

  const migrated = await readConfig(store);
  assert.deepEqual(migrated.providers.map((entry) => [entry.apiKeyEnv, secrets.get(entry.apiKeyEnv)]), [
    ['MO_IMAGE_LEGACY_2_API_KEY', 'legacy-key'],
    ['MO_IMAGE_LEGACY_API_KEY', 'existing-key'],
    ['MO_IMAGE_DRAFT_API_KEY', 'other-key']
  ]);
  const saved = await saveConfigWithCredentials(store, {
    ...migrated,
    providers: [provider('draft', { key: 'draft-key' }), ...migrated.providers]
  });
  assert.deepEqual(saved.providers.map((entry) => [entry.apiKeyEnv, secrets.get(entry.apiKeyEnv)]), [
    ['MO_IMAGE_DRAFT_2_API_KEY', 'draft-key'],
    ['MO_IMAGE_LEGACY_2_API_KEY', 'legacy-key'],
    ['MO_IMAGE_LEGACY_API_KEY', 'existing-key'],
    ['MO_IMAGE_DRAFT_API_KEY', 'other-key']
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDefaults, capabilityManifest } from '../lib/index.js';
import { buildImageStatus } from '../lib/status.js';

/* 选择器要的三样东西：默认值、每个模型的尺寸能力、给外部插件的状态快照。 */

test('defaults gain aspect, tier, preset and strict with back-compatible values', () => {
  const d = normalizeDefaults({ width: 1024, height: 1536 });
  assert.equal(d.aspect, '2:3');
  assert.equal(d.strict, false);
  assert.equal(d.preset, '1024x1536');
  assert.ok(d.tier === '' || typeof d.tier === 'string');
});

test('strict defaults to false and survives a truthy value', () => {
  assert.equal(normalizeDefaults({}).strict, false);
  assert.equal(normalizeDefaults({ strict: true }).strict, true);
  assert.equal(normalizeDefaults({ strict: 'yes' }).strict, true);
});

test('the capability manifest carries the size spec per model', () => {
  const manifest = capabilityManifest({
    providers: [{
      id: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: '',
      models: ['seedream-5.5', 'seedream-5.0-lite']
    }]
  });
  const models = manifest[0].models;
  const pro = models.find((item) => item.model === 'seedream-5.5').size;
  assert.equal(pro.control, 'preset');
  assert.deepEqual(pro.tiers.map((tier) => tier.value), ['1K', '1.5K', '2K']);
  const lite = models.find((item) => item.model === 'seedream-5.0-lite').size;
  assert.deepEqual(lite.tiers.map((tier) => tier.value), ['2K', '3K', '4K']);
});

test('the manifest exposes a prompt-only adapter as a plain wh control', () => {
  const manifest = capabilityManifest({
    providers: [{ id: 'gw', baseUrl: 'http://127.0.0.1:3000/v1', adapter: 'openai-chat', models: ['m'] }]
  });
  const size = manifest[0].models[0].size;
  assert.equal(size.control, 'prompt');
  assert.equal(size.stitch, true);
});

test('status capabilities.size reports mode, strict and control', () => {
  const config = {
    providers: [{ id: 'ark', name: 'Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: '', models: ['seedream-5.5'] }],
    active: { providerId: 'ark', model: 'seedream-5.5' },
    defaults: { auto: false, width: 1024, height: 1024, strict: true, preset: '2K' }
  };
  const status = buildImageStatus({ config: config, key: { ok: true, source: 'config' } });
  assert.equal(status.capabilities.size.mode, 'fixed');
  assert.equal(status.capabilities.size.strict, true);
  assert.equal(status.capabilities.size.control, 'preset');
  assert.equal(status.capabilities.size.preset, '2K');
});

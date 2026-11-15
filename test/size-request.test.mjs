import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSizeRequest } from '../lib/index.js';

/* 尺寸请求：控件的形态决定用户的选择怎么变成一次具体的请求。 */

const whAdapter = { size: { control: 'wh', style: 'string', field: 'size' } };

const aspectAdapter = {
  size: {
    control: 'aspect', style: 'aspect', field: 'aspect_ratio', aspects: ['1:1', '16:9'],
    tiers: [{ value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }]
  }
};

const presetAdapter = {
  size: { control: 'preset', custom: true, style: 'string', field: 'size', tiers: [{ value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }] }
};

const ark55 = {
  size: { control: 'preset', custom: true, style: 'string', field: 'size',
    tiers: [{ value: '1K', pixels: 1048576 }, { value: '1.5K', pixels: 2359296 }, { value: '2K', pixels: 4194304 }] }
};

test('fixed wh control turns the picker into WxH', () => {
  const out = resolveSizeRequest(whAdapter, 'm', { auto: false, width: 768, height: 1024 }, {});
  assert.equal(out.arg, '768x1024');
  assert.deepEqual(out.nominal, { width: 768, height: 1024 });
  assert.equal(out.control, 'wh');
});

test('fixed aspect control synthesises pixels from the tier', () => {
  const out = resolveSizeRequest(aspectAdapter, 'm', { auto: false, aspect: '16:9', tier: '1K' }, {});
  assert.equal(out.arg, '1368x768');
  assert.deepEqual(out.nominal, { width: 1368, height: 768 });
  assert.equal(out.aspect, '16:9');
  assert.equal(out.tier, '1K');
});

test('a preset label is sent as a label', () => {
  const out = resolveSizeRequest(presetAdapter, 'm', { auto: false, preset: '2K' }, {});
  assert.equal(out.arg, '2K');
  assert.equal(out.tier, '2K');
});

test('a preset control also accepts a custom WxH', () => {
  const out = resolveSizeRequest(presetAdapter, 'm', { auto: false, preset: '1328x1328' }, {});
  assert.equal(out.arg, '1328x1328');
  assert.deepEqual(out.nominal, { width: 1328, height: 1328 });
});

test('auto size with a model-supplied WxH is honoured', () => {
  const out = resolveSizeRequest(whAdapter, 'm', { auto: true }, { size: '1024x1536' });
  assert.equal(out.arg, '1024x1536');
  assert.deepEqual(out.nominal, { width: 1024, height: 1536 });
});

test('auto size with no request sends no size', () => {
  assert.equal(resolveSizeRequest(whAdapter, 'm', { auto: true }, {}).arg, 'none');
});

test('a fixed size ignores a size the model tried to pass', () => {
  const out = resolveSizeRequest(whAdapter, 'm', { auto: false, width: 768, height: 1024 }, { size: '2048x2048' });
  assert.equal(out.arg, '768x1024');
  assert.match(out.note, /已忽略 size/);
});

test('an illegal stored tier falls back to the nearest legal one and says so', () => {
  const out = resolveSizeRequest(ark55, 'seedream-5.5', { auto: false, preset: '4K', width: 2048, height: 2048 }, {});
  assert.equal(out.arg, '2K');
  assert.match(out.note, /4K/);
});

test('a prompt-only adapter still resolves a WxH for the strict target', () => {
  const promptAdapter = { size: { control: 'prompt', style: 'string', field: 'size', stitch: true } };
  const out = resolveSizeRequest(promptAdapter, 'm', { auto: false, width: 1024, height: 1024 }, {});
  assert.equal(out.arg, '1024x1024');
  assert.equal(out.stitch, true);
});

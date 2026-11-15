import test from 'node:test';
import assert from 'node:assert/strict';

import { fitSize, sizePolicyFor, parseTier, nearestTier, sizeForAspect } from '../lib/adapters.js';

/* 尺寸策略：能力按模型分档，档位名保留档位、像素另给。 */

const ark = {
  size: {
    control: 'preset', custom: true, field: 'size', style: 'string',
    tiers: [{ value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }]
  },
  sizeByModel: [
    { match: /5\.0-lite/, size: { tiers: [{ value: '2K', pixels: 4194304 }, { value: '3K', pixels: 9437184 }] } }
  ]
};

test('sizeByModel overrides the tier set for the matching model', () => {
  assert.deepEqual(sizePolicyFor(ark, 'seedream-5.0-lite').tiers.map((item) => item.value), ['2K', '3K']);
  assert.deepEqual(sizePolicyFor(ark, 'seedream-5.5').tiers.map((item) => item.value), ['1K', '2K']);
});

test('parseTier keeps the label and resolves pixels', () => {
  assert.deepEqual(parseTier(ark, '2K'), { value: '2K', pixels: 4194304 });
  assert.equal(parseTier(ark, '9K'), null);
  assert.deepEqual(parseTier(ark, '1024x1536'), { value: '1024x1536', pixels: 1572864, width: 1024, height: 1536 });
});

test('nearestTier picks by pixel budget, not by a fixed threshold', () => {
  const tiers = [{ value: '1K', pixels: 1048576 }, { value: '2K', pixels: 4194304 }];
  assert.equal(nearestTier(tiers, 1572864).value, '1K', '1.57MP is closer to 1K than to 4.19MP');
  assert.equal(nearestTier(tiers, 2359296).value, '2K', '2.36MP is closer to 2K');
});

test('sizeForAspect aligns both sides to 8', () => {
  assert.deepEqual(sizeForAspect('16:9', 1048576), { width: 1368, height: 768 });
  assert.deepEqual(sizeForAspect('1:1', 1048576), { width: 1024, height: 1024 });
});

test('allowCustom keeps an off-list WxH instead of snapping', () => {
  const loose = { size: { control: 'wh', allowed: ['1024x1024'], allowCustom: true, minPixels: 262144, maxPixels: 4194304 } };
  assert.equal(fitSize(loose, '1328x1328').size, '1328x1328');
  const strictList = { size: { control: 'preset', allowed: ['1024x1024', '2048x2048'], allowCustom: false } };
  assert.equal(fitSize(strictList, '1328x1328').adjusted, true, 'without allowCustom it still snaps');
});

test('a tier label survives fitSize as a label with pixels attached', () => {
  const out = fitSize(ark, { kind: 'preset', text: '2K' }, 'seedream-5.5');
  assert.equal(out.size, '2K');
  assert.equal(out.width, 2048);
  assert.equal(out.height, 2048);
});

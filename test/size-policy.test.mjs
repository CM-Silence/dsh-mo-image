import test from 'node:test';
import assert from 'node:assert/strict';

import { fitSize, sizePolicyFor, parseTier, nearestTier, sizeForAspect } from '../lib/adapters.js';

/* 尺寸策略：能力按模型分档，档位名保留档位、像素另给。 */

const ARK = { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' };
const SILICONFLOW = { baseUrl: 'https://api.siliconflow.cn/v1' };

// 原来这里放的是「基础策略 + sizeByModel 覆盖」的假适配器；分档现在由规则表给，
// 同一件事用真实模型（seedream 的版本分叉）来锁。
test('each seedream version gets its own tier set from the rule table', () => {
  assert.deepEqual(sizePolicyFor(ARK, 'seedream-5.0-lite').tiers.map((item) => item.value), ['2K', '3K', '4K']);
  assert.deepEqual(sizePolicyFor(ARK, 'seedream-5.5').tiers.map((item) => item.value), ['1K', '1.5K', '2K']);
});

test('parseTier keeps the label and resolves pixels', () => {
  assert.deepEqual(parseTier(ARK, '2K', 'seedream-5.5'), { value: '2K', pixels: 4194304 });
  assert.equal(parseTier(ARK, '9K', 'seedream-5.5'), null);
  assert.deepEqual(parseTier(ARK, '1024x1536', 'seedream-5.5'), { value: '1024x1536', pixels: 1572864, width: 1024, height: 1536 });
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
  // 硅基流动的非 qwen 表只有白名单 + allowCustom：表外的 WxH 原样保留。
  const loose = SILICONFLOW;
  assert.equal(fitSize(loose, '1328x1328', 'Kwai-Kolors/Kolors').size, '1328x1328');
  // dall-e-3 只有三个固定尺寸：白名单外必须吸附到最近的合法值。
  const strictList = {};
  assert.equal(fitSize(strictList, '1328x1328', 'dall-e-3').adjusted, true, 'without allowCustom it still snaps');
});

test('a tier label survives fitSize as a label with pixels attached', () => {
  const out = fitSize(ARK, { kind: 'preset', text: '2K' }, 'seedream-5.5');
  assert.equal(out.size, '2K');
  assert.equal(out.width, 2048);
  assert.equal(out.height, 2048);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter, sizeSpecFor, fitSize, prepareGenerate } from '../lib/adapters.js';
import { normalizeModelOptions } from '../lib/config-store.js';

/* 模型选项里那份「尺寸参数」覆盖：用户手填的形态/参数名/分隔符要压过规则表默认。 */

function relay(size) {
  return {
    id: 'p', baseUrl: 'https://api.apiyi.com/v1', adapter: '', protocol: 'openai-images', key: 'k',
    modelOptions: { 'gemini-nano-banana-2.1': { size: size } }
  };
}

const MODEL = 'gemini-nano-banana-2.1';

test('an override can rename the size parameter and change the separator', () => {
  const provider = relay({ mode: 'wh-string', field: 'image_size', separator: '*' });
  const adapter = resolveAdapter(provider, MODEL);
  const spec = sizeSpecFor(provider, MODEL, adapter);
  assert.equal(spec.control, 'wh');
  assert.equal(spec.field, 'image_size');

  const fitted = fitSize(provider, { kind: 'size', text: '1024x1024' }, MODEL);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: MODEL, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.equal(body.image_size, '1024*1024');
  assert.equal(body.size, undefined, 'the old field name must not leak through');
});

test('an override can switch to two numeric fields', () => {
  const provider = relay({ mode: 'wh-fields' });
  const adapter = resolveAdapter(provider, MODEL);
  const fitted = fitSize(provider, { kind: 'size', text: '1368x768' }, MODEL);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: MODEL, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.equal(body.width, 1368);
  assert.equal(body.height, 768);
  assert.equal(body.size, undefined);
});

test('width + height take their key names from field and second.field', () => {
  // 缺省：还是 width / height，body 与迁移前一模一样。
  const plain = relay({ mode: 'wh-fields' });
  const plainAdapter = resolveAdapter(plain, MODEL);
  const plainFitted = fitSize(plain, { kind: 'size', text: '1368x768' }, MODEL);
  const plainBody = JSON.parse(prepareGenerate(plainAdapter, plain, { model: MODEL, prompt: 'p', fitted: plainFitted }, new Set()).body);
  assert.equal(plainBody.width, 1368);
  assert.equal(plainBody.height, 768);
  assert.equal(plainBody.size, undefined);

  // 改名：field 是「宽」的键名，second.field 是「高」的键名；键名反过来也照用。
  const renamed = relay({ mode: 'wh-fields', field: 'w', second: { from: 'aspect', field: 'h' } });
  const renamedAdapter = resolveAdapter(renamed, MODEL);
  const renamedFitted = fitSize(renamed, { kind: 'size', text: '1368x768' }, MODEL);
  const renamedBody = JSON.parse(prepareGenerate(renamedAdapter, renamed, { model: MODEL, prompt: 'p', fitted: renamedFitted }, new Set()).body);
  assert.equal(renamedBody.w, 1368);
  assert.equal(renamedBody.h, 768);
  assert.equal(renamedBody.width, undefined, '改名后旧键名不许再出现');
  assert.equal(renamedBody.height, undefined);
});

test('an override can switch to a ratio even on a plain images gateway', () => {
  const provider = relay({ mode: 'aspect' });
  const adapter = resolveAdapter(provider, MODEL);
  const spec = sizeSpecFor(provider, MODEL, adapter);
  assert.equal(spec.control, 'aspect');
  assert.ok(spec.aspects.includes('16:9'), 'a default ratio list keeps the dropdown usable');
  assert.equal(spec.field, 'aspect_ratio');

  const fitted = fitSize(provider, { kind: 'aspect', text: '1024x1024' }, MODEL);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: MODEL, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.equal(body.aspect_ratio, '1:1');
});

test('an override can send a tier label', () => {
  const provider = relay({ mode: 'tier', field: 'resolution' });
  const adapter = resolveAdapter(provider, MODEL);
  const spec = sizeSpecFor(provider, MODEL, adapter);
  assert.equal(spec.control, 'preset');
  assert.deepEqual(spec.tiers.map((tier) => tier.value), ['1K', '2K', '4K']);

  const fitted = fitSize(provider, { kind: 'preset', text: '2K' }, MODEL);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: MODEL, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.equal(body.resolution, '2K');
});

test('a dotted parameter name builds a nested object', () => {
  const provider = relay({ mode: 'wh-string', field: 'generationConfig.imageConfig.imageSize' });
  const adapter = resolveAdapter(provider, MODEL);
  const fitted = fitSize(provider, { kind: 'size', text: '1024x1536' }, MODEL);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: MODEL, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.deepEqual(body.generationConfig, { imageConfig: { imageSize: '1024x1536' } });
});

test('the user override beats the built-in model family table', () => {
  // 官方家族表认为 nano-banana 收比例，用户说这个中转只认 width/height。
  const provider = relay({ mode: 'wh-fields' });
  const spec = sizeSpecFor(provider, MODEL);
  assert.equal(spec.control, 'wh');
});

test('without an override the model name still picks a sensible default', () => {
  const plain = { id: 'p', baseUrl: 'https://api.apiyi.com/v1', adapter: '', protocol: 'openai-images', key: 'k' };
  const adapter = resolveAdapter(plain, MODEL);
  assert.equal('sizeOverride' in adapter, false);
  // 名字里有 banana：按 nano-banana 的比例 + 档位兜底，用户仍然可以覆盖。
  assert.equal(sizeSpecFor(plain, MODEL).control, 'aspect');
  assert.deepEqual(sizeSpecFor(plain, MODEL).tiers.map((tier) => tier.value), ['1K', '2K', '4K']);
  // 认不出来的模型保持宽高。
  assert.equal(sizeSpecFor(plain, 'mystery-image-v9').control, 'wh');
});

test('the config sanitiser keeps a size-only model option', () => {
  const out = normalizeModelOptions({
    'gemini-nano-banana-2.1': { size: { mode: 'aspect', field: 'aspect_ratio', separator: '' } }
  }, ['gemini-nano-banana-2.1'], '');
  assert.deepEqual(out['gemini-nano-banana-2.1'], { size: { mode: 'aspect', field: 'aspect_ratio' } });

  // 分隔符可以手填，常见于 | 或 , 风格的中转；空白和超长会被清掉。
  const custom = normalizeModelOptions({
    'm': { size: { mode: 'wh-string', separator: '|' } }
  }, ['m'], '');
  assert.equal(custom.m.size.separator, '|');
  const messy = normalizeModelOptions({
    'm': { size: { mode: 'wh-string', separator: ' a b ' } }
  }, ['m'], '');
  assert.equal(messy.m.size.separator, 'ab');

  // 第二个字段也要能落盘：比例写 aspectRatio、档位写 imageSize。
  const multi = normalizeModelOptions({
    'm': { size: { mode: 'aspect', field: 'aspectRatio', second: { from: 'tier', field: 'imageSize' } } }
  }, ['m'], '');
  assert.deepEqual(multi.m.size, { mode: 'aspect', field: 'aspectRatio', second: { from: 'tier', field: 'imageSize' } });

  const broken = normalizeModelOptions({
    'gemini-nano-banana-2.1': { size: { mode: 'nonsense', field: 42, separator: '   ' } }
  }, ['gemini-nano-banana-2.1'], '');
  assert.equal(broken['gemini-nano-banana-2.1'], undefined, 'nothing valid means no entry at all');
});
test('a second field can carry the ratio or the tier', () => {
  const provider = {
    id: 'p', baseUrl: 'https://api.apiyi.com/v1', adapter: '', protocol: 'openai-images', key: 'k',
    modelOptions: {
      'gemini-nano-banana-2.1': {
        size: { mode: 'aspect', field: 'aspect_ratio', second: { from: 'tier', field: 'imageSize' } }
      }
    }
  };
  const adapter = resolveAdapter(provider, MODEL);
  const fitted = fitSize(provider, { kind: 'aspect', text: '1368x768' }, MODEL);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: MODEL, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.equal(body.aspect_ratio, '16:9');
  assert.equal(body.imageSize, fitted.tier, 'the tier goes to the second field');
});

/** 向量模型：规则说「面板给比例、线上发像素」，一键配置把规则抄成覆盖后不能退化成宽高。 */
const VECTOR = 'recraftv3_vector';

test('an override can pin the panel control without changing the wire form', () => {
  const provider = {
    id: 'p', baseUrl: 'https://api.apiyi.com/v1', adapter: '',
    modelOptions: { [VECTOR]: { size: { mode: 'wh-string', field: 'size', control: 'aspect' } } }
  };
  const adapter = resolveAdapter(provider, VECTOR);
  const spec = sizeSpecFor(provider, VECTOR, adapter);
  assert.equal(spec.control, 'aspect', 'control 跟着覆盖走，面板才不会从比例变成宽高');
  assert.equal(spec.field, 'size');

  // control 只影响面板，线上仍然发像素串。
  const fitted = fitSize(provider, { kind: 'size', text: '1024x1024' }, VECTOR);
  const body = JSON.parse(prepareGenerate(adapter, provider, { model: VECTOR, prompt: 'p', fitted: fitted }, new Set()).body);
  assert.match(String(body.size), /^\d+x\d+$/);
  assert.equal(body.aspect_ratio, undefined);
});

test('an override without control keeps the old behaviour', () => {
  const provider = relay({ mode: 'wh-string', field: 'image_size' });
  const adapter = resolveAdapter(provider, MODEL);
  assert.equal(sizeSpecFor(provider, MODEL, adapter).control, 'wh',
    '用户只说怎么发、没说控件时，面板还是宽高');
});

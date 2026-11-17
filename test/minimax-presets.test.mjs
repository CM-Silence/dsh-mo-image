import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_PRESETS, detectProtocolStart, fitSize, prepareEdit, prepareGenerate, resolveAdapter
} from '../lib/adapters.js';
import { headersFor } from '../lib/adapter-kit.js';
import { detectQualityRule, detectSizeRule } from '../lib/model-rules.js';

/*
 * MiniMax H3-Image 的图片接口就是 **OpenAI Images 形状**，官方 OpenAPI 里写得很清楚：
 *
 *   POST /v1/images/generations   文生图（JSON）
 *   POST /v1/images/edits         图生图，1–16 张参考图（JSON 的 images[].image_url，
 *                                 或 OpenAI SDK 的 multipart image[]）
 *   GET  /v1/models               OpenAI 兼容的模型清单
 *   鉴权 Authorization: Bearer <API Key>
 *
 * 所以这两条预设一律是 `adapter: 'openai-images'` + 一个 baseUrl，不需要新协议。
 * 这里锁三件事：地址三元组拼得对、models 里只有查证过的 id、尺寸按 H3 的真实参数
 * （aspect_ratio + area 档位，不能同时发 size）走。
 *
 * 查证来源：
 *   https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md
 *   https://platform.minimax.io/docs/api-reference/image-generation-h3-edits.md
 *   https://platform.minimax.io/docs/api-reference/models/openai/list-models.md
 *   https://platform.minimax.cn/docs/api-reference/image-generation-h3-generations.md
 */

/** 两条预设：两个官方域名（国际站 / 中国站）。 */
const PRESETS = [
  { id: 'minimax', baseUrl: 'https://api.minimax.io/v1' },
  { id: 'minimax-cn', baseUrl: 'https://api.minimax.cn/v1' }
];

/** 官方 OpenAPI 的 model enum（文生图与图生图两个端点一致）。 */
const H3_MODELS = ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'];

/** baseUrl 末尾可能带斜杠，拼接规则与 baseUrlOf() 一致：去掉尾部斜杠再接路由模板。 */
function join(baseUrl, route) {
  return String(baseUrl).replace(/\/+$/, '') + route;
}

test('MiniMax 预设都解析成 openai-images，并拼出 generations / edits / models 三条地址', () => {
  for (const { id, baseUrl } of PRESETS) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    assert.ok(preset, '缺少内置预设 ' + id);
    assert.equal(preset.baseUrl, baseUrl, id + ' 的 baseUrl 变了');

    const adapter = resolveAdapter(preset, H3_MODELS[0]);
    assert.equal(adapter.id, 'openai-images', id + ' 应该落在现成的 openai-images 协议上，而不是新协议');

    // 三条路由模板：和官方 OpenAPI 的 paths 一一对应。
    assert.equal(adapter.routes.generate, '/images/generations');
    assert.equal(adapter.routes.edit, '/images/edits');
    assert.equal(adapter.routes.models, '/models');

    // 拼出来的完整地址。
    assert.equal(join(baseUrl, adapter.routes.generate), baseUrl + '/images/generations');
    assert.equal(join(baseUrl, adapter.routes.edit), baseUrl + '/images/edits');
    assert.equal(join(baseUrl, adapter.routes.models), baseUrl + '/models');

    // 鉴权是 Authorization: Bearer <API Key>（官方 securitySchemes 就是 HTTP bearer），
    // 不是 Azure 那种 api-key 头。
    const headers = headersFor(Object.assign({}, preset, { key: 'sk-test' }), false, null, adapter);
    assert.equal(headers.Authorization, 'Bearer sk-test', id + ' 的鉴权头应该是 Bearer');

    // 编辑端点收 multipart 的 image[]（官方 OpenAI SDK 示例就是 images.edit + image=[...]）。
    assert.equal(adapter.transport.edit, 'multipart', id + ' 的编辑端点应该是 multipart');
    assert.deepEqual(adapter.editFields.slice(0, 1), ['image[]']);
    assert.equal(preset.fields.image.multipart, adapter.editFields[0]);
  }
});

test('MiniMax 预设的 models 里只有查证过的 id', () => {
  for (const { id } of PRESETS) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    assert.ok(Array.isArray(preset.models), id + ' 的 models 必须是数组');
    for (const model of preset.models) {
      assert.ok(H3_MODELS.includes(model), id + ' 里出现了没查证过的模型 id：' + model);
    }
    // 两个官方域名的文档都列了这两个模型，没有理由留空。
    assert.deepEqual(preset.models, H3_MODELS, id + ' 应该带上官方文档里的两个 H3 模型');
  }
});

test('MiniMax 预设只发 H3 认的参数：负面词拼进提示词，没有质量档位', () => {
  for (const { id } of PRESETS) {
    const preset = PROVIDER_PRESETS.find((item) => item.id === id);
    assert.deepEqual(preset.fields.prompt, { path: 'prompt' });
    // H3 的请求体没有 negative_prompt 这个键，只能拼进提示词。
    assert.deepEqual(preset.fields.negative, { appendToPrompt: '\n\nAvoid: ' });
    assert.deepEqual(preset.fields.model, { path: 'model' });
    assert.deepEqual(preset.fields.n, { path: 'n' });
    // H3 只有 output_compression（0–100），没有 low/medium/high 这种档位枚举。
    assert.equal(preset.fields.quality, null, id + ' 不该声明质量档位');
  }
});

test('MiniMax 地址的自动检测不发探测请求就知道是 openai-images', () => {
  // /v1/models 要鉴权：没贴 Key 时探回来是 401，会被当成「不像任何协议」。
  // 所以这两个主机登记在 KNOWN_OPENAI_HOSTS 里，检测直接给出答案、一个请求都不发。
  for (const { id, baseUrl } of PRESETS) {
    const start = detectProtocolStart({ baseUrl: baseUrl }, H3_MODELS[0]);
    assert.equal(start.done, true, id + ' 的检测应该当场有结论');
    assert.equal(start.answer.protocol, 'openai-images', id + ' 应该被认成 openai-images');
    assert.equal(start.answer.matched, true, id + ' 应该 matched');
    assert.equal(start.answer.probed, false, id + ' 不该发探测请求');
    // 协议级选项全走默认（编辑走 /images/edits、鉴权 Bearer），不该冒出 edit:'none' 之类。
    assert.equal(start.answer.protocolOptions, undefined, id + ' 不该带协议级选项');
  }
});

test('MiniMax 请求体：比例 + area 档位，绝不出现 size', () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === 'minimax');
  const adapter = resolveAdapter(preset, H3_MODELS[0]);
  const provider = Object.assign({}, preset, { key: 'sk-test' });

  // 官方两个端点都写明 size 与 aspect_ratio/area 互斥（同时给会 400），
  // 所以编码出来只能有后两个。
  for (const [wanted, aspect, area] of [
    ['1024x1024', '1:1', '1K'],
    ['2720x1536', '16:9', '2K'],
    ['1536x2720', '9:16', '2K'],
    ['4096x4096', '1:1', '4K']
  ]) {
    const fitted = fitSize(provider, wanted, H3_MODELS[0]);
    const out = prepareGenerate(adapter, provider, {
      model: H3_MODELS[0], prompt: 'a cat', negativePrompt: 'blurry', fitted
    }, new Set());
    assert.equal(out.path, '/images/generations');
    const body = JSON.parse(out.body);
    assert.equal('size' in body, false, wanted + ' 不该发 size（会和 aspect_ratio 打架）');
    assert.equal(body.aspect_ratio, aspect, wanted + ' 的比例不对');
    assert.equal(body.area, area, wanted + ' 的档位不对');
    // H3 没有 negative_prompt：负面词只能拼进提示词。
    assert.equal(body.prompt, 'a cat\n\nAvoid: blurry');
  }

  // 选了「自动」就什么都不发，交给服务端（size=auto、aspect_ratio=auto、area=4K）。
  const auto = prepareGenerate(adapter, provider, {
    model: H3_MODELS[0], prompt: 'a cat', fitted: fitSize(provider, 'auto', H3_MODELS[0])
  }, new Set());
  const autoBody = JSON.parse(auto.body);
  assert.equal('size' in autoBody, false);
  assert.equal('aspect_ratio' in autoBody, false);
  assert.equal('area' in autoBody, false);

  // 图生图走 multipart 的 /images/edits，参考图字段是 image[]（官方 cURL --form 'image[]=@cat.jpg'）。
  const edit = prepareEdit(adapter, provider, {
    model: H3_MODELS[0], prompt: 'make it blue',
    fitted: fitSize(provider, '1024x1024', H3_MODELS[0]),
    images: [{ buffer: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png', filename: 'ref.png' }]
  }, new Set());
  assert.equal(edit.path, '/images/edits');
  // 编辑走 multipart/form-data（官方两个请求格式都收，multipart 与 OpenAI SDK 一致）。
  assert.ok(edit.body instanceof FormData, '编辑体应该是 FormData');
  assert.equal(edit.body.get('image[]').name, 'ref.png');
  assert.equal(edit.body.get('aspect_ratio'), '1:1');
  assert.equal(edit.body.get('area'), '1K');
  assert.equal(edit.body.has('size'), false);
});

test('H3-Image 的尺寸规则是 aspect_ratio + area 档位，不发 size', () => {
  for (const model of H3_MODELS) {
    for (const baseUrl of [undefined, 'https://api.minimax.io/v1', 'https://api.minimax.cn/v1']) {
      const rule = detectSizeRule(model, baseUrl);
      assert.ok(rule, model + ' 应该命中尺寸规则');
      // size 与 aspect_ratio 互斥：H3 收到 aspect_ratio 时 size 必须是 auto/缺省，
      // 所以只发比例 + area，让服务端按档位算宽高。
      assert.equal(rule.size.mode, 'aspect');
      assert.equal(rule.size.field, 'aspect_ratio');
      assert.deepEqual(rule.size.second, { from: 'tier', field: 'area' });
      assert.deepEqual(rule.domain.tiers.map((tier) => tier.value), ['1K', '2K', '4K']);
      // 官方给的例子是 16:9 / 3:4 / 21:9 / 3:1，比例的合法区间是 1:3–3:1。
      for (const aspect of ['1:1', '16:9', '9:16', '21:9', '3:1']) {
        assert.ok(rule.domain.aspects.includes(aspect), model + ' 的比例表里应该有 ' + aspect);
      }
    }
  }

  // 没有质量枚举：不写质量规则，QUALITY_RULES 就不该命中。
  assert.equal(detectQualityRule('MiniMax-H3-Image'), null);
  assert.equal(detectQualityRule('MiniMax-H3-Image-Highspeed', 'https://api.minimax.io/v1'), null);
});

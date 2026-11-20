import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_PRESETS, LOCAL_PRESETS, resolveAdapter, listAdapters, prepareGenerate
} from '../lib/adapters.js';
import { applyFields, multipartFields, promptParts, resolveFields } from '../lib/field-templates.js';
import { FIELD_RULES, detectFieldRule } from '../lib/model-rules.js';

/*
 * 内置提供商 / 本地部署预设的字段模板（docs/…/2026-11-16-model-size-quality-rules.md 任务 6'、7'）。
 *
 * 任务 6' 只加数据；任务 7' 把通用路径接上以后，这里同时锁三件事：
 *
 *   1. 每条预设都有 prompt / negative / model / n / image / quality 六个逻辑字段，
 *      值是字段模板或 null（null = 这个网关没有这个字段，写 body 时跳过）；
 *   2. 同一条协议被多条预设复用时，各预设内联的那几份 fields 必须一字不差
 *      —— 字段名是照抄协议代码的，一份改错另一份没改，接线后就会一半协议发对、
 *      一半发错（quality 例外：它随模型收不收，见下面的用例）；
 *   3. 模板的形状能被 lib/field-templates.js 的口径接受（三个出口都试一遍），
 *      而且协议上**不再有任何字段名**（send / acceptsQuality 删干净）。
 *
 * 模型规则那半边（lib/model-rules.js 的 FIELD_RULES）同样有形状与命中断言；
 * 它按模型名收窄，认不出就返回 null 回落到预设，所以这里也盯着「不许有兜底规则」：
 * 一条匹配任意模型的通配规则会把所有预设盖掉。
 */

const LOGICAL_FIELDS = ['prompt', 'negative', 'model', 'n', 'image', 'quality'];

/** 两份清单摊平成一张表：字段模板对提供商与本地部署是同一套口径。 */
function presets() {
  return [
    ...PROVIDER_PRESETS.map((preset) => Object.assign({}, preset, { group: 'provider' })),
    ...LOCAL_PRESETS.map((preset) => Object.assign({}, preset, { group: 'local' }))
  ];
}

/** 该预设实际落在哪条协议上：和 resolveAdapter 的判定一致（空模型名足够区分主机型协议）。 */
function protocolOf(preset) {
  return resolveAdapter(preset, '');
}

/** 每个逻辑字段的样例值：够让三个出口都真的走一遍写入。 */
const SAMPLE = {
  prompt: 'a cat sitting on a windowsill, soft morning light',
  negative: 'blurry, watermark, text',
  model: 'test-model',
  n: 2,
  image: { buffer: Buffer.from('png-bytes'), contentType: 'image/png' }
};

/* ------------------------------------------------------------------ 形状 */

test('每条内置预设都带六个逻辑字段的模板键（模板对象或 null）', () => {
  const list = presets();
  assert.ok(list.length > 0, '至少要下发一条预设');
  for (const preset of list) {
    const label = preset.group + '/' + preset.id;
    assert.ok(
      preset.fields && typeof preset.fields === 'object' && !Array.isArray(preset.fields),
      label + ' 没有 fields'
    );
    assert.deepEqual(
      Object.keys(preset.fields).sort(),
      LOGICAL_FIELDS.slice().sort(),
      label + ' 的逻辑字段必须正好是 prompt / negative / model / n / image / quality'
    );
    for (const name of LOGICAL_FIELDS) {
      const spec = preset.fields[name];
      assert.ok(
        spec === null || (typeof spec === 'object' && !Array.isArray(spec)),
        label + '.' + name + ' 只能是模板对象或 null，收到 ' + JSON.stringify(spec)
      );
    }
  }
});

/* -------------------------------------------------------------- 同协议一致 */

/** 这家网关把提示词 / 负面词 / 模型 / 张数 / 参考图叫什么（quality 随模型，见下一个用例）。 */
function gatewayFields(fields) {
  const rest = {};
  for (const [key, value] of Object.entries(fields || {})) if (key !== 'quality') rest[key] = value;
  return rest;
}

/**
 * 协议合并之后，「同一条协议 ⇒ 同一种字段形状」不再成立：`openai-images` 现在同时承载
 * OpenAI 官方、几家 OpenAI 兼容网关、火山方舟、硅基流动、LocalAI、Together，
 * 它们的参考图字段与负面词本来就不同（这正是它们以前各占一条协议的原因）。
 *
 * 所以守卫下沉一层：按**网关家族**比。同一家族里的预设仍然必须一字不差
 * （那是「两份预设各写一个样」的唯一防线），跨家族不比。
 * 只比较已有的同族条目。新增独立预设会自动跑下方通用契约测试。
 */
const FIELD_FAMILIES = {
  'openai-compatible': ['openai', 'openai-gateway', 'sd-server'],
  // MiniMax 两个域名是同一条接口（OpenAI Images 形状）的不同地址，字段一字不差。
  'minimax': ['minimax', 'minimax-cn'],
  'volcengine': ['volcengine', 'volcengine-plan']
};

test('同一个网关家族的所有预设，fields 必须完全一致（防止两份漂移）', () => {
  const list = presets();
  for (const [family, ids] of Object.entries(FIELD_FAMILIES)) {
    const group = ids.map((id) => {
      const preset = list.find((item) => item.id === id);
      assert.ok(preset, 'FIELD_FAMILIES 里的 ' + id + ' 不再是预设');
      return preset;
    });
    const first = group[0];
    assert.ok(first.fields, first.id + ' 没有 fields');
    for (const preset of group.slice(1)) {
      // quality 是模型级的：openai 预设自己的模型认质量，通用 OpenAI 兼容网关上的 flux 不认，
      // 同一家族的预设会落到同一套模板但 quality 不同，所以这一层只比五项网关字段。
      assert.deepEqual(
        gatewayFields(preset.fields),
        gatewayFields(first.fields),
        preset.id + ' 与 ' + first.id + ' 同为 ' + family + ' 家族，fields 必须一字不差'
      );
    }
  }
});

test('预设目录的 ID 唯一，地址与协议有效', () => {
  const byProtocol = new Map();
  const ids = new Set();
  for (const preset of presets()) {
    assert.match(preset.id, /^[a-z0-9][a-z0-9._-]*$/);
    assert.ok(!ids.has(preset.id), 'duplicate preset ' + preset.id);
    ids.add(preset.id);
    assert.match(new URL(preset.baseUrl).protocol, /^https?:$/);
    const adapter = protocolOf(preset);
    assert.ok(adapter.endpoints?.generate || adapter.routes?.generate, preset.id);
    const id = adapter.id;
    if (!byProtocol.has(id)) byProtocol.set(id, []);
    byProtocol.get(id).push(preset.id);
  }
  // 合并掉的协议 id 不能再出现在清单里。
  for (const gone of ['dall-e-3', 'gpt-image', 'together', 'localai', 'siliconflow', 'volcengine-ark', 'azure-openai', 'xai-imagine', 'zhipu']) {
    assert.equal(byProtocol.has(gone), false, gone + ' 应该已经合并进 openai-images');
  }
});

test('收质量的只有原来那 4 条协议对应的 3 份预设（acceptsQuality 删掉后改由模板声明）', () => {
  const accepting = presets()
    .filter((preset) => preset.fields.quality)
    .map((preset) => preset.group + '/' + preset.id)
    .sort();
  // dall-e-3 与 gpt-image 共用 openai 预设；ideogram、azure-openai 各一份。
  assert.deepEqual(accepting, ['provider/azure', 'provider/ideogram', 'provider/openai']);
  for (const preset of presets()) {
    const quality = preset.fields.quality;
    if (!quality) continue;
    assert.deepEqual(quality, { path: 'quality' }, preset.id + ' 的 quality 模板只该说明发到哪个字段');
  }
});

/* ------------------------------------------------------- 模板能被模板层接受 */

test('预设模板的形状能被 applyFields / multipartFields / promptParts 接受', () => {
  for (const preset of presets()) {
    for (const name of LOGICAL_FIELDS) {
      const spec = preset.fields[name];
      if (spec === null) continue;
      assert.doesNotThrow(
        () => applyFields({}, { [name]: spec }, SAMPLE),
        preset.id + '.' + name + ' 的模板形状不被 applyFields 接受'
      );
    }
    // 六条一起写进空 body：字段之间不能在同一个容器上互相踩。
    assert.doesNotThrow(
      () => applyFields({}, preset.fields, SAMPLE),
      preset.id + ' 的六条模板不能一起写进同一个 body'
    );
    // multipart 与拼提示词是两个出口，同一份模板必须同样认得。
    assert.doesNotThrow(
      () => multipartFields(preset.fields, SAMPLE, [SAMPLE.image]),
      preset.id + ' 的模板不被 multipartFields 接受'
    );
    assert.doesNotThrow(
      () => promptParts(preset.fields, SAMPLE),
      preset.id + ' 的模板不被 promptParts 接受'
    );
  }
});

/* ----------------------------------------------------- 协议上没有字段名了 */

test('协议上不再有字段名：send / acceptsQuality 都删干净了', () => {
  for (const entry of listAdapters()) {
    const adapter = resolveAdapter({ adapter: entry.id, baseUrl: 'https://example.test/v1' }, 'some-model');
    assert.equal(adapter.id, entry.id);
    assert.equal('send' in adapter, false, entry.id + ' 还留着 send 白名单');
    assert.equal('acceptsQuality' in adapter, false, entry.id + ' 还留着 acceptsQuality');
  }
  // custom 协议是 resolveAdapter 现场生成的，同样不该持有字段名。
  const custom = resolveAdapter({ adapter: 'custom', baseUrl: 'https://example.test/v1' }, '');
  assert.equal('send' in custom, false, 'custom 协议还留着 send 白名单');
});

test('通用协议的请求体就是预设模板写出来的：字段一个不多一个不少', () => {
  // openai-gateway 预设（openai-images 协议）是「按字段模板组装」的活例子。
  const provider = { adapter: 'openai-images', baseUrl: 'http://127.0.0.1:3000/v1', key: 'k' };
  const adapter = resolveAdapter(provider, 'flux-1-schnell');
  assert.equal(adapter.id, 'openai-images');
  const body = JSON.parse(prepareGenerate(adapter, provider, {
    model: 'flux-1-schnell', prompt: 'a cat', negativePrompt: 'bad', fitted: { omit: true, size: 'none' }
  }, new Set()).body);
  assert.deepEqual(Object.keys(body).sort(), ['model', 'n', 'negative_prompt', 'prompt']);
  assert.equal(body.model, 'flux-1-schnell');
  assert.equal(body.prompt, 'a cat');
  assert.equal(body.negative_prompt, 'bad');
  assert.equal(body.n, 1);
});

test('参考图模板的字段名来自协议的 editFields', () => {
  for (const preset of presets()) {
    const adapter = protocolOf(preset);
    const image = preset.fields.image;
    if (image === null) continue;
    const declared = Array.isArray(adapter.editFields) ? adapter.editFields : [];
    if (!declared.length) continue;
    if (adapter.transport.edit === 'multipart') {
      assert.equal(
        image.multipart,
        declared[0],
        preset.id + ' 落在 multipart 编辑端点 ' + adapter.id + ' 上，参考图字段名要和 editFields 第一个一致'
      );
      continue;
    }
    // JSON 编辑端点：字段名就是 body 的键（data URL 由 as 决定编码形态）。
    if (typeof image.path === 'string' && !image.path.includes('.') && !image.path.includes('[')) {
      assert.equal(
        image.path,
        declared[0],
        preset.id + ' 落在 JSON 编辑端点 ' + adapter.id + ' 上，参考图字段名要和 editFields 第一个一致'
      );
    }
  }
});

test('协议不支持编辑时，预设不得声称有参考图字段', () => {
  for (const preset of presets()) {
    const adapter = protocolOf(preset);
    if (adapter.endpoints.edit) continue;
    assert.equal(
      preset.fields.image,
      null,
      preset.id + ' 落在不支持编辑的协议 ' + adapter.id + ' 上，image 必须是 null'
    );
  }
});

/* -------------------------------------------------------- 模型字段规则 */

test('模型字段规则：键名落在六个逻辑字段里、match 是正则、模板能被 applyFields 接受', () => {
  assert.ok(Array.isArray(FIELD_RULES) && FIELD_RULES.length > 0);
  for (const rule of FIELD_RULES) {
    assert.ok(rule.match instanceof RegExp, 'match 必须是正则');
    if (rule.host !== undefined) assert.equal(typeof rule.host, 'string');
    assert.ok(rule.fields && typeof rule.fields === 'object');
    // 规则是「在预设之上收窄」，可以只写要改的字段（不带 host 的 gpt-image 条目就是这样
    // 把 negative 留给预设的）；但不许出现六个逻辑字段以外的名字。
    const unknown = Object.keys(rule.fields).filter((key) => !LOGICAL_FIELDS.includes(key));
    assert.deepEqual(unknown, [], String(rule.match) + ' 出现了六个逻辑字段以外的键');
    for (const [field, spec] of Object.entries(rule.fields)) {
      assert.ok(
        spec === null || (typeof spec === 'object' && !Array.isArray(spec)),
        String(rule.match) + '.' + field + ' 只能是模板对象或 null'
      );
    }
    assert.doesNotThrow(
      () => applyFields({}, rule.fields, SAMPLE),
      String(rule.match) + ' 的模板不能一起写进空 body'
    );
  }
});

test('模型字段规则叠加预设之后，六个逻辑字段都有定论', () => {
  // 规则可以省略字段（省略 = 跟随预设），合并以后必须齐全，缺的那个就是没人管的字段。
  const preset = PROVIDER_PRESETS.find((item) => item.id === 'openai').fields;
  for (const rule of FIELD_RULES) {
    const merged = resolveFields({ rule: rule.fields, preset });
    assert.deepEqual(
      Object.keys(merged).sort(),
      LOGICAL_FIELDS.slice().sort(),
      String(rule.match) + ' 与 openai 预设合并不齐'
    );
  }
});

test('字段规则没有兜底：认不出的模型返回 null，回落到预设', () => {
  // 与尺寸规则不同，字段规则不能有 `match:/.*/` 的通配条目：它会把所有预设盖掉，
  // 而字段名恰恰是「这家网关怎么发」里最需要按预设区分的东西。
  assert.equal(
    FIELD_RULES.some((rule) => rule.match.source === '.*' && rule.host === undefined),
    false,
    '字段规则不许有通配兜底'
  );
  assert.equal(detectFieldRule('some-private-model'), null);
  assert.equal(detectFieldRule('some-private-model', 'https://gateway.example/v1'), null);
  assert.equal(detectFieldRule(''), null);
});

test('模型字段规则：OpenAI 官方端点上的 GPT-Image / DALL·E 3 没有负面词字段', () => {
  // 官方端点收未知参数会 400，所以只对官方主机把 negative 关掉；
  // 中转站上的同名模型保留预设的 negative_prompt（见下一个用例）。
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-1', 'dall-e-3']) {
    for (const baseUrl of ['https://api.openai.com/v1', 'https://example-resource.openai.azure.com/openai/v1']) {
      const rule = detectFieldRule(model, baseUrl);
      assert.ok(rule, model + ' 应该命中字段规则');
      assert.equal(rule.fields.negative, null, model + ' 在 ' + baseUrl + ' 不该发 negative_prompt');
      assert.deepEqual(rule.fields.prompt, { path: 'prompt' });
      assert.deepEqual(rule.fields.model, { path: 'model' });
      assert.deepEqual(rule.fields.n, { path: 'n' });
      assert.deepEqual(rule.fields.image, { multipart: 'image[]' });
      // quality 不归规则管：openai-chat / openai-responses 这类没有预设的协议不能凭模型名
      // 凭空多出质量档位，所以规则里不写 quality，交给预设的 fields.quality。
      assert.equal('quality' in rule.fields, false, model + ' 的规则不该带 quality');
    }
  }
});

test('模型字段规则：中转站上的 GPT-Image / DALL·E 3 保留预设的 negative_prompt', () => {
  for (const model of ['gpt-image-2.5-flare', 'dall-e-3']) {
    const rule = detectFieldRule(model, 'https://relay.example.com/v1');
    assert.ok(rule, model + ' 应该命中不带 host 的那条规则');
    assert.equal(rule.host, undefined, '中转站靠的是不带 host 的那条');
    assert.deepEqual(rule.fields.negative, { path: 'negative_prompt' }, model + ' 在中转站上要发负面词');
    assert.equal(detectFieldRule(model), rule, '没有 baseUrl 时同样落到不带 host 的那条');
  }
});

test('模型字段规则：同一个 qwen-image 在硅基流动与百炼字段不同', () => {
  const silicon = detectFieldRule('Qwen/Qwen-Image', 'https://api.siliconflow.cn/v1');
  assert.deepEqual(silicon.fields.prompt, { path: 'prompt' });
  assert.deepEqual(silicon.fields.negative, { path: 'negative_prompt' });
  assert.deepEqual(silicon.fields.image, { path: 'image', as: 'dataUrl' });

  // 百炼是原生多模态接口：提示词与参考图都追加到 input.messages[0].content[]。
  const bailian = detectFieldRule('qwen-image-3.0-pro', 'https://dashscope.aliyuncs.com/api/v1');
  assert.deepEqual(bailian.fields.prompt, { path: 'input.messages[0].content[]', wrap: 'text' });
  assert.deepEqual(bailian.fields.negative, { path: 'parameters.negative_prompt' });
  assert.deepEqual(bailian.fields.n, { path: 'parameters.n' });
  assert.deepEqual(
    bailian.fields.image,
    { path: 'input.messages[0].content[]', wrap: 'image', as: 'dataUrl' }
  );

  const body = {};
  applyFields(body, bailian.fields, { prompt: '一只猫', negative: '模糊', model: 'qwen-image-3.0-pro', n: 1 });
  assert.deepEqual(body, {
    input: { messages: [{ content: [{ text: '一只猫' }] }] },
    parameters: { negative_prompt: '模糊', n: 1 },
    model: 'qwen-image-3.0-pro'
  });
});

test('模型字段规则：gemini 原生把内容写进 contents[].parts[]，负面词拼进提示词', () => {
  const rule = detectFieldRule('gemini-3.1-flash-image', 'https://generativelanguage.googleapis.com/v1beta');
  assert.deepEqual(rule.fields.prompt, { path: 'contents[0].parts[]', wrap: 'text' });
  assert.deepEqual(rule.fields.negative, { appendToPrompt: '\n\nAvoid: ' });
  // 模型名在 URL 的 :generateContent 前面，参考图是 inlineData 对象（六种能力表达不了），都留在 execute 里。
  assert.equal(rule.fields.model, null);
  assert.equal(rule.fields.image, null);
});

test('模型字段规则：ideogram-4 是 JSON，没有 negative_prompt；4-5 / transparent 有', () => {
  const plain = detectFieldRule('ideogram-4');
  assert.equal(plain.fields.negative, null, 'ideogram-4 的 JSON body 只有 prompt / num_images / resolution');

  for (const model of ['ideogram-3', 'ideogram-4-5', 'ideogram-4-transparent']) {
    assert.deepEqual(
      detectFieldRule(model).fields.negative,
      { path: 'negative_prompt' },
      model + ' 的表单体带 negative_prompt'
    );
  }
  for (const model of ['ideogram-3', 'ideogram-4', 'ideogram-4-5']) {
    const rule = detectFieldRule(model);
    assert.deepEqual(rule.fields.n, { path: 'num_images' }, model + ' 的张数字段叫 num_images');
    assert.equal(rule.fields.model, null, 'ideogram 的模型名在路径里，不是 body 字段');
    assert.equal(rule.fields.image, null, 'ideogram 不支持编辑');
  }
});

test('模型字段规则：BFL 的参考图按序号展开，FLUX 3 换成 images 数组', () => {
  const flux2 = detectFieldRule('flux-2-pro', 'https://api.bfl.ai/v1');
  assert.deepEqual(flux2.fields.image, { numbered: 'input_image', as: 'dataUrl' });
  assert.equal(flux2.fields.model, null, 'BFL 的模型名在提交路径 /v1/<model> 里');

  const flux3 = detectFieldRule('flux-3-image', 'https://api.bfl.ai/v1');
  assert.deepEqual(flux3.fields.image, { path: 'images[]', as: 'dataUrl' });
});

test('模型字段规则：火山方舟的 seedream 没有负面词字段', () => {
  for (const model of ['doubao-seedream-4-0-250828', 'seedream-5.0']) {
    const rule = detectFieldRule(model, 'https://ark.cn-beijing.volces.com/api/v3');
    assert.ok(rule, model + ' 应该命中字段规则');
    assert.equal(rule.fields.negative, null);
    assert.deepEqual(rule.fields.image, { path: 'image', as: 'dataUrl' });
  }
});

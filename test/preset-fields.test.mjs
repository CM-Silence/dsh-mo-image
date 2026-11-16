import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_PRESETS, LOCAL_PRESETS, resolveAdapter } from '../lib/adapters.js';
import { applyFields, multipartFields, promptParts } from '../lib/field-templates.js';
import { FIELD_RULES, detectFieldRule } from '../lib/model-rules.js';

/*
 * 内置提供商 / 本地部署预设的字段模板（docs/…/2026-11-16-model-size-quality-rules.md 任务 6'）。
 *
 * 这一轮只加数据，不接线：请求组装仍然走各自的 send 白名单 / execute()。
 * 所以这里锁的是三件事：
 *
 *   1. 每条预设都有 prompt / negative / model / n / image 五个逻辑字段，
 *      值是字段模板或 null（null = 这个网关没有这个字段，写 body 时跳过）；
 *   2. 同一条协议被多条预设复用时，各预设内联的那几份 fields 必须一字不差
 *      —— 字段名是照抄协议代码的，一份改错另一份没改，7' 接线时就会一半协议发对、
 *      一半发错；
 *   3. 模板的形状能被 lib/field-templates.js 的口径接受（三个出口都试一遍），
 *      以及「字段名确实来自协议代码」：扁平的 path 必须在该协议的 send 白名单里，
 *      multipart 的参考图名必须是协议的 editFields 第一个。
 *
 * 模型规则那半边（lib/model-rules.js 的 FIELD_RULES）同样有形状与命中断言；
 * 它按模型名收窄，认不出就返回 null 回落到预设，所以这里也盯着「不许有兜底规则」：
 * 一条匹配任意模型的通配规则会把所有预设盖掉。
 */

const LOGICAL_FIELDS = ['prompt', 'negative', 'model', 'n', 'image'];

/** 两份清单摊平成一张表：字段模板对提供商与本地部署是同一套口径。 */
function presets() {
  return [
    ...PROVIDER_PRESETS.map((preset) => Object.assign({}, preset, { group: 'provider' })),
    ...LOCAL_PRESETS.map((preset) => Object.assign({}, preset, { group: 'local' }))
  ];
}

/** 该预设实际落在哪条协议上：和 resolveAdapter 的判定一致（空模型名足够区分主机型协议）。 */
function protocolOf(preset) {
  return resolveAdapter({ adapter: preset.adapter, baseUrl: preset.baseUrl }, '');
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

test('每条内置预设都带五个逻辑字段的模板键（模板对象或 null）', () => {
  const list = presets();
  assert.equal(list.length, 27, '预设数量变了：新增的预设也要补 fields，否则面板里它没有只读摘要');
  for (const preset of list) {
    const label = preset.group + '/' + preset.id;
    assert.ok(
      preset.fields && typeof preset.fields === 'object' && !Array.isArray(preset.fields),
      label + ' 没有 fields'
    );
    assert.deepEqual(
      Object.keys(preset.fields).sort(),
      LOGICAL_FIELDS.slice().sort(),
      label + ' 的逻辑字段必须正好是 prompt / negative / model / n / image'
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

test('同一条协议的所有预设，fields 必须完全一致（防止两份漂移）', () => {
  const byProtocol = new Map();
  for (const preset of presets()) {
    const id = protocolOf(preset).id;
    if (!byProtocol.has(id)) byProtocol.set(id, []);
    byProtocol.get(id).push(preset);
  }

  // 复用最密的两条先点名：不点数，「各写一份」退化成「各写一个样」时没人发现。
  assert.deepEqual(
    byProtocol.get('openai-images').map((preset) => preset.id).sort(),
    ['fireworks', 'novita', 'openai', 'openai-gateway', 'sd-server'],
    'openai-images 的复用清单变了'
  );
  assert.deepEqual(
    byProtocol.get('volcengine-ark').map((preset) => preset.id).sort(),
    ['volcengine', 'volcengine-plan'],
    'volcengine-ark 的复用清单变了'
  );

  for (const [protocol, group] of byProtocol) {
    const first = group[0];
    // 缺 fields 时 deepEqual(undefined, undefined) 会假通过，所以先点名第一份。
    assert.ok(first.fields, first.id + ' 没有 fields');
    for (const preset of group.slice(1)) {
      assert.deepEqual(
        preset.fields,
        first.fields,
        preset.id + ' 与 ' + first.id + ' 同为 ' + protocol + ' 协议，fields 必须一字不差'
      );
    }
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
    // 五条一起写进空 body：字段之间不能在同一个容器上互相踩。
    assert.doesNotThrow(
      () => applyFields({}, preset.fields, SAMPLE),
      preset.id + ' 的五条模板不能一起写进同一个 body'
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

/* ----------------------------------------------------- 字段名来自协议代码 */

test('扁平 path 必须出现在该协议的 send 白名单里（照抄，不自造字段名）', () => {
  for (const preset of presets()) {
    const adapter = protocolOf(preset);
    // 没有 send 白名单的协议（自拼 body 的那 16 条）另行核对，见各自的 execute。
    if (!Array.isArray(adapter.send)) continue;
    // 有 compose() 的协议（dashscope-wanx）白名单是折叠前的扁平键，模板写的却是折叠后的
    // 嵌套路径，两套名字不能直接对比。
    if (typeof adapter.compose === 'function') continue;
    for (const name of LOGICAL_FIELDS) {
      // 参考图不走 send 白名单（它归 editFields），由下一条测试核。
      if (name === 'image') continue;
      const spec = preset.fields[name];
      if (!spec || typeof spec.path !== 'string') continue;
      assert.ok(
        adapter.send.includes(spec.path),
        preset.id + '.' + name + ' 用了 ' + spec.path + '，但它不在 ' + adapter.id + ' 的 send 白名单里'
      );
    }
  }
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

test('模型字段规则：五个键齐全、match 是正则、模板能被 applyFields 接受', () => {
  assert.ok(Array.isArray(FIELD_RULES) && FIELD_RULES.length > 0);
  for (const rule of FIELD_RULES) {
    assert.ok(rule.match instanceof RegExp, 'match 必须是正则');
    if (rule.host !== undefined) assert.equal(typeof rule.host, 'string');
    assert.ok(rule.fields && typeof rule.fields === 'object');
    assert.deepEqual(
      Object.keys(rule.fields).sort(),
      LOGICAL_FIELDS.slice().sort(),
      String(rule.match) + ' 的 fields 键必须是五个逻辑字段'
    );
    assert.doesNotThrow(
      () => applyFields({}, rule.fields, SAMPLE),
      String(rule.match) + ' 的模板不能一起写进空 body'
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

test('模型字段规则：OpenAI 自家的 GPT-Image / DALL·E 3 没有负面词字段', () => {
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-1', 'dall-e-3']) {
    const rule = detectFieldRule(model);
    assert.ok(rule, model + ' 应该命中字段规则');
    assert.equal(rule.fields.negative, null, model + ' 没有 negative prompt 这个参数');
    assert.deepEqual(rule.fields.prompt, { path: 'prompt' });
    assert.deepEqual(rule.fields.model, { path: 'model' });
    assert.deepEqual(rule.fields.n, { path: 'n' });
    assert.deepEqual(rule.fields.image, { multipart: 'image[]' });
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

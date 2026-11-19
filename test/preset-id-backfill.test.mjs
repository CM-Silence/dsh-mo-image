import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, presetIdForProvider } from '../lib/config-store.js';

/**
 * presetId 是后加的字段：升级前建的第三方 / 本地配置里没有它，于是打开编辑被判成
 * 「自定义 API」，协议设置的折叠区又冒了出来。
 *
 * normalizeConfig 把它补回来，判定**先分组、再消歧**：
 *
 *   1. **按 adapter 收窄候选组**：只有 adapter 相同的预设进组。
 *   2. **组内只有一条** → 就是它，地址完全不看（comfyui / a1111 / swarmui / bfl …）：
 *      本地部署器换个端口、换台机器都还是它。
 *   3. **组内按地址认**：归一化后地址完全相同 → 唯一命中就用它。共用 `openai-images`
 *      的那 14 份预设靠这条分开。
 *   4. **组内按名称认**：提供商显示名与预设名相同 → 唯一命中就用它（azure 的地址里
 *      有占位符，只能靠名字）。
 *   5. 都不唯一 → 不回填。
 *
 * 回填只回答「这个提供商来自哪份预设」——UI 判据（协议设置整块不渲染）、锁的默认值、
 * 一键配置都读这一个字段；adapter 与用户选过的协议一律原样保留。
 *
 * 唯一的取舍原则：**宁可不填，也不猜错**。每一步都必须唯一落在一份预设上，否则往下走。
 */

/** 一份「升级前」的配置：提供商没有 presetId（那个字段当年还不存在）。 */
function legacy(provider) {
  return normalizeConfig({
    version: 1,
    providers: [Object.assign({
      id: 'p1', name: 'P', apiKeyEnv: 'MO_IMAGE_P1_API_KEY', models: ['m'], names: {}
    }, provider)],
    active: { providerId: 'p1', model: 'm' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
}
const presetIdOf = (provider) => legacy(provider).providers[0].presetId;

/* ------------------------------------- 第 2 步：adapter 组里只有一条 */

test('adapter 唯一确定身份：地址随便写都还是那一份预设', () => {
  // 本地部署器的身份就是 adapter 本身：`:8189` 上的 ComfyUI 还是 ComfyUI。
  for (const baseUrl of [
    'http://127.0.0.1:8188',
    'http://127.0.0.1:8189',
    'http://localhost:8189',
    'http://192.168.1.5:8190',
    'http://comfy.lan:8190',
    'https://comfy.example.com',
    ''
  ]) {
    assert.equal(presetIdOf({ adapter: 'comfyui', baseUrl: baseUrl, optionalKey: true }), 'comfyui', baseUrl);
  }
  // 云端独用 adapter 的那几家同样不看地址（bfl / fal / recraft / 百炼两条协议各自独用）。
  assert.equal(presetIdOf({ adapter: 'bfl', baseUrl: 'http://127.0.0.1:8188' }), 'bfl');
  assert.equal(presetIdOf({ adapter: 'fal', baseUrl: 'https://anything.example' }), 'fal');
  assert.equal(presetIdOf({ adapter: 'dashscope-qwen-image', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' }), 'dashscope');
  assert.equal(presetIdOf({ adapter: 'dashscope-wanx', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' }), 'dashscope-wanx');
  // adapter 的大小写不参与判据。
  assert.equal(presetIdOf({ adapter: 'ComfyUI', baseUrl: 'http://127.0.0.1:8189' }), 'comfyui');
  assert.equal(presetIdOf({ adapter: '  comfyui  ', baseUrl: 'http://127.0.0.1:8189' }), 'comfyui');
});

test('adapter 与地址打架时信 adapter：地址可能只是没改', () => {
  // 典型场景：设置里先换了协议，忘了改地址（地址还留着上一份预设的默认值）。
  assert.equal(presetIdOf({ adapter: 'comfyui', baseUrl: 'https://api.openai.com/v1' }), 'comfyui');
  assert.equal(presetIdOf({ adapter: 'swarmui', baseUrl: 'http://127.0.0.1:8188' }), 'swarmui', 'ComfyUI 的端口也不抢');
  assert.equal(presetIdOf({ adapter: 'a1111', baseUrl: 'https://api.x.ai/v1' }), 'a1111');
});

/* --------------------------- 第 3 步：组内按地址认（openai-images 那 14 份） */

test('共用 adapter 的靠地址分开：openai-images + 各家官方地址各回各家', () => {
  const cases = [
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://api.together.xyz/v1', 'together'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    ['https://api.novita.ai/v3/openai', 'novita'],
    ['https://api.minimax.io/v1', 'minimax'],
    ['https://api.minimax.cn/v1', 'minimax-cn'],
    ['https://api.siliconflow.cn/v1', 'siliconflow'],
    ['https://open.bigmodel.cn/api/paas/v4', 'bigmodel'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'volcengine'],
    ['https://ark.cn-beijing.volces.com/api/plan/v3', 'volcengine-plan'],
    ['http://127.0.0.1:3000/v1', 'openai-gateway']
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: baseUrl }), expected, baseUrl);
  }
});

test('组内按地址比的是归一化后的地址：大小写 / 尾斜杠 / 省略的 /v1 都算同一个', () => {
  const cases = [
    'https://api.openai.com/v1/',
    'https://API.OpenAI.com/V1',
    'https://api.openai.com',
    'https://api.openai.com/v1//'
  ];
  for (const baseUrl of cases) {
    assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: baseUrl }), 'openai', baseUrl);
  }
});

test('回环主机是同一台机器：localhost / 127.0.0.1 / [::1] 三种写法都认', () => {
  // 预设登记的是 127.0.0.1，用户手填的多半是 localhost（复制粘贴友好）。
  for (const baseUrl of [
    'http://localhost:3000/v1',
    'http://[::1]:3000/v1',
    'http://LocalHost:3000/v1'
  ]) {
    assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: baseUrl, optionalKey: true }), 'openai-gateway', baseUrl);
  }
});

test('组内地址认不出（换过域名 / 路径 / 端口 / 查询串）：不回填', () => {
  const changed = [
    'https://my-relay.example/v1',                 // 换域名
    'https://api.openai.com/v2',                   // 同主机、换了版本路径
    'https://api.openai.com/v1/proxy',             // 同主机、加了前缀
    'https://api.openai.com.evil.test/v1',         // 后缀像，但不是同一个主机
    'https://api.openai.com/v1?token=abc',         // 加了查询串：地址已经不是一个字面
    'http://127.0.0.1:9999',                       // 本地部署换了端口（这组里有多条，不能猜）
    'https://gateway.example/v1'
  ];
  for (const baseUrl of changed) {
    assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: baseUrl }), undefined, baseUrl);
  }
});

test('组内地址命中多份预设（有歧义）：不填，别猜', () => {
  // 127.0.0.1:8080 上同时登记了 sd-server 与 LocalAI：地址分不出来。
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true }), undefined);
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'http://localhost:8080/v1', optionalKey: true }), undefined);
});

/* ------------------------------------- 第 4 步：组内按名称认 */

test('组内地址有歧义时用名称消歧：叫 LocalAI 的就是 LocalAI', () => {
  assert.equal(presetIdOf({
    adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', name: 'LocalAI', optionalKey: true
  }), 'localai');
  assert.equal(presetIdOf({
    adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', name: 'stable-diffusion.cpp (sd-server)', optionalKey: true
  }), 'sd-server');
  // 名称只做去空白 + 小写的归一。
  assert.equal(presetIdOf({
    adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', name: '  localai ', optionalKey: true
  }), 'localai');
  // 认不出的名字照样不填。
  assert.equal(presetIdOf({
    adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', name: 'My Gateway', optionalKey: true
  }), undefined);
});

test('azure 的预设地址是占位符：靠名称认（Azure OpenAI）', () => {
  // 地址里的 YOUR-RESOURCE 段是用户自己的资源名，地址永远比不中；名称是预设带来的。
  for (const baseUrl of [
    'https://my-resource.openai.azure.com/openai/v1',
    'https://my-resource.openai.azure.com/openai/v1/',
    'https://my-resource.services.ai.azure.com/openai/v1'
  ]) {
    assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: baseUrl, name: 'Azure OpenAI' }), 'azure', baseUrl);
  }
  // 名字改过、地址又比不中：不填（宁可不填，也不猜错）。
  assert.equal(presetIdOf({
    adapter: 'openai-images', baseUrl: 'https://my-resource.openai.azure.com/openai/v1', name: 'My Azure'
  }), undefined);
});

/* ------------------------------------- 第 5 步 / 兜底 */

test('空 adapter 不算身份：只按地址在「不绑 adapter」的预设里兜底', () => {
  // `openai` 这份预设本身没写 adapter（由地址/模型现选），地址对得上就认它。
  assert.equal(presetIdOf({ adapter: '', baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(presetIdOf({ baseUrl: 'https://api.openai.com/v1' }), 'openai');
  // 地址不像：不填。空白 adapter 当没写。
  assert.equal(presetIdOf({ adapter: '', baseUrl: 'https://my-relay.example/v1' }), undefined);
  assert.equal(presetIdOf({ adapter: '   ', baseUrl: 'https://my-relay.example/v1' }), undefined);
  // 空地址也不发明来源。
  assert.equal(presetIdOf({ baseUrl: '' }), undefined);
});

test('兜底只看地址：中转站把自己叫成 OpenAI 也不会被认成预设来源', () => {
  // 名称是用户随手起的，不能当证据：真按名字认，自建网关会被拽成 openai，
  // 协议设置整块藏起来——而他正要改的就是那个地址。
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'https://my-relay.example/v1', name: 'OpenAI' }), undefined);
  assert.equal(presetIdOf({ adapter: '', baseUrl: 'https://my-relay.example/v1', name: 'OpenAI' }), undefined);
});

test('认不出的 adapter 不进任何组：不回填', () => {
  // 老版本 / 手写的 adapter 字符串，或者根本不是预设来的（openai-chat 之类中间协议）。
  assert.equal(presetIdOf({ adapter: 'openai-chat', baseUrl: 'https://api.openai.com/v1' }), undefined);
  assert.equal(presetIdOf({ adapter: 'some-unknown', baseUrl: 'https://api.openai.com/v1' }), undefined);
});

test('自定义协议不推断来源：它的请求格式编辑器正住在「协议设置」里', () => {
  // 同一个地址，选了「自定义」就是要自己写请求形状：补一个来源会把他写的 JSON 藏起来。
  assert.equal(presetIdOf({
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'custom',
    operations: { version: 1, generate: { path: '/v1/images/generations', method: 'POST', output: 'binary' } }
  }), undefined);
  assert.equal(presetIdOf({ adapter: 'custom', baseUrl: 'https://api.openai.com/v1' }), undefined);
  assert.equal(presetIdForProvider('custom', 'https://api.openai.com/v1', 'OpenAI'), '');
});

/* ------------------------------------------------------------ 已有值不动 */

test('已有 presetId 一律不动：哪怕 adapter / 地址指向另一份预设', () => {
  assert.equal(presetIdOf({ presetId: 'together', adapter: 'openai-images', baseUrl: 'https://api.openai.com/v1' }), 'together');
  assert.equal(presetIdOf({ presetId: 'openai', adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8189' }), 'openai');
});

test('形状不对的 presetId 当作没写：照常按组推断', () => {
  // 存坏了的值本来就会被 normalizeConfig 丢掉；那就等于「没有来源」。
  assert.equal(presetIdOf({ presetId: 'has space', adapter: 'openai-images', baseUrl: 'https://api.openai.com/v1' }), 'openai');
});

test('自定义协议上已经写好的 presetId 不动（只跳过推断，不改既有值）', () => {
  assert.equal(presetIdOf({ presetId: 'openai', protocol: 'custom', baseUrl: 'https://api.openai.com/v1' }), 'openai');
});

/* ------------------------------------------------------------ 只补来源，不改行为 */

test('回填只补来源：adapter / 协议选项 / 鉴权 / 地址都不动', () => {
  const provider = legacy({
    baseUrl: 'https://api.openai.com/v1',
    adapter: 'openai-chat',
    protocolOptions: {},
    auth: { mode: 'api-key' }
  }).providers[0];
  // openai-chat 不在任何组里：这条只验证「补 / 不补都不动别的字段」。
  assert.equal(provider.adapter, 'openai-chat', '用户选过的协议原样保留');
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(provider.auth, { mode: 'api-key' });
  // 补得上的那种：来源有了，别的字段一模一样。
  const filled = legacy({
    baseUrl: 'https://api.x.ai/v1',
    adapter: 'openai-images',
    protocolOptions: { edit: 'same' },
    auth: { mode: 'x-key' }
  }).providers[0];
  assert.equal(filled.presetId, 'xai');
  assert.equal(filled.adapter, 'openai-images');
  assert.equal(filled.baseUrl, 'https://api.x.ai/v1');
  assert.deepEqual(filled.protocolOptions, { edit: 'same' });
  assert.deepEqual(filled.auth, { mode: 'x-key' });
});

/* ------------------------------------------------------------ 幂等 */

test('回填幂等：再跑一遍 normalizeConfig，结果一模一样', () => {
  const providers = [
    { id: 'p1', adapter: 'openai-images', baseUrl: 'https://api.openai.com/v1', models: ['m'] },
    { id: 'p2', adapter: 'openai-images', baseUrl: 'https://my-relay.example/v1', models: ['m'] },
    { id: 'p3', adapter: 'dashscope-qwen-image', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', models: ['m'] },
    { id: 'p4', adapter: 'comfyui', baseUrl: 'http://127.0.0.1:8189', optionalKey: true, models: ['m'] },
    { id: 'p5', adapter: 'openai-images', baseUrl: 'https://res.openai.azure.com/openai/v1', name: 'Azure OpenAI', models: ['m'] },
    { id: 'p6', adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', name: 'LocalAI', models: ['m'] },
    { id: 'p7', baseUrl: 'https://api.openai.com/v1', models: ['m'] }
  ];
  const once = normalizeConfig({
    version: 1, providers: providers, active: { providerId: 'p1', model: 'm' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  const twice = normalizeConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.deepEqual(once.providers.map((provider) => provider.presetId),
    ['openai', undefined, 'dashscope', 'comfyui', 'azure', 'localai', 'openai']);
});

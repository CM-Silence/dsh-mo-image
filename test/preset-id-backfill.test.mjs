import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config-store.js';

/**
 * presetId 是后加的字段：升级前建的第三方 / 本地配置里没有它，于是打开编辑被判成
 * 「自定义 API」，协议设置的折叠区又冒了出来。
 *
 * normalizeConfig 按**地址身份**把它补回来。回填只回答「这个提供商来自哪份预设」——
 * UI 判据（协议设置整块不渲染）、锁的默认值、一键配置都读这一个字段；adapter 与
 * 用户选过的协议一律原样保留。
 *
 * 唯一的取舍原则：**宁可不填，也不猜错**。地址必须唯一落在一份预设上，否则不补：
 * 命中多份（同一地址的两条预设）与零命中（自建网关）都不填。
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

/* ------------------------------------------------------------ 回填 */

test('老配置的地址就是预设地址：回填 presetId（地址归一化后再比）', () => {
  const cases = [
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.openai.com/v1/', 'openai'],            // 尾部斜杠
    ['https://API.OpenAI.com/V1', 'openai'],             // 大小写
    ['https://api.openai.com', 'openai'],                // 不带 /v1
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.minimax.cn/v1', 'minimax-cn'],
    ['https://ark.cn-beijing.volces.com/api/plan/v3', 'volcengine-plan'],
    ['https://api-inference.modelscope.cn', 'modelscope']
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(presetIdOf({ baseUrl: baseUrl }), expected, baseUrl);
  }
});

test('本地部署按默认地址的主机认：换路径 / 带尾斜杠都还是同一台', () => {
  const cases = [
    ['http://127.0.0.1:8188', 'comfyui'],
    ['http://127.0.0.1:8188/', 'comfyui'],
    ['http://127.0.0.1:7860', 'a1111'],
    ['http://127.0.0.1:7801', 'swarmui'],
    ['http://127.0.0.1:3000/v1', 'openai-gateway']
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(presetIdOf({ baseUrl: baseUrl, optionalKey: true }), expected, baseUrl);
  }
});

test('回环主机是同一台机器：localhost / 127.0.0.1 / [::1] 三种写法都认', () => {
  // 预设登记的是 127.0.0.1，用户手填的多半是 localhost（复制粘贴友好）。
  // 同一条预设换个回环写法不该变成「自定义 API」——那会把协议设置重新翻出来。
  const cases = [
    ['http://localhost:8188', 'comfyui'],
    ['http://localhost:8188/', 'comfyui'],
    ['http://localhost:7860', 'a1111'],
    ['http://[::1]:7860', 'a1111'],
    ['http://[::1]:8188', 'comfyui'],
    ['http://LocalHost:8188', 'comfyui'],                  // 主机名大小写
    ['http://[0:0:0:0:0:0:0:1]:8188', 'comfyui'],         // IPv6 回环的完整写法
    ['http://localhost:8188/v1', 'comfyui']               // 路径本来就不参与本地预设的判据
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(presetIdOf({ baseUrl: baseUrl, optionalKey: true }), expected, baseUrl);
  }
});

test('只做回环这一条等价：同端口的不同机器 / 别的回环地址都不认，云端仍严格比对', () => {
  // 放宽到「同端口就算同一台」会把 192.168.1.5:8188 也认成 ComfyUI——共享主机或反向
  // 代理后面那台机器跑的什么都可能，猜错比不填更糟。
  const unchanged = [
    'http://192.168.1.5:8188',        // 局域网里另一台机器，端口恰好相同
    'http://10.0.0.2:7860',
    'http://127.0.0.2:8188',          // 127.0.0.0/8 里只有 127.0.0.1 属于这条等价
    'http://[::1]:9999',              // 回环写法对，端口不对
    'http://localhost',               // 本地预设都登记了端口
    'https://api.openai.com:8443/v1'  // 云端仍按整条地址比：换了端口就不认
  ];
  for (const baseUrl of unchanged) {
    assert.equal(presetIdOf({ baseUrl: baseUrl }), undefined, baseUrl);
  }
  // 云端地址本身不受这条规则影响。
  assert.equal(presetIdOf({ baseUrl: 'https://api.openai.com/v1' }), 'openai');
});

test('azure 的预设地址是占位符：按主机后缀认（*.openai.azure.com）', () => {
  for (const baseUrl of [
    'https://my-resource.openai.azure.com/openai/v1',
    'https://my-resource.openai.azure.com/openai/v1/',
    'https://YOUR-RESOURCE.openai.azure.com/openai/v1', // 用户没改占位符，照抄了预设
    'https://my-resource.services.ai.azure.com/openai/v1'
  ]) {
    assert.equal(presetIdOf({ baseUrl: baseUrl }), 'azure', baseUrl);
  }
});

/* ------------------------------------------------------------ 不回填 */

test('手改过地址 = 换了一家网关：不回填（否则会重新藏起他要的协议设置）', () => {
  const changed = [
    'https://my-relay.example/v1',                 // 换域名
    'https://api.openai.com/v2',                   // 同主机、换了版本路径
    'https://api.openai.com/v1/proxy',             // 同主机、加了前缀
    'https://api.openai.com.evil.test/v1',         // 后缀像，但不是同一个主机
    'https://api.openai.com/v1?token=abc',         // 加了查询串：地址已经不是一个字面
    'http://127.0.0.1:9999',                       // 本地部署换了端口
    'https://gateway.example/v1'                   // 自建网关
  ];
  for (const baseUrl of changed) {
    assert.equal(presetIdOf({ baseUrl: baseUrl }), undefined, baseUrl);
  }
});

test('地址命中多份预设（有歧义）：不回填，不猜', () => {
  // 百炼的两份预设是同一个地址（Qwen-Image / 通义万相）：只凭地址分不出来。
  assert.equal(presetIdOf({ baseUrl: 'https://dashscope.aliyuncs.com/api/v1' }), undefined, 'dashscope 地址');
  // 127.0.0.1:8080 上同时登记了 sd-server 与 LocalAI。
  assert.equal(presetIdOf({ baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true }), undefined, '8080 地址');
  // 换成回环写法也还是那两份，不能因为归一化而少认成一份。
  assert.equal(presetIdOf({ baseUrl: 'http://localhost:8080/v1', optionalKey: true }), undefined, 'localhost:8080 地址');
});

test('空地址不发明 presetId', () => {
  assert.equal(presetIdOf({ baseUrl: '' }), undefined);
});

/* ------------------------------------------------------------ 已有值不动 */

test('已有 presetId 一律不动：哪怕地址像另一份预设', () => {
  assert.equal(presetIdOf({ presetId: 'together', baseUrl: 'https://api.openai.com/v1' }), 'together');
  assert.equal(presetIdOf({ presetId: 'openai', baseUrl: 'https://my-relay.example/v1' }), 'openai');
});

test('形状不对的 presetId 当作没写：仍按地址推断', () => {
  // 存坏了的值本来就会被 normalizeConfig 丢掉；那就等于「没有来源」，照地址认。
  assert.equal(presetIdOf({ presetId: 'has space', baseUrl: 'https://api.openai.com/v1' }), 'openai');
});

test('自定义协议不推断来源：它的请求格式编辑器正住在「协议设置」里', () => {
  // 同一个地址，选了「自定义」就是要自己写请求形状：补一个来源会把他写的 JSON 藏起来。
  assert.equal(presetIdOf({
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'custom',
    operations: { version: 1, generate: { path: '/v1/images/generations', method: 'POST', output: 'binary' } }
  }), undefined);
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
  assert.equal(provider.presetId, 'openai', '来源补上了');
  assert.equal(provider.adapter, 'openai-chat', '用户选过的协议原样保留');
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(provider.auth, { mode: 'api-key' });
});

/* ------------------------------------------------------------ 幂等 */

test('回填幂等：再跑一遍 normalizeConfig，结果一模一样', () => {
  const providers = [
    { id: 'p1', baseUrl: 'https://api.openai.com/v1', models: ['m'] },
    { id: 'p2', baseUrl: 'https://my-relay.example/v1', models: ['m'] },
    { id: 'p3', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', models: ['m'] },
    { id: 'p4', baseUrl: 'http://127.0.0.1:8188', optionalKey: true, models: ['m'] },
    { id: 'p5', baseUrl: 'https://res.openai.azure.com/openai/v1', models: ['m'] }
  ];
  const once = normalizeConfig({
    version: 1, providers: providers, active: { providerId: 'p1', model: 'm' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  const twice = normalizeConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.deepEqual(once.providers.map((provider) => provider.presetId),
    ['openai', undefined, undefined, 'comfyui', 'azure']);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config-store.js';

/**
 * presetId 是后加的字段：升级前建的第三方 / 本地配置里没有它，于是打开编辑被判成
 * 「自定义 API」，协议设置的折叠区又冒了出来。
 *
 * normalizeConfig 把它补回来，判定分三级，**先命中先返回**：
 *
 *   1. **adapter 唯一命中**：这个 adapter 只对应一份预设 → 直接用它，地址完全不看。
 *      本地三条（comfyui / a1111 / swarmui）走这条：换了端口、换了主机名、挂在反代后面
 *      都还是同一个部署器。共用 adapter 的（openai-images 那十几份）落到第 2 步。
 *   2. **地址唯一命中**：现有逻辑（含回环等价与主机后缀）。
 *   3. 都不唯一 → 不回填。
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

/* -------------------------------------------- 第一级：adapter 唯一命中 */

test('adapter 唯一命中就按 adapter 认：comfyui 换个端口也还是 ComfyUI', () => {
  // 端口只说明「这台机器上开的是哪个服务」，不说明「装的是哪个部署器」。8189 不在任何
  // 预设地址里，地址这一级认不出来 —— 但 adapter 是用户显式选的，唯一落在 comfyui 上。
  // 升级前建的本地配置正是这个形状：地址照抄了自己改过的端口，adapter 也一起存了。
  const cases = [
    'http://127.0.0.1:8189',
    'http://localhost:8189',
    'http://192.168.1.5:8190',
    'http://comfy.lan:8190',
    'https://comfy.example.com'
  ];
  for (const baseUrl of cases) {
    assert.equal(presetIdOf({ adapter: 'comfyui', baseUrl: baseUrl, optionalKey: true }), 'comfyui', baseUrl);
  }
  // adapter 的大小写不参与判据：落盘的是用户写的原样，解析时（pickAdapter）也是小写化的。
  assert.equal(presetIdOf({ adapter: 'ComfyUI', baseUrl: 'http://127.0.0.1:8189' }), 'comfyui');
  assert.equal(presetIdOf({ adapter: '  comfyui  ', baseUrl: 'http://127.0.0.1:8189' }), 'comfyui');
});

test('a1111 / swarmui 的 adapter 与主机无关：任意地址都是那一份预设', () => {
  for (const baseUrl of ['http://127.0.0.1:7861', 'http://localhost:7860', 'http://10.0.0.2:8080', 'https://a1111.my-host.example', '']) {
    assert.equal(presetIdOf({ adapter: 'a1111', baseUrl: baseUrl, optionalKey: true }), 'a1111', baseUrl);
  }
  for (const baseUrl of ['http://127.0.0.1:7802', 'http://swarm.lan', 'https://swarmui.example.com']) {
    assert.equal(presetIdOf({ adapter: 'swarmui', baseUrl: baseUrl, optionalKey: true }), 'swarmui', baseUrl);
  }
});

test('adapter 与地址打架时信 adapter：地址可能只是没改', () => {
  // 典型场景：在设置里先换了协议，忘了改地址（地址还留着上一份预设的默认值）。
  // 这时 adapter 才是用户的显式选择 —— 请求形状、字段模板、锁的默认值都跟着它走。
  // 若让地址赢，来源会被拽成 openai：协议设置整块藏起来，用户反而看不到自己正要改的地址。
  assert.equal(presetIdOf({ adapter: 'comfyui', baseUrl: 'https://api.openai.com/v1' }), 'comfyui');
  assert.equal(presetIdOf({ adapter: 'swarmui', baseUrl: 'http://127.0.0.1:8188' }), 'swarmui', 'ComfyUI 的端口也不抢');
  assert.equal(presetIdOf({ adapter: 'a1111', baseUrl: 'https://api.x.ai/v1' }), 'a1111');
  // 反方向也一样：地址像本地，adapter 是云端 —— 仍然按 adapter。
  assert.equal(presetIdOf({ adapter: 'bfl', baseUrl: 'http://127.0.0.1:8188' }), 'bfl');
});

test('adapter 空着不算证据（那是「还没选」）：仍然只按地址判', () => {
  // `openai` 这份预设本身就没写 adapter（由地址/模型现选），所以「adapter 为空」绝不能
  // 反推出 openai —— 手填的中转站 adapter 也是空的。空 adapter 直接落到第二级。
  assert.equal(presetIdOf({ adapter: '', baseUrl: 'https://api.openai.com/v1' }), 'openai', '地址说了算');
  assert.equal(presetIdOf({ adapter: '', baseUrl: 'https://my-relay.example/v1' }), undefined, '地址也不像：不填');
  assert.equal(presetIdOf({ adapter: '   ', baseUrl: 'https://my-relay.example/v1' }), undefined, '空白当没写');
});

/* -------------------------------------------- 第二级：adapter 不唯一时退回地址 */

test('adapter 对应多份预设：退回按地址认（openai-images 那十几份）', () => {
  // openai-images 被云端中转与三条本地预设共用，光凭 adapter 分不出来 —— 这时才轮到地址。
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'https://api.x.ai/v1' }), 'xai');
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'https://api.together.xyz/v1' }), 'together');
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'https://api-inference.modelscope.cn' }), 'modelscope');
  // 地址也不是任何一份预设的：两级都没命中，不填。
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'https://my-relay.example/v1' }), undefined);
});

test('两条本地预设共用 adapter（sd-server / LocalAI）：adapter 不唯一，地址也不唯一 → 不填', () => {
  // 127.0.0.1:8080 上同时登记了两份预设，adapter 也同为 openai-images：两边都分不出来。
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true }), undefined);
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'http://localhost:8080/v1', optionalKey: true }), undefined);
  // 换个端口（不再是任何预设地址）：第一级不唯一、第二级零命中 → 还是不填。
  assert.equal(presetIdOf({ adapter: 'openai-images', baseUrl: 'http://127.0.0.1:1234/v1', optionalKey: true }), undefined);
});

test('认不出的 adapter 不进第一级：照旧只看地址', () => {
  // 老版本 / 手写的 adapter 字符串，或者根本不是预设来的（openai-chat 之类中间协议）。
  assert.equal(presetIdOf({ adapter: 'openai-chat', baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(presetIdOf({ adapter: 'some-unknown', baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(presetIdOf({ adapter: 'some-unknown', baseUrl: 'https://my-relay.example/v1' }), undefined);
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
  // adapter 上写的 custom 同理：它不是清单里的一条，也不是任何一份预设的 adapter。
  assert.equal(presetIdOf({ adapter: 'custom', baseUrl: 'https://api.openai.com/v1' }), undefined);
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
    { id: 'p5', baseUrl: 'https://res.openai.azure.com/openai/v1', models: ['m'] },
    // adapter 一级命中的：补一次之后就有 presetId 了，再跑一遍读到同一个值。
    { id: 'p6', baseUrl: 'http://127.0.0.1:8189', adapter: 'comfyui', optionalKey: true, models: ['m'] },
    { id: 'p7', baseUrl: 'https://api.openai.com/v1', adapter: 'comfyui', models: ['m'] }
  ];
  const once = normalizeConfig({
    version: 1, providers: providers, active: { providerId: 'p1', model: 'm' },
    defaults: { quality: 'high', auto: true, width: 1024, height: 1024 }
  });
  const twice = normalizeConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.deepEqual(once.providers.map((provider) => provider.presetId),
    ['openai', undefined, undefined, 'comfyui', 'azure', 'comfyui', 'comfyui']);
});

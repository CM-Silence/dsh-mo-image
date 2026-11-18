/**
 * 鉴权方式是**提供商自己的字段**（`provider.auth`），不再是协议级选项。
 *
 * 为什么要独立出来：鉴权回答的是「这个地址怎么认证」，与「说哪种协议」是两件事。
 * 挂在协议下面时，切到 ComfyUI / 百炼 / Gemini 这些没声明 auth 的协议，下拉就消失了，
 * 于是「本地 ComfyUI 前面挂了反代要带 X-API-Key」这类场景根本填不出来。
 *
 * 这里锁四件事：
 *   1. 五种模式各自产出的请求头（bearer / api-key / x-key / fal-key / custom）；
 *   2. `provider.auth` 没设时回落到协议自己的默认值（adapter.authHeader），没有协议时回落到 bearer；
 *   3. 老配置的 `protocolOptions.auth`（只有 bearer / api-key）迁移成 `provider.auth.mode`，
 *      写回时不再出现 `protocolOptions.auth`，但同层的其它选项（edit）一个字都不许丢；
 *   4. normalizeConfig 的校验：mode 白名单、头名 `/^[A-Za-z0-9-]{1,64}$/`、prefix 长度上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { authHeaders, normalizeAuthSpec } from '../lib/adapter-kit.js';
import { normalizeConfig } from '../lib/config-store.js';
import { prepareGenerate, resolveAdapter } from '../lib/adapters.js';

const KEY = 'sk-test';

/** 直接问鉴权头：provider.auth 优先，adapter.authHeader 只是默认值。 */
function headersOf(auth, adapter, key = KEY) {
  return authHeaders({ key: key, auth: auth }, adapter);
}

test('五种模式各自产出的请求头', () => {
  const cases = [
    [{ mode: 'bearer' }, { Authorization: 'Bearer ' + KEY }],
    [{ mode: 'api-key' }, { 'api-key': KEY }],
    [{ mode: 'x-key' }, { 'x-key': KEY }],
    [{ mode: 'fal-key' }, { Authorization: 'Key ' + KEY }],
    // custom 用头名 + 前缀：prefix 为空就是裸 key，有前缀就原样拼在前面。
    [{ mode: 'custom', header: 'X-API-Key', prefix: '' }, { 'X-API-Key': KEY }],
    [{ mode: 'custom', header: 'Authorization', prefix: 'Token ' }, { Authorization: 'Token ' + KEY }]
  ];
  for (const [auth, expected] of cases) {
    assert.deepEqual(headersOf(auth, { authHeader: 'bearer' }), expected, JSON.stringify(auth));
  }
});

test('provider.auth 缺省时回落到协议自己的默认鉴权形态', () => {
  assert.deepEqual(headersOf(undefined, { authHeader: 'api-key' }), { 'api-key': KEY });
  assert.deepEqual(headersOf(undefined, { authHeader: 'x-key' }), { 'x-key': KEY });
  assert.deepEqual(headersOf(undefined, { authHeader: 'fal-key' }), { Authorization: 'Key ' + KEY });
  assert.deepEqual(headersOf({}, { authHeader: 'bearer' }), { Authorization: 'Bearer ' + KEY });
  // 没有协议（ComfyUI 的 /object_info、轮询这类没有 adapter 的调用点）也回落到 bearer。
  assert.deepEqual(headersOf(undefined, null), { Authorization: 'Bearer ' + KEY });
  // 没有 key 就不带任何鉴权头，五种模式都一样。
  for (const mode of ['bearer', 'api-key', 'x-key', 'fal-key']) {
    assert.deepEqual(headersOf({ mode: mode }, null, ''), {}, mode);
  }
  assert.deepEqual(headersOf({ mode: 'custom', header: 'X-API-Key' }, null, ''), {});
});

test('provider.auth 压过协议默认值（同一协议换鉴权方式）', () => {
  assert.deepEqual(headersOf({ mode: 'bearer' }, { authHeader: 'fal-key' }), { Authorization: 'Bearer ' + KEY });
  assert.deepEqual(headersOf({ mode: 'x-key' }, { authHeader: 'bearer' }), { 'x-key': KEY });
  assert.deepEqual(headersOf({ mode: 'api-key' }, { authHeader: 'x-key' }), { 'api-key': KEY });
});

test('认不出的模式回落到协议默认值；custom 缺头名时回落到 bearer', () => {
  assert.deepEqual(headersOf({ mode: 'nope' }, { authHeader: 'api-key' }), { 'api-key': KEY });
  assert.deepEqual(headersOf({ mode: 'nope' }, null), { Authorization: 'Bearer ' + KEY });
  assert.deepEqual(headersOf({ mode: 'custom' }, null), { Authorization: 'Bearer ' + KEY });
  // 头名不是合法的 HTTP 头（空格 / 冒号 / 换行）一律不认，免得把请求写坏。
  assert.deepEqual(headersOf({ mode: 'custom', header: 'X API Key' }, null), { Authorization: 'Bearer ' + KEY });
  assert.deepEqual(headersOf({ mode: 'custom', header: 'X-API-Key\r\nX-Evil: 1' }, null), { Authorization: 'Bearer ' + KEY });
});

test('请求头真的进到请求里（prepareGenerate 是线上唯一出口）', () => {
  const input = { model: 'flux-1', prompt: 'p', fitted: { width: 1024, height: 1024, size: '1024x1024' } };
  const cases = [
    [{ mode: 'bearer' }, 'Authorization', 'Bearer ' + KEY],
    [{ mode: 'api-key' }, 'api-key', KEY],
    [{ mode: 'x-key' }, 'x-key', KEY],
    [{ mode: 'fal-key' }, 'Authorization', 'Key ' + KEY],
    [{ mode: 'custom', header: 'X-API-Key', prefix: 'k ' }, 'X-API-Key', 'k ' + KEY]
  ];
  for (const [auth, header, value] of cases) {
    const provider = { baseUrl: 'https://gateway.example/v1', adapter: 'openai-images', key: KEY, auth: auth };
    const built = prepareGenerate(resolveAdapter(provider, 'flux-1'), provider, input, new Set());
    assert.equal(built.headers[header], value, JSON.stringify(auth));
  }
});

test('鉴权方式只改请求头，不改请求体', () => {
  const input = { model: 'flux-1', prompt: 'p', fitted: { width: 1024, height: 1024, size: '1024x1024' } };
  const bodyOf = (auth) => {
    const provider = { baseUrl: 'https://gateway.example/v1', adapter: 'openai-images', key: KEY, auth: auth };
    return prepareGenerate(resolveAdapter(provider, 'flux-1'), provider, input, new Set()).body;
  };
  const bearer = bodyOf({ mode: 'bearer' });
  for (const auth of [{ mode: 'api-key' }, { mode: 'x-key' }, { mode: 'fal-key' }, { mode: 'custom', header: 'X-API-Key' }]) {
    assert.equal(bodyOf(auth), bearer, JSON.stringify(auth));
  }
});

/* ------------------------------------------------------- normalizeConfig 校验 */

function normalized(extra) {
  return normalizeConfig({
    providers: [Object.assign({ id: 'p1', name: 'relay', baseUrl: 'https://gateway.example/v1', models: ['m'] }, extra)],
    active: { providerId: 'p1', model: 'm' }
  }).providers[0];
}

test("老配置的 protocolOptions.auth 迁到 provider.auth.mode，其它协议选项保留", () => {
  const provider = normalized({ adapter: 'openai-images', protocolOptions: { edit: 'same', auth: 'api-key' } });
  assert.deepEqual(provider.auth, { mode: 'api-key' });
  assert.deepEqual(provider.protocolOptions, { edit: 'same' }, 'auth 不该再写回协议选项，edit 不能丢');
});

test('老配置 protocolOptions.auth:"bearer" 也照原样迁过来', () => {
  const provider = normalized({ adapter: 'openai-images', protocolOptions: { auth: 'bearer' } });
  assert.deepEqual(provider.auth, { mode: 'bearer' });
  assert.equal(provider.protocolOptions, undefined);
});

test("老协议 id azure-openai 升级成 openai-images + provider.auth.mode='api-key'", () => {
  const provider = normalized({ adapter: 'azure-openai', baseUrl: 'https://res.openai.azure.com/openai/v1' });
  assert.equal(provider.adapter, 'openai-images');
  assert.deepEqual(provider.auth, { mode: 'api-key' });
  assert.equal(provider.protocolOptions, undefined);
});

test('迁移后的老配置能直接跑：请求头就是 api-key', () => {
  const provider = normalized({ adapter: 'azure-openai', baseUrl: 'https://res.openai.azure.com/openai/v1', key: KEY });
  provider.key = KEY; // key 会进凭据库；这里只验证请求头
  const built = prepareGenerate(resolveAdapter(provider, 'my-deployment'), provider, {
    model: 'my-deployment', prompt: 'p', fitted: { width: 1024, height: 1024, size: '1024x1024' }
  }, new Set());
  assert.equal(built.headers['api-key'], KEY);
  assert.equal(built.headers.Authorization, undefined);
});

test('provider.auth 落盘形状：明文外的一切都按白名单收', () => {
  // 五种模式都留，且非 custom 的 header / prefix 不落盘。
  for (const mode of ['bearer', 'api-key', 'x-key', 'fal-key']) {
    const provider = normalized({ auth: { mode: mode, header: 'X-API-Key', prefix: 'Bearer ' } });
    assert.deepEqual(provider.auth, { mode: mode }, mode);
  }
  assert.deepEqual(
    normalized({ auth: { mode: 'custom', header: 'X-API-Key', prefix: 'Bearer ' } }).auth,
    { mode: 'custom', header: 'X-API-Key', prefix: 'Bearer ' }
  );
  // mode 白名单之外一律不落盘（缺省 = bearer）。
  assert.equal(normalized({ auth: { mode: 'bogus' } }).auth, undefined);
  assert.equal(normalized({ auth: 'api-key' }).auth, undefined, '字符串老形状不算合法 provider.auth');
  assert.equal(normalized({ auth: {} }).auth, undefined);
  assert.equal(normalized({}).auth, undefined, '没设过就不能凭空写一个 auth 字段');
});

test('custom 的头名走 /^[A-Za-z0-9-]{1,64}$/，prefix 有长度上限', () => {
  // 合法字符集：字母、数字、连字符。
  assert.deepEqual(normalized({ auth: { mode: 'custom', header: 'X-Api-Key-2' } }).auth, { mode: 'custom', header: 'X-Api-Key-2' });
  // 头名里的空格 / 冒号 / 下划线都不收 → 这条 custom 没有头名，等于没设（回落到 bearer）。
  assert.equal(normalized({ auth: { mode: 'custom', header: 'X Api Key' } }).auth, undefined);
  assert.equal(normalized({ auth: { mode: 'custom', header: 'X_API_KEY' } }).auth, undefined);
  assert.equal(normalized({ auth: { mode: 'custom', header: '' } }).auth, undefined);
  assert.equal(normalized({ auth: { mode: 'custom', header: 'A'.repeat(65) } }).auth, undefined);
  assert.equal(normalized({ auth: { mode: 'custom', header: 'A'.repeat(64) } }).auth.header, 'A'.repeat(64));
  // prefix 截到 64 个字符。
  const prefix = normalized({ auth: { mode: 'custom', header: 'X-API-Key', prefix: 'p'.repeat(100) } }).auth.prefix;
  assert.equal(prefix.length, 64);
  // 空 prefix 不落盘（空字符串与「没写」等价）。
  assert.equal(normalized({ auth: { mode: 'custom', header: 'X-API-Key', prefix: '' } }).auth.prefix, undefined);
});

test('normalizeAuthSpec 是这套校验的唯一出口', () => {
  assert.equal(normalizeAuthSpec(undefined), null);
  assert.equal(normalizeAuthSpec({ mode: 'bogus' }), null);
  assert.deepEqual(normalizeAuthSpec({ mode: 'x-key' }), { mode: 'x-key' });
  assert.deepEqual(normalizeAuthSpec({ mode: 'custom', header: 'X-API-Key', prefix: 'k ' }), { mode: 'custom', header: 'X-API-Key', prefix: 'k ' });
});

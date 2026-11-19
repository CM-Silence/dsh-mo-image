import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/config-store.js';
import { providerPresetManifest, selectedProtocolOf } from '../lib/adapters.js';

/**
 * 「未选择 API 协议」是有意义的状态，不是「自动」：
 *
 * 协议决定路径、字段名和响应解析，所以没选就不发请求（以前拿协议表的最后一条
 * openai-images 兜底蒙一把，界面还写着「自动」）。这里钉住三件事：
 *   1. 预设自己写着协议，不从兜底推；
 *   2. normalizeConfig 只为**有证据**的老配置补 adapter（具体 protocol id / 客户端写的 presetId），
 *      没有证据就保持空；
 *   3. 宿主侧有一个稳定判据（selectedProtocolOf）给请求前的守卫用。
 */

const DEFAULTS = {};

function normalize(provider) {
  const config = normalizeConfig({
    version: 1,
    providers: [Object.assign({ id: 'p1', name: 'Relay', baseUrl: 'https://relay.example/v1', models: ['m'], names: {} }, provider)],
    active: { providerId: 'p1', model: 'm' },
    defaults: DEFAULTS
  });
  return config.providers[0];
}

test('openai 预设写着自己的协议，不靠「协议表最后一条」兜底', () => {
  const openai = providerPresetManifest().find((preset) => preset.id === 'openai');
  assert.ok(openai, 'openai 预设在');
  assert.equal(openai.adapter, 'openai-images', 'OpenAI 官方就是 OpenAI Images 形状');
});

test('没有任何协议证据：normalizeConfig 保持「未选择」，不替用户猜', () => {
  const provider = normalize({});
  assert.equal(provider.adapter, '', '没选就是没选');
  assert.equal(selectedProtocolOf(provider), '', '宿主侧判定为「未选择」');
});

test('老配置里 protocol 就是具体协议 id：迁移成 adapter（那是真的选过）', () => {
  const provider = normalize({ protocol: 'google-gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  assert.equal(provider.adapter, 'google-gemini', 'protocol 里的具体 id 落到 adapter');
  assert.equal(selectedProtocolOf(provider), 'google-gemini');
});

test('从预设建的提供商（客户端写了 presetId）：补上预设里的协议', () => {
  const provider = normalize({ presetId: 'openai', baseUrl: 'https://api.openai.com/v1' });
  assert.equal(provider.adapter, 'openai-images', '老配置里 adapter 为空、presetId 在的那批靠这条自愈');
});

test('老协议 id 的迁移照旧生效，不因为这次改动丢掉', () => {
  const provider = normalize({ protocol: 'azure-openai', baseUrl: 'https://example.openai.azure.com' });
  assert.equal(provider.adapter, 'openai-images');
  assert.equal(selectedProtocolOf(provider), 'openai-images');
});

test('自定义协议也是显式协议：selectedProtocolOf 认得它', () => {
  assert.equal(selectedProtocolOf({ adapter: 'custom', customEndpoints: { generate: 'https://g.example/render' } }), 'custom');
  // protocol 写着 custom、adapter 还没写的老配置：normalizeConfig 会落到 adapter。
  assert.equal(selectedProtocolOf(normalize({ protocol: 'custom' })), 'custom');
});

test('通用/无信息量的 protocol 值不算证据', () => {
  for (const protocol of ['auto', 'images', 'openai-images']) {
    const provider = normalize({ protocol });
    assert.equal(selectedProtocolOf(provider), '', protocol + ' 说的是「看 adapter」，不是一条具体协议');
  }
});

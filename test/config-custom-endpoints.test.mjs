import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config-store.js';

test('自定义协议的三条地址会被保留', () => {
  const out = normalizeConfig({ providers: [{
    id: 'p1', name: '网关', baseUrl: '', adapter: 'custom',
    customEndpoints: {
      generate: 'https://gateway.example/v1/images/generations',
      edit: ' https://gateway.example/v1/images/edits ',
      models: ''
    }
  }] });
  assert.deepEqual(out.providers[0].customEndpoints, {
    generate: 'https://gateway.example/v1/images/generations',
    edit: 'https://gateway.example/v1/images/edits',
    models: ''
  });
});

test('没填 baseUrl 时从文生图地址推导', () => {
  const out = normalizeConfig({ providers: [{
    id: 'p1', name: '网关', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: 'https://gateway.example/v1/images/generations', edit: '', models: '' }
  }] });
  assert.equal(out.providers[0].baseUrl, 'https://gateway.example');
});

test('相对地址不推导 baseUrl', () => {
  const out = normalizeConfig({ providers: [{
    id: 'p1', name: '网关', baseUrl: '', adapter: 'custom',
    customEndpoints: { generate: '/v1/images/generations', edit: '', models: '' }
  }] });
  assert.equal(out.providers[0].baseUrl, '');
});

test('非自定义协议不保留 customEndpoints', () => {
  const out = normalizeConfig({ providers: [{
    id: 'p1', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '',
    customEndpoints: { generate: 'https://g.example/x', edit: '', models: '' }
  }] });
  assert.equal(out.providers[0].customEndpoints, undefined);
});

test('旧配置没有该字段时不崩', () => {
  const out = normalizeConfig({ providers: [{ id: 'p1', name: 'x', baseUrl: 'https://a.example/v1', adapter: '' }] });
  assert.equal(out.providers.length, 1);
  assert.equal(out.providers[0].customEndpoints, undefined);
});

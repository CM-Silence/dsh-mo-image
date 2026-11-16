import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdapter, prepareGenerate, prepareEdit, adapterSupportsKind } from '../lib/adapters.js';

const OMIT = { omit: true };

function provider(extra) {
  return Object.assign({
    baseUrl: 'https://gateway.example/v1',
    key: 'k',
    adapter: 'custom',
    customEndpoints: {
      generate: 'https://gateway.example/v1/images/generations',
      edit: '',
      models: ''
    }
  }, extra || {});
}

test('custom 协议用用户填的绝对地址', () => {
  const config = provider();
  const adapter = resolveAdapter(config, '');
  const request = prepareGenerate(adapter, config, { prompt: 'a cat', model: 'flux', n: 1, fitted: OMIT }, new Set());
  assert.equal(request.path, 'https://gateway.example/v1/images/generations');
});

test('custom 协议支持相对地址', () => {
  const config = provider({ customEndpoints: { generate: '/v1/images/generations', edit: '', models: '' } });
  const adapter = resolveAdapter(config, '');
  const request = prepareGenerate(adapter, config, { prompt: 'a cat', model: 'flux', n: 1, fitted: OMIT }, new Set());
  assert.equal(request.path, '/v1/images/generations');
});

test('custom 协议图生图留空即不支持', () => {
  const adapter = resolveAdapter(provider(), '');
  assert.equal(adapterSupportsKind(adapter, 'generate'), true);
  assert.equal(adapterSupportsKind(adapter, 'edit'), false);
});

test('custom 协议填了图生图地址就能走 multipart', () => {
  const config = provider({
    customEndpoints: {
      generate: 'https://g.example/v1/images/generations',
      edit: 'https://g.example/v1/images/edits',
      models: ''
    }
  });
  const adapter = resolveAdapter(config, '');
  assert.equal(adapterSupportsKind(adapter, 'edit'), true);
  const request = prepareEdit(adapter, config, {
    prompt: 'x',
    model: 'flux',
    fitted: OMIT,
    images: [{ buffer: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png', filename: 'a.png' }]
  }, new Set());
  assert.equal(request.path, 'https://g.example/v1/images/edits');
  assert.equal(adapter.transport.edit, 'multipart');
});

test('custom 协议的路由镜像用户填的地址', () => {
  const adapter = resolveAdapter(provider(), '');
  assert.equal(adapter.id, 'custom');
  assert.deepEqual(adapter.routes, {
    generate: 'https://gateway.example/v1/images/generations',
    edit: '',
    models: ''
  });
});

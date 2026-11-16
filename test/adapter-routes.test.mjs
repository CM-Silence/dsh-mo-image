import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listAdapters, adapterManifest, resolveAdapter, listProviderModels } from '../lib/adapters.js';

// 三个键必须齐全，值要么是非空字符串、要么是空串（空串 = 该操作原生不支持）
test('every adapter declares generate/edit/models routes', () => {
  const manifest = adapterManifest();
  for (const { id } of listAdapters()) {
    const entry = manifest.find((item) => item.id === id);
    assert.ok(entry, 'manifest 里缺少 ' + id);
    assert.deepEqual(Object.keys(entry.routes || {}).sort(), ['edit', 'generate', 'models'], id);
    for (const value of Object.values(entry.routes)) assert.equal(typeof value, 'string', id);
  }
});

// 这两个适配器自己拼路径（google 拼 /{model}:generateContent，ideogram 在
// /generate 和 /remix 之间选），endpoints 只是个占位，routes 才是给人看的模板。
const ROUTE_TEMPLATE_EXEMPT = new Set(['google-gemini', 'ideogram']);

// 字符串型 endpoints 与 routes 必须一致，防止两处漂移
test('string endpoints agree with routes', () => {
  const manifest = adapterManifest();
  for (const { id } of listAdapters()) {
    if (ROUTE_TEMPLATE_EXEMPT.has(id)) continue;
    const adapter = resolveAdapter({ protocol: id }, '');
    const route = manifest.find((item) => item.id === id).routes;
    if (typeof adapter.endpoints.generate === 'string') {
      assert.equal(route.generate, adapter.endpoints.generate, id);
    }
    if (!adapter.endpoints.edit) {
      assert.equal(route.edit, '', id);
    } else if (typeof adapter.endpoints.edit === 'string') {
      assert.equal(route.edit, adapter.endpoints.edit, id);
    }
  }
});

// 空串只允许出现在真正不支持的那一侧：有图生图就必须有地址
test('routes never advertise an unsupported edit endpoint', () => {
  const manifest = adapterManifest();
  for (const { id } of listAdapters()) {
    const adapter = resolveAdapter({ protocol: id }, '');
    const route = manifest.find((item) => item.id === id).routes;
    assert.equal(route.edit !== '', Boolean(adapter.endpoints.edit), id);
  }
});

// 没有专用 listModels 的协议（Together 这类）按 routes.models 拉一次
test('adapters without listModels fall back to routes.models', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'flux-1' }, { id: 'flux-pro' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  try {
    const adapter = resolveAdapter({ protocol: 'together' }, '');
    assert.equal(adapter.listModels, undefined);
    assert.deepEqual(await listProviderModels(adapter, { baseUrl }, undefined), ['flux-1', 'flux-pro']);
  } finally {
    server.close();
  }
});

// stability 既没有 listModels 也没有 routes.models，必须继续明确报不支持
test('supportsModels follows routes.models', async () => {
  const manifest = adapterManifest();
  assert.equal(manifest.find((item) => item.id === 'together').supportsModels, true);
  assert.equal(manifest.find((item) => item.id === 'stability').supportsModels, false);
  const adapter = resolveAdapter({ protocol: 'stability' }, '');
  await assert.rejects(() => listProviderModels(adapter, { baseUrl: 'https://api.stability.ai' }, undefined), /不支持/);
});


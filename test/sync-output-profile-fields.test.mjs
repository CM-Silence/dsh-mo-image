/**
 * stability / openai-chat 迁完后的**字段钉住**（与 test/sync-output-profiles.test.mjs 分开）。
 *
 * 特征化基线只回答「同一份响应 → 同一份字节 / 同一句报错」；这个文件回答
 * 「描述符的最终字段名与值是什么」——以后谁改了形状，这里先红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/adapters.js';

test('stability：输出描述符钉住 kind:binary 的字段（请求常量 binary 仍在协议上）', () => {
  const provider = { baseUrl: 'https://api.stability.ai', key: 'k' };
  const adapter = resolveAdapter(provider, 'core');
  assert.equal(adapter.binary, true, 'binary:true 是请求常量，不能跟着响应侧一起删');
  assert.equal(adapter.output.kind, 'binary');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'kind', 'maxBytes']);
  assert.equal(adapter.output.maxBytes, 32 * 1024 * 1024, '迁移前通用路径的 MAX_IMAGE_BYTES');
  assert.equal(adapter.output.emptyMessage, '生图接口没有返回图片');
});

test('openai-chat：输出描述符钉住 from[] / text[] 的级联形状与顺序', () => {
  const provider = { baseUrl: 'https://relay.example/v1', adapter: 'openai-chat', key: 'k' };
  const adapter = resolveAdapter(provider, 'relay-chat-model');
  assert.deepEqual(Object.keys(adapter.output).sort(), ['emptyMessage', 'from', 'kind', 'maxBytes', 'scan']);
  assert.equal(adapter.output.kind, 'json');
  assert.equal(adapter.output.scan, true);
  assert.equal(adapter.output.maxBytes, 64 * 1024 * 1024, '迁移前 readJsonResponse 的上限');
  assert.equal(adapter.output.emptyMessage, '该中转没有返回图片（检查 modalities 或换用 OpenRouter 专用接口）');

  const [images, content] = adapter.output.from;
  assert.deepEqual(images, {
    path: 'choices.0.message.images[]',
    as: 'auto',
    any: ['image_url.url', 'url', '']
  });
  assert.equal(content.path, 'choices.0.message.content');
  assert.deepEqual(content.text.map((rule) => rule.as), ['base64', 'url'], '先 data URL、再 http 链接');
  const dataUrl = new RegExp(content.text[0].regex, content.text[0].flags === undefined ? 'i' : content.text[0].flags);
  const link = new RegExp(content.text[1].regex, content.text[1].flags === undefined ? 'i' : content.text[1].flags);
  assert.ok(dataUrl.test('data:image/png;base64,AAAA'));
  assert.ok(link.test('https://cdn.test/a.png?x=1'));
  assert.ok(!link.test('https://cdn.test/a.txt'), 'http 级只认图片后缀');
});

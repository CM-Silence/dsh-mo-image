import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAdapter, prepareEdit, classifyFailure, readResponseBytes, looksLikeImage
} from '../lib/adapters.js';

const provider = { baseUrl: 'https://api.siliconflow.cn/v1', key: 'test-key' };

test('JSON edit adapters carry the reference image in the body', () => {
  const adapter = resolveAdapter(provider, 'kwai-kolors/kolors');
  assert.equal(adapter.transport.edit, 'json');
  const body = JSON.parse(prepareEdit(adapter, provider, {
    model: 'kwai-kolors/kolors',
    prompt: '把背景换成浅灰色',
    fitted: { omit: true, size: 'none' },
    images: [{ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', filename: 'ref.png' }]
  }, new Set(), 'image').body);
  assert.match(body.image, /^data:image\/png;base64,/);
});

test('multiple reference images are encoded as an array for JSON edit', () => {
  const adapter = resolveAdapter(provider, 'kwai-kolors/kolors');
  const body = JSON.parse(prepareEdit(adapter, provider, {
    model: 'kwai-kolors/kolors', prompt: '融合两张图', fitted: { omit: true, size: 'none' },
    images: [
      { buffer: Buffer.from('a'), contentType: 'image/png', filename: 'a.png' },
      { buffer: Buffer.from('b'), contentType: 'image/jpeg', filename: 'b.jpg' }
    ]
  }, new Set(), 'image').body);
  assert.equal(body.image.length, 2);
  assert.match(body.image[1], /^data:image\/jpeg;base64,/);
});

test('unquoted unknown-parameter messages are still droppable', () => {
  const cases = [
    'Unrecognized request argument supplied: negative_prompt',
    "Unknown parameter: 'negative_prompt'",
    "Unsupported parameter: 'negative_prompt' is not supported with this model"
  ];
  for (const message of cases) {
    const failure = classifyFailure(400, JSON.stringify({ error: { message } }));
    assert.equal(failure.kind, 'param', message);
    assert.equal(failure.drop, 'negative_prompt', message);
  }
});

test('structured error.param is used when the message has no field name', () => {
  const failure = classifyFailure(400, JSON.stringify({ error: { message: 'bad request', param: 'negative_prompt' } }));
  assert.equal(failure.kind, 'param');
  assert.equal(failure.drop, 'negative_prompt');
});

test('response reader refuses oversized bodies', async () => {
  const response = new Response(Buffer.alloc(64), { headers: { 'content-length': '64' } });
  await assert.rejects(() => readResponseBytes(response, 32), /大小限制/);
});

test('response reader uses content-length for a single-buffer read', async () => {
  const response = new Response(Buffer.from('image-bytes'), { headers: { 'content-length': '11' } });
  const bytes = await readResponseBytes(response, 64);
  assert.equal(bytes.toString(), 'image-bytes');
});

test('response reader falls back when content-length is shorter than the body', async () => {
  const response = new Response(Buffer.from('longer-body'), { headers: { 'content-length': '4' } });
  const bytes = await readResponseBytes(response, 64);
  assert.equal(bytes.toString(), 'longer-body');
});

test('looksLikeImage accepts a minimal PNG signature buffer', () => {
  assert.equal(looksLikeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(looksLikeImage(Buffer.from('not an image')), false);
});

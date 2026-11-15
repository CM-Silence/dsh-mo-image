import test from 'node:test';
import assert from 'node:assert/strict';

import { encodePng } from '../lib/png-scale.js';
import { imageSizeOf } from '../lib/adapter-kit.js';
import { resizeInWorker, closeImageWorker } from '../lib/image-worker.js';

/* D2：大图缩放必须在 Worker 里完成；失败时返回 null，让调用方同步兜底。 */

function png(width, height) {
  return encodePng(new Uint8Array(width * height * 4).fill(120), width, height);
}

test.after(() => closeImageWorker());

test('the worker decodes, resizes and re-encodes a PNG off the main thread', async () => {
  const source = png(1200, 800);
  const out = await resizeInWorker(source, 400, 300);

  assert.ok(out);
  assert.equal(out.contentType, 'image/png');
  assert.deepEqual(imageSizeOf(out.bytes), { width: 400, height: 300 });
  assert.equal(out.cropped, false);
});

test('cover mode crops to the target aspect before scaling', async () => {
  const source = png(300, 300);
  const out = await resizeInWorker(source, 100, 200, 'cover');

  assert.ok(out);
  assert.equal(out.cropped, true);
  assert.deepEqual(imageSizeOf(out.bytes), { width: 100, height: 200 });
});

test('unsupported input and unsafe targets return null instead of throwing', async () => {
  assert.equal(await resizeInWorker(Buffer.from('not a png'), 100, 100), null);
  assert.equal(await resizeInWorker(png(10, 10), 0, 100), null);
  assert.equal(await resizeInWorker(png(10, 10), 200000, 100), null);
  assert.equal(await resizeInWorker(png(10, 10), 100, 100, 'cover', { timeoutMs: 0 }), null, 'timeout 0 is invalid');
});

test('a timeout resolves to null and does not poison later jobs', async () => {
  const timedOut = await resizeInWorker(png(800, 600), 200, 150, undefined, { timeoutMs: 1 });
  assert.equal(timedOut, null, 'a 1ms budget expires before the worker can finish');

  const next = await resizeInWorker(png(100, 100), 50, 50);
  assert.ok(next, 'the worker is still usable after a timed-out request');
  assert.deepEqual(imageSizeOf(next.bytes), { width: 50, height: 50 });
});

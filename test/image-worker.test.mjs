import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { encodePng } from '../lib/png-scale.js';
import { imageSizeOf } from '../lib/adapter-kit.js';
import { resizeInWorker, closeImageWorker } from '../lib/image-worker.js';

/* 大图缩放在 Worker 中完成；失败时调用方可以保留原图。 */

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

test('an active timeout terminates its worker before dispatching the next job', async (t) => {
  const postMessage = Worker.prototype.postMessage;
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  let firstWorker;
  let firstExited = false;
  let nextWorker;
  t.mock.method(Worker.prototype, 'postMessage', function (...args) {
    if (!firstWorker) {
      firstWorker = this;
      this.prependOnceListener('exit', () => { firstExited = true; });
      return;
    }
    nextWorker = this;
    assert.equal(firstExited, true, 'the previous thread has stopped');
    return postMessage.apply(this, args);
  });

  const source = png(100, 100);
  const expired = resizeInWorker(source, 50, 50, undefined, { timeoutMs: 10 });
  const queued = resizeInWorker(source, 40, 30);
  assert.equal(await expired, null);
  const next = await queued;
  assert.ok(next);
  assert.equal(terminate.mock.callCount(), 1);
  assert.equal(firstExited, true);
  assert.notEqual(nextWorker, firstWorker);
  assert.deepEqual(imageSizeOf(next.bytes), { width: 40, height: 30 });
});

test('a queued timeout leaves the active job running and transfers no extra image', async (t) => {
  const postMessage = Worker.prototype.postMessage;
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  let submit;
  const posted = t.mock.method(Worker.prototype, 'postMessage', function (...args) {
    submit = () => postMessage.apply(this, args);
  });
  const source = png(100, 100);
  const active = resizeInWorker(source, 50, 50);
  const queued = resizeInWorker(source, 40, 30, undefined, { timeoutMs: 1 });
  assert.equal(await queued, null);
  assert.equal(posted.mock.callCount(), 1);
  assert.equal(terminate.mock.callCount(), 0);
  submit();
  assert.deepEqual(imageSizeOf((await active).bytes), { width: 50, height: 50 });
});

test('close settles active and queued jobs and allows a fresh worker to start', async () => {
  const source = png(100, 100);
  const active = resizeInWorker(source, 50, 50);
  const queued = resizeInWorker(source, 40, 30);
  closeImageWorker();
  assert.deepEqual(await Promise.all([active, queued]), [null, null]);
  const next = await resizeInWorker(source, 20, 30);
  assert.deepEqual(imageSizeOf(next.bytes), { width: 20, height: 30 });
});

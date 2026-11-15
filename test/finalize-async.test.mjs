import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../lib/png-scale.js';
import { imageSizeOf } from '../lib/adapter-kit.js';
import { closeImageWorker } from '../lib/image-worker.js';

/* D2：大图收尾走 Worker；结果与同步 finalizeImage 的语义保持一致。 */

function png(width, height) {
  return encodePng(new Uint8Array(width * height * 4).fill(90), width, height);
}

test.after(() => closeImageWorker());

test.before(async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-finalize-async-'));
  mkdirSync(path.join(home, 'mo-image'), { recursive: true });
  process.env.DSH_HOME = home;
  test.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
});

test('a large strict resize runs through the worker and keeps the original', async () => {
  const { finalizeImageAsync } = await import('../lib/index.js?finalize-async-test');
  const source = png(1200, 800);
  const wanted = { width: 400, height: 300, text: '400x300' };
  const result = await finalizeImageAsync({
    bytes: source,
    contentType: 'image/png',
    fitted: { size: '1200x800', width: 1200, height: 800, requested: wanted }
  }, { strict: true });

  assert.deepEqual(imageSizeOf(result.bytes), { width: 400, height: 300 });
  assert.equal(result.bytes.equals(source), false);
  assert.equal(result.original, source, 'the upstream bytes are kept for the sidecar');
  assert.equal(result.generated, '1200x800');
  assert.match(result.note, /严格模式/);
  assert.match(result.note, /裁切并/);
});

test('a small resize stays on the synchronous path with the same result shape', async () => {
  const { finalizeImageAsync, finalizeImage } = await import('../lib/index.js?finalize-async-small-test');
  const source = png(128, 128);
  const input = {
    bytes: source,
    contentType: 'image/png',
    fitted: { size: '128x128', width: 128, height: 128, requested: { width: 64, height: 64, text: '64x64' } }
  };
  const asyncResult = await finalizeImageAsync(input, { strict: true });
  const syncResult = finalizeImage(input, { strict: true });

  assert.deepEqual(imageSizeOf(asyncResult.bytes), { width: 64, height: 64 });
  assert.deepEqual(imageSizeOf(syncResult.bytes), { width: 64, height: 64 });
  assert.equal(asyncResult.generated, syncResult.generated);
  assert.match(asyncResult.note, /严格模式/);
});

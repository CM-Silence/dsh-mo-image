import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('finalizeImage does not upscale when the requested size is larger than the model max', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-finalize-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  mkdirSync(path.join(home, 'mo-image'), { recursive: true });
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const { finalizeImage } = await import('../lib/index.js?finalize-test');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = finalizeImage({
    bytes,
    contentType: 'image/png',
    fitted: {
      size: '1024x1024', width: 1024, height: 1024, adjusted: true,
      requested: { width: 2000, height: 2000, text: '2000x2000' }
    }
  });
  assert.equal(result.bytes, bytes);
  assert.equal(result.fitted.size, '1024x1024');
  assert.equal(result.fitted.width, 1024);
  assert.match(result.note, /上限/);
});

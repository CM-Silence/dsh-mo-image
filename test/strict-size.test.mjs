import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodePng } from '../lib/png-scale.js';
import { imageSizeOf } from '../lib/adapter-kit.js';

/* 严格模式：目标只来自"请求里实际带的尺寸"，缩放失败就留着原图并说明。 */

function png(width, height) {
  return encodePng(new Uint8Array(width * height * 4).fill(180), width, height);
}

let finalizeImage;
let home;

test.before(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-strict-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  mkdirSync(path.join(home, 'mo-image'), { recursive: true });
  ({ finalizeImage } = await import('../lib/index.js?strict-size-test'));
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

test.after(() => { rmSync(home, { recursive: true, force: true }); });

const requested = (width, height) => ({ width: width, height: height, text: width + 'x' + height });

test('imageSizeOf reads PNG, JPEG, WebP and GIF headers', () => {
  assert.deepEqual(imageSizeOf(png(37, 41)), { width: 37, height: 41 });

  // GIF：逻辑屏幕描述符里的宽高（小端）。
  const gif = Buffer.alloc(16);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(120, 6);
  gif.writeUInt16LE(90, 8);
  assert.deepEqual(imageSizeOf(gif), { width: 120, height: 90 });

  // JPEG：FFD8 + SOF0 段（FFC0），高在前、宽在后。
  const jpeg = Buffer.alloc(20);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  jpeg[2] = 0xff; jpeg[3] = 0xc0;
  jpeg.writeUInt16BE(17, 4);
  jpeg[6] = 8;
  jpeg.writeUInt16BE(48, 7);
  jpeg.writeUInt16BE(64, 9);
  assert.deepEqual(imageSizeOf(jpeg), { width: 64, height: 48 });

  // WebP 无损（VP8L）：14 位宽高各减一，打包在一个小端字里。
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8L', 12, 'ascii');
  webp[20] = 0x2f;
  webp.writeUInt32LE(((100 - 1) & 0x3fff) | (((60 - 1) & 0x3fff) << 14), 21);
  assert.deepEqual(imageSizeOf(webp), { width: 100, height: 60 });

  // WebP 有损（VP8 ）：同步码之后是两个 14 位宽高。
  const lossy = Buffer.alloc(34);
  lossy.write('RIFF', 0, 'ascii');
  lossy.write('WEBP', 8, 'ascii');
  lossy.write('VP8 ', 12, 'ascii');
  lossy.writeUInt16LE(200, 26);
  lossy.writeUInt16LE(150, 28);
  assert.deepEqual(imageSizeOf(lossy), { width: 200, height: 150 });

  assert.equal(imageSizeOf(Buffer.from('not an image')), null);
  assert.equal(imageSizeOf(Buffer.alloc(4)), null);
});

test('strict resizes a bigger image down to the requested size', () => {
  const out = finalizeImage({
    bytes: png(256, 256),
    contentType: 'image/png',
    fitted: { size: '128x128', width: 128, height: 128, requested: requested(128, 128) }
  }, { strict: true });
  assert.equal(out.generated, '256x256');
  assert.equal(out.fitted.size, '128x128');
  assert.match(out.note, /严格模式/);
  assert.deepEqual(imageSizeOf(out.bytes), { width: 128, height: 128 });
});

test('strict upscales a smaller image and says quality is lost', () => {
  const out = finalizeImage({
    bytes: png(64, 64),
    contentType: 'image/png',
    fitted: { size: '128x128', width: 128, height: 128, requested: requested(128, 128) }
  }, { strict: true });
  assert.deepEqual(imageSizeOf(out.bytes), { width: 128, height: 128 });
  assert.match(out.note, /放大/);
});

test('strict does nothing when the request carried no size', () => {
  const out = finalizeImage({
    bytes: png(200, 150),
    contentType: 'image/png',
    fitted: { omit: true, size: 'none' }
  }, { strict: true });
  assert.equal(out.generated, '200x150');
  assert.match(out.note, /未生效/);
  assert.deepEqual(imageSizeOf(out.bytes), { width: 200, height: 150 });
});

test('strict never stretches a bare tier label to its nominal pixels', () => {
  const out = finalizeImage({
    bytes: png(400, 300),
    contentType: 'image/png',
    fitted: { size: '2K', width: 2048, height: 2048, requested: null, tier: '2K' }
  }, { strict: true });
  assert.deepEqual(imageSizeOf(out.bytes), { width: 400, height: 300 }, 'a tier label has no pixel target');
  assert.match(out.note, /档位/);
});

test('non-strict keeps the original but still reports the generated size', () => {
  const out = finalizeImage({
    bytes: png(256, 256),
    contentType: 'image/png',
    fitted: { size: '128x128', width: 128, height: 128, requested: requested(128, 128) }
  }, {});
  assert.equal(out.generated, '256x256');
  assert.deepEqual(imageSizeOf(out.bytes), { width: 256, height: 256 });
});

test('strict crops instead of stretching when the platform ignored the ratio', () => {
  const out = finalizeImage({
    bytes: png(300, 300),
    contentType: 'image/png',
    fitted: { size: '200x100', width: 200, height: 100, requested: requested(200, 100) }
  }, { strict: true });
  assert.deepEqual(imageSizeOf(out.bytes), { width: 200, height: 100 });
  assert.match(out.note, /裁切/);
});

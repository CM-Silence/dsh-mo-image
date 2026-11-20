import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { decodePng, encodePng, isPng, scalePng } from '../lib/png-scale.js';
import { imageSizeOf, looksLikeImage, sniffType } from '../lib/adapter-kit.js';

/* 图片输入边界：坏头、坏块、坏压缩流都只能返回 null，不能抛异常或先分配内存。 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])));
  return Buffer.concat([head, data, crc]);
}

function ihdr(overrides = {}) {
  const width = overrides.width === undefined ? 1 : overrides.width;
  const height = overrides.height === undefined ? 1 : overrides.height;
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = overrides.bitDepth === undefined ? 8 : overrides.bitDepth;
  data[9] = overrides.colorType === undefined ? 6 : overrides.colorType;
  data[10] = overrides.compression === undefined ? 0 : overrides.compression;
  data[11] = overrides.filter === undefined ? 0 : overrides.filter;
  data[12] = overrides.interlace === undefined ? 0 : overrides.interlace;
  return chunk('IHDR', data);
}

function pngOf(chunks) {
  return Buffer.concat([PNG_SIGNATURE].concat(chunks));
}

/** 故意构造的 1x1 RGBA：filter 0 + 4 字节像素，正好是解码器期望的 raw 长度。 */
const RAW_1X1 = Buffer.alloc(5);

function craftedPng(header, raw = RAW_1X1) {
  return pngOf([ihdr(header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function findChunk(buffer, type) {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const name = buffer.toString('ascii', offset + 4, offset + 8);
    if (name === type) return { offset: offset, length: length, dataOffset: offset + 8, crcOffset: offset + 8 + length };
    offset += 12 + length;
  }
  return null;
}

function jpegHeader(width = 64, height = 48) {
  // 段长 17 包含两字节长度字段：整段从偏移 4 延伸到 20，文件至少 21 字节。
  const buffer = Buffer.alloc(21);
  buffer[0] = 0xff; buffer[1] = 0xd8;
  buffer[2] = 0xff; buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webpLossless(width = 100, height = 60) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii');
  buffer[20] = 0x2f;
  buffer.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return buffer;
}

function gifHeader(width = 120, height = 90) {
  const buffer = Buffer.alloc(16);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

test('decodePng rejects every truncation up to the 32-byte header boundary', () => {
  const png = encodePng(new Uint8Array([255, 0, 0, 255]), 1, 1);
  assert.ok(png.length > 32);
  for (let size = 0; size <= 32; size++) {
    const cut = png.subarray(0, size);
    assert.equal(decodePng(cut), null, 'decodePng accepts ' + size + ' bytes');
    assert.equal(looksLikeImage(cut), false, 'looksLikeImage accepts ' + size + ' bytes');
  }
});

test('decodePng rejects a chunk whose declared length runs past the buffer', () => {
  const png = encodePng(new Uint8Array(16).fill(200), 2, 2);
  const idat = findChunk(png, 'IDAT');
  assert.ok(idat);

  const truncated = png.subarray(0, idat.dataOffset + 2);
  assert.equal(decodePng(truncated), null);

  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(png.length, idat.offset);
  assert.equal(decodePng(oversized), null);
});

test('decodePng requires IHDR to be first and exactly 13 bytes long', () => {
  const png = encodePng(new Uint8Array([1, 2, 3, 255]), 1, 1);

  const wrongLength = Buffer.from(png);
  wrongLength.writeUInt32BE(14, 8);
  assert.equal(decodePng(wrongLength), null);

  const notFirst = pngOf([
    chunk('tEXt', Buffer.from('k\0v')),
    ihdr(),
    chunk('IDAT', zlib.deflateSync(RAW_1X1)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  assert.equal(decodePng(notFirst), null);
});

test('decodePng rejects invalid PNG header fields', () => {
  const dimensions = [{ width: 0 }, { height: 0 }, { width: 0x80000000 }, { width: 0xffffffff, height: 1 }];
  for (const header of dimensions) {
    assert.equal(decodePng(craftedPng(header)), null, JSON.stringify(header));
  }

  const fields = [
    { bitDepth: 7 },
    { bitDepth: 16, colorType: 6 },
    { colorType: 5 },
    { compression: 1 },
    { filter: 1 },
    { interlace: 2 },
    { colorType: 3 }
  ];
  for (const header of fields) {
    assert.equal(decodePng(craftedPng(header)), null, JSON.stringify(header));
  }
});

test('decodePng rejects bad critical-chunk CRCs', () => {
  const png = encodePng(new Uint8Array(16).fill(128), 2, 2);

  const badHeaderCrc = Buffer.from(png);
  badHeaderCrc[29] ^= 0xff;
  assert.equal(decodePng(badHeaderCrc), null);

  const idat = findChunk(png, 'IDAT');
  assert.ok(idat);
  const badIdatCrc = Buffer.from(png);
  badIdatCrc[idat.crcOffset] ^= 0xff;
  assert.equal(decodePng(badIdatCrc), null);
});

test('decodePng rejects corrupt zlib streams and wrong decompressed lengths', () => {
  const corrupt = pngOf([
    ihdr(),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff])),
    chunk('IEND', Buffer.alloc(0))
  ]);
  assert.equal(decodePng(corrupt), null);

  const short = craftedPng({}, Buffer.alloc(4));
  assert.equal(decodePng(short), null);

  const long = craftedPng({}, Buffer.alloc(6));
  assert.equal(decodePng(long), null);
});

test('decodePng rejects oversized images before inflating', () => {
  const oversized = craftedPng({ width: 10000, height: 10000 });
  assert.deepEqual(imageSizeOf(oversized), { width: 10000, height: 10000 }, 'the header itself is readable');

  const original = zlib.inflateSync;
  let called = false;
  zlib.inflateSync = function patched(...args) {
    called = true;
    return original.apply(zlib, args);
  };
  try {
    assert.equal(decodePng(oversized), null);
    assert.equal(called, false, 'the pixel budget must be checked before decompression');
  } finally {
    zlib.inflateSync = original;
  }
});

test('decodePng caps inflate output at the expected row size', () => {
  const png = encodePng(new Uint8Array(16).fill(10), 2, 2);
  const original = zlib.inflateSync;
  let options = null;
  zlib.inflateSync = function patched(buffer, optionsIn) {
    options = optionsIn;
    return original.call(zlib, buffer, optionsIn);
  };
  try {
    assert.ok(decodePng(png));
  } finally {
    zlib.inflateSync = original;
  }
  assert.equal(options && options.maxOutputLength, 2 * (2 * 4 + 1));
});

test('decodePng and scalePng still handle valid 1x1 and 2x2 PNGs', () => {
  const one = new Uint8Array([255, 0, 0, 255]);
  const onePng = encodePng(one, 1, 1);
  assert.equal(isPng(onePng), true);
  assert.deepEqual(imageSizeOf(onePng), { width: 1, height: 1 });

  const decodedOne = decodePng(onePng);
  assert.equal(decodedOne.width, 1);
  assert.equal(decodedOne.height, 1);
  assert.deepEqual(Buffer.from(decodedOne.rgba), Buffer.from(one));

  const two = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255
  ]);
  const twoPng = encodePng(two, 2, 2);
  const decodedTwo = decodePng(twoPng);
  assert.equal(decodedTwo.width, 2);
  assert.equal(decodedTwo.height, 2);
  assert.deepEqual(Buffer.from(decodedTwo.rgba), Buffer.from(two));

  const scaled = decodePng(scalePng(twoPng, 1, 1));
  assert.equal(scaled.width, 1);
  assert.equal(scaled.height, 1);
  assert.deepEqual(Array.from(scaled.rgba), [128, 128, 128, 255]);
});

test('decodePng reverses all row filters across split IDAT chunks', () => {
  const raw = Buffer.from([
    0, 10, 20, 30, 40, 50, 60, 70, 80,
    1, 11, 21, 31, 41, 40, 40, 40, 40,
    2, 1, 1, 1, 1, 1, 1, 1, 1,
    3, 7, 12, 17, 22, 21, 21, 21, 21,
    4, 1, 1, 1, 1, 1, 1, 1, 1
  ]);
  const compressed = zlib.deflateSync(raw);
  const split = Math.floor(compressed.length / 2);
  const source = pngOf([
    ihdr({ width: 2, height: 5 }),
    chunk('IDAT', compressed.subarray(0, split)),
    chunk('IDAT', Buffer.alloc(0)),
    chunk('IDAT', compressed.subarray(split)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  const expected = Uint8Array.from({ length: 40 }, (_, i) => (i % 8 + 1) * 10 + Math.floor(i / 8));
  assert.deepEqual(decodePng(source)?.rgba, expected);
});

test('decodePng expands compact rows for grayscale, RGB and indexed inputs', () => {
  for (const { colorType, raw, expected } of [
    { colorType: 0, raw: [0, 10, 2, 5], expected: [10, 10, 10, 255, 15, 15, 15, 255] },
    { colorType: 2, raw: [0, 10, 20, 30, 2, 5, 4, 3], expected: [10, 20, 30, 255, 15, 24, 33, 255] },
    { colorType: 4, raw: [0, 10, 15, 2, 5, 3], expected: [10, 10, 10, 15, 15, 15, 15, 18] }
  ]) {
    const source = craftedPng({ colorType, width: 1, height: 2 }, Buffer.from(raw));
    assert.deepEqual(decodePng(source)?.rgba, Uint8Array.from(expected));
  }
  const indexed = pngOf([
    ihdr({ colorType: 3, width: 1, height: 2 }),
    chunk('PLTE', Buffer.from([10, 20, 30, 40, 50, 60])),
    chunk('tRNS', Buffer.from([70])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 2, 1]))),
    chunk('IEND', Buffer.alloc(0))
  ]);
  assert.deepEqual(decodePng(indexed)?.rgba, Uint8Array.from([10, 20, 30, 70, 40, 50, 60, 255]));
});

test('imageSizeOf rejects truncated JPEG, WebP and GIF headers', () => {
  const jpeg = jpegHeader();
  for (let size = 0; size < 11; size++) {
    assert.equal(imageSizeOf(jpeg.subarray(0, size)), null, 'jpeg ' + size + ' bytes');
    assert.equal(looksLikeImage(jpeg.subarray(0, size)), false, 'jpeg looksLike ' + size + ' bytes');
  }
  assert.deepEqual(imageSizeOf(jpeg), { width: 64, height: 48 });

  const webp = webpLossless();
  for (let size = 0; size < 25; size++) {
    assert.equal(imageSizeOf(webp.subarray(0, size)), null, 'webp ' + size + ' bytes');
    assert.equal(looksLikeImage(webp.subarray(0, size)), false, 'webp looksLike ' + size + ' bytes');
  }
  assert.deepEqual(imageSizeOf(webp), { width: 100, height: 60 });

  const gif = gifHeader();
  for (let size = 0; size < 13; size++) {
    assert.equal(imageSizeOf(gif.subarray(0, size)), null, 'gif ' + size + ' bytes');
    assert.equal(looksLikeImage(gif.subarray(0, size)), false, 'gif looksLike ' + size + ' bytes');
  }
  assert.deepEqual(imageSizeOf(gif), { width: 120, height: 90 });

  assert.equal(sniffType(jpeg), 'image/jpeg');
  assert.equal(sniffType(webp), 'image/webp');
  assert.equal(sniffType(gif), 'image/gif');
});

test('imageSizeOf validates container lengths and positive dimensions', () => {
  const webp = webpLossless();
  const badRiff = Buffer.from(webp);
  badRiff.writeUInt32LE(1000, 4);
  assert.equal(imageSizeOf(badRiff), null);

  const badChunk = Buffer.from(webp);
  badChunk.writeUInt32LE(1000, 16);
  assert.equal(imageSizeOf(badChunk), null);

  const fakeGif = Buffer.alloc(16);
  fakeGif.write('GIF99a', 0, 'ascii');
  fakeGif.writeUInt16LE(10, 6);
  fakeGif.writeUInt16LE(10, 8);
  assert.equal(imageSizeOf(fakeGif), null);

  const emptyGif = Buffer.alloc(16);
  emptyGif.write('GIF89a', 0, 'ascii');
  assert.equal(imageSizeOf(emptyGif), null);

  const badPngCrc = Buffer.from(encodePng(new Uint8Array(4).fill(1), 1, 1));
  badPngCrc[29] ^= 0xff;
  assert.equal(imageSizeOf(badPngCrc), null);
});

test('looksLikeImage only accepts structurally valid headers', () => {
  assert.equal(looksLikeImage(encodePng(new Uint8Array(4).fill(9), 1, 1)), true);
  assert.equal(looksLikeImage(jpegHeader()), true);
  assert.equal(looksLikeImage(webpLossless()), true);
  assert.equal(looksLikeImage(gifHeader()), true);

  assert.equal(looksLikeImage(PNG_SIGNATURE), false);
  assert.equal(looksLikeImage(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(25)])), false);
  assert.equal(looksLikeImage(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(10)])), false);
  assert.equal(looksLikeImage(Buffer.from('RIFFxxxxWEBP')), false);
  assert.equal(looksLikeImage(Buffer.from('GIF89a')), false);
});

test('header readers return null instead of throwing on malformed input', () => {
  const samples = [
    null,
    undefined,
    Buffer.alloc(0),
    Buffer.from('GIF'),
    Buffer.from([0xff, 0xd8]),
    Buffer.from('RIFFxxxxWEBP'),
    Buffer.alloc(40, 0xff)
  ];
  for (const sample of samples) {
    assert.doesNotThrow(() => imageSizeOf(sample));
    assert.doesNotThrow(() => looksLikeImage(sample));
    assert.doesNotThrow(() => sniffType(sample));
  }
  assert.equal(imageSizeOf(null), null);
  assert.equal(looksLikeImage(null), false);
});

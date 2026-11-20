/**
 * 零依赖 PNG 缩放：只做「解码 → 面积平均缩放 → 重新编码」这一件事。
 *
 * 用途：上游模型有最小像素预算时，先在合法尺寸出图，再缩回用户真正要的尺寸。
 * 只支持 8-bit、非隔行、colorType 0/2/3/4/6 的 PNG（生图接口返回的基本都是这些）；
 * 遇到别的形状返回 null，由调用方走别的路子。
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_DIMENSION = 0x7fffffff;

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
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function isPng(buffer) {
  if (!buffer || buffer.length < 8) return false;
  for (let i = 0; i < 8; i++) if (buffer[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** PNG 允许的色深/颜色类型组合；解码器自己只实现 8-bit。 */
function validColorFormat(bitDepth, colorType) {
  if (colorType === 0) return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
  if (colorType === 3) return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8;
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  return false;
}

function positiveDimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_DIMENSION;
}

/**
 * 只读签名和 IHDR（含 CRC），不碰像素数据。
 *
 * 宽高是后面所有分配和循环的依据，所以必须在解码前把长度、边界和字段合法性验光；
 * adapter-kit 的 imageSizeOf/looksLikeImage 也复用这里，保证两边对「合法头」的定义一致。
 */
export function pngHeaderOf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !isPng(buffer)) return null;
  if (buffer.readUInt32BE(8) !== 13) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  if (crc32(buffer.subarray(12, 29)) !== buffer.readUInt32BE(29)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!positiveDimension(width) || !positiveDimension(height)) return null;
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const compression = buffer[26];
  const filter = buffer[27];
  const interlace = buffer[28];
  if (!validColorFormat(bitDepth, colorType)) return null;
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return null;
  return {
    width: width,
    height: height,
    bitDepth: bitDepth,
    colorType: colorType,
    compression: compression,
    filter: filter,
    interlace: interlace
  };
}

/** 像素预算用除法比较：两个 32 位宽高直接相乘会先超过安全整数。 */
function pixelCount(width, height) {
  if (!positiveDimension(width) || !positiveDimension(height)) return 0;
  if (width > Math.floor(MAX_PIXELS / height)) return 0;
  const pixels = width * height;
  return Number.isSafeInteger(pixels) && Number.isSafeInteger(pixels * 4) ? pixels : 0;
}

function isChunkType(buffer, offset) {
  for (let i = 0; i < 4; i++) {
    const code = buffer[offset + i];
    if (!((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))) return false;
  }
  return true;
}

function isCriticalChunk(buffer, offset) {
  const code = buffer[offset];
  return code >= 0x41 && code <= 0x5a;
}

/** 解成 { width, height, rgba }；不支持或结构不合法就返回 null。 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const header = pngHeaderOf(buffer);
  if (!header) return null;
  if (header.bitDepth !== 8 || header.interlace !== 0) return null;
  const channels = CHANNELS[header.colorType];
  if (!channels) return null;
  const width = header.width;
  const height = header.height;
  const colorType = header.colorType;
  const pixels = pixelCount(width, height);
  if (!pixels) return null;

  let offset = 33;
  let palette = null;
  let transparency = null;
  let sawIend = false;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (!isChunkType(buffer, offset + 4)) return null;
    const start = offset + 8;
    // 块长度必须连同尾部 CRC 落在 buffer 内，否则后面的读取会越界。
    if (length > buffer.length - start - 4) return null;
    const dataEnd = start + length;
    if (isCriticalChunk(buffer, offset + 4)
      && crc32(buffer.subarray(offset + 4, dataEnd)) !== buffer.readUInt32BE(dataEnd)) return null;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') return null;
    if (type === 'PLTE') {
      palette = buffer.subarray(start, dataEnd);
    } else if (type === 'tRNS') {
      transparency = buffer.subarray(start, dataEnd);
    } else if (type === 'IDAT' && length) {
      idat.push(buffer.subarray(start, dataEnd));
    } else if (type === 'IEND') {
      if (length !== 0) return null;
      sawIend = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!sawIend || idat.length === 0) return null;
  if (colorType === 3 && !palette) return null;

  const stride = width * channels;
  const rowSize = stride + 1;
  const expected = height * rowSize;
  if (!Number.isSafeInteger(expected) || expected <= 0) return null;
  let raw;
  try {
    // 只解到期望长度：压缩炸弹会在超出时抛错，而不是先占满内存。
    raw = zlib.inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected });
  } catch (_error) {
    return null;
  }
  if (!raw || raw.length !== expected) return null;

  // 在解压缓冲区内还原扫描线。过滤器只依赖当前行左侧和上一行，不需要第二份像素副本。
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize + 1;
    const filter = raw[rowStart - 1];
    if (filter === 0) continue;
    if (filter > 4) return null;
    const prevStart = rowStart - rowSize;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? raw[rowStart + x - channels] : 0;
      const b = y > 0 ? raw[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? raw[prevStart + x - channels] : 0;
      let prediction;
      if (filter === 1) prediction = a;
      else if (filter === 2) prediction = b;
      else if (filter === 3) prediction = (a + b) >> 1;
      else prediction = paeth(a, b, c);
      raw[rowStart + x] = (raw[rowStart + x] + prediction) & 0xff;
    }
  }

  if (colorType === 6) {
    // RGBA 只需移除每行的过滤字节，复用整个解压缓冲区。
    for (let y = 0; y < height; y++) {
      const rowStart = y * rowSize + 1;
      raw.copyWithin(y * stride, rowStart, rowStart + stride);
    }
    return { width, height, rgba: new Uint8Array(raw.buffer, raw.byteOffset, pixels * 4) };
  }

  const rgba = new Uint8Array(pixels * 4);
  let dst = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize + 1;
    for (let src = rowStart; src < rowStart + stride; src += channels, dst += 4) {
      if (colorType === 0 || colorType === 4) {
        const gray = raw[src];
        rgba[dst] = gray; rgba[dst + 1] = gray; rgba[dst + 2] = gray;
        rgba[dst + 3] = colorType === 4 ? raw[src + 1] : 255;
      } else if (colorType === 2) {
        rgba[dst] = raw[src]; rgba[dst + 1] = raw[src + 1]; rgba[dst + 2] = raw[src + 2]; rgba[dst + 3] = 255;
      } else {
        const index = raw[src];
        const at = index * 3;
        rgba[dst] = palette[at] || 0;
        rgba[dst + 1] = palette[at + 1] || 0;
        rgba[dst + 2] = palette[at + 2] || 0;
        rgba[dst + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
  }

  return { width, height, rgba };
}

/** 面积平均缩放（不是最近邻，小图不会锯齿）。 */
export function resizeRgba(rgba, width, height, targetWidth, targetHeight) {
  if (targetWidth === width && targetHeight === height) return rgba;
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  const xRatio = width / targetWidth;
  const yRatio = height / targetHeight;
  for (let ty = 0; ty < targetHeight; ty++) {
    const y0 = ty * yRatio;
    const y1 = y0 + yRatio;
    for (let tx = 0; tx < targetWidth; tx++) {
      const x0 = tx * xRatio;
      const x1 = x0 + xRatio;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let total = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        if (sy < 0 || sy >= height) continue;
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          if (sx < 0 || sx >= width) continue;
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const at = (sy * width + sx) * 4;
          r += rgba[at] * weight;
          g += rgba[at + 1] * weight;
          b += rgba[at + 2] * weight;
          a += rgba[at + 3] * weight;
          total += weight;
        }
      }
      const at = (ty * targetWidth + tx) * 4;
      if (total > 0) {
        out[at] = Math.round(r / total);
        out[at + 1] = Math.round(g / total);
        out[at + 2] = Math.round(b / total);
        out[at + 3] = Math.round(a / total);
      }
    }
  }
  return out;
}

/** 编码成 RGBA 的 PNG。 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 一步到位：PNG 字节 → 指定尺寸的 PNG 字节；做不到就返回 null。 */
export function scalePng(buffer, targetWidth, targetHeight) {
  const image = decodePng(buffer);
  if (!image) return null;
  const resized = resizeRgba(image.rgba, image.width, image.height, targetWidth, targetHeight);
  return encodePng(resized, targetWidth, targetHeight);
}

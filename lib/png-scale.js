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

/** 解成 { width, height, rgba }；不支持就返回 null。 */
export function decodePng(buffer) {
  if (!isPng(buffer)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const data = buffer.subarray(start, start + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channels = CHANNELS[colorType];
  if (!channels) return null;
  if (colorType === 3 && !palette) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (_error) {
    return null;
  }

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++];
      const a = x >= channels ? pixels[rowStart + x - channels] : 0;
      const b = y > 0 ? pixels[prevStart + x] : 0;
      const c = (x >= channels && y > 0) ? pixels[prevStart + x - channels] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth(a, b, c);
      else return null;
      pixels[rowStart + x] = out & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    if (colorType === 0) {
      const v = pixels[src];
      rgba[dst] = v; rgba[dst + 1] = v; rgba[dst + 2] = v; rgba[dst + 3] = 255;
    } else if (colorType === 2) {
      rgba[dst] = pixels[src]; rgba[dst + 1] = pixels[src + 1]; rgba[dst + 2] = pixels[src + 2]; rgba[dst + 3] = 255;
    } else if (colorType === 3) {
      const index = pixels[src];
      const at = index * 3;
      rgba[dst] = palette[at] || 0;
      rgba[dst + 1] = palette[at + 1] || 0;
      rgba[dst + 2] = palette[at + 2] || 0;
      rgba[dst + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 4) {
      const v = pixels[src];
      rgba[dst] = v; rgba[dst + 1] = v; rgba[dst + 2] = v; rgba[dst + 3] = pixels[src + 1];
    } else {
      rgba[dst] = pixels[src]; rgba[dst + 1] = pixels[src + 1]; rgba[dst + 2] = pixels[src + 2]; rgba[dst + 3] = pixels[src + 3];
    }
  }

  return { width: width, height: height, rgba: rgba };
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

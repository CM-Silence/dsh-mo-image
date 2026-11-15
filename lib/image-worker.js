/**
 * 大图处理的受控 Worker（OPTIMIZATION_PLAN 阶段 D2）。
 *
 * 主线程只负责收图和落盘；解码、裁切、缩放、编码都在 Worker 里做。
 * 一个 4K PNG 解码后是 33MB 的 RGBA，在主线程上做面积平均缩放会把事件循环
 * 顶住几百毫秒，设置页和对话流都会卡；Worker 里做，主线程只等一条消息。
 *
 * 失败一律回 null，让调用方退回同步的 `resizeTo()`；Worker 起不来、超时、
 * 图片格式不支持都不应该让一次生图失败。并发 1 个 Worker 是有意的：
 * 上游本身已经有 2 并发的队列，这里再开多线程只会抢 CPU 和内存。
 */
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { Buffer } from 'node:buffer';

import { decodePng, encodePng, resizeRgba } from './png-scale.js';

const MAX_SIDE = 16384;
const MAX_PIXELS = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

function targetOk(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0
    && width <= MAX_SIDE && height <= MAX_SIDE
    && width * height <= MAX_PIXELS;
}

/** 居中裁切一段 RGBA；和 adapters.js 的 cover 语义保持一致。 */
function cropRgba(rgba, width, height, left, top, cropWidth, cropHeight) {
  const out = new Uint8Array(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const from = ((top + y) * width + left) * 4;
    out.set(rgba.subarray(from, from + cropWidth * 4), y * cropWidth * 4);
  }
  return out;
}

function coverCrop(image, targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight;
  const ratio = image.width / image.height;
  if (Math.abs(ratio - targetRatio) <= 0.01) return null;
  let cropWidth = image.width;
  let cropHeight = Math.round(image.width / targetRatio);
  if (cropHeight > image.height) {
    cropHeight = image.height;
    cropWidth = Math.round(image.height * targetRatio);
  }
  if (cropWidth <= 0 || cropHeight <= 0) return null;
  const left = Math.max(0, Math.floor((image.width - cropWidth) / 2));
  const top = Math.max(0, Math.floor((image.height - cropHeight) / 2));
  return {
    width: cropWidth,
    height: cropHeight,
    rgba: cropRgba(image.rgba, image.width, image.height, left, top, cropWidth, cropHeight)
  };
}

/* --------------------------------------------------------------- worker 侧 */

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    const id = message && message.id;
    try {
      const width = Number(message && message.width);
      const height = Number(message && message.height);
      if (!id || !targetOk(width, height)) {
        parentPort.postMessage({ id: id, ok: false });
        return;
      }
      const bytes = Buffer.from(message.bytes);
      const image = decodePng(bytes);
      if (!image) {
        parentPort.postMessage({ id: id, ok: false });
        return;
      }
      let source = image;
      let cropped = false;
      if (message.mode === 'cover') {
        const next = coverCrop(image, width, height);
        if (next) { source = next; cropped = true; }
      }
      const rgba = resizeRgba(source.rgba, source.width, source.height, width, height);
      const encoded = encodePng(rgba, width, height);
      // 复制到独立的 ArrayBuffer 再转移：Buffer.concat 返回的底层 buffer
      // 可能来自共享池，直接写进 transfer list 会被 worker_threads 拒绝。
      const out = new Uint8Array(encoded);
      parentPort.postMessage({ id: id, ok: true, bytes: out.buffer, cropped: cropped }, [out.buffer]);
    } catch (error) {
      parentPort.postMessage({ id: id, ok: false, error: String(error && error.message ? error.message : error) });
    }
  });
}

/* ----------------------------------------------------------------- 主线程 */

let worker = null;
let nextId = 1;
const pending = new Map();

function settleAll() {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pending.clear();
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  const created = new Worker(new URL('./image-worker.js', import.meta.url));
  worker = created;
  // 不因为这个 Worker 让宿主进程无法退出；每次请求仍有自己的超时。
  if (typeof created.unref === 'function') created.unref();
  created.on('message', (message) => {
    const entry = pending.get(message && message.id);
    if (!entry) return;
    pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (message.ok && message.bytes) {
      entry.resolve({
        bytes: Buffer.from(message.bytes),
        contentType: 'image/png',
        resized: true,
        cropped: !!message.cropped
      });
    } else {
      entry.resolve(null);
    }
    if (pending.size === 0 && typeof created.unref === 'function') created.unref();
  });
  // 旧 Worker 被 close/重启后，它的 exit 不能把新 Worker 的请求一起结算掉。
  created.on('error', () => { if (worker === created) settleAll(); });
  created.on('exit', () => { if (worker === created) settleAll(); });
  return created;
}

function releaseWorkerIfIdle() {
  if (pending.size === 0 && worker && typeof worker.unref === 'function') worker.unref();
}

/**
 * 在 Worker 里把 PNG 缩放/裁切到目标尺寸。
 *
 * @param {Buffer} bytes 原始 PNG
 * @param {number} width 目标宽
 * @param {number} height 目标高
 * @param {string} [mode] 'cover' 先居中裁切
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{bytes:Buffer,contentType:string,resized:boolean,cropped:boolean}|null>}
 */
export function resizeInWorker(bytes, width, height, mode, options = {}) {
  if (!Buffer.isBuffer(bytes) || !targetOk(Number(width), Number(height))) return Promise.resolve(null);
  let active;
  try {
    active = ensureWorker();
  } catch (_error) {
    return Promise.resolve(null);
  }
  const requestedTimeout = options && options.timeoutMs !== undefined ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) return Promise.resolve(null);
  const timeoutMs = requestedTimeout;
  return new Promise((resolve) => {
    const id = nextId++;
    if (typeof active.ref === 'function') active.ref();
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      releaseWorkerIfIdle();
      resolve(null);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(id, { id: id, resolve: resolve, timer: timer });
    // 复制一份再转移：Buffer 可能来自共享的 Buffer 池，转移共享底层内存会破坏其他引用。
    // 复制到独立的 ArrayBuffer 再转移：Buffer 可能来自 Node 的共享池，
    // 池底层的 ArrayBuffer 带 byteOffset，直接放进 transfer list 会被拒绝。
    const copy = new Uint8Array(bytes);
    try {
      active.postMessage({ id: id, bytes: copy.buffer, width: Number(width), height: Number(height), mode: mode }, [copy.buffer]);
    } catch (_error) {
      pending.delete(id);
      clearTimeout(timer);
      releaseWorkerIfIdle();
      resolve(null);
    }
  });
}

/** 关闭 Worker；测试和插件卸载时调用。进行中的请求回 null，由调用方同步兜底。 */
export function closeImageWorker() {
  if (!worker) return;
  try { worker.terminate(); } catch (_error) { /* ignore */ }
  if (typeof worker.unref === 'function') worker.unref();
  settleAll();
}

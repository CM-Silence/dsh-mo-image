/**
 * 在 Worker 中处理大图。
 *
 * 主线程只负责收图和落盘；解码、裁切、缩放、编码都在 Worker 里做。
 * 主线程串行提交，只有正在处理的图片需要复制并转移到 Worker。
 *
 * 失败返回 null，调用方可以保留上游原图。运行中的任务超时后停止整个 Worker，
 * 等它退出后再处理队列，避免同时有两份像素缓冲区和缩放任务。
 */
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { Buffer } from 'node:buffer';

import { decodePng, encodePng, pngHeaderOf, resizeRgba } from './png-scale.js';

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
let stopping = false;
let running = null;
let nextId = 1;
const queue = new Map();

function settle(job, result) {
  clearTimeout(job.timer);
  job.resolve(result);
}

function clearQueue() {
  for (const job of queue.values()) settle(job, null);
  queue.clear();
}

function stopWorker() {
  if (!worker || stopping) return;
  stopping = true;
  // exit() 恢复调度。新 Worker 必须等旧 Worker 释放计算和缓冲区后再启动。
  void worker.terminate().catch(() => {});
}

function completeRunning(result) {
  const job = running;
  running = null;
  if (job) settle(job, result);
}

function createWorker() {
  const created = new Worker(new URL('./image-worker.js', import.meta.url));
  created.on('message', (message) => {
    if (worker !== created || stopping || !running || running.id !== message?.id) return;
    completeRunning(message.ok && message.bytes ? {
      bytes: Buffer.from(message.bytes),
      contentType: 'image/png',
      resized: true,
      cropped: !!message.cropped
    } : null);
    dispatchNext();
  });
  created.on('error', () => { if (worker === created) stopWorker(); });
  created.on('exit', () => {
    if (worker !== created) return;
    worker = null;
    stopping = false;
    completeRunning(null);
    dispatchNext();
  });
  return created;
}

function dispatchNext() {
  if (stopping || running) return;
  const job = queue.values().next().value;
  if (!job) {
    worker?.unref();
    return;
  }
  queue.delete(job.id);
  running = job;
  try {
    worker ??= createWorker();
    worker.ref();
    // 独立的 ArrayBuffer 可以转移，同时保留调用方的原图（包括 Buffer 池切片）。
    const copy = new Uint8Array(job.bytes);
    worker.postMessage({ id: job.id, bytes: copy.buffer, width: job.width, height: job.height, mode: job.mode }, [copy.buffer]);
  } catch (_error) {
    completeRunning(null);
    if (worker) stopWorker();
    else clearQueue();
  }
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
  const targetWidth = Number(width);
  const targetHeight = Number(height);
  if (!targetOk(targetWidth, targetHeight)) return Promise.resolve(null);
  const header = pngHeaderOf(bytes);
  if (!header || header.bitDepth !== 8 || header.interlace !== 0 || !targetOk(header.width, header.height)) {
    return Promise.resolve(null);
  }
  const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (queue.delete(id)) {
        resolve(null);
      } else if (running?.id === id) {
        stopWorker();
        completeRunning(null);
      }
    }, timeoutMs);
    queue.set(id, { id, bytes, width: targetWidth, height: targetHeight, mode, resolve, timer });
    dispatchNext();
  });
}

/** 关闭 Worker，未完成的请求返回 null。以后提交的请求可以启动新 Worker。 */
export function closeImageWorker() {
  stopWorker();
  completeRunning(null);
  clearQueue();
}

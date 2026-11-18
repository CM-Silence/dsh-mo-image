/**
 * 成图管道：收尾尺寸、严格模式缩放、Worker 卸载与成品保存。
 *
 * 这些逻辑原来长在 lib/index.js 里，和执行器/配置/路由混在一起。拆出来以后
 * index.js 只负责装配与工具入口；这里只依赖适配器层的纯函数和 Worker 客户端，
 * 不读配置、不发请求，测试也就能直接针对成图行为。
 */
import { mkdirSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { aspectLabel, comfySizeWritable, imageSizeOf, resizeTo } from './adapters.js';
import { resizeInWorker } from './image-worker.js';

/** 从 content-type 猜扩展名；只有成品文件名用它，认不出按 png。 */
export function safeExt(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'png';
}

/** 工具结果/日志里给人看的尺寸标签。 */
export function sizeLabel(fitted) {
  if (!fitted) return '';
  if (fitted.omit || fitted.size === 'none') return 'auto';
  if (fitted.size === 'auto') return fitted.width && fitted.height ? fitted.width + 'x' + fitted.height : 'auto';
  return fitted.size;
}

/**
 * 模型不接收尺寸参数时的降级：把尺寸写进提示词。
 * 生图模型对英文尺寸句最稳，所以这句固定英文。
 */
export function stitchSizePrompt(prompt, fitted) {
  const text = String(prompt || '');
  if (!fitted || fitted.omit || !fitted.width || !fitted.height) return text;
  return text + '\n\nOutput size: ' + fitted.width + 'x' + fitted.height
    + ' (' + aspectLabel(fitted.width, fitted.height) + ').';
}

/** 描述符声明了 stitch，或 ComfyUI 自定义工作流根本写不进尺寸时，把尺寸补进提示词。 */
export function applySizeStitch(prompt, fitted, adapter, provider, model) {
  const declared = fitted && fitted.stitch === true;
  // ComfyUI 自定义工作流：宽高既没有占位符也没有映射时，尺寸根本进不了图。
  let blind = false;
  if (adapter && adapter.id === 'comfyui' && provider) {
    try { blind = !comfySizeWritable(provider, model); } catch (_error) { blind = false; }
  }
  if (!declared && !blind) return { prompt: prompt, note: '' };
  const next = stitchSizePrompt(prompt, fitted);
  if (next === prompt) return { prompt: prompt, note: '' };
  return {
    prompt: next,
    note: '该模型不接收尺寸参数，尺寸 ' + fitted.width + 'x' + fitted.height + ' 已写进提示词'
  };
}

/**
 * 收尾：读出回图真实尺寸，按严格模式决定要不要缩放，并把原始尺寸一并回报。
 *
 * 目标值只来自「请求里实际带的那个尺寸」（`fitted.requested`）：
 * 固定尺寸下是选择器的值，自动尺寸下是对话模型填进 size 的值。
 * 档位名（`2K`）没有像素含义，官方连 2048×2048 都不保证，所以不拿它当目标。
 */
export function finalizeImage(result, options, log = () => {}) {
  const strict = Boolean(options && options.strict === true);
  let bytes = result.bytes;
  let contentType = result.contentType;
  let fitted = result.fitted;
  let note = result && result.note ? String(result.note) : '';
  const actual = imageSizeOf(bytes);
  const generated = actual && actual.width && actual.height ? actual.width + 'x' + actual.height : '';
  const omit = !fitted || fitted.omit || fitted.size === 'none';
  const wanted = fitted && fitted.requested ? fitted.requested : null;
  const wantedPixels = wanted ? wanted.width * wanted.height : 0;
  const fittedPixels = fitted ? (fitted.width || 0) * (fitted.height || 0) : 0;
  const appendNote = (text) => { note = note ? note + '；' + text : text; };

  if (strict) {
    if (!wanted || !wanted.width || !wanted.height) {
      appendNote(omit
        ? '自动尺寸且请求未带尺寸，严格模式未生效'
        : '该模型按档位出图，没有固定像素目标，严格模式未生效');
    } else if (actual && (actual.width !== wanted.width || actual.height !== wanted.height)) {
      const upscale = actual.width * actual.height < wanted.width * wanted.height;
      // 缩之前留一份：严格模式改了像素，上游原图反而是没法再拿到的。
      const originalBytes = bytes;
      const resized = resizeTo(bytes, wanted.width, wanted.height, 'cover');
      if (resized) {
        bytes = resized.bytes;
        contentType = resized.contentType;
        fitted = Object.assign({}, fitted, {
          size: wanted.text || (wanted.width + 'x' + wanted.height),
          width: wanted.width,
          height: wanted.height,
          adjusted: false
        });
        appendNote('严格模式：上游出图 ' + generated + '，已' + (resized.cropped ? '裁切并' : '')
          + '缩放到 ' + fitted.size + (upscale ? '（已放大，画质有损）' : ''));
        return {
          bytes: bytes, contentType: contentType, fitted: fitted, note: note,
          generated: generated, original: originalBytes
        };
      }
      appendNote('严格模式：上游出图 ' + generated + '，未能缩放到 '
        + (wanted.text || wanted.width + 'x' + wanted.height) + '，成图保持原尺寸');
    }
    return { bytes: bytes, contentType: contentType, fitted: fitted, note: note, generated: generated };
  }

  // 非严格模式：只有我们自己把尺寸落大过，才缩回用户要的尺寸。
  if (fitted && fitted.adjusted && wanted && wanted.width && wanted.height
    && wanted.text !== fitted.size && fittedPixels > wantedPixels) {
    const resized = resizeTo(bytes, wanted.width, wanted.height);
    if (resized) {
      bytes = resized.bytes;
      contentType = resized.contentType;
      log('resize ' + fitted.size + ' → ' + wanted.text);
      fitted = Object.assign({}, fitted, { size: wanted.text, width: wanted.width, height: wanted.height, adjusted: false });
    } else {
      log('resize unavailable, keep ' + fitted.size + '（用户要 ' + wanted.text + '）');
    }
  } else if (fitted && fitted.adjusted && wanted && fittedPixels < wantedPixels) {
    const sizeNote = '该模型上限为 ' + fitted.size + '，已按上限生成（请求 ' + wanted.text + '，未放大）。';
    appendNote(sizeNote);
    log('keep model max ' + fitted.size + '（用户要 ' + wanted.text + '，不放大）');
  }
  return { bytes: bytes, contentType: contentType, fitted: fitted, note: note, generated: generated };
}

/**
 * 只有大图、且确实需要缩放时才进 Worker；小图/非 PNG 继续走同步的
 * `finalizeImage`，省掉 Worker 的启动与消息开销。
 */
const WORKER_MIN_PIXELS = 512 * 1024;

function workerResizePlan(result, options) {
  const strict = Boolean(options && options.strict === true);
  const fitted = result && result.fitted;
  const wanted = fitted && fitted.requested ? fitted.requested : null;
  if (!wanted || !wanted.width || !wanted.height) return null;
  const actual = imageSizeOf(result && result.bytes);
  if (!actual || !actual.width || !actual.height) return null;
  const same = actual.width === wanted.width && actual.height === wanted.height;
  if (strict) return same ? null : { strict: true, mode: 'cover', actual: actual, wanted: wanted };
  const fittedPixels = (fitted.width || 0) * (fitted.height || 0);
  const wantedPixels = wanted.width * wanted.height;
  if (fitted.adjusted && wanted.text !== fitted.size && fittedPixels > wantedPixels) {
    return { strict: false, mode: undefined, actual: actual, wanted: wanted };
  }
  return null;
}

/**
 * 异步版收尾：把大图的解码/裁切/缩放/编码放到 Worker；Worker 不可用、
 * 超时或遇到非 PNG 时自动退回同步 `finalizeImage`，行为与原来完全一致。
 */
export async function finalizeImageAsync(result, options, log = () => {}) {
  const plan = workerResizePlan(result, options);
  if (!plan) return finalizeImage(result, options, log);
  const sourcePixels = plan.actual.width * plan.actual.height;
  const targetPixels = plan.wanted.width * plan.wanted.height;
  if (Math.max(sourcePixels, targetPixels) < WORKER_MIN_PIXELS) return finalizeImage(result, options, log);

  let resized = null;
  try {
    resized = await resizeInWorker(result.bytes, plan.wanted.width, plan.wanted.height, plan.mode);
  } catch (_error) {
    resized = null;
  }
  if (!resized) return finalizeImage(result, options, log);

  // 已经缩好了，再让 finalizeImage 只负责 generate/note 等元数据；不能让它在
  // 主线程把同一张图再解一遍。
  const merged = Object.assign({}, result, {
    bytes: resized.bytes,
    contentType: resized.contentType,
    fitted: Object.assign({}, result.fitted, { adjusted: false })
  });
  const final = finalizeImage(merged, options, log);
  const wanted = plan.wanted;
  const fitted = Object.assign({}, final.fitted, {
    size: wanted.text || (wanted.width + 'x' + wanted.height),
    width: wanted.width, height: wanted.height, adjusted: false
  });
  const generated = plan.actual.width + 'x' + plan.actual.height;
  let note = final.note || '';
  const append = (text) => { note = note ? note + '；' + text : text; };
  if (plan.strict) {
    const upscale = sourcePixels < targetPixels;
    append('严格模式：上游出图 ' + generated + '，已' + (resized.cropped ? '裁切并' : '')
      + '缩放到 ' + fitted.size + (upscale ? '（已放大，画质有损）' : ''));
  }
  return Object.assign({}, final, {
    bytes: resized.bytes, contentType: resized.contentType, fitted: fitted,
    note: note, generated: generated,
    original: plan.strict ? result.bytes : final.original
  });
}

/** 生成图旁边留一份上游原图（严格模式缩过图时用）。 */
export async function saveSidecar(bytes, contentType, file, log = () => {}) {
  try {
    const ext = safeExt(contentType);
    const base = path.basename(file, path.extname(file));
    const target = path.join(path.dirname(file), base + '-original.' + ext);
    await writeFile(target, bytes);
    return target;
  } catch (error) {
    log('save original failed: ' + String(error && error.message ? error.message : error));
    return '';
  }
}

/** 把成品写进调用方选定的目录（当前项目 generated-images 或 DSH 状态目录）。 */
export async function saveImage(bytes, contentType, provider, model, size, dir) {
  mkdirSync(dir, { recursive: true });
  const ext = safeExt(contentType);
  const filename = 'mo-' + Date.now() + '-' + randomUUID().slice(0, 8) + '.' + ext;
  const file = path.join(dir, filename);
  const tmp = file + '.tmp';
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') await unlink(tmp).catch(() => {});
    throw error;
  }
  return { file, filename, provider: provider.name || provider.id, model, size, bytes: bytes.length, contentType };
}

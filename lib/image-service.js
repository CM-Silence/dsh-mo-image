/**
 * 成图管道：收尾尺寸、严格模式缩放、Worker 卸载与成品保存。
 *
 * 这些逻辑原来长在 lib/index.js 里，和执行器/配置/路由混在一起。拆出来以后
 * index.js 只负责装配与工具入口；这里只依赖适配器层的纯函数和 Worker 客户端，
 * 不读配置、不发请求，测试也就能直接针对成图行为。
 */
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { aspectLabel, comfySizeWritable, imageSizeOf, resizeTo } from './adapters.js';
import { resizeInWorker } from './image-worker.js';
import { isPng } from './png-scale.js';

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

const WORKER_MIN_PIXELS = 512 * 1024;

/** 只用请求里明确给出的宽高做缩放目标，档位名没有固定像素尺寸。 */
function resizePlan(result, options) {
  const strict = options?.strict === true;
  const fitted = result.fitted;
  const requested = fitted?.requested;
  const wanted = requested?.width && requested?.height ? requested : null;
  const actual = imageSizeOf(result.bytes);
  const sourcePixels = actual ? actual.width * actual.height : 0;
  const targetPixels = wanted ? wanted.width * wanted.height : 0;
  const fittedPixels = (fitted?.width || 0) * (fitted?.height || 0);
  const matches = Boolean(actual && wanted && actual.width === wanted.width && actual.height === wanted.height);
  // 非严格模式只有在尺寸适配时抬大过请求，才尝试缩回去。
  const downscale = fitted?.adjusted && wanted && wanted.text !== fitted.size && fittedPixels > targetPixels;
  const resize = Boolean(wanted && !matches && (strict ? actual : downscale));
  return { strict, wanted, actual, sourcePixels, targetPixels, fittedPixels, matches, resize };
}

function withSize(fitted, dimensions, adjusted) {
  const { width, height } = dimensions;
  return { ...fitted, size: width + 'x' + height, width, height, omit: false, adjusted };
}

function finalizeResult(result, plan, resized, log) {
  const { strict, wanted, actual, sourcePixels, targetPixels, fittedPixels, matches, resize } = plan;
  const { bytes, contentType, fitted } = result;
  const generated = actual ? actual.width + 'x' + actual.height : '';
  const output = { bytes, contentType, fitted, note: String(result.note || ''), generated };
  const appendNote = (text) => { output.note = output.note ? output.note + '；' + text : text; };
  if (strict && !wanted) {
    const omit = !fitted || fitted.omit || fitted.size === 'none';
    appendNote(omit
      ? '自动尺寸且请求未带尺寸，严格模式未生效'
      : '该模型按档位出图，没有固定像素目标，严格模式未生效');
    return output;
  }
  const target = wanted ? wanted.width + 'x' + wanted.height : '';
  if (resize && resized) {
    output.bytes = resized.bytes;
    output.contentType = resized.contentType;
    output.fitted = withSize(fitted, wanted, false);
    if (strict) {
      output.original = bytes;
      appendNote('严格模式：上游出图 ' + generated + '，已' + (resized.cropped ? '裁切并' : '')
        + '缩放到 ' + target + (sourcePixels < targetPixels ? '（已放大，画质有损）' : ''));
    } else {
      log('resize ' + (generated || fitted.size) + ' → ' + target);
    }
  } else if (resize || (strict && !actual)) {
    if (actual) output.fitted = withSize(fitted, actual, true);
    const upstream = generated ? '上游出图 ' + generated : '无法读取上游出图尺寸';
    appendNote((strict ? '严格模式：' : '') + upstream + '，未能缩放到 ' + target + '，已保留原图');
    log('resize unavailable, keep original ' + generated + '（用户要 ' + target + '）');
  } else if (matches) {
    output.fitted = withSize(fitted, wanted, false);
  } else if (!strict && fitted?.adjusted && wanted && fittedPixels < targetPixels) {
    appendNote('该模型上限为 ' + fitted.size + '，已按上限生成（请求 ' + target + '，未放大）。');
    log('keep model max ' + fitted.size + '（用户要 ' + target + '，不放大）');
  }
  return output;
}

export function finalizeImage(result, options, log = () => {}) {
  const plan = resizePlan(result, options);
  const resized = plan.resize
    ? resizeTo(result.bytes, plan.wanted.width, plan.wanted.height, plan.strict ? 'cover' : undefined)
    : null;
  return finalizeResult(result, plan, resized, log);
}

/** 大 PNG 只交给 Worker，失败时保留原图。小图和其他格式沿用原有缩放路径。 */
export async function finalizeImageAsync(result, options, log = () => {}) {
  const plan = resizePlan(result, options);
  let resized = null;
  if (plan.resize) {
    const { width, height } = plan.wanted;
    const mode = plan.strict ? 'cover' : undefined;
    if (isPng(result.bytes) && Math.max(plan.sourcePixels, plan.targetPixels) >= WORKER_MIN_PIXELS) {
      resized = await resizeInWorker(result.bytes, width, height, mode);
    } else {
      resized = resizeTo(result.bytes, width, height, mode);
    }
  }
  return finalizeResult(result, plan, resized, log);
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
  await mkdir(dir, { recursive: true });
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

/** 提交付费请求前确认能在目标目录创建文件，兼容 Windows 的目录 ACL。 */
export async function checkImageOutput(dir) {
  await mkdir(dir, { recursive: true });
  const probe = path.join(dir, '.mo-write-' + randomUUID() + '.tmp');
  const file = await open(probe, 'wx', 0o600);
  try {
    await file.close();
  } finally {
    await unlink(probe);
  }
}

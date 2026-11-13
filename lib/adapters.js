/**
 * 生图请求适配层。
 *
 * 插件其余部分只认「规范形式」：
 *   { model, prompt, size: { width, height, text }, quality?, seed?, images? }
 *
 * 每个适配器声明四件事：
 *   send[]     —— 允许写到请求体里的字段（白名单，没列的一律不发）
 *   size       —— 尺寸怎么编码、该模型接受哪些尺寸
 *   quality    —— 规范 quality 如何映射成该提供商的值
 *   response   —— 怎么从回应里挖出图片字节
 *
 * 新增一个模型族 = 加一条描述符，不用改调用方。
 */

import { createRequire } from 'node:module';
import { decodePng, encodePng, resizeRgba } from './png-scale.js';
import { request } from './net.js';
import { localizedError } from './localized-error.js';
import {
  ASPECT_CHOICES, aspectLabel, nearestAspect, resolutionFor, baseUrlOf, headersFor,
  keyedHeaders, sleep, readJsonResponse, jsonRequest, getPath, sniffType, looksLikeImage,
  base64ToImage, fetchImageUrl, decodeImagePayload, classifyFailure, extractMessage,
  readResponseBytes, MAX_IMAGE_BYTES
} from './adapter-kit.js';
import { OPENAI_ADAPTERS } from './adapters/openai.js';

export {
  ASPECT_CHOICES, aspectLabel, nearestAspect, resolutionFor, sniffType, looksLikeImage,
  fetchImageUrl, decodeImagePayload, classifyFailure, extractMessage, readResponseBytes, MAX_IMAGE_BYTES
};

const require = createRequire(import.meta.url);
const DEFAULT_SIZE = '1024x1024';

/* ------------------------------------------------------------------ size */

export function parseSize(raw) {
  const text = String(raw || '').trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  if (!text || text === 'auto') return null;
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(text);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { width: width, height: height, text: width + 'x' + height };
}

function settle(size, adjusted, reason, requested) {
  const text = size && size.text ? size.text : String(size || DEFAULT_SIZE);
  const parsed = size && size.width ? size : parseSize(text);
  return {
    size: text,
    width: parsed ? parsed.width : 0,
    height: parsed ? parsed.height : 0,
    adjusted: !!adjusted,
    reason: reason || '',
    requested: requested || null
  };
}

function nearestAllowed(allowed, width, height) {
  const targetAspect = Math.log(width / height);
  const targetPixels = Math.log(width * height);
  let best = null;
  let bestScore = Infinity;
  for (const item of allowed) {
    if (item === 'auto') continue;
    const parsed = parseSize(item);
    if (!parsed) continue;
    const score = Math.abs(Math.log(parsed.width / parsed.height) - targetAspect) * 6
      + Math.abs(Math.log(parsed.width * parsed.height) - targetPixels) * 0.4;
    if (score < bestScore) {
      bestScore = score;
      best = parsed;
    }
  }
  return best;
}

function clampPixels(width, height, minPixels, maxPixels, multiple) {
  let w = width;
  let h = height;
  if (minPixels && w * h < minPixels) {
    const k = Math.sqrt(minPixels / (w * h));
    w = Math.ceil(w * k);
    h = Math.ceil(h * k);
  }
  if (maxPixels && w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    w = Math.floor(w * k);
    h = Math.floor(h * k);
  }
  w = Math.max(multiple, Math.round(w / multiple) * multiple);
  h = Math.max(multiple, Math.round(h / multiple) * multiple);
  return { width: w, height: h };
}

/**
 * 把用户要的尺寸落成该模型真正接受的尺寸。
 * 返回 { size, width, height, adjusted, reason, requested, rejected? }
 */
export function fitSize(adapter, rawSize) {
  const policy = adapter && adapter.size ? adapter.size : {};
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : null;
  const fallback = parseSize(policy.default || DEFAULT_SIZE) || parseSize(DEFAULT_SIZE);
  const requestedRaw = String(rawSize || '').trim();
  const requestedText = requestedRaw.toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  const requested = parseSize(requestedText);

  if (!requestedText || requestedText === 'none' || requestedText === 'auto') {
    // 用户选了「自动」：请求里干脆不带尺寸，让模型自己决定
    return { size: 'none', width: 0, height: 0, adjusted: false, reason: '', requested: null, omit: true };
  }

  if (!requested) {
    return settle(fallback, !!requestedRaw, requestedRaw ? '尺寸无法识别，改用 ' + fallback.text : '', null);
  }

  if (allowed && allowed.length) {
    if (allowed.includes(requested.text)) {
      return settle(requested, false, '', requested);
    }
    if (policy.onUnsupported === 'reject') {
      return Object.assign(settle(requested, false, '', requested), {
        rejected: true,
        reason: '该模型不支持 ' + requested.text + '，可用尺寸：' + allowed.join(' / ')
      });
    }
    const chosen = nearestAllowed(allowed, requested.width, requested.height) || fallback;
    return settle(chosen, true, requested.text + ' → ' + chosen.text, requested);
  }

  const multiple = Number(policy.multiple) || 1;
  const minPixels = Number(policy.minPixels) || 0;
  const maxPixels = Number(policy.maxPixels) || 0;
  const clamped = clampPixels(requested.width, requested.height, minPixels, maxPixels, multiple);
  const text = clamped.width + 'x' + clamped.height;
  return settle({ width: clamped.width, height: clamped.height, text: text }, text !== requested.text,
    text !== requested.text ? requested.text + ' → ' + text : '', requested);
}

/** 尺寸被上游拒了以后，往上抬一档再试。 */
export function escalateSize(adapter, fitted) {
  if (fitted && fitted.omit) return fitted;
  const policy = adapter && adapter.size ? adapter.size : {};
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : null;
  const currentPixels = (fitted.width || 0) * (fitted.height || 0);
  if (allowed && allowed.length) {
    let best = null;
    for (const item of allowed) {
      const parsed = parseSize(item);
      if (!parsed) continue;
      if (parsed.width * parsed.height > currentPixels && (!best || parsed.width * parsed.height < best.width * best.height)) best = parsed;
    }
    if (best) return settle(best, true, '上游拒绝 ' + fitted.size + '，抬到 ' + best.text, fitted.requested);
  }
  const width = Math.max(1, Math.round((fitted.width || 1024) * 1.5));
  const height = Math.max(1, Math.round((fitted.height || 1024) * 1.5));
  if ((fitted.width || 0) * (fitted.height || 0) < 1024 * 1024) {
    // 没有尺寸白名单时，常见的最小预算是 1MP，一步抬到位，省一次往返
    const k = Math.sqrt((1024 * 1024) / Math.max(1, (fitted.width || 1024) * (fitted.height || 1024)));
    const w = Math.round((fitted.width || 1024) * k);
    const h = Math.round((fitted.height || 1024) * k);
    return settle({ width: w, height: h, text: w + 'x' + h }, true, '上游拒绝 ' + fitted.size + '，抬到 ' + w + 'x' + h, fitted.requested);
  }
  return settle({ width: width, height: height, text: width + 'x' + height }, true, '上游拒绝 ' + fitted.size + '，抬到 ' + width + 'x' + height, fitted.requested);
}

/* -------------------------------------------------------------- adapters */

function encodeSize(adapter, fitted) {
  const policy = adapter.size || {};
  const field = policy.field || 'size';
  const style = policy.style || 'string';
  if (fitted.omit || fitted.size === 'none') return {};
  if (style === 'width-height') return { width: fitted.width, height: fitted.height };
  if (style === 'aspect') {
    const aspects = policy.aspects || ['1:1'];
    const label = aspectLabel(fitted.width || 1024, fitted.height || 1024);
    let chosen = aspects.includes(label) ? label : null;
    if (!chosen) {
      let bestScore = Infinity;
      for (const item of aspects) {
        const parts = String(item).split(':');
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        if (!a || !b) continue;
        const score = Math.abs(Math.log(a / b) - Math.log((fitted.width || 1024) / (fitted.height || 1024)));
        if (score < bestScore) {
          bestScore = score;
          chosen = item;
        }
      }
    }
    return { [field]: chosen || aspects[0] };
  }
  const separator = policy.separator || 'x';
  return { [field]: separator === 'x' ? fitted.size : fitted.size.split('x').join(separator) };
}

export function qualityOptionsFor(adapter, model) {
  const spec = adapter && adapter.quality;
  if (!spec) return null;
  const rawOptions = typeof spec.options === 'function' ? spec.options(model) : spec.options;
  if (!Array.isArray(rawOptions) || !rawOptions.length) return null;
  const options = rawOptions
    .map((item) => ({ value: String(item && item.value || '').trim().toLowerCase(), label: String(item && item.label || '') }))
    .filter((item) => item.value);
  if (!options.length) return null;
  const wanted = String(spec.default || '').trim().toLowerCase();
  const fallback = options.some((item) => item.value === wanted) ? wanted : options[0].value;
  return { label: spec.label || '质量', options, default: fallback };
}

export function qualityForAdapter(adapter, value, model) {
  const spec = qualityOptionsFor(adapter, model);
  if (!spec) return undefined;
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'off') return 'off';
  return spec.options.some((item) => item.value === raw) ? raw : spec.default;
}

function mapQuality(adapter, quality) {
  const value = String(quality || '').trim().toLowerCase();
  // Off：按用户要求完全不发这个参数
  if (!value || value === 'off' || value === 'auto') return undefined;
  const spec = adapter.quality;
  if (!spec) return undefined;
  if (spec.map && spec.map[value]) return spec.map[value];
  if (Array.isArray(spec.allowed) && spec.allowed.includes(value)) return value;
  if (spec.fallback) return spec.fallback;
  return undefined;
}

const IMAGE_MODEL_KEYWORDS = [
  'image', 'imagen', 'gpt-image', 'gptimage', 'dall-e', 'dalle', 'flux',
  'stable-diffusion', 'sdxl', 'sd3', 'diffusion', 't2i',
  'seedream', 'seededit', 'qwen-image', 'wanx', 'kolors', 'cogview',
  'ideogram', 'recraft', 'grok-imagine', 'nano-banana',
  'midjourney', 'journey', 'playground', 'photon', 'krea', 'hidream',
  'janus', 'emu', 'sana', 'pixart', 'dreamshaper', 'realvis',
  'juggernaut', 'fibo', 'lumina', 'chroma', 'omnigen', 'bagel',
  'sprite', 'paint'
];
const NON_IMAGE_MODEL_KEYWORDS = [
  'embedding', 'embed', 'whisper', 'tts', 'audio', 'speech',
  'moderation', 'rerank', 'transcribe', 'ocr', 'llava', 'image-to-text'
];
const EXACT_IMAGE_MODEL_IDS = new Set(['core']);

function normalizeModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/[_\s./:]+/g, '-');
}

/** Generic OpenAI-compatible `/models` often returns chat, embedding and image models together. */
export function isLikelyImageModel(model) {
  const id = normalizeModelId(model);
  if (!id) return false;
  if (EXACT_IMAGE_MODEL_IDS.has(id)) return true;
  if (NON_IMAGE_MODEL_KEYWORDS.some((keyword) => id.includes(keyword))) return false;
  return IMAGE_MODEL_KEYWORDS.some((keyword) => id.includes(keyword));
}

export function filterImageModels(models) {
  return (Array.isArray(models) ? models : []).filter(isLikelyImageModel);
}

/* ------------------------------------------------------------ ComfyUI 工作流 */

import { parseWorkflow, uiToApi, analyzeWorkflow, injectByMapping, applyWorkflowParams } from './comfy-workflow.js';

const OBJECT_INFO_TTL = 5 * 60 * 1000;
const objectInfoCache = new Map();

/** 拉全量节点签名并缓存；UI 格式工作流和模型列表都靠它。 */
async function comfyObjectInfo(base, provider, signal) {
  const hit = objectInfoCache.get(base);
  const now = Date.now();
  if (hit && now - hit.at < OBJECT_INFO_TTL) return hit.data;
  const response = await request(base + '/object_info', { headers: headersFor(provider, false), signal });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
    throw new Error('读不到 ComfyUI 的节点签名（/object_info），请确认服务在运行。');
  }
  const data = await readJsonResponse(response, 40 * 1024 * 1024);
  objectInfoCache.set(base, { at: now, data });
  return data;
}

/**
 * 读某个 loader 节点可选的模型名。优先只取单节点，避免自定义节点很多时
 * /object_info 的 20MB+ 全量响应；节点级 404 时退回全量。
 */
async function comfyNodeOptions(base, provider, node, field, signal) {
  let response = await request(base + '/object_info/' + node, { headers: headersFor(provider, false), signal });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_error) { /* ignore */ }
    response = await request(base + '/object_info', { headers: headersFor(provider, false), signal });
    if (!response.ok) return [];
  }
  const payload = await readJsonResponse(response, 20 * 1024 * 1024);
  const entry = payload && payload[node];
  const inputs = entry && entry.input;
  const names = (inputs && inputs.required && inputs.required[field])
    || (inputs && inputs.optional && inputs.optional[field]);
  const list = Array.isArray(names) ? names[0] : null;
  return Array.isArray(list) ? list.map((name) => String(name)).filter(Boolean) : [];
}

const FLUX2_NAME = /flux[._\-\s]?2/i;
/** MOSS 的编码器/VAE 名字长得很像 FLUX 的，装在一起时必须靠这些特征排除。 */
const MOSS_CLIP_NAME = /qwen3?[._\-\s]?5|9b/i;
const MOSS_VAE_NAME = /_small/i;

/** FLUX.2 是单文本编码器架构：按名字挑 qwen 编码器和 flux2 VAE。 */
async function comfyFluxAssets(base, provider, model, signal) {
  if (!FLUX2_NAME.test(String(model || ''))) {
    throw new Error('ComfyUI 目前内置的是 FLUX.2 系列（diffusion_models）工作流；'
      + '其它架构（如 FLUX.1、Qwen-Image、Z-Image）请改用「其他 OpenAI 兼容网关」。');
  }
  const clips = await comfyNodeOptions(base, provider, 'CLIPLoader', 'clip_name', signal);
  const vaes = await comfyNodeOptions(base, provider, 'VAELoader', 'vae_name', signal);
  const clip = clips.find((name) => /qwen[._\-\s]?3[._\-\s]?4b/i.test(name))
    || clips.find((name) => /qwen/i.test(name) && !MOSS_CLIP_NAME.test(name))
    || (clips.length === 1 ? clips[0] : null);
  const vae = vaes.find((name) => FLUX2_NAME.test(name) && !MOSS_VAE_NAME.test(name))
    || (vaes.length === 1 ? vaes[0] : null);
  if (!clip) throw new Error('ComfyUI 里找不到 FLUX.2 的文本编码器（models/text_encoders/qwen_3_4b.safetensors）。');
  if (!vae) throw new Error('ComfyUI 里找不到 FLUX.2 的 VAE（models/vae/flux2-vae.safetensors）。');
  return { clip, vae };
}

async function comfyUploadImage(base, provider, image, signal) {
  const form = new FormData();
  form.append('image', new Blob([image.buffer], { type: image.contentType || 'image/png' }),
    image.filename || 'reference.png');
  form.append('overwrite', 'true');
  const response = await request(base + '/upload/image', {
    method: 'POST', headers: headersFor(provider, true), body: form, signal
  });
  const payload = await readJsonResponse(response, 2 * 1024 * 1024);
  const name = payload && payload.name;
  if (!name) throw new Error('ComfyUI 上传参考图失败');
  const subfolder = payload.subfolder ? String(payload.subfolder) + '/' : '';
  return subfolder + String(name);
}

function comfyCheckpointWorkflow({ kind, input, model, width, height, seed, imageName }) {
  const workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: (input && input.negativePrompt) || '', clip: ['1', 1] } }
  };
  if (kind === 'edit') {
    workflow['4'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    workflow['5'] = { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } };
    workflow['6'] = {
      class_type: 'KSampler',
      inputs: {
        seed, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0]
      }
    };
    workflow['7'] = { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } };
    workflow['8'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['7', 0] } };
    return workflow;
  }
  workflow['4'] = { class_type: 'EmptyLatentImage', inputs: { width: width, height: height, batch_size: 1 } };
  workflow['5'] = {
    class_type: 'KSampler',
    inputs: {
      seed: seed, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0]
    }
  };
  workflow['6'] = { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } };
  workflow['7'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['6', 0] } };
  return workflow;
}

async function comfyFluxWorkflow(base, provider, { kind, input, model, width, height, seed, signal }) {
  const assets = await comfyFluxAssets(base, provider, model, signal);
  const workflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: assets.clip, type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: assets.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
    '7': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '8': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '9': { class_type: 'Flux2Scheduler', inputs: { steps: 4, width: width, height: height } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['12', 0] } }
  };
  if (kind === 'edit') {
    const reference = input.images && input.images[0];
    if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
    const imageName = await comfyUploadImage(base, provider, reference, signal);
    workflow['20'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    workflow['21'] = {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: ['20', 0], upscale_method: 'nearest-exact', megapixels: 1.0, resolution_steps: 1 }
    };
    workflow['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: ['3', 0] } };
    workflow['23'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['4', 0], latent: ['22', 0] } };
    workflow['24'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['5', 0], latent: ['22', 0] } };
    workflow['10'] = {
      class_type: 'CFGGuider',
      inputs: { model: ['1', 0], positive: ['23', 0], negative: ['24', 0], cfg: 1 }
    };
  } else {
    workflow['10'] = {
      class_type: 'CFGGuider',
      inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], cfg: 1 }
    };
  }
  workflow['11'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['7', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['6', 0] }
  };
  return workflow;
}

const MOSS_NAME = /moss/i;

async function comfyMossAssets(base, provider, signal) {
  const clips = await comfyNodeOptions(base, provider, 'CLIPLoader', 'clip_name', signal);
  const vaes = await comfyNodeOptions(base, provider, 'VAELoader', 'vae_name', signal);
  const clip = clips.find((name) => /qwen3[._]5/i.test(name))
    || clips.find((name) => /9b/i.test(name))
    || null;
  const vae = vaes.find((name) => /flux2-vae_small/i.test(name))
    || vaes.find((name) => FLUX2_NAME.test(name))
    || null;
  if (!clip) throw new Error('ComfyUI 里找不到 MOSS-Image 的文本编码器（models/text_encoders/qwen3.5_9b*.safetensors）。');
  if (!vae) throw new Error('ComfyUI 里找不到 MOSS-Image 的 VAE（models/vae/flux2-vae_small.safetensors）。');
  return { clip, vae };
}

async function comfyMossWorkflow(base, provider, { input, model, width, height, seed, signal }) {
  if (!MOSS_NAME.test(String(model || ''))) {
    throw new Error('ComfyUI 目前内置的是 MOSS-Image（diffusion_models）文生图工作流。');
  }
  const assets = await comfyMossAssets(base, provider, signal);
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: assets.clip, type: 'moss_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: assets.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: input.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: (input && input.negativePrompt) || '', clip: ['2', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: seed, steps: 25, cfg: 2.5, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0]
      }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['8', 0] } }
  };
}

const MOSS_EDIT_NEGATIVE = 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact';

/**
 * MOSS-Image 编辑：编辑 LoRA 叠在 SFT 主干上，指令和参考图一起交给
 * TextEncodeMOSSImageEdit 编码，采样器在原画面上只重绘被描述的部分。
 * 参数取自官方 image_moss_image_edit 模板（30 步 / cfg 4 / euler / normal / denoise 1）。
 */
async function comfyMossEditWorkflow(base, provider, { input, model, seed, signal }) {
  const assets = await comfyMossAssets(base, provider, signal);
  const loras = await comfyNodeOptions(base, provider, 'LoraLoaderModelOnly', 'lora_name', signal);
  const lora = loras.find((name) => /moss/i.test(name) && /edit/i.test(name));
  if (!lora) {
    throw new Error('ComfyUI 里找不到 MOSS-Image 的编辑 LoRA（models/loras/moss_image_edit_lora_rank_64_bf16.safetensors），'
      + '图生图无法进行；请放入该文件后重试，或改用 FLUX.2 模型。');
  }
  const reference = input.images && input.images[0];
  if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
  const imageName = await comfyUploadImage(base, provider, reference, signal);
  return {
    '8': { class_type: 'LoadImage', inputs: { image: imageName } },
    '27': { class_type: 'GetImageSize', inputs: { image: ['8', 0] } },
    // 输出比例跟原图走
    '28': { class_type: 'EmptyFlux2LatentImage', inputs: { width: ['27', 0], height: ['27', 1], batch_size: 1 } },
    '29': {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: ['8', 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 16 }
    },
    '30': { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    '31': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['30', 0], lora_name: lora, strength_model: 1 } },
    '32': {
      class_type: 'SkipLayerGuidanceDiTSimple',
      inputs: { model: ['31', 0], double_layers: '', single_layers: '22', start_percent: 0, end_percent: 1 }
    },
    '33': { class_type: 'CLIPLoader', inputs: { clip_name: assets.clip, type: 'moss_image', device: 'default' } },
    '34': { class_type: 'VAELoader', inputs: { vae_name: assets.vae } },
    '36': {
      class_type: 'TextEncodeMOSSImageEdit',
      inputs: {
        clip: ['33', 0], prompt: (input && input.negativePrompt) || MOSS_EDIT_NEGATIVE,
        edit_format: 'Moss-Image-Edit', image_strength: 1, 'images.image_0': ['29', 0], vae: ['34', 0]
      }
    },
    '39': {
      class_type: 'TextEncodeMOSSImageEdit',
      inputs: {
        clip: ['33', 0], prompt: input.prompt,
        edit_format: 'Moss-Image-Edit', image_strength: 1, 'images.image_0': ['29', 0], vae: ['34', 0]
      }
    },
    '37': {
      class_type: 'KSampler',
      inputs: {
        seed: seed, steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['32', 0], positive: ['39', 0], negative: ['36', 0], latent_image: ['28', 0]
      }
    },
    '38': { class_type: 'VAEDecode', inputs: { samples: ['37', 0], vae: ['34', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-mo-image', images: ['38', 0] } }
  };
}

async function comfySubmitAndWait(base, provider, workflow, signal) {
  const submitted = await readJsonResponse(await request(base + '/prompt', {
    method: 'POST', headers: headersFor(provider, false),
    body: JSON.stringify({ prompt: workflow, client_id: 'dsh-mo-image' }), signal
  }), 2 * 1024 * 1024);
  const promptId = submitted && submitted.prompt_id;
  if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id');
  const deadline = Date.now() + 300000;
  let history = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('已取消');
    await sleep(700);
    const poll = await request(base + '/history/' + encodeURIComponent(promptId), {
      headers: headersFor(provider, false), signal
    });
    if (!poll.ok) {
      if (poll.status === 404) continue;
      throw new Error('ComfyUI 查询任务失败：HTTP ' + poll.status);
    }
    const payload = await readJsonResponse(poll, 10 * 1024 * 1024);
    if (payload && payload[promptId]) { history = payload[promptId]; break; }
  }
  if (!history) throw new Error('ComfyUI 生成超时，请检查队列和显存');
  const state = history.status || {};
  if (state.status_str === 'error') {
    let detail = '';
    for (const message of state.messages || []) {
      if (message && message[0] === 'execution_error') {
        const info = message[1] || {};
        detail = String(info.exception_message || info.exception_type || '').trim();
      }
    }
    throw new Error('ComfyUI 执行失败' + (detail ? '：' + detail : '，请检查 ComfyUI 控制台'));
  }
  const outputs = history.outputs || {};
  let image = null;
  for (const node of Object.values(outputs)) {
    if (node && Array.isArray(node.images) && node.images[0] && node.images[0].filename) {
      image = node.images[0];
      break;
    }
  }
  if (!image) throw new Error('ComfyUI 没有返回图片');
  const query = new URLSearchParams({
    filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output'
  });
  return fetchImageUrl(base + '/view?' + query.toString(), signal);
}

/* ------------------------------------------------------ 自定义工作流模板 */

/**
 * 用户可以在「模型选项」里粘一段 ComfyUI 导出的 API 格式工作流，
 * 用这些占位符把运行时参数填进去。这样任何架构都能接，不必等插件补代码。
 */
export const COMFY_WORKFLOW_PLACEHOLDERS = [
  'prompt', 'negative_prompt', 'width', 'height', 'seed', 'model', 'image'
];

const PLACEHOLDER_EXACT = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const PLACEHOLDER_ANY = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function placeholderError(key) {
  return new Error('自定义工作流里有未知占位符 {{' + key + '}}；可用：'
    + COMFY_WORKFLOW_PLACEHOLDERS.map((name) => '{{' + name + '}}').join('、'));
}

function fillString(text, values, lenient) {
  const exact = PLACEHOLDER_EXACT.exec(text);
  if (exact) {
    const key = exact[1];
    // 整个字段就是一个占位符时保留原始类型（seed/width 必须是数字）
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined) return values[key];
    if (lenient) return '';
    throw placeholderError(key);
  }
  return text.replace(PLACEHOLDER_ANY, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const value = values[key];
      return value === undefined || value === null ? '' : String(value);
    }
    if (lenient) return '';
    throw placeholderError(key);
  });
}

/** 深拷贝模板并替换占位符；源模板不会被改动。 */
export function applyWorkflowTemplate(template, values, options) {
  const lenient = !!(options && options.lenient);
  const walk = (node) => {
    if (typeof node === 'string') return fillString(node, values, lenient);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  return walk(template);
}

/** 该模型有没有配置自定义工作流；没有就返回空串，走内置图。 */
function comfyCustomWorkflow(provider, model) {
  const options = provider && provider.modelOptions;
  if (!options || typeof options !== 'object') return '';
  const entry = options[model];
  if (!entry || typeof entry !== 'object') return '';
  return typeof entry.workflow === 'string' ? entry.workflow.trim() : '';
}

/**
 * 设置页解析用：把用户贴的工作流变成映射与候选。
 * UI 格式缺签名的节点会导致悬空连线，所以这里当硬错误处理。
 */
export async function analyzeComfyWorkflow({ base, provider, workflow, signal }) {
  const parsed = parseWorkflow(workflow);
  const info = await comfyObjectInfo(base, provider, signal);
  let graph = parsed.graph;
  if (parsed.format === 'ui') {
    const converted = uiToApi(parsed.ui, info);
    if (converted.missing.length) {
      throw new Error('工作流里的节点没有安装：' + converted.missing.join('、')
        + '。请在 ComfyUI 里装好它们，或改贴 API 格式的工作流。');
    }
    graph = converted.graph;
  }
  const analysis = analyzeWorkflow(graph, info);
  return { format: parsed.format, ...analysis };
}

async function comfyCustomGraph(base, provider, { kind, input, model, width, height, seed, raw, signal }) {
  const parsed = parseWorkflow(raw);
  let graph = parsed.graph;
  if (parsed.format === 'ui') {
    const info = await comfyObjectInfo(base, provider, signal);
    const converted = uiToApi(parsed.ui, info);
    if (converted.missing.length) {
      throw new Error('工作流里的节点没有安装：' + converted.missing.join('、')
        + '。请在 ComfyUI 里装好它们，或改贴 API 格式的工作流。');
    }
    graph = converted.graph;
  }

  const entry = provider && provider.modelOptions ? provider.modelOptions[model] : null;
  const mapping = entry && entry.mapping ? entry.mapping : null;
  const hasPlaceholder = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(raw);
  const values = {
    prompt: input.prompt || '',
    negative_prompt: input.negativePrompt || '',
    negativePrompt: input.negativePrompt || '',
    width, height, seed, model
  };

  if (kind === 'edit') {
    const hasImageSlot = /\{\{\s*image\s*\}\}/.test(raw);
    if (!hasImageSlot && !(mapping && mapping.image)) {
      throw new Error('这个自定义工作流里既没有 {{image}} 占位符，也没有可用的参考图映射，不能用于图生图；'
        + '请把参考图节点的 image 字段写成 {{image}}，或在模型选项里解析并确认映射。');
    }
    const reference = input.images && input.images[0];
    if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
    values.image = await comfyUploadImage(base, provider, reference, signal);
  }

  let out;
  if (hasPlaceholder) out = applyWorkflowTemplate(graph, values);
  else if (mapping) out = injectByMapping(graph, mapping, values).graph;
  else throw new Error('这个自定义工作流没有注入映射，请先在模型选项里解析并确认。');

  // 对话模型塞进来的可调参数：认得的写进去，认不得的记下来告诉它。
  const declared = entry && Array.isArray(entry.params) ? entry.params : [];
  const overrides = input && input.params && typeof input.params === 'object' ? input.params : null;
  if (overrides) {
    if (!declared.length) {
      return { graph: out, note: '当前模型没有暴露任何工作流参数，已忽略：' + Object.keys(overrides).join('、') };
    }
    const tuned = applyWorkflowParams(out, declared, overrides);
    const note = tuned.ignored.length
      ? '这些参数当前模型不支持或取值无效，已忽略：' + tuned.ignored.join('、')
      : '';
    return { graph: tuned.graph, note };
  }
  return { graph: out, note: '' };
}

const ADAPTERS = [
  {
    id: 'dall-e-3',
    label: 'OpenAI DALL·E 3',
    match: (provider, model) => /dall-?e-?3/i.test(model),
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'response_format', 'n'],
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: {
      label: '质量', default: 'standard', fallback: 'standard',
      allowed: ['standard', 'hd'],
      options: [
        { value: 'off', label: 'Off' },
        { value: 'standard', label: 'Standard' },
        { value: 'hd', label: 'HD' }
      ]
    },
    responseFormat: 'b64_json',
    maxN: 1,
    editFields: ['image[]', 'image']
  },
  {
    id: 'gpt-image',
    label: 'OpenAI GPT-Image',
    match: (provider, model) => /gpt-?image/i.test(model),
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'size', 'quality', 'n'],
    // gpt-image 2.x 起支持任意 W×H：16 的倍数、比例 1:3–3:1、像素 655360–8294400。
    size: { style: 'string', field: 'size', multiple: 16, minPixels: 655360, maxPixels: 8294400, default: '1024x1024', onUnsupported: 'nearest' },
    quality: {
      label: '质量', default: 'high', fallback: 'high',
      allowed: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
      options: (model) => {
        const maxed = /2\.5-(sunburst|flare)/i.test(String(model || ''));
        return [
          { value: 'off', label: 'Off' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ].concat(maxed ? [{ value: 'xhigh', label: 'XHigh' }, { value: 'max', label: 'Max' }] : [])
          .concat([{ value: 'auto', label: 'Auto' }]);
      }
    },
    maxN: 10,
    editFields: ['image[]', 'image']
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini / Nano Banana',
    match: (provider) => /generativelanguage\.googleapis\.com/i.test(String((provider && provider.baseUrl) || '')),
    local: false,
    endpoints: { generate: '/models', edit: '/models' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'aspect', field: 'aspect_ratio', aspects: ASPECT_CHOICES, default: '1024x1024', onUnsupported: 'nearest' },
    maxN: 1,
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models?pageSize=1000', {
        headers: keyedHeaders(provider, 'x-goog-api-key', false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload.models || [])
        .filter((item) => {
          const methods = item.supportedGenerationMethods;
          if (Array.isArray(methods) && !methods.includes('generateContent')) return false;
          return /gemini/i.test(String(item.name || '')) && /image/i.test(String(item.name || '')) && !/imagen/i.test(String(item.name || ''));
        })
        .map((item) => {
          const id = String(item.name || '').replace(/^models\//, '');
          const display = String(item.displayName || '').trim();
          return { id: id, name: display && display !== id ? display : '' };
        })
        .filter((entry) => entry.id)
        .slice(0, 100);
    },
    async execute(kind, provider, input, signal) {
      const model = String(input.model || '').replace(/^models\//, '').trim();
      if (!model) throw new Error('Gemini 模型 ID 不能为空');
      const images = input.images || [];
      if (images.length > 14) throw new Error('Gemini 一次最多支持 14 张参考图');
      const parts = [];
      for (const image of images) {
        if (!image || !image.buffer) continue;
        parts.push({
          inlineData: {
            mimeType: image.contentType || 'image/png',
            data: image.buffer.toString('base64')
          }
        });
      }
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      parts.push({ text: prompt });
      const width = input.fitted && !input.fitted.omit ? input.fitted.width : 1024;
      const height = input.fitted && !input.fitted.omit ? input.fitted.height : 1024;
      const generationConfig = {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: nearestAspect(width, height) }
      };
      if (/pro-image/i.test(model)) generationConfig.imageConfig.imageSize = resolutionFor(width, height).toUpperCase();
      const response = await request(baseUrlOf(provider) + '/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: keyedHeaders(provider, 'x-goog-api-key', false),
        body: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: generationConfig }),
        signal: signal
      });
      const payload = await readJsonResponse(response, 48 * 1024 * 1024);
      const partsOut = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts;
      for (const part of Array.isArray(partsOut) ? partsOut : []) {
        const inline = part && (part.inlineData || part.inline_data);
        if (!inline || !inline.data) continue;
        const decoded = base64ToImage(inline.data);
        if (!decoded) continue;
        return { bytes: decoded.bytes, contentType: inline.mimeType || inline.mime_type || decoded.contentType };
      }
      const finish = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].finishReason;
      throw new Error('Gemini 没有返回图片' + (finish ? '（finishReason=' + finish + '）' : ''));
    }
  },
  {
    id: 'xai-imagine',
    label: 'xAI Grok Imagine',
    match: (provider) => /(^|\.)api\.x\.ai$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]) || /xai-imagine/i.test(String((provider && provider.adapter) || '')),
    local: false,
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'aspect', field: 'aspect_ratio', aspects: ASPECT_CHOICES, default: '1024x1024', onUnsupported: 'nearest' },
    maxN: 1,
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', { headers: headersFor(provider, false), signal });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload.data || [])
        .map((item) => String(item && item.id || ''))
        .filter((name) => /imagine/i.test(name))
        .slice(0, 100);
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('xAI Grok Imagine 原生编辑暂未支持；请改用支持编辑的模型或网关。');
      const width = input.fitted && !input.fitted.omit ? input.fitted.width : 1024;
      const height = input.fitted && !input.fitted.omit ? input.fitted.height : 1024;
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      const body = {
        model: input.model, prompt: prompt, n: 1,
        response_format: 'url',
        aspect_ratio: nearestAspect(width, height),
        resolution: resolutionFor(width, height)
      };
      const response = await request(baseUrlOf(provider) + '/images/generations', {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      });
      const payload = await readJsonResponse(response, 10 * 1024 * 1024);
      const decoded = decodeImagePayload(payload, null);
      if (decoded.bytes) return decoded;
      if (decoded.url) return fetchImageUrl(decoded.url, signal);
      throw new Error('xAI Grok Imagine 没有返回图片');
    }
  },
  {
    id: 'recraft',
    label: 'Recraft',
    match: (provider) => /external\.api\.recraft\.ai/i.test(String((provider && provider.baseUrl) || '')),
    local: false,
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536', '2048x2048'], default: '1024x1024', onUnsupported: 'nearest' },
    maxN: 1,
    async listModels() {
      return ['recraftv4_1', 'recraftv4', 'recraftv3', 'recraftv2'];
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('Recraft 原生编辑暂未支持；请使用生成或换支持编辑的模型。');
      let prompt = String(input.prompt || '');
      if (input.negativePrompt) prompt += '\n\nAvoid: ' + String(input.negativePrompt);
      const body = {
        model: input.model, prompt: prompt, n: 1, response_format: 'url'
      };
      if (input.fitted && !input.fitted.omit && input.fitted.size) body.size = input.fitted.size;
      const response = await request(baseUrlOf(provider) + '/images/generations', {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      });
      const payload = await readJsonResponse(response, 32 * 1024 * 1024);
      const decoded = decodeImagePayload(payload, null);
      if (decoded.bytes) return decoded;
      if (decoded.url) return fetchImageUrl(decoded.url, signal);
      throw new Error('Recraft 没有返回图片');
    }
  },
  {
    id: 'ideogram',
    label: 'Ideogram',
    match: (provider) => /(^|\.)api\.ideogram\.ai$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]),
    local: false,
    endpoints: { generate: '/v2/image/generate/ideogram-3', edit: '' },
    transport: { generate: 'multipart', edit: 'json' },
    size: { style: 'aspect', field: 'aspect_ratio', aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: {
      label: '质量', default: 'default', fallback: 'default',
      allowed: ['turbo', 'default', 'quality'],
      map: { turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' },
      options: [
        { value: 'off', label: 'Off' },
        { value: 'turbo', label: 'Turbo' },
        { value: 'default', label: 'Default' },
        { value: 'quality', label: 'Quality' }
      ]
    },
    maxN: 1,
    async listModels() {
      return ['ideogram-3'];
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('Ideogram 原生编辑暂未支持；请使用生成或换支持编辑的模型。');
      const form = new FormData();
      form.append('prompt', String(input.prompt || ''));
      if (input.negativePrompt) form.append('negative_prompt', String(input.negativePrompt));
      const speed = input.quality && input.quality !== 'off'
        ? ({ turbo: 'TURBO', default: 'DEFAULT', quality: 'QUALITY' })[String(input.quality).toLowerCase()]
        : '';
      if (speed) form.append('rendering_speed', speed);
      form.append('aspect_ratio', nearestAspect(input.fitted && input.fitted.width, input.fitted && input.fitted.height));
      form.append('num_images', '1');
      const response = await request(baseUrlOf(provider) + '/v2/image/generate/ideogram-3', {
        method: 'POST',
        headers: keyedHeaders(provider, 'Api-Key', true),
        body: form,
        signal: signal
      });
      const payload = await readJsonResponse(response, 32 * 1024 * 1024);
      const decoded = decodeImagePayload(payload, null);
      if (decoded.bytes) return decoded;
      if (decoded.url) return fetchImageUrl(decoded.url, signal);
      throw new Error('Ideogram 没有返回图片');
    }
  },
  {
    id: 'together',
    label: 'Together AI',
    match: (provider) => /(^|\.)api\.together\.xyz$/i.test(String((provider && provider.baseUrl) || '').replace(/^https?:\/\//, '').split('/')[0]),
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'width', 'height', 'n', 'response_format'],
    size: { style: 'width-height', default: '1024x1024', onUnsupported: 'nearest' },
    responseFormat: 'url',
    maxN: 1
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    match: (provider, model) => /siliconflow/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/images/generations', edit: '/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'negative_prompt', 'image_size', 'batch_size', 'num_inference_steps', 'guidance_scale', 'seed'],
    size: { style: 'string', field: 'image_size', allowed: ['1024x1024', '768x1024', '1024x768', '512x512'], default: '1024x1024', onUnsupported: 'nearest' },
    maxN: 1,
    editFields: ['image']
  },
  {
    id: 'volcengine-ark',
    label: '火山方舟',
    match: (provider, model) => /volces\.com/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/images/generations', edit: '/images/generations' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'size', 'response_format', 'watermark', 'n'],
    size: { style: 'string', field: 'size', allowed: ['1024x1024', '864x1152', '1152x864'], default: '1024x1024', onUnsupported: 'nearest' },
    responseFormat: 'url',
    watermark: false,
    maxN: 1,
    editFields: ['image']
  },
  {
    id: 'stability',
    label: 'Stability AI',
    match: (provider, model) => /stability\.ai/i.test(provider.baseUrl || ''),
    endpoints: { generate: '/v2beta/stable-image/generate/core', edit: '/v2beta/stable-image/generate/sd3' },
    transport: { generate: 'multipart', edit: 'multipart' },
    send: ['prompt', 'negative_prompt', 'aspect_ratio', 'output_format', 'model'],
    size: { style: 'aspect', field: 'aspect_ratio', aspects: ['1:1', '16:9', '3:2', '4:3', '9:16', '2:3'], default: '1024x1024', onUnsupported: 'nearest' },
    quality: null,
    binary: true,
    maxN: 1,
    editFields: ['image']
  },
  {
    // 异步入队型：提交拿 task_id → 轮询到 SUCCEEDED → 下载结果。
    // body 是嵌套结构，用 compose 把白名单字段折叠进去。
    id: 'dashscope-wanx',
    label: '阿里云百炼 · 通义万相',
    match: (provider, model) => /dashscope\.aliyuncs\.com/i.test(provider.baseUrl || '') || /(?:^|[/-])wanx/i.test(model),
    async: true,
    submit: '/services/aigc/text2image/image-synthesis',
    headers: { 'X-DashScope-Async': 'enable' },
    poll: {
      path: '/tasks/{taskId}',
      idPath: 'output.task_id',
      statusPath: 'output.task_status',
      resultPath: 'output.results',
      success: ['SUCCEEDED'],
      failure: ['FAILED', 'CANCELED', 'UNKNOWN'],
      intervalMs: 2000,
      timeoutMs: 300000
    },
    endpoints: { generate: '/services/aigc/text2image/image-synthesis', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'negative_prompt', 'size', 'n'],
    compose: (fields) => ({
      model: fields.model,
      input: { prompt: fields.prompt, negative_prompt: fields.negative_prompt },
      parameters: { size: fields.size, n: fields.n }
    }),
    size: {
      style: 'string', field: 'size', separator: '*',
      allowed: ['1024x1024', '1280x720', '720x1280', '1024x768', '768x1024'],
      default: '1024x1024', onUnsupported: 'nearest'
    },
    quality: null,
    maxN: 4,
    editFields: []
  },
  {
    id: 'a1111',
    label: 'AUTOMATIC1111 / Forge / SD.Next / Draw Things',
    match: (provider) => /a1111|forge|sdnext|sd-next|drawthings/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/sdapi/v1/txt2img', edit: '/sdapi/v1/img2img' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/sdapi/v1/sd-models', {
        headers: headersFor(provider, false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      if (!Array.isArray(payload)) return [];
      return payload
        .map((item) => String((item && (item.title || item.model_name || item.name)) || '').trim())
        .filter(Boolean);
    },
    async execute(kind, provider, input, signal) {
      const size = input.fitted && !input.fitted.omit
        ? { width: input.fitted.width, height: input.fitted.height }
        : { width: 1024, height: 1024 };
      const body = {
        prompt: input.prompt,
        negative_prompt: input.negativePrompt || '',
        batch_size: 1,
        n_iter: 1,
        ...size
      };
      if (input.model) body.override_settings = { sd_model_checkpoint: input.model };
      let endpoint = '/sdapi/v1/txt2img';
      if (kind === 'edit') {
        const image = input.images && input.images[0];
        if (!image) throw new Error('A1111 编辑需要参考图');
        const dimensions = imageDimensions(image.buffer) || size;
        body.init_images = [image.buffer.toString('base64')];
        body.denoising_strength = 0.6;
        body.width = dimensions.width;
        body.height = dimensions.height;
        endpoint = '/sdapi/v1/img2img';
      }
      const response = await request(baseUrlOf(provider) + endpoint, {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      });
      const payload = await readJsonResponse(response, 50 * 1024 * 1024);
      const first = payload && Array.isArray(payload.images) ? payload.images[0] : null;
      const decoded = base64ToImage(first);
      if (!decoded) throw new Error('A1111 没有返回图片');
      return decoded;
    }
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    match: (provider) => /comfyui/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/prompt', edit: '/prompt' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', multiple: 8, default: '1024x1024', onUnsupported: 'nearest' },
    async listModels(provider, signal) {
      const base = baseUrlOf(provider);
      const checkpoints = await comfyNodeOptions(base, provider, 'CheckpointLoaderSimple', 'ckpt_name', signal);
      const diffusion = await comfyNodeOptions(base, provider, 'UNETLoader', 'unet_name', signal);
      return Array.from(new Set(checkpoints.concat(diffusion)));
    },
    async execute(kind, provider, input, signal) {
      const base = baseUrlOf(provider);
      const width = input.fitted && !input.fitted.omit ? input.fitted.width : 1024;
      const height = input.fitted && !input.fitted.omit ? input.fitted.height : 1024;
      const seed = Math.floor(Math.random() * 2147483647);
      const model = input.model;

      const custom = comfyCustomWorkflow(provider, model);
      if (custom) {
        const built = await comfyCustomGraph(base, provider, {
          kind, input, model, width, height, seed, raw: custom, signal
        });
        const result = await comfySubmitAndWait(base, provider, built.graph, signal);
        return built.note ? Object.assign({}, result, { note: built.note }) : result;
      }
      const diffusionModels = await comfyNodeOptions(base, provider, 'UNETLoader', 'unet_name', signal);
      let workflow;
      if (diffusionModels.includes(model) && /moss/i.test(model)) {
        workflow = kind === 'edit'
          ? await comfyMossEditWorkflow(base, provider, { input, model, seed, signal })
          : await comfyMossWorkflow(base, provider, { input, model, width, height, seed, signal });
      } else if (diffusionModels.includes(model)) {
        workflow = await comfyFluxWorkflow(base, provider, { kind, input, model, width, height, seed, signal });
      } else {
        let imageName = null;
        if (kind === 'edit') {
          const reference = input.images && input.images[0];
          if (!reference || !reference.buffer) throw new Error('ComfyUI 编辑需要一张参考图');
          imageName = await comfyUploadImage(base, provider, reference, signal);
        }
        workflow = comfyCheckpointWorkflow({ kind, input, model, width, height, seed, imageName });
      }
      return comfySubmitAndWait(base, provider, workflow, signal);
    }
  },
  {
    id: 'swarmui',
    label: 'SwarmUI',
    match: (provider) => /swarmui/i.test(String((provider && provider.adapter) || '')),
    local: true,
    endpoints: { generate: '/API/GenerateText2Image', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    size: { style: 'string', field: 'size', multiple: 8, default: '1024x1024', onUnsupported: 'nearest' },
    async newSession(provider, signal) {
      const payload = await readJsonResponse(await request(baseUrlOf(provider) + '/API/GetNewSession', {
        method: 'POST', headers: headersFor(provider, false), body: '{}', signal
      }), 2 * 1024 * 1024);
      const session = payload && payload.session_id;
      if (!session) throw localizedError(new Error('SwarmUI 没有返回 session_id'), 'upstream.invalidResponse', { service: 'SwarmUI', field: 'session_id' });
      return session;
    },
    async listModels(provider, signal) {
      const session = await this.newSession(provider, signal);
      const payload = await readJsonResponse(await request(baseUrlOf(provider) + '/API/ListModels', {
        method: 'POST', headers: headersFor(provider, false),
        body: JSON.stringify({ session_id: session, path: '', depth: 2, subtype: 'Stable-Diffusion' }), signal
      }), 5 * 1024 * 1024);
      const files = payload && Array.isArray(payload.files) ? payload.files : [];
      return files.map((item) => String((item && (item.name || item.id)) || '').trim()).filter(Boolean);
    },
    async execute(kind, provider, input, signal) {
      if (kind === 'edit') throw new Error('SwarmUI 原生编辑暂未支持；请改用支持 /images/edits 的 OpenAI 兼容网关');
      const base = baseUrlOf(provider);
      const session = await this.newSession(provider, signal);
      const width = input.fitted && !input.fitted.omit ? input.fitted.width : 1024;
      const height = input.fitted && !input.fitted.omit ? input.fitted.height : 1024;
      const body = {
        session_id: session, images: 1,
        prompt: input.prompt, negativeprompt: input.negativePrompt || '',
        model: input.model, width: width, height: height,
        cfgscale: 7, steps: 20, seed: -1
      };
      const generated = await readJsonResponse(await request(base + '/API/GenerateText2Image', {
        method: 'POST', headers: headersFor(provider, false), body: JSON.stringify(body), signal
      }), 5 * 1024 * 1024);
      const image = generated && Array.isArray(generated.images) ? generated.images[0] : null;
      if (!image) throw new Error('SwarmUI 没有返回图片');
      if (String(image).startsWith('data:')) {
        const decoded = base64ToImage(image);
        if (!decoded) throw new Error('SwarmUI 返回的图片无法解码');
        return decoded;
      }
      if (/^https?:\/\//i.test(String(image))) return fetchImageUrl(String(image), signal);
      return fetchImageUrl(base + '/' + String(image).replace(/^\/+/, ''), signal);
    }
  },
  {
    id: 'localai',
    label: 'LocalAI',
    match: (provider) => /localai/i.test(String((provider && provider.adapter) || '')),
    local: true,
    // LocalAI 没有 /v1/images/edits：图生图要换成 generations + file/ref_images，
    // 语义和 OpenAI 不同，所以这里明确声明不支持编辑，让 UI 直接告诉用户换网关。
    endpoints: { generate: '/images/generations', edit: '' },
    transport: { generate: 'json', edit: 'json' },
    send: ['model', 'prompt', 'negative_prompt', 'size', 'quality', 'n'],
    size: { style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    quality: null,
    maxN: 4,
    editFields: [],
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', {
        headers: headersFor(provider, false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return openAiCompatibleEntries(payload);
    }
  },
  ...OPENAI_ADAPTERS,
  {
    id: 'openai-images',
    label: 'OpenAI Images 兼容',
    match: () => true,
    endpoints: { generate: '/images/generations', edit: '/images/edits' },
    transport: { generate: 'json', edit: 'multipart' },
    send: ['model', 'prompt', 'negative_prompt', 'size', 'quality', 'n'],
    // 通用兼容族：尺寸原样透传（保持旧行为），被上游拒了再靠重试往上抬。
    size: { style: 'string', field: 'size', multiple: 1, default: '1024x1024', onUnsupported: 'nearest' },
    quality: null,
    maxN: 4,
    editFields: ['image[]', 'image'],
    async listModels(provider, signal) {
      return (await this.listModelEntries(provider, signal)).map((entry) => entry.id);
    },
    async listModelEntries(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', {
        headers: headersFor(provider, false), signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return openAiCompatibleEntries(payload);
    }
  }
];

export async function listProviderModels(adapter, provider, signal) {
  if (!adapter || typeof adapter.listModels !== 'function') {
    throw localizedError(new Error('该部署器不支持获取模型列表'), 'models.unsupported');
  }
  return adapter.listModels(provider, signal);
}

/** OpenAI 兼容的 `/models` 条目：id 是请求要用的标识，display_name / name 才是人类可读名。*/
function openAiCompatibleEntries(payload) {
  const data = payload && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const entries = [];
  for (const item of data) {
    // 没有 id 的网关常把模型名写在 name 里，这时 name 就是 id。
    const id = String((item && (item.id || item.name)) || '').trim();
    if (!id) continue;
    const display = String((item && (item.display_name || item.displayName || item.name)) || '').trim();
    entries.push({ id: id, name: display && display !== id ? display : '' });
  }
  return entries;
}

/**
 * 模型列表连同显示名一起取回。适配器只给 id 时显示名留空，由客户端退回 id；
 * 这样设置页「获取可用模型」之后能直接把名称填进模型行。
 */
export async function listProviderModelEntries(adapter, provider, signal) {
  if (adapter && typeof adapter.listModelEntries === 'function') {
    const entries = await adapter.listModelEntries(provider, signal);
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => ({ id: String((entry && entry.id) || '').trim(), name: String((entry && entry.name) || '').trim() }))
      .filter((entry) => entry.id);
  }
  const ids = await listProviderModels(adapter, provider, signal);
  return (Array.isArray(ids) ? ids : [])
    .map((id) => ({ id: String(id || '').trim(), name: '' }))
    .filter((entry) => entry.id);
}

export function listAdapters() {
  return ADAPTERS.map((item) => ({ id: item.id, label: item.label }));
}

/**
 * 该适配器是否支持某种操作（generate / edit）。
 * endpoints.edit 为空串表示原生不支持编辑——调用方据此直接报「不支持」，
 * 而不是偷偷换一个模型。
 */
export function adapterSupportsKind(adapter, kind) {
  if (!adapter || !adapter.endpoints) return false;
  return kind === 'edit' ? Boolean(adapter.endpoints.edit) : Boolean(adapter.endpoints.generate);
}

/** 本地部署入口的唯一数据源：客户端不再维护一份重复的 preset 表。 */
export function providerPresetManifest() {
  return PROVIDER_PRESETS.map((preset) => Object.assign({}, preset, { models: (preset.models || []).slice() }));
}

/** 云端内置提供商；和本地 preset 一样由宿主下发，客户端不再维护第二份。 */
export const PROVIDER_PRESETS = [
  {
    id: 'gemini', name: 'Google Gemini / Nano Banana',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', adapter: 'google-gemini',
    website: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview']
  },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '', website: 'https://platform.openai.com/api-keys', models: [] },
  {
    id: 'xai', name: 'xAI Grok Imagine',
    baseUrl: 'https://api.x.ai/v1', adapter: 'xai-imagine',
    website: 'https://console.x.ai/',
    models: ['grok-imagine-image']
  },
  {
    id: 'recraft', name: 'Recraft',
    baseUrl: 'https://external.api.recraft.ai/v1', adapter: 'recraft',
    website: 'https://www.recraft.ai/profile/api',
    models: ['recraftv4_1', 'recraftv4', 'recraftv3', 'recraftv2']
  },
  {
    id: 'ideogram', name: 'Ideogram',
    baseUrl: 'https://api.ideogram.ai', adapter: 'ideogram',
    website: 'https://developer.ideogram.ai/',
    models: ['ideogram-3']
  },
  {
    id: 'stability', name: 'Stability AI',
    baseUrl: 'https://api.stability.ai', adapter: 'stability',
    website: 'https://platform.stability.ai/account/keys',
    models: ['core']
  },
  {
    id: 'together', name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1', adapter: 'together',
    website: 'https://api.together.ai/settings/api-keys',
    models: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev']
  },
  {
    id: 'fireworks', name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1', adapter: 'openai-images',
    website: 'https://fireworks.ai/account/api-keys',
    models: ['accounts/fireworks/models/flux-1-schnell']
  },
  {
    id: 'novita', name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai', adapter: 'openai-images',
    website: 'https://novita.ai/settings/key-management',
    models: ['flux-1-schnell']
  },
  {
    id: 'openrouter', name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1', adapter: 'openrouter-images',
    website: 'https://openrouter.ai/settings/keys',
    models: ['google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-flare', 'black-forest-labs/flux-2-pro']
  },
  {
    id: 'azure', name: 'Azure OpenAI',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', adapter: 'azure-openai',
    website: 'https://portal.azure.com/',
    models: []
  },
  { id: 'volcengine', name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: '', website: 'https://console.volcengine.com/ark', models: [] },
  { id: 'dashscope', name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', adapter: '', website: 'https://bailian.console.aliyun.com/', models: [] },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', adapter: '', website: 'https://cloud.siliconflow.cn/account/ak', models: [] },
  { id: 'bigmodel', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', adapter: '', website: 'https://bigmodel.cn/usercenter/apikeys', models: [] }
];

export const LOCAL_PRESETS = [
  {
    id: 'sd-server', name: 'stable-diffusion.cpp (sd-server)', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。',
    hint: '原生 OpenAI Images 接口，生成和 /images/edits 编辑都支持；模型名通常是 sd-cpp-local，可从 /v1/models 获取。'
  },
  {
    id: 'localai', name: 'LocalAI', adapter: 'localai',
    baseUrl: 'http://127.0.0.1:8080/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，末尾保留 /v1；插件会拼 /images/generations 和 /models。',
    hint: 'OpenAI Images 兼容，生成可用；模型名填 LocalAI 模型 YAML 里的 name，可从 /v1/models 获取。LocalAI 没有 /images/edits，图生图需要走「其他 OpenAI 兼容网关」接一个支持编辑的后端。'
  },
  {
    id: 'a1111', name: 'AUTOMATIC1111 / Forge / SD.Next / Draw Things', adapter: 'a1111',
    baseUrl: 'http://127.0.0.1:7860', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /sdapi/v1；插件会拼 /sdapi/v1/txt2img、/img2img、/sd-models。',
    hint: '走 /sdapi/v1/txt2img 和 /sdapi/v1/img2img，模型列表来自 /sdapi/v1/sd-models；A1111 需要启动时加 --api。'
  },
  {
    id: 'comfyui', name: 'ComfyUI', adapter: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /prompt；插件会拼 /prompt、/upload/image、/history、/view。',
    hint: '支持 SD/SDXL 单文件 checkpoint、FLUX.2 系列和 MOSS-Image（含编辑 LoRA 的图生图），模型列表来自 /object_info。FLUX.1、Qwen-Image 等其它架构仍建议走 OpenAI 兼容网关。'
  },
  {
    id: 'swarmui', name: 'SwarmUI', adapter: 'swarmui',
    baseUrl: 'http://127.0.0.1:7801', optionalKey: true, supportsModels: true,
    urlHint: '只填服务根地址，不要带 /API；插件会拼 /API/GetNewSession、/API/ListModels、/API/GenerateText2Image。',
    hint: '走 /API/GenerateText2Image，模型列表来自 /API/ListModels；生成可用，原生编辑暂不支持。'
  },
  {
    id: 'openai-gateway', name: '其他 OpenAI 兼容网关', adapter: 'openai-images',
    baseUrl: 'http://127.0.0.1:3000/v1', optionalKey: true, supportsModels: true,
    urlHint: '只填 OpenAI API 根地址（通常带 /v1）；插件会拼 /images/generations 和 /models。',
    hint: 'InvokeAI、Fooocus、复杂 ComfyUI 工作流或自建服务，只要暴露 /v1/images/generations 就选这个。'
  }
];

export function adapterManifest() {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    local: !!adapter.local,
    supportsModels: typeof adapter.listModels === 'function'
  }));
}

export function localPresetManifest() {
  return LOCAL_PRESETS.map((preset) => ({ ...preset }));
}

export function resolveAdapter(provider, model) {
  const protocol = String((provider && provider.protocol) || '').trim().toLowerCase();
  if (protocol && protocol !== 'openai-images' && protocol !== 'auto' && protocol !== 'images') {
    const byProtocol = ADAPTERS.find((item) => item.id === protocol);
    if (!byProtocol) {
      throw localizedError(
        new Error('暂不支持该生图协议：' + protocol + '（可用：' + ADAPTERS.map((item) => item.id).join(' / ') + '）'),
        'adapter.unknownProtocol',
        { protocol: protocol, available: ADAPTERS.map((item) => item.id).join(' / ') }
      );
    }
    return byProtocol;
  }
  const explicit = String((provider && provider.adapter) || '').trim().toLowerCase();
  if (explicit) {
    const hit = ADAPTERS.find((item) => item.id === explicit);
    if (hit) return hit;
    throw localizedError(
      new Error('找不到生图适配器：' + explicit + '（可用：' + ADAPTERS.map((item) => item.id).join(' / ') + '）'),
      'adapter.notFound',
      { adapter: explicit, available: ADAPTERS.map((item) => item.id).join(' / ') }
    );
  }
  const modelId = String(model || '');
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match && adapter.match(provider || {}, modelId)) return adapter;
    } catch (_error) {
      /* 一个适配器的判定出错不应影响其它适配器 */
    }
  }
  return ADAPTERS[ADAPTERS.length - 1];
}

export function describeAdapter(adapter) {
  return adapter.id + ' (' + adapter.label + ')';
}

/* -------------------------------------------------------------- requests */

/** A1111 img2img 需要原图尺寸；PNG/JPEG 足够覆盖常见参考图。 */
function imageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function pickFields(adapter, candidate, drops) {
  const body = {};
  const blocked = drops || new Set();
  for (const key of adapter.send || []) {
    if (blocked.has(key)) continue;
    const value = candidate[key];
    if (value === undefined || value === null || value === '') continue;
    body[key] = value;
  }
  return body;
}

function buildFields(adapter, input) {
  const sizeFields = encodeSize(adapter, input.fitted);
  return Object.assign({
    model: input.model,
    prompt: input.prompt,
    negative_prompt: input.negativePrompt,
    n: adapter.maxN ? Math.min(input.n || 1, adapter.maxN) : undefined,
    quality: mapQuality(adapter, input.quality),
    seed: input.seed,
    response_format: adapter.responseFormat,
    watermark: adapter.watermark,
    output_format: adapter.binary ? 'png' : adapter.outputFormat
  }, sizeFields);
}

/** 白名单过滤 → 需要嵌套 body 的模型再用 compose 折叠。 */
function composeBody(adapter, input, drops) {
  const fields = pickFields(adapter, buildFields(adapter, input), drops);
  return adapter.compose ? adapter.compose(fields) : fields;
}

/** 端点既可以是固定字符串，也可以是按模型拼路径的函数（Ideogram、fal 这类）。 */
function endpointOf(value, input) {
  return typeof value === 'function' ? value(input || {}) : value;
}

export function prepareGenerate(adapter, provider, input, drops) {
  const body = composeBody(adapter, input, drops);
  if (adapter.transport.generate === 'multipart') {
    const form = new FormData();
    for (const key of Object.keys(body)) form.append(key, String(body[key]));
    return { path: endpointOf(adapter.endpoints.generate, input), headers: headersFor(provider, true, adapter.headers, adapter), body: form };
  }
  return jsonRequest(adapter, provider, endpointOf(adapter.endpoints.generate, input), body);
}

export function prepareEdit(adapter, provider, input, drops, fieldName) {
  const body = composeBody(adapter, input, drops);
  if (adapter.transport.edit !== 'multipart') {
    // 非 multipart 的编辑接口（如 SiliconFlow / 火山方舟）用 image 字段承载
    // 参考图；统一编码成 data URL，单张发字符串，多张发数组。
    const field = fieldName || (adapter.editFields && adapter.editFields[0]) || 'image';
    const images = input.images || [];
    if (images.length > 0) {
      const encoded = images
        .filter((image) => image && image.buffer && image.contentType)
        .map((image) => 'data:' + image.contentType + ';base64,' + image.buffer.toString('base64'));
      if (encoded.length > 0) body[field] = encoded.length === 1 ? encoded[0] : encoded;
    }
    return jsonRequest(adapter, provider, endpointOf(adapter.endpoints.edit, input), body);
  }
  const form = new FormData();
  for (const key of Object.keys(body)) form.append(key, String(body[key]));
  const field = fieldName || (adapter.editFields && adapter.editFields[0]) || 'image';
  for (const image of input.images || []) {
    form.append(field, new Blob([image.buffer], { type: image.contentType }), image.filename);
  }
  return { path: endpointOf(adapter.endpoints.edit, input), headers: headersFor(provider, true, adapter.headers, adapter), body: form };
}

/** 异步任务：先提交拿 task_id。 */
export function prepareAsync(adapter, provider, input, drops) {
  return jsonRequest(adapter, provider, adapter.submit, composeBody(adapter, input, drops));
}

/** 新式异步描述符：提交体与提交路径都由适配器自己决定。 */
export function preparePhaseAsync(adapter, provider, input) {
  const phase = adapter.async || {};
  const path = String(phase.submitPath(input) || '');
  return {
    path: path,
    headers: headersFor(provider, false, adapter.headers, adapter),
    body: JSON.stringify(phase.build(input, provider) || {})
  };
}

export function pollUrlFor(adapter, provider, taskId) {
  const template = String((adapter.poll && adapter.poll.path) || '/tasks/{taskId}');
  return baseUrlOf(provider) + template.replace('{taskId}', encodeURIComponent(taskId));
}

export function pollHeaders(provider) {
  return { Authorization: 'Bearer ' + String((provider && provider.key) || '') };
}

export function readTaskId(adapter, payload) {
  const value = getPath(payload, (adapter.poll && adapter.poll.idPath) || 'output.task_id');
  return value ? String(value) : null;
}

/** 把不同平台的「排队中 / 成功 / 失败」收敛成一个三态。 */
export function readTaskState(adapter, payload) {
  const poll = adapter.poll || {};
  const status = String(getPath(payload, poll.statusPath || 'output.task_status') || '').toUpperCase();
  const success = poll.success || ['SUCCEEDED'];
  const failure = poll.failure || ['FAILED', 'CANCELED'];
  if (success.includes(status)) {
    return { state: 'success', status: status, node: getPath(payload, poll.resultPath || 'output') };
  }
  if (failure.includes(status)) {
    const message = String(getPath(payload, 'output.message') || getPath(payload, 'message') || status);
    return { state: 'failure', status: status, message: message };
  }
  return { state: 'pending', status: status };
}

export function adapterBase(provider) {
  return baseUrlOf(provider);
}

/* ----------------------------------------------------------------- resize */

/**
 * 生成尺寸被抬大以后，把结果缩回用户要的尺寸。
 * PNG 走自带的纯 JS 面积平均缩放（无依赖、任何进程可用）；
 * 其它格式再试 Electron 的 nativeImage。
 */
export function resizeTo(bytes, width, height) {
  if (!bytes || !width || !height) return null;
  try {
    const image = decodePng(bytes);
    if (image) {
      if (image.width === width && image.height === height) return { bytes: bytes, contentType: 'image/png', resized: false };
      const rgba = resizeRgba(image.rgba, image.width, image.height, width, height);
      return { bytes: encodePng(rgba, width, height), contentType: 'image/png', resized: true };
    }
  } catch (_error) {
    /* 落到下面的 Electron 通路 */
  }
  try {
    const electron = require('electron');
    const nativeImage = electron && electron.nativeImage;
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
    const image = nativeImage.createFromBuffer(bytes);
    if (!image || image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width === width && size.height === height) return { bytes: bytes, contentType: 'image/png', resized: false };
    const resized = image.resize({ width: width, height: height, quality: 'best' });
    const png = resized.toPNG();
    if (!png || !png.length) return null;
    return { bytes: png, contentType: 'image/png', resized: true };
  } catch (_error) {
    return null;
  }
}

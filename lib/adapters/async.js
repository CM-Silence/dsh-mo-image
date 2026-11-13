/**
 * 异步队列型协议：BFL / fal.ai / Replicate。
 *
 * 三个平台的共同点是「提交 → 轮询 → 拿一个会过期的 URL」，差异全部收敛到
 * async 描述符：build / submitPath / pollUrl / pollHeaders / statusOf / resolve。
 * 拿到 URL 必须立刻下载，不能交给上层。
 */
import { request } from '../net.js';
import {
  baseUrlOf, headersFor, authHeaders, readJsonResponse, dataUrlOf, nearestAspect, resolutionFor
} from '../adapter-kit.js';

function hostOf(provider) {
  return String((provider && provider.baseUrl) || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
}

function promptWithNegative(input) {
  const prompt = String((input && input.prompt) || '');
  const negative = String((input && input.negativePrompt) || '').trim();
  return negative ? prompt + '\n\nAvoid: ' + negative : prompt;
}

function imagesOf(input) {
  return (Array.isArray(input && input.images) ? input.images : [])
    .filter((image) => image && image.buffer && image.contentType);
}

function sizeOf(input) {
  const fitted = input && input.fitted;
  if (!fitted || fitted.omit || fitted.size === 'none' || fitted.size === 'auto') return null;
  if (!fitted.width || !fitted.height) return null;
  return { width: fitted.width, height: fitted.height };
}

/* ------------------------------------------------------------------ BFL */

const BFL_SUCCESS = new Set(['READY']);
const BFL_FAILURE = new Set([
  'ERROR', 'REQUEST MODERATED', 'CONTENT MODERATED', 'NO CARD GENERATED', 'TASK NOT FOUND'
]);

function bflBuild(input) {
  const model = String(input.model || '');
  const images = imagesOf(input);
  const body = { prompt: promptWithNegative(input) };
  const size = sizeOf(input) || { width: 1024, height: 1024 };

  // FLUX 3 只认 aspect_ratio / resolution / images，未知字段直接 422。
  if (/^flux-3/i.test(model)) {
    body.aspect_ratio = nearestAspect(size.width, size.height);
    body.resolution = resolutionFor(size.width, size.height);
    if (images.length) body.images = images.slice(0, 10).map(dataUrlOf);
    return body;
  }

  // Kontext / Ultra 用 aspect_ratio，没有 width/height。
  if (/kontext|ultra/i.test(model)) {
    body.aspect_ratio = nearestAspect(size.width, size.height);
    body.output_format = 'png';
    if (images.length) {
      body.input_image = dataUrlOf(images[0]);
      for (let index = 1; index < images.length && index < 4; index++) {
        body['input_image_' + (index + 1)] = dataUrlOf(images[index]);
      }
    }
    return body;
  }

  body.width = size.width;
  body.height = size.height;
  body.output_format = 'png';
  if (input.seed !== undefined && input.seed !== null && input.seed !== '') body.seed = input.seed;
  if (images.length) {
    body.input_image = dataUrlOf(images[0]);
    for (let index = 1; index < images.length && index < 8; index++) {
      body['input_image_' + (index + 1)] = dataUrlOf(images[index]);
    }
  }
  return body;
}

/* ------------------------------------------------------------------ fal */

function falModelPath(model) {
  return '/' + String(model || '').trim().replace(/^\/+/, '');
}

function falBuild(input) {
  const body = { prompt: promptWithNegative(input), num_images: 1, output_format: 'jpeg' };
  const size = sizeOf(input);
  if (size) body.image_size = { width: size.width, height: size.height };
  const images = imagesOf(input);
  // fal 的单图端点用 image_url、多图端点用 image_urls，混用会 422。
  if (images.length === 1) body.image_url = dataUrlOf(images[0]);
  else if (images.length > 1) body.image_urls = images.map(dataUrlOf);
  return body;
}

/* -------------------------------------------------------------- Replicate */

const schemaCache = new Map();
const SCHEMA_TTL = 10 * 60 * 1000;

/** 测试用：清掉模型 schema 缓存。 */
export function resetAsyncSchemaCache() {
  schemaCache.clear();
}

function replicateName(model) {
  return String(model || '').trim().replace(/^\/+/, '');
}

const SCHEMA_CACHE_LIMIT = 100;

/** 读模型 Input schema；失败就返回 null，且不缓存失败（瞬时 503 不该让后面 10 分钟都退化）。 */
async function inputSchemaOf(provider, model, signal) {
  const name = replicateName(model);
  if (!name.includes('/')) return null;
  const key = baseUrlOf(provider) + '|' + name;
  const cached = schemaCache.get(key);
  if (cached && Date.now() - cached.at < SCHEMA_TTL) return cached.value;
  try {
    const response = await request(baseUrlOf(provider) + '/models/' + name, {
      headers: headersFor(provider, false), signal: signal
    });
    if (!response.ok) throw new Error('schema ' + response.status);
    const payload = await readJsonResponse(response, 5 * 1024 * 1024);
    const schema = payload
      && payload.latest_version
      && payload.latest_version.openapi_schema
      && payload.latest_version.openapi_schema.components
      && payload.latest_version.openapi_schema.components.schemas
      && payload.latest_version.openapi_schema.components.schemas.Input;
    const properties = schema && schema.properties ? schema.properties : null;
    if (!properties) return null;
    if (schemaCache.size >= SCHEMA_CACHE_LIMIT) {
      const oldest = schemaCache.keys().next().value;
      if (oldest) schemaCache.delete(oldest);
    }
    schemaCache.set(key, { at: Date.now(), value: properties });
    return properties;
  } catch (_error) {
    return null;
  }
}

const SCALAR_IMAGE_FIELDS = ['input_image', 'image', 'image_url'];
const ARRAY_IMAGE_FIELDS = ['images', 'image_urls'];

function isImageString(spec) {
  return !!spec && (spec.type === 'string' || spec.format === 'uri');
}

/**
 * 只认 schema 里声明过的图片字段，并且要求类型对得上。
 * Replicate 对未知字段是静默忽略的，猜错会让参考图被丢掉还照常出图。
 */
function imageFieldOf(properties) {
  if (!properties) return null;
  for (const name of SCALAR_IMAGE_FIELDS) {
    if (isImageString(properties[name])) return { name: name, array: false };
  }
  for (const name of ARRAY_IMAGE_FIELDS) {
    const spec = properties[name];
    if (!spec) continue;
    if (spec.type === 'array') return { name: name, array: true };
    if (isImageString(spec)) return { name: name, array: false };
  }
  return null;
}

function sizeFieldsOf(properties, size) {
  if (!properties || !size) return null;
  const widthSpec = properties.width;
  const heightSpec = properties.height;
  const numeric = (spec) => !!spec && (spec.type === 'integer' || spec.type === 'number');
  if (numeric(widthSpec) && numeric(heightSpec)) {
    return { width: size.width, height: size.height };
  }
  if (properties.aspect_ratio) {
    const allowed = Array.isArray(properties.aspect_ratio.enum) ? properties.aspect_ratio.enum : undefined;
    return { aspect_ratio: nearestAspect(size.width, size.height, allowed) };
  }
  return null;
}

async function replicateBuild(input, provider, signal) {
  const images = imagesOf(input);
  const properties = await inputSchemaOf(provider, input.model, signal);
  const payload = { prompt: promptWithNegative(input) };
  const notes = [];

  if (images.length) {
    const field = imageFieldOf(properties);
    if (!field) {
      notes.push('未识别模型输入字段，已省略参考图');
    } else if (field.array) {
      payload[field.name] = images.map(dataUrlOf);
    } else {
      payload[field.name] = dataUrlOf(images[0]);
      if (images.length > 1) notes.push('该模型只接受一张参考图，已只用第一张');
    }
  }

  const size = sizeOf(input);
  if (size) {
    const sizeFields = sizeFieldsOf(properties, size);
    if (sizeFields) Object.assign(payload, sizeFields);
    else notes.push('未识别模型的尺寸字段，已省略尺寸');
  }

  return notes.length ? { body: { input: payload }, note: notes.join('；') } : { body: { input: payload } };
}

/* ----------------------------------------------------------------- 描述符 */

export const ASYNC_ADAPTERS = [
  {
    id: 'bfl',
    label: 'Black Forest Labs (FLUX)',
    match: (provider) => /(^|\.)bfl\.ai$/i.test(hostOf(provider)),
    authHeader: 'x-key',
    local: false,
    endpoints: { generate: '/v1', edit: '/v1' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels() {
      return [
        'flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-klein-9b', 'flux-2-klein-4b',
        'flux-3-image', 'flux-3-image-klein', 'flux-kontext-pro', 'flux-kontext-max',
        'flux-pro-1.1', 'flux-pro-1.1-ultra'
      ];
    },
    async: {
      edit: true,
      build: bflBuild,
      submitPath: (input) => '/' + String(input.model || '').trim().replace(/^\/+/, ''),
      pollUrl: (submission) => String(submission.polling_url || ''),
      pollHeaders: (provider) => ({ 'x-key': String((provider && provider.key) || '') }),
      statusOf: (payload) => {
        const status = String((payload && payload.status) || '').toUpperCase();
        if (BFL_SUCCESS.has(status)) return { state: 'success', status: status };
        if (BFL_FAILURE.has(status)) {
          return { state: 'failure', status: status, message: String((payload && payload.detail) || status) };
        }
        return { state: 'pending', status: status };
      },
      resolve: async (payload) => {
        const sample = payload && payload.result && payload.result.sample;
        if (!sample) throw new Error('BFL 任务完成了但没有返回图片');
        return { url: sample };
      },
      intervalMs: 1000,
      timeoutMs: 300000
    }
  },
  {
    id: 'fal',
    label: 'fal.ai',
    match: (provider) => /(^|\.)(queue\.)?fal(run)?\.(run|com)$/i.test(hostOf(provider)),
    authHeader: 'fal-key',
    local: false,
    endpoints: { generate: '/', edit: '/' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels(provider, signal) {
      const response = await request('https://api.fal.ai/v1/models?category=text-to-image', {
        headers: headersFor(provider, false), signal: signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload && Array.isArray(payload.models) ? payload.models : [])
        .map((item) => String((item && item.endpoint_id) || '').trim())
        .filter(Boolean)
        .slice(0, 200);
    },
    async: {
      edit: true,
      build: falBuild,
      submitPath: (input) => falModelPath(input.model),
      pollUrl: (submission) => String(submission.status_url || ''),
      pollHeaders: (provider) => authHeaders(provider, { authHeader: 'fal-key' }),
      statusOf: (payload) => {
        const status = String((payload && payload.status) || '').toUpperCase();
        if (status === 'COMPLETED') {
          if (payload && payload.error) {
            return { state: 'failure', status: status, message: String(payload.error) };
          }
          return { state: 'success', status: status };
        }
        return { state: 'pending', status: status };
      },
      resolve: async (payload, provider, signal, submission) => {
        const url = (submission && submission.response_url) || (payload && payload.response_url);
        if (!url) throw new Error('fal 任务完成了但没有 response_url');
        const response = await request(url, { headers: authHeaders(provider, { authHeader: 'fal-key' }), signal: signal });
        const result = await readJsonResponse(response, 64 * 1024 * 1024);
        const first = result && Array.isArray(result.images) ? result.images[0] : null;
        if (!first || !first.url) throw new Error('fal 没有返回图片');
        return { url: String(first.url) };
      },
      intervalMs: 1000,
      timeoutMs: 300000
    }
  },
  {
    id: 'replicate',
    label: 'Replicate',
    match: (provider) => hostOf(provider) === 'api.replicate.com',
    authHeader: 'bearer',
    local: false,
    endpoints: { generate: '/', edit: '/' },
    transport: { generate: 'json', edit: 'json' },
    editFields: [],
    maxN: 1,
    async listModels(provider, signal) {
      const response = await request(baseUrlOf(provider) + '/models', {
        headers: headersFor(provider, false), signal: signal
      });
      const payload = await readJsonResponse(response, 5 * 1024 * 1024);
      return (payload && Array.isArray(payload.results) ? payload.results : [])
        .map((item) => (item && item.owner && item.name ? item.owner + '/' + item.name : ''))
        .filter(Boolean)
        .slice(0, 200);
    },
    async: {
      edit: true,
      build: replicateBuild,
      submitPath: (input) => '/models/' + replicateName(input.model) + '/predictions',
      pollUrl: (submission) => String((submission && submission.urls && submission.urls.get) || ''),
      pollHeaders: (provider) => headersFor(provider, false),
      statusOf: (payload) => {
        const status = String((payload && payload.status) || '').toLowerCase();
        if (status === 'succeeded') return { state: 'success', status: status };
        if (['failed', 'canceled', 'aborted'].includes(status)) {
          return { state: 'failure', status: status, message: String((payload && payload.error) || status) };
        }
        return { state: 'pending', status: status };
      },
      resolve: async (payload) => {
        const output = payload && payload.output;
        const url = Array.isArray(output) ? output[0] : output;
        if (!url) throw new Error('Replicate 任务完成了但没有返回图片');
        return { url: String(url) };
      },
      intervalMs: 1000,
      timeoutMs: 300000
    }
  }
];
